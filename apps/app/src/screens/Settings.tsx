import { useCallback, useEffect, useRef, useState } from 'react';
import type { Storage } from '../ports/storage';
import type { MediaStore } from '../ports/mediaStore';
import { DEFAULT_SETTINGS, setKey, type AppSettings } from '../form/types';
import { CONSENT_NOTES, CONSENT_TEXT, CONSENT_VERSION, ConsentPrompt } from './ConsentPrompt';
import { ConfirmDialog } from './ConfirmDialog';

export type SettingsProps = {
  mediaStore: MediaStore;
  /** 있으면 영상이 이미 정리된 세트의 클립까지 찾아 지운다 */
  storage?: Storage;
  onBack: () => void;
  /** 없으면 내보내기 버튼을 숨긴다. 돌려준 문구(저장 위치·실패 사유)를 화면에 보여 준다 */
  onExport?: () => Promise<string | void> | void;
};

export const formatMegabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

export function Settings({ mediaStore, storage, onBack, onExport }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [usage, setUsage] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'consent' | 'deleteAll' | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const alive = useRef(true);

  const refreshUsage = useCallback(async () => {
    try {
      const n = await mediaStore.usageBytes();
      if (alive.current) setUsage(n);
    } catch {
      if (alive.current) setError('불러오지 못했어요. 다시 시도해 주세요.');
    }
  }, [mediaStore]);

  useEffect(() => {
    alive.current = true;
    mediaStore.getSettings().then(
      (s) => {
        if (alive.current) setSettings(s);
      },
      () => {
        if (alive.current) {
          setSettings(DEFAULT_SETTINGS);
          setError('불러오지 못했어요. 다시 시도해 주세요.');
        }
      },
    );
    void refreshUsage();
    return () => {
      alive.current = false;
    };
  }, [mediaStore, refreshUsage]);

  const save = async (next: AppSettings) => {
    try {
      await mediaStore.putSettings(next);
      if (alive.current) {
        setSettings(next);
        setError('');
      }
    } catch {
      if (alive.current) setError('저장하지 못했어요. 다시 시도해 주세요.');
    }
  };

  const toggleVideo = (on: boolean) => {
    if (!settings) return;
    // 동의 여부를 한 번도 묻지 않았다면 처음 켤 때 안내를 먼저 보여 준다
    if (on && settings.consent === null) setDialog('consent');
    else void save({ ...settings, videoEnabled: on });
  };

  const confirmConsent = async (agreed: boolean) => {
    if (!settings) return;
    setDialog(null);
    await save({ ...settings, videoEnabled: true, consent: { agreed, version: CONSENT_VERSION, at: Date.now() } });
  };

  const toggleConsent = (on: boolean) => {
    if (!settings) return;
    void save({ ...settings, consent: { agreed: on, version: CONSENT_VERSION, at: Date.now() } });
  };

  const deleteAll = async () => {
    setDialog(null);
    setBusy(true);
    try {
      const keys = new Set(await mediaStore.listVideoKeys());
      if (storage) {
        for (const s of await storage.listSessions()) for (const st of s.sets) keys.add(setKey(s.id, st.exerciseIndex, st.setIndex));
      }
      for (const k of keys) {
        await mediaStore.deleteVideo(k);
        await mediaStore.deleteClipsOfSet(k);
      }
      if (alive.current) setError('');
    } catch {
      if (alive.current) setError('영상을 지우지 못했어요. 다시 시도해 주세요.');
    }
    await refreshUsage();
    if (alive.current) setBusy(false);
  };

  const runExport = async () => {
    if (!onExport) return;
    setBusy(true);
    setExportMsg('');
    try {
      const msg = await onExport();
      if (alive.current) setExportMsg(msg ?? '');
    } catch {
      if (alive.current) setExportMsg('내보내지 못했어요. 다시 시도해 주세요.');
    }
    if (alive.current) setBusy(false);
  };

  const agreed = settings?.consent?.agreed ?? false;

  return (
    <main className="app settings">
      <h1 className="app-title">설정</h1>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {settings && (
        <>
          <section className="settings-section">
            <label className="consent-check">
              <input type="checkbox" checked={settings.videoEnabled} onChange={(e) => toggleVideo(e.target.checked)} />
              <span>영상 저장</span>
            </label>
            <p className="hint">영상은 폰 안에만 저장되고, 운동이 끝난 뒤 자세 분석에 쓰여요. 끄면 그 뒤 운동은 녹화하지 않아요.</p>
          </section>

          <section className="settings-section">
            <label className="consent-check">
              <input type="checkbox" checked={agreed} onChange={(e) => toggleConsent(e.target.checked)} />
              <span>{CONSENT_TEXT}</span>
            </label>
            {CONSENT_NOTES.map((n) => (
              <p key={n} className="hint">
                {n}
              </p>
            ))}
            {settings.consent !== null && !agreed && <p className="hint">이미 내보낸 파일은 지울 수 없어요.</p>}
          </section>

          <section className="settings-section">
            <p>영상 용량 {usage === null ? '-' : formatMegabytes(usage)}</p>
            <button type="button" disabled={busy} onClick={() => setDialog('deleteAll')}>
              영상 전체 삭제
            </button>
            {onExport && (
              <button type="button" disabled={busy} onClick={() => void runExport()}>
                학습 데이터 내보내기
              </button>
            )}
            {exportMsg && (
              <p role="status" className="hint">
                {exportMsg}
              </p>
            )}
          </section>
        </>
      )}
      <div className="home-footer">
        <button type="button" onClick={onBack}>
          홈으로
        </button>
      </div>
      {dialog === 'consent' && <ConsentPrompt onConfirm={(a) => void confirmConsent(a)} onCancel={() => setDialog(null)} />}
      {dialog === 'deleteAll' && (
        <ConfirmDialog
          title="영상 전체 삭제"
          message="저장된 영상을 모두 지울까요? 분석 결과와 맞아요/틀려요는 남아요."
          confirmLabel="삭제"
          onConfirm={() => void deleteAll()}
          onCancel={() => setDialog(null)}
        />
      )}
    </main>
  );
}
