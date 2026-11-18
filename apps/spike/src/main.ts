import { createTracker, EXERCISES, type ExerciseId, type TrackerState } from '@wom/core';
import { createLandmarker, detect, drawPose, type Delegate, type Landmarker, type ModelName } from './pose';
import { Recorder, downloadRecording } from './recorder';
import { Hud, Stat } from './hud';
import { listVoices, onVoicesChanged, speak } from './speech';

// MediaPipe 1.2.3 내부 로거가 https://odml.pa.googleapis.com/v1/log 로 fetch를 보낸다.
// 옵션으로 끌 방법이 없어서(조사 결과는 task-8-report.md) 이 주소로 가는 fetch는 막는다.
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('odml.pa.googleapis.com')) return Promise.reject(new TypeError('blocked: mediapipe telemetry'));
  return realFetch(input, init);
};

const KO_NAMES: Record<ExerciseId, string> = {
  squat: '스쿼트',
  pushup: '푸시업',
  dumbbellBench: '덤벨 벤치프레스',
  pullup: '풀업',
  negative: '네거티브(내려오기)',
  deadHang: '데드 행(매달리기)',
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const canvas = $<HTMLCanvasElement>('overlay');
const ctx = canvas.getContext('2d')!;
const exerciseSel = $<HTMLSelectElement>('exercise');
const modelSel = $<HTMLSelectElement>('model');
const delegateSel = $<HTMLSelectElement>('delegate');
const startBtn = $<HTMLButtonElement>('start');
const recBtn = $<HTMLButtonElement>('rec');
const ttsBtn = $<HTMLButtonElement>('tts');
const hud = new Hud($('big'), $('hud'));

for (const id of Object.keys(EXERCISES) as ExerciseId[]) {
  exerciseSel.add(new Option(KO_NAMES[id], id));
}

let tracker = createTracker(exerciseSel.value as ExerciseId);
let state: TrackerState = tracker.state();
let lm: Landmarker | null = null;
let note = '';
let busy = false; // 추론 중 (재생성 포함)
let generation = 0; // 설정을 바꿀 때마다 올려 이전 비동기 결과를 버린다
let skipped = 0;
let lastT = 0;
const inferMs = new Stat(120);
const doneTimes: number[] = []; // 최근 1초 처리 프레임 시각
const recorder = new Recorder();
let voices = listVoices();

async function rebuild(): Promise<void> {
  const gen = ++generation;
  const model = modelSel.value as ModelName;
  const delegate = delegateSel.value as Delegate;
  const old = lm;
  lm = null; // 루프가 이전 랜드마커를 쓰지 않게
  old?.landmarker.close();
  tracker = createTracker(exerciseSel.value as ExerciseId);
  state = tracker.state();
  inferMs.clear();
  doneTimes.length = 0;
  skipped = 0;
  note = `${model} 모델 로딩 중...`;
  refreshHud();
  try {
    const made = await createLandmarker(model, delegate);
    if (gen !== generation) {
      made.landmarker.close();
      return;
    }
    lm = made;
    lastT = 0;
    note = made.fellBack ? 'GPU 생성 실패 -> CPU로 자동 전환' : '';
    if (made.fellBack) delegateSel.value = 'CPU';
  } catch (e) {
    if (gen === generation) note = `랜드마커 생성 실패: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (gen === generation) refreshHud();
  }
}

function refreshHud(): void {
  const now = performance.now();
  while (doneTimes.length && now - doneTimes[0]! > 1000) doneTimes.shift();
  hud.render({
    state,
    kind: EXERCISES[exerciseSel.value as ExerciseId].kind,
    fps: doneTimes.length,
    avgMs: inferMs.avg(),
    p95Ms: inferMs.p95(),
    delegate: lm ? lm.delegate : '-',
    note,
    recFrames: recorder.recording ? recorder.length : null,
    voices,
    skipped,
  });
}

function onFrame(): void {
  schedule();
  if (video.readyState < 2) return;
  if (!lm) return;
  if (busy) {
    skipped++;
    return;
  }
  busy = true;
  try {
    // detectForVideo는 동기 호출이라 busy는 재진입 방어용이다. 타임스탬프는 단조 증가여야 한다.
    const t = Math.max(performance.now(), lastT + 0.001);
    lastT = t;
    const t0 = performance.now();
    const frame = detect(lm.landmarker, video, t);
    inferMs.add(performance.now() - t0);
    state = tracker.push(frame);
    recorder.add(frame);
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    drawPose(ctx, frame, canvas.width, canvas.height);
    doneTimes.push(performance.now());
  } catch (e) {
    note = `추론 오류: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy = false;
  }
  refreshHud();
}

function schedule(): void {
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame(onFrame);
}

startBtn.onclick = async () => {
  startBtn.disabled = true;
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    await video.play();
    recBtn.disabled = false;
    startBtn.textContent = '카메라 켜짐';
    await rebuild();
    schedule();
  } catch (e) {
    note = `카메라 실패: ${e instanceof Error ? e.message : String(e)}`;
    startBtn.disabled = false;
    refreshHud();
  }
};

for (const sel of [exerciseSel, modelSel, delegateSel]) {
  sel.onchange = () => {
    if (recorder.recording) stopRecording(); // 설정이 바뀌면 녹화 파일의 운동/모델 값이 어긋나므로 먼저 저장
    void rebuild();
  };
}

// 녹화 중 운동/모델을 바꾸면 이전 값으로 저장해야 해서 값을 시작 시점에 고정해 둔다.
let recMeta: { exercise: ExerciseId; model: ModelName } | null = null;

function stopRecording(): void {
  if (!recMeta) return;
  const file = recorder.stop(recMeta.exercise, recMeta.model);
  recMeta = null;
  recBtn.textContent = '녹화 시작';
  if (file.frames.length === 0) {
    note = '녹화된 프레임이 없어 저장하지 않음';
    return;
  }
  const name = downloadRecording(file);
  note = `저장: ${name} (${file.frames.length}프레임)`;
}

recBtn.onclick = () => {
  if (recorder.recording) {
    stopRecording();
  } else {
    recMeta = { exercise: exerciseSel.value as ExerciseId, model: modelSel.value as ModelName };
    recorder.start();
    recBtn.textContent = '녹화 정지 및 저장';
  }
  refreshHud();
};

ttsBtn.onclick = async () => {
  const r = await speak('하나, 둘, 셋. 좋아요!');
  note = r === 'ok' ? '음성 재생 완료' : '한국어 음성을 쓸 수 없음 (unsupported)';
  refreshHud();
};

onVoicesChanged(() => {
  voices = listVoices();
  refreshHud();
});

refreshHud();
