import { describe, expect, it, vi } from 'vitest';
import type { Routine } from '@wom/core';
import { createMemoryStorage } from '../src/storage/memoryStorage';
import { createMemoryMediaStore } from '../src/storage/memoryMediaStore';
import { FakePose } from './fakeWorkout';

const recorderNow: (() => number)[] = [];
vi.mock('../src/platform/mediaRecorderCapture', () => ({
  createMediaRecorder: (_getStream: unknown, now: () => number) => {
    recorderNow.push(now);
    return null;
  },
}));

const { buildDeps } = await import('../src/workout/WorkoutFlow');

const ROUTINE: Routine = { id: 'r', name: '루틴', order: 0, exercises: [{ exercise: 'squat', sets: 1, target: { kind: 'reps', reps: 5 }, restSec: 30 }] };

describe('WorkoutFlow 녹화 시계', () => {
  it('녹화 startedAt은 반복·상자 시각과 같은 시계(엔진 now + epochOffset)를 쓴다', () => {
    let t = 500;
    const deps = buildDeps(ROUTINE, createMemoryStorage(), {
      pose: new FakePose(),
      speech: { speak: () => undefined, cancel: () => undefined } as never,
      keepAwake: { acquire: async () => undefined, release: async () => undefined } as never,
      now: () => t,
      epochOffset: 10_000,
    }, createMemoryMediaStore());
    expect(recorderNow).toHaveLength(1);
    const now = recorderNow[0]!;
    expect(now()).toBe(10_500);
    t = 900;
    expect(now()).toBe(deps.now() + deps.epochOffset);
    expect(now()).toBe(10_900);
  });
});
