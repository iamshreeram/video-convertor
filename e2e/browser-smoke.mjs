// Headless-Chrome end-to-end smoke test for the static site in ../dist.
// Dev-only tool: not part of the shipped site. Build first: bash scripts/build.sh
//
// Usage: node browser-smoke.mjs [--big]
//   --big  also run T10 (generates a ~450 MB input; takes several minutes)
//
// Env overrides: CHROME_PATH, FFMPEG, FFPROBE.
// Exit code: 0 when no test FAILs (SKIPs allowed), 1 on any FAIL, 2 on setup error.

import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG || "/tmp/mkvtools/ffmpeg";
const FFPROBE = process.env.FFPROBE || "/tmp/mkvtools/ffprobe";
const FIXTURES = "/tmp/mkvtools/fixtures";
const BIG_IN = "/tmp/mkvtools/big.mkv";
const BIG_OUT = "/tmp/mkvtools/big-out.mp4";
const VP9_IN = "/tmp/mkvtools/vp9only.mkv";
const PREFIX = "/web-mkv-mp4";
const CONVERT_TIMEOUT = 120000;
const POLL = { polling: 100 };

const BIG = process.argv.includes("--big");
const unknownArgs = process.argv.slice(2).filter((a) => a !== "--big");
if (unknownArgs.length > 0) {
  console.error(`browser-smoke: unknown argument(s): ${unknownArgs.join(" ")}`);
  process.exit(2);
}

const fixture = (name) => path.join(FIXTURES, `${name}.mkv`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// ffmpeg prefixes log lines with a per-process pointer ("[null @ 0x14fe05670]"),
// so addresses are masked before lines are compared across processes.
const splitLines = (text) =>
  String(text || "")
    .split("\n")
    .map((line) => line.trim().replace(/0x[0-9a-fA-F]+/g, "0x*"))
    .filter(Boolean);
const firstLine = (text) => String(text).split("\n")[0];

class SkipError extends Error {}
const skip = (message) => {
  throw new SkipError(message);
};
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

// ---------- static server (dist/ at "/" and under "/web-mkv-mp4/") ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) {
      pathname = pathname.slice(PREFIX.length) || "/";
    }
    // Browsers request /favicon.ico automatically; answer it so it is not a 404 console error.
    if (pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (pathname.endsWith("/")) {
      pathname += "index.html";
    }
    const file = path.normalize(path.join(DIST, pathname));
    if (!file.startsWith(DIST + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------- ffmpeg / ffprobe helpers ----------

async function probe(file) {
  const { stdout } = await execFileAsync(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
    { maxBuffer: 64 << 20 },
  );
  const info = JSON.parse(stdout);
  return {
    streams: (info.streams || []).map((s) => ({ type: s.codec_type, codec: s.codec_name })),
    duration: Number(info.format && info.format.duration),
  };
}

// Sorted "type:codec" list for video and audio streams only.
const codecSig = (info) =>
  info.streams
    .filter((s) => s.type === "video" || s.type === "audio")
    .map((s) => `${s.type}:${s.codec}`)
    .sort();

async function ffmpegDecode(file, seconds) {
  const args = ["-v", "error", "-i", file];
  if (seconds) {
    args.push("-t", String(seconds));
  }
  args.push("-f", "null", "-");
  try {
    const { stderr } = await execFileAsync(FFMPEG, args, { maxBuffer: 64 << 20, timeout: 900000 });
    return { code: 0, lines: splitLines(stderr) };
  } catch (err) {
    return { code: typeof err.code === "number" ? err.code : -1, lines: splitLines(err.stderr) };
  }
}

// Returns a problem string, or null when the output decodes cleanly.
// Exit must be 0; stderr lines are tolerated only if the source also prints them.
async function decodeProblem(srcFile, outFile, seconds) {
  const out = await ffmpegDecode(outFile, seconds);
  if (out.code !== 0) {
    return `ffmpeg decode of output exited ${out.code}: ${out.lines.slice(0, 2).join(" / ")}`;
  }
  if (out.lines.length === 0) {
    return null;
  }
  const src = await ffmpegDecode(srcFile, seconds);
  const extra = out.lines.filter((line) => !src.lines.includes(line));
  return extra.length > 0
    ? `output decode stderr not present when decoding source: ${extra.slice(0, 2).join(" / ")}`
    : null;
}

// Codec match against the source plus decode check. Returns {problems, got, out}.
async function verifyOutput(srcFile, outFile, seconds) {
  const [src, out] = await Promise.all([probe(srcFile), probe(outFile)]);
  const problems = [];
  const want = codecSig(src);
  const got = codecSig(out);
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    problems.push(`codecs ${JSON.stringify(got)} != source ${JSON.stringify(want)}`);
  }
  const decode = await decodeProblem(srcFile, outFile, seconds);
  if (decode) {
    problems.push(decode);
  }
  return { problems, got, out, src };
}

async function sha256File(file) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}

// ---------- page helpers ----------

let browser;
let ROOT;
let SUB;
const shared = {};

// Runs in the page before any script: records the session lock name and,
// when delayMs > 0, delays the lock callback (the "lock-ready handshake").
function installLockWrapper({ delayMs }) {
  const locks = navigator.locks;
  if (!locks || typeof locks.request !== "function") {
    return;
  }
  const original = locks.request.bind(locks);
  locks.request = function (name, ...rest) {
    window.__mkvLockName = name;
    const last = rest.length - 1;
    const callback = rest[last];
    if (typeof callback === "function" && delayMs > 0) {
      rest[last] = (lock) =>
        new Promise((resolve) => setTimeout(resolve, delayMs)).then(() => callback(lock));
    }
    return original(name, ...rest);
  };
}
const lockInit = (delayMs) => ({ fn: installLockWrapper, arg: { delayMs } });

function watchPage(page, issues) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      issues.push(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => issues.push(`pageerror: ${err.message}`));
}

async function newContext(env, initScript = null) {
  const context = await browser.newContext({ acceptDownloads: true });
  env.contexts.push(context);
  if (initScript) {
    await context.addInitScript(initScript.fn, initScript.arg);
  }
  return context;
}

async function newPage(env, { context = null, url = ROOT, waitReady = true } = {}) {
  const ctx = context || (await newContext(env));
  const page = await ctx.newPage();
  watchPage(page, env.issues);
  await page.goto(url, { waitUntil: "load" });
  if (waitReady) {
    await waitForState(page, ["ready"], 30000);
  }
  return page;
}

const stateOf = (page) => page.evaluate(() => document.documentElement.dataset.state ?? null);

async function waitForState(page, states, timeout) {
  await page.waitForFunction(
    (list) => list.includes(document.documentElement.dataset.state),
    states,
    { timeout, ...POLL },
  );
  return stateOf(page);
}

async function errorTextOf(page) {
  return ((await page.textContent("#error").catch(() => "")) || "").trim();
}

async function expectDone(page, state) {
  if (state !== "done") {
    throw new Error(`expected state done, got ${state}; #error="${await errorTextOf(page)}"`);
  }
}

// Uploads a file (page must be idle/enabled) and waits for done or error.
async function convertFile(page, file, timeout = CONVERT_TIMEOUT) {
  await page.waitForFunction(() => !document.getElementById("file-input").disabled, null, {
    timeout: 30000,
    ...POLL,
  });
  await page.setInputFiles("#file-input", file);
  // file-info is set synchronously when a conversion starts: use it to avoid
  // matching a stale "error" state from a previous run.
  const name = path.basename(file);
  await page.waitForFunction(
    (n) => document.getElementById("file-info").textContent.startsWith(n),
    name,
    { timeout: 10000, ...POLL },
  );
  return waitForState(page, ["done", "error"], timeout);
}

async function downloadTo(page, dest) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click("#download"),
  ]);
  await download.saveAs(dest);
  return download.suggestedFilename();
}

async function downloadSha(page, dest) {
  await downloadTo(page, dest);
  return sha256File(dest);
}

async function opfsNames(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name] of root.entries()) {
      names.push(name);
    }
    return names;
  });
}

const outNames = (names) => names.filter((name) => /^out-.*\.mp4$/.test(name));

async function sessionIdOf(page) {
  const name = await page.evaluate(() => window.__mkvLockName);
  assert(
    typeof name === "string" && name.startsWith("mkv2mp4:"),
    `session lock name not recorded: ${name}`,
  );
  return name.slice("mkv2mp4:".length);
}

function assertNoIssues(env) {
  assert(
    env.issues.length === 0,
    `console/page issues (${env.issues.length}): ${env.issues.slice(0, 3).join(" | ")}`,
  );
}

// ---------- test runner ----------

const results = [];

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function runTest(id, title, timeoutMs, body) {
  const env = { issues: [], contexts: [] };
  const started = Date.now();
  let status;
  let detail;
  try {
    detail = (await withTimeout(body(env), timeoutMs, id)) || "";
    status = "PASS";
  } catch (err) {
    if (err instanceof SkipError) {
      status = "SKIP";
      detail = err.message;
    } else {
      status = "FAIL";
      detail = firstLine(err.message);
    }
  } finally {
    for (const context of env.contexts) {
      await context.close().catch(() => {});
    }
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${status} ${id} (${secs}s) ${title}${detail ? ` -- ${detail}` : ""}`);
  results.push({ id, title, status, detail });
}

// ---------- tests ----------


async function testT2(env) {
  assert(shared.t1Sha, "T1 produced no output to compare against");
  const page = await newPage(env, { url: `${ROOT}?nofs=1` });
  const state = await convertFile(page, fixture("h264_aac"));
  await expectDone(page, state);

  const opfs = outNames(await opfsNames(page));
  assert(opfs.length === 0, `in-memory mode wrote OPFS files: ${opfs}`);

  const dest = path.join(WORK, "t2-nofs.mp4");
  const sha = await downloadSha(page, dest);
  assert(sha === shared.t1Sha, `sha256 differs from OPFS output: ${sha} vs ${shared.t1Sha}`);
  assertNoIssues(env);
  return "in-memory sink: no OPFS files; bytes identical to T1 (sha256 match)";
}

async function testT3(env) {
  const bad = path.join(WORK, "bad.mkv");
  fs.writeFileSync(bad, randomBytes(5 * 1024));
  const page = await newPage(env);
  const state = await convertFile(page, bad);
  assert(state === "error", `garbage file: expected state error, got ${state}`);

  const message = await errorTextOf(page);
  assert(message.length > 0, "garbage file: #error text is empty");
  assert(!/undefined|\[object/.test(message), `garbage file: #error not human readable: "${message}"`);
  assert(!(await page.locator("#download").isVisible()), "garbage file: #download is visible");

  const recovered = await convertFile(page, fixture("h264_aac"));
  await expectDone(page, recovered);
  assert((await errorTextOf(page)) === "", "error text not cleared after recovery");
  const dest = path.join(WORK, "t3-recovered.mp4");
  await downloadTo(page, dest);
  const { problems } = await verifyOutput(fixture("h264_aac"), dest, null);
  assert(problems.length === 0, `recovered output: ${problems.join("; ")}`);
  return `error shown: "${message.slice(0, 80)}"; download hidden; recovery conversion ok`;
}

async function testT4(env) {
  const encoders = await execFileAsync(FFMPEG, ["-hide_banner", "-encoders"], {
    maxBuffer: 16 << 20,
  });
  if (!/libvpx-vp9/.test(encoders.stdout)) {
    skip("ffmpeg has no libvpx-vp9 encoder");
  }
  await execFileAsync(
    FFMPEG,
    [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10",
      "-t", "1", "-c:v", "libvpx-vp9", "-f", "matroska", VP9_IN,
    ],
    { timeout: 300000 },
  );
  const page = await newPage(env);
  const state = await convertFile(page, VP9_IN);
  assert(state === "error", `vp9-only: expected state error, got ${state}`);
  const message = await errorTextOf(page);
  assert(/vp9/i.test(message), `vp9-only: message does not mention the codec: "${message}"`);
  const literal = message.includes("V_VP9") ? "literal V_VP9 present" : "literal V_VP9 absent";
  return `error: "${message.slice(0, 100)}" (${literal})`;
}

const T5_CODECS = ["hevc_aac", "h264_flac", "h264_ac3", "h264_mp3", "h264_opus", "av1_aac", "h264_only"];

async function testCodec(env, name) {
  const page = await newPage(env);
  const state = await convertFile(page, fixture(name));
  await expectDone(page, state);
  const dest = path.join(WORK, `t5-${name}.mp4`);
  const suggested = await downloadTo(page, dest);
  const { problems, got } = await verifyOutput(fixture(name), dest, null);
  assert(problems.length === 0, problems.join("; "));
  assertNoIssues(env);
  return `${got.join(", ") || "no a/v streams"}; download "${suggested}"`;
}

async function testT6(env) {
  const page = await newPage(env);
  const state = await convertFile(page, fixture("h264_aac"));
  await expectDone(page, state);
  assert(outNames(await opfsNames(page)).length >= 1, "no out-*.mp4 before Convert another");

  await page.click("#again");
  const after = await waitForState(page, ["ready"], 5000);
  assert(after === "ready", `after Convert another: state ${after}`);
  const src = await page.getAttribute("#preview", "src");
  assert(!src, `#preview still has src: ${src}`);

  const deadline = Date.now() + 5000;
  let left = outNames(await opfsNames(page));
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(200);
    left = outNames(await opfsNames(page));
  }
  assert(left.length === 0, `out-*.mp4 still present 5 s after Convert another: ${left}`);
  return "state ready; #preview src cleared; OPFS out file removed";
}

async function testT7(env) {
  const ctx = await newContext(env, lockInit(0));
  const pageA = await newPage(env, { context: ctx });
  const pageB = await newPage(env, { context: ctx });
  const idA = await sessionIdOf(pageA);
  const idB = await sessionIdOf(pageB);

  const [stA, stB] = await Promise.all([
    convertFile(pageA, fixture("h264_aac")),
    convertFile(pageB, fixture("h264_opus")),
  ]);
  await expectDone(pageA, stA);
  await expectDone(pageB, stB);
  const firstA = await downloadSha(pageA, path.join(WORK, "t7-a1.mp4"));
  const firstB = await downloadSha(pageB, path.join(WORK, "t7-b1.mp4"));

  const pageC = await newPage(env, { context: ctx });
  const idC = await sessionIdOf(pageC);
  await expectDone(pageC, await convertFile(pageC, fixture("hevc_aac")));

  const againA = await downloadSha(pageA, path.join(WORK, "t7-a2.mp4"));
  const againB = await downloadSha(pageB, path.join(WORK, "t7-b2.mp4"));
  assert(againA === firstA, "A re-download differs from its first download");
  assert(againB === firstB, "B re-download differs from its first download");

  const before = outNames(await opfsNames(pageA));
  assert(before.length >= 3, `expected >= 3 out-*.mp4 with A, B, C open; found ${before.length}`);
  for (const id of [idA, idB, idC]) {
    assert(before.some((n) => n.startsWith(`out-${id}-`)), `no OPFS file for session ${id}`);
  }

  await pageA.close();
  const pageD = await newPage(env, { context: ctx });
  const idD = await sessionIdOf(pageD);
  await expectDone(pageD, await convertFile(pageD, fixture("h264_ac3")));

  const deadline = Date.now() + 8000;
  let names = outNames(await opfsNames(pageD));
  while (names.some((n) => n.startsWith(`out-${idA}-`)) && Date.now() < deadline) {
    await sleep(250);
    names = outNames(await opfsNames(pageD));
  }
  assert(
    !names.some((n) => n.startsWith(`out-${idA}-`)),
    "A's orphan file still present 8 s after tab A closed and D converted",
  );
  for (const id of [idB, idC, idD]) {
    assert(names.some((n) => n.startsWith(`out-${id}-`)), `live session ${id} file was swept`);
  }
  const bAfterSweep = await downloadSha(pageB, path.join(WORK, "t7-b3.mp4"));
  assert(bAfterSweep === firstB, "B download changed after sweep");
  return `3 sessions with files; re-download sha match; orphan A swept within 8 s; B,C,D kept; OPFS now ${names.length} out files`;
}

async function testT8(env) {
  const ctx = await newContext(env, lockInit(1500));
  const page = await ctx.newPage();
  watchPage(page, env.issues);
  await page.goto(ROOT, { waitUntil: "load" });

  let readyAt = null;
  const deadline = Date.now() + 10000;
  let samples = 0;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => ({
      state: document.documentElement.dataset.state ?? null,
      disabled: document.getElementById("file-input").disabled,
      t: performance.now(),
    }));
    if (s.state === "ready") {
      readyAt = s.t;
      break;
    }
    assert(
      s.state === null || s.state === "init",
      `state ${s.state} before lock callback ran (at ${s.t.toFixed(0)} ms)`,
    );
    assert(s.disabled, "file input enabled before ready");
    const names = outNames(await opfsNames(page));
    assert(names.length === 0, `out file appeared before ready: ${names}`);
    samples += 1;
    await sleep(50);
  }
  assert(readyAt !== null, "never reached ready within 10 s");
  assert(readyAt >= 1000, `ready at ${readyAt.toFixed(0)} ms; lock delay not honoured (< 1000 ms)`);

  await expectDone(page, await convertFile(page, fixture("h264_aac")));
  assertNoIssues(env);
  return `init held for ${readyAt.toFixed(0)} ms (${samples} samples, no out file); then conversion done`;
}

async function testT9(env) {
  const page = await newPage(env);
  await page.setInputFiles("#file-input", fixture("h264_aac"));
  const st = await stateOf(page);
  if (st !== "converting") {
    skip(`conversion already ${st} before cancel click`);
  }
  try {
    await page.click("#cancel", { timeout: 3000 });
  } catch (err) {
    const now = await stateOf(page);
    if (now !== "converting") {
      skip(`conversion finished (${now}) before cancel click`);
    }
    throw err;
  }
  const after = await waitForState(page, ["ready", "error", "done"], 15000);
  assert(after === "ready", `after cancel: state ${after}, expected ready`);

  const deadline = Date.now() + 5000;
  let names = outNames(await opfsNames(page));
  while (names.length > 0 && Date.now() < deadline) {
    await sleep(250);
    names = outNames(await opfsNames(page));
  }
  assert(names.length === 0, `stray out-*.mp4 after cancel: ${names}`);

  await expectDone(page, await convertFile(page, fixture("h264_aac")));
  return "cancelled mid-conversion; UI back to ready; no stray OPFS file; next conversion done";
}

async function testT10(env) {
  if (!BIG) {
    skip("--big not given");
  }
  try {
    if (!fs.existsSync(BIG_IN)) {
      await execFileAsync(
        FFMPEG,
        [
          "-v", "error", "-y",
          "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
          "-t", "270", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "12M",
          "-c:a", "aac", "-f", "matroska", BIG_IN,
        ],
        { timeout: 1500000 },
      );
    }
    const inSize = fs.statSync(BIG_IN).size;
    const page = await newPage(env);
    const started = Date.now();
    const state = await convertFile(page, BIG_IN, 900000);
    const wallSecs = (Date.now() - started) / 1000;
    await expectDone(page, state);
    await downloadTo(page, BIG_OUT);
    const outSize = fs.statSync(BIG_OUT).size;
    const { problems, src, out } = await verifyOutput(BIG_IN, BIG_OUT, 20);
    assert(problems.length === 0, problems.join("; "));
    const drift = Math.abs(out.duration - src.duration);
    assert(drift <= 0.1, `duration drift ${drift.toFixed(3)} s (src ${src.duration}, out ${out.duration})`);
    assertNoIssues(env);
    return `input ${(inSize / 2 ** 20).toFixed(0)} MiB, output ${(outSize / 2 ** 20).toFixed(0)} MiB, wall ${wallSecs.toFixed(1)} s, duration drift ${drift.toFixed(3)} s`;
  } finally {
    for (const file of [BIG_IN, BIG_OUT]) {
      fs.rmSync(file, { force: true });
    }
  }
}

// ---------- main ----------

let WORK = "";

async function main() {
  for (const name of ["h264_aac", "h264_opus", "hevc_aac", "h264_ac3", "h264_mp3", "h264_flac", "av1_aac", "h264_only"]) {
    if (!fs.existsSync(fixture(name))) {
      console.error(`browser-smoke: missing fixture ${fixture(name)}`);
      process.exit(2);
    }
  }
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error(`browser-smoke: ${DIST} missing; run bash scripts/build.sh first`);
    process.exit(2);
  }
  WORK = fs.mkdtempSync("/tmp/mkvtools/e2e-run-");

  const server = await startServer();
  const port = server.address().port;
  ROOT = `http://127.0.0.1:${port}/`;
  SUB = `http://127.0.0.1:${port}${PREFIX}/`;
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    console.log(`Chrome ${browser.version()} (${CHROME}); server ${ROOT} and ${SUB}`);

    await runTest("T1", "OPFS convert h264_aac at sub-path", 300000, async (env) => {
      const page = await newPage(env, { url: SUB });
      const state = await convertFile(page, fixture("h264_aac"));
      await expectDone(page, state);
      env.page = page;
      return testT1Body(env, page);
    });
    await runTest("T2", "in-memory sink (?nofs=1) matches T1 bytes", 300000, testT2);
    await runTest("T3", "garbage input -> error, then recovery", 300000, testT3);
    await runTest("T4", "VP9-only input -> unsupported-codec error", 300000, testT4);
    for (const name of T5_CODECS) {
      await runTest(`T5:${name}`, `codec ${name} converts and verifies`, 300000, (env) =>
        testCodec(env, name),
      );
    }
    await runTest("T6", "Convert another resets page and sweeps output", 300000, testT6);
    await runTest("T7", "multi-tab sessions, re-download, orphan sweep", 900000, testT7);
    await runTest("T8", "lock-ready handshake holds init", 180000, testT8);
    await runTest("T9", "cancel mid-conversion recovers", 300000, testT9);
    await runTest("T10", "large file (--big only)", 1500000, testT10);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(`SUMMARY: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("SKIP")} SKIP`);
  if (count("FAIL") === 0) {
    fs.rmSync(WORK, { recursive: true, force: true });
  } else {
    console.log(`work dir kept for triage: ${WORK}`);
  }
  process.exitCode = count("FAIL") > 0 ? 1 : 0;
}

// T1 body is split out so the test can keep its page reference for assertions.
async function testT1Body(env, page) {
  const dest = path.join(WORK, "t1-h264_aac.mp4");
  const opfs = outNames(await opfsNames(page));
  assert(opfs.length >= 1, `no out-*.mp4 in OPFS right after done (names: ${opfs})`);
  await downloadTo(page, dest);
  shared.t1Sha = await sha256File(dest);
  shared.t1Path = dest;
  return finishT1(env, page, dest);
}

async function finishT1(env, page, dest) {
  const { problems, got } = await verifyOutput(fixture("h264_aac"), dest, null);
  assert(
    JSON.stringify(got) === JSON.stringify(["audio:aac", "video:h264"]),
    `expected h264 + aac, ffprobe says ${JSON.stringify(got)}`,
  );
  assert(problems.length === 0, problems.join("; "));
  const width = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const video = document.getElementById("preview");
        const timer = setTimeout(() => reject(new Error("preview: no loadedmetadata within 20 s")), 20000);
        const finish = () => {
          clearTimeout(timer);
          resolve(video.videoWidth);
        };
        if (video.readyState >= 1) {
          finish();
        } else {
          video.addEventListener("loadedmetadata", finish, { once: true });
          video.addEventListener(
            "error",
            () => {
              clearTimeout(timer);
              reject(new Error(`preview: video error code ${video.error && video.error.code}`));
            },
            { once: true },
          );
        }
      }),
  );
  assert(width === 320, `preview videoWidth ${width}, expected 320`);
  const summary = (await page.textContent("#summary")) || "";
  assert(summary.includes("h264"), `#summary does not mention h264: "${summary.trim()}"`);
  assertNoIssues(env);
  return `OPFS out file present; ffprobe h264+aac; decode clean; preview width 320; sha256 ${shared.t1Sha.slice(0, 12)}`;
}

main().catch((err) => {
  console.error(`browser-smoke: setup error: ${err.stack || err.message}`);
  process.exitCode = 2;
});
