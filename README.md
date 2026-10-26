# Convertor

Convertor is a set of local-first media tools that run entirely in your browser. The first tool converts **MKV to MP4**. It is a remuxer written in Rust and compiled to WebAssembly:

- **No upload.** The file is read and converted inside the browser tab.
- **No re-encoding.** Compressed video and audio packets are copied byte for byte into an MP4 container, so the result is lossless.
- **Fast.** The work is container rewriting, so it is limited by disk and memory bandwidth, not by codec speed.

Repository: <https://github.com/iamshreeram/video-convertor>
Site: <https://iamshreeram.github.io/video-convertor/>

## Your files never leave your device

- **Content Security Policy.** `index.html` sets a strict CSP: `default-src 'none'`, `connect-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `object-src 'none'`, `form-action 'none'`, and no other origins are allowed. The page cannot send your file, or anything else, to a third-party server.
- **No third-party requests.** No shipped file contains an external `http(s)://` URL, no external fonts or scripts are loaded, and the UI uses the system font stack. CI checks this on every build.
- **Confined worker.** The conversion runs in a Web Worker. It is started through a small `blob:` module bootstrap, so the worker inherits the page's CSP. Your browser's own CSP cannot be weakened by the worker. If the secure worker cannot start, the app stops and does not fall back to an unconfined worker.
- **Verify it yourself.** Open DevTools → **Network**, convert a file, and look at the list. You should see only the page's own assets (HTML, JS, CSS, SVG, and the `.wasm` file). No request carries your file. The "Processed locally" badge in the header explains the same check.
- **Automated proof.** The end-to-end suite (headless Chrome) blocks every request except the local origin and fails if any other request is attempted during a conversion. It also checks that `fetch`, `WebSocket` and `sendBeacon` to an external host are refused by the CSP, and that the worker runs under the inherited policy.

## Features

- **Multi-file queue.** Drop or pick several files. They are converted one at a time, in order.
- **Analysis before converting.** Each file is probed first. The card shows its tracks (codec, resolution or channels, sample rate, language), duration, estimated output size and any warnings about skipped tracks.
- **Progress.** Each job shows its stage, a percentage, throughput (MB/s), estimated time remaining and elapsed time.
- **Cancel.** Queued and running jobs can be cancelled. A cancelled run's partial output is removed.
- **Lazy preview.** A video player is created only when you press **Preview**, and it is removed when you close it. Nothing is loaded in the background.
- **Download.** Finished files are offered as `<name>.mp4`.
- **Dark mode.** Light, dark or automatic (follows the system). The choice is stored locally in the browser.
- **Keyboard accessible.** Every control can be reached and operated from the keyboard. Dialogs trap focus and close with Esc. State changes are announced to screen readers.
- **Responsive.** The sidebar collapses to a tab bar on narrow screens. `prefers-reduced-motion` disables animation.

## Supported codecs

| Kind  | Supported (copied into MP4)                                                                 | Skipped with a warning                                                                 | Not supported                              |
|-------|---------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|--------------------------------------------|
| Video | H.264 (`avc1`), H.265/HEVC (`hvc1` when the parameter sets live only in the config, otherwise `hev1`), AV1 (`av01`) | VP8, VP9 video | Laced blocks, content-encoded (compressed or encrypted) tracks |
| Audio | AAC (`mp4a`), MP3 (`mp4a`), Opus (`Opus`), FLAC (`fLaC`), AC-3 (`ac-3`)                     | E-AC-3, DTS, TrueHD, PCM                                                               | Laced blocks, content-encoded tracks       |
| Other | none                                                                                        | Subtitles, attachments, chapters                                                       | none                                       |

A file with no supported track fails with an error that lists what was found.

## Performance

A remux copies the existing compressed bytes and rewrites only the container metadata. There is no decoding and no per-pixel or per-sample computation, so throughput is bounded by how fast the browser can read the input and write the output, not by the CPU or GPU.

Measured on a laptop with headless Chrome writing to OPFS: a file of about 390 MB converts in roughly 5 to 12 seconds, depending on the disk.

**Why WebGPU is not used.** A GPU only helps with heavy per-pixel or per-sample work. Remuxing has none, so a GPU path would add complexity and cost without making the copy faster. GPU work would matter for re-encoding, which this tool does not do. A future tool that transcodes would use the browser's WebCodecs hardware codecs rather than WebGPU.

## Memory

- **Input** is read in slices from the `File` on the worker. The whole file is never loaded into memory. Only a compact index of blocks (offset, size, timestamp, keyframe flag) is kept.
- **Output** is written to the Origin Private File System (OPFS), which is disk-backed, where the browser supports it (Chrome and Edge, Safari 15.2+, Firefox 111+).
- **Fallback.** Where OPFS is unavailable, the output is held in memory. The total of all retained in-memory results is capped at an aggregate budget of **1.5 GiB**. A file that would exceed the remaining budget is refused before any work starts. Download or remove finished files to free budget.

## Limitations

- **No transcoding.** Tracks that MP4 cannot carry in this form (VP8/VP9 video, E-AC-3, DTS, TrueHD, PCM audio) are dropped. If you need them, transcode with ffmpeg first, for example `ffmpeg -i in.mkv -c:v libx264 -c:a aac out.mp4`.
- **Only the first video track** is converted. Additional video tracks are skipped.
- **Subtitles, attachments and chapters are dropped.**
- **Playback depends on the browser.** The MP4 is valid, but not every browser can decode every codec inside MP4. AC-3, HEVC and AV1 in particular may not play in some browsers, even though the file itself is correct.
- **Faststart layout.** The `moov` box is written before the media data, so playback can begin before the file is fully downloaded.

## How it works

Conversion runs in two passes inside the Rust core.

1. **Scan.** The EBML structure is walked (headers only, not payloads) to build an index of every block. Nothing else is kept in memory.
2. **Plan and stream.** Per-track timing is computed, then `ftyp` and `moov` are written first, followed by `mdat`. Sample payloads are copied in slices of at most 1 MiB, in interleaved chunks.

A **probe API** runs the same scan and planning without writing anything. It reports the tracks, duration, exact output size and warnings, so the UI can show them before conversion. Probe and convert share the same code path, and their results are tested to agree.

Timing details:

- **B-frames:** decode timestamps (`dts`) come from the sample order, composition offsets (`ctts`) carry the reordering, and an edit list keeps presentation times aligned with the source.
- **AAC:** frame durations are fixed (1024 samples, or 960 with `frameLengthFlag`, doubled for SBR), so timestamp jitter is normalised.
- **Opus:** the end trim comes from positive `DiscardPadding` on the last block only. Pre-skip is stored in `dOps` and is not applied twice.
- **Origin:** all tracks share one origin shift, so the earliest frame starts at zero and late-starting tracks keep their relative offset through an empty edit.
- **Interleaving:** samples are grouped into chunks of up to 500 ms of media (and at most 512 samples), alternating between tracks by decode time.

### Worker protocol

The page talks to the conversion worker with a small message protocol:

- **Start:** the page sends `process` with the file, a session id, a run id, the output mode and the memory budget. The worker replies `ready` before it accepts any work.
- **Analysis:** the worker sends `stage` and then `analysis` (the probe report) before converting.
- **Progress:** `progress` messages are throttled to about 100 ms and always end with a final value of 1.
- **Finish:** `done` (with the output name and summary) or `error` (a message and details). Errors are mapped to plain sentences in the UI, with the original text under Details.
- **Cleanup:** `cleanup` removes the OPFS files of named runs of the current session. It is retried for up to 15 seconds, and a cancelled run is always cleaned up.

## Project layout

```
.
├── Cargo.toml                 crate manifest (cdylib + rlib), wasm-bindgen pinned with =
├── Cargo.lock
├── src/
│   ├── lib.rs                 module tree and public API
│   ├── error.rs               Error enum
│   ├── source.rs              Source / Sink traits, BufferedSource
│   ├── ebml.rs                EBML element reader
│   ├── mkv.rs                 pass 1: scan Matroska/WebM structure
│   ├── codec.rs               codec detection and MP4 sample entries
│   ├── plan.rs                timing, edit lists, chunk interleaving
│   ├── mp4.rs                 pass 2: ftyp/moov/mdat writer
│   ├── convert.rs             convert() and probe() orchestration and progress
│   ├── json.rs                JSON reports for the web UI
│   └── wasm.rs                wasm-bindgen exports (wasm32 only)
├── tests/                     Rust integration tests and JS unit tests (tests/js)
├── web/                       static site source (see web/ for the current files)
├── scripts/
│   ├── build.sh               builds dist/ (and dist-node/ with --node)
│   ├── node-smoke.mjs         Node.js converter and probe (development only)
│   └── validate.sh            compares output against ffmpeg/ffprobe (development only)
├── e2e/                       headless-Chrome end-to-end tests of the built site (development only)
└── .github/workflows/ci.yml   CI: tests, lint, build, publish to gh-pages and GitHub Pages
```

The web source is organised in layers. Each is described in `web/`:

- `web/js/core/`: pure helpers and browser services (formatting, theme, sessions, feature detection, worker factory, memory budget).
- `web/js/queue/`: the sequential job queue (pure, unit-tested).
- `web/js/ui/`: shell, dropzone, job cards.
- `web/js/tools/`: one module per tool, plus `registry.js`, which lists the tools shown in the sidebar.

`dist/` and `dist-node/` are build outputs and are not committed.

### Adding a new tool

1. Add an entry to `web/js/tools/registry.js` (id, group, title, subtitle, accepted file types, and `status: 'ready'`).
2. Implement a tool module in `web/js/tools/` that renders its view and drives its jobs through the shared queue and worker factory.
3. If the tool needs new Rust code, add it to the crate and export it through `src/wasm.rs`.

Entries with `status: 'soon'` appear in the sidebar as disabled items.

## Development

### Prerequisites

- [rustup](https://rustup.rs/), then the WebAssembly target:
  ```sh
  rustup target add wasm32-unknown-unknown
  ```
- The wasm-bindgen CLI, at the **same version** as the `wasm-bindgen` line in `Cargo.toml` (currently `0.2.129`):
  ```sh
  cargo install wasm-bindgen-cli --version 0.2.129 --locked
  ```
  The version must match exactly. `scripts/build.sh` checks this and stops with a message if it does not.
- Node.js 22 (for the JavaScript unit tests and the optional smoke tools).

### Commands

```sh
cargo fmt --check                   # formatting
cargo test                          # Rust unit and integration tests (native)
cargo clippy --lib -- -D warnings   # library lint gate
npm test                            # JavaScript unit tests (node:test, tests/js)
bash scripts/build.sh               # builds dist/ (static site + wasm)
python3 -m http.server -d dist 8080 # then open http://localhost:8080
```

Serve `dist/` over HTTP. Opening `index.html` as a `file://` URL will not work, because module workers and `.wasm` files are blocked there.

Optional Node.js tools (no browser needed):

```sh
bash scripts/build.sh --node
node scripts/node-smoke.mjs in.mkv out.mp4   # convert
node scripts/node-smoke.mjs --probe in.mkv   # print the probe report as JSON only
```

### Validation against ffmpeg and in a real browser (optional, development only)

The unit and integration tests use synthetic MKV files. Two extra tools check real files:

```sh
# 1. Needs ffmpeg + ffprobe and a directory of .mkv fixtures; converts each file with the
#    Node build and checks: full decode, stream/packet parity, packet timing, duration,
#    inter-stream start offsets, decoded video frames (framemd5) and the first second of audio.
bash scripts/build.sh --node
bash scripts/validate.sh /path/to/fixtures /path/to/ffmpeg /path/to/ffprobe

# 2. Headless Chrome (playwright-core, uses your installed Chrome) against dist/: UI flows,
#    network isolation, worker confinement, OPFS and in-memory output, errors, several tabs,
#    cancel, responsiveness, and large files (--big).
bash scripts/build.sh
cd e2e && npm install && node browser-smoke.mjs [--big]
```

The scripts expect `ffmpeg`/`ffprobe` and `fixtures` at the locations given on the command line (see the header of each script).

## CI and deployment

The workflow in `.github/workflows/ci.yml` runs on pushes to `main`, on pull requests, and on manual dispatch. For every run it:

1. checks formatting, runs the Rust tests and the library clippy gate (warnings are errors), and runs the JavaScript unit tests;
2. builds the site with `scripts/build.sh`, using the wasm-bindgen CLI pinned in `Cargo.toml` (cached);
3. checks that the wasm file and `index.html` exist, and that no shipped file contains an external URL.

On pushes to `main` only, it then:

4. commits the built site to the **`gh-pages`** branch (a force-pushed, single-commit mirror of exactly what was published), and
5. uploads the same `dist/` as a Pages artifact and deploys it with the **GitHub Pages** action.

`main` contains **source only**: no wasm, no build output, no binaries. `gh-pages` is a generated mirror and is overwritten on every run. Do not commit to it by hand.

### One-time repository setup

1. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
2. **Settings → Actions → General → Workflow permissions:** choose **Read and write permissions** if your organisation restricts the default `GITHUB_TOKEN`. The `build` job needs write access to push `gh-pages`.
3. Push to `main` (or run the **CI** workflow manually from the Actions tab). The `deploy` job's URL is shown on the run summary.

The site is then live at <https://iamshreeram.github.io/video-convertor/>.

## Troubleshooting

- **`wasm-bindgen CLI is X but Cargo.toml pins Y`** (from `scripts/build.sh`): the installed CLI does not match the crate. Reinstall it at the pinned version: `cargo install wasm-bindgen-cli --version Y --locked`.
- **`wasm-bindgen CLI not found`**: `~/.cargo/bin` is not on your `PATH`, or the CLI was never installed. See Prerequisites.
- **"Could not start the secure worker in this browser"**: the browser did not run the blob bootstrap in time. Use a current Chrome, Edge, Firefox or Safari.
- **"no supported tracks"**: the file has no video or audio track in one of the supported codecs (see the table above). Transcode it with ffmpeg first.
- **"Not enough memory to hold this file"**: the browser has no OPFS and the output would exceed the 1.5 GiB in-memory budget. Download or remove finished files, or use a browser with OPFS support.
- **Download works but the video does not play**: the MP4 is valid, but the browser may not decode that codec inside MP4 (AC-3, HEVC and AV1 are the usual cases). Try another browser, or transcode with ffmpeg.
- **CI fails at "Check shipped files for external URLs"**: a shipped file contains an `http(s)://` address. Remove it or load the resource from the same origin. The job prints the offending files.
- **CI fails at "Commit built site to gh-pages"** with a permission error: set Workflow permissions to Read and write (see setup above).

## License

Released under the terms of the [LICENSE](LICENSE) file in this repository.
