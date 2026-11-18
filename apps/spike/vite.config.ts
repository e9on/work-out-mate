import { defineConfig } from 'vite';

// 스파이크용. 폰(같은 Wi-Fi)에서도 열 수 있게 host 노출은 dev 스크립트의 --host로 한다.
export default defineConfig({
  server: { port: 5173, strictPort: true },
});
