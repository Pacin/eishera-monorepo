// The market's ordering guarantee (SPEC §10.1): every order passes through a
// single sequential FIFO queue, so they are processed one-at-a-time in arrival
// order — deterministic "first in, first processed", no concurrent matching
// races. It sits behind an interface so a multi-process build can swap in a
// Redis-based sequencer without touching the matching logic.

export interface MarketQueue {
  /** Run `task` after all previously-enqueued tasks have settled. FIFO. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

/** Single-process in-memory sequencer: a promise chain. */
export class SequentialQueue implements MarketQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    // The chain must not break on a failed task, so swallow rejections on `tail`.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** The process-wide market sequencer. */
export const marketQueue: MarketQueue = new SequentialQueue();
