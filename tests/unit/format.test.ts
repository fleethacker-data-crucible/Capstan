import { expect, test } from 'bun:test';
import { safeFileName, timecode } from '../../src/ui/format';

test('timecode rounds float error to the nearest frame', () => {
  expect(timecode(5.999999999, 30)).toBe('0:00:06;00');
  expect(timecode(1.5, 30)).toBe('0:00:01;15');
  expect(timecode(3661.5, 30)).toBe('1:01:01;15');
  expect(timecode(2.999, undefined)).toBe('0:03.00');
  expect(timecode(65.25)).toBe('1:05.25');
});

test('file names are made safe for Windows', () => {
  expect(safeFileName('a/b:c*?"<>|d')).toBe('a b c d');
  expect(safeFileName('   ')).toBe('OpenTape export');
});
