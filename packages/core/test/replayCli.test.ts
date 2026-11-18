import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const script = join(pkgDir, 'scripts', 'replay.ts');
const sample = join(here, 'fixtures', 'sample-squat-3.json');
const tsxPkg = createRequire(import.meta.url).resolve('tsx/package.json');
const tsxCli = join(dirname(tsxPkg), 'dist', 'cli.mjs');

function run(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], { cwd: pkgDir, encoding: 'utf8' });
}

describe('녹화 재생 CLI', () => {
  it('샘플 파일: 한 줄 JSON으로 3회를 센다', () => {
    const out = execFileSync(process.execPath, [tsxCli, script, sample], { cwd: pkgDir, encoding: 'utf8' });
    expect(out.trim().split('\n')).toHaveLength(1);
    const r = JSON.parse(out);
    expect(r.exercise).toBe('squat');
    expect(r.count).toBe(3);
    expect(r.heldMs).toBe(0);
    expect(r.reps).toHaveLength(3);
  });

  it('exerciseId 인자로 덮어쓴다', () => {
    const r = run([sample, 'pushup']);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.exercise).toBe('pushup');
    expect(j.count).toBe(0);
  });

  it('파일이 없으면 종료 코드 1과 한국어 오류', () => {
    const r = run([join(here, 'fixtures', 'nope.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('파일을 찾을 수 없어요');
  });

  it('잘못된 운동 id면 종료 코드 1과 한국어 오류', () => {
    const r = run([sample, 'zumba']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('운동');
  });

  it('인자가 없으면 사용법과 종료 코드 1', () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('사용법');
  });
});
