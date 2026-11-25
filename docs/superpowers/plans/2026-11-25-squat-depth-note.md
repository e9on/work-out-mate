# 스쿼트 깊이 세트 조언(3D) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스쿼트 깊이를 반복별 "오류 지적"에서 빼고, 반복 카운터의 3D 무릎 각도 최저점으로 "덜 앉았어요" 세트 조언을 낸다.

**Architecture:**
- core `RepEngine`이 반복마다 신호 최저점(valley)을 `RepEvent.valley`로 내보낸다.
- `SetRunner`가 이 값을 `RepTiming.bottomSignal`로 세트 기록에 남긴다. 스쿼트의 신호는 MediaPipe world 3D 무릎 각도다.
- `computeSquatRepMetrics`는 이 값을 `depth3d`로 옮긴다.
- `judgeSquat`는 depth 지적 대신 `shallow` 조언을 만들고, 무릎 모임 판정을 건너뛸지도 3D 값을 우선해 정한다.
- 앱은 문구만 더한다.

**Tech Stack:** TypeScript, vitest (packages/core, apps/app), React

**Spec:** `docs/specs/2026-11-25-squat-depth-note-design.md`

## Global Constraints

- 기준값: `SQUAT_RULES.shallowKneeDeg3d = 83`. 판정은 `depth3d > 83`이면 덜 앉음이다(83은 포함하지 않음).
- 카운터 동작(반복을 세는 조건)은 바꾸지 않는다. `RepEvent`·`RepTiming`에 값만 더한다.
- 조언 문구(정확히): `이번 세트는 {total}회 중 {count}회를 덜 앉았어요. 허벅지가 바닥과 평행해질 때까지 앉아 보세요`
- `count`가 0이면 조언을 내지 않는다. `total`은 `depth3d`가 있는(null이 아닌) 반복 수다.
- 옛 기록·옛 분석과 호환해야 한다.
  - `RepTiming.bottomSignal`과 `SquatRepMetrics.depth3d`는 선택 필드(`?:`)다.
  - `FindingKind`의 `'depth'`와 `FINDING_PHRASES.depth`는 저장된 옛 분석을 표시하려고 남긴다.
- 수동 오류 라벨 `ManualErrorKind`의 `'depth'`('깊이 부족')는 그대로 둔다.
- 개인 녹화(`packages/core/test/fixtures/private/`)를 쓰는 시험은 파일이 없으면 건너뛴다(`describe.skipIf`). 이 폴더는 git에 넣지 않는다.
- 사용자에게 보이는 글, 주석, 커밋 메시지는 한국어로 쓴다.

## Review Focus

1. 세트 안 일부 반복만 `bottomSignal`이 있을 때(옛 기록과 섞임) → `total`은 값이 있는 반복만 센다. 값이 없는 반복의 무릎 모임 판정은 2D 기준으로 건너뛴다. (Task 2 시험)
2. 2D로는 `skipped`인 반복(noPerson·oneLeg)도 3D 값이 있으면 깊이 조언 집계에 넣는다. 깊이 조언은 2D 판정과 상관없다. (Task 2 시험)
3. 반복 되돌리기(undo) 뒤에도 `reps`와 `bottomSignal`이 같은 반복끼리 맞게 남아야 한다. (Task 1 시험)
4. `restSide: 'low'` 운동(negative)의 valley는 신호 원래 단위로 나와야 한다(내부 부호 적용 전 값). (Task 1 시험)
5. 옛 분석(findings에 depth가 있고 notes에 shallow가 없음)을 열어도 화면이 깨지지 않아야 한다. (Task 3 시험)

---

### Task 1: 반복 최저점을 세트 기록까지 전달 (core)

**Files:**
- Modify: `packages/core/src/counter/repEngine.ts` (`RepEvent`, `finish`)
- Modify: `packages/core/src/session/model.ts` (`RepTiming`)
- Modify: `packages/core/src/session/setRunner.ts:433` (reps 변환)
- Test: `packages/core/test/repEngine.test.ts`, `packages/core/test/setRunner.test.ts`

**Interfaces:**
- Produces:
  - `RepEvent.valley: number`: 그 반복의 신호 최저점, 원래 신호 단위다. 'high' 운동은 최소값, 'low' 운동은 최대값이다.
  - `RepTiming.bottomSignal?: number`: SetRunner가 채우고, 'reps' 운동이면 항상 들어 있다.
  - `routineRunner`는 `...x`로 복사하므로 자동으로 따라간다. 시각 필드만 epoch로 바뀌는지 확인한다.

- [ ] **Step 1: 실패하는 시험**
  - `repEngine.test.ts`
    - `it('RepEvent.valley는 반복 중 신호 최저점')`
      - 'high' 설정에서 170→100→95→120→170으로 한 반복을 돌린다.
      - `ev.valley === 95`
    - `it("restSide 'low'면 valley는 원래 단위의 최대점")`
      - 기존 low 시험 패턴으로 한 반복을 돌린다.
      - 신호 최고값이 그대로 `ev.valley`로 나와야 한다.
  - `setRunner.test.ts`
    - `it('세트 결과 reps에 bottomSignal이 반복별 최저점으로 들어간다')`
      - 두 반복의 최저점을 각각 90, 80으로 만든다.
      - `result.reps.map(r => r.bottomSignal)`이 `[90, 80]`이어야 한다.
    - 같은 파일에 되돌리기 시험을 하나 더 둔다.
      - 반복 3회 뒤 되돌리기 1회를 한다.
      - 남은 `reps`의 `bottomSignal`이 첫 두 반복 값이어야 한다.
- [ ] **Step 2:** `npm test -w packages/core -- repEngine setRunner`를 실행한다. 새 시험이 FAIL해야 한다.
- [ ] **Step 3: 구현**
  - `RepEngine.finish`에서 `valley: this.valley * restSign(this.cfg.restSide)`를 넣는다.
    - 내부 값이 부호를 곱한 값이면 원래 단위로 되돌린다. 실제 내부 표현을 확인하고 맞춘다.
  - `RepTiming`에 `bottomSignal?: number`를 더한다. 주석: 반복 카운터 신호 최저점이고, 스쿼트는 MediaPipe world 3D 무릎 각도다.
  - `setRunner.ts:433`에서 `bottomSignal: r.valley`를 넣는다.
- [ ] **Step 4:** `npm test -w packages/core`를 실행한다. 전부 PASS해야 하고, `npm run typecheck -w packages/core`도 통과해야 한다(스크립트 이름은 package.json에서 확인).
- [ ] **Step 5:** 커밋한다. 메시지는 `feat(core): 반복 카운터 신호 최저점을 RepEvent.valley·RepTiming.bottomSignal로 남긴다`

### Task 2: 깊이를 세트 조언으로 옮기기 (core 판정)

**Files:**
- Modify: `packages/core/src/form/squatRules.ts` (`SQUAT_RULES`, `SquatRepMetrics`, `SetNote`, `computeSquatRepMetrics`, `judgeSquat`, `SQUAT_ENABLED`)
- Test: `packages/core/test/squatRules.test.ts`
- Create: `packages/core/test/depthNote.private.test.ts` (개인 녹화 기준값 확인)

**Interfaces:**
- Consumes: `RepTiming.bottomSignal?: number` (Task 1), `replay(id, frames)`의 `reps[].valley` (Task 1)
- Produces:
  - `SQUAT_RULES.shallowKneeDeg3d: 83`
  - `SquatRepMetrics.depth3d?: number | null`: `rep.bottomSignal ?? null`. skipped 반복에도 채운다.
  - `SetNote = { kind: 'fastDescent'; avgDescentMs: number } | { kind: 'shallow'; count: number; total: number }`
  - `judgeSquat`는 `'depth'` finding을 만들지 않는다.
  - `SQUAT_ENABLED.depth`는 `false`로 두고 주석을 단다: 깊이는 notes로 옮김, kind는 옛 분석 표시용.

- [ ] **Step 1: 실패하는 시험** (`squatRules.test.ts`)
  - `it('depth3d 83 초과 반복 수로 shallow note를 만든다')`
    - depth3d가 `[60, 83, 84, 95]`면 `notes`에 `{ kind: 'shallow', count: 2, total: 4 }`가 있어야 한다.
  - `it('덜 앉은 반복이 없으면 shallow note가 없다')`
    - depth3d가 `[60, 70]`이면 shallow note가 없어야 한다.
  - `it('depth3d가 없는 반복은 total에서 빠진다')`
    - depth3d가 `[90, null, undefined]`면 `{ count: 1, total: 1 }`이어야 한다.
  - `it('2D로 skipped인 반복도 depth3d가 있으면 집계한다')`
    - skipped `'noPerson'`이고 depth3d 90이면 count 1이어야 한다.
  - `it('depth finding은 만들지 않는다')`
    - 2D `kneeDeg` 120(옛 기준 100 초과)이어도 findings에 `kind 'depth'`가 없어야 한다.
  - `it('무릎 모임 판정 건너뛰기는 depth3d가 있으면 3D 기준')`
    - depth3d 90, 2D kneeDeg 70, kneeAnkleRatio 0.5면 kneeIn finding이 없어야 한다.
    - depth3d 60, 2D kneeDeg 120, ratio 0.5면 kneeIn finding이 있어야 한다.
  - `it('depth3d가 없으면 지금처럼 2D 100° 기준으로 건너뛴다')`
    - depth3d 없음, kneeDeg 120, ratio 0.5면 kneeIn이 없어야 한다.
  - `it('computeSquatRepMetrics는 rep.bottomSignal을 depth3d로 옮긴다')`
    - bottomSignal 77이면 `depth3d === 77`, 없으면 `null`이어야 한다.
  - 기존 시험 가운데 depth finding을 기대하던 것은 새 동작에 맞게 고친다. 고친 이유를 시험 이름이나 주석에 남긴다.
  - fastDescent 조언과 shallow 조언이 같이 나올 때 순서: `[fastDescent, shallow]`
- [ ] **Step 2:** `npm test -w packages/core -- squatRules`를 실행한다. FAIL해야 한다.
- [ ] **Step 3: 구현**
  - 무릎 모임을 건너뛸지는 이렇게 정한다.
    - `m.depth3d != null`이면 `m.depth3d > R.shallowKneeDeg3d`
    - 아니면 `m.kneeDeg !== null && m.kneeDeg > R.depthMaxKneeDeg`
  - `depthMaxKneeDeg`는 이제 이 대체 판정에만 쓴다. 주석을 그렇게 고친다.
- [ ] **Step 4: 개인 녹화 기준값 확인 시험** (`depthNote.private.test.ts`)
  - 파일이 없으면 `describe.skipIf`로 건너뛴다.
  - 각 녹화를 `replay('squat', frames)`로 돌려 `reps[].valley`를 얻는다. 값이 83을 넘는 반복 수를 센다.
  - 기대값(spec 2절 표):

| 녹화 | 반복 수 | 83 초과 |
|---|---|---|
| `depth3d/wom-squat-lite-20261125-161243.json` (정상) | 10 | 0 |
| `depth3d/wom-squat-lite-20261125-161410.json` (경계) | 10 | 0 |
| `depth3d/wom-squat-lite-20261125-161325.json` (하프) | 6 | 6 |
| `angle-test/diag45-12.json` | 12 | 0 |
| `angle-test/diag45.json` | 6 | 0 |

- [ ] **Step 5:** `npm test -w packages/core`를 실행한다. 전부 PASS해야 한다(개인 녹화 시험 포함). typecheck도 통과해야 한다.
- [ ] **Step 6:** 커밋한다. 메시지는 `feat(core): 스쿼트 깊이를 지적에서 빼고 3D 최저점 83° 기준 shallow 세트 조언으로`

### Task 3: 앱 문구와 표시 (apps/app)

**Files:**
- Modify: `apps/app/src/domain/formPhrases.ts` (`notePhrase`)
- Test: `apps/app/test/FormFindings.test.tsx` (그리고 formPhrases 시험이 있으면 그 파일)

**Interfaces:**
- Consumes: `SetNote` 합집합(Task 2)

- [ ] **Step 1: 실패하는 시험**
  - `notePhrase({ kind: 'shallow', count: 4, total: 10 })`는 `'이번 세트는 10회 중 4회를 덜 앉았어요. 허벅지가 바닥과 평행해질 때까지 앉아 보세요'`여야 한다.
  - fastDescent 문구는 그대로여야 한다.
  - FormFindings에 `notes: [{ kind: 'shallow', count: 4, total: 10 }]`인 분석을 주면, ⓘ 줄에 위 문구가 보여야 한다. 지적 없음 문구('자세 지적 없음')는 보이지 않아야 한다(기존 규칙: findings와 notes가 모두 비었을 때만 표시).
  - 옛 분석 호환: findings에 `{ kind: 'depth' }`가 있고 notes가 비어 있으면, 기존 depth 문구가 그대로 표시돼야 한다.
- [ ] **Step 2:** `npm test -w apps/app -- FormFindings formPhrases`를 실행한다. FAIL해야 한다.
- [ ] **Step 3: 구현**
  - `notePhrase`를 `n.kind`로 나눠 처리한다(switch). 모든 kind를 다 다뤘는지 타입 검사가 확인하게 한다(exhaustive).
- [ ] **Step 4:** `npm test -w apps/app`과 `npm run build -w apps/app`을 실행한다. 둘 다 통과해야 한다.
- [ ] **Step 5:** 커밋한다. 메시지는 `feat(app): 스쿼트 덜 앉음 세트 조언 문구`
