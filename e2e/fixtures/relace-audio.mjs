// Test helper: rewrites a Matroska file so that one audio track's SimpleBlocks are packed into
// laced blocks (Xiph, EBML or fixed-size lacing), the way some muxers store AAC. The frames
// themselves are untouched, so a correct reader must produce exactly the same MP4 as for the
// original file. SeekHead and Cues are dropped (their offsets would be wrong) and the Segment
// size is set to "unknown"; neither matters to a streaming reader.
//
// Usage: relaceAudio(srcPath, dstPath, { track: 2, group: 4, kind: "xiph" | "ebml" | "fixed" })
// Returns the number of laced blocks written.

import fs from "node:fs";

const ID_SEEKHEAD = "114d9b74";
const ID_CUES = "1c53bb6b";
const ID_CLUSTER = "1f43b675";
const ID_SIMPLEBLOCK = "a3";

function readId(buf, pos) {
  const first = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    len += 1;
  }
  return { id: buf.subarray(pos, pos + len).toString("hex"), next: pos + len };
}

function readSize(buf, pos) {
  const first = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    len += 1;
  }
  let value = BigInt(first & (mask - 1));
  for (let i = 1; i < len; i += 1) value = (value << 8n) | BigInt(buf[pos + i]);
  const unknown = value === (1n << BigInt(7 * len)) - 1n;
  return { value: Number(value), next: pos + len, unknown };
}

function* children(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const id = readId(buf, pos);
    const size = readSize(buf, id.next);
    const length = size.unknown ? end - size.next : size.value;
    yield { id: id.id, body: buf.subarray(size.next, size.next + length) };
    pos = size.next + length;
  }
}

function sizeVint8(n) {
  const out = Buffer.alloc(8);
  out[0] = 0x01;
  out.writeUIntBE(n, 2, 6);
  return out;
}

function element(idHex, body) {
  return Buffer.concat([Buffer.from(idHex, "hex"), sizeVint8(body.length), body]);
}

function xiphSizes(frames) {
  const out = [];
  for (const f of frames.slice(0, -1)) {
    let n = f.length;
    while (n >= 255) {
      out.push(255);
      n -= 255;
    }
    out.push(n);
  }
  return Buffer.from(out);
}

function sizeVint(n) {
  for (let len = 1; len <= 8; len += 1) {
    if (n < 2 ** (7 * len) - 1) {
      const out = Buffer.alloc(len);
      let v = BigInt(n) | (1n << BigInt(7 * len));
      for (let i = len - 1; i >= 0; i -= 1) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    }
  }
  throw new Error("size too large");
}

function signedVint(d) {
  for (let len = 1; len <= 8; len += 1) {
    const bias = 2 ** (7 * len - 1) - 1;
    if (d >= -bias && d <= bias) {
      const out = Buffer.alloc(len);
      let v = BigInt(d + bias) | (1n << BigInt(7 * len));
      for (let i = len - 1; i >= 0; i -= 1) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    }
  }
  throw new Error("delta too large");
}

function lacedBody(frames, kind) {
  const count = Buffer.from([frames.length - 1]);
  const sameSize = frames.every((f) => f.length === frames[0].length);
  if (kind === "fixed" && sameSize) {
    return { flags: 0x04, body: Buffer.concat([count, ...frames]) };
  }
  if (kind === "ebml") {
    const table = [sizeVint(frames[0].length)];
    for (let i = 1; i < frames.length - 1; i += 1) {
      table.push(signedVint(frames[i].length - frames[i - 1].length));
    }
    return { flags: 0x06, body: Buffer.concat([count, ...table, ...frames]) };
  }
  // Xiph (also the fallback when "fixed" is asked for frames of different sizes)
  return { flags: 0x02, body: Buffer.concat([count, xiphSizes(frames), ...frames]) };
}

export function relaceAudio(src, dst, { track = 2, group = 4, kind = "xiph" } = {}) {
  const buf = fs.readFileSync(src);
  const header = readId(buf, 0);
  const headerSize = readSize(buf, header.next);
  const out = [buf.subarray(0, headerSize.next + headerSize.value)];
  let pos = headerSize.next + headerSize.value;
  const seg = readId(buf, pos);
  const segSize = readSize(buf, seg.next);
  const segEnd = segSize.unknown ? buf.length : segSize.next + segSize.value;

  const segBody = [];
  let laced = 0;
  for (const el of children(buf, segSize.next, segEnd)) {
    if (el.id === ID_SEEKHEAD || el.id === ID_CUES) continue;
    if (el.id !== ID_CLUSTER) {
      segBody.push(element(el.id, el.body));
      continue;
    }
    const kids = [];
    let pending = [];
    const flush = () => {
      if (pending.length === 0) return;
      const { flags, body } = lacedBody(
        pending.map((p) => p.data),
        kind,
      );
      const rel = Buffer.alloc(2);
      rel.writeInt16BE(pending[0].rel);
      kids.push(
        element(
          ID_SIMPLEBLOCK,
          Buffer.concat([Buffer.from([0x80 | track]), rel, Buffer.from([0x80 | flags]), body]),
        ),
      );
      laced += 1;
      pending = [];
    };
    for (const kid of children(el.body, 0, el.body.length)) {
      if (kid.id === ID_SIMPLEBLOCK && (kid.body[0] & 0x7f) === track) {
        pending.push({ rel: kid.body.readInt16BE(1), data: kid.body.subarray(4) });
        if (pending.length === group) flush();
      } else {
        kids.push(element(kid.id, kid.body));
      }
    }
    flush();
    segBody.push(element(ID_CLUSTER, Buffer.concat(kids)));
  }
  const unknownSize = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  out.push(Buffer.from(seg.id, "hex"), unknownSize, Buffer.concat(segBody));
  fs.writeFileSync(dst, Buffer.concat(out));
  return laced;
}
