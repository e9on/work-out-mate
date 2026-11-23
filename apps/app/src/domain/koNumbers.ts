const KO = ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];

/** 1~10은 고유어, 그 밖은 숫자 문자열 */
export function koCount(n: number): string {
  return Number.isInteger(n) && n >= 1 && n <= 10 ? (KO[n - 1] ?? String(n)) : String(n);
}
