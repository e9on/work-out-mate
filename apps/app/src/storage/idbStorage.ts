import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Routine, WorkoutSession } from '@wom/core';
import type { Storage } from '../ports/storage';

interface WomDB extends DBSchema {
  routines: { key: string; value: Routine };
  sessions: { key: string; value: WorkoutSession; indexes: { endedAt: number } };
}

/** IndexedDB 저장소. DB는 처음 쓸 때 연다. 저장할 때 복사해 넣고, 읽을 때는 새 객체가 나온다. */
export function createIdbStorage(dbName = 'work-out-mate'): Storage {
  let dbPromise: Promise<IDBPDatabase<WomDB>> | null = null;
  const db = () => {
    dbPromise ??= openDB<WomDB>(dbName, 1, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore('routines', { keyPath: 'id' });
          const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
          sessions.createIndex('endedAt', 'endedAt');
        }
      },
    });
    return dbPromise;
  };

  return {
    async listRoutines() {
      const all = await (await db()).getAll('routines');
      return all.sort((a, b) => a.order - b.order);
    },
    async saveRoutine(r) {
      await (await db()).put('routines', structuredClone(r));
    },
    async deleteRoutine(id) {
      await (await db()).delete('routines', id);
    },
    async listSessions() {
      const all = await (await db()).getAllFromIndex('sessions', 'endedAt');
      return all.reverse();
    },
    async getSession(id) {
      return (await (await db()).get('sessions', id)) ?? null;
    },
    async saveSession(s) {
      await (await db()).put('sessions', structuredClone(s));
    },
  };
}
