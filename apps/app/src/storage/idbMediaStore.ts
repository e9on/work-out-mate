import { DEFAULT_SETTINGS, type AppSettings } from '../form/types';
import type { MediaStore } from '../ports/mediaStore';
import { openWomDb } from './idbStorage';

const byKey = <T extends { key: string }>(items: T[]) => items.sort((a, b) => (a.key < b.key ? -1 : 1));

/** IndexedDB MediaStore. DB는 처음 쓸 때 열며, createIdbStorage와 같은 openWomDb를 쓴다. */
export function createIdbMediaStore(dbName = 'work-out-mate'): MediaStore {
  let dbPromise: ReturnType<typeof openWomDb> | null = null;
  const db = () => (dbPromise ??= openWomDb(dbName));

  return {
    async putVideo(v) {
      await (await db()).put('videos', v);
    },
    async getVideo(key) {
      return (await (await db()).get('videos', key)) ?? null;
    },
    async deleteVideo(key) {
      await (await db()).delete('videos', key);
    },
    async listVideoKeys() {
      return (await (await db()).getAllKeys('videos')).sort();
    },
    async putClip(c) {
      await (await db()).put('clips', c);
    },
    async getClip(key) {
      return (await (await db()).get('clips', key)) ?? null;
    },
    async listClips(setKey) {
      const all = await (await db()).getAllFromIndex('clips', 'setKey', setKey);
      return all.sort((a, b) => a.index - b.index);
    },
    async deleteClipsOfSet(setKey) {
      const tx = (await db()).transaction('clips', 'readwrite');
      const keys = await tx.store.index('setKey').getAllKeys(setKey);
      await Promise.all([...keys.map((k) => tx.store.delete(k)), tx.done]);
    },
    async putAnalysis(a) {
      await (await db()).put('analyses', a);
    },
    async getAnalysis(key) {
      return (await (await db()).get('analyses', key)) ?? null;
    },
    async listAnalyses(sessionId) {
      return byKey(await (await db()).getAllFromIndex('analyses', 'sessionId', sessionId));
    },
    async putLabel(l) {
      await (await db()).put('labels', l);
    },
    async listLabels(sessionId) {
      return byKey(await (await db()).getAllFromIndex('labels', 'sessionId', sessionId));
    },
    async putCaptureMeta(m) {
      await (await db()).put('captureMeta', m);
    },
    async getCaptureMeta(sessionId) {
      return (await (await db()).get('captureMeta', sessionId)) ?? null;
    },
    async getSettings(): Promise<AppSettings> {
      return (await (await db()).get('settings', 'app')) ?? structuredClone(DEFAULT_SETTINGS);
    },
    async putSettings(s) {
      await (await db()).put('settings', s, 'app');
    },
    async usageBytes() {
      const d = await db();
      let n = 0;
      for (const store of ['videos', 'clips'] as const) {
        let c = await d.transaction(store).store.openCursor();
        while (c) {
          n += c.value.blob.size;
          c = await c.continue();
        }
      }
      return n;
    },
  };
}
