/**
 * 규칙 판정 기준선 실행기(실험 전용). core의 computeSquatRepMetrics + judgeSquat를 그대로 부른다.
 *
 * 입력 JSON: { sets: [{ file, kind: "mediapipe"|"halpe", frames: [{ t, kps: [[x,y,score]...]|null }],
 *              reps: [{ index, startT, bottomT, endT }] }] }
 *   녹화 한 개 = 세트 하나(서 있을 때 기준값을 세트 전체 프레임으로 구하므로 앱과 같은 방식).
 *   mediapipe는 33점(화소 좌표, score=visibility), halpe는 26점.
 * 출력 JSON: { sets: [{ file, reps: [{ index, kneeIn: 0|1, shallow: 0|1, skipped: null|"noPerson"|"oneLeg" }] }] }
 *   kneeIn = judge의 kneeIn 또는 kneeInRelative, shallow = 실험 당시 앱의 깊이 지적(2D 무릎 각도 > depthMaxKneeDeg).
 *
 * 실행: npx esbuild ml/rules/run_rules.ts --bundle --platform=node --outfile=ml/runs/rules/run_rules.cjs
 *       node ml/runs/rules/run_rules.cjs <in.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { HALPE, type Kp2, type KpFrame } from '../../packages/core/src/form/halpe';
import { SQUAT_RULES, computeSquatRepMetrics, judgeSquat } from '../../packages/core/src/form/squatRules';
import type { RepTiming } from '../../packages/core/src/session/model';

type RawFrame = { t: number; kps: number[][] | null };
type RawSet = { file: string; kind: 'mediapipe' | 'halpe'; frames: RawFrame[]; reps: RepTiming[] };

// MediaPipe 33점 -> Halpe 자리: 엉덩이 23/24 -> 11/12, 무릎 25/26 -> 13/14, 발목 27/28 -> 15/16,
// 뒤꿈치 29/30 -> 24/25, 엄지발가락(foot index) 31/32 -> 20/21
const MP_TO_HALPE: [number, number][] = [
  [23, HALPE.L_HIP], [24, HALPE.R_HIP], [25, HALPE.L_KNEE], [26, HALPE.R_KNEE],
  [27, HALPE.L_ANKLE], [28, HALPE.R_ANKLE], [29, HALPE.L_HEEL], [30, HALPE.R_HEEL],
  [31, HALPE.L_BIG_TOE], [32, HALPE.R_BIG_TOE],
];

function toKpFrame(f: RawFrame, kind: RawSet['kind']): KpFrame {
  if (f.kps === null) return { t: f.t, kps: null };
  const mk = (p: number[]): Kp2 => ({ x: p[0]!, y: p[1]!, score: p[2]! });
  if (kind === 'halpe') return { t: f.t, kps: f.kps.map(mk) };
  const kps: Kp2[] = Array.from({ length: 26 }, () => ({ x: 0, y: 0, score: 0 }));
  for (const [mp, h] of MP_TO_HALPE) kps[h] = mk(f.kps[mp]!);
  return { t: f.t, kps };
}

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('사용법: node run_rules.cjs <in.json> <out.json>');
  process.exit(2);
}
const input = JSON.parse(readFileSync(inPath, 'utf8')) as { sets: RawSet[] };
const sets = input.sets.map((s) => {
  const metrics = computeSquatRepMetrics(s.frames.map((f) => toKpFrame(f, s.kind)), s.reps);
  const j = judgeSquat(metrics, []);
  const has = (index: number, kinds: string[]) => (j.findings.some((f) => f.index === index && kinds.includes(f.kind)) ? 1 : 0);
  return {
    file: s.file,
    reps: metrics.map((m) => ({
      index: m.index,
      kneeIn: has(m.index, ['kneeIn', 'kneeInRelative']),
      // 앱은 2026-11-25부터 깊이를 반복 지적이 아닌 3D 세트 조언으로 바꿨다(이 입력엔 3D 값이 없음).
      // 실험 기준선은 실험 당시 앱 판정(2D 바닥 무릎 각도 > depthMaxKneeDeg면 깊이 지적)을 그대로 재현한다.
      shallow: !m.skipped && m.kneeDeg !== null && m.kneeDeg > SQUAT_RULES.depthMaxKneeDeg ? 1 : 0,
      skipped: m.skipped,
    })),
  };
});
writeFileSync(outPath, JSON.stringify({ sets }));
