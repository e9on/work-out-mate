/** Electron preload가 노출하는 객체. 브라우저·Capacitor에서는 없다. */
interface Window {
  wom?: {
    isElectron: boolean;
    selftest: boolean;
    onRecordingSaved(cb: (r: { ok: boolean; path: string; error?: string }) => void): void;
  };
}
