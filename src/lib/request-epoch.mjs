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
