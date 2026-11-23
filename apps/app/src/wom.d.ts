/** Electron preload가 노출하는 객체. 브라우저·Android(Capacitor)에서는 없다. */
interface Window {
  wom?: {
    isElectron: boolean;
    selftest: boolean;
  };
}
