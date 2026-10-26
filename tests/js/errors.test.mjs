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

test("describeWarning rewrites known engine warnings and passes unknown ones through", () => {
  assert.equal(describeWarning("track 3 (A_DTS) skipped: unsupported codec"), "Skipped track 3 (A_DTS): unsupported codec");
  assert.equal(describeWarning("file appears truncated; trailing data ignored"), "The file looks cut off; the readable part was converted.");
  assert.equal(describeWarning("additional segments ignored"), "additional segments ignored");
  assert.equal(describeWarning(""), "");
});
