import test from "node:test";
import assert from "node:assert/strict";
import { describeError, describeWarning } from "../../web/js/core/errors.js";

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
