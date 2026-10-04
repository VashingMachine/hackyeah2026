/** Concurrent requests may read one configuration; a publication drains them before swapping it. */
export class PublicationGate {
  private readers = 0;
  private barrier: Promise<void> | undefined;
  private drained: (() => void) | undefined;
  private writers: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    while (this.barrier) await this.barrier;
    this.readers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.readers === 0) { this.drained?.(); this.drained = undefined; }
    };
  }

  async publish<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writers;
    let next!: () => void;
    this.writers = new Promise(resolve => { next = resolve; });
    await previous;
    let open!: () => void;
    this.barrier = new Promise(resolve => { open = resolve; });
    try {
      if (this.readers) await new Promise<void>(resolve => { this.drained = resolve; });
      return await fn();
    } finally {
      this.barrier = undefined;
      open(); next();
    }
  }
}
