import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// 스파이크용.
// - dev     : PC에서 http://localhost:5173
// - dev:lan : 같은 Wi-Fi의 폰에서 https://<PC IP>:5174 (폰 카메라는 HTTPS가 필요해서 개발용 임시 인증서를 쓴다)
export default defineConfig(({ mode }) =>
  mode === 'lan'
    ? { plugins: [basicSsl()], server: { host: true, port: 5174, strictPort: true } }
    : { server: { port: 5173, strictPort: true } },
);
