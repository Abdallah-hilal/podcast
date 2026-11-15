/**
 * A single-flight slot: while a run is in flight, every call returns that
 * run's promise instead of starting another. Once it settles, the next call
 * runs its function. Keep one slot per resource (e.g. in useState).
 */
export function createSingleFlight<T>(): (fn: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (fn) => {
    if (!inFlight) {
      inFlight = fn().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}
