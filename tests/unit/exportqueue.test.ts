import { expect, test } from 'bun:test';
import { ExportQueue } from '../../src/engine/exportqueue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('items run one at a time, in order, with progress and results', async () => {
  const q = new ExportQueue<string, string>();
  q.add('a', 'A');
  q.add('b', 'B');
  q.add('c', 'C');
  const order: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const seen: number[] = [];
  q.subscribe(() => seen.push(q.items.filter((i) => i.status === 'done').length));
  await q.run(async (p, ctx) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push(p);
    ctx.report(0.5, 'half');
    expect(q.items.find((i) => i.status === 'running')?.progress).toBe(0.5);
    await sleep(2);
    concurrent--;
    return p.toLowerCase();
  });
  expect(order).toEqual(['A', 'B', 'C']);
  expect(maxConcurrent).toBe(1);
  expect(q.items.map((i) => [i.status, i.result, i.progress])).toEqual([
    ['done', 'a', 1],
    ['done', 'b', 1],
    ['done', 'c', 1],
  ]);
  expect(q.counts()).toEqual({ queued: 0, running: 0, done: 3, failed: 0, cancelled: 0 });
  expect(q.running).toBe(false);
  expect(seen[seen.length - 1]).toBe(3);
});

test('a failing item is reported and the rest still run', async () => {
  const q = new ExportQueue<number, number>();
  [1, 2, 3].forEach((n) => q.add(`n${n}`, n));
  await q.run(async (n) => {
    if (n === 2) throw new Error('encoder exploded');
    return n * 10;
  });
  expect(q.items.map((i) => i.status)).toEqual(['done', 'failed', 'done']);
  expect(q.items[1].error).toBe('encoder exploded');
  expect(q.items[2].result).toBe(30);
});

test('cancelling a queued item skips it; cancelling the running item aborts its signal', async () => {
  const q = new ExportQueue<string, string>();
  const a = q.add('a', 'A');
  const b = q.add('b', 'B');
  q.add('c', 'C');
  q.cancel(b);
  const ran: string[] = [];
  const done = q.run(async (p, ctx) => {
    ran.push(p);
    if (p === 'A') {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new DOMException('Export cancelled', 'AbortError')));
        setTimeout(resolve, 2000);
      });
    }
    return p;
  });
  await sleep(10);
  expect(q.items[0].status).toBe('running');
  q.cancel(a);
  await done;
  expect(ran).toEqual(['A', 'C']);
  expect(q.items.map((i) => i.status)).toEqual(['cancelled', 'cancelled', 'done']);
});

test('cancel all stops the running item and everything waiting', async () => {
  const q = new ExportQueue<number, number>();
  [1, 2, 3].forEach((n) => q.add(`n${n}`, n));
  const ran: number[] = [];
  const done = q.run(
    (n, ctx) =>
      new Promise<number>((resolve, reject) => {
        ran.push(n);
        ctx.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        setTimeout(() => resolve(n), 1000);
      }),
  );
  await sleep(10);
  q.cancelAll();
  await done;
  expect(ran).toEqual([1]);
  expect(q.items.map((i) => i.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  expect(q.running).toBe(false);
});

test('a runner that ignores the abort still ends up cancelled, not done', async () => {
  const q = new ExportQueue<number, number>();
  q.add('x', 1);
  const done = q.run(async (_n, _ctx) => {
    await sleep(20);
    return 5;
  });
  await sleep(5);
  q.cancelAll();
  await done;
  expect(q.items[0].status).toBe('cancelled');
});

test('items added while the queue runs are picked up; finished items can be cleared and failed ones retried', async () => {
  const q = new ExportQueue<number, number>();
  q.add('one', 1);
  let first = true;
  const ran: number[] = [];
  const done = q.run(async (n) => {
    ran.push(n);
    if (first) {
      first = false;
      q.add('two', 2);
    }
    if (n === 2 && ran.length === 2) throw new Error('first try fails');
    return n;
  });
  await done;
  expect(ran).toEqual([1, 2]);
  expect(q.items[1].status).toBe('failed');
  expect(q.retry(q.items[1].id)).toBe(true);
  expect(q.retry(q.items[0].id)).toBe(false);
  await q.run(async (n) => n);
  expect(q.items.map((i) => i.status)).toEqual(['done', 'done']);
  q.clearFinished();
  expect(q.items.length).toBe(0);
});

test('a running item cannot be removed, a waiting one can; a second run() joins the first', async () => {
  const q = new ExportQueue<number, number>();
  const a = q.add('a', 1);
  const b = q.add('b', 2);
  const runner = async (n: number) => {
    await sleep(15);
    return n;
  };
  const first = q.run(runner);
  expect(q.run(runner)).toBe(first);
  await sleep(2);
  expect(q.remove(a)).toBe(false);
  expect(q.remove(b)).toBe(true);
  await first;
  expect(q.items.map((i) => i.label)).toEqual(['a']);
});
