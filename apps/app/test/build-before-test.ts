import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export default async function setup(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    await build({ root, logLevel: 'warn' });
  } catch (e) {
    throw new Error(`CSP 테스트용 빌드에 실패했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
}
