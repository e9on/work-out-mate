import type { Routine, WorkoutSession } from '@wom/core';
import type { Storage } from '../ports/storage';

/** 테스트·폴백용 메모리 저장소. 저장할 때와 돌려줄 때 모두 복사한다. */
export function createMemoryStorage(): Storage {
  const routines = new Map<string, Routine>();
  const sessions = new Map<string, WorkoutSession>();
  return {
    async listRoutines() {
      return structuredClone([...routines.values()].sort((a, b) => a.order - b.order));
    },
    async saveRoutine(r) {
      routines.set(r.id, structuredClone(r));
    },
    async deleteRoutine(id) {
      routines.delete(id);
    },
    async listSessions() {
      return structuredClone([...sessions.values()].sort((a, b) => b.endedAt - a.endedAt));
    },
    async getSession(id) {
      const s = sessions.get(id);
      return s ? structuredClone(s) : null;
    },
    async saveSession(s) {
      sessions.set(s.id, structuredClone(s));
    },
  };
}
