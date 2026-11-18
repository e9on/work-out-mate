import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { replay } from '../src/exercises/runner';
import type { ExerciseId } from '../src/exercises/runner';
import type { RecordingFile } from '../src/recording';

type ManifestEntry = {
  file: string;
  exercise: ExerciseId;
  expectedCount?: number;
  expectedHeldMs?: number;
  note: string;
};

const privateDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'private');
const manifestPath = join(privateDir, 'manifest.json');
const hasManifest = existsSync(manifestPath);

// 실제 녹화는 개인 신체 데이터라 git에 없다. manifest가 없는 PC·CI에서는 건너뛴다.
describe('합격 테스트 (실제 녹화)', () => {
  if (!hasManifest) {
    test.skip('manifest.json이 없어 건너뜀', () => {});
    return;
  }
  const manifest: ManifestEntry[] = JSON.parse(readFileSync(manifestPath, 'utf8'));

  for (const entry of manifest) {
    test(`${entry.file} (${entry.exercise})`, () => {
      const rec = JSON.parse(readFileSync(join(privateDir, entry.file), 'utf8')) as RecordingFile;
      const r = replay(entry.exercise, rec.frames);

      if (entry.expectedCount !== undefined) {
        expect(
          Math.abs(r.count - entry.expectedCount),
          `${entry.file}: 횟수 기대 ${entry.expectedCount}, 실제 ${r.count} (허용 ±1)`,
        ).toBeLessThanOrEqual(1);
      }
      if (entry.expectedHeldMs !== undefined) {
        expect(
          Math.abs(r.heldMs - entry.expectedHeldMs),
          `${entry.file}: 버틴 시간 기대 ${entry.expectedHeldMs}ms, 실제 ${r.heldMs}ms (허용 ±1000ms)`,
        ).toBeLessThanOrEqual(1000);
      }
    });
  }
});
