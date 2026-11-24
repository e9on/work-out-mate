import type { Plugin } from 'vite';

/**
 * 개발 서버 전용 CSP 완화.
 * - style-src 'unsafe-inline': Vite dev가 CSS를 <style> 태그로 주입한다(빌드에서는 외부 css 파일).
 * - connect-src ws: wss:: Vite HMR 웹소켓.
 * replace가 하나라도 적용되지 않으면(index.html의 CSP가 바뀐 경우 등) 조용히 넘어가지 않고 throw한다.
 */
export function relaxCspHtml(html: string): string {
  const steps: Array<[string, string]> = [
    ["connect-src 'self'", "connect-src 'self' ws: wss:"],
    ["default-src 'self';", "default-src 'self'; style-src 'self' 'unsafe-inline';"],
  ];
  let out = html;
  for (const [from, to] of steps) {
    if (!out.includes(from)) throw new Error(`dev CSP 완화 실패: index.html에 "${from}"가 없어요`);
    out = out.replace(from, to);
  }
  return out;
}

export function relaxCspForDev(): Plugin {
  return {
    name: 'wom-relax-csp-dev',
    apply: 'serve',
    transformIndexHtml: relaxCspHtml,
  };
}
