// Headless-Chrome end-to-end suite for the static site in ../dist (dev-only tool, not shipped).
// Build first: bash scripts/build.sh
//
// Usage: node browser-smoke.mjs [--list] [--big]
//   --list  print the test ids and names, then exit 0 (no browser, no ffmpeg needed)
//   --big   also run the [--big] tests (T9, T10, T12). Generates ~390 MB
//           /tmp/mkvtools/big.mkv when missing; deleted at exit if this run made it.
//   --only=T1,T11  run only the listed test ids (for trials)
//
// Env overrides: CHROME_PATH, FFMPEG, FFPROBE.
// Exit: 0 when no FAIL (SKIP allowed), 1 on any FAIL, 2 on setup or argument error.
//
// Selectors follow DESIGN.md "UI test contract" (data-testid values are stable API).

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { relaceAudio } from "./fixtures/relace-audio.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const PROBE_WORKER_FILE = path.join(here, "fixtures", "probe-worker.js");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG || "/tmp/mkvtools/ffmpeg";
const FFPROBE = process.env.FFPROBE || "/tmp/mkvtools/ffprobe";
const FIXTURES = "/tmp/mkvtools/fixtures";
const BIG_IN = "/tmp/mkvtools/big.mkv";
const BIG_NAME = "big.mkv";
const VP9_IN = "/tmp/mkvtools/vp9only.mkv";
const PREFIX = "/video-convertor"; // the real GitHub Pages sub-path
const CONVERT_TIMEOUT = 120000;
const POLL = { polling: 100 };
const JOB = '[data-testid="job"]';

const args = process.argv.slice(2);
const onlyArg = args.find((arg) => arg.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean)) : null;
const KNOWN_ARGS = new Set(["--big", "--list"]);
const unknownArgs = args.filter((arg) => !KNOWN_ARGS.has(arg) && !arg.startsWith("--only="));
if (unknownArgs.length > 0) {
  console.error(`browser-smoke: unknown argument(s): ${unknownArgs.join(" ")}`);
  process.exit(2);
}
const LIST = args.includes("--list");
const BIG = args.includes("--big");

// ---------- small helpers ----------

const fixture = (name) => path.join(FIXTURES, `${name}.mkv`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testid = (id) => `[data-testid="${id}"]`;
const jobSelByName = (name) => `${JOB}[data-name="${name.replace(/["\\]/g, "\\$&")}"]`;
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

async function waitUntil(check, timeoutMs, message, interval = 100) {
  const started = Date.now();
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(message);
    }
    await sleep(interval);
  }
}

// ---------- static server: dist/ at "/" and under PREFIX, test worker at /__test__ ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

// Every request the server answers is logged here (ground truth for T18, including
// requests issued from inside workers, which page events may not show).
function startServer(hits) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let raw;
    try {
      raw = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const hit = { method: req.method, raw, status: 0 };
    hits.push(hit);
    const respond = (status, body, type) => {
      hit.status = status;
      const headers = { "cache-control": "no-store" };
      if (type) headers["content-type"] = type;
      res.writeHead(status, headers);
      res.end(body);
    };
    if (raw === "/favicon.ico" || raw === `${PREFIX}/favicon.ico`) {
      respond(204, undefined);
      return;
    }
    let rel = raw;
    if (rel === PREFIX || rel.startsWith(`${PREFIX}/`)) {
      rel = rel.slice(PREFIX.length) || "/";
    }
    if (rel === "/__test__/probe-worker.js") {
      fs.readFile(PROBE_WORKER_FILE, (err, body) =>
        err ? respond(404, "not found", "text/plain") : respond(200, body, MIME[".js"]),
      );
      return;
    }
    if (rel.endsWith("/")) {
      rel += "index.html";
    }
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep)) {
      respond(404, "not found", "text/plain");
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        respond(404, "not found", "text/plain");
        return;
      }
      respond(200, body, MIME[path.extname(file)] || "application/octet-stream");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------- ffmpeg / ffprobe helpers ----------

async function probeFull(file) {
  const { stdout } = await execFileAsync(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
    { maxBuffer: 64 << 20 },
  );
  const info = JSON.parse(stdout);
  return {
    streams: (info.streams || []).map((s) => ({
      type: s.codec_type,
      codec: s.codec_name,
      width: s.width,
      height: s.height,
      channels: s.channels,
      sampleRate: Number(s.sample_rate),
    })),
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
  const cmd = ["-v", "error", "-i", file];
  if (seconds) {
    cmd.push("-t", String(seconds));
  }
  cmd.push("-f", "null", "-");
  try {
    const { stderr } = await execFileAsync(FFMPEG, cmd, { maxBuffer: 64 << 20, timeout: 900000 });
    return { code: 0, lines: splitLines(stderr) };
  } catch (err) {
    return { code: typeof err.code === "number" ? err.code : -1, lines: splitLines(err.stderr) };
  }
}

// Returns a problem string, or null when the output decodes cleanly. Exit must be 0;
// stderr lines are tolerated only if decoding the source prints them too.
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

// Codec match against the source plus decode check.
async function verifyOutput(srcFile, outFile, seconds) {
  const [src, out] = await Promise.all([probeFull(srcFile), probeFull(outFile)]);
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

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function ensureBigInput() {
  if (fs.existsSync(BIG_IN)) {
    return false;
  }
  try {
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
  } catch (err) {
    fs.rmSync(BIG_IN, { force: true });
    throw err;
  }
  return true;
}

// Returns true when a VP9-only input exists or could be created; false when no encoder.
async function ensureVp9Input() {
  if (fs.existsSync(VP9_IN)) {
    return true;
  }
  const encoders = await execFileAsync(FFMPEG, ["-hide_banner", "-encoders"], {
    maxBuffer: 16 << 20,
  });
  if (!/libvpx-vp9/.test(encoders.stdout)) {
    return false;
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
  return true;
}

// ---------- browser state ----------

let browser;
let WORK = "";
const shared = { hits: [] };

// Page-side init scripts. Each is serialised by Playwright, so keep them self-contained.

// Records every Worker constructed by the page (T18, T19b).
function spyWorkers() {
  window.__workerUrls = [];
  const Native = window.Worker;
  if (typeof Native !== "function") {
    return;
  }
  class SpyWorker extends Native {
    constructor(url, options) {
      super(url, options);
      window.__workerUrls.push(String(url));
    }
  }
  window.Worker = SpyWorker;
}

// Records CSP violations on the document (T11, T17).
function cspRecorder() {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__cspViolations.push(String(event.blockedURI));
  });
}

// Delays every navigator.locks.request callback (T8 lock-ready handshake).
function lockDelay(arg) {
  const locks = navigator.locks;
  if (!locks || typeof locks.request !== "function") {
    return;
  }
  const original = locks.request.bind(locks);
  locks.request = function (...requestArgs) {
    const last = requestArgs.length - 1;
    if (typeof requestArgs[last] === "function") {
      const callback = requestArgs[last];
      requestArgs[last] = (lock) =>
        new Promise((resolve) => setTimeout(resolve, arg.ms)).then(() => callback(lock));
    }
    return original(...requestArgs);
  };
}

// rAF gap and long-task recorder (T12).
function framePerf() {
  window.__frames = { last: 0, maxGap: 0 };
  const tick = (now) => {
    const frames = window.__frames;
    if (frames.last) {
      const gap = now - frames.last;
      if (gap > frames.maxGap) {
        frames.maxGap = gap;
      }
    }
    frames.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__longtasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longtasks.push(entry.duration);
      }
    }).observe({ type: "longtask", buffered: false });
  } catch {
    window.__longtasks = null;
  }
}

const DEFAULT_INIT = [{ fn: spyWorkers }, { fn: cspRecorder }];

function watchPage(page, env) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      env.issues.push(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => env.issues.push(`pageerror: ${err.message}`));
}

function assertNoIssues(env) {
  assert(
    env.issues.length === 0,
    `console/page issues (${env.issues.length}): ${env.issues.slice(0, 3).join(" | ")}`,
  );
}

async function newContext(env, extraInit = []) {
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
  env.contexts.push(context);
  for (const script of [...DEFAULT_INIT, ...extraInit]) {
    if (script.arg === undefined) {
      await context.addInitScript(script.fn);
    } else {
      await context.addInitScript(script.fn, script.arg);
    }
  }
  return context;
}

// Blocks everything except the local origin; records what was attempted.
async function installIsolation(context, origin, log) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    let url = null;
    try {
      url = new URL(request.url());
    } catch {
      url = null;
    }
    if (url && (url.protocol === "blob:" || url.protocol === "data:")) {
      await route.continue();
      return;
    }
    if (url && url.origin === origin) {
      log.local.push({
        method: request.method(),
        url: request.url(),
        body: request.postData() !== null,
      });
      await route.continue();
      return;
    }
    log.nonLocal.push(request.url());
    await route.abort();
  });
}

const newIsolationLog = () => ({ local: [], nonLocal: [] });

async function waitForState(page, states, timeout) {
  await page.waitForFunction(
    (list) => list.includes(document.documentElement.dataset.state),
    states,
    { timeout, ...POLL },
  );
  return page.evaluate(() => document.documentElement.dataset.state ?? null);
}

async function openPageIn(env, context, url, { waitStates = ["ready"] } = {}) {
  const page = await context.newPage();
  watchPage(page, env);
  await page.goto(url, { waitUntil: "load" });
  await waitForState(page, waitStates, 30000);
  return page;
}

async function openApp(env, { url, extraInit = [] }) {
  const context = await newContext(env, extraInit);
  return openPageIn(env, context, url);
}

// ---------- job-card helpers (selectors from DESIGN.md / ui/job-card.js) ----------

function cardOf(page, pick) {
  const base = pick.name !== undefined ? page.locator(jobSelByName(pick.name)) : page.locator(JOB);
  return base.nth(pick.index || 0);
}

async function cardCount(page) {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, JOB);
}

// Reads data-state of the picked card (null when the card does not exist yet).
async function stateOfPick(page, pick) {
  return page.evaluate((p) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="job"]'));
    const matches = p.name !== undefined ? cards.filter((c) => c.dataset.name === p.name) : cards;
    const card = matches[p.index || 0];
    return card ? card.dataset.state : null;
  }, pick);
}

async function waitCard(page, pick, states, timeout = CONVERT_TIMEOUT, interval = 100) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await stateOfPick(page, pick);
    if (last && states.includes(last)) {
      return last;
    }
    await sleep(interval);
  }
  throw new Error(
    `card ${JSON.stringify(pick)} did not reach ${states.join("|")} in ${timeout / 1000}s (last: ${last})`,
  );
}

async function cardText(page, pick, selector) {
  const text = await cardOf(page, pick)
    .locator(selector)
    .textContent({ timeout: 2000 })
    .catch(() => "");
  return (text || "").trim();
}

async function expectDone(page, pick, state) {
  if (state !== "done") {
    const error = await cardText(page, pick, testid("job-error"));
    throw new Error(`expected done, got ${state}; job-error="${firstLine(error)}"`);
  }
}

// Uploads files through the real file input and waits until each card is attached.
async function addFiles(page, paths) {
  await page.waitForFunction(
    () => {
      const input = document.querySelector('[data-testid="file-input"]');
      return Boolean(input) && !input.disabled;
    },
    null,
    { timeout: 30000, ...POLL },
  );
  await page.locator(testid("file-input")).setInputFiles(paths);
  const names = paths.map((p) => path.basename(p));
  for (const name of names) {
    await page.locator(jobSelByName(name)).first().waitFor({ state: "attached", timeout: 15000 });
  }
  return names;
}

// Adds one file as the newest card and waits for done or error. The new card is
// appended, so its index is the count before the add.
async function convertOne(page, file, timeout = CONVERT_TIMEOUT) {
  const before = await cardCount(page);
  await addFiles(page, [file]);
  const pick = { index: before };
  const state = await waitCard(page, pick, ["done", "error"], timeout);
  return { pick, state };
}

async function downloadFrom(page, pick, dest, timeout = 60000) {
  const card = cardOf(page, pick);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout }),
    card.locator(testid("job-download")).click(),
  ]);
  await download.saveAs(dest);
  return download.suggestedFilename();
}

async function downloadSha(page, pick, dest, timeout = 60000) {
  await downloadFrom(page, pick, dest, timeout);
  return sha256File(dest);
}

// Names of out-*.mp4 files in the OPFS root.
async function opfsOutNames(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === "file" && /^out-.*\.mp4$/.test(name)) {
        names.push(name);
      }
    }
    return names;
  });
}

// out-*.mp4 files in the OPFS root with size and SHA-256 (use for small outputs only).
async function opfsOutFiles(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const files = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "file" || !/^out-.*\.mp4$/.test(name)) {
        continue;
      }
      const file = await handle.getFile();
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      files.push({ name, size: file.size, sha });
    }
    return files;
  });
}

// Runs in the page against one card's progress bar (T12 sampler).
function sampleCard(pick) {
  const cards = Array.from(document.querySelectorAll('[data-testid="job"]'));
  const matches = pick.name !== undefined ? cards.filter((c) => c.dataset.name === pick.name) : cards;
  const card = matches[pick.index || 0];
  if (!card) {
    return null;
  }
  const bar = card.querySelector('[data-testid="job-progress"]');
  const pct = card.querySelector('[data-testid="job-percent"]');
  return {
    state: card.dataset.state,
    now: bar ? bar.getAttribute("aria-valuenow") : null,
    pct: pct ? pct.textContent : null,
  };
}

// Reads the About dialog's memory-budget readout (opens and closes the dialog).
async function readMemoryBudget(page) {
  const opener = page.locator(testid("about-open"));
  await opener.click();
  const dialog = page.locator(testid("about-dialog"));
  await waitUntil(() => dialog.evaluate((d) => d.open), 5000, "about dialog did not open");
  const text = ((await page.locator(testid("memory-budget")).textContent()) || "").trim();
  await page.keyboard.press("Escape");
  await waitUntil(() => dialog.evaluate((d) => !d.open), 5000, "about dialog did not close");
  return text;
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

async function runTest(test) {
  const env = { issues: [], contexts: [] };
  const started = Date.now();
  let status;
  let detail;
  try {
    detail = (await withTimeout(test.run(env), test.timeoutMs, test.id)) || "";
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
  console.log(`${status} ${test.id} (${secs}s) ${test.title}${detail ? ` -- ${detail}` : ""}`);
  results.push({ id: test.id, status });
}

// ---------- tests ----------

async function testT1(env) {
  const page = await openApp(env, { url: shared.sub });
  assert(
    new URL(page.url()).pathname.startsWith(`${PREFIX}/`),
    `page is not under ${PREFIX}/: ${page.url()}`,
  );
  const { pick, state } = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, pick, state);
  const card = cardOf(page, pick);

  const chips = (await card.locator(testid("job-track")).allTextContents()).map((t) => t.trim());
  const videoChip = chips.find((t) => /H\.264/.test(t));
  assert(videoChip && videoChip.includes("320\u00d7240"), `video chip: ${JSON.stringify(chips)}`);
  assert(chips.some((t) => /AAC/.test(t)), `no AAC chip: ${JSON.stringify(chips)}`);

  const duration = (await card.locator(testid("job-duration")).textContent()) || "";
  assert(/0:03/.test(duration), `job-duration "${duration}" is not 0:03`);
  assert(await card.locator(testid("job-output-size")).isVisible(), "job-output-size not shown");

  const bar = card.locator(testid("job-progress"));
  assert((await bar.getAttribute("role")) === "progressbar", "job-progress lacks role=progressbar");
  assert(((await bar.getAttribute("aria-label")) || "").trim() !== "", "job-progress lacks aria-label");

  const download = card.locator(testid("job-download"));
  const href = await download.getAttribute("href");
  assert(href && href.startsWith("blob:"), `job-download href is not blob: (${href})`);
  const suggestedAttr = (await download.getAttribute("download")) || "";
  assert(suggestedAttr.endsWith(".mp4"), `job-download download="${suggestedAttr}" is not *.mp4`);

  const outs = await opfsOutNames(page);
  assert(outs.length >= 1, `no out-*.mp4 in OPFS right after done (found ${JSON.stringify(outs)})`);

  const dest = path.join(WORK, "t1-h264_aac.mp4");
  const suggested = await downloadFrom(page, pick, dest);
  assert(suggested.endsWith(".mp4"), `suggested name "${suggested}"`);
  const { problems, got } = await verifyOutput(fixture("h264_aac"), dest, null);
  assert(
    JSON.stringify(got) === JSON.stringify(["audio:aac", "video:h264"]),
    `ffprobe streams ${JSON.stringify(got)}`,
  );
  assert(problems.length === 0, problems.join("; "));
  shared.t1Sha = await sha256File(dest);

  const toggle = card.locator(testid("job-preview-toggle"));
  await toggle.click();
  const preview = card.locator(testid("job-preview"));
  await preview.waitFor({ state: "attached", timeout: 10000 });
  const width = await preview.evaluate(
    (v) =>
      new Promise((resolve, reject) => {
        if (v.readyState >= 1) {
          resolve(v.videoWidth);
          return;
        }
        const timer = setTimeout(() => reject(new Error("no loadedmetadata within 20 s")), 20000);
        v.addEventListener(
          "loadedmetadata",
          () => {
            clearTimeout(timer);
            resolve(v.videoWidth);
          },
          { once: true },
        );
        v.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error(`video error code ${v.error && v.error.code}`));
          },
          { once: true },
        );
      }),
  );
  assert(width === 320, `preview videoWidth ${width}, expected 320`);
  await toggle.click();
  await preview.waitFor({ state: "detached", timeout: 5000 });
  assertNoIssues(env);
  return `OPFS out file present; ffprobe h264+aac; decode clean; preview 320px; sha256 ${shared.t1Sha.slice(0, 12)}`;
}

async function testT2(env) {
  assert(shared.t1Sha, "T1 produced no output to compare against (T1 must pass first)");
  const page = await openApp(env, { url: `${shared.root}?nofs=1` });
  const { pick, state } = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, pick, state);
  const outs = await opfsOutNames(page);
  assert(outs.length === 0, `in-memory mode wrote OPFS files: ${JSON.stringify(outs)}`);
  const sha = await downloadSha(page, pick, path.join(WORK, "t2-nofs.mp4"));
  assert(sha === shared.t1Sha, `sha256 differs from OPFS output: ${sha} vs ${shared.t1Sha}`);
  assertNoIssues(env);
  return "in-memory sink: no OPFS files; bytes identical to T1";
}

async function testT3(env) {
  const bad = path.join(WORK, "bad.mkv");
  fs.writeFileSync(bad, randomBytes(5 * 1024));
  const page = await openApp(env, { url: shared.root });
  const { pick, state } = await convertOne(page, bad);
  assert(state === "error", `garbage file: expected error, got ${state}`);
  const card = cardOf(page, pick);
  assert(await card.getAttribute("data-state") === "error", "card data-state is not error");
  const title = await cardText(page, pick, testid("job-error"));
  assert(
    title.includes("doesn\u2019t look like an MKV or WebM file"),
    `job-error text: "${firstLine(title)}"`,
  );
  const details = await card.locator(testid("job-error-details")).locator("code").textContent();
  assert((details || "").trim().length > 0, "job-error-details is empty");
  assert((await card.locator(testid("job-download")).count()) === 0, "error card has a download");

  const good = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, good.pick, good.state);
  return "garbage -> error card with raw details; valid file then converts on the same page";
}

async function testT4(env) {
  if (!(await ensureVp9Input())) {
    skip("no vp9only.mkv and no libvpx-vp9 encoder to create it");
  }
  const page = await openApp(env, { url: shared.root });
  const { pick, state } = await convertOne(page, VP9_IN);
  assert(state === "error", `vp9-only: expected error, got ${state}`);
  const card = cardOf(page, pick);
  const text = await cardText(page, pick, testid("job-error"));
  assert(
    text.includes("No supported video or audio found"),
    `job-error title: "${firstLine(text)}"`,
  );
  assert(text.includes("V_VP9"), `neither details nor hint mention V_VP9: "${firstLine(text)}"`);
  assert((await card.locator(testid("job-download")).count()) === 0, "vp9-only card has a download");
  return "error title 'No supported video or audio found'; V_VP9 shown";
}

const T5_CASES = [
  { name: "hevc_aac", chips: ["H.265"] },
  { name: "h264_flac", chips: ["FLAC"] },
  { name: "h264_ac3", chips: ["AC-3"] },
  { name: "h264_mp3", chips: ["MP3"] },
  { name: "h264_opus", chips: ["Opus"] },
  { name: "av1_aac", chips: ["AV1"] },
  { name: "h264_only", chips: ["H.264"], noAudio: true },
];

async function testT5(env) {
  const failures = [];
  const summary = [];
  for (const testCase of T5_CASES) {
    try {
      const page = await openApp(env, { url: shared.root });
      const { pick, state } = await convertOne(page, fixture(testCase.name));
      await expectDone(page, pick, state);
      const card = cardOf(page, pick);
      const tracks = await card.locator(testid("job-track")).evaluateAll((els) =>
        els.map((el) => ({ kind: el.dataset.kind, text: el.textContent.trim() })),
      );
      const texts = tracks.map((t) => t.text).join(" | ");
      for (const label of testCase.chips) {
        assert(texts.includes(label), `chip "${label}" missing: ${texts}`);
      }
      const audioChips = tracks.filter((t) => t.kind === "audio").length;
      if (testCase.noAudio) {
        assert(audioChips === 0, `unexpected audio chips: ${texts}`);
      } else {
        assert(audioChips >= 1, `no audio chip: ${texts}`);
      }
      const dest = path.join(WORK, `t5-${testCase.name}.mp4`);
      await downloadFrom(page, pick, dest);
      const { problems, got } = await verifyOutput(fixture(testCase.name), dest, null);
      assert(problems.length === 0, problems.join("; "));
      summary.push(`${testCase.name}=${got.join(",") || "none"}`);
    } catch (err) {
      failures.push(`${testCase.name}: ${firstLine(err.message)}`);
    }
  }
  assert(failures.length === 0, failures.join(" ;; "));
  return summary.join("; ");
}

// True when the blob URL loads metadata in a detached <video> (5 s cap).
async function blobLoads(page, url) {
  return page.evaluate(
    (u) =>
      new Promise((resolve) => {
        const video = document.createElement("video");
        const finish = (ok) => {
          video.removeAttribute("src");
          video.load();
          resolve(ok);
        };
        video.preload = "metadata";
        video.onloadedmetadata = () => finish(true);
        video.onerror = () => finish(false);
        setTimeout(() => finish(false), 5000);
        video.src = u;
      }),
    url,
  );
}

async function testT6(env) {
  const page = await openApp(env, { url: shared.root });
  const { pick, state } = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, pick, state);
  const card = cardOf(page, pick);
  const href = await card.locator(testid("job-download")).getAttribute("href");
  assert(href && href.startsWith("blob:"), `download href is not blob: (${href})`);
  // The app CSP has connect-src 'self' (no blob:), so fetch() of a blob URL is
  // always blocked and cannot prove liveness. media-src allows blob:, so a
  // detached <video> is the probe: it loads metadata only while the URL is live.
  const control = await blobLoads(page, href);
  assert(control, "control: live blob URL did not load in a <video> element; revocation cannot be proven");
  assert((await opfsOutNames(page)).length === 1, "expected one OPFS output before remove");

  await card.locator(testid("job-remove")).click();
  await waitUntil(
    async () => (await page.locator(jobSelByName("h264_aac.mkv")).count()) === 0,
    5000,
    "card still present 5 s after remove",
  );
  await waitUntil(
    async () => (await opfsOutNames(page)).length === 0,
    5000,
    "OPFS output of the removed card still present after 5 s",
  );
  const revoked = !(await blobLoads(page, href));
  assert(revoked, "old blob URL still loads in a <video> element after remove");

  await addFiles(page, [fixture("h264_opus"), fixture("h264_mp3")]);
  await waitCard(page, { name: "h264_opus.mkv" }, ["done"]);
  await waitCard(page, { name: "h264_mp3.mkv" }, ["done"]);
  await page.locator(testid("clear-finished")).click();
  await waitUntil(async () => (await cardCount(page)) === 0, 5000, "clear-finished left cards behind");
  return "remove: card gone, OPFS file gone <5 s, blob URL revoked; clear-finished removed all";
}

async function testT7(env) {
  const context = await newContext(env);
  const pageA = await openPageIn(env, context, shared.root);
  const pageB = await openPageIn(env, context, shared.root);
  await addFiles(pageA, [fixture("h264_aac")]);
  await addFiles(pageB, [fixture("hevc_aac")]);
  await waitCard(pageA, { index: 0 }, ["done"]);
  await waitCard(pageB, { index: 0 }, ["done"]);
  const shaA1 = await downloadSha(pageA, { index: 0 }, path.join(WORK, "t7-a1.mp4"));
  const shaB1 = await downloadSha(pageB, { index: 0 }, path.join(WORK, "t7-b1.mp4"));

  const pageC = await openPageIn(env, context, shared.root);
  const cResult = await convertOne(pageC, fixture("h264_opus"));
  await expectDone(pageC, cResult.pick, cResult.state);
  const shaC = await downloadSha(pageC, cResult.pick, path.join(WORK, "t7-c.mp4"));

  const shaA2 = await downloadSha(pageA, { index: 0 }, path.join(WORK, "t7-a2.mp4"));
  const shaB2 = await downloadSha(pageB, { index: 0 }, path.join(WORK, "t7-b2.mp4"));
  assert(shaA2 === shaA1, "A re-download differs from its first download");
  assert(shaB2 === shaB1, "B re-download differs from its first download");

  const before = await opfsOutFiles(pageC);
  assert(before.length >= 3, `expected >=3 out-*.mp4 in OPFS, found ${before.length}`);
  assert(before.some((f) => f.sha === shaA1), "A's output not found in OPFS");
  assert(before.some((f) => f.sha === shaB1), "B's output not found in OPFS");

  await pageA.close();
  const pageD = await openPageIn(env, context, shared.root);
  const dResult = await convertOne(pageD, fixture("h264_only"));
  await expectDone(pageD, dResult.pick, dResult.state);
  const shaD = await downloadSha(pageD, dResult.pick, path.join(WORK, "t7-d.mp4"));

  await waitUntil(
    async () => !(await opfsOutFiles(pageD)).some((f) => f.sha === shaA1),
    8000,
    "A's OPFS output still present 8 s after D converted (orphan sweep)",
  );
  const after = await opfsOutFiles(pageD);
  for (const [label, sha] of [
    ["B", shaB1],
    ["C", shaC],
    ["D", shaD],
  ]) {
    assert(after.some((f) => f.sha === sha), `${label}'s output was swept`);
  }
  return "3 tabs converted; re-downloads identical; A's orphan swept <8 s; B, C, D kept";
}

async function testT8(env) {
  const context = await newContext(env, [{ fn: lockDelay, arg: { ms: 1500 } }]);
  const page = await context.newPage();
  watchPage(page, env);
  await page.goto(shared.root, { waitUntil: "load" });
  const first = await page.evaluate(() => document.documentElement.dataset.state);
  assert(first === "init", `state right after load is ${first}, expected init`);

  const enabled = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="file-input"]');
    return Boolean(input) && !input.disabled;
  });
  let preAdded = false;
  if (enabled) {
    await page.locator(testid("file-input")).setInputFiles([fixture("h264_aac")]);
    preAdded = true;
  }

  const started = Date.now();
  while (Date.now() - started < 1000) {
    const state = await page.evaluate(() => document.documentElement.dataset.state);
    assert(state === "init", `state became ${state} after ${Date.now() - started} ms (expected init)`);
    await sleep(50);
  }
  const outsDuring = await opfsOutNames(page);
  assert(outsDuring.length === 0, `out-*.mp4 appeared during the lock delay: ${JSON.stringify(outsDuring)}`);

  await waitForState(page, ["ready"], 10000);
  if (preAdded && (await page.locator(jobSelByName("h264_aac.mkv")).count()) > 0) {
    const state = await waitCard(page, { name: "h264_aac.mkv" }, ["done", "error"]);
    await expectDone(page, { name: "h264_aac.mkv" }, state);
  } else {
    const { pick, state } = await convertOne(page, fixture("h264_aac"));
    await expectDone(page, pick, state);
  }
  return `init held >=1000 ms (${preAdded ? "file added during init" : "input unavailable during init"}); no output during delay; then ready and converted`;
}

async function testT9(env) {
  const page = await openApp(env, { url: shared.root });
  const small = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, small.pick, small.state);
  const smallSha = await downloadSha(page, small.pick, path.join(WORK, "t9-small-before.mp4"));

  await addFiles(page, [BIG_IN]);
  const big = { index: 1 };
  await waitCard(page, big, ["converting"], 900000, 25);
  const beforeCancel = await opfsOutNames(page);
  assert(
    beforeCancel.length >= 2,
    `expected the small output plus a partial output before cancel, found ${JSON.stringify(beforeCancel)}`,
  );
  await cardOf(page, big).locator(testid("job-cancel")).click();
  await waitCard(page, big, ["cancelled"], 5000, 50);
  await sleep(1000);
  assert((await page.locator(jobSelByName(BIG_NAME)).count()) === 1, "cancelled card disappeared");

  await waitUntil(
    async () => (await opfsOutNames(page)).length === 1,
    15000,
    "cancelled run's OPFS file still present 15 s after cancel",
  );
  const remaining = await opfsOutFiles(page);
  assert(
    remaining.length === 1 && remaining[0].sha === smallSha,
    "the remaining OPFS file is not the earlier completed job's output",
  );

  const again = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, again.pick, again.state);
  const againSha = await downloadSha(page, again.pick, path.join(WORK, "t9-again.mp4"));
  assert(againSha === smallSha, "new conversion output differs from the earlier one");
  const earlierSha = await downloadSha(page, small.pick, path.join(WORK, "t9-small-after.mp4"));
  assert(earlierSha === smallSha, "earlier completed job's download changed after the cancel");
  return "cancel kept the card; cancelled OPFS file gone <15 s; earlier download and new output intact";
}

async function testT10(env) {
  const page = await openApp(env, { url: shared.root });
  const { pick, state } = await convertOne(page, BIG_IN, 1200000);
  await expectDone(page, pick, state);
  const dest = path.join(WORK, "t10-big.mp4");
  await downloadFrom(page, pick, dest, 900000);
  const inSize = fs.statSync(BIG_IN).size;
  const outSize = fs.statSync(dest).size;
  const ratio = outSize / inSize;
  assert(Math.abs(ratio - 1) <= 0.05, `output ${outSize} B vs input ${inSize} B (ratio ${ratio.toFixed(3)})`);
  const { problems, out, src } = await verifyOutput(BIG_IN, dest, 20);
  assert(
    Math.abs(out.duration - src.duration) <= 0.1,
    `duration ${out.duration} vs source ${src.duration}`,
  );
  assert(problems.length === 0, problems.join("; "));
  return `output ${(outSize / 2 ** 20).toFixed(0)} MiB vs input ${(inSize / 2 ** 20).toFixed(0)} MiB; decode of first 20 s clean`;
}

async function testT11(env) {
  const log = newIsolationLog();
  const context = await newContext(env);
  await installIsolation(context, shared.origin, log);
  const page = await openPageIn(env, context, shared.root);
  const { pick, state } = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, pick, state);
  await downloadFrom(page, pick, path.join(WORK, "t11.mp4"));

  assert(log.nonLocal.length === 0, `non-local request attempts: ${log.nonLocal.slice(0, 3).join(", ")}`);
  assert(log.local.length > 0, "no local requests recorded");
  const badMethod = log.local.filter((r) => r.method !== "GET" || r.body);
  assert(badMethod.length === 0, `local non-GET or body requests: ${JSON.stringify(badMethod.slice(0, 2))}`);
  const fileNamed = /\.(mkv|mp4|webm)|h264|aac|opus|hevc|vp9|av1/i;
  const nonStatic = [];
  for (const entry of log.local) {
    const u = new URL(entry.url);
    const staticPath = u.pathname === "/" || u.pathname.endsWith("/") || /\.(html|js|css|svg|wasm|ico|png)$/.test(u.pathname);
    if (!staticPath || fileNamed.test(u.search)) {
      nonStatic.push(entry.url);
    }
  }
  assert(nonStatic.length === 0, `local requests that are not static assets: ${nonStatic.slice(0, 3).join(", ")}`);

  const probes = await page.evaluate(async () => {
    const out = {};
    const count = () => window.__cspViolations.length;
    const exampleSince = (mark) =>
      window.__cspViolations.slice(mark).some((u) => u.includes("example.com"));
    let mark = count();
    try {
      await fetch("https://example.com/");
      out.fetchRejected = false;
    } catch {
      out.fetchRejected = true;
    }
    await new Promise((r) => setTimeout(r, 300));
    out.fetchViolation = exampleSince(mark);

    mark = count();
    let socket = null;
    try {
      socket = new WebSocket("wss://example.com/");
      socket.addEventListener("error", () => {});
    } catch {
      out.wsThrew = true;
    }
    await new Promise((r) => setTimeout(r, 500));
    out.wsViolation = exampleSince(mark);
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }

    mark = count();
    out.beacon = navigator.sendBeacon("https://example.com/", "x");
    await new Promise((r) => setTimeout(r, 300));
    out.beaconViolation = exampleSince(mark);
    return out;
  });
  assert(probes.fetchRejected, "fetch('https://example.com/') did not reject");
  assert(probes.fetchViolation, "no securitypolicyviolation with example.com for fetch");
  assert(probes.wsViolation || probes.wsThrew, "no securitypolicyviolation with example.com for WebSocket");
  assert(
    probes.beacon === false || probes.beaconViolation,
    "sendBeacon to example.com returned true with no violation",
  );
  return "only the local origin reached; fetch, WebSocket and sendBeacon to example.com blocked by CSP";
}

async function testT12(env) {
  const page = await openApp(env, { url: shared.root, extraInit: [{ fn: framePerf }] });
  await addFiles(page, [BIG_IN]);
  const pick = { index: 0 };
  await waitCard(page, pick, ["converting"], 900000, 25);
  await page.evaluate(() => {
    window.__frames.maxGap = 0;
    if (window.__longtasks) {
      window.__longtasks.length = 0;
    }
  });

  const distinctNow = new Set();
  let lastPct = null;
  let pctChanges = 0;
  const deadline = Date.now() + 900000;
  for (;;) {
    const sample = await page.evaluate(sampleCard, pick);
    if (sample) {
      if (sample.now !== null) {
        distinctNow.add(sample.now);
      }
      if (sample.pct && sample.pct !== lastPct) {
        if (lastPct !== null) {
          pctChanges += 1;
        }
        lastPct = sample.pct;
      }
      if (["done", "error", "cancelled"].includes(sample.state)) {
        assert(sample.state === "done", `conversion ended as ${sample.state}`);
        break;
      }
    }
    assert(Date.now() < deadline, "conversion did not finish within 15 min");
    await sleep(25);
  }
  const metrics = await page.evaluate(() => ({
    maxGap: window.__frames.maxGap,
    longtasks: window.__longtasks ? window.__longtasks.slice() : null,
  }));
  assert(metrics.longtasks !== null, "PerformanceObserver longtask is not supported");
  assert(metrics.maxGap <= 250, `max rAF gap ${metrics.maxGap.toFixed(0)} ms (limit 250)`);
  const worstTask = metrics.longtasks.length ? Math.max(...metrics.longtasks) : 0;
  assert(worstTask <= 200, `long task of ${worstTask.toFixed(0)} ms (limit 200)`);
  assert(distinctNow.size >= 8, `only ${distinctNow.size} distinct aria-valuenow values (need 8)`);
  assert(pctChanges >= 8, `job-percent changed ${pctChanges} times (need 8)`);
  return `max rAF gap ${metrics.maxGap.toFixed(0)} ms; worst long task ${worstTask.toFixed(0)} ms; ${distinctNow.size} distinct progress values; ${pctChanges} percent changes`;
}

async function testT13(env) {
  const page = await openApp(env, { url: shared.root });
  const names = ["h264_aac.mkv", "h264_opus.mkv", "hevc_aac.mkv"];
  const files = ["h264_aac", "h264_opus", "hevc_aac"].map((n) => fixture(n));
  await page.waitForFunction(
    () => {
      const input = document.querySelector('[data-testid="file-input"]');
      return Boolean(input) && !input.disabled;
    },
    null,
    { timeout: 30000, ...POLL },
  );
  await page.locator(testid("file-input")).setInputFiles(files);

  let maxActive = 0;
  let sawQueued = false;
  let sawAnalyzing = false;
  const orderProblems = [];
  const indeterminateProblems = [];
  const started = Date.now();
  for (;;) {
    const snap = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="job"]')).map((card) => {
        const bar = card.querySelector('[data-testid="job-progress"]');
        const cancel = card.querySelector('[data-testid="job-cancel"]');
        return {
          name: card.dataset.name,
          state: card.dataset.state,
          now: bar ? bar.getAttribute("aria-valuenow") : undefined,
          role: bar ? bar.getAttribute("role") : null,
          cancelLabel: cancel ? cancel.getAttribute("aria-label") : null,
        };
      }),
    );
    const active = snap.filter((s) => s.state === "analyzing" || s.state === "converting").length;
    maxActive = Math.max(maxActive, active);
    const seen = snap.map((s) => s.name);
    if (JSON.stringify(seen) !== JSON.stringify(names.slice(0, seen.length))) {
      orderProblems.push(seen.join(","));
    }
    for (const s of snap) {
      if (s.state === "queued" || s.state === "analyzing") {
        if (s.state === "queued") {
          sawQueued = true;
          if (!s.cancelLabel || !s.cancelLabel.includes(s.name.replace(/\.mkv$/, ""))) {
            indeterminateProblems.push(`cancel label of queued ${s.name}: ${s.cancelLabel}`);
          }
        } else {
          sawAnalyzing = true;
        }
        if (s.role !== "progressbar" || s.now !== null) {
          indeterminateProblems.push(`${s.state} ${s.name}: role=${s.role} aria-valuenow=${s.now}`);
        }
      }
    }
    if (snap.length === 3 && snap.every((s) => s.state === "done" || s.state === "error")) {
      break;
    }
    assert(Date.now() - started < 300000, "queue did not finish within 5 min");
    await sleep(25);
  }
  assert(maxActive <= 1, `${maxActive} jobs analyzing/converting at once`);
  assert(orderProblems.length === 0, `card order changed: ${orderProblems[0]}`);
  assert(sawQueued, "no queued state was observed (conversion finished before the first sample)");
  assert(indeterminateProblems.length === 0, indeterminateProblems.slice(0, 2).join("; "));
  for (let i = 0; i < 3; i += 1) {
    const state = await stateOfPick(page, { index: i });
    assert(state === "done", `card ${i} ended as ${state}`);
  }
  return `max ${maxActive} active; order kept; queued/analyzing indeterminate with no aria-valuenow (analyzing seen: ${sawAnalyzing})`;
}

async function testT14(env) {
  const page = await openApp(env, { url: shared.root });
  const toggle = page.locator(testid("theme-toggle"));
  const read = async () => ({
    pref: await page.evaluate(() => document.documentElement.dataset.themePref ?? null),
    theme: await page.evaluate(() => document.documentElement.dataset.theme ?? null),
    label: await toggle.getAttribute("aria-label"),
    stored: await page.evaluate(() => window.localStorage.getItem("convertor.theme")),
  });

  let s = await read();
  assert(s.pref === "auto" && /Theme: auto/.test(s.label), `initial ${JSON.stringify(s)}`);
  await toggle.click();
  s = await read();
  assert(s.pref === "light" && s.theme === "light" && /Theme: light/.test(s.label), `after 1 click ${JSON.stringify(s)}`);
  await toggle.click();
  s = await read();
  assert(s.pref === "dark" && s.theme === "dark" && /Theme: dark/.test(s.label), `after 2 clicks ${JSON.stringify(s)}`);
  await toggle.click();
  s = await read();
  assert(s.pref === "auto" && /Theme: auto/.test(s.label), `after 3 clicks ${JSON.stringify(s)}`);

  await page.emulateMedia({ colorScheme: "dark" });
  await waitUntil(async () => (await read()).theme === "dark", 5000, "auto did not resolve to dark");
  await page.emulateMedia({ colorScheme: "light" });
  await waitUntil(async () => (await read()).theme === "light", 5000, "auto did not follow light OS scheme");
  await page.emulateMedia({ colorScheme: "dark" });
  await waitUntil(async () => (await read()).theme === "dark", 5000, "auto did not return to dark");

  await toggle.click();
  await toggle.click();
  s = await read();
  assert(s.pref === "dark" && s.stored === "dark", `before reload ${JSON.stringify(s)}`);
  await page.reload({ waitUntil: "load" });
  await waitForState(page, ["ready"], 30000);
  s = await read();
  assert(s.pref === "dark" && s.theme === "dark" && s.stored === "dark", `after reload ${JSON.stringify(s)}`);

  await toggle.focus();
  await page.keyboard.press("Enter");
  s = await read();
  assert(s.pref === "auto" && /Theme: auto/.test(s.label), `after keyboard Enter ${JSON.stringify(s)}`);
  return "auto->light->dark->auto with labels; OS dark resolves auto; persisted across reload; Enter works";
}

async function testT15(env) {
  const page = await openApp(env, { url: shared.root });
  const badge = page.locator(testid("privacy-badge"));
  const privacy = page.locator(testid("privacy-dialog"));
  const isOpen = (locator) => locator.evaluate((d) => d.open);

  await badge.focus();
  await badge.click();
  await waitUntil(() => isOpen(privacy), 5000, "privacy dialog did not open");
  assert(await privacy.evaluate((d) => d.contains(document.activeElement)), "focus not inside privacy dialog");
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await privacy.evaluate((d) => d.contains(document.activeElement));
    assert(inside, `Tab #${i + 1} left the privacy dialog`);
  }
  await page.keyboard.press("Escape");
  await waitUntil(async () => !(await isOpen(privacy)), 5000, "privacy dialog did not close on Esc");
  const focusedAfterPrivacy = await page.evaluate(() => document.activeElement && document.activeElement.dataset.testid);
  assert(focusedAfterPrivacy === "privacy-badge", `focus after Esc is ${focusedAfterPrivacy}, expected privacy-badge`);

  const { pick, state } = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, pick, state);

  const aboutButton = page.locator(testid("about-open"));
  const about = page.locator(testid("about-dialog"));
  await aboutButton.focus();
  await aboutButton.click();
  await waitUntil(() => isOpen(about), 5000, "about dialog did not open");
  const memory = ((await page.locator(testid("memory-budget")).textContent()) || "").trim();
  assert(memory.length > 0, "memory-budget readout is empty");
  const confinement = await about.evaluate((d) => {
    const dt = Array.from(d.querySelectorAll("dt")).find((x) => x.textContent.trim() === "Worker confinement");
    return dt && dt.nextElementSibling ? dt.nextElementSibling.textContent.trim() : null;
  });
  assert(confinement !== null && /active/i.test(confinement), `worker confinement readout: "${confinement}"`);
  await page.keyboard.press("Escape");
  await waitUntil(async () => !(await isOpen(about)), 5000, "about dialog did not close on Esc");
  const focusedAfterAbout = await page.evaluate(() => document.activeElement && document.activeElement.dataset.testid);
  assert(focusedAfterAbout === "about-open", `focus after about Esc is ${focusedAfterAbout}, expected about-open`);

  const soon = page.locator('[data-testid="nav-item"][aria-disabled="true"]');
  const soonCount = await soon.count();
  assert(soonCount >= 1, "no nav item with aria-disabled=true");
  for (let i = 0; i < soonCount; i += 1) {
    // Soon items are aria-disabled on purpose but stay focusable, so Playwright's
    // actionability check (which waits for "enabled") must be bypassed with force.
    const beforeHash = await page.evaluate(() => location.hash);
    const beforeUrl = page.url();
    await soon.nth(i).click({ force: true });
    await page.waitForTimeout(150);
    const afterHash = await page.evaluate(() => location.hash);
    assert(beforeHash === afterHash, `clicking a soon item changed location.hash ${beforeHash} -> ${afterHash}`);
    assert(page.url() === beforeUrl, `clicking a soon item navigated ${beforeUrl} -> ${page.url()}`);
  }
  const active = page.locator('[data-testid="nav-item"][aria-current="page"]');
  assert((await active.count()) === 1, "expected exactly one nav item with aria-current=page");
  assert((await active.getAttribute("aria-disabled")) !== "true", "active nav item is disabled");
  return `privacy and about open/close with focus return; Tab trapped; ${soonCount} soon items inert; active nav marked`;
}

async function testT16(env) {
  for (const name of ["h264_aac", "hevc_aac"]) {
    const page = await openApp(env, { url: shared.root });
    const { pick, state } = await convertOne(page, fixture(name));
    await expectDone(page, pick, state);
    const card = cardOf(page, pick);
    const tracks = await card.locator(testid("job-track")).evaluateAll((els) =>
      els.map((el) => ({ kind: el.dataset.kind, text: el.textContent.trim() })),
    );
    const info = await probeFull(fixture(name));
    const video = info.streams.find((s) => s.type === "video");
    const audio = info.streams.find((s) => s.type === "audio");
    const videoChip = tracks.find((t) => t.kind === "video");
    const audioChip = tracks.find((t) => t.kind === "audio");
    assert(videoChip, `${name}: no video chip`);
    assert(audioChip, `${name}: no audio chip`);
    const codecWord = name.startsWith("hevc") ? "H.265" : "H.264";
    assert(videoChip.text.includes(codecWord), `${name}: video chip "${videoChip.text}" lacks ${codecWord}`);
    assert(
      videoChip.text.includes(`${video.width}\u00d7${video.height}`),
      `${name}: video chip "${videoChip.text}" vs ffprobe ${video.width}x${video.height}`,
    );
    const channelWord = audio.channels === 1 ? "Mono" : audio.channels === 2 ? "Stereo" : `${audio.channels} ch`;
    assert(audioChip.text.includes(channelWord), `${name}: audio chip "${audioChip.text}" vs ffprobe ${audio.channels} ch`);
    const khz = /([\d.]+) kHz/.exec(audioChip.text);
    assert(
      khz && Math.abs(Number(khz[1]) * 1000 - audio.sampleRate) <= 50,
      `${name}: audio chip "${audioChip.text}" vs ffprobe ${audio.sampleRate} Hz`,
    );
    const durationText = (await card.locator(testid("job-duration")).textContent()) || "";
    const match = /(\d+):(\d{2})/.exec(durationText);
    assert(match, `${name}: job-duration "${durationText}" unparsable`);
    const shown = Number(match[1]) * 60 + Number(match[2]);
    // The UI shows whole seconds (m:ss), so 0.1 s cannot be checked from the display.
    assert(
      Math.abs(shown - info.duration) < 1,
      `${name}: duration shown ${durationText} vs ffprobe ${info.duration.toFixed(3)} s`,
    );
  }
  return "h264_aac and hevc_aac: resolution, channels, sample rate and duration match ffprobe";
}

async function testT17(env) {
  const log = newIsolationLog();
  const context = await newContext(env);
  await installIsolation(context, shared.origin, log);
  const page = await openPageIn(env, context, shared.root);
  const result = await page.evaluate(async () => {
    const factory = await import("./js/core/worker-factory.js");
    const scriptUrl = new URL("/__test__/probe-worker.js", location.href).href;
    const worker = await factory.createConvertWorker({ scriptUrl, readyTimeoutMs: 10000 });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no probe-result within 20 s")), 20000);
        worker.addEventListener("message", (event) => {
          if (event.data && event.data.type === "probe-result") {
            clearTimeout(timer);
            resolve(event.data);
          } else if (event.data && event.data.type === "probe-error") {
            clearTimeout(timer);
            reject(new Error(`probe worker failed: ${event.data.message}`));
          }
        });
      });
    } finally {
      worker.terminate();
    }
  });
  assert(result.fetchRejected === true, "fetch to example.com was not rejected inside the worker");
  assert(
    result.fetchViolations.some((u) => u.includes("example.com")),
    `no fetch violation for example.com (violations: ${JSON.stringify(result.fetchViolations)})`,
  );
  assert(result.wsOpened === false, "WebSocket to example.com opened inside the worker");
  let wsNote;
  if (result.wsViolations.some((u) => u.includes("example.com"))) {
    wsNote = "WebSocket violation reported";
  } else {
    assert(result.wsErrored === true, "WebSocket to example.com neither reported nor errored");
    wsNote = "WebSocket errored (no violation event reported inside the worker)";
  }
  assert(log.nonLocal.length === 0, `non-local requests allowed: ${log.nonLocal.slice(0, 3).join(", ")}`);
  const page2Result = await addFiles(page, [fixture("h264_aac")]);
  const state = await waitCard(page, { name: page2Result[0] }, ["done", "error"]);
  assert(state === "done", `normal conversion failed after the probe: ${state}`);
  return `fetch rejected + violation; ${wsNote}; no external request allowed`;
}

async function testT18(env) {
  const mark = shared.hits.length;
  const page = await openApp(env, { url: shared.sub });
  const { pick, state } = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, pick, state);
  const hits = shared.hits.slice(mark);
  const bad = hits.filter((h) => h.status >= 400);
  assert(bad.length === 0, `responses >= 400: ${bad.slice(0, 5).map((h) => `${h.status} ${h.raw}`).join(", ")}`);
  const outside = hits.filter(
    (h) => h.raw !== "/favicon.ico" && h.raw !== PREFIX && !h.raw.startsWith(`${PREFIX}/`),
  );
  assert(outside.length === 0, `requests outside ${PREFIX}/: ${outside.slice(0, 3).map((h) => h.raw).join(", ")}`);
  for (const suffix of ["/assets/favicon.svg", ".css", ".wasm", "convert.worker.js"]) {
    assert(
      hits.some((h) => h.status === 200 && h.raw.endsWith(suffix)),
      `no 200 response for *${suffix} under ${PREFIX}/`,
    );
  }
  const workers = await page.evaluate(() => window.__workerUrls || []);
  assert(
    workers.length >= 1 && workers.every((u) => u.startsWith("blob:")),
    `Worker URLs not all blob: ${JSON.stringify(workers)}`,
  );
  return `${hits.length} requests under ${PREFIX}/, none >= 400; ${workers.length} worker(s), all blob:`;
}

async function testT19a(env) {
  const page = await openApp(env, { url: shared.root });
  const first = BIG ? BIG_IN : fixture("h264_aac");
  const running = BIG ? ["converting"] : ["queued", "analyzing", "converting"];
  await addFiles(page, [first, fixture("h264_opus"), fixture("h264_mp3")]);
  const firstName = path.basename(first);
  const state = await waitCard(
    page,
    { index: 0 },
    [...running, "done", "error"],
    BIG ? 900000 : 2000,
    10,
  );
  if (!running.includes(state)) {
    skip("first conversion finished before the cancel could land (run with --big)");
  }
  // Without --big the small first file may finish before Cancel is clickable
  // (the button then disappears). Only that case may skip, and only without --big.
  const cancelBtn = cardOf(page, { index: 0 }).locator(testid("job-cancel"));
  const clicked = await cancelBtn.click({ timeout: 2000 }).then(
    () => true,
    () => false,
  );
  const landed = clicked
    ? await waitCard(page, { index: 0 }, ["cancelled", "done", "error"], 5000, 50)
    : await stateOfPick(page, { index: 0 });
  if (landed !== "cancelled") {
    if (!BIG && (landed === "done" || landed === "error")) {
      skip("first conversion finished before the cancel could land (run with --big)");
    }
    throw new Error(`cancel did not land on ${firstName} (card is ${landed})`);
  }
  await waitCard(page, { name: "h264_opus.mkv" }, ["done"]);
  await waitCard(page, { name: "h264_mp3.mkv" }, ["done"]);
  assert(await cardCount(page) === 3, "the cancelled card vanished before it was removed");
  await cardOf(page, { index: 0 }).locator(testid("job-remove")).click();
  await waitUntil(async () => (await cardCount(page)) === 2, 5000, "removed card still present");
  await sleep(3000);
  assert((await cardCount(page)) === 2, "a removed card reappeared");
  assert((await page.locator(jobSelByName(firstName)).count()) === 0, `${firstName} card reappeared`);
  await waitUntil(
    async () => (await opfsOutNames(page)).length === 2,
    15000,
    "cancelled run's OPFS output not gone (expected 2 finished outputs)",
  );
  return `cancelled ${firstName} during ${state}; next two completed; removed card never reappeared`;
}

async function testT19b(env) {
  const results = [];
  for (const query of ["testfail=bootstrap", "testfail=timeout&readyms=300"]) {
    const log = newIsolationLog();
    const context = await newContext(env);
    await installIsolation(context, shared.origin, log);
    const page = await openPageIn(env, context, `${shared.root}?${query}`, {
      waitStates: ["ready", "error", "unsupported"],
    });
    const { pick, state } = await convertOne(page, fixture("h264_aac"), 60000);
    assert(state === "error", `${query}: expected error, got ${state}`);
    const details = await cardText(page, pick, `${testid("job-error-details")} code`);
    assert(/secure worker/i.test(details), `${query}: details "${firstLine(details)}" lack "secure worker"`);
    const urls = await page.evaluate(() => window.__workerUrls || []);
    assert(urls.every((u) => u.startsWith("blob:")), `${query}: non-blob Worker constructed: ${JSON.stringify(urls)}`);
    assert(log.nonLocal.length === 0, `${query}: non-local request: ${log.nonLocal[0]}`);
    assert(log.local.every((r) => !r.body), `${query}: a request carried a body`);
    results.push(query.split("&")[0].replace("testfail=", ""));
  }
  return `${results.join(" and ")}: job fails with 'secure worker'; only blob: workers; file not sent`;
}

async function testT20(env) {
  const context = await newContext(env);
  const page = await openPageIn(env, context, `${shared.root}?nofs=1&membudget=250000`);
  const first = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, first.pick, first.state);
  const second = await convertOne(page, fixture("h264_ac3"));
  assert(second.state === "error", `second file: expected error, got ${second.state}`);
  const title = await cardText(page, second.pick, testid("job-error"));
  assert(
    title.includes("Not enough memory to hold this file"),
    `second file title: "${firstLine(title)}"`,
  );
  assert(
    (await cardOf(page, second.pick).locator(testid("job-download")).count()) === 0,
    "second file produced a download",
  );

  const heldReadout = await readMemoryBudget(page);
  await cardOf(page, first.pick).locator(testid("job-remove")).click();
  await waitUntil(async () => (await cardCount(page)) === 1, 5000, "first card not removed");
  const freedReadout = await readMemoryBudget(page);
  assert(
    heldReadout !== freedReadout,
    `About memory-budget readout did not change after freeing the file ("${heldReadout}")`,
  );

  const third = await convertOne(page, fixture("h264_ac3"));
  await expectDone(page, third.pick, third.state);
  return `second rejected before download; readout "${heldReadout}" -> "${freedReadout}"; re-add done`;
}

const T21_ORDER = ["skip-link", "privacy-badge", "theme-toggle", "about-open", "nav-item", "browse", "job-download", "job-remove"];

async function testT21(env) {
  const page = await openApp(env, { url: shared.root });
  await addFiles(page, [fixture("h264_aac"), fixture("h264_opus")]);
  await waitCard(page, { index: 0 }, ["done"]);
  await waitCard(page, { index: 1 }, ["done"]);

  // Tab order from the top of the page.
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
  const sequence = [];
  for (let i = 0; i < 90; i += 1) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      if (el.classList.contains("skip-link")) return "skip-link";
      return el.dataset.testid || el.tagName.toLowerCase();
    });
    sequence.push(label);
  }
  const positions = T21_ORDER.map((id) => sequence.indexOf(id));
  const missing = T21_ORDER.filter((_, i) => positions[i] < 0);
  assert(missing.length === 0, `not reached by Tab: ${missing.join(", ")}`);
  for (let i = 1; i < positions.length; i += 1) {
    assert(positions[i] > positions[i - 1], `Tab order: ${T21_ORDER[i]} comes before ${T21_ORDER[i - 1]}`);
  }

  // Accessible names and progress semantics on the done cards.
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="job"]')).map((card) => {
      const name = card.dataset.name;
      const download = card.querySelector('[data-testid="job-download"]');
      const remove = card.querySelector('[data-testid="job-remove"]');
      const preview = card.querySelector('[data-testid="job-preview-toggle"]');
      const bar = card.querySelector('[data-testid="job-progress"]');
      return {
        name,
        download: download ? download.getAttribute("aria-label") || "" : null,
        remove: remove ? remove.getAttribute("aria-label") || "" : null,
        preview: preview ? preview.getAttribute("aria-label") || preview.textContent.trim() : null,
        now: bar ? bar.getAttribute("aria-valuenow") : null,
        barLabel: bar ? bar.getAttribute("aria-label") || "" : null,
      };
    }),
  );
  const nameProblems = [];
  for (const card of names) {
    const stem = card.name.replace(/\.mkv$/, "");
    if (!card.download || !card.download.includes(stem)) nameProblems.push(`download of ${card.name}: "${card.download}"`);
    if (!card.remove || !card.remove.includes(card.name)) nameProblems.push(`remove of ${card.name}: "${card.remove}"`);
    if (!card.preview || !card.preview.includes(stem)) nameProblems.push(`preview toggle of ${card.name}: "${card.preview}"`);
    if (card.now !== "100") nameProblems.push(`determinate progress of ${card.name} has aria-valuenow=${card.now}`);
    if (!card.barLabel || !card.barLabel.includes(card.name)) nameProblems.push(`progress label of ${card.name}: "${card.barLabel}"`);
  }
  assert(nameProblems.length === 0, nameProblems.slice(0, 3).join(" ; "));

  // Keyboard removal of a focused done card: focus goes to the next card's first action.
  await cardOf(page, { index: 0 }).locator(testid("job-remove")).focus();
  await page.keyboard.press("Enter");
  await waitUntil(async () => (await cardCount(page)) === 1, 5000, "card not removed with Enter");
  const focusAfterFirst = await page.evaluate(() => {
    const el = document.activeElement;
    const card = el && el.closest('[data-testid="job"]');
    return { testid: el && el.dataset.testid, name: card ? card.dataset.name : null };
  });
  assert(
    focusAfterFirst.testid === "job-download" && focusAfterFirst.name === "h264_opus.mkv",
    `focus after removal: ${JSON.stringify(focusAfterFirst)}, expected h264_opus.mkv job-download`,
  );

  // Removing the last card moves focus to the dropzone's Browse button.
  await cardOf(page, { index: 0 }).locator(testid("job-remove")).focus();
  await page.keyboard.press("Enter");
  await waitUntil(async () => (await cardCount(page)) === 0, 5000, "last card not removed with Enter");
  const focusAfterLast = await page.evaluate(() => document.activeElement && document.activeElement.dataset.testid);
  assert(focusAfterLast === "browse", `focus after last removal: ${focusAfterLast}, expected browse`);

  // Icon-only shell buttons carry an accessible name.
  for (const id of ["theme-toggle", "about-open"]) {
    const label = (await page.locator(testid(id)).getAttribute("aria-label")) || "";
    assert(label.trim() !== "", `${id} has no accessible name`);
  }
  return `Tab reached ${T21_ORDER.length} stops in order; Enter-removal focus moves correctly; job actions named`;
}

// ---------- test table ----------

// ---------- T22/T23: Vorbis re-encode and damaged/padded files ----------

async function meanVolumeDb(file) {
  let stderr = "";
  try {
    ({ stderr } = await execFileAsync(
      FFMPEG,
      ["-hide_banner", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"],
      { maxBuffer: 64 << 20 },
    ));
  } catch (err) {
    stderr = err.stderr || "";
  }
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  return m ? Number(m[1]) : null;
}

async function testT22(env) {
  const src = fixture("h264_vorbis");
  if (!fs.existsSync(src)) {
    skip("no h264_vorbis.mkv fixture (needs ffmpeg with libvorbis)");
  }
  const page = await openApp(env, { url: shared.root });
  const { pick, state } = await convertOne(page, src);
  await expectDone(page, pick, state);
  const warnings = await cardText(page, pick, testid("job-warnings"));
  assert(/re-encoded to (AAC|Opus)/.test(warnings), `no re-encode notice in warnings: "${warnings}"`);
  assert(!/Skipped track/.test(warnings), `the Vorbis track must not be reported as skipped: "${warnings}"`);
  const chips = (await cardOf(page, pick).locator(testid("job-track")).allTextContents()).map((t) => t.trim());
  assert(chips.some((t) => /AAC|Opus/.test(t)), `no re-encoded audio chip: ${JSON.stringify(chips)}`);

  const dest = path.join(WORK, "t22-h264_vorbis.mp4");
  await downloadFrom(page, pick, dest);
  const out = await probeFull(dest);
  const video = out.streams.find((x) => x.type === "video");
  const audio = out.streams.find((x) => x.type === "audio");
  assert(video && video.codec === "h264", `video stream: ${JSON.stringify(out.streams)}`);
  assert(audio && ["aac", "opus"].includes(audio.codec), `audio stream: ${JSON.stringify(out.streams)}`);
  assert(audio.channels === 2, `channels ${audio.channels}`);
  const dec = await ffmpegDecode(dest, null);
  assert(dec.code === 0 && dec.lines.length === 0, `output does not decode cleanly: ${dec.lines.slice(0, 2).join(" / ")}`);
  assert(Math.abs(out.duration - 3) < 0.25, `duration ${out.duration}`);
  // A/V sync: the re-encoded audio must start and end together with the video (AAC priming
  // may shift it slightly; more than 100 ms would be audible lip-sync drift).
  const { stdout: timing } = await execFileAsync(FFPROBE, [
    "-v", "error", "-show_entries", "stream=codec_type,start_time,duration", "-of", "json", dest,
  ]);
  const t = Object.fromEntries(JSON.parse(timing).streams.map((x) => [x.codec_type, x]));
  const startGap = Math.abs(Number(t.audio.start_time) - Number(t.video.start_time));
  const endGap = Math.abs(
    Number(t.audio.start_time) + Number(t.audio.duration) - (Number(t.video.start_time) + Number(t.video.duration)),
  );
  assert(startGap < 0.1, `audio starts ${startGap.toFixed(3)} s away from video`);
  assert(endGap < 0.2, `audio ends ${endGap.toFixed(3)} s away from video`);
  const vol = await meanVolumeDb(dest);
  const srcVol = await meanVolumeDb(src);
  assert(vol !== null && vol > -60, `output audio is silent (mean ${vol} dB)`);
  assert(srcVol !== null && Math.abs(vol - srcVol) < 3, `loudness changed: ${vol} dB vs source ${srcVol} dB`);
  return `${audio.codec} ${audio.channels}ch, duration ${out.duration.toFixed(2)} s, A/V start gap ${startGap.toFixed(3)} s, end gap ${endGap.toFixed(3)} s, mean ${vol} dB vs ${srcVol} dB`;
}

async function testT23(env) {
  // A valid file followed by zeros (preallocated / partially downloaded recording) must still convert
  // and give exactly the same MP4 as the clean file.
  const clean = fixture("h264_aac");
  const padded = path.join(WORK, "t23-padded.mkv");
  fs.copyFileSync(clean, padded);
  fs.appendFileSync(padded, Buffer.alloc(20 * 1024 * 1024));
  const page = await openApp(env, { url: shared.root });
  const a = await convertOne(page, clean);
  await expectDone(page, a.pick, a.state);
  const b = await convertOne(page, padded);
  await expectDone(page, b.pick, b.state);
  const warnings = await cardText(page, b.pick, testid("job-warnings"));
  assert(/unreadable/.test(warnings), `no notice about the ignored tail: "${warnings}"`);
  const shaClean = await downloadSha(page, a.pick, path.join(WORK, "t23-clean.mp4"));
  const shaPadded = await downloadSha(page, b.pick, path.join(WORK, "t23-padded.mp4"));
  assert(shaClean === shaPadded, "padded file produced a different MP4");
  const { problems } = await verifyOutput(clean, path.join(WORK, "t23-padded.mp4"), null);
  assert(problems.length === 0, problems.join("; "));
  return "20 MB zero tail ignored with notice; output identical to the clean file";
}

// ---------- T24-T26: more real samples for the Vorbis path ----------

// Creates (once) a generated sample with ffmpeg; returns its path.
async function ensureSample(name, args) {
  const file = path.join(FIXTURES, `${name}.mkv`);
  if (!fs.existsSync(file)) {
    try {
      await execFileAsync(FFMPEG, ["-v", "error", "-y", ...args, file], { timeout: 1500000 });
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
  }
  return file;
}

// Times a track's start/end relative to the video; returns gaps in seconds.
async function avGaps(file) {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-show_entries", "stream=codec_type,start_time,duration", "-of", "json", file,
  ]);
  const t = Object.fromEntries(JSON.parse(stdout).streams.map((x) => [x.codec_type, x]));
  const start = (x) => Number(x.start_time);
  const end = (x) => Number(x.start_time) + Number(x.duration);
  return { startGap: Math.abs(start(t.audio) - start(t.video)), endGap: Math.abs(end(t.audio) - end(t.video)) };
}

// Runs the Vorbis -> Opus path in real Chrome. Normal runs always pick AAC, so Opus would
// otherwise never be exercised: this drives the same modules on the page with Opus forced.
async function testT24(env) {
  const src = fixture("h264_vorbis");
  if (!fs.existsSync(src)) {
    skip("no h264_vorbis.mkv fixture");
  }
  const page = await openApp(env, { url: shared.root });
  const bytes = [...fs.readFileSync(src)];
  const result = await page.evaluate(async (input) => {
    const wasm = await import(`${location.origin}/pkg/mkv2mp4.js`);
    await wasm.default();
    const audio = await import(`${location.origin}/js/core/audio-transcode.js`);
    const data = new Uint8Array(input);
    const read = (offset, length) => data.slice(offset, offset + length);
    const report = JSON.parse(wasm.probe_mkv(data.length, read));
    const track = report.reencodable[0];
    const packets = [];
    const info = wasm.export_audio_track(data.length, read, track.number, (ptsNs, d) => packets.push({ ptsNs, data: d }));
    const format = { codecPrivate: info.codecPrivate, sampleRate: info.sampleRate, channels: info.channels };
    const config = { codec: "opus", sampleRate: format.sampleRate, numberOfChannels: format.channels, bitrate: 128000 };
    const supported = await AudioEncoder.isConfigSupported(config);
    if (!supported.supported) return { unsupported: true };
    const deps = { AudioDecoder, AudioEncoder, EncodedAudioChunk };
    const encoded = await audio.transcodeVorbis({
      info: format, packets, encoder: { id: "opus", codecId: "A_OPUS", config }, deps,
    });
    const replacement = audio.buildReplacement(track.number, encoded);
    const chunks = [];
    const summary = JSON.parse(
      wasm.convert_mkv_to_mp4_ex(data.length, 0, read, (c) => chunks.push(c.slice()), () => {}, replacement),
    );
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return { mp4: [...out], codecPrivateLen: encoded.codecPrivate.length, delayNs: encoded.codecDelayNs, summary };
  }, bytes);
  if (result.unsupported) {
    skip("this Chrome has no Opus AudioEncoder");
  }
  const dest = path.join(WORK, "t24-opus.mp4");
  fs.writeFileSync(dest, Buffer.from(result.mp4));
  const out = await probeFull(dest);
  const audio = out.streams.find((x) => x.type === "audio");
  assert(audio && audio.codec === "opus" && audio.channels === 2, `audio: ${JSON.stringify(out.streams)}`);
  const dec = await ffmpegDecode(dest, null);
  assert(dec.code === 0 && dec.lines.length === 0, `decode: ${dec.lines.slice(0, 2).join(" / ")}`);
  const gaps = await avGaps(dest);
  assert(gaps.startGap < 0.1, `audio starts ${gaps.startGap.toFixed(3)} s from video`);
  assert(gaps.endGap < 0.2, `audio ends ${gaps.endGap.toFixed(3)} s from video`);
  const vol = await meanVolumeDb(dest);
  const srcVol = await meanVolumeDb(src);
  assert(vol !== null && Math.abs(vol - srcVol) < 3, `loudness ${vol} dB vs source ${srcVol} dB`);
  return `opus 2ch, OpusHead ${result.codecPrivateLen} B, delay ${result.delayNs} ns, A/V gaps ${gaps.startGap.toFixed(3)}/${gaps.endGap.toFixed(3)} s, ${vol} dB vs ${srcVol} dB`;
}

// 5.1 Vorbis: the browser may or may not encode 6 channels. Either outcome is acceptable, but the
// job must finish with the video, and any audio that is produced must decode and keep 6 channels.
async function testT25(env) {
  const src = await ensureSample("h264_vorbis_51", [
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
    "-af", "pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", "-c:a", "libvorbis", "-b:a", "256k",
  ]);
  const page = await openApp(env, { url: shared.root });
  const { pick, state } = await convertOne(page, src);
  await expectDone(page, pick, state);
  const warnings = await cardText(page, pick, testid("job-warnings"));
  const dest = path.join(WORK, "t25-51.mp4");
  await downloadFrom(page, pick, dest);
  const out = await probeFull(dest);
  assert(out.streams.some((x) => x.type === "video" && x.codec === "h264"), "video missing");
  const dec = await ffmpegDecode(dest, null);
  assert(dec.code === 0 && dec.lines.length === 0, `decode: ${dec.lines.slice(0, 2).join(" / ")}`);
  const audio = out.streams.find((x) => x.type === "audio");
  if (audio) {
    assert(audio.channels === 6, `re-encoded audio has ${audio.channels} channels`);
    assert(/re-encoded/.test(warnings), `audio present but no notice: "${warnings}"`);
    return `5.1 re-encoded to ${audio.codec} with 6 channels`;
  }
  assert(/skipped/i.test(warnings), `no audio and no skip warning: "${warnings}"`);
  return `5.1 not re-encodable here; video kept, warning: ${warnings.slice(0, 80)}`;
}

// Realistic long file: 10 min 720p H.264 with B-frames, Vorbis audio, and 100 MB of zero padding.
async function testT26(env) {
  const base = await ensureSample("h264_vorbis_long", [
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "600", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "3M", "-bf", "2",
    "-c:a", "libvorbis", "-b:a", "128k",
  ]);
  const padded = path.join(WORK, "t26-padded.mkv");
  fs.copyFileSync(base, padded);
  fs.appendFileSync(padded, Buffer.alloc(100 * 1024 * 1024));
  const page = await openApp(env, { url: shared.root });
  const started = Date.now();
  const { pick, state } = await convertOne(page, padded, 600000);
  const seconds = (Date.now() - started) / 1000;
  await expectDone(page, pick, state);
  const warnings = await cardText(page, pick, testid("job-warnings"));
  assert(/re-encoded to (AAC|Opus)/.test(warnings), `no re-encode notice: "${warnings}"`);
  assert(/unreadable/.test(warnings), `no notice for the ignored tail: "${warnings}"`);
  const dest = path.join(WORK, "t26.mp4");
  await downloadFrom(page, pick, dest, 120000);
  const out = await probeFull(dest);
  assert(Math.abs(out.duration - 600) < 1, `duration ${out.duration}`);
  const dec = await ffmpegDecode(dest, null);
  assert(dec.code === 0 && dec.lines.length === 0, `decode: ${dec.lines.slice(0, 2).join(" / ")}`);
  const gaps = await avGaps(dest);
  assert(gaps.startGap < 0.1, `audio starts ${gaps.startGap.toFixed(3)} s from video`);
  assert(gaps.endGap < 0.3, `audio ends ${gaps.endGap.toFixed(3)} s from video (drift over 10 min?)`);
  return `10 min 720p+Vorbis+100 MB tail converted in ${seconds.toFixed(1)} s; duration ${out.duration.toFixed(2)} s; A/V gaps ${gaps.startGap.toFixed(3)}/${gaps.endGap.toFixed(3)} s`;
}

// ---------- T27-T30: laced audio, error panel + diagnostics, storage limits ----------

// Audio packed into laced blocks (Xiph and EBML lacing) must convert to the identical MP4.
async function testT27(env) {
  const src = fixture("h264_aac");
  const page = await openApp(env, { url: shared.root });
  const base = await convertOne(page, src);
  await expectDone(page, base.pick, base.state);
  const baseSha = await downloadSha(page, base.pick, path.join(WORK, "t27-base.mp4"));
  const notes = [];
  for (const kind of ["xiph", "ebml"]) {
    const laced = path.join(WORK, `t27-${kind}.mkv`);
    const blocks = relaceAudio(src, laced, { track: 2, group: 4, kind });
    assert(blocks > 0, `${kind}: no audio blocks were laced`);
    const run = await convertOne(page, laced);
    await expectDone(page, run.pick, run.state);
    const warnings = await cardText(page, run.pick, testid("job-warnings")).catch(() => "");
    assert(!/laced|Skipped track/i.test(warnings), `${kind}: audio reported as skipped: "${warnings}"`);
    const chips = (await cardOf(page, run.pick).locator(testid("job-track")).allTextContents()).map((t) => t.trim());
    assert(chips.some((t) => /AAC/.test(t)), `${kind}: no AAC chip: ${JSON.stringify(chips)}`);
    const sha = await downloadSha(page, run.pick, path.join(WORK, `t27-${kind}.mp4`));
    assert(sha === baseSha, `${kind}: laced input gave a different MP4 than the unlaced original`);
    notes.push(`${kind} (${blocks} laced blocks)`);
  }
  return `${notes.join(" and ")}: output identical to the unlaced file`;
}

// Collects console output of a page: [{type, text}].
function recordConsole(page) {
  const lines = [];
  page.on("console", (msg) => lines.push({ type: msg.type(), text: msg.text() }));
  return lines;
}

// Failure: friendly panel with an error code, a copy button, and diagnostics in the console.
async function testT28(env) {
  const secret = path.join(WORK, "secret-holiday-4821.mkv");
  fs.writeFileSync(secret, randomBytes(5 * 1024));
  const context = await newContext(env);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: shared.origin });
  const page = await openPageIn(env, context, shared.root);
  const lines = recordConsole(page);
  const { pick, state } = await convertOne(page, secret);
  assert(state === "error", `garbage file: expected error, got ${state}`);
  const card = cardOf(page, pick);
  assert(
    (await card.locator(testid("job-error-code")).textContent()).trim() === "NOT_MKV",
    "error code is not NOT_MKV",
  );
  const button = card.locator(testid("job-copy-diagnostics"));
  assert(await button.isVisible(), "copy-diagnostics button is not visible");
  const label = (await button.getAttribute("aria-label")) || "";
  assert(label.includes("secret-holiday-4821"), `copy button label lacks the file name: "${label}"`);
  await button.click();
  await waitUntil(
    async () => /Copied/.test((await card.locator(testid("job-copy-status")).textContent()) || ""),
    5000,
    "no 'Copied' confirmation",
  );
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(!clip.includes("secret-holiday"), "the file name leaked into the diagnostics");
  const diag = JSON.parse(clip);
  assert(diag.schema === 1 && diag.error && diag.error.code === "NOT_MKV", `diagnostics error: ${JSON.stringify(diag.error)}`);
  assert(diag.input.extension === "mkv" && diag.input.bytes === 5 * 1024, `input: ${JSON.stringify(diag.input)}`);
  assert(diag.stages.some((x) => x.name === "scan"), `stages: ${JSON.stringify(diag.stages.map((x) => x.name))}`);
  assert(diag.extra && diag.extra.failedStage === "scan", `failed stage: ${diag.extra && diag.extra.failedStage}`);
  assert(typeof diag.env.cores === "number", "no core count in env");
  const logged = lines.find((l) => l.type === "error" && l.text.startsWith("[mkv2mp4]") && /NOT_MKV/.test(l.text));
  assert(logged, `no [mkv2mp4] error line in the console: ${JSON.stringify(lines.slice(0, 4))}`);
  assert(lines.some((l) => l.type === "log" && l.text.includes('"schema": 1')), "full JSON record was not logged");
  assert(!lines.some((l) => l.text.includes("secret-holiday")), "the file name was written to the console");

  // A good file logs an info record with timings and I/O.
  const ok = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, ok.pick, ok.state);
  const info = lines.find((l) => l.type === "info" && l.text.includes("finished in"));
  assert(info, "no finished-conversion line in the console");
  const record = lines.filter((l) => l.type === "log" && l.text.includes('"schema": 1')).map((l) => JSON.parse(l.text)).find((d) => !d.error);
  assert(record, "no JSON record for the successful run");
  const names = record.stages.map((x) => x.name);
  for (const want of ["scan", "prepare-output", "convert"]) assert(names.includes(want), `stage ${want} missing: ${names}`);
  const size = fs.statSync(fixture("h264_aac")).size;
  const scanStage = record.stages.find((x) => x.name === "scan");
  const copyStage = record.stages.find((x) => x.name === "convert");
  assert(scanStage.readBytes >= size * 0.9 && scanStage.readBytes <= size * 1.5, `scan read ${scanStage.readBytes} of a ${size} byte file`);
  assert(copyStage.writeBytes > 0, "no output bytes recorded");
  assert(record.io.readBytes < size * 2.6, `file read ${record.io.readBytes} bytes in total (${size} byte file): the scan is repeated`);
  return `error code, copy button and console record verified; scan read ${scanStage.readBytes} B and copy read ${copyStage.readBytes} B of ${size} B`;
}

// Makes navigator.storage.estimate() report the given numbers inside the conversion worker, by
// prepending a patch to the worker script. (The DevTools quota override changes what writes are
// allowed but not what estimate() reports, so it cannot drive the up-front check.)
const WORKER_SCRIPT = "**/workers/convert.worker.js";
async function patchStorageEstimate(context, estimate) {
  await context.route(WORKER_SCRIPT, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const patch = `Object.defineProperty(StorageManager.prototype, "estimate", { configurable: true, value: async () => (${JSON.stringify(estimate)}) });\n`;
    await route.fulfill({ response, body: patch + body });
  });
}

// The browser's own storage estimate is checked before copying; too little room falls back to memory
// for small results (T29).
async function testT29(env) {
  const context = await newContext(env);
  await patchStorageEstimate(context, { quota: 50_000, usage: 0 });
  const page = await openPageIn(env, context, shared.root);
  const lines = recordConsole(page);
  const { pick, state } = await convertOne(page, fixture("h264_aac"));
  await expectDone(page, pick, state);
  const record = lines.filter((l) => l.type === "log" && l.text.includes('"schema": 1')).map((l) => JSON.parse(l.text)).at(-1);
  assert(record && record.storage, "no storage record in the diagnostics");
  assert(/memory \(browser storage too small\)/.test(record.storage.mode), `storage mode: ${record.storage.mode}`);
  assert(record.storage.enough === false && record.storage.known === true, `storage: ${JSON.stringify(record.storage)}`);
  const names = await opfsOutNames(page);
  assert(names.length === 0, `OPFS files were created although storage was too small: ${names}`);
  const dest = path.join(WORK, "t29.mp4");
  await downloadFrom(page, pick, dest);
  const { problems } = await verifyOutput(fixture("h264_aac"), dest, null);
  assert(problems.length === 0, problems.join("; "));
  return `quota 50 kB: result kept in memory (${record.storage.needed} B needed), valid MP4, no OPFS file`;
}

// Large result with too little storage: fails at once with numbers; and a disk that fills up part
// way through is reported with how far it got.
async function testT30(env) {
  const base = await ensureSample("big_storage", [
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "450", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "24M", "-maxrate", "24M", "-bufsize", "48M",
    "-c:a", "aac", "-b:a", "128k",
  ]);
  const size = fs.statSync(base).size;
  assert(size > 560 * 1024 * 1024, `sample is only ${size} bytes; it must exceed the 512 MiB memory fallback`);

  const context = await newContext(env);
  await patchStorageEstimate(context, { quota: 100 * 1024 * 1024, usage: 0 });
  const page = await openPageIn(env, context, shared.root);
  const client = await context.newCDPSession(page);

  // 1. too little room from the start
  const started = Date.now();
  const first = await convertOne(page, base, 300000);
  assert(first.state === "error", `expected an error, got ${first.state}`);
  const text = await cardText(page, first.pick, testid("job-error"));
  assert(/Not enough storage space for the converted file/.test(text), `title: "${firstLine(text)}"`);
  assert(/needs about \d/.test(text) && /available/.test(text) && /Free up/.test(text), `hint: "${text}"`);
  const code = (await cardOf(page, first.pick).locator(testid("job-error-code")).textContent()).trim();
  assert(code === "STORAGE_FULL", `code ${code}`);
  assert((await opfsOutNames(page)).length === 0, "an output file was left behind");
  const preflightSecs = (Date.now() - started) / 1000;

  // 2. enough room at the start (real estimate), then the real quota is cut while copying
  await context.unroute(WORKER_SCRIPT);
  await client.send("Storage.overrideQuotaForOrigin", { origin: shared.origin, quotaSize: 4 * 1024 * 1024 * 1024 });
  const before = await cardCount(page);
  await addFiles(page, [base]);
  const pick = { index: before };
  await waitUntil(
    async () => {
      const progress = await cardOf(page, pick).locator(testid("job-progress")).getAttribute("aria-valuenow");
      return Number(progress) >= 3;
    },
    300000,
    "conversion never reached 3 %",
    50,
  );
  await client.send("Storage.overrideQuotaForOrigin", { origin: shared.origin, quotaSize: 1024 * 1024 });
  const state = await waitCard(page, pick, ["error", "done"], 300000);
  await client.send("Storage.overrideQuotaForOrigin", { origin: shared.origin });
  assert(state === "error", `mid-copy quota cut: expected an error, got ${state}`);
  const mid = await cardText(page, pick, testid("job-error"));
  assert(/The disk ran out of space while saving/.test(mid), `title: "${firstLine(mid)}"`);
  const details = await cardText(page, pick, `${testid("job-error-details")} code`);
  assert(/^storage full: disk write failed after \d+ of \d+ bytes/.test(details.trim()), `details: "${details}"`);
  assert((await opfsOutNames(page)).length === 0, "a partial output file was left behind");
  return `preflight refused in ${preflightSecs.toFixed(1)} s with sizes; mid-copy cut reported "${details.trim().slice(0, 80)}"`;
}

// ---------- T31-T35: save straight to a file the user chooses ----------

// showSaveFilePicker opens a native dialog that a headless browser cannot drive, so these tests
// replace it with a function that returns a handle to a file in the browser's private storage.
// That is the same kind of object (a FileSystemFileHandle: it can be sent to the worker and has
// createWritable), so the worker code under test is the real one. It also records whether the
// call happened while the click that opened it was still an active user gesture, which the real
// function requires.
const PICKER_PATCH = {
  fn: () => {
    window.__picker = { mode: "ok", calls: [], count: 0 };
    window.showSaveFilePicker = async (options) => {
      const picker = window.__picker;
      picker.calls.push({
        suggestedName: options?.suggestedName ?? null,
        types: options?.types ?? null,
        active: navigator.userActivation ? navigator.userActivation.isActive : null,
      });
      if (picker.mode === "abort") {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      const root = await navigator.storage.getDirectory();
      const name = `saved-${++picker.count}.mp4`;
      const handle = await root.getFileHandle(name, { create: true });
      if (picker.mode === "locked") {
        // an exclusive writer held by the page: any other writer is refused, like a file that
        // another program has open
        picker.lock = await handle.createWritable({ mode: "exclusive" });
      }
      return handle;
    };
  },
};

const NO_PICKER_PATCH = {
  fn: () => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  },
};

// A page whose browser storage looks too small and whose memory budget is tiny, so any
// conversion fails up front with STORAGE_FULL (the card then offers "Save to a file").
async function storageFullPage(env, extraInit = [PICKER_PATCH]) {
  const context = await newContext(env, extraInit);
  await patchStorageEstimate(context, { quota: 1_000, usage: 0 });
  return openPageIn(env, context, `${shared.root}?membudget=100`);
}

async function opfsAllNames(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name] of root.entries()) {
      names.push(name);
    }
    return names.sort();
  });
}

// A (small) file from the browser's private storage, as a Buffer.
async function readOpfsFile(page, name) {
  const b64 = await page.evaluate(async (fileName) => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(fileName)).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }, name);
  return Buffer.from(b64, "base64");
}

async function setPickerMode(page, mode) {
  await page.evaluate(async (m) => {
    const picker = window.__picker;
    if (picker.lock) {
      await picker.lock.abort().catch(() => {});
      picker.lock = null;
    }
    picker.mode = m;
  }, mode);
}

const pickerCalls = (page) => page.evaluate(() => window.__picker.calls);

async function clickSaveToFile(page, pick) {
  const button = cardOf(page, pick).locator(testid("job-save-to-file"));
  assert((await button.count()) === 1, "the failed card has no 'Save to a file' button");
  await button.click();
}

// After a click on "Save to a file" the card leaves "error" (picker, queue) and ends in done/error.
async function waitSaveRun(page, pick, timeout = 120000) {
  await waitCard(page, pick, ["queued", "analyzing", "converting", "done"], 30000, 25);
  return waitCard(page, pick, ["done", "error"], timeout);
}

async function testT31(env) {
  const src = fixture("h264_aac");
  const refPage = await openApp(env, { url: shared.root });
  const ref = await convertOne(refPage, src);
  await expectDone(refPage, ref.pick, ref.state);
  const refFile = path.join(WORK, "t31-ref.mp4");
  await downloadFrom(refPage, ref.pick, refFile);

  const page = await storageFullPage(env);
  const first = await convertOne(page, src);
  assert(first.state === "error", `expected the forced storage error, got ${first.state}`);
  const code = (await cardOf(page, first.pick).locator(testid("job-error-code")).textContent()).trim();
  assert(code === "STORAGE_FULL", `code ${code}`);
  const label = await cardOf(page, first.pick).locator(testid("job-save-to-file")).getAttribute("aria-label");
  assert(/h264_aac\.mp4/.test(label || ""), `button name does not carry the file name: "${label}"`);

  await clickSaveToFile(page, first.pick);
  const state = await waitSaveRun(page, first.pick);
  await expectDone(page, first.pick, state);

  const card = cardOf(page, first.pick);
  const note = await cardText(page, first.pick, testid("job-saved-note"));
  assert(/Saved to disk as saved-1\.mp4/.test(note), `saved note: "${note}"`);
  assert((await card.locator(testid("job-download")).count()) === 0, "a Download link is shown for a file that was saved to disk");
  assert((await card.locator(testid("job-preview-toggle")).count()) === 0, "a preview toggle is shown without a blob");
  assert((await card.locator(testid("job-error")).count()) === 0, "the old error panel is still shown");
  const calls = await pickerCalls(page);
  assert(calls.length === 1, `picker called ${calls.length} times`);
  assert(calls[0].suggestedName === "h264_aac.mp4", `suggested name ${calls[0].suggestedName}`);
  assert(calls[0].types?.[0]?.accept?.["video/mp4"]?.includes(".mp4"), `types ${JSON.stringify(calls[0].types)}`);
  assert(calls[0].active === true, "the picker was opened without an active user gesture (the real one would refuse)");
  assert((await opfsOutNames(page)).length === 0, "the private-storage output path was used although a file was chosen");

  const dest = path.join(WORK, "t31-saved.mp4");
  fs.writeFileSync(dest, await readOpfsFile(page, "saved-1.mp4"));
  const sameBytes = (await sha256File(dest)) === (await sha256File(refFile));
  assert(sameBytes, "the file saved through the chosen-file path differs from the normal conversion");
  const { problems } = await verifyOutput(src, dest, null);
  assert(problems.length === 0, problems.join("; "));

  // removing the card must not delete the user's file
  await card.locator(testid("job-remove")).click();
  await sleep(500);
  assert((await opfsAllNames(page)).includes("saved-1.mp4"), "removing the card deleted the saved file");
  return `saved ${fs.statSync(dest).size} B straight to the chosen file, byte-identical to the normal conversion, valid per ffprobe`;
}

async function testT32(env) {
  const src = fixture("h264_vorbis");
  if (!fs.existsSync(src)) {
    skip("no h264_vorbis.mkv fixture (needs ffmpeg with libvorbis)");
  }
  const page = await storageFullPage(env);
  const lines = recordConsole(page);
  const first = await convertOne(page, src);
  const record = lines.filter((l) => l.type === "log" && l.text.includes('"schema": 1')).map((l) => JSON.parse(l.text)).at(-1);
  assert(first.state === "error", `expected the forced storage error, got ${first.state} (storage ${JSON.stringify(record?.storage)})`);
  await clickSaveToFile(page, first.pick);
  const state = await waitSaveRun(page, first.pick);
  await expectDone(page, first.pick, state);
  const warnings = await cardText(page, first.pick, testid("job-warnings"));
  assert(/re-encoded to (AAC|Opus)/.test(warnings), `no re-encode notice: "${warnings}"`);

  const dest = path.join(WORK, "t32-saved.mp4");
  fs.writeFileSync(dest, await readOpfsFile(page, "saved-1.mp4"));
  const out = await probeFull(dest);
  const video = out.streams.find((x) => x.type === "video");
  const audio = out.streams.find((x) => x.type === "audio");
  assert(video && video.codec === "h264", `video stream: ${JSON.stringify(out.streams)}`);
  assert(audio && ["aac", "opus"].includes(audio.codec) && audio.channels === 2, `audio stream: ${JSON.stringify(out.streams)}`);
  const dec = await ffmpegDecode(dest, null);
  assert(dec.code === 0 && dec.lines.length === 0, `does not decode cleanly: ${dec.lines.slice(0, 2).join(" / ")}`);
  assert(Math.abs(out.duration - 3) < 0.25, `duration ${out.duration}`);
  const vol = await meanVolumeDb(dest);
  assert(vol !== null && vol > -60, `output audio is silent (mean ${vol} dB)`);
  return `re-encoded ${audio.codec} audio and video written through the chosen file: valid, ${out.duration.toFixed(2)} s, mean ${vol} dB`;
}

async function testT33(env) {
  const src = fixture("h264_aac");
  const page = await storageFullPage(env);
  const first = await convertOne(page, src);
  assert(first.state === "error", `expected the forced storage error, got ${first.state}`);

  // closing the dialog is not an error: the card stays failed and the button keeps working
  await setPickerMode(page, "abort");
  await clickSaveToFile(page, first.pick);
  await sleep(600);
  assert((await stateOfPick(page, first.pick)) === "error", "cancelling the dialog changed the card");
  assert((await pickerCalls(page)).length === 1, "the dialog was not opened");
  assert((await cardOf(page, first.pick).locator(testid("job-save-to-file")).count()) === 1, "button vanished after cancelling the dialog");

  // a chosen file that cannot be written (another program has it open) is its own, accurate error
  await setPickerMode(page, "locked");
  await clickSaveToFile(page, first.pick);
  await waitUntil(
    async () => (await cardText(page, first.pick, testid("job-error-code"))) === "SAVE_FAILED",
    60000,
    `the unwritable chosen file did not end as SAVE_FAILED`,
  ).catch(async (err) => {
    throw new Error(`${err.message} (card state ${await stateOfPick(page, first.pick)}, files ${JSON.stringify(await opfsAllNames(page))})`);
  });
  const title = await cardText(page, first.pick, ".job__error-title");
  assert(/write to the file you chose/.test(title), `title "${title}"`);
  const details = await cardText(page, first.pick, `${testid("job-error-details")} code`);
  assert(/^save error: NoModificationAllowedError/.test(details), `details "${details}"`);
  assert((await cardOf(page, first.pick).locator(testid("job-save-to-file")).count()) === 1, "no way to choose another file");

  // and the next attempt works
  await setPickerMode(page, "ok");
  await clickSaveToFile(page, first.pick);
  const state = await waitSaveRun(page, first.pick);
  await expectDone(page, first.pick, state);
  const note = await cardText(page, first.pick, testid("job-saved-note"));
  assert(/saved-2\.mp4/.test(note), `saved note "${note}"`);
  return "dialog cancelled -> still failed; unwritable file -> SAVE_FAILED with the browser's error; next try saved";
}

// Big file, cancelled while it is being written to the chosen file: nothing is left behind.
async function testT34(env) {
  const base = await ensureSample("big_storage", [
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "450", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "24M", "-maxrate", "24M", "-bufsize", "48M",
    "-c:a", "aac", "-b:a", "128k",
  ]);
  const page = await storageFullPage(env);
  const first = await convertOne(page, base, 300000);
  assert(first.state === "error", `expected the forced storage error, got ${first.state}`);
  assert(/STORAGE_FULL/.test(await cardText(page, first.pick, testid("job-error-code"))), "not a STORAGE_FULL error");
  await clickSaveToFile(page, first.pick);
  await waitUntil(
    async () => {
      const progress = await cardOf(page, first.pick).locator(testid("job-progress")).getAttribute("aria-valuenow");
      return Number(progress) >= 5;
    },
    300000,
    "the save never reached 5 %",
    50,
  );
  assert((await stateOfPick(page, first.pick)) === "converting", "not converting");
  await cardOf(page, first.pick).locator(testid("job-cancel")).click();
  assert((await waitCard(page, first.pick, ["cancelled"], 15000)) === "cancelled", "not cancelled");
  await waitUntil(
    async () => (await opfsAllNames(page)).length === 0,
    30000,
    `the half-written file was left behind: ${JSON.stringify(await opfsAllNames(page))}`,
    250,
  );

  // Then the same big file, saved to the end: the worker verifies the size on disk, and the file
  // must be about as large as the input (a remux copies the compressed data).
  const second = await convertOne(page, base, 300000);
  assert(second.state === "error", `expected the forced storage error, got ${second.state}`);
  await clickSaveToFile(page, second.pick);
  const state = await waitSaveRun(page, second.pick, 600000);
  await expectDone(page, second.pick, state);
  const names = (await opfsAllNames(page)).filter((n) => /^saved-/.test(n));
  assert(names.length === 1, `expected one saved file, found ${JSON.stringify(names)}`);
  const savedSize = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle(name)).getFile()).size;
  }, names[0]);
  const inputSize = fs.statSync(base).size;
  assert(Math.abs(savedSize - inputSize) / inputSize < 0.02, `saved ${savedSize} B from a ${inputSize} B input`);
  const note = await cardText(page, second.pick, testid("job-saved-note"));
  assert(note.includes(names[0]), `saved note "${note}"`);
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  }, names[0]);
  return `cancel while writing left no partial file; a full ${(savedSize / 2 ** 20).toFixed(0)} MiB save to the chosen file completed and the size on disk was verified`;
}

// The button only appears when it can help and the browser supports it.
async function testT35(env) {
  // a failure that choosing a file cannot fix
  const garbage = path.join(WORK, "t35-garbage.mkv");
  fs.writeFileSync(garbage, randomBytes(4096));
  const context = await newContext(env, [PICKER_PATCH]);
  const page = await openPageIn(env, context, shared.root);
  const bad = await convertOne(page, garbage);
  assert(bad.state === "error", `expected an error, got ${bad.state}`);
  assert((await cardOf(page, bad.pick).locator(testid("job-save-to-file")).count()) === 0, "the button is offered for a damaged input file");

  // a browser without the save dialog
  const noPicker = await storageFullPage(env, [NO_PICKER_PATCH]);
  const full = await convertOne(noPicker, fixture("h264_aac"));
  assert(full.state === "error", `expected the forced storage error, got ${full.state}`);
  assert(/STORAGE_FULL/.test(await cardText(noPicker, full.pick, testid("job-error-code"))), "wrong code");
  assert((await cardOf(noPicker, full.pick).locator(testid("job-save-to-file")).count()) === 0, "the button is offered without showSaveFilePicker");
  const hint = await cardText(noPicker, full.pick, ".job__error-hint");
  assert(hint.length > 20, "the error has no explanation");
  return "no button for a damaged file or without showSaveFilePicker; error text still present";
}

const TESTS = [
  { id: "T1", title: "OPFS convert h264_aac at /video-convertor/ (chips, download, ffprobe, preview)", timeoutMs: 300000, run: testT1 },
  { id: "T2", title: "in-memory sink (?nofs=1) gives the same bytes, no OPFS files", timeoutMs: 300000, run: testT2 },
  { id: "T3", title: "garbage input -> error card with raw details; queue recovers", timeoutMs: 300000, run: testT3 },
  { id: "T4", title: "VP9-only input -> 'No supported video or audio found' naming V_VP9", timeoutMs: 300000, run: testT4 },
  { id: "T5", title: "codec matrix through the UI (hevc, flac, ac3, mp3, opus, av1, video-only)", timeoutMs: 900000, run: testT5 },
  { id: "T6", title: "remove done card: OPFS file gone <5 s, blob URL revoked; clear-finished", timeoutMs: 300000, run: testT6 },
  { id: "T7", title: "multi-tab: re-download, orphan sweep of a closed tab's output <8 s", timeoutMs: 900000, run: testT7 },
  { id: "T8", title: "lock-ready handshake: init held >=1 s, then ready and convert", timeoutMs: 180000, run: testT8 },
  { id: "T9", title: "cancel while converting: card stays, file gone <15 s, next job intact", big: true, timeoutMs: 1200000, run: testT9 },
  { id: "T10", title: "389 MB conversion: size, duration, decode of first 20 s", big: true, timeoutMs: 1800000, run: testT10 },
  { id: "T11", title: "network isolation: only local static GETs; CSP blocks fetch, WebSocket, beacon", timeoutMs: 300000, run: testT11 },
  { id: "T12", title: "responsiveness: rAF gap, long tasks, progress updates", big: true, timeoutMs: 1200000, run: testT12 },
  { id: "T13", title: "queue of 3: at most one active, order kept, queued cards indeterminate", timeoutMs: 600000, run: testT13 },
  { id: "T14", title: "theme: cycle, OS follow, persistence, keyboard", timeoutMs: 180000, run: testT14 },
  { id: "T15", title: "dialogs (Esc, focus return, Tab trap) and inert 'Soon' nav items", timeoutMs: 300000, run: testT15 },
  { id: "T16", title: "analysis chips and duration match ffprobe (h264_aac, hevc_aac)", timeoutMs: 300000, run: testT16 },
  { id: "T17", title: "worker confinement: fetch/WebSocket to example.com blocked inside a factory worker", timeoutMs: 300000, run: testT17 },
  { id: "T18", title: "sub-path /video-convertor/: no response >=400; every Worker URL is blob:", timeoutMs: 300000, run: testT18 },
  { id: "T19a", title: "queue lifecycle: cancel+remove a running card, others finish, card never reappears", timeoutMs: 900000, run: testT19a },
  { id: "T19b", title: "worker bootstrap and ready-timeout failures fail closed ('secure worker')", timeoutMs: 300000, run: testT19b },
  { id: "T20", title: "aggregate memory budget (?nofs=1&membudget=250000)", timeoutMs: 300000, run: testT20 },
  { id: "T21", title: "keyboard a11y: Tab order, focus after removal, accessible names, progress semantics", timeoutMs: 300000, run: testT21 },
  { id: "T22", title: "Vorbis audio is re-encoded to AAC/Opus with WebCodecs (valid MP4, same duration and loudness)", timeoutMs: 300000, run: testT22 },
  { id: "T23", title: "zero-padded MKV converts, with a notice, to the identical MP4", timeoutMs: 300000, run: testT23 },
  { id: "T24", title: "Vorbis -> Opus path in real Chrome (forced): valid MP4, sync, loudness", timeoutMs: 300000, run: testT24 },
  { id: "T25", title: "5.1 Vorbis: job finishes with video; audio either re-encoded with 6 channels or skipped with a warning", timeoutMs: 300000, run: testT25 },
  { id: "T26", title: "10 min 720p B-frames + Vorbis + 100 MB zero tail: converts, no A/V drift", big: true, timeoutMs: 1800000, run: testT26 },
  { id: "T27", title: "laced audio (Xiph and EBML lacing) converts to the identical MP4 as the unlaced file", timeoutMs: 300000, run: testT27 },
  { id: "T28", title: "error panel: code, copy-diagnostics button, [mkv2mp4] console records, no file name leaked; input scanned once", timeoutMs: 300000, run: testT28 },
  { id: "T29", title: "browser storage estimate too small: small results fall back to memory (no OPFS file)", timeoutMs: 300000, run: testT29 },
  { id: "T30", title: "large result, too little storage: refused up front with sizes; quota cut while copying is reported with progress", big: true, timeoutMs: 1800000, run: testT30 },
  { id: "T31", title: "failed card -> Save to a file: written straight to the chosen file, byte-identical, no private-storage output", timeoutMs: 300000, run: testT31 },
  { id: "T32", title: "Save to a file with re-encoded Vorbis audio: valid MP4 with audio", timeoutMs: 300000, run: testT32 },
  { id: "T33", title: "save dialog cancelled -> card unchanged; unwritable file -> SAVE_FAILED; next try works", timeoutMs: 300000, run: testT33 },
  { id: "T34", title: "big file to a chosen file: cancel leaves nothing behind; a full save completes with the size verified", big: true, timeoutMs: 1800000, run: testT34 },
  { id: "T35", title: "Save-to-file button only where it can help (not for damaged files, not without the save dialog)", timeoutMs: 300000, run: testT35 },
];

// ---------- main ----------

function printList() {
  for (const test of TESTS) {
    console.log(`${test.id.padEnd(4)} ${test.big ? "[--big] " : ""}${test.title}`);
  }
}

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
  const { chromium } = await import("playwright-core");
  WORK = fs.mkdtempSync("/tmp/mkvtools/e2e-run-");
  const server = await startServer(shared.hits);
  const port = server.address().port;
  shared.origin = `http://127.0.0.1:${port}`;
  shared.root = `${shared.origin}/`;
  shared.sub = `${shared.origin}${PREFIX}/`;
  let generatedBig = false;
  try {
    if (BIG) {
      generatedBig = await ensureBigInput();
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    console.log(`Chrome ${browser.version()} (${CHROME}); server ${shared.root} and ${shared.sub}`);

    for (const test of TESTS) {
      if (ONLY && !ONLY.has(test.id)) {
        continue;
      }
      if (test.big && !BIG) {
        console.log(`SKIP ${test.id} -- ${test.title} (needs --big)`);
        results.push({ id: test.id, status: "SKIP" });
        continue;
      }
      await runTest(test);
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
    if (generatedBig) {
      fs.rmSync(BIG_IN, { force: true });
    }
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

if (LIST) {
  printList();
  process.exit(0);
}

main().catch((err) => {
  console.error(`browser-smoke: setup error: ${err.stack || err.message}`);
  process.exitCode = 2;
});
