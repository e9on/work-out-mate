// Electron 메인 프로세스. 빌드 결과 dist/ 를 app://wom/ 커스텀 프로토콜로 서빙한다.
// 시험용 앱(apps/spike/electron/main.ts)에서 옮기고 보안을 다듬었다.
// - 렌더러: contextIsolation + sandbox + nodeIntegration 끔. preload는 {isElectron, selftest}만 노출한다.
// - 외부 네트워크 전부 차단(Android에서 INTERNET 권한을 뺀 것과 같은 원칙). 카메라(video)만 허용한다.
// - 새 창·다른 origin으로 이동·webview·다운로드는 모두 막는다. origin은 접두사가 아니라 정확히 비교한다.
import { app, BrowserWindow, Menu, protocol, session, type WebContents } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const SCHEME = 'app';
const HOST = 'wom';
const ORIGIN = `${SCHEME}://${HOST}`;
const SELFTEST = process.env.WOM_SELFTEST === '1';
const DIST = normalize(join(__dirname, '..', 'dist'));
/** 자가 점검에서 렌더러가 일부러 보내는 외부 요청 주소의 표식. main 차단 목록에 이 표식이 있어야 한다. */
const PROBE_MARK = 'wom-selftest-probe';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
// 모든 렌더러를 샌드박스로 띄운다(webPreferences에서 빠뜨려도 안전하게).
app.enableSandbox();

function log(msg: string): void {
  if (SELFTEST) process.stdout.write(`${msg}\n`);
}

/**
 * URL이 앱 origin(app://wom)인지 정확히 비교한다. 접두사 비교(startsWith)는 app://wom.evil 같은 주소를 통과시키므로 쓰지 않는다.
 * Node의 URL.origin은 표준이 아닌 스킴(app:)에 대해 "null"을 돌려주므로, 프로토콜·호스트(포트 포함)를 직접 이어 붙여 비교한다.
 */
function isAppOrigin(value: string | undefined | null): boolean {
  if (!value) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  return `${u.protocol}//${u.host}` === ORIGIN;
}

/** app://wom/<경로> → dist/<경로>. dist 밖으로 나가는 경로(.., 인코딩된 ..)는 403. */
function registerAppProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    if (!isAppOrigin(request.url)) return new Response('not found', { status: 404 });
    const url = new URL(request.url);
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (rel.includes('\0')) return new Response('bad request', { status: 400 });
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = normalize(join(DIST, rel));
    if (!file.startsWith(DIST + sep)) return new Response('forbidden', { status: 403 });
    try {
      if (!(await stat(file)).isFile()) return new Response('not found', { status: 404 });
      const body = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(body, { headers: { 'content-type': type, 'content-length': String(body.length) } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/**
 * 카메라(video)와 화면 켜짐(screen wake lock)만 허용하고 나머지 권한은 전부 거부한다. 요청한 쪽과 창 모두 앱 origin이어야 한다.
 * 화면 켜짐: 운동 중 화면이 꺼지지 않게 src/platform/keepAwake.ts가 navigator.wakeLock.request('screen')을 부른다.
 * Electron 45는 이 요청을 permission 이름 'screen-wake-lock'으로 넘긴다(자가 점검 로그로 확인).
 */
const WAKE_LOCK = 'screen-wake-lock';
function setupPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    const fromApp = isAppOrigin(details.requestingUrl) && isAppOrigin(wc.getURL());
    const video = permission === 'media' && types.length > 0 && types.every((t) => t === 'video');
    const ok = fromApp && (video || (permission as string) === WAKE_LOCK);
    log(`[perm] request ${permission} ${JSON.stringify(types)} -> ${ok ? 'allow' : 'deny'}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const mediaType = (details as { mediaType?: string }).mediaType;
    const ok =
      isAppOrigin(requestingOrigin) &&
      ((permission === 'media' && mediaType === 'video') || (permission as string) === WAKE_LOCK);
    log(`[perm] check ${permission} ${requestingOrigin} ${mediaType ?? ''} -> ${ok ? 'allow' : 'deny'}`);
    return ok;
  });
  // USB·HID·시리얼 등 장치 접근은 쓰지 않는다.
  ses.setDevicePermissionHandler(() => false);
}

/** 앱 프로토콜과 로컬 데이터(blob:, data:) 외의 요청(http, https, ws, file 등)은 전부 취소한다. */
const ALLOWED_PROTOCOLS = new Set(['app:', 'blob:', 'data:']);
const blocked: string[] = [];
/** 차단을 통과해 실제로 헤더가 나간 외부 요청(0건이어야 한다). */
const sentExternal: string[] = [];

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

function setupNetworkBlock(): void {
  const web = session.defaultSession.webRequest;
  web.onBeforeRequest((details, callback) => {
    if (ALLOWED_PROTOCOLS.has(protocolOf(details.url))) return callback({});
    blocked.push(details.url);
    log(`[blocked] ${details.method} ${details.url}`);
    callback({ cancel: true });
  });
  web.onSendHeaders((details) => {
    if (ALLOWED_PROTOCOLS.has(protocolOf(details.url))) return;
    sentExternal.push(details.url);
    log(`[sent-external] ${details.method} ${details.url}`);
  });
}

/**
 * 앱에는 내려받기 기능이 없다. 모든 다운로드를 취소한다.
 * 저장 폴더를 만드는 코드(mkdirSync) 자체가 없으므로 폴더 생성 실패로 main이 죽을 일도 없다.
 */
function setupDownloads(): void {
  session.defaultSession.on('will-download', (_e, item) => {
    log(`[download] cancel ${item.getURL()}`);
    item.cancel();
  });
}

/** 모든 webContents(나중에 생길 것 포함)에 새 창·이동·webview 차단을 건다. */
function hardenContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    log(`[window-open] deny ${url}`);
    return { action: 'deny' };
  });
  const guard = (e: { preventDefault(): void }, url: string): void => {
    if (isAppOrigin(url)) return;
    log(`[navigate] deny ${url}`);
    e.preventDefault();
  };
  contents.on('will-navigate', (e, url) => guard(e, url));
  contents.on('will-redirect', (e, url) => guard(e, url));
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

type SelftestResult = {
  cspViolations: number;
  cspDetails: string[];
  landmarker: boolean;
  landmarkerDetail: string;
  probesRejected: boolean;
  probeDetails: string[];
  wakeLock: boolean;
  wakeLockDetail: string;
};

/** 렌더러가 보낸 결과와 main이 본 네트워크 기록을 합쳐 판정한다. 실패 사유 목록을 돌려준다(빈 배열이면 통과). */
function judge(r: SelftestResult): string[] {
  const fails: string[] = [];
  if (!(r.cspViolations >= 3)) fails.push(`CSP 위반 이벤트 ${r.cspViolations}건 (3건 이상이어야 함)`);
  if (r.landmarker !== true) fails.push(`랜드마커 생성 실패: ${r.landmarkerDetail}`);
  if (r.probesRejected !== true) fails.push(`렌더러의 외부 요청 중 성공한 것이 있음: ${JSON.stringify(r.probeDetails)}`);
  if (!blocked.some((u) => u.includes(PROBE_MARK))) fails.push(`main 차단 목록에 점검용 외부 요청(${PROBE_MARK})이 없음`);
  if (r.wakeLock !== true) fails.push(`화면 wake lock 실패: ${r.wakeLockDetail}`);
  if (sentExternal.length !== 0) fails.push(`실제로 나간 외부 요청 ${sentExternal.length}건: ${JSON.stringify(sentExternal)}`);
  return fails;
}

/** 자가 점검 판정이 끝났는지. 끝나기 전에 창이 닫히면 실패(exit 1)로 끝낸다. */
let selftestJudged = false;

function finishSelftest(raw: string): void {
  selftestJudged = true;
  let r: SelftestResult;
  try {
    r = JSON.parse(raw) as SelftestResult;
  } catch {
    log('[selftest] 결과 해석 실패');
    app.exit(1);
    return;
  }
  log(`[selftest] CSP 위반 ${r.cspViolations}건: ${JSON.stringify(r.cspDetails)}`);
  log(`[selftest] 랜드마커: ${r.landmarker ? '성공' : '실패'} (${r.landmarkerDetail})`);
  log(`[selftest] 렌더러 외부 요청: ${JSON.stringify(r.probeDetails)}`);
  log(`[selftest] 화면 wake lock: ${r.wakeLock ? '성공' : '실패'} (${r.wakeLockDetail})`);
  log(`[selftest] main 차단 ${blocked.length}건: ${JSON.stringify(blocked)}`);
  log(`[selftest] 실제로 나간 외부 요청 ${sentExternal.length}건`);
  const fails = judge(r);
  if (fails.length === 0) {
    log('[selftest] PASS');
    setTimeout(() => app.exit(0), 200);
  } else {
    for (const f of fails) log(`[selftest] FAIL ${f}`);
    setTimeout(() => app.exit(1), 200);
  }
}

function msgOf(args: unknown[]): string {
  // 새 시그니처(event.message)와 구버전 시그니처(event, level, message) 둘 다 받는다.
  return (args[0] as { message?: string }).message ?? String(args[2] ?? '');
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 860,
    title: 'Work Out Mate',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false, // 맞춤법 사전을 인터넷에서 받으려 하지 않게 끈다
      additionalArguments: SELFTEST ? ['--wom-selftest'] : [],
    },
  });
  // index.html의 <title>도 같지만, 창 제목은 항상 고정한다.
  win.on('page-title-updated', (e) => e.preventDefault());
  if (SELFTEST) {
    const RESULT = '[SELFTEST] result ';
    let done = false;
    win.webContents.on('console-message', (...args: unknown[]) => {
      const msg = msgOf(args);
      log(`[renderer] ${msg}`);
      if (!done && msg.startsWith(RESULT)) {
        done = true;
        finishSelftest(msg.slice(RESULT.length));
      }
    });
    win.webContents.on('did-finish-load', () => log(`[load] ok ${win.webContents.getURL()}`));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => log(`[load] FAIL ${code} ${desc} ${url}`));
    win.webContents.on('render-process-gone', (_e, d) => {
      log(`[renderer] gone ${d.reason}`);
      app.exit(1);
    });
  }
  void win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

app.on('web-contents-created', (_e, contents) => hardenContents(contents));

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  setupPermissions();
  setupNetworkBlock();
  setupDownloads();
  createWindow();
  if (SELFTEST) {
    // 렌더러가 결과를 보내지 않으면 60초 뒤 종료 코드 2.
    setTimeout(() => {
      log('[selftest] timeout');
      app.exit(2);
    }, 60_000);
  }
});

app.on('window-all-closed', () => {
  if (SELFTEST && !selftestJudged) {
    log('[selftest] FAIL 판정 전에 창이 닫힘');
    app.exit(1);
    return;
  }
  app.quit();
});
