/**
 * Maps engine error/warning messages to plain-language text (DESIGN.md B3.4).
 * The original message is always kept in `details`; `code` is a stable identifier support can
 * ask for. Pure; no DOM access.
 */

import { formatBytes } from "./format.js";

const DEFAULT_TITLE = "Conversion failed";
const DEFAULT_CODE = "UNKNOWN";
const DEFAULT_HINT =
  "Something went wrong while converting this file. Try another file, or reload the page and try again.";

/** Ordered rules: first matching prefix wins. */
const RULES = [
  {
    // Valid MKV header but no readable media (zeros/garbage where data should be).
    prefix: "invalid Matroska file",
    contains: "no media data could be found",
    code: "MKV_DAMAGED",
    title: "This MKV file looks damaged",
    hint: "",
    hintFor: (details) => {
      const at = /at offset (\d+)/.exec(details);
      const where = at ? ` (unreadable data starts at offset ${at[1]})` : "";
      return (
        "The file has an MKV header but its video data could not be read" +
        where +
        ". If it was downloaded or recorded, it may be incomplete or corrupted; try downloading it again."
      );
    },
  },
  {
    prefix: "invalid Matroska file",
    code: "NOT_MKV",
    title: "This doesn\u2019t look like an MKV or WebM file",
    hint: "Choose an MKV or WebM file. Files renamed from another format will not convert.",
  },
  {
    prefix: "unsupported: no supported track",
    code: "NO_SUPPORTED_TRACK",
    title: "No supported video or audio found",
    hint: "",
    hintFor: (details) => {
      const list = details.slice("unsupported: no supported track".length).replace(/^:\s*/, "");
      const found = list ? ` Tracks found: ${list}.` : "";
      return (
        "This file has no track this converter can copy into MP4 (H.264, H.265/HEVC, AV1 video; " +
        "AAC, MP3, Opus, FLAC, AC-3 audio)." +
        found
      );
    },
  },
  {
    prefix: "too large",
    code: "TOO_LARGE",
    title: "This file is too large to process",
    hint: "This file exceeds the size or sample limit this converter can handle in the browser.",
  },
  {
    // Output storage is (or ran) full. Messages come from the worker (diagnostics.js).
    prefix: "storage full",
    contains: "needs ",
    code: "STORAGE_FULL",
    title: "Not enough storage space for the converted file",
    hint: "",
    hintFor: (details) => {
      const m = /needs (\d+) bytes but only (\d+) bytes/.exec(details);
      const need = m ? formatBytes(Number(m[1])) : "the converted file";
      const have = m ? ` but only ${formatBytes(Number(m[2]))} is available` : "";
      return (
        `The converted file needs about ${need} of free space in the browser\u2019s storage${have}. ` +
        "Free up disk space on the drive that holds your browser profile (usually C: on Windows), " +
        "or close private/incognito windows, then try again. Saving the result to your Downloads " +
        "folder needs the same amount of space again."
      );
    },
  },
  {
    prefix: "storage full",
    code: "STORAGE_FULL",
    title: "The disk ran out of space while saving",
    hint: "",
    hintFor: (details) => {
      const m = /after (\d+)(?: of (\d+))? bytes/.exec(details);
      const done = m ? formatBytes(Number(m[1])) : "part";
      const total = m && m[2] ? ` of ${formatBytes(Number(m[2]))}` : "";
      return (
        `Saving stopped after ${done}${total} because the disk or the browser\u2019s storage limit was ` +
        "reached. Free up disk space (the converted file needs room in the browser\u2019s storage and " +
        "again in your Downloads folder), then try again."
      );
    },
  },
  {
    // The browser answered a write with a value that is not a byte count. Its meaning is not
    // documented, so the text names no cause.
    prefix: "output rejected",
    code: "OUTPUT_REJECTED",
    title: "The browser refused to save the converted file",
    hint: "",
    hintFor: (details) => {
      const m = /after (\d+)(?: of (\d+))? bytes/.exec(details);
      const done = m ? formatBytes(Number(m[1])) : "part";
      const total = m && m[2] ? ` of ${formatBytes(Number(m[2]))}` : "";
      return (
        `The browser stopped accepting data after ${done}${total} and did not say why, so the cause is ` +
        "not known. Its private storage may be failing on this computer. In Chrome or Edge you can " +
        "choose where to save the converted file instead, which avoids that storage. Otherwise close " +
        "other tabs or restart the browser, make sure security software is not scanning the " +
        "browser\u2019s profile folder, and try again."
      );
    },
  },
  {
    prefix: "save denied",
    code: "SAVE_DENIED",
    title: "Saving to that file wasn\u2019t allowed",
    hint:
      "The browser did not allow writing to the file you chose. Choose the location again and allow " +
      "access if asked, or pick another folder (system folders such as Windows or Program Files are " +
      "not allowed).",
  },
  {
    prefix: "save error",
    code: "SAVE_FAILED",
    title: "Couldn\u2019t write to the file you chose",
    hint:
      "The browser could not write to that file. Check that it is not open in another program, that " +
      "the drive has free space and that you may write to that folder, then choose the location again.",
  },
  {
    prefix: "output error",
    code: "OUTPUT_ERROR",
    title: "Couldn\u2019t save the converted file",
    hint: "Check that the browser has free storage space, then try again.",
  },
  {
    prefix: "I/O error: read failed at offset",
    code: "READ_FAILED",
    title: "Couldn\u2019t read the file",
    hint: "",
    hintFor: (details) => {
      const at = /offset (\d+)/.exec(details);
      const where = at ? ` at byte ${at[1]}` : "";
      return (
        `The browser stopped being able to read the file${where}. The file may have been moved, ` +
        "renamed or changed during conversion, or it is on a network or removable drive that " +
        "disconnected. Copy the file to a local disk and try again."
      );
    },
  },
  {
    prefix: "The conversion worker stopped",
    code: "WORKER_STOPPED",
    title: "The converter stopped unexpectedly",
    hint:
      "This usually means the browser ran out of memory. Close other tabs and applications and try " +
      "again. If it keeps happening, copy the diagnostics and report them.",
  },
  {
    prefix: "memory budget exceeded",
    code: "MEMORY_BUDGET",
    title: "Not enough memory to hold this file",
    hint: "Download or remove finished files first, then try again.",
  },
  {
    prefix: "I/O error",
    code: "READ_FAILED",
    title: "Couldn\u2019t read the file",
    hint: "The file could not be read. Check that it still exists and is not being changed, then try again.",
  },
];

/** Failures that writing straight to a file the user chooses can get around. */
const SAVE_TO_FILE_CODES = new Set([
  "STORAGE_FULL",
  "OUTPUT_REJECTED",
  "OUTPUT_ERROR",
  "MEMORY_BUDGET",
  "SAVE_DENIED",
  "SAVE_FAILED",
]);

/**
 * @param {unknown} code an error code from describeError
 * @returns {boolean} whether choosing a file to save to is a sensible next step
 */
export function offersSaveToFile(code) {
  return typeof code === "string" && SAVE_TO_FILE_CODES.has(code);
}

/**
 * Extracts the original message text from a string, an Error-like object or
 * anything else (which yields '').
 * @param {unknown} messageOrError
 * @returns {string}
 */
function messageText(messageOrError) {
  if (typeof messageOrError === "string") return messageOrError;
  if (messageOrError && typeof messageOrError.message === "string") return messageOrError.message;
  return "";
}

/**
 * Describes an engine error for display.
 * @param {string|Error|unknown} messageOrError
 * @returns {{title: string, hint: string, details: string, code: string}}
 */
export function describeError(messageOrError) {
  const details = messageText(messageOrError);
  for (const rule of RULES) {
    if (details.startsWith(rule.prefix) && (!rule.contains || details.includes(rule.contains))) {
      const hint = rule.hintFor ? rule.hintFor(details) : rule.hint;
      return { title: rule.title, hint, details, code: rule.code ?? DEFAULT_CODE };
    }
  }
  return { title: DEFAULT_TITLE, hint: DEFAULT_HINT, details, code: DEFAULT_CODE };
}

/**
 * Rewrites known engine warnings into plain sentences; others pass through.
 * @param {string} text
 * @returns {string}
 */
export function describeWarning(text) {
  if (typeof text !== "string") return "";
  const skipped = /^track (\d+) \((.*?)\) skipped: (.*)$/.exec(text);
  if (skipped) return `Skipped track ${skipped[1]} (${skipped[2]}): ${skipped[3]}`;
  const skippedData = /^skipped (\d+) bytes of unreadable data/.exec(text);
  if (skippedData) {
    return (
      `Damaged parts of the file were skipped (${skippedData[1]} bytes). ` +
      "The rest was converted; there may be a short glitch where data was missing."
    );
  }
  const ignoredTail = /^ignored (\d+) bytes of unreadable data at the end/.exec(text);
  if (ignoredTail) {
    return (
      `The end of the file was unreadable (${ignoredTail[1]} bytes) and was ignored. ` +
      "This usually means an unfinished download or recording; everything readable was converted."
    );
  }
  if (text.startsWith("file appears truncated")) {
    return "The file looks cut off; the readable part was converted.";
  }
  return text;
}
