# mkv2mp4

Client-side MKV to MP4 **remuxer** written in Rust and compiled to WebAssembly.

- **No upload.** The file is read and converted inside your browser tab.
- **No re-encoding.** Compressed video and audio packets are copied byte for byte into an MP4 container, so the result is lossless.
- **Fast.** The work is container rewriting, so it is limited by disk and memory bandwidth rather than by codec speed.

Live demo (after you deploy it, see [Deploying to GitHub Pages](#deploying-to-github-pages)):
`https://<your-user>.github.io/<repo>/`

## Supported codecs

| Kind  | Supported (copied into MP4)                                                                 | Skipped with a warning                                                                 | Not supported                              |
|-------|---------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|--------------------------------------------|
| Video | H.264 (`avc1`), H.265/HEVC (`hvc1` when the parameter sets live only in the config, otherwise `hev1`), AV1 (`av01`) | VP8, VP9 video | Laced blocks, content-encoded (compressed or encrypted) tracks |
| Audio | AAC (`mp4a`), MP3 (`mp4a`), Opus (`Opus`), FLAC (`fLaC`), AC-3 (`ac-3`)                     | E-AC-3, DTS, TrueHD, PCM                                                               | Laced blocks, content-encoded tracks       |
| Other | none                                                                                        | Subtitles, attachments, chapters                                                       | none                                       |

A file with no supported track fails with an error that lists what was found.

## Limitations

- **No transcoding.** Tracks that MP4 cannot carry in this form (VP8/VP9 video, E-AC-3, DTS, TrueHD, PCM audio) are dropped. If you need them, transcode with ffmpeg first, for example `ffmpeg -i in.mkv -c:v libx264 -c:a aac out.mp4`.
- **Only the first video track** is converted. Additional video tracks are skipped.
- **Subtitles, attachments and chapters are dropped.**
- **Playback depends on the browser.** The MP4 is valid, but not every browser can decode every codec inside MP4. AC-3, HEVC and AV1 in particular may not play in some browsers, even though the output file itself is correct.
- **Large files.** The input is streamed in pieces and is never loaded whole. The output is written to the browser's Origin Private File System (OPFS) where it is available (Chrome/Edge, Safari 15.2+, Firefox 111+). Where OPFS is missing, the output is held in memory with a 1.5 GiB cap, and the conversion fails with a clear error if the output would exceed it.
- **Faststart layout.** The `moov` box is written before the media data, so the file can start playing before it is fully downloaded.

## How it works

Conversion runs in two passes.

1. **Scan.** The EBML structure is walked (headers only, not payloads) to build an index of every block: its file offset, size, timestamp and keyframe flag. Nothing else is kept in memory.
2. **Plan and stream.** Per-track timing is computed, then `ftyp` and `moov` are written first, followed by the `mdat` box. Sample payloads are copied in slices of at most 1 MiB, in interleaved chunks.

Timing details:

- **B-frames:** decode timestamps (`dts`) come from the sample order, composition offsets (`ctts`) carry the reordering, and an edit list keeps presentation times aligned with the source.
- **AAC:** frame durations are fixed (1024 samples, or 960 with `frameLengthFlag`, doubled for SBR), so timestamp jitter is normalised.
- **Opus:** the end trim comes from positive `DiscardPadding` on the last block only. Pre-skip is stored in `dOps` and is not applied twice.
- **Origin:** all tracks share one origin shift, so the earliest frame starts at zero and late-starting tracks keep their relative offset through an empty edit.
- **Interleaving:** samples are grouped into chunks of up to 500 ms of media (and at most 512 samples), alternating between tracks by decode time.

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
│   ├── convert.rs             convert() orchestration and progress
│   └── wasm.rs                wasm-bindgen export (wasm32 only)
├── tests/
│   ├── common/mod.rs          test-only MKV builder and MP4 parser
│   ├── scan.rs, plan_timing.rs, mp4_writer.rs, remux.rs
├── web/                       static site source (index.html, main.js, worker.js, style.css)
├── scripts/
│   ├── build.sh               builds dist/ (and dist-node/ with --node)
│   └── node-smoke.mjs         Node.js smoke converter (development only)
└── .github/workflows/pages.yml  CI: test, lint, build, deploy to GitHub Pages
```

`dist/` and `dist-node/` are build outputs and are not committed.

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

### Commands

```sh
cargo test                          # unit and integration tests (native)
cargo clippy --lib -- -D warnings   # library lint gate
bash scripts/build.sh               # builds dist/ (static site + wasm)
python3 -m http.server -d dist 8080 # then open http://localhost:8080
```

Serve `dist/` over HTTP. Opening `index.html` as a `file://` URL will not work, because module workers and `.wasm` files are blocked there.

Optional Node.js smoke test (no browser needed):

```sh
bash scripts/build.sh --node
node scripts/node-smoke.mjs in.mkv out.mp4
```

## Deploying to GitHub Pages

The Pages artifact is built by the workflow in `.github/workflows/pages.yml`. No wasm binary or generated file is committed to the repository.

1. Create a new repository on GitHub, for example `mkv2mp4`.
2. Push this code to its `main` branch (or `master`):
   ```sh
   git remote add origin git@github.com:<your-user>/<repo>.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Open the **Actions** tab and wait for "Deploy to GitHub Pages" to finish (the `build` job, then `deploy`). You can also start it manually with **Run workflow**.
5. The site is then live at `https://<your-user>.github.io/<repo>/`. The URL is also shown on the workflow run's `deploy` job.

## Troubleshooting

- **`wasm-bindgen CLI is X but Cargo.toml pins Y`** (from `scripts/build.sh`): the installed CLI does not match the crate. Reinstall it at the pinned version: `cargo install wasm-bindgen-cli --version Y --locked`.
- **`wasm-bindgen CLI not found`**: `~/.cargo/bin` is not on your `PATH`, or the CLI was never installed. See Prerequisites.
- **The page says the browser lacks a required feature**: use a current Chrome, Edge, Firefox or Safari. Very old browsers do not provide Web Workers, WebAssembly or the File API in the form this app needs.
- **"no supported tracks"**: the file has no video or audio track in one of the supported codecs (see the table above). Transcode it with ffmpeg first.
- **"output would exceed the in-memory limit"**: the browser has no OPFS, and the output is larger than 1.5 GiB. Use a browser with OPFS support.

## License

MIT. See [LICENSE](LICENSE).
