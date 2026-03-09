import type { NormalizedEvent } from './types.js';

interface Waiter {
  afterSeq: number;
  limit: number;
  timer: NodeJS.Timeout;
  resolve: (events: NormalizedEvent[]) => void;
}

export class EventBuffer {
  private readonly events: NormalizedEvent[] = [];
  private readonly waiters = new Set<Waiter>();

  append(event: NormalizedEvent): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      const available = this.getAfter(waiter.afterSeq, waiter.limit);
      if (available.length > 0) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(available);
      }
    }
  }

  getAfter(afterSeq: number, limit: number): NormalizedEvent[] {
    return this.events.filter((event) => event.seq > afterSeq).slice(0, limit);
  }

  waitForAfter(afterSeq: number, limit: number, waitMs: number): Promise<NormalizedEvent[]> {
    const immediate = this.getAfter(afterSeq, limit);
    if (immediate.length > 0 || waitMs === 0) {
      return Promise.resolve(immediate);
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        afterSeq,
        limit,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(this.getAfter(afterSeq, limit));
        }, waitMs),
        resolve,
      };
      this.waiters.add(waiter);
    });
  }
}
