// Batch export queue: runs jobs one after another with per-item progress, cancel, and a results
// list. Pure logic with an injected runner, so it is unit-tested without a browser or an encoder.

export type QueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueueItem<P, R> {
  id: string;
  label: string;
  payload: P;
  status: QueueStatus;
  /** 0..1 */
  progress: number;
  /** Short note from the runner, such as "Rendering frame 12 of 90". */
  detail: string;
  result?: R;
  error?: string;
}

export interface RunContext {
  signal: AbortSignal;
  /** Position of this item among the items run so far (0-based). */
  index: number;
  report(fraction: number, detail?: string): void;
}

export type Runner<P, R> = (payload: P, ctx: RunContext) => Promise<R>;

function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

export class ExportQueue<P, R> {
  private list: Array<QueueItem<P, R>> = [];
  private listeners = new Set<() => void>();
  private controllers = new Map<string, AbortController>();
  private active: Promise<void> | null = null;
  private stopping = false;
  private counter = 0;
  private ran = 0;

  /** An immutable copy of the items, in order. */
  get items(): ReadonlyArray<Readonly<QueueItem<P, R>>> {
    return this.list.map((i) => ({ ...i }));
  }

  get running(): boolean {
    return this.active !== null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of [...this.listeners]) l();
  }

  add(label: string, payload: P): string {
    const id = `q${++this.counter}`;
    this.list.push({ id, label, payload, status: 'queued', progress: 0, detail: '' });
    this.changed();
    return id;
  }

  /** Removes an item that is not running. */
  remove(id: string): boolean {
    const i = this.list.findIndex((x) => x.id === id);
    if (i < 0 || this.list[i].status === 'running') return false;
    this.list.splice(i, 1);
    this.changed();
    return true;
  }

  /** Drops everything that has finished (done, failed or cancelled). */
  clearFinished(): void {
    this.list = this.list.filter((x) => x.status === 'queued' || x.status === 'running');
    this.changed();
  }

  /** Puts a failed or cancelled item back in the queue. */
  retry(id: string): boolean {
    const item = this.list.find((x) => x.id === id);
    if (!item || (item.status !== 'failed' && item.status !== 'cancelled')) return false;
    Object.assign(item, { status: 'queued', progress: 0, detail: '', error: undefined, result: undefined });
    this.changed();
    return true;
  }

  /** Cancels one item: a queued item will not run, a running item is aborted. */
  cancel(id: string): void {
    const item = this.list.find((x) => x.id === id);
    if (!item) return;
    if (item.status === 'queued') {
      item.status = 'cancelled';
      item.detail = 'Cancelled';
      this.changed();
    } else if (item.status === 'running') {
      this.controllers.get(id)?.abort();
    }
  }

  /** Cancels the running item and every item still waiting. */
  cancelAll(): void {
    this.stopping = true;
    for (const item of this.list) if (item.status === 'queued') this.cancel(item.id);
    for (const c of this.controllers.values()) c.abort();
  }

  counts(): Record<QueueStatus, number> {
    const out: Record<QueueStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const i of this.list) out[i.status]++;
    return out;
  }

  /**
   * Runs the queued items in order. A failing item never stops the rest. Items added while it runs
   * are picked up. Resolves when nothing is left to run. Calling it again while running joins the run.
   */
  run(runner: Runner<P, R>): Promise<void> {
    if (this.active) return this.active;
    this.stopping = false;
    this.active = (async () => {
      try {
        for (;;) {
          if (this.stopping) break;
          const item = this.list.find((x) => x.status === 'queued');
          if (!item) break;
          const controller = new AbortController();
          this.controllers.set(item.id, controller);
          item.status = 'running';
          item.progress = 0;
          item.detail = '';
          this.changed();
          try {
            const result = await runner(item.payload, {
              signal: controller.signal,
              index: this.ran++,
              report: (fraction, detail) => {
                item.progress = Math.max(0, Math.min(1, fraction));
                if (detail !== undefined) item.detail = detail;
                this.changed();
              },
            });
            if (controller.signal.aborted) {
              item.status = 'cancelled';
              item.detail = 'Cancelled';
            } else {
              item.status = 'done';
              item.progress = 1;
              item.result = result;
              item.detail = 'Done';
            }
          } catch (e) {
            if (isAbort(e) || controller.signal.aborted) {
              item.status = 'cancelled';
              item.detail = 'Cancelled';
            } else {
              item.status = 'failed';
              item.error = e instanceof Error ? e.message : String(e);
              item.detail = 'Failed';
            }
          } finally {
            this.controllers.delete(item.id);
            this.changed();
          }
        }
      } finally {
        this.active = null;
        this.stopping = false;
        this.changed();
      }
    })();
    return this.active;
  }
}
