import { expect, test } from 'bun:test';
import { EncoderStalled, waitForQueue } from '../../src/engine/export';

test('waitForQueue rejects when the encoder produces nothing for too long', async () => {
  const encoder = { encodeQueueSize: 12 };
  const since = performance.now();
  await expect(waitForQueue(encoder, 8, () => since, 60)).rejects.toBeInstanceOf(EncoderStalled);
});

test('waitForQueue resolves once the queue drains', async () => {
  const encoder = { encodeQueueSize: 12 };
  setTimeout(() => (encoder.encodeQueueSize = 3), 30);
  await waitForQueue(encoder, 8, () => performance.now(), 5000);
  expect(encoder.encodeQueueSize).toBe(3);
});

test('waitForQueue returns at once when the queue is short', async () => {
  await waitForQueue({ encodeQueueSize: 2 }, 8, () => 0, 1);
});
