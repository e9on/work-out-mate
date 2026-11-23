// PC 앱(Electron) 자가 점검. WOM_SELFTEST=1 로 켰을 때만(window.wom.selftest) main.tsx가 동적 import로 불러온다.
// 카메라 없이 아래 세 가지를 확인하고, 결과를 콘솔 한 줄("[SELFTEST] result {...}")로 main에 넘긴다. 판정은 main이 한다.
//  (a) 일부러 일으킨 CSP 위반(인라인 스크립트·eval·외부 이미지·외부 fetch)이 securitypolicyviolation 으로 잡히는지
//  (b) MediaPipe PoseLandmarker를 app:// 자산(wasm·lite 모델)으로 실제로 만들 수 있는지
//  (c) 렌더러의 외부 요청이 모두 실패하는지. CSP가 적용되지 않는 app:// 워커에서도 시도해 main 차단 목록에 잡히게 한다.
//  (d) 운동 중 화면 켜짐(navigator.wakeLock.request('screen'))이 성공하는지
import { blockTelemetry, createLandmarker } from './platform/mediapipePose';

/** main이 차단 목록에서 찾는 표식(electron/main.ts의 PROBE_MARK와 같다) */
const PROBE = 'https://example.com/wom-selftest-probe';

const say = (m: string): void => console.log(`[SELFTEST] ${m}`);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** (a) CSP가 막아야 하는 동작을 일부러 해 본다. 위반 이벤트는 호출한 쪽에서 센다. */
async function provokeCsp(): Promise<void> {
  // 인라인 스크립트(script-src에 'unsafe-inline' 없음)
  const s = document.createElement('script');
  s.textContent = 'window.__womInline = 1';
  document.head.appendChild(s);
  s.remove();
  // eval 계열(script-src에 'unsafe-eval' 없음)
  try {
    new Function('return 1')();
    say('eval: 실행됨(문제)');
  } catch (e) {
    say(`eval: 막힘(정상) ${errText(e)}`);
  }
  // 외부 이미지(img-src 'self' blob: data:)
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = `${PROBE}.png`;
    setTimeout(resolve, 2000);
  });
}

/** (c) 문서에서 외부 fetch(CSP connect-src가 먼저 막는다) */
async function probeFromDocument(): Promise<string> {
  try {
    await fetch(`${PROBE}?from=document`, { mode: 'no-cors' });
    return 'document fetch: 성공(문제)';
  } catch (e) {
    return `document fetch: 실패(정상) ${errText(e)}`;
  }
}

/**
 * (c) app:// 워커에서 외부 fetch. app:// 응답에는 CSP 헤더가 없어서 이 요청은 렌더러 CSP를 지나 main의 네트워크 차단까지 간다.
 * main 차단 목록에 이 주소가 남아야 통과다.
 */
async function probeFromWorker(): Promise<string> {
  const worker = new Worker(new URL('./selftestWorker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<string>((resolve) => {
      worker.onmessage = (ev: MessageEvent<string>) => resolve(`worker fetch: ${ev.data}`);
      worker.onerror = (ev) => resolve(`worker 오류: ${ev.message}`);
      worker.postMessage(`${PROBE}?from=worker`);
      setTimeout(() => resolve('worker fetch: 응답 없음'), 10_000);
    });
  } finally {
    worker.terminate();
  }
}

/** (b) 실제 앱과 같은 함수로 랜드마커를 만든다(GPU 실패 시 CPU). */
async function makeLandmarker(): Promise<{ ok: boolean; detail: string }> {
  const t0 = performance.now();
  try {
    blockTelemetry();
    const made = await createLandmarker();
    made.landmarker.close();
    return { ok: true, detail: `delegate=${made.delegate} ${(performance.now() - t0).toFixed(0)}ms` };
  } catch (e) {
    return { ok: false, detail: errText(e) };
  }
}

/** (d) 화면 wake lock을 잡았다가 바로 놓는다(실제 앱의 platform/keepAwake.ts와 같은 API). */
async function tryWakeLock(): Promise<{ ok: boolean; detail: string }> {
  if (!navigator.wakeLock) return { ok: false, detail: 'navigator.wakeLock 없음' };
  try {
    const s = await navigator.wakeLock.request('screen');
    await s.release();
    return { ok: true, detail: 'screen 잡기·놓기 성공' };
  } catch (e) {
    return { ok: false, detail: errText(e) };
  }
}

export async function runSelfTest(): Promise<void> {
  const cspDetails: string[] = [];
  const onViolation = (ev: SecurityPolicyViolationEvent): void => {
    cspDetails.push(`${ev.effectiveDirective} ${ev.blockedURI}`);
  };
  document.addEventListener('securitypolicyviolation', onViolation);
  let landmarker = { ok: false, detail: '실행 안 됨' };
  let wakeLock = { ok: false, detail: '실행 안 됨' };
  const probeDetails: string[] = [];
  try {
    say(`href=${location.href} secure=${String(isSecureContext)}`);
    await provokeCsp();
    probeDetails.push(await probeFromDocument());
    probeDetails.push(await probeFromWorker());
    landmarker = await makeLandmarker();
    wakeLock = await tryWakeLock();
    await wait(300); // 위반 이벤트는 비동기로 온다
  } catch (e) {
    say(`점검 중 예외: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  } finally {
    document.removeEventListener('securitypolicyviolation', onViolation);
  }
  const result = {
    cspViolations: cspDetails.length,
    cspDetails,
    landmarker: landmarker.ok,
    landmarkerDetail: landmarker.detail,
    probesRejected: probeDetails.length === 2 && probeDetails.every((d) => d.includes('실패(정상)')),
    probeDetails,
    wakeLock: wakeLock.ok,
    wakeLockDetail: wakeLock.detail,
  };
  console.log(`[SELFTEST] result ${JSON.stringify(result)}`);
}
