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
console.log(JSON.stringify({ exercise: id, count: r.count, heldMs: r.heldMs, reps: r.reps }));
