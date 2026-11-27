/**
 * Runs async tasks strictly one after another, in the order they were
 * added. A failed task rejects its own promise but doesn't stop the queue.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}
