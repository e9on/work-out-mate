// CSP(style-src 없음)에서 막히는 인라인 스타일 패턴. canvas의 fillStyle/strokeStyle은 대소문자가 달라 걸리지 않는다.
const PATTERNS: Array<[string, RegExp]> = [
  ['style= 속성(JSX 포함)', /\bstyle\s*=/],
  ['객체 키 style:', /\bstyle\s*:/],
  ['.style 접근(CSSOM)', /\.style\b/],
  ["setAttribute('style'", /setAttribute\(\s*['"]style['"]/],
  ['cssText', /cssText/],
  ['<style 태그', /<style/],
];

export function findStyleViolations(source: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(source)).map(([name]) => name);
}
