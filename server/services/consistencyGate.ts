/**
 * Global consistency gate for storage-backed writes.
 *
 * InkFlow keeps Markdown/revisions/assets on the filesystem and their metadata in
 * SQLite. A full backup or restore must observe those two sides at the same logical
 * generation. The per-document locks in documentService only serialise work on a
 * single document, so this process-wide gate is the missing global barrier:
 *
 *   - every operation that mutates documents/, revisions/, assets/ (or the DB rows
 *     that describe them) holds a SHARED lease;
 *   - backup/restore and whole-library maintenance hold an EXCLUSIVE lease.
 *
 * The queue is strictly FIFO. Readers at the head are granted as a batch; a writer
 * at the head waits for the current readers to drain and is then granted alone.
 * That gives fairness in both directions (no starvation of a queued writer behind
 * a stream of saves, and no starvation of readers behind a stream of writers).
 *
 * The gate is process-local by design: InkFlow only supports one writer process
 * per storage directory (see the cluster guard in server.ts).
 */

export interface GateSnapshot {
  /** Readers currently holding a shared lease. */
  readers: number;
  /** Whether an exclusive lease is currently held. */
  writing: boolean;
  /** Waiters that have not been granted yet. */
  queued: number;
  /** Monotonic counter incremented on every grant and release (diagnostics only). */
  generation: number;
}

type Mode = 'read' | 'write';

interface Waiter {
  mode: Mode;
  grant: (release: () => void) => void;
}

export class ConsistencyGate {
  private readers = 0;
  private writer = false;
  private queue: Waiter[] = [];
  private generationCounter = 0;

  public acquireShared(): Promise<() => void> {
    return this.enqueue('read');
  }

  public acquireExclusive(): Promise<() => void> {
    return this.enqueue('write');
  }

  public async withShared<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquireShared();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public async withExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquireExclusive();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public snapshot(): GateSnapshot {
    return {
      readers: this.readers,
      writing: this.writer,
      queued: this.queue.length,
      generation: this.generationCounter,
    };
  }

  /** True when no reader/writer holds or awaits a lease (used by tests/assertions). */
  public isIdle(): boolean {
    return !this.writer && this.readers === 0 && this.queue.length === 0;
  }

  private enqueue(mode: Mode): Promise<() => void> {
    return new Promise(resolve => {
      this.queue.push({ mode, grant: resolve });
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];

      if (head.mode === 'write') {
        // A writer must run alone, and only in FIFO order.
        if (this.writer || this.readers > 0) return;
        this.queue.shift();
        this.writer = true;
        this.generationCounter++;
        head.grant(this.makeRelease('write'));
        return;
      }

      // Readers run concurrently, but only those at the front of the queue.
      // If a writer is currently active, everyone waits.
      if (this.writer) return;

      this.queue.shift();
      this.readers++;
      this.generationCounter++;
      head.grant(this.makeRelease('read'));
    }
  }

  private makeRelease(mode: Mode): () => void {
    let released = false;
    return () => {
      // Idempotent: a double release must never corrupt the counters.
      if (released) return;
      released = true;

      if (mode === 'read') {
        this.readers--;
        if (this.readers < 0) this.readers = 0;
      } else {
        this.writer = false;
      }
      this.generationCounter++;
      this.drain();
    };
  }
}

/**
 * Small FIFO mutex used to serialise asset mutations among themselves.
 *
 * The shared lease only excludes backup/restore; it deliberately allows concurrent
 * shared holders. Asset upload/delete/reconcile still need to be mutually exclusive
 * because they combine a filesystem operation with a SQLite write (write file then
 * INSERT, or DELETE row then unlink file).
 */
export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  public acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise(resolve => {
      this.queue.push(() => resolve(this.makeRelease()));
    });
  }

  public async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public snapshot(): { locked: boolean; queued: number } {
    return { locked: this.locked, queued: this.queue.length };
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Ownership transfers directly to the next waiter; stay locked.
        next();
      } else {
        this.locked = false;
      }
    };
  }
}

export const consistencyGate = new ConsistencyGate();

/** Serialises upload/delete/cleanup/reconcile for the shared assets directory. */
export const assetMutationLock = new AsyncMutex();
