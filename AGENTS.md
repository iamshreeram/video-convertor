# AGENTS.md: context for anyone (human or AI agent) working on this repo

This file is the shared background for every GitHub issue in this repository. Read it fully
before starting an issue; the issues deliberately do not repeat it. The README describes the
product; this file describes how to work on it safely.

## 1. What this project is

"Convertor" is a **local-first, multi-tool media converter** that runs entirely in the browser
and is hosted as a static site on GitHub Pages. The first tool, **MKV to MP4**, is a lossless
*remuxer* (it copies compressed streams into a new container, no decoding) written in Rust,
compiled to WebAssembly, and driven from a vanilla-JS UI. Roadmap: see the epic issue
("Multi-format conversion roadmap") and its linked issues.

Remote: `https://github.com/iamshreeram/video-convertor`. Default branch: `main`.

## 2. Non-negotiable invariants

Breaking any of these is a blocker, whatever the feature.

1. **Files never leave the device.** No upload, analytics, telemetry, CDN, font service or any
   third-party request. The page ships a strict Content-Security-Policy meta tag
   (`web/index.html`: `default-src 'none'`, `connect-src 'self'`, `worker-src 'self' blob:`,
   `script-src 'self' 'wasm-unsafe-eval'`). Do not loosen it globally. If a tool genuinely
   needs something extra, scope it and update the network-isolation e2e test (T11) in the same
   change. Any large dependency (codecs, wasm cores) must be **self-hosted** in `dist/`.
2. **`main` is source only.** Never commit `.wasm`, `.mp4`, `.mkv`, `dist/`, `dist-node/`,
   `node_modules/`, `target/` or lockfiles that contain private registry URLs
   (`e2e/package-lock.json` is git-ignored for that reason). CI builds the wasm and publishes
   the generated site to the `gh-pages` branch.
3. **Tests first, no weakened assertions.** Write the failing test(s) before the
   implementation. Never delete or loosen an assertion to get green. If a spec genuinely
   changes, say so explicitly in the PR description and in a code comment next to the test.
4. **Real-file parity.** New conversion paths are validated against `ffprobe`/`ffmpeg` on real
   files (see section 5), not only against synthetic fixtures.
5. **No `innerHTML`/`outerHTML`/`insertAdjacentHTML`, no inline `style=` attributes, no inline
   scripts.** Build DOM with `web/js/core/dom.js` `h()`. All user-visible strings that come
   from file names or errors go in as text nodes.
6. **Accessibility is a requirement**, not polish: keyboard operable, visible focus, accessible
   names that include the file name for per-file buttons, `role=progressbar` semantics
   (`aria-valuenow` only when determinate), `prefers-reduced-motion` respected, WCAG AA
   contrast using the tokens in `web/css/tokens.css` only.
7. **Do not use WebGPU to speed up a remux.** Remuxing copies bytes and is I/O-bound. WebGPU is
   only relevant for per-pixel work (filters, scaling) in a future transcode tool.
8. **Commit identity:** commits are authored `iamshreeram <shreeram.v@live.com>`. Never commit
   other personal/work email addresses, hostnames, or internal URLs (check lockfiles).

## 3. Architecture in one page

```
file (File/Blob)
  -> web worker (web/workers/convert.worker.js, started from a blob: bootstrap, fail-closed)
       -> wasm (Rust core, src/)   reads via FileReaderSync callbacks (Source),
                                   writes via OPFS sync access handle or memory (Sink)
  <- messages: ready, stage, analysis, progress, done, error, info, cleaned
UI (web/js): shell + tool registry -> tool module (web/js/tools/mkv-to-mp4.js) -> queue -> job cards
```

Rust crate (`src/`), two passes, streaming, bounded memory (only an index of samples is kept):

| File | Role |
|---|---|
| `source.rs` | `Source` (random-access read) and `Sink` (append-only write) traits, `SliceSource`, `BufferedSource` (adaptive read window) |
| `ebml.rs`, `mkv.rs` | pass 1: scan Matroska/WebM headers into a sample index (`Mkv`, `MkvTrack`, `SampleRef`, `TrackKind`) |
| `codec.rs` | codec detection + MP4 sample entries (`prepare_video`, `prepare_audio`): h264, hevc, av1, aac, mp3, opus, flac, ac3 |
| `plan.rs` | timing, edit lists, chunk interleaving -> `Plan { tracks: Vec<PlanTrack{samples: Vec<PlanSample{offset,size,dts,duration,cts_offset,keyframe}>, sample_entry, edits,..}>, chunks, ... }` |
| `mp4.rs` | pass 2: `build_header` (ftyp+moov, faststart) and `write_mp4` (mdat copy in <=1 MiB slices) |
| `convert.rs` | `convert()` and `probe()` orchestration, progress, `ProbeReport`/`ConvertReport` |
| `json.rs` | JSON for the UI; `wasm.rs` wasm-bindgen exports (`convert_mkv_to_mp4`, `probe_mkv`, `version`) |
| `error.rs` | `Error::{Io, InvalidMkv, Unsupported, TooLarge, Sink}`; messages are mapped to friendly text in `web/js/core/errors.js` (with tests in `tests/js/errors.test.mjs`): when you add or rename errors, update both |

`probe()` and `convert()` share one code path and are tested to agree (output size, tracks).

Web layers (`web/js/`): `core/` (pure helpers + browser services: `format`, `errors`,
`memory-budget`, `theme`, `caps`, `session`, `worker-factory`, `dom`, `icons`, `toast`),
`queue/queue.js` (pure sequential queue with once-only settlement, cancel, discard),
`ui/` (shell, dropzone, job-list, job-card, dialogs), `tools/` (one module per tool +
`registry.js`). Adding a tool: README "Adding a new tool".

## 4. Hard-won lessons (do not rediscover these)

- **Browser file reads are expensive per call.** `FileReaderSync.readAsArrayBuffer(file.slice())`
  costs roughly 0.3 ms per call. Header scans use an adaptive read window of 64 KiB..4 MiB
  (`READ_MIN_WINDOW/READ_MAX_WINDOW` in `src/mkv.rs`); 4 KiB windows made analysis of a 389 MB
  file take 2.6 s instead of 0.4 s. Prefer fewer, larger reads. `tests/io_amplification.rs`
  guards read amplification (thresholds were deliberately adjusted for this trade-off).
- **Matroska `CodecDelay`** must be applied to audio timestamps; Opus pre-skip must not be
  applied twice; Opus end trim comes from positive `DiscardPadding` on the last block only.
- **wasm-bindgen CLI version must equal the `=` pin in `Cargo.toml`** (currently 0.2.129);
  `scripts/build.sh` enforces it.
- **OPFS**: output is written with a sync access handle in the worker; cancelled/removed runs
  must be cleaned up (exact run id, retry on busy handles up to 15 s); orphans from closed tabs
  are swept using Web Locks. Do not regress this when adding output paths.
- **In-memory fallback** is limited by an aggregate budget (1.5 GiB); the worker refuses
  before writing when a result would not fit.
- **Playwright's bundled Chromium has no H.264.** E2E uses the locally installed Google Chrome
  (`executablePath` in `e2e/browser-smoke.mjs`). WebCodecs/H.264 behaviour must be tested there.
- **GitHub Pages cannot set response headers** (no COOP/COEP), so `SharedArrayBuffer`/threaded
  wasm is unavailable unless a service-worker shim is used, which conflicts with the privacy
  model (see the ffmpeg.wasm issue).
- Theme colours flip without CSS transitions on purpose (transitions caused a mixed light/dark
  frame). Tokens: single source in `web/css/tokens.css`, applied before first paint by
  `web/js/theme-init.js`.

## 5. How to build, test and validate

Prerequisites: Rust stable + `wasm32-unknown-unknown`, `wasm-bindgen-cli` at the pinned
version, Node 22, and for validation `ffmpeg`/`ffprobe` (README "Development").

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --check
cargo test                                            # ~126 tests (synthetic MKVs, tests/common/mod.rs builders)
cargo clippy --lib -- -D warnings
cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings
npm test                                              # node:test, tests/js/*.test.mjs (pure JS modules)
bash scripts/build.sh [--node]                        # dist/ (and dist-node/ for the node tools)
node scripts/node-smoke.mjs in.mkv out.mp4            # convert from the CLI; --probe prints the probe JSON
bash scripts/validate.sh <fixtures_dir> <ffmpeg> <ffprobe>   # real-file parity vs ffmpeg (needs --node build)
cd e2e && npm install && node browser-smoke.mjs [--big] [--only=T1,T11] [--list]   # headless Chrome UI tests
```

Real fixtures are **not** in the repo (binary files). They live in a local directory (the
maintainer uses `/tmp/mkvtools/fixtures`); the infra issue ("reproducible fixtures") adds a
script that regenerates them with ffmpeg. Until then create small (3 s, 320x240) files with
ffmpeg yourself, one per codec combination you touch.

Definition of done for any feature PR: all commands above green; new tests listed in the issue
added; `scripts/validate.sh` (extended for the new format) shows 0 FAIL; e2e passes (including
T11 network isolation); README (supported formats, limitations) updated; CI green on the PR.

## 6. Conventions

- Rust: no `unsafe`; no panics on malformed input (return `Error`); bound every allocation
  that depends on file contents (see `mkv.rs` limits); no new dependencies without a stated
  reason (binary size matters: the wasm is ~126 KB; report size before/after).
- JS: ES modules, JSDoc types, no frameworks, no build step for `web/`. Pure logic goes in
  `web/js/core` or `web/js/queue` with `node:test` unit tests; DOM code stays thin.
- E2E selectors are `data-testid` attributes (see `web/js/ui/*`); keep them stable.
- Keep PRs small and reviewable; one issue per PR where possible; reference the issue.
- CI (`.github/workflows/ci.yml`) runs fmt, tests, clippy, JS tests, build, an "no external
  URLs in dist" check, publishes `gh-pages`, and deploys Pages when configured.
