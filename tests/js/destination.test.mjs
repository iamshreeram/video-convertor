import test from "node:test";
import assert from "node:assert/strict";
import {
  SAVE_PREF_KEY,
  canPickFolder,
  classifyFolderFailure,
  createOutputFile,
  mp4Name,
  numberedName,
  readSavePreference,
  safeFileName,
  uniqueFileName,
  writeSavePreference,
} from "../../web/js/core/destination.js";

/** A directory handle double: `files` are taken names, `dirs` are names of sub-directories. */
function fakeDir({ files = [], dirs = [], failWith = null } = {}) {
  const taken = new Set(files);
  const calls = [];
  return {
    calls,
    taken,
    async getFileHandle(name, options) {
      calls.push({ name, create: Boolean(options?.create) });
      if (failWith) throw Object.assign(new Error("boom"), { name: failWith });
      if (dirs.includes(name)) throw Object.assign(new Error("is a directory"), { name: "TypeMismatchError" });
      if (taken.has(name)) return { kind: "file", name };
      if (options?.create) {
        taken.add(name);
        return { kind: "file", name };
      }
      throw Object.assign(new Error("not found"), { name: "NotFoundError" });
    },
  };
}

test("safeFileName keeps ordinary names and replaces characters Windows and macOS refuse", () => {
  assert.equal(safeFileName("Holiday 2024"), "Holiday 2024");
  assert.equal(safeFileName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(safeFileName("tab\there\u0001"), "tab_here_");
  assert.equal(safeFileName("name. "), "name");
  assert.equal(safeFileName("..."), "output");
  assert.equal(safeFileName(""), "output");
  assert.equal(safeFileName(undefined), "output");
  assert.equal(safeFileName("   "), "output");
});

test("safeFileName avoids reserved Windows device names and over-long names", () => {
  for (const reserved of ["CON", "con", "NUL", "COM1", "lpt9", "AUX", "PRN"]) {
    assert.notEqual(safeFileName(reserved).toLowerCase(), reserved.toLowerCase(), reserved);
    assert.ok(safeFileName(reserved).endsWith(reserved), reserved);
  }
  assert.equal(safeFileName("CONSOLE"), "CONSOLE");
  assert.equal(safeFileName("x".repeat(500)).length, 120);
});

test("mp4Name swaps the extension and sanitises the rest", () => {
  assert.equal(mp4Name("movie.mkv"), "movie.mp4");
  assert.equal(mp4Name("a.b.c.webm"), "a.b.c.mp4");
  assert.equal(mp4Name("noextension"), "noextension.mp4");
  assert.equal(mp4Name("My: Movie?.mkv"), "My_ Movie_.mp4");
  assert.equal(mp4Name("dir/inside.mkv"), "dir_inside.mp4");
  assert.equal(mp4Name(""), "output.mp4");
  assert.equal(mp4Name(null), "output.mp4");
});

test("numberedName inserts the counter before the extension", () => {
  assert.equal(numberedName("a.mp4", 0), "a.mp4");
  assert.equal(numberedName("a.mp4", 1), "a (1).mp4");
  assert.equal(numberedName("a.b.mp4", 12), "a.b (12).mp4");
  assert.equal(numberedName("plain", 2), "plain (2)");
});

test("uniqueFileName never picks a name that is taken", async () => {
  assert.equal(await uniqueFileName(fakeDir(), "a.mp4"), "a.mp4");
  assert.equal(await uniqueFileName(fakeDir({ files: ["a.mp4"] }), "a.mp4"), "a (1).mp4");
  assert.equal(await uniqueFileName(fakeDir({ files: ["a.mp4", "a (1).mp4"] }), "a.mp4"), "a (2).mp4");
});

test("uniqueFileName treats a directory with that name as taken and never creates anything", async () => {
  const dir = fakeDir({ dirs: ["a.mp4"] });
  assert.equal(await uniqueFileName(dir, "a.mp4"), "a (1).mp4");
  assert.ok(dir.calls.every((c) => c.create === false), "uniqueFileName must only look");
});

test("uniqueFileName passes real errors through and gives up after the limit", async () => {
  await assert.rejects(() => uniqueFileName(fakeDir({ failWith: "NotAllowedError" }), "a.mp4"), { name: "NotAllowedError" });
  const everything = { async getFileHandle() { return { kind: "file" }; } };
  await assert.rejects(() => uniqueFileName(everything, "a.mp4", 5), /free file name/);
});

test("createOutputFile creates the file under a free name and returns both", async () => {
  const dir = fakeDir({ files: ["clip.mp4"] });
  const out = await createOutputFile(dir, "clip.mp4");
  assert.equal(out.name, "clip (1).mp4");
  assert.equal(out.handle.name, "clip (1).mp4");
  assert.ok(dir.taken.has("clip (1).mp4"));
  assert.deepEqual(dir.calls.filter((c) => c.create).map((c) => c.name), ["clip (1).mp4"]);
});

test("classifyFolderFailure maps permission errors to SAVE_DENIED and the rest to SAVE_FAILED", () => {
  const denied = classifyFolderFailure({ name: "NotAllowedError", message: "x" });
  assert.equal(denied.code, "SAVE_DENIED");
  assert.match(denied.message, /^save denied: NotAllowedError/);
  const other = classifyFolderFailure({ name: "NotFoundError", message: "gone" });
  assert.equal(other.code, "SAVE_FAILED");
  assert.match(other.message, /^save error: NotFoundError: gone/);
  assert.equal(classifyFolderFailure(null).code, "SAVE_FAILED");
});

test("the 'use a normal download' choice is remembered and nothing else is", () => {
  const data = new Map();
  const storage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  assert.equal(readSavePreference(storage), null);
  writeSavePreference(storage, "browser");
  assert.equal(data.get(SAVE_PREF_KEY), "browser");
  assert.equal(readSavePreference(storage), "browser");
  writeSavePreference(storage, null);
  assert.equal(readSavePreference(storage), null);
  data.set(SAVE_PREF_KEY, "something else");
  assert.equal(readSavePreference(storage), null);
});

test("preference helpers survive missing or throwing storage", () => {
  const broken = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  assert.equal(readSavePreference(broken), null);
  assert.doesNotThrow(() => writeSavePreference(broken, "browser"));
  assert.equal(readSavePreference(undefined), null);
  assert.doesNotThrow(() => writeSavePreference(undefined, "browser"));
});

test("canPickFolder needs showDirectoryPicker", () => {
  assert.equal(canPickFolder({ showDirectoryPicker() {} }), true);
  assert.equal(canPickFolder({}), false);
  assert.equal(canPickFolder(null), false);
});
