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
