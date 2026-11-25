import { describe, expect, it } from 'vitest';
import { findingLine, mmss, notePhrase } from '../src/domain/formPhrases';

describe('formPhrases', () => {
  it('fastDescent 600ms는 "0.6초"로 소수 한 자리', () => {
    expect(notePhrase({ kind: 'fastDescent', avgDescentMs: 600 })).toBe('이번 세트는 평균 0.6초 만에 내려갔어요. 2초 이상 천천히 내려가 보세요');
  });
  it('shallow는 몇 회 중 몇 회를 덜 앉았는지 알려 준다', () => {
    expect(notePhrase({ kind: 'shallow', count: 4, total: 10 })).toBe('이번 세트는 10회 중 4회를 덜 앉았어요. 허벅지가 바닥과 평행해질 때까지 앉아 보세요');
  });
  it('m:ss는 0 아래를 0으로', () => {
    expect(mmss(18)).toBe('0:18');
    expect(mmss(65.9)).toBe('1:05');
    expect(mmss(-3)).toBe('0:00');
  });
  it('줄 형식: 시각이 없으면 괄호를 뺀다', () => {
    expect(findingLine(4, 18, '문구')).toBe('4번째 (0:18)  문구');
    expect(findingLine(4, null, '문구')).toBe('4번째  문구');
  });
});
