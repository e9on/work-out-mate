import { createTracker, EXERCISES, type ExerciseId, type TrackerState } from '@wom/core';
import { createLandmarker, detect, drawPose, type Delegate, type Landmarker, type ModelName } from './pose';
import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Recorder, downloadRecording, isNativeApp, saveRecordingNative, sendRecordingToPc } from './recorder';
import { Hud, Stat } from './hud';
import { listNativeVoices, listVoices, onVoicesChanged, speak } from './speech';

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

// --- 진단 표시 (왜 안 세는지 확인용) ---
// 지금 신호값(스무딩 전), 이번 동작에서 가장 많이 굽힌 값, 운동 임계값, 좌우 관절 가시성을 보여 준다.
let diag = '';
let diagExtreme: number | null = null;
let diagCount = 0;
const VIS_IDX = { squat: [[23, 25, 27], [24, 26, 28]], arm: [[11, 13, 15], [12, 14, 16]] } as const;
function updateDiag(frame: import('@wom/core').PoseFrame): void {
  const id = exerciseSel.value as ExerciseId;
  const def = EXERCISES[id];
  const sides = id === 'squat' ? VIS_IDX.squat : VIS_IDX.arm;
  const vis = sides
    .map((ix, k) => `${k === 0 ? '왼' : '오'} ${ix.map((i) => (frame.image[i]?.visibility ?? 0).toFixed(2)).join('/')}`)
    .join('  ');
  if (def.kind !== 'reps') {
    const h = def.holding(frame);
    diag = `진단: 매달림 판정 ${h === null ? '안 보임' : h ? '예' : '아니오'}   가시성 ${vis}`;
    return;
  }
  const s = def.signal(frame);
  const restSide = def.adaptive ? def.adaptive.restSide : def.rep.restSide;
  if (state.count !== diagCount) {
    diagCount = state.count;
    diagExtreme = null;
  }
  if (s !== null) {
    const deeper = restSide === 'high' ? s < (diagExtreme ?? Infinity) : s > (diagExtreme ?? -Infinity);
    if (deeper) diagExtreme = s;
  }
  let rule: string;
  if (def.adaptive) {
    // 준비 자세 기준: 바닥 = 기준 - depth, 복귀 = 이번 최저 + rebound ('low'면 방향만 반대)
    const a = def.adaptive;
    const b = state.baseline;
    const dir = a.restSide === 'high' ? 1 : -1;
    rule =
      b === null
        ? `기준 보정 중(준비 자세 ${a.calibrateMs / 1000}초 정지)`
        : `기준 ${b.toFixed(0)}° 바닥${dir > 0 ? '<=' : '>='}${(b - dir * a.depth).toFixed(0)}° 복귀=최저${dir > 0 ? '+' : '-'}${a.rebound}°`;
  } else {
    const r = def.rep;
    rule = `기준 시작<${r.enter} 바닥<=${r.turn} 복귀>${r.exit}`;
  }
  diag =
    `진단: 신호 ${s === null ? '없음(안 보임)' : s.toFixed(0) + '°'}   이번 최저 ${diagExtreme === null ? '-' : diagExtreme.toFixed(0) + '°'}` +
    `   ${rule}${restSide === 'low' ? '(반대 방향)' : ''}\n` +
    `가시성(어깨·팔꿈치·손목 / 엉덩이·무릎·발목) ${vis}`;
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
    diag,
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
    updateDiag(frame);
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
    if (Capacitor.isNativePlatform()) await KeepAwake.keepAwake().catch(() => undefined); // 운동 중 화면 꺼짐 방지
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
  if (isNativeApp) {
    note = `폰에 저장하는 중... (${file.frames.length}프레임)`;
    saveRecordingNative(file).then(
      (where) => { note = `폰에 저장: ${where} (${file.frames.length}프레임)`; refreshHud(); },
      (e) => { note = `저장 실패: ${e instanceof Error ? e.message : String(e)}`; refreshHud(); },
    );
    return;
  }
  note = `PC로 보내는 중... (${file.frames.length}프레임)`;
  void sendRecordingToPc(file).then((sent) => {
    if (sent) {
      note = `PC로 보냄: ${sent} (${file.frames.length}프레임)`;
    } else {
      const name = downloadRecording(file);
      note = `PC로 못 보내서 폰에 저장: ${name} (${file.frames.length}프레임)`;
    }
    refreshHud();
  });
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

// 카메라를 멈추는 버튼은 없다. 앱이 가려지거나 닫힐 때 화면 켜짐 유지를 푼다.
if (Capacitor.isNativePlatform()) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void KeepAwake.allowSleep().catch(() => undefined);
    else if (video.srcObject) void KeepAwake.keepAwake().catch(() => undefined);
  });
  void listNativeVoices().then((v) => { voices = v; refreshHud(); });
}

onVoicesChanged(() => {
  voices = listVoices();
  refreshHud();
});

refreshHud();
