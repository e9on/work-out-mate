import { describe, expect, it } from 'vitest';
import { CameraError } from '../src/ports/pose';
import { relaxCspForDev } from '../csp.ts';

describe('CameraError', () => {
  it('Error이면서 CameraError이고 kind를 가진다', () => {
    const e = new CameraError('denied', '거부됨');
    expect(e).toBeInstanceOf(CameraError);
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('denied');
    expect(e.message).toBe('거부됨');
  });
});

describe('relaxCspForDev', () => {
  it("dev 서버에서만 적용된다(apply === 'serve')", () => {
    expect(relaxCspForDev().apply).toBe('serve');
  });
});
