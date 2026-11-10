import test from "node:test";
import assert from "node:assert/strict";
import { describeError, describeWarning, offersSaveToFile } from "../../web/js/core/errors.js";

test("describeError maps engine messages to friendly titles with hints and keeps the original text", () => {
  const cases = [
    ["invalid Matroska file: not a Matroska/WebM file", "This doesn’t look like an MKV or WebM file"],
    ["invalid Matroska file: no tracks found", "This doesn’t look like an MKV or WebM file"],
    ["unsupported: no supported track: V_VP9 (unsupported codec)", "No supported video or audio found"],
    ["too large: sample count exceeds limit", "This file is too large to process"],
    ["output error: disk write failed (storage full?)", "Couldn’t save the converted file"],
    ["memory budget exceeded: need 2000 bytes", "Not enough memory to hold this file"],
    ["I/O error: short read", "Couldn’t read the file"],
    ["something nobody anticipated", "Conversion failed"],
  ];
  for (const [msg, title] of cases) {
    const d = describeError(msg);
    assert.equal(d.title, title, msg);
    assert.equal(typeof d.hint, "string");
    assert.ok(d.hint.length > 10, msg);
    assert.equal(d.details, msg);
  }
  assert.match(describeError("unsupported: no supported track: V_VP9 (unsupported codec)").hint, /V_VP9/);
  assert.match(describeError("memory budget exceeded: x").hint, /Download or remove finished files/);
  assert.equal(describeError("").title, "Conversion failed");
  assert.equal(describeError(undefined).title, "Conversion failed");
  assert.equal(describeError(new Error("invalid Matroska file: x")).title, "This doesn’t look like an MKV or WebM file");
});

test("damaged files get a 'damaged' explanation instead of the 'not an MKV' one", () => {
  const msg =
    "invalid Matroska file: invalid EBML element ID at offset 123456 (inside element 0x18538067); next bytes: 00 00 00 00 00 00 00 00; no media data could be found";
  const d = describeError(msg);
  assert.equal(d.title, "This MKV file looks damaged");
  assert.match(d.hint, /offset 123456/);
  assert.equal(d.details, msg);
  // a genuinely foreign file keeps the original wording
  assert.equal(
    describeError("invalid Matroska file: not a Matroska/WebM file").title,
    "This doesn’t look like an MKV or WebM file",
  );
});

test("describeWarning explains skipped and ignored damaged data", () => {
  assert.match(
    describeWarning("skipped 4096 bytes of unreadable data in 2 place(s), first at offset 900"),
    /^Damaged parts of the file were skipped \(4096 bytes\)/,
  );
  assert.match(
    describeWarning("ignored 65536 bytes of unreadable data at the end of the file (from offset 99)"),
    /^The end of the file was unreadable \(65536 bytes\) and was ignored/,
  );
});

test("describeWarning rewrites known engine warnings and passes unknown ones through", () => {
  assert.equal(describeWarning("track 3 (A_DTS) skipped: unsupported codec"), "Skipped track 3 (A_DTS): unsupported codec");
  assert.equal(describeWarning("file appears truncated; trailing data ignored"), "The file looks cut off; the readable part was converted.");
  assert.equal(describeWarning("additional segments ignored"), "additional segments ignored");
  assert.equal(describeWarning(""), "");
});

test("storage errors explain how much space is needed and what to do", () => {
  const pre = describeError(
    "storage full: the converted file needs 1500000000 bytes but only 600000000 bytes are available (quota 900000000, used 300000000)",
  );
  assert.equal(pre.title, "Not enough storage space for the converted file");
  assert.equal(pre.code, "STORAGE_FULL");
  assert.match(pre.hint, /1\.4 GB/);
  assert.match(pre.hint, /572 MB/);
  assert.match(pre.hint, /Free up/);
  assert.match(pre.hint, /Downloads/);

  const mid = describeError("storage full: disk write failed after 1073741824 of 1500000000 bytes");
  assert.equal(mid.title, "The disk ran out of space while saving");
  assert.equal(mid.code, "STORAGE_FULL");
  assert.match(mid.hint, /1\.0 GB of 1\.4 GB/);

  const bare = describeError("storage full: disk write failed after 12 bytes");
  assert.equal(bare.code, "STORAGE_FULL");
  assert.ok(bare.hint.length > 20);
});

test("the older 'output error' wording still maps to the generic save failure", () => {
  const d = describeError("output error: NoModificationAllowedError: locked");
  assert.equal(d.title, "Couldn’t save the converted file");
  assert.equal(d.code, "OUTPUT_ERROR");
});

test("read failures name the offset and suggest copying the file locally", () => {
  const d = describeError("I/O error: read failed at offset 123456789 (NotReadableError: The requested file could not be read)");
  assert.equal(d.title, "Couldn’t read the file");
  assert.equal(d.code, "READ_FAILED");
  assert.match(d.hint, /123456789/);
  assert.match(d.hint, /local/i);
  assert.equal(describeError("I/O error: short read").code, "READ_FAILED");
});

test("a stopped worker is explained as a likely out-of-memory crash", () => {
  const d = describeError("The conversion worker stopped unexpectedly.");
  assert.equal(d.title, "The converter stopped unexpectedly");
  assert.equal(d.code, "WORKER_STOPPED");
  assert.match(d.hint, /memory/i);
});

test("every described error carries a stable code", () => {
  const cases = {
    "invalid Matroska file: not a Matroska/WebM file": "NOT_MKV",
    "invalid Matroska file: x; no media data could be found": "MKV_DAMAGED",
    "unsupported: no supported track: V_VP9": "NO_SUPPORTED_TRACK",
    "too large: x": "TOO_LARGE",
    "memory budget exceeded: x": "MEMORY_BUDGET",
    "something nobody anticipated": "UNKNOWN",
  };
  for (const [msg, code] of Object.entries(cases)) {
    assert.equal(describeError(msg).code, code, msg);
  }
});

test("a refused write says what happened, does not blame a cause it cannot know, and points at the alternative", () => {
  const d = describeError(
    "output rejected: the browser refused a write after 249000000 of 1629000000 bytes (browser code -8)",
  );
  assert.equal(d.code, "OUTPUT_REJECTED");
  assert.equal(d.title, "The browser refused to save the converted file");
  assert.match(d.hint, /237 MB of 1\.5 GB/);
  assert.match(d.hint, /choose/i);
  // not a claim about free space or file-size limits: the browser's code is not documented
  assert.doesNotMatch(d.hint, /ran out of space|file size limit|too large/i);
  assert.equal(d.details.includes("browser code -8"), true);
  // without numbers it still reads well
  assert.ok(describeError("output rejected: the browser refused a write after 0 bytes (browser code -8)").hint.length > 40);
});

test("errors for a file the user chose have their own text", () => {
  const denied = describeError("save denied: NotAllowedError: The request is not allowed");
  assert.equal(denied.code, "SAVE_DENIED");
  assert.match(denied.hint, /allow/i);
  const failed = describeError("save error: NoModificationAllowedError: locked");
  assert.equal(failed.code, "SAVE_FAILED");
  assert.match(failed.hint, /open in another program/i);
});

test("offersSaveToFile lists the failures that choosing a file can get around", () => {
  for (const code of ["STORAGE_FULL", "OUTPUT_REJECTED", "OUTPUT_ERROR", "MEMORY_BUDGET", "SAVE_DENIED", "SAVE_FAILED"]) {
    assert.equal(offersSaveToFile(code), true, code);
  }
  for (const code of ["MKV_DAMAGED", "NOT_MKV", "NO_SUPPORTED_TRACK", "TOO_LARGE", "READ_FAILED", "WORKER_STOPPED", "UNKNOWN", "", undefined, null]) {
    assert.equal(offersSaveToFile(code), false, String(code));
  }
});
