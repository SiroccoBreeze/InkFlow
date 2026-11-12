import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncMutex, ConsistencyGate } from '../services/consistencyGate';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

describe('ConsistencyGate', () => {
  let gate: ConsistencyGate;

  beforeEach(() => {
    gate = new ConsistencyGate();
  });

  it('allows concurrent readers but never mixes a reader with a writer', async () => {
    let activeReaders = 0;
    let maxReaders = 0;
    let writerActive = false;
    let violations = 0;

    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      tasks.push(
        gate.withShared(async () => {
          if (writerActive) violations++;
          activeReaders++;
          maxReaders = Math.max(maxReaders, activeReaders);
          await delay(2);
          activeReaders--;
        })
      );
    }
    for (let i = 0; i < 10; i++) {
      tasks.push(
        gate.withExclusive(async () => {
          writerActive = true;
          if (activeReaders !== 0) violations++;
          await delay(2);
          writerActive = false;
        })
      );
    }

    await withTimeout(Promise.all(tasks), 5000, 'mixed readers/writers');
    expect(violations).toBe(0);
    expect(maxReaders).toBeGreaterThan(1);
    expect(gate.isIdle()).toBe(true);
  });

  it('grants a queued writer before readers that arrived later (FIFO, no writer starvation)', async () => {
    const order: string[] = [];

    const firstReader = gate.withShared(async () => {
      order.push('reader-0-start');
      await delay(20);
      order.push('reader-0-end');
    });
    await delay(1); // ensure reader-0 is already holding the lease

    const writer = gate.withExclusive(async () => {
      order.push('writer');
    });

    // These readers arrive after the writer and must not jump the queue.
    const lateReaders = Array.from({ length: 10 }, (_, i) =>
      gate.withShared(async () => {
        order.push(`reader-${i + 1}`);
        await delay(1);
      })
    );

    await withTimeout(Promise.all([firstReader, writer, ...lateReaders]), 5000, 'writer fairness');

    expect(order[0]).toBe('reader-0-start');
    expect(order).toContain('writer');
    expect(order.indexOf('writer')).toBeLessThan(order.indexOf('reader-1'));
    expect(order.indexOf('writer')).toBeLessThan(order.indexOf('reader-10'));
    expect(gate.isIdle()).toBe(true);
  });

  it('grants a queued reader before writers that arrived later (no reader starvation)', async () => {
    const order: string[] = [];

    const firstWriter = gate.withExclusive(async () => {
      order.push('writer-0-start');
      await delay(20);
      order.push('writer-0-end');
    });
    await delay(1);

    const reader = gate.withShared(async () => {
      order.push('reader');
    });

    const lateWriters = Array.from({ length: 5 }, (_, i) =>
      gate.withExclusive(async () => {
        order.push(`writer-${i + 1}`);
        await delay(1);
      })
    );

    await withTimeout(Promise.all([firstWriter, reader, ...lateWriters]), 5000, 'reader fairness');

    expect(order.indexOf('reader')).toBeGreaterThan(order.indexOf('writer-0-end'));
    expect(order.indexOf('reader')).toBeLessThan(order.indexOf('writer-1'));
    expect(gate.isIdle()).toBe(true);
  });

  it('does not starve an exclusive waiter behind a continuous stream of readers', async () => {
    let stop = false;
    const inFlight: Promise<void>[] = [];

    const producer = (async () => {
      while (!stop) {
        inFlight.push(
          gate.withShared(async () => {
            await delay(1);
          })
        );
        await delay(0);
      }
    })();

    await delay(5); // let a stream of readers build up
    const writer = gate.withExclusive(async () => {
      // exclusive critical section
    });

    await withTimeout(writer, 3000, 'writer starvation');
    stop = true;
    await producer;
    await withTimeout(Promise.all(inFlight), 5000, 'reader drain');
    expect(gate.isIdle()).toBe(true);
  });

  it('does not starve a reader behind a continuous stream of exclusive writers', async () => {
    let stop = false;
    const inFlight: Promise<void>[] = [];

    const producer = (async () => {
      while (!stop) {
        inFlight.push(
          gate.withExclusive(async () => {
            await delay(1);
          })
        );
        await delay(0);
      }
    })();

    await delay(5);
    const reader = gate.withShared(async () => {
      // shared critical section
    });

    await withTimeout(reader, 3000, 'reader starvation');
    stop = true;
    await producer;
    await withTimeout(Promise.all(inFlight), 5000, 'writer drain');
    expect(gate.isIdle()).toBe(true);
  });

  it('survives a high-volume mixed stress run without deadlock or leaked leases', async () => {
    const ops: Promise<unknown>[] = [];
    let seed = 0x12345678;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };

    for (let i = 0; i < 600; i++) {
      const value = next();
      if (value % 7 === 0) {
        ops.push(
          gate.withExclusive(async () => {
            if (value % 3 === 0) await delay(1);
          })
        );
      } else {
        ops.push(
          gate.withShared(async () => {
            if (value % 11 === 0) await delay(1);
          })
        );
      }
    }

    await withTimeout(Promise.all(ops), 10000, 'stress');
    expect(gate.isIdle()).toBe(true);
    expect(gate.snapshot()).toMatchObject({ readers: 0, writing: false, queued: 0 });
  });

  it('does not leak readers across repeated acquire/release cycles', async () => {
    for (let i = 0; i < 500; i++) {
      const release = await gate.acquireShared();
      release();
    }
    expect(gate.snapshot()).toMatchObject({ readers: 0, writing: false, queued: 0 });

    for (let i = 0; i < 100; i++) {
      const release = await gate.acquireExclusive();
      release();
    }
    expect(gate.isIdle()).toBe(true);
  });

  it('treats a double release as a no-op', async () => {
    const release = await gate.acquireShared();
    expect(gate.snapshot().readers).toBe(1);
    release();
    release();
    expect(gate.snapshot().readers).toBe(0);
    expect(gate.isIdle()).toBe(true);
  });
});

describe('AsyncMutex', () => {
  it('serialises holders and hands ownership to the oldest waiter', async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 20 }, (_, i) =>
      mutex.withLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`start-${i}`);
        await delay(1);
        order.push(`end-${i}`);
        active--;
      })
    );

    await withTimeout(Promise.all(tasks), 5000, 'mutex');
    expect(maxActive).toBe(1);
    // Strict FIFO ownership: starts appear in the same order as the tasks.
    const starts = order.filter(item => item.startsWith('start-')).map(item => Number(item.split('-')[1]));
    expect(starts).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(mutex.snapshot()).toEqual({ locked: false, queued: 0 });
  });

  it('does not leak the lock when a holder throws', async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.withLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(mutex.snapshot()).toEqual({ locked: false, queued: 0 });

    const release = await mutex.acquire();
    release();
    expect(mutex.snapshot()).toEqual({ locked: false, queued: 0 });
  });
});
