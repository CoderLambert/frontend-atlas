export function createRequestEpoch() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    invalidate() {
      current += 1;
    },
    isCurrent(epoch) {
      return current === epoch;
    },
  };
}

/** @typedef {{ epoch: number, phase: "preparing" | "streaming", controller: AbortController | null, buffer: string, timer: ReturnType<typeof setTimeout> | null }} RequestContext */

export function createRequestLifecycle() {
  let epoch = 0;
  /** @type {RequestContext | null} */
  let active = null;

  return {
    begin() {
      const previous = active;
      /** @type {RequestContext} */
      const request = { epoch: ++epoch, phase: "preparing", controller: null, buffer: "", timer: null };
      active = request;
      return { request, previous };
    },
    invalidate() {
      epoch += 1;
      const previous = active;
      active = null;
      return previous;
    },
    /** @param {RequestContext} request */
    isCurrent(request) {
      return active === request && request.epoch === epoch;
    },
    /** @param {RequestContext} request */
    finish(request) {
      if (active !== request || request.epoch !== epoch) return false;
      active = null;
      return true;
    },
  };
}

/**
 * @template T
 * @param {T} request
 * @param {(request: T) => boolean} isCurrent
 * @param {() => Promise<unknown>} prepare
 * @param {(request: T) => void} start
 * @returns {Promise<boolean>}
 */
export async function afterPreparation(request, isCurrent, prepare, start) {
  await prepare();
  if (!isCurrent(request)) return false;
  start(request);
  return true;
}

/** @param {RequestContext} request */
export function takeRequestBuffer(request) {
  if (request.timer !== null) clearTimeout(request.timer);
  request.timer = null;
  const pending = request.buffer;
  request.buffer = "";
  return pending;
}

/** @param {RequestContext} request */
export function discardRequestBuffer(request) {
  takeRequestBuffer(request);
}

/**
 * @param {RequestContext} request
 * @param {(request: RequestContext) => boolean} isCurrent
 * @param {(pending: string) => void} append
 */
export function flushRequestBuffer(request, isCurrent, append) {
  if (!isCurrent(request)) return false;
  const pending = takeRequestBuffer(request);
  if (pending) append(pending);
  return true;
}
