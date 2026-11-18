import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 스파이크용.
// - dev     : PC에서 http://localhost:5173
// - dev:lan : 같은 Wi-Fi의 폰에서 https://<PC IP>:5174 (폰 카메라는 HTTPS가 필요해서 개발용 임시 인증서를 쓴다)

const PRIVATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../packages/core/test/fixtures/private');
const NAME_RE = /^wom-[A-Za-z]+-(lite|full)-\d{8}-\d{6}\.json$/;
const MAX_BYTES = 50 * 1024 * 1024;

/** 개발 서버 전용: 폰에서 보낸 녹화 파일을 PC의 fixtures/private/ 에 저장한다. 빌드 결과물에는 들어가지 않는다. */
function receiveRecordings(): Plugin {
  return {
    name: 'wom-receive-recordings',
    configureServer(server) {
      server.middlewares.use('/__wom/recording', (req, res) => {
        const fail = (code: number, msg: string) => {
          res.statusCode = code;
          res.end(msg);
        };
        if (req.method !== 'POST') return fail(405, 'POST만 받아요');
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (!NAME_RE.test(name)) return fail(400, '파일 이름이 올바르지 않아요');
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            fail(413, '파일이 너무 커요');
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          if (res.writableEnded) return;
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(body) as { version?: unknown; frames?: unknown };
            if (parsed.version !== 1 || !Array.isArray(parsed.frames)) return fail(400, '녹화 파일 형식이 아니에요');
          } catch {
            return fail(400, 'JSON이 아니에요');
          }
          mkdirSync(PRIVATE_DIR, { recursive: true });
          writeFileSync(join(PRIVATE_DIR, name), body);
          server.config.logger.info(`[wom] 녹화 저장: ${name} (${(size / 1024).toFixed(0)}KB)`);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ saved: name }));
        });
      });
    },
  };
}

export default defineConfig(({ mode }) =>
  mode === 'lan'
    ? { plugins: [basicSsl(), receiveRecordings()], server: { host: true, port: 5174, strictPort: true } }
    : { plugins: [receiveRecordings()], server: { port: 5173, strictPort: true } },
);
