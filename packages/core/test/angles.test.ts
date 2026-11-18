import { test, expect } from 'vitest';
import { jointAngle } from '../src/pose/angles';

const p = (x: number, y: number, z = 0) => ({ x, y, z, visibility: 1 });

test('직각', () => expect(jointAngle(p(1, 0), p(0, 0), p(0, 1))).toBeCloseTo(90, 5));
test('일직선', () => expect(jointAngle(p(-1, 0), p(0, 0), p(1, 0))).toBeCloseTo(180, 5));
test('3D 45도', () => expect(jointAngle(p(1, 0, 0), p(0, 0, 0), p(1, 0, 1))).toBeCloseTo(45, 5));
test('길이 0이면 NaN', () => expect(jointAngle(p(0, 0), p(0, 0), p(1, 0))).toBeNaN());
