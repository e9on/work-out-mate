import { useEffect, useRef } from 'react';

/**
 * 폰 뒤로 가기(Android 제스처·◁ 버튼) 처리.
 *
 * 화면과 대화 상자가 useBackHandler로 처리기를 쌓는다. 뒤로 가기가 오면 가장 나중에 등록한(위에 있는)
 * 처리기부터 부른다. 처리기가 false를 돌려주면 그 아래로 넘긴다. 아무도 처리하지 않으면 앱의 기본 동작
 * (installBackButton: 앱을 뒤로 보냄)을 한다.
 * 자리는 처음 등록한 순서로 고정하고, 다시 그려질 때는 콜백만 최신 것으로 바꾼다.
 */
export type BackHandler = () => boolean | void;

type Entry = { current: BackHandler };
let stack: Entry[] = [];

export function dispatchBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i]!.current() !== false) return true;
    } catch (e) {
      // 처리기 하나가 실패해도 뒤로 가기 전체가 멈추지 않게, 그 처리기는 처리 안 함으로 보고 아래로 넘긴다
      console.warn('뒤로 가기 처리기 오류', e);
    }
  }
  return false;
}

export function useBackHandler(onBack: BackHandler): void {
  const ref = useRef<BackHandler>(onBack);
  ref.current = onBack;
  useEffect(() => {
    const entry: Entry = { current: () => ref.current() };
    stack.push(entry);
    return () => {
      stack = stack.filter((e) => e !== entry);
    };
  }, []);
}

/** 렌더 트리 안에서 조건부로 처리기를 거는 용도(예: 대화 상자가 열려 있을 때만) */
export function BackHandlerOn({ onBack }: { onBack: BackHandler }): null {
  useBackHandler(onBack);
  return null;
}

/** 시험 전용: 처리기 목록을 비운다 */
export function resetBackHandlers(): void {
  stack = [];
}

/** 네이티브 앱에서만 폰 뒤로 가기를 받는다. 아무도 처리하지 않으면 앱을 뒤로 보낸다(Android 기본 동작과 같음). */
export async function installBackButton(): Promise<void> {
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return;
  const { App } = await import('@capacitor/app');
  await App.addListener('backButton', () => {
    if (!dispatchBack()) void App.minimizeApp();
  });
}
