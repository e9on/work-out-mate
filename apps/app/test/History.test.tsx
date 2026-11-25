import { fireEvent, render, screen } from '@testing-library/react';
import { setKey } from '../src/form/types';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { describe, expect, it, vi } from 'vitest';
import type { SetLog, WorkoutSession } from '@wom/core';
import { History } from '../src/screens/History';
import { SessionDetail } from '../src/screens/SessionDetail';
import { createMemoryStorage } from '../src/storage/memoryStorage';

const log = (p: Partial<SetLog>): SetLog => ({
  exercise: 'squat', target: { kind: 'reps', reps: 10 }, count: 8, heldMs: 0, negativeDescentMs: [],
  startT: 0, endT: 1, endReason: 'target', exerciseIndex: 0, setIndex: 0, restTakenMs: null, ...p,
});
const mk = (id: string, name: string, endedAt: number, completed: boolean, sets: SetLog[] = []): WorkoutSession => ({
  id, routineId: 'r', routineName: name, startedAt: endedAt - 1000, endedAt, completed, sets,
});

describe('History', () => {
  it('endedAt 내림차순으로 날짜·저장 당시 루틴 이름·완료 여부를 보이고, 누르면 onOpen', async () => {
    const storage = createMemoryStorage();
    await storage.saveSession(mk('old', '지운루틴', new Date(2026, 10, 1, 9, 5).getTime(), true));
    await storage.saveSession(mk('new', '하체데이', new Date(2026, 10, 23, 18, 30).getTime(), false));
    const onOpen = vi.fn();
    render(<History storage={storage} onOpen={onOpen} onBack={vi.fn()} />);
    const items = await screen.findAllByRole('button', { name: /데이|루틴/ });
    expect(items[0]).toHaveTextContent('2026. 11. 23. 18:30');
    expect(items[0]).toHaveTextContent('하체데이');
    expect(items[0]).toHaveTextContent('미완료');
    expect(items[1]).toHaveTextContent('2026. 11. 1. 09:05');
    expect(items[1]).toHaveTextContent('지운루틴');
    expect(items[1]).toHaveTextContent('완료');
    expect(items[1]).not.toHaveTextContent('미완료');
    fireEvent.click(items[0]!);
    expect(onOpen).toHaveBeenCalledWith('new');
  });

  it('기록이 없으면 안내하고 뒤로 버튼이 동작한다', async () => {
    const onBack = vi.fn();
    render(<History storage={createMemoryStorage()} onOpen={vi.fn()} onBack={onBack} />);
    expect(await screen.findByText('아직 기록이 없어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '홈으로' }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('SessionDetail', () => {
  it('세트 표에 +1 세트 번호, 목표, 실제, 쉰 시간, 종료 사유(한국어)를 보인다', async () => {
    const storage = createMemoryStorage();
    await storage.saveSession(
      mk('s', '하체데이', 5000, true, [
        log({ setIndex: 0, count: 8, endReason: 'idle', restTakenMs: null }),
        log({ setIndex: 1, count: 10, endReason: 'target', restTakenMs: 61400 }),
        log({ exercise: 'deadHang', exerciseIndex: 1, target: { kind: 'seconds', seconds: 30 }, count: 0, heldMs: 24600, endReason: 'released', restTakenMs: 30000 }),
        log({ exerciseIndex: 2, endReason: 'manual', restTakenMs: 5000 }),
      ]),
    );
    render(<SessionDetail storage={storage} sessionId="s" onBack={vi.fn()} />);
    await screen.findByRole('table');
    const rows = screen.getAllByRole('row').slice(1);
    const cells = (i: number) => Array.from(rows[i]!.querySelectorAll('td')).map((c) => c.textContent);
    expect(cells(0)).toEqual(['스쿼트', '1', '10회', '8회', '-', '멈춤']);
    expect(cells(1)).toEqual(['스쿼트', '2', '10회', '10회', '61초', '목표 달성']);
    expect(cells(2)).toEqual(['매달리기', '1', '30초', '25초', '30초', '손 놓음']);
    expect(cells(3)[5]).toBe('그만하기');
  });

  it('세션이 없으면 안내한다', async () => {
    render(<SessionDetail storage={createMemoryStorage()} sessionId="none" onBack={vi.fn()} />);
    expect(await screen.findByText('기록을 찾을 수 없어요')).toBeInTheDocument();
  });

  it('녹화한 세션이면 자세 분석 지적 줄과 ▶을 보이고, 누르면 onPlay(setKey, index)', async () => {
    const storage = createMemoryStorage();
    const reps = [{ index: 1, startT: 1000, bottomT: 1500, endT: 2000 }];
    await storage.saveSession(mk('s', '하체데이', 5000, true, [log({ count: 1, reps })]));
    const store = createMemoryMediaStore();
    await store.putCaptureMeta({ sessionId: 's', videoEnabled: true, consentAgreed: false, consentVersion: null });
    const key = setKey('s', 0, 0);
    await store.putVideo({ key, sessionId: 's', routineId: 'r', exerciseIndex: 0, setIndex: 0, startedAt: 0, mimeType: 'video/webm', blob: new Blob([new Uint8Array(1)]), boxes: [] });
    await store.putAnalysis({
      key, sessionId: 's', status: 'done', reason: null,
      metrics: [{ index: 1, bottomT: 1500, kneeDeg: 120, kneeAnkleRatio: 1.3, heelRise: 0, descentMs: 800, skipped: null }],
      findings: [{ index: 1, kind: 'depth', value: 120 }], notes: [], uncertain: [], frames: [], model: 'rtmpose-m-halpe26', analyzedAt: 1,
    });
    const onPlay = vi.fn();
    render(<SessionDetail storage={storage} sessionId="s" onBack={vi.fn()} mediaStore={store} onPlay={onPlay} />);
    expect(await screen.findByRole('region', { name: '자세 분석' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '1번째 다시 보기' }));
    expect(onPlay).toHaveBeenCalledWith(key, 1);
  });
});
