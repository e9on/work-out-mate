import { describe, expect, it } from 'vitest';
import { findStyleViolations } from './styleScan';

describe('findStyleViolations (인라인 스타일 패턴 검출)', () => {
  const bad: Array<[string, string]> = [
    ['JSX style={ }', '<div style={{ color: "red" }} />'],
    ['JSX style="..."', '<div style="color:red" />'],
    ["JSX style='...'", "<div style='color:red' />"],
    ['객체 키 style:', 'const p = { style: { color: "red" } };'],
    ['.style. 접근', 'el.style.color = "red";'],
    ['.style = 대입', 'el.style = "color:red";'],
    ["setAttribute('style'", "el.setAttribute('style', 'color:red');"],
    ['setAttribute("style"', 'el.setAttribute("style", "color:red");'],
    ['cssText', 'el.cssText = "a:b";'],
    ['<style 태그', 'const h = "<style>a{}</style>";'],
  ];
  it.each(bad)('잡는다: %s', (_name, code) => {
    expect(findStyleViolations(code)).not.toEqual([]);
  });

  it('canvas의 fillStyle/strokeStyle은 잡지 않는다', () => {
    const code = 'ctx.fillStyle = "#fff"; ctx.strokeStyle = "red"; const s = styleSheet; <div className="a" />';
    expect(findStyleViolations(code)).toEqual([]);
  });
});
