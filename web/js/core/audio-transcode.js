/**
 * Re-encodes an audio track the MP4 writer cannot copy (Vorbis) using the browser's
 * WebCodecs decoder + encoder: Vorbis -> PCM -> AAC (preferred) or Opus.
 *
 * Pure orchestration: the codec classes are injected so this runs in Node tests with fakes and
 * in the conversion worker with the real `AudioDecoder`/`AudioEncoder`. Nothing leaves the device.
 */

/** Packets/frames allowed in flight in the decoder or encoder before feeding pauses. */
export const MAX_QUEUE = 48;
/** Refuse to buffer more than this many bytes of compressed packets or encoded output. */
export const MAX_BUFFER_BYTES = 512 * 1024 * 1024;

const CANDIDATES = [
  { id: "aac", codecId: "A_AAC", config: { codec: "mp4a.40.2", aac: { format: "aac" } } },
  { id: "opus", codecId: "A_OPUS", config: { codec: "opus" } },
];

/**
 * @param {number} channels
 * @returns {number} target bitrate in bits per second
 */
export function targetBitrate(channels) {
  const perChannel = 64000;
  return Math.min(Math.max(Math.round(channels) * perChannel, 64000), 320000);
}

/**
 * Picks the first encoder the browser supports for this audio format.
 * @param {{isConfigSupported: Function}|undefined} Encoder AudioEncoder class
 * @param {number} sampleRate
 * @param {number} channels
 * @returns {Promise<{id: string, codecId: string, config: object}|null>}
 */
export async function pickEncoder(Encoder, sampleRate, channels) {
  if (!Encoder || typeof Encoder.isConfigSupported !== "function") return null;
  for (const c of CANDIDATES) {
    const config = {
      ...c.config,
      sampleRate,
      numberOfChannels: channels,
      bitrate: targetBitrate(channels),
    };
    try {
      const result = await Encoder.isConfigSupported(config);
      if (result && result.supported) {
        return { id: c.id, codecId: c.codecId, config: result.config ?? config };
      }
    } catch {
      // treated as unsupported
    }
  }
  return null;
}

/**
 * True when this browser can decode Vorbis and encode AAC or Opus.
 * @param {{AudioDecoder?: any, AudioEncoder?: any}} deps
 * @param {{codecPrivate: Uint8Array, sampleRate: number, channels: number}} info
 * @returns {Promise<{id: string, codecId: string, config: object}|null>} the encoder choice
 */
export async function canReencodeVorbis(deps, info) {
  const { AudioDecoder, AudioEncoder } = deps;
  if (!AudioDecoder || !AudioEncoder || typeof AudioDecoder.isConfigSupported !== "function") {
    return null;
  }
  try {
    const dec = await AudioDecoder.isConfigSupported({
      codec: "vorbis",
      sampleRate: info.sampleRate,
      numberOfChannels: info.channels,
      description: info.codecPrivate,
    });
    if (!dec || !dec.supported) return null;
  } catch {
    return null;
  }
  return pickEncoder(AudioEncoder, info.sampleRate, info.channels);
}

/** @param {Uint8Array|ArrayBuffer|undefined|null} d @returns {Uint8Array} a private copy */
function copyBytes(d) {
  if (!d) return new Uint8Array(0);
  const src = d instanceof Uint8Array ? d : new Uint8Array(d);
  return new Uint8Array(src);
}

/** OpusHead pre-skip (samples at 48 kHz), or 312 when the header is unusable. */
export function opusPreSkip(head) {
  return head && head.length >= 12 ? head[10] | (head[11] << 8) : 312;
}

/** Builds a minimal OpusHead for 1-2 channels (mapping family 0). */
export function buildOpusHead(channels, inputRate, preSkip = 312) {
  const v = new Uint8Array(19);
  v.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  v[8] = 1;
  v[9] = channels;
  v[10] = preSkip & 0xff;
  v[11] = (preSkip >> 8) & 0xff;
  new DataView(v.buffer).setUint32(12, inputRate >>> 0, true);
  return v;
}

/**
 * Fills missing/zero durations from the gap to the next chunk (last chunk repeats the previous).
 * @param {{ptsUs: number, durUs: number}[]} chunks
 */
export function fillDurations(chunks) {
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].durUs > 0) continue;
    if (i + 1 < chunks.length && chunks[i + 1].ptsUs > chunks[i].ptsUs) {
      chunks[i].durUs = chunks[i + 1].ptsUs - chunks[i].ptsUs;
    } else if (i > 0) {
      chunks[i].durUs = chunks[i - 1].durUs;
    }
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * Decodes Vorbis packets and encodes them with the chosen encoder.
 *
 * @param {object} args
 * @param {{codecPrivate: Uint8Array, sampleRate: number, channels: number}} args.info
 * @param {{ptsNs: number, data: Uint8Array}[]} args.packets file-order packets
 * @param {{id: string, codecId: string, config: object}} args.encoder from {@link pickEncoder}
 * @param {{AudioDecoder: any, AudioEncoder: any, EncodedAudioChunk: any}} args.deps
 * @param {(fraction: number) => void} [args.onProgress]
 * @param {() => boolean} [args.isCancelled]
 * @returns {Promise<{codecId: string, codecPrivate: Uint8Array, sampleRate: number,
 *   channels: number, codecDelayNs: number|null, chunks: {ptsUs: number, durUs: number, data: Uint8Array}[]}>}
 */
export async function transcodeVorbis({ info, packets, encoder, deps, onProgress, isCancelled }) {
  const { AudioDecoder, AudioEncoder, EncodedAudioChunk } = deps;
  /** @type {{ptsUs: number, durUs: number, data: Uint8Array}[]} */
  const chunks = [];
  let description = null;
  let outBytes = 0;
  let failure = null;
  const fail = (e) => {
    failure = failure ?? (e instanceof Error ? e : new Error(String(e?.message ?? e)));
  };

  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      outBytes += data.length;
      if (!description && meta?.decoderConfig?.description) {
        description = copyBytes(meta.decoderConfig.description);
      }
      chunks.push({ ptsUs: chunk.timestamp, durUs: chunk.duration ?? 0, data });
      if (outBytes > MAX_BUFFER_BYTES) fail(new Error("re-encoded audio is too large"));
    },
    error: fail,
  });
  const dec = new AudioDecoder({
    output: (audio) => {
      try {
        if (!failure) enc.encode(audio);
      } catch (e) {
        fail(e);
      } finally {
        audio.close();
      }
    },
    error: fail,
  });

  const close = () => {
    for (const c of [dec, enc]) {
      try {
        if (c.state !== "closed") c.close();
      } catch {
        // already closed
      }
    }
  };

  try {
    enc.configure(encoder.config);
    dec.configure({
      codec: "vorbis",
      sampleRate: info.sampleRate,
      numberOfChannels: info.channels,
      description: info.codecPrivate,
    });
    const total = packets.length;
    for (let i = 0; i < total; i++) {
      while (!failure && (dec.decodeQueueSize > MAX_QUEUE || enc.encodeQueueSize > MAX_QUEUE)) {
        await tick();
      }
      if (failure) break;
      if (isCancelled?.()) throw new Error("cancelled");
      const p = packets[i];
      dec.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Math.max(0, Math.round(p.ptsNs / 1000)),
          data: p.data,
        }),
      );
      if (onProgress && (i & 0x3ff) === 0) onProgress(i / total);
    }
    if (!failure) await dec.flush();
    if (!failure) await enc.flush();
    if (failure) throw failure;
  } finally {
    close();
  }

  if (chunks.length === 0) throw new Error("the audio decoder produced no output");
  fillDurations(chunks);
  onProgress?.(1);

  if (encoder.id === "opus") {
    const head = description && description.length >= 19 ? description : null;
    const codecPrivate = head ?? buildOpusHead(info.channels, info.sampleRate);
    return {
      codecId: "A_OPUS",
      codecPrivate,
      sampleRate: 48000,
      channels: info.channels,
      codecDelayNs: Math.round((opusPreSkip(codecPrivate) * 1e9) / 48000),
      chunks,
    };
  }
  if (!description || description.length < 2) {
    throw new Error("the AAC encoder did not provide an AudioSpecificConfig");
  }
  return {
    codecId: "A_AAC",
    codecPrivate: description,
    sampleRate: info.sampleRate,
    channels: info.channels,
    codecDelayNs: null,
    chunks,
  };
}

/**
 * Packs encoded chunks into the object the wasm `*_ex` functions expect.
 * @param {number} trackNumber
 * @param {Awaited<ReturnType<typeof transcodeVorbis>>} result
 */
export function buildReplacement(trackNumber, result) {
  const n = result.chunks.length;
  const sizes = new Uint32Array(n);
  const ptsUs = new Float64Array(n);
  const durUs = new Float64Array(n);
  let total = 0;
  result.chunks.forEach((c, i) => {
    sizes[i] = c.data.length;
    ptsUs[i] = c.ptsUs;
    durUs[i] = c.durUs;
    total += c.data.length;
  });
  const extra = new Uint8Array(total);
  let at = 0;
  for (const c of result.chunks) {
    extra.set(c.data, at);
    at += c.data.length;
  }
  return {
    trackNumber,
    codecId: result.codecId,
    codecPrivate: result.codecPrivate,
    sampleRate: result.sampleRate,
    channels: result.channels,
    codecDelayNs: result.codecDelayNs,
    sizes,
    ptsUs,
    durUs,
    extraSize: total,
    readExtra: (offset, length) => extra.subarray(offset, offset + length),
  };
}
