import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  execSync('npx vite build', { cwd: root, stdio: 'inherit' });
}
