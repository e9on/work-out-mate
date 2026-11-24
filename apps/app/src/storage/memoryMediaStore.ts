import { DEFAULT_SETTINGS, type AppSettings, type CaptureMeta, type RepLabel, type SetAnalysis, type SetVideo, type VideoClip } from '../form/types';
import type { MediaStore } from '../ports/mediaStore';

/** Blob은 불변이라 복사하지 않고, 나머지 필드만 복사한다. */
const cloneWithBlob = <T extends { blob: Blob }>(v: T): T => {
  const { blob, ...rest } = v;
  return { ...structuredClone(rest), blob } as T;
};

/** 테스트·폴백용 메모리 MediaStore. */
export function createMemoryMediaStore(): MediaStore {
  const videos = new Map<string, SetVideo>();
  const clips = new Map<string, VideoClip>();
  const analyses = new Map<string, SetAnalysis>();
  const labels = new Map<string, RepLabel>();
  const metas = new Map<string, CaptureMeta>();
  let settings: AppSettings | null = null;
  const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : 1);
  return {
    async putVideo(v) {
      videos.set(v.key, cloneWithBlob(v));
    },
    async getVideo(key) {
      const v = videos.get(key);
      return v ? cloneWithBlob(v) : null;
    },
    async deleteVideo(key) {
      videos.delete(key);
    },
    async listVideoKeys() {
      return [...videos.keys()].sort();
    },
    async putClip(c) {
      clips.set(c.key, cloneWithBlob(c));
    },
    async getClip(key) {
      const c = clips.get(key);
      return c ? cloneWithBlob(c) : null;
    },
    async listClips(setKey) {
      return [...clips.values()].filter((c) => c.setKey === setKey).sort((a, b) => a.index - b.index).map(cloneWithBlob);
    },
    async deleteClipsOfSet(setKey) {
      for (const [k, c] of clips) if (c.setKey === setKey) clips.delete(k);
    },
    async putAnalysis(a) {
      analyses.set(a.key, structuredClone(a));
    },
    async getAnalysis(key) {
      const a = analyses.get(key);
      return a ? structuredClone(a) : null;
    },
    async listAnalyses(sessionId) {
      return structuredClone([...analyses.values()].filter((a) => a.sessionId === sessionId).sort(byKey));
    },
    async putLabel(l) {
      labels.set(l.key, structuredClone(l));
    },
    async listLabels(sessionId) {
      return structuredClone([...labels.values()].filter((l) => l.sessionId === sessionId).sort(byKey));
    },
    async putCaptureMeta(m) {
      metas.set(m.sessionId, structuredClone(m));
    },
    async getCaptureMeta(sessionId) {
      const m = metas.get(sessionId);
      return m ? structuredClone(m) : null;
    },
    async getSettings() {
      return structuredClone(settings ?? DEFAULT_SETTINGS);
    },
    async putSettings(s) {
      settings = structuredClone(s);
    },
    async usageBytes() {
      let n = 0;
      for (const v of videos.values()) n += v.blob.size;
      for (const c of clips.values()) n += c.blob.size;
      return n;
    },
  };
}
