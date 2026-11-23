import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relaxCspHtml } from '../csp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 설계 문서 5.7 원문 + base-uri / form-action
const EXPECTED_CSP =
  "default-src 'self'; connect-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; media-src 'self' blob: mediastream:; base-uri 'none'; form-action 'none'";

function cspOf(html: string): string | null {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  return m ? (m[1] ?? null) : null;
}

describe('CSP 빌드 산출물', () => {
  it('dist/index.html의 CSP meta가 기대 값과 정확히 같다', () => {
    const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
    expect(cspOf(html)).toBe(EXPECTED_CSP);
  });

  it('dist/index.html에 인라인 <style>이 없다 (CSS는 외부 파일)', () => {
    const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
    expect(html).not.toMatch(/<style/);
    expect(html).toMatch(/<link rel="stylesheet"/);
  });

  it('dev 완화가 빌드 산출물에는 들어가지 않는다', () => {
    const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('ws:');
  });
});

describe('relaxCspHtml (dev 전용 완화)', () => {
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');

  it('connect-src에 ws: wss:를, style-src에 unsafe-inline을 더한다', () => {
    const out = cspOf(relaxCspHtml(src));
    expect(out).toContain("connect-src 'self' ws: wss: blob: data:");
    expect(out).toContain("default-src 'self'; style-src 'self' 'unsafe-inline';");
  });

  it('CSP가 없는 html이면 throw한다', () => {
    expect(() => relaxCspHtml('<html><head></head><body></body></html>')).toThrow();
  });

  it('replace 하나라도 적용되지 않으면 throw한다', () => {
    const noConnect = src.replace("connect-src 'self'", "connect-src https:");
    expect(() => relaxCspHtml(noConnect)).toThrow();
    const noDefault = src.replace("default-src 'self';", "default-src 'none';");
    expect(() => relaxCspHtml(noDefault)).toThrow();
  });
});

describe('src에서 style 속성 금지', () => {
  function tsxFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : [];
    });
  }

  it('.tsx 안에 style={ 또는 style=" 이 없다', () => {
    const bad = tsxFiles(join(ROOT, 'src')).filter((f) => /style\s*=\s*(\{|")/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
