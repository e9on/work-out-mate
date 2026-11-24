import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Routine, WorkoutSession } from '@wom/core';
import type { AppSettings, CaptureMeta, RepLabel, SetAnalysis, SetVideo, VideoClip } from '../form/types';
import type { Storage } from '../ports/storage';

interface WomDB extends DBSchema {
  routines: { key: string; value: Routine };
  sessions: { key: string; value: WorkoutSession; indexes: { endedAt: number } };
  videos: { key: string; value: SetVideo };
  clips: { key: string; value: VideoClip; indexes: { setKey: string } };
  analyses: { key: string; value: SetAnalysis; indexes: { sessionId: string } };
  labels: { key: string; value: RepLabel; indexes: { sessionId: string } };
  captureMeta: { key: string; value: CaptureMeta };
  settings: { key: string; value: AppSettings };
}

export const WOM_DB_VERSION = 2;

/** 두 저장소(Storage·MediaStore)가 함께 쓰는 DB 열기. 버전 1 데이터는 그대로 두고 새 store만 만든다. */
export function openWomDb(dbName = 'work-out-mate'): Promise<IDBPDatabase<WomDB>> {
  return openDB<WomDB>(dbName, WOM_DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore('routines', { keyPath: 'id' });
        const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('endedAt', 'endedAt');
      }
      if (oldVersion < 2) {
        database.createObjectStore('videos', { keyPath: 'key' });
        database.createObjectStore('clips', { keyPath: 'key' }).createIndex('setKey', 'setKey');
        database.createObjectStore('analyses', { keyPath: 'key' }).createIndex('sessionId', 'sessionId');
        database.createObjectStore('labels', { keyPath: 'key' }).createIndex('sessionId', 'sessionId');
        database.createObjectStore('captureMeta', { keyPath: 'sessionId' });
        database.createObjectStore('settings');
      }
    },
  });
}

/** IndexedDB 저장소. DB는 처음 쓸 때 연다. 저장할 때 복사해 넣고, 읽을 때는 새 객체가 나온다. */
export function createIdbStorage(dbName = 'work-out-mate'): Storage {
  let dbPromise: Promise<IDBPDatabase<WomDB>> | null = null;
  const db = () => (dbPromise ??= openWomDb(dbName));

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
