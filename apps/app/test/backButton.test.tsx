import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchBack, resetBackHandlers, useBackHandler } from '../src/platform/backButton';

function Handler({ onBack }: { onBack: () => boolean | void }) {
  useBackHandler(onBack);
  return null;
}

afterEach(() => resetBackHandlers());

describe('뒤로 가기 처리기', () => {
  it('등록된 처리기가 없으면 처리하지 않았다고 알린다', () => {
    expect(dispatchBack()).toBe(false);
  });

  it('나중에 등록한(위에 있는) 처리기부터 부른다', () => {
    const a = vi.fn();
    const b = vi.fn();
    render(<Handler onBack={a} />);
    render(<Handler onBack={b} />);
    expect(dispatchBack()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it('처리기가 false를 돌려주면 아래 처리기로 넘긴다', () => {
    const a = vi.fn();
    render(<Handler onBack={a} />);
    render(<Handler onBack={() => false} />);
    expect(dispatchBack()).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('모두 false면 처리하지 않았다고 알린다', () => {
    render(<Handler onBack={() => false} />);
    expect(dispatchBack()).toBe(false);
  });

  it('화면에서 빠진 처리기는 더 부르지 않는다', () => {
    const a = vi.fn();
    const b = vi.fn();
    render(<Handler onBack={a} />);
    const top = render(<Handler onBack={b} />);
    top.unmount();
    dispatchBack();
    expect(b).not.toHaveBeenCalled();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('다시 그려져도 자리는 그대로이고 최신 콜백을 부른다', () => {
    const a1 = vi.fn();
    const a2 = vi.fn();
    const b = vi.fn();
    const first = render(<Handler onBack={a1} />);
    render(<Handler onBack={b} />);
    first.rerender(<Handler onBack={a2} />);
    dispatchBack(); // 위는 여전히 b
    expect(b).toHaveBeenCalledTimes(1);
    expect(a1).not.toHaveBeenCalled();
    expect(a2).not.toHaveBeenCalled();
  });
});
