// Dev-only smoke test for the wasm converter under Node.js.
// Usage: node scripts/node-smoke.mjs <in.mkv> <out.mp4> [--max-output=<bytes>] [--verbose]
// Requires `bash scripts/build.sh --node` first (loads dist-node/mkv2mp4.js).

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const wasmModulePath = path.join(here, "..", "dist-node", "mkv2mp4.js");

function parseArgs(argv) {
  const positional = [];
  let maxOutput = -1;
  let verbose = false;
  for (const arg of argv) {
    if (arg.startsWith("--max-output=")) {
      maxOutput = Number(arg.slice("--max-output=".length));
      if (!Number.isFinite(maxOutput)) {
        throw new Error(`invalid --max-output value: ${arg}`);
      }
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    throw new Error("usage: node scripts/node-smoke.mjs <in.mkv> <out.mp4> [--max-output=<bytes>] [--verbose]");
  }
  return { inPath: positional[0], outPath: positional[1], maxOutput, verbose };
}

// Reads exactly `length` bytes at `offset`, looping over short reads.
function makeReader(fd) {
  return (offset, length) => {
    const buf = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, offset + got);
      if (n === 0) {
        throw new Error(`unexpected end of input at offset ${offset + got}`);
      }
      got += n;
    }
    return buf;
  };
}

// Writes the whole chunk, looping over partial writes.
function makeWriter(fd) {
  return (chunk) => {
    let off = 0;
    while (off < chunk.length) {
      off += fs.writeSync(fd, chunk, off, chunk.length - off);
    }
  };
}

function main() {
  const { inPath, outPath, maxOutput, verbose } = parseArgs(process.argv.slice(2));
  const { convert_mkv_to_mp4 } = require(wasmModulePath);

  const inFd = fs.openSync(inPath, "r");
  let outFd = null;
  try {
    const size = fs.fstatSync(inFd).size;
    outFd = fs.openSync(outPath, "w");
    const progress = (fraction) => {
      if (verbose) {
        process.stderr.write(`progress ${(fraction * 100).toFixed(1)}%\n`);
      }
    };
    const summaryJson = convert_mkv_to_mp4(
      size,
      maxOutput,
      makeReader(inFd),
      makeWriter(outFd),
      progress,
    );
    process.stdout.write(`${JSON.stringify(JSON.parse(summaryJson), null, 2)}\n`);
  } finally {
    if (outFd !== null) {
      fs.closeSync(outFd);
    }
    fs.closeSync(inFd);
  }
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
