/**
 * One job card per file (DESIGN.md B3.2). update(job) re-renders only what
 * changed, keeps the preview <video> and open <details> alive across updates,
 * tolerates partial jobs and announces nothing (the controller does that).
 */

import { h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { formatBytes, formatDuration, formatEta, formatSpeed } from "../core/format.js";
import { describeError, describeWarning } from "../core/errors.js";

/** Display metadata per visible state. */
const STATE_INFO = {
  queued: { label: "Queued", tone: "neutral", iconName: "clock", stage: "Waiting in the queue", progressLabel: "Waiting" },
  analyzing: {
    label: "Analyzing",
    tone: "info",
    iconName: "layers",
    stage: "Reading the file structure\u2026",
    progressLabel: "Analyzing",
  },
  converting: {
    label: "Converting",
    tone: "info",
    iconName: "play",
    stage: "Converting video and audio\u2026",
    progressLabel: "Converting",
  },
  finalizing: {
    label: "Finalizing",
    tone: "info",
    iconName: "layers",
    stage: "Finalizing the file\u2026",
    progressLabel: "Converting",
  },
  done: { label: "Done", tone: "success", iconName: "check", stage: "Finished", progressLabel: "Converting" },
  error: { label: "Failed", tone: "danger", iconName: "alert", stage: "Stopped with an error", progressLabel: "Converting" },
  cancelled: { label: "Cancelled", tone: "muted", iconName: "x", stage: "Cancelled", progressLabel: "Converting" },
};

const CODEC_LABELS = {
  h264: "H.264",
  hevc: "H.265 (HEVC)",
  av1: "AV1",
  aac: "AAC",
  mp3: "MP3",
  opus: "Opus",
  flac: "FLAC",
  ac3: "AC-3",
};

const CHANNEL_LABELS = { 1: "Mono", 2: "Stereo" };

/** @param {unknown} v @returns {boolean} */
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** @param {string} name @returns {string} name without its extension */
function stem(name) {
  return String(name).replace(/\.[^.]+$/, "") || String(name);
}

/** @param {string} tone chip colour family */
function chipClass(tone) {
  return `chip chip--${tone}`;
}

/**
 * Human label for one analysed track, e.g. "H.264 · 1920×1080" or
 * "AAC · Stereo · 48 kHz · eng". Returns null for unknown kinds.
 * @param {object} track
 * @returns {{kind: 'video'|'audio', text: string}|null}
 */
function trackLabel(track) {
  if (!track || typeof track !== "object") return null;
  const kind = track.kind === "audio" ? "audio" : track.kind === "video" ? "video" : null;
  if (!kind) return null;
  const codec = typeof track.codec === "string" ? track.codec : "";
  const parts = [CODEC_LABELS[codec] || codec.toUpperCase() || "Unknown codec"];
  if (kind === "video") {
    if (isNum(track.width) && isNum(track.height) && track.width > 0 && track.height > 0) {
      parts.push(`${track.width}\u00d7${track.height}`);
    }
  } else {
    if (isNum(track.channels) && track.channels > 0) {
      parts.push(CHANNEL_LABELS[track.channels] || `${track.channels} ch`);
    }
    if (isNum(track.sampleRate) && track.sampleRate > 0) {
      parts.push(`${Number((track.sampleRate / 1000).toFixed(1))} kHz`);
    }
    if (typeof track.language === "string" && track.language && track.language !== "und") {
      parts.push(track.language);
    }
  }
  return { kind, text: parts.join(" \u00b7 ") };
}

/**
 * Puts `parent`'s children into exactly `wanted` order, moving only nodes that
 * are out of place (moving a <video> would interrupt it).
 * @param {Element} parent
 * @param {Node[]} wanted
 */
function syncChildren(parent, wanted) {
  for (const child of Array.from(parent.childNodes)) {
    if (!wanted.includes(child)) child.remove();
  }
  let previous = null;
  for (const node of wanted) {
    const expected = previous ? previous.nextSibling : parent.firstChild;
    if (node !== expected) parent.insertBefore(node, expected);
    previous = node;
  }
}

/** @param {Element} el @param {string} text sets textContent only when different */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** @param {Element} el @param {string} name @param {string|null} value */
function setAttr(el, name, value) {
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

/** @param {Element} el @param {boolean} hidden */
function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}

/** Refuses javascript: and other non-navigational schemes. */
function safeUrl(url) {
  return typeof url === "string" && url && !/^\s*javascript:/i.test(url) ? url : null;
}

/**
 * @param {object} job
 * @param {{onCancel?: (id: string) => void, onRemove?: (id: string) => void}} handlers
 * @returns {{el: HTMLElement, update: (job: object) => void, focusPrimary: () => void, destroy: () => void}}
 */
export function createJobCard(job, { onCancel, onRemove } = {}) {
  let currentId = job && job.id !== undefined ? String(job.id) : "";
  let base = "queued";
  let previewOpen = false;
  let previewUrl = null;
  let previewVideo = null;
  let previewToggle = null;
  let previewLabel = null;
  let actionsKey = "";
  let chipKey = "";
  let trackSig = "";
  let warnSig = "";
  let errorKey = "";
  let lastUrl = "";
  let currentName = "";

  // ---- static skeleton --------------------------------------------------
  const nameEl = h("span", { class: "job__name", dataset: { testid: "job-name" } });
  const sizeEl = h("span", { class: "job__size", dataset: { testid: "job-size" } });
  const chip = h("span", { class: "chip chip--neutral", dataset: { testid: "job-state" } });
  const stageEl = h("p", { class: "job__stage", dataset: { testid: "job-stage" } });

  const barEl = h("div", { class: "progress__bar" });
  const progressEl = h(
    "div",
    {
      class: "progress",
      dataset: { testid: "job-progress" },
      attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" },
    },
    barEl,
  );

  const percentEl = h("span", { class: "meter meter--strong", dataset: { testid: "job-percent" } });
  const speedEl = h("span", { class: "meter", dataset: { testid: "job-speed" } });
  const etaEl = h("span", { class: "meter", dataset: { testid: "job-eta" } });
  const elapsedEl = h("span", { class: "meter", dataset: { testid: "job-elapsed" } });
  const metersEl = h("div", { class: "job__meters" }, percentEl, speedEl, etaEl, elapsedEl);

  const tracksEl = h("div", { class: "job__tracks" });
  const durationEl = h("span", { class: "job__fact", dataset: { testid: "job-duration" } });
  const outputEl = h("span", { class: "job__fact", dataset: { testid: "job-output-size" } });
  const metaEl = h("div", { class: "job__meta" }, tracksEl, durationEl, outputEl);

  // Warnings: collapsible, open state survives updates because the element persists.
  const warnSummary = h("summary", {});
  const warnList = h("ul", { class: "job__warn-list" });
  const warningsEl = h(
    "details",
    { class: "job__warnings", dataset: { testid: "job-warnings" } },
    warnSummary,
    warnList,
  );

  // Error panel: friendly text plus collapsible technical details.
  const errorTitle = h("p", { class: "job__error-title" });
  const errorHint = h("p", { class: "job__error-hint" });
  const errorRaw = h("code", {});
  const errorDetails = h(
    "details",
    { class: "job__error-details", dataset: { testid: "job-error-details" } },
    h("summary", {}, "Technical details"),
    errorRaw,
  );
  const errorEl = h(
    "div",
    { class: "job__error", dataset: { testid: "job-error" } },
    errorTitle,
    errorHint,
    errorDetails,
  );

  // Preview: the <video> exists only while the preview is open.
  const previewWrap = h("div", { class: "job__preview" });

  const extrasEl = h("div", { class: "job__extras" });
  const actionsEl = h("div", { class: "job__actions" });

  const el = h(
    "article",
    { class: "job", attrs: { role: "listitem" }, dataset: { testid: "job" } },
    h(
      "header",
      { class: "job__head" },
      h("span", { class: "job__icon", attrs: { "aria-hidden": "true" } }, icon("file", { size: 20 })),
      h("div", { class: "job__title" }, nameEl, sizeEl),
      chip,
    ),
    stageEl,
    progressEl,
    metersEl,
    metaEl,
    extrasEl,
    actionsEl,
  );

  // ---- preview ----------------------------------------------------------
  function closePreview() {
    if (previewVideo) {
      previewVideo.pause();
      previewVideo.removeAttribute("src");
      previewVideo.load();
      previewVideo.remove();
      previewVideo = null;
    }
    previewOpen = false;
    previewUrl = null;
  }

  /** @param {string} url */
  function openPreview(url) {
    previewVideo = h("video", {
      dataset: { testid: "job-preview" },
      attrs: { controls: true, preload: "metadata", src: url },
    });
    previewWrap.append(previewVideo);
    previewOpen = true;
    previewUrl = url;
  }

  function syncPreviewToggle() {
    if (!previewToggle || !previewLabel) return;
    // The accessible name carries the file name; the visible text stays "Preview"/"Hide preview".
    setText(previewLabel, previewOpen ? "Hide preview" : "Preview");
    setAttr(
      previewToggle,
      "aria-label",
      previewOpen ? `Hide preview of ${currentName}` : `Preview ${currentName}`,
    );
    setAttr(previewToggle, "aria-expanded", previewOpen ? "true" : "false");
  }

  function togglePreview() {
    if (previewOpen) {
      closePreview();
    } else if (base === "done" && lastUrl) {
      openPreview(lastUrl);
    }
    syncPreviewToggle();
    syncExtras();
  }

  // ---- actions ----------------------------------------------------------
  /**
   * Rebuilds the action row only when state, name or URL change.
   * @param {string} name
   * @param {string|null} url
   */
  function renderActions(name, url) {
    const key = `${base}|${name}|${url || ""}`;
    if (key === actionsKey) return;
    actionsKey = key;
    previewToggle = null;
    previewLabel = null;
    const buttons = [];

    if (base === "done" && url) {
      const outName = `${stem(name)}.mp4`;
      buttons.push(
        h(
          "a",
          {
            class: "btn btn--primary btn--sm",
            dataset: { testid: "job-download" },
            attrs: { href: url, download: `${outName}`, "aria-label": `Download ${outName}` },
          },
          icon("download", { size: 16 }),
          "Download",
        ),
      );
    }
    if (base === "done") {
      previewLabel = h("span", {}, previewOpen ? "Hide preview" : "Preview");
      previewToggle = h(
        "button",
        {
          class: "btn btn--secondary btn--sm",
          dataset: { testid: "job-preview-toggle" },
          attrs: { type: "button", "aria-expanded": previewOpen ? "true" : "false" },
          on: { click: togglePreview },
        },
        icon("play", { size: 16 }),
        previewLabel,
      );
      buttons.push(previewToggle);
    }
    if (base === "queued" || base === "analyzing" || base === "converting") {
      buttons.push(
        h(
          "button",
          {
            class: "btn btn--secondary btn--sm",
            dataset: { testid: "job-cancel" },
            attrs: { type: "button", "aria-label": `Cancel conversion of ${name}` },
            on: {
              click: () => {
                if (typeof onCancel === "function") onCancel(currentId);
              },
            },
          },
          icon("x", { size: 16 }),
          "Cancel",
        ),
      );
    } else {
      buttons.push(
        h(
          "button",
          {
            class: "btn btn--ghost btn--sm",
            dataset: { testid: "job-remove" },
            attrs: { type: "button", "aria-label": `Remove ${name} from the list` },
            on: {
              click: () => {
                if (typeof onRemove === "function") onRemove(currentId);
              },
            },
          },
          icon("trash", { size: 16 }),
          "Remove",
        ),
      );
    }
    actionsEl.replaceChildren(...buttons);
  }

  // ---- extras (warnings, error, preview) ---------------------------------
  function syncExtras() {
    const wanted = [];
    if (warnList.childElementCount > 0) wanted.push(warningsEl);
    if (base === "error") wanted.push(errorEl);
    if (previewOpen) wanted.push(previewWrap);
    syncChildren(extrasEl, wanted);
  }

  /**
   * Updates the progress bar, percent, speed, ETA and elapsed readouts.
   * @param {object} job
   */
  function renderProgress(job) {
    const hideBar = base === "error" || base === "cancelled";
    setHidden(progressEl, hideBar);

    let fraction = null;
    if (base === "done") fraction = 1;
    else if (base === "converting" && isNum(job.progress)) {
      fraction = Math.min(1, Math.max(0, job.progress));
    }

    const info = STATE_INFO[displayState(job)];
    const label = `${info.progressLabel} ${currentName}`;
    setAttr(progressEl, "aria-label", label);

    if (fraction === null) {
      progressEl.classList.add("is-indeterminate");
      progressEl.removeAttribute("aria-valuenow");
      if (barEl.style.getPropertyValue("--p")) barEl.style.removeProperty("--p");
    } else {
      progressEl.classList.remove("is-indeterminate");
      setAttr(progressEl, "aria-valuenow", String(Math.round(fraction * 100)));
      barEl.style.setProperty("--p", String(fraction));
    }

    if (fraction !== null && !hideBar) {
      setHidden(percentEl, false);
      setText(percentEl, `${Math.round(fraction * 100)}%`);
    } else {
      setHidden(percentEl, true);
    }

    const converting = base === "converting";
    if (converting && isNum(job.speed) && job.speed >= 0) {
      setHidden(speedEl, false);
      setText(speedEl, formatSpeed(job.speed));
    } else {
      setHidden(speedEl, true);
    }
    if (converting && isNum(job.eta) && job.eta >= 0) {
      setHidden(etaEl, false);
      setText(etaEl, `ETA ${formatEta(job.eta)}`);
    } else {
      setHidden(etaEl, true);
    }
    if (isNum(job.elapsedMs) && job.elapsedMs >= 0 && base !== "queued") {
      setHidden(elapsedEl, false);
      setText(elapsedEl, `Elapsed ${formatDuration(job.elapsedMs)}`);
    } else {
      setHidden(elapsedEl, true);
    }
    setHidden(metersEl, percentEl.hidden && speedEl.hidden && etaEl.hidden && elapsedEl.hidden);
  }

  /** @param {object} job @returns {string} display state (finalizing is a converting sub-stage) */
  function displayState(job) {
    if (base === "converting" && job.stage === "finalizing") return "finalizing";
    return base;
  }

  /**
   * Re-renders the card for a job snapshot.
   * @param {object} next
   */
  function update(next) {
    const job = next && typeof next === "object" ? next : {};
    if (job.id !== undefined && job.id !== null) currentId = String(job.id);

    const file = job.file && typeof job.file === "object" ? job.file : {};
    const name = typeof file.name === "string" && file.name ? file.name : "Untitled file";
    currentName = name;
    base = Object.prototype.hasOwnProperty.call(STATE_INFO, job.state) ? job.state : "queued";
    const shown = displayState(job);
    const info = STATE_INFO[shown];
    const analysis = job.analysis && typeof job.analysis === "object" ? job.analysis : null;
    const result = job.result && typeof job.result === "object" ? job.result : null;
    const url = result ? safeUrl(result.url) : null;

    setAttr(el, "data-state", base);
    setAttr(el, "data-name", name);

    setText(nameEl, name);
    setAttr(nameEl, "title", name);
    setText(sizeEl, isNum(file.size) ? formatBytes(file.size) : "\u2014");

    const chipSig = shown;
    if (chipKey !== chipSig) {
      chipKey = chipSig;
      chip.className = chipClass(info.tone);
      chip.replaceChildren(icon(info.iconName, { size: 14 }), document.createTextNode(info.label));
    }
    setText(stageEl, info.stage);

    // Preview is only valid for the same finished file.
    if (previewOpen && (base !== "done" || url !== previewUrl)) closePreview();
    lastUrl = url || "";

    renderProgress(job);

    // Analysis facts: tracks, duration, output estimate.
    const tracks = analysis && Array.isArray(analysis.tracks) ? analysis.tracks : [];
    let sig = "";
    try {
      sig = JSON.stringify(tracks);
    } catch {
      sig = "";
    }
    if (sig !== trackSig) {
      trackSig = sig;
      const chips = [];
      for (const track of tracks) {
        const label = trackLabel(track);
        if (!label) continue;
        chips.push(
          h(
            "span",
            { class: `chip chip--track chip--${label.kind}`, dataset: { testid: "job-track", kind: label.kind } },
            icon(label.kind === "audio" ? "audio" : "video", { size: 14 }),
            label.text,
          ),
        );
      }
      tracksEl.replaceChildren(...chips);
      setHidden(tracksEl, chips.length === 0);
    }

    const hasDuration = analysis && isNum(analysis.durationMs) && analysis.durationMs >= 0;
    setHidden(durationEl, !hasDuration);
    if (hasDuration) setText(durationEl, `Duration ${formatDuration(analysis.durationMs)}`);

    if (base === "done" && result && isNum(result.size)) {
      setHidden(outputEl, false);
      setText(outputEl, formatBytes(result.size));
    } else if (base !== "done" && analysis && isNum(analysis.outputSize) && base !== "cancelled") {
      setHidden(outputEl, false);
      setText(outputEl, `\u2248 ${formatBytes(analysis.outputSize)} output`);
    } else {
      setHidden(outputEl, true);
    }
    setHidden(metaEl, tracksEl.hidden && durationEl.hidden && outputEl.hidden);

    // Warnings (collapsed by default; only the list items are rebuilt on change).
    const warnings = analysis && Array.isArray(analysis.warnings)
      ? analysis.warnings.filter((w) => typeof w === "string")
      : [];
    const wSig = warnings.join("\u0000");
    if (wSig !== warnSig) {
      warnSig = wSig;
      warnList.replaceChildren(...warnings.map((w) => h("li", {}, describeWarning(w))));
      const n = warnings.length;
      setText(warnSummary, n === 1 ? "1 notice" : `${n} notices`);
    }

    // Error panel.
    if (base === "error") {
      const described = describeError(job.error);
      const key = `${described.title}|${described.hint}|${described.details}`;
      if (key !== errorKey) {
        errorKey = key;
        setText(errorTitle, described.title);
        setText(errorHint, described.hint);
        setText(errorRaw, described.details);
        setHidden(errorDetails, !described.details);
      }
    }

    renderActions(name, url);
    syncPreviewToggle();
    syncExtras();
  }

  /** Moves focus to the most relevant action: Download, Cancel or Remove. */
  function focusPrimary() {
    const order = base === "done" ? ["job-download", "job-remove"]
      : base === "queued" || base === "analyzing" || base === "converting" ? ["job-cancel"]
        : ["job-remove"];
    for (const testid of order) {
      const target = actionsEl.querySelector(`[data-testid="${testid}"]`);
      if (target && typeof target.focus === "function") {
        target.focus();
        return;
      }
    }
    const first = actionsEl.querySelector("a[href], button:not([disabled])");
    if (first && typeof first.focus === "function") first.focus();
  }

  /** Releases the preview media and removes the card from the DOM. */
  function destroy() {
    closePreview();
    el.remove();
  }

  // Warnings, error and actions start empty; update() fills them in.
  update(job);

  return { el, update, focusPrimary, destroy };
}
