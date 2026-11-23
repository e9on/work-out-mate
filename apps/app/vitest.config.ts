import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    // csp.test.ts가 빌드 산출물(dist/index.html)을 검사하므로, 테스트 전에 한 번 빌드한다.
    globalSetup: ['./test/build-before-test.ts'],
  },
});
