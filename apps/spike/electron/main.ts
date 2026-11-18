// Electron 메인 프로세스. dist/ 를 app://wom/ 커스텀 프로토콜로 서빙한다.
// 보안: contextIsolation, sandbox, 외부 네트워크 전부 차단(Android에서 INTERNET 권한을 뺀 것과 같은 원칙), 카메라만 허용.
import { app, BrowserWindow, Menu, protocol, session, type DownloadItem } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, sep } from 'node:path';

const SCHEME = 'app';
const HOST = 'wom';
const ORIGIN = `${SCHEME}://${HOST}`;
const SELFTEST = process.env.WOM_SELFTEST === '1';
const DIST = join(__dirname, '..', 'dist');

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
  '.map': 'application/json',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function log(msg: string): void {
  if (SELFTEST) process.stdout.write(`${msg}\n`);
}

function registerAppProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('not found', { status: 404 });
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = normalize(join(DIST, rel));
    if (file !== DIST && !file.startsWith(DIST + sep)) return new Response('forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(body, { headers: { 'content-type': type, 'content-length': String(body.length) } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/** 카메라(video)만 허용, 나머지 권한은 전부 거부. 요청 origin은 앱 origin이어야 한다. */
function setupPermissions(): void {
  const ses = session.defaultSession;
  const isApp = (origin: string | undefined): boolean => !!origin && origin.startsWith(ORIGIN);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    const ok =
      permission === 'media' && isApp(details.requestingUrl) && isApp(wc.getURL()) && types.length > 0 && types.every((t) => t === 'video');
    log(`[perm] request ${permission} ${JSON.stringify(types)} -> ${ok ? 'allow' : 'deny'}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const mediaType = (details as { mediaType?: string }).mediaType;
    return permission === 'media' && isApp(requestingOrigin) && (mediaType === undefined || mediaType === 'video');
  });
}

/** 앱 프로토콜과 devtools 외의 요청(http, https, ws 등)은 전부 취소한다. blob/data는 로컬 데이터라 허용. */
const blocked: string[] = [];
function setupNetworkBlock(): void {
  const allowed = new Set(['app:', 'devtools:', 'blob:', 'data:']);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let proto = '';
    try {
      proto = new URL(details.url).protocol;
    } catch {
      /* 해석 불가 URL은 차단 */
    }
    if (allowed.has(proto)) return callback({});
    blocked.push(details.url);
    log(`[blocked] ${details.method} ${details.url}`);
    callback({ cancel: true });
  });
}

/** 녹화 다운로드를 대화상자 없이 문서/WorkOutMate 에 저장한다. */
function setupDownloads(getWin: () => BrowserWindow | null): void {
  const dir =
    process.env.WOM_RECORD_DIR ?? (SELFTEST ? join(tmpdir(), 'wom-selftest') : join(app.getPath('documents'), 'WorkOutMate'));
  session.defaultSession.on('will-download', (_e, item: DownloadItem) => {
    const name = basename(item.getFilename());
    const notify = (r: { ok: boolean; path: string; error?: string }): void => {
      log(`[download] ${JSON.stringify(r)}`);
      getWin()?.webContents.send('wom:recording-saved', r);
    };
    if (!/^wom-[A-Za-z]+-(lite|full)-\d{8}-\d{6}\.json$/.test(name)) {
      item.cancel();
      notify({ ok: false, path: name, error: '허용하지 않는 파일 이름' });
      return;
    }
    mkdirSync(dir, { recursive: true });
    let target = join(dir, name);
    for (let i = 1; existsSync(target); i++) target = join(dir, name.replace(/\.json$/, `-${i}.json`));
    item.setSavePath(target);
    item.once('done', (_ev, state) => {
      notify(state === 'completed' ? { ok: true, path: target } : { ok: false, path: target, error: `다운로드 ${state}` });
    });
  });
}

function msgOf(event: unknown, legacy: string): string {
  return (event as { message?: string }).message ?? legacy;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 860,
    title: 'Work Out Mate 시험',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: SELFTEST ? ['--wom-selftest'] : [],
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });
  if (SELFTEST) {
    // 구버전 시그니처(event, level, message)와 새 시그니처(event.message) 둘 다 받는다.
    win.webContents.on('console-message', (...args: unknown[]) => {
      const msg = msgOf(args[0], String(args[2] ?? ''));
      log(`[renderer] ${msg}`);
      if (msg.includes('[SELFTEST] done')) {
        log(`[blocked-summary] ${blocked.length}건: ${JSON.stringify(blocked)}`);
        setTimeout(() => app.exit(0), 300);
      }
    });
    win.webContents.on('did-finish-load', () => log(`[load] ok ${win.webContents.getURL()}`));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => log(`[load] FAIL ${code} ${desc} ${url}`));
    win.webContents.on('render-process-gone', (_e, d) => log(`[renderer] gone ${d.reason}`));
  }
  void win.loadURL(`${ORIGIN}/index.html`);
  return win;
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  setupPermissions();
  setupNetworkBlock();
  let win: BrowserWindow | null = null;
  setupDownloads(() => win);
  win = createWindow();
  win.on('closed', () => {
    win = null;
  });
  if (SELFTEST) {
    // 화면 코드가 [SELFTEST] done 을 찍으면 종료. 안 찍혀도 60초 뒤 종료.
    setTimeout(() => {
      log('[selftest] timeout');
      app.exit(2);
    }, 60_000);
  }
});

app.on('window-all-closed', () => app.quit());
