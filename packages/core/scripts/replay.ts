import { readFileSync } from 'node:fs';
import { EXERCISES, replay, type ExerciseId, type RecordingFile } from '../src/index';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const [file, override] = process.argv.slice(2);
if (!file) fail('사용법: npm run replay -w packages/core -- <file.json> [exerciseId]');

let raw: string;
try {
  raw = readFileSync(file, 'utf8');
} catch {
  fail(`파일을 찾을 수 없어요: ${file}`);
}

let rec: RecordingFile;
try {
  rec = JSON.parse(raw) as RecordingFile;
} catch {
  fail(`JSON을 읽을 수 없어요: ${file}`);
}
if (!rec || !Array.isArray(rec.frames)) fail(`녹화 파일 형식이 아니에요(frames 배열이 없어요): ${file}`);

const id = override ?? rec.exercise;
if (!Object.hasOwn(EXERCISES, id)) {
  fail(`알 수 없는 운동이에요: ${id} (가능: ${Object.keys(EXERCISES).join(', ')})`);
}

const r = replay(id as ExerciseId, rec.frames);
// 기존 키(count, heldMs, reps)는 유지한다. 해당 없는 쪽은 0.
const out = { exercise: id, kind: r.kind, count: r.kind === 'reps' ? r.count : 0, heldMs: r.kind === 'hold' ? r.heldMs : 0, reps: r.reps, diagnosis: r.diagnosis };
console.log(JSON.stringify(out));
