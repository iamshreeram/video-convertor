// Test-only module worker for T17 (worker confinement). NOT part of dist/.
// The e2e server serves it at /__test__/probe-worker.js. It posts {type:'ready'}
// (the factory handshake), then reports what the worker CSP lets through:
// a fetch and a WebSocket to example.com must both be refused.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const violations = [];
self.addEventListener("securitypolicyviolation", (event) => {
  violations.push(String(event.blockedURI));
});

self.postMessage({ type: "ready" });

async function probe() {
  // Give the page time to attach its message listener after the factory resolves.
  await sleep(300);

  const beforeFetch = violations.length;
  let fetchRejected = false;
  try {
    await fetch("https://example.com/");
  } catch {
    fetchRejected = true;
  }
  await sleep(200);
  const fetchViolations = violations.slice(beforeFetch);

  const beforeWs = violations.length;
  let wsErrored = false;
  let wsOpened = false;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    let socket = null;
    try {
      socket = new WebSocket("wss://example.com/");
    } catch {
      wsErrored = true;
      clearTimeout(timer);
      resolve();
      return;
    }
    socket.addEventListener("open", () => {
      wsOpened = true;
      socket.close();
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      wsErrored = true;
      clearTimeout(timer);
      resolve();
    });
  });
  await sleep(200);
  const wsViolations = violations.slice(beforeWs);

  self.postMessage({
    type: "probe-result",
    fetchRejected,
    fetchViolations,
    wsErrored,
    wsOpened,
    wsViolations,
    violations: violations.slice(),
  });
}

probe().catch((err) => {
  self.postMessage({ type: "probe-error", message: String((err && err.message) || err) });
});
