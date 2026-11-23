import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { relaxCspForDev } from './csp.ts';

export default defineConfig({
  plugins: [react(), relaxCspForDev()],
  server: { port: 5175, strictPort: true },
});
