import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { relaxCspForDev } from './csp.ts';

/**
 * onnxruntime-web 번들이 폴백용으로 해시 이름의 wasm(약 21MB)을 dist/assets에 한 번 더 넣는다.
 * 실제 로딩 경로는 ort.env.wasm.wasmPaths = '/form/ort/'(public 사본)라 이 사본은 쓰이지 않으므로 빌드에서 뺀다.
 */
function dropOrtWasmDuplicate(): Plugin {
  return {
    name: 'drop-ort-wasm-duplicate',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/(^|\/)ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name];
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), relaxCspForDev(), dropOrtWasmDuplicate()],
  server: { port: 5175, strictPort: true },
});
