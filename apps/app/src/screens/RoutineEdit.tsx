import { useRef, useState } from 'react';
import type { ExerciseId, Routine } from '@wom/core';
import type { Storage } from '../ports/storage';
import { EXERCISE_IDS, EXERCISE_NAMES, newRoutine, validateRoutine } from '../domain/validate';

export type RoutineEditProps = {
  storage: Storage;
  routine?: Routine;
  nextOrder: number;
  onDone: () => void;
  now?: () => number;
  makeId?: () => string;
};

/** 입력 중에는 문자열로 들고 있다가 저장할 때 숫자로 바꾼다. */
type Row = { exercise: ExerciseId; sets: string; value: string; restSec: string };

const isHold = (id: ExerciseId) => id === 'deadHang';
const defaultValue = (id: ExerciseId) => (isHold(id) ? '30' : '10');
const newRow = (id: ExerciseId): Row => ({ exercise: id, sets: '3', value: defaultValue(id), restSec: '60' });

/** 빈칸은 NaN이 되어 검증에서 걸린다. */
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

function toRows(r?: Routine): Row[] {
  return (r?.exercises ?? []).map((e) => ({
    exercise: e.exercise,
    sets: String(e.sets),
    value: String(e.target.kind === 'reps' ? e.target.reps : e.target.seconds),
    restSec: String(e.restSec),
  }));
}

export function RoutineEdit({ storage, routine, nextOrder, onDone, now = Date.now, makeId = () => crypto.randomUUID() }: RoutineEditProps) {
  const [name, setName] = useState(routine?.name ?? '');
  const [rows, setRows] = useState<Row[]>(() => toRows(routine));
  const [toAdd, setToAdd] = useState<ExerciseId>('squat');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // 새 루틴 id는 한 번만 만든다(저장을 여러 번 눌러도 같은 id로 덮어쓴다).
  const [id] = useState(() => routine?.id ?? makeId());

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d;
      if (j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      const a = next[i]!;
      next[i] = next[j]!;
      next[j] = a;
      return next;
    });
  const changeExercise = (i: number, id: ExerciseId) =>
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        // 반복형 ↔ 매달리기로 바뀌면 목표 종류가 달라지므로 기본값으로 되돌린다.
        return isHold(r.exercise) === isHold(id) ? { ...r, exercise: id } : { ...r, exercise: id, value: defaultValue(id) };
      }),
    );

  /** 진행 중 중복 실행을 막고, 실패하면 오류 문구를 보인 뒤 다시 누를 수 있게 한다. */
  const guarded = async (op: () => Promise<void>, failText: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await op();
    } catch {
      setErrors([failText]);
      busyRef.current = false;
      setBusy(false);
      return;
    }
    onDone();
  };

  const save = async () => {
    const base = routine ?? newRoutine(name, nextOrder, now(), id);
    const candidate: Routine = {
      ...base,
      name: name.trim(),
      updatedAt: now(),
      exercises: rows.map((r) => ({
        exercise: r.exercise,
        sets: num(r.sets),
        target: isHold(r.exercise) ? { kind: 'seconds', seconds: num(r.value) } : { kind: 'reps', reps: num(r.value) },
        restSec: num(r.restSec),
      })),
    };
    const errs = validateRoutine(candidate);
    setErrors(errs);
    if (errs.length > 0) return;
    await guarded(async () => {
      await storage.saveRoutine(candidate);
    }, '저장하지 못했어요. 다시 시도해 주세요.');
  };

  const remove = async () => {
    if (!routine) return;
    setConfirming(false);
    await guarded(async () => {
      await storage.deleteRoutine(routine.id);
    }, '삭제하지 못했어요. 다시 시도해 주세요.');
  };

  return (
    <main className="app routine-edit">
      <h1 className="app-title">{routine ? '루틴 편집' : '새 루틴'}</h1>

      <label className="field">
        <span>루틴 이름</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <ol className="edit-list">
        {rows.map((r, i) => {
          const n = i + 1;
          const hold = isHold(r.exercise);
          return (
            <li key={i} className="edit-row">
              <label className="field">
                <span>{n}번 운동</span>
                <select value={r.exercise} onChange={(e) => changeExercise(i, e.target.value as ExerciseId)}>
                  {EXERCISE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {EXERCISE_NAMES[id]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{n}번 세트</span>
                <input type="number" step={1} value={r.sets} onChange={(e) => update(i, { sets: e.target.value })} />
              </label>
              <label className="field">
                <span>{hold ? `${n}번 초` : `${n}번 횟수`}</span>
                <input type="number" step={1} value={r.value} onChange={(e) => update(i, { value: e.target.value })} />
              </label>
              <label className="field">
                <span>{n}번 쉬는 시간(초)</span>
                <input type="number" step={1} value={r.restSec} onChange={(e) => update(i, { restSec: e.target.value })} />
              </label>
              <div className="edit-actions">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)}>
                  {n}번 위로
                </button>
                <button type="button" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                  {n}번 아래로
                </button>
                <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  {n}번 제거
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="add-row">
        <label className="field">
          <span>추가할 운동</span>
          <select value={toAdd} onChange={(e) => setToAdd(e.target.value as ExerciseId)}>
            {EXERCISE_IDS.map((id) => (
              <option key={id} value={id}>
                {EXERCISE_NAMES[id]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setRows((rs) => [...rs, newRow(toAdd)])}>
          운동 추가
        </button>
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="error-list">
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <div className="edit-footer">
        <button type="button" className="primary" disabled={busy} onClick={save}>
          저장
        </button>
        <button type="button" onClick={onDone}>
          편집 취소
        </button>
        {routine && (
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            루틴 삭제
          </button>
        )}
      </div>

      {confirming && (
        <div className="dialog-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="del-title" className="dialog">
            <p id="del-title">이 루틴을 삭제할까요? 되돌릴 수 없어요.</p>
            <button type="button" className="danger" onClick={remove}>
              삭제
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              취소
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
