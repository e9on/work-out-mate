// 샌드박스 preload. 화면 코드에는 아래 최소 정보만 노출한다(Node API·IPC는 노출하지 않는다).
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('wom', {
  isElectron: true,
  selftest: process.argv.includes('--wom-selftest'),
});
