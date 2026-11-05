import { describe, expect, test } from 'bun:test';
import { pickDuration } from '../../src/engine/media';

describe('pickDuration', () => {
  test('a header that agrees with the recorder is used', () => {
    expect(pickDuration(1251.7, 1246.1)).toBe(1251.7);
    expect(pickDuration(12, 12)).toBe(12);
  });
  test("the recorder's count wins over a short header (Firefox read 0.4 s for a 20-minute take)", () => {
    expect(pickDuration(0.421, 1246.08)).toBe(1246.08);
  });
  test('the recorder count fills in a missing or infinite header', () => {
    expect(pickDuration(Number.POSITIVE_INFINITY, 30)).toBe(30);
    expect(pickDuration(Number.NaN, 30)).toBe(30);
    expect(pickDuration(0, 30)).toBe(30);
  });
  test('without a known value the header is all there is, and 0 asks the caller to probe', () => {
    expect(pickDuration(5, 0)).toBe(5);
    expect(pickDuration(Number.POSITIVE_INFINITY, 0)).toBe(0);
  });
});
