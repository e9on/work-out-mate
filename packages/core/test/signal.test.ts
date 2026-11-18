import { test, expect } from 'vitest';
import { Ema, visibleEnough } from '../src/pose/signal';
import { buildPose } from './helpers/poseBuilder';

test('Ema: 10, 20 -> 10, 15', () => {
  const e = new Ema(0.5);
  expect(e.next(10)).toBe(10);
  expect(e.next(20)).toBe(15);
});

test('Ema: null은 null을 내고 내부 값은 유지', () => {
  const e = new Ema(0.5);
  expect(e.next(10)).toBe(10);
  expect(e.next(null)).toBeNull();
  expect(e.next(20)).toBe(15);
});

test('Ema: reset 후 첫 값은 그대로', () => {
  const e = new Ema(0.5);
  e.next(10);
  e.reset();
  expect(e.next(40)).toBe(40);
});

test('visibleEnough: 0.6이면 true', () => {
  const f = buildPose({ t: 0, visibility: 0.6 });
  expect(visibleEnough(f, [11, 13, 15])).toBe(true);
});

test('visibleEnough: 하나라도 0.4면 false', () => {
  const f = buildPose({ t: 0, visibility: 0.6 });
  f.image[13] = { x: 0, y: 0, z: 0, visibility: 0.4 };
  expect(visibleEnough(f, [11, 13, 15])).toBe(false);
});

test('visibleEnough: min 인자와 hidden', () => {
  const f = buildPose({ t: 0, hidden: [13] });
  expect(visibleEnough(f, [11, 13, 15])).toBe(false);
  expect(visibleEnough(f, [11, 15], 0.9)).toBe(true);
});
