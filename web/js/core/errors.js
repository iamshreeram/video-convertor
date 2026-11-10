/**
 * Maps engine error/warning messages to plain-language text (DESIGN.md B3.4).
 * The original message is always kept in `details`. Pure; no DOM access.
 */

const DEFAULT_TITLE = "Conversion failed";
const DEFAULT_HINT =
  "Something went wrong while converting this file. Try another file, or reload the page and try again.";

/** Ordered rules: first matching prefix wins. */
const RULES = [
  {
    // Valid MKV header but no readable media (zeros/garbage where data should be).
    prefix: "invalid Matroska file",
    contains: "no media data could be found",
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
    title: "This doesn\u2019t look like an MKV or WebM file",
    hint: "Choose an MKV or WebM file. Files renamed from another format will not convert.",
  },
  {
    prefix: "unsupported: no supported track",
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
    title: "This file is too large to process",
    hint: "This file exceeds the size or sample limit this converter can handle in the browser.",
  },
  {
    prefix: "output error",
    title: "Couldn\u2019t save the converted file",
    hint: "Check that the browser has free storage space, then try again.",
  },
  {
    prefix: "memory budget exceeded",
    title: "Not enough memory to hold this file",
    hint: "Download or remove finished files first, then try again.",
  },
  {
    prefix: "I/O error",
    title: "Couldn\u2019t read the file",
    hint: "The file could not be read. Check that it still exists and is not being changed, then try again.",
  },
];

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
 * @returns {{title: string, hint: string, details: string}}
 */
export function describeError(messageOrError) {
  const details = messageText(messageOrError);
  for (const rule of RULES) {
    if (details.startsWith(rule.prefix) && (!rule.contains || details.includes(rule.contains))) {
      const hint = rule.hintFor ? rule.hintFor(details) : rule.hint;
      return { title: rule.title, hint, details };
    }
  }
  return { title: DEFAULT_TITLE, hint: DEFAULT_HINT, details };
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
