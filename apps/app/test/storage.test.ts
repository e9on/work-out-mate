import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Routine, WorkoutSession } from '@wom/core';
import type { Storage } from '../src/ports/storage';
import { createIdbStorage } from '../src/storage/idbStorage';
import { createMemoryStorage } from '../src/storage/memoryStorage';

const routine = (id: string, order: number): Routine => ({
  id,
  name: `루틴 ${id}`,
  order,
  exercises: [{ exercise: 'squat', sets: 3, target: { kind: 'reps', reps: 10 }, restSec: 30 } as Routine['exercises'][number]],
  createdAt: 1,
  updatedAt: 1,
});

const session = (id: string, endedAt: number, completed = true): WorkoutSession => ({
  id,
  routineId: 'r1',
  routineName: '루틴 r1',
  startedAt: endedAt - 1000,
  endedAt,
  completed,
  sets: [],
});

let dbSeq = 0;
const makers: [string, () => Storage][] = [
  ['idb', () => createIdbStorage(`test-db-${dbSeq++}`)],
  ['memory', () => createMemoryStorage()],
];

describe.each(makers)('저장소 (%s)', (_name, make) => {
  let s: Storage;
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    s = make();
  });

  it('루틴을 order 오름차순으로 돌려준다', async () => {
    await s.saveRoutine(routine('b', 2));
    await s.saveRoutine(routine('a', 1));
    await s.saveRoutine(routine('c', 3));
    expect((await s.listRoutines()).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('루틴을 지운다', async () => {
    await s.saveRoutine(routine('a', 1));
    await s.saveRoutine(routine('b', 2));
    await s.deleteRoutine('a');
    expect((await s.listRoutines()).map((r) => r.id)).toEqual(['b']);
  });

  it('같은 id 세션을 두 번 저장하면 1개이고 나중 값이다', async () => {
    await s.saveSession(session('x', 100, false));
    await s.saveSession(session('x', 200, true));
    const list = await s.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.endedAt).toBe(200);
    expect(list[0]!.completed).toBe(true);
  });

  it('세션 목록은 endedAt 내림차순이다', async () => {
    await s.saveSession(session('a', 100));
    await s.saveSession(session('b', 300));
    await s.saveSession(session('c', 200));
    expect((await s.listSessions()).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('없는 세션 id는 null이다', async () => {
    expect(await s.getSession('none')).toBeNull();
    await s.saveSession(session('a', 1));
    expect((await s.getSession('a'))?.id).toBe('a');
  });

  it('저장한 객체를 밖에서 바꿔도 저장된 값은 그대로다', async () => {
    const r = routine('a', 1);
    await s.saveRoutine(r);
    r.name = '바뀜';
    const got = await s.listRoutines();
    expect(got[0]!.name).toBe('루틴 a');
    got[0]!.name = '또 바뀜';
    expect((await s.listRoutines())[0]!.name).toBe('루틴 a');

    const ss = session('s', 1);
    await s.saveSession(ss);
    ss.routineName = '바뀜';
    const g = await s.getSession('s');
    expect(g?.routineName).toBe('루틴 r1');
    g!.routineName = '또 바뀜';
    expect((await s.getSession('s'))?.routineName).toBe('루틴 r1');
  });
});

describe('idb 영속성', () => {
  it('DB를 다시 열어도 데이터가 남는다', async () => {
    globalThis.indexedDB = new IDBFactory();
    const a = createIdbStorage('persist-db');
    await a.saveRoutine(routine('a', 1));
    await a.saveSession(session('s', 5));
    const b = createIdbStorage('persist-db');
    expect((await b.listRoutines()).map((r) => r.id)).toEqual(['a']);
    expect((await b.getSession('s'))?.endedAt).toBe(5);
  });
});
