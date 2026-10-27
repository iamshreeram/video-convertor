/**
 * Session identity and the Web Lock readiness handshake (DESIGN.md Rev 5
 * "OPFS ownership", kept in Part B). The lock is held for the lifetime of the
 * tab; other tabs use it to tell live output files from orphans.
 */

/** @returns {string} random id: crypto.randomUUID, else 32 random hex digits */
function makeSessionId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Requests the session lock and resolves only once the lock callback has run
 * (the lock is granted). Resolves false when the Locks API is missing or the
 * request fails: conversion still works, only orphan sweeping is disabled.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function holdSessionLock(id) {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== "function") return false;
  try {
    await new Promise((ready, fail) => {
      locks
        .request(`mkv2mp4:${id}`, () => {
          ready();
          return new Promise(() => {});
        })
        .catch(fail);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the session. Never rejects.
 * @returns {Promise<{sessionId: string, sweep: boolean}>} sweep=true when the
 *   lock is held, which allows the worker to delete orphaned outputs.
 */
export async function acquireSession() {
  const sessionId = makeSessionId();
  const sweep = await holdSessionLock(sessionId);
  return { sessionId, sweep };
}
