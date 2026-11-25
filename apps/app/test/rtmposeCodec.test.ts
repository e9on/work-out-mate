import type { Kp2 } from '@wom/core';
import { describe, expect, it } from 'vitest';
import { RTM_H, RTM_W, cropFor, decodeSimcc, toInputTensor } from '../src/form/rtmposeCodec';

describe('rtmposeCodec', () => {
  it('cropFor: 중심을 지키고 높이 기준 1.25배, 192:256 비율', () => {
    const c = cropFor([0.4, 0.2, 0.6, 0.8], 1080, 1920);
    expect(c.sh).toBeCloseTo(1152 * 1.25);
    expect(c.sw).toBeCloseTo((c.sh * 192) / 256);
    expect(c.sx + c.sw / 2).toBeCloseTo(540);
    expect(c.sy + c.sh / 2).toBeCloseTo(960);
  });

  it('cropFor: 너비가 더 크면 너비 기준으로 높이를 늘린다', () => {
    const c = cropFor([0.1, 0.4, 0.9, 0.6], 1000, 1000);
    expect(c.sw).toBeCloseTo(800 * 1.25);
    expect(c.sh).toBeCloseTo((c.sw * 256) / 192);
    expect(c.sx + c.sw / 2).toBeCloseTo(500);
  });

  it('toInputTensor: BGR 순서로 MEAN/STD 정규화, CHW', () => {
    const px = RTM_W * RTM_H;
    const rgba = new Uint8ClampedArray(px * 4);
    for (let i = 0; i < px; i++) rgba.set([10, 20, 30, 255], i * 4);
    const t = toInputTensor(rgba);
    expect(t.length).toBe(3 * px);
    expect(t[0]).toBeCloseTo((30 - 123.675) / 58.395, 5);
    expect(t[px]).toBeCloseTo((20 - 116.28) / 57.12, 5);
    expect(t[2 * px + px - 1]).toBeCloseTo((10 - 103.53) / 57.375, 5);
  });

  it('decodeSimcc: argmax÷2를 크롭 좌표로 보고 원본 픽셀로 되돌린다', () => {
    const LX = RTM_W * 2, LY = RTM_H * 2;
    const sx = new Float32Array(2 * LX), sy = new Float32Array(2 * LY);
    sx[200] = 0.9; sy[300] = 0.7; // 관절 0
    sx[LX + 10] = 0.2; sy[LY + 20] = 0.8; // 관절 1
    const crop = { sx: 100, sy: 50, sw: 384, sh: 512 };
    const k = decodeSimcc(sx, sy, 2, crop) as [Kp2, Kp2];
    expect(k[0].x).toBeCloseTo(100 + (100 / 192) * 384);
    expect(k[0].y).toBeCloseTo(50 + (150 / 256) * 512);
    expect(k[0].score).toBeCloseTo(0.7);
    expect(k[1].score).toBeCloseTo(0.2);
  });
});
