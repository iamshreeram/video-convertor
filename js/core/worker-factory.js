/**
 * Starts the conversion worker FAIL-CLOSED (DESIGN.md B3.6).
 *
 * A worker loaded straight from a URL does not inherit the page CSP, so the
 * worker is started from a blob: bootstrap module that imports the real
 * script. The bootstrap inherits the document CSP. There is no fallback to a
 * URL-loaded worker: if the handshake fails, the worker is terminated and the
 * promise rejects.
 */

const START_FAILED =
  "Could not start the secure worker in this browser. Try a current Chrome, Edge, Firefox or Safari.";
const DEFAULT_READY_TIMEOUT_MS = 10000;

/**
 * @param {{scriptUrl?: URL|string, bootstrapSource?: string, readyTimeoutMs?: number}} [options]
 *   scriptUrl and bootstrapSource exist for tests only.
 * @returns {Promise<Worker>} resolves after the worker posted {type:'ready'}
 */
export function createConvertWorker({
  scriptUrl,
  bootstrapSource,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const absoluteUrl =
      scriptUrl !== undefined && scriptUrl !== null
        ? new URL(String(scriptUrl), document.baseURI).href
        : new URL("../../workers/convert.worker.js", import.meta.url).href;
    const source =
      typeof bootstrapSource === "string" ? bootstrapSource : `import ${JSON.stringify(absoluteUrl)};`;

    let blobUrl = null;
    let worker = null;
    let timer = null;
    let settled = false;

    /** Releases the blob URL and the temporary listeners; once only. */
    function cleanupHandshake() {
      clearTimeout(timer);
      if (worker) {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onFailure);
        worker.removeEventListener("messageerror", onFailure);
      }
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
    }

    /** @param {MessageEvent} event */
    function onMessage(event) {
      if (event.data && event.data.type === "ready") finish(true);
    }

    function onFailure() {
      finish(false);
    }

    /** @param {boolean} ok */
    function finish(ok) {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      if (ok) {
        resolve(worker);
      } else {
        if (worker) worker.terminate();
        worker = null;
        reject(new Error(START_FAILED));
      }
    }

    try {
      blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      worker = new Worker(blobUrl, { type: "module" });
    } catch {
      if (worker) worker.terminate();
      worker = null;
      settled = true;
      cleanupHandshake();
      reject(new Error(START_FAILED));
      return;
    }

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onFailure);
    worker.addEventListener("messageerror", onFailure);
    const limit = Number.isFinite(readyTimeoutMs) && readyTimeoutMs > 0 ? readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS;
    timer = setTimeout(() => finish(false), limit);
  });
}
