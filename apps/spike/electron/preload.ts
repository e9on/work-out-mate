// 샌드박스 preload. 화면 코드에는 아래 최소 정보만 노출한다(Node API는 노출하지 않는다).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('wom', {
  isElectron: true,
  selftest: process.argv.includes('--wom-selftest'),
  /** main이 녹화 파일을 실제로 저장한 뒤 경로(또는 오류)를 알려 준다. */
  onRecordingSaved(cb: (r: { ok: boolean; path: string; error?: string }) => void): void {
    ipcRenderer.on('wom:recording-saved', (_e, r) => cb(r));
  },
});
