import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_QUEUE,
  buildOpusHead,
  buildReplacement,
  canReencodeVorbis,
  fillDurations,
  opusPreSkip,
  pickEncoder,
  targetBitrate,
  transcodeVorbis,
} from "../../web/js/core/audio-transcode.js";

// ---- fakes mimicking the WebCodecs surface used by the module
class FakeChunk {
  constructor({ timestamp, data }) {
    this.timestamp = timestamp;
    this.data = data;
  }
}

function makeCodecs({ aacSupported = true, opusSupported = true, decodeError = null, dropDuration = false } = {}) {
  const stats = { maxDecodeQueue: 0, maxEncodeQueue: 0, closedAudio: 0, createdAudio: 0, order: [] };

  class FakeAudioData {
    constructor(ts) {
      this.timestamp = ts;
      stats.createdAudio++;
    }
    close() {
      stats.closedAudio++;
    }
  }
  class AudioDecoder {
    static async isConfigSupported(cfg) {
      return { supported: cfg.codec === "vorbis" && !!cfg.description, config: cfg };
    }
    constructor(init) {
      this.init = init;
      this.decodeQueueSize = 0;
      this.state = "unconfigured";
      this.n = 0;
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk) {
      this.decodeQueueSize++;
      stats.maxDecodeQueue = Math.max(stats.maxDecodeQueue, this.decodeQueueSize);
      setTimeout(() => {
        this.decodeQueueSize--;
        if (decodeError && ++this.n === 3) return this.init.error(new Error(decodeError));
        this.init.output(new FakeAudioData(chunk.timestamp));
      }, 2);
    }
    async flush() {
      while (this.decodeQueueSize > 0) await new Promise((r) => setTimeout(r, 1));
    }
    close() {
      this.state = "closed";
    }
  }
  class AudioEncoder {
    static async isConfigSupported(cfg) {
      const ok = cfg.codec === "opus" ? opusSupported : aacSupported;
      return { supported: ok, config: cfg };
    }
    constructor(init) {
      this.init = init;
      this.encodeQueueSize = 0;
      this.state = "unconfigured";
      this.first = true;
      this.opus = false;
    }
    configure(cfg) {
      this.cfg = cfg;
      this.state = "configured";
    }
    encode(data) {
      this.encodeQueueSize++;
      stats.maxEncodeQueue = Math.max(stats.maxEncodeQueue, this.encodeQueueSize);
      stats.order.push(data.timestamp);
      setTimeout(() => {
        this.encodeQueueSize--;
        const bytes = new Uint8Array([data.timestamp & 0xff, 1, 2, 3]);
        const chunk = {
          timestamp: data.timestamp,
          duration: dropDuration ? undefined : 1000,
          byteLength: bytes.length,
          copyTo: (dst) => dst.set(bytes),
        };
        let meta;
        if (this.first) {
          this.first = false;
          const description =
            this.cfg.codec === "opus" ? buildOpusHead(2, 44100, 400) : new Uint8Array([0x12, 0x10]);
          meta = { decoderConfig: { description } };
        }
        this.init.output(chunk, meta);
      }, 2);
    }
    async flush() {
      while (this.encodeQueueSize > 0) await new Promise((r) => setTimeout(r, 1));
    }
    close() {
      this.state = "closed";
    }
  }
  return { deps: { AudioDecoder, AudioEncoder, EncodedAudioChunk: FakeChunk }, stats };
}

const info = { codecPrivate: new Uint8Array([2, 30, 40, 1, 2, 3]), sampleRate: 44100, channels: 2 };
const packetsOf = (n) =>
  Array.from({ length: n }, (_, i) => ({ ptsNs: i * 23_219_954, data: new Uint8Array([i & 0xff, 9]) }));

test("targetBitrate scales with channels and is clamped", () => {
  assert.equal(targetBitrate(1), 64000);
  assert.equal(targetBitrate(2), 128000);
  assert.equal(targetBitrate(6), 320000);
  assert.equal(targetBitrate(0), 64000);
});

test("pickEncoder prefers AAC, falls back to Opus, and returns null when nothing is supported", async () => {
  let { deps } = makeCodecs();
  assert.equal((await pickEncoder(deps.AudioEncoder, 44100, 2)).id, "aac");
  ({ deps } = makeCodecs({ aacSupported: false }));
  const opus = await pickEncoder(deps.AudioEncoder, 44100, 2);
  assert.equal(opus.id, "opus");
  assert.equal(opus.codecId, "A_OPUS");
  ({ deps } = makeCodecs({ aacSupported: false, opusSupported: false }));
  assert.equal(await pickEncoder(deps.AudioEncoder, 44100, 2), null);
  assert.equal(await pickEncoder(undefined, 44100, 2), null);
  const throwing = { isConfigSupported: async () => { throw new Error("boom"); } };
  assert.equal(await pickEncoder(throwing, 44100, 2), null);
});

test("canReencodeVorbis needs a Vorbis decoder and an encoder", async () => {
  const { deps } = makeCodecs();
  assert.equal((await canReencodeVorbis(deps, info)).id, "aac");
  assert.equal(await canReencodeVorbis({ AudioEncoder: deps.AudioEncoder }, info), null);
  assert.equal(await canReencodeVorbis({ AudioDecoder: deps.AudioDecoder }, info), null);
  const noVorbis = { ...deps, AudioDecoder: { isConfigSupported: async () => ({ supported: false }) } };
  assert.equal(await canReencodeVorbis(noVorbis, info), null);
  const throwing = { ...deps, AudioDecoder: { isConfigSupported: async () => { throw new Error("x"); } } };
  assert.equal(await canReencodeVorbis(throwing, info), null);
});

test("transcodeVorbis produces AAC chunks in order, closes every frame and honours back-pressure", async () => {
  const { deps, stats } = makeCodecs();
  const encoder = await pickEncoder(deps.AudioEncoder, 44100, 2);
  const seen = [];
  const result = await transcodeVorbis({
    info,
    packets: packetsOf(300),
    encoder,
    deps,
    onProgress: (f) => seen.push(f),
  });
  assert.equal(result.codecId, "A_AAC");
  assert.deepEqual([...result.codecPrivate], [0x12, 0x10]);
  assert.equal(result.chunks.length, 300);
  assert.equal(result.sampleRate, 44100);
  assert.equal(result.codecDelayNs, null);
  const ts = result.chunks.map((c) => c.ptsUs);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  assert.equal(stats.createdAudio, stats.closedAudio, "no leaked AudioData");
  assert.ok(stats.maxDecodeQueue <= MAX_QUEUE + 1, `decode queue ${stats.maxDecodeQueue}`);
  assert.ok(stats.maxEncodeQueue <= MAX_QUEUE + 2, `encode queue ${stats.maxEncodeQueue}`);
  assert.equal(seen.at(-1), 1);
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]));
});

test("transcodeVorbis with Opus builds codec delay from the OpusHead pre-skip", async () => {
  const { deps } = makeCodecs({ aacSupported: false });
  const encoder = await pickEncoder(deps.AudioEncoder, 44100, 2);
  const result = await transcodeVorbis({ info, packets: packetsOf(20), encoder, deps });
  assert.equal(result.codecId, "A_OPUS");
  assert.equal(result.sampleRate, 48000);
  assert.equal(String.fromCharCode(...result.codecPrivate.slice(0, 8)), "OpusHead");
  assert.equal(result.codecDelayNs, Math.round((400 * 1e9) / 48000));
});

test("missing chunk durations are derived from timestamps", async () => {
  const { deps } = makeCodecs({ dropDuration: true });
  const encoder = await pickEncoder(deps.AudioEncoder, 44100, 2);
  const result = await transcodeVorbis({ info, packets: packetsOf(10), encoder, deps });
  assert.ok(result.chunks.every((c) => c.durUs > 0));
  const chunks = [
    { ptsUs: 0, durUs: 0 },
    { ptsUs: 20, durUs: 0 },
    { ptsUs: 40, durUs: 0 },
  ];
  fillDurations(chunks);
  assert.deepEqual(chunks.map((c) => c.durUs), [20, 20, 20]);
});

test("a decoder error rejects with its message and still releases the codecs", async () => {
  const { deps, stats } = makeCodecs({ decodeError: "corrupt vorbis packet" });
  const encoder = await pickEncoder(deps.AudioEncoder, 44100, 2);
  await assert.rejects(
    transcodeVorbis({ info, packets: packetsOf(50), encoder, deps }),
    /corrupt vorbis packet/,
  );
  assert.equal(stats.createdAudio, stats.closedAudio);
});

test("no packets means no output and is reported as an error", async () => {
  const { deps } = makeCodecs();
  const encoder = await pickEncoder(deps.AudioEncoder, 44100, 2);
  await assert.rejects(transcodeVorbis({ info, packets: [], encoder, deps }), /no output/);
});

test("cancelling stops the transcode", async () => {
  const { deps } = makeCodecs();
  const encoder = await pickEncoder(deps.AudioEncoder, 44100, 2);
  let n = 0;
  await assert.rejects(
    transcodeVorbis({ info, packets: packetsOf(100), encoder, deps, isCancelled: () => ++n > 10 }),
    /cancelled/,
  );
});

test("buildReplacement packs sizes, times and a readable extra buffer", () => {
  const result = {
    codecId: "A_AAC",
    codecPrivate: new Uint8Array([0x12, 0x10]),
    sampleRate: 44100,
    channels: 2,
    codecDelayNs: null,
    chunks: [
      { ptsUs: 0, durUs: 23220, data: new Uint8Array([1, 2, 3]) },
      { ptsUs: 23220, durUs: 23220, data: new Uint8Array([4, 5]) },
    ],
  };
  const r = buildReplacement(2, result);
  assert.deepEqual([...r.sizes], [3, 2]);
  assert.deepEqual([...r.ptsUs], [0, 23220]);
  assert.equal(r.extraSize, 5);
  assert.deepEqual([...r.readExtra(1, 3)], [2, 3, 4]);
  assert.deepEqual([...r.readExtra(0, 5)], [1, 2, 3, 4, 5]);
  assert.equal(r.trackNumber, 2);
});

test("Opus helpers", () => {
  const head = buildOpusHead(2, 44100, 312);
  assert.equal(head.length, 19);
  assert.equal(opusPreSkip(head), 312);
  assert.equal(opusPreSkip(new Uint8Array(3)), 312);
  assert.equal(new DataView(head.buffer).getUint32(12, true), 44100);
});
