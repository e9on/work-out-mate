import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replay } from '../src/exercises/runner';
import type { RecordingFile } from '../src/recording';
import { SQUAT_RULES } from '../src/form/squatRules';

// 개인 녹화(git에 없음)로 shallow 기준값 83°를 확인한다. 파일이 없으면 건너뛴다.
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'private');

const CASES: { file: string; label: string; reps: number; over: number }[] = [
  { file: 'depth3d/wom-squat-lite-20261125-161243.json', label: '정상', reps: 10, over: 0 },
  { file: 'depth3d/wom-squat-lite-20261125-161410.json', label: '경계', reps: 10, over: 0 },
  { file: 'depth3d/wom-squat-lite-20261125-161325.json', label: '하프', reps: 6, over: 6 },
  { file: 'angle-test/diag45-12.json', label: 'diag45-12', reps: 12, over: 0 },
  { file: 'angle-test/diag45.json', label: 'diag45', reps: 6, over: 0 },
];

for (const c of CASES) {
  const path = join(dir, c.file);
  describe.skipIf(!existsSync(path))(`깊이 기준값: ${c.label} (${c.file})`, () => {
    it(`반복 ${c.reps}개 중 valley > ${SQUAT_RULES.shallowKneeDeg3d}는 ${c.over}개`, () => {
      const rec = JSON.parse(readFileSync(path, 'utf8')) as RecordingFile;
      const res = replay('squat', rec.frames);
      const valleys = res.reps.map((r) => r.valley);
      const over = valleys.filter((v) => v > SQUAT_RULES.shallowKneeDeg3d).length;
      const msg = `valleys=${valleys.map((v) => v.toFixed(1)).join(',')}`;
      expect(res.reps.length, msg).toBe(c.reps);
      expect(over, msg).toBe(c.over);
    });
  });
}
