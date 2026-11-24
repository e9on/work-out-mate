import { useEffect, useState } from 'react';
import type { WorkoutSession } from '@wom/core';
import type { Storage } from '../ports/storage';
import { formatDateTime } from './History';
import type { AnalysisQueue } from '../form/analysisQueue';
import { setKey, type SetKey } from '../form/types';
import { ConfirmDialog } from './ConfirmDialog';
import type { MediaStore } from '../ports/mediaStore';
import { FormFindings } from './FormFindings';
import { SetTable } from './SetTable';

export type SessionDetailProps = {
  storage: Storage;
  sessionId: string;
  onBack: () => void;
  mediaStore?: MediaStore;
  analysisQueue?: AnalysisQueue;
  onPlay?: (setKey: SetKey, index: number) => void;
};

export function SessionDetail({ storage, sessionId, onBack, mediaStore, analysisQueue, onPlay }: SessionDetailProps) {
  // undefined: 읽는 중, null: 없음
  const [session, setSession] = useState<WorkoutSession | null | undefined>(undefined);

  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');

  /** 이 기록의 영상과 클립만 지운다. 분석·라벨은 남긴다 */
  const deleteVideos = async () => {
    setConfirming(false);
    if (!mediaStore || !session) return;
    try {
      const keys = new Set((await mediaStore.listVideoKeys()).filter((k) => k.startsWith(`${session.id}/`)));
      for (const st of session.sets) keys.add(setKey(session.id, st.exerciseIndex, st.setIndex));
      for (const k of keys) {
        await mediaStore.deleteVideo(k);
        await mediaStore.deleteClipsOfSet(k);
      }
      setNotice('이 기록의 영상을 지웠어요');
    } catch {
      setNotice('영상을 지우지 못했어요. 다시 시도해 주세요.');
    }
  };

  useEffect(() => {
    let alive = true;
    storage.getSession(sessionId).then(
      (s) => {
        if (alive) setSession(s);
      },
      () => {
        if (alive) setSession(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [storage, sessionId]);

  return (
    <main className="app session-detail">
      <h1 className="app-title">{session ? session.routineName : '기록 상세'}</h1>
      {session === null && <p>기록을 찾을 수 없어요</p>}
      {session && (
        <>
          <p>
            {formatDateTime(session.endedAt)} · {session.completed ? '완료' : '미완료'}
          </p>
          <SetTable sets={session.sets} />
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="home-footer">
        {mediaStore && session && (
          <button type="button" onClick={() => setConfirming(true)}>
            이 기록의 영상 삭제
          </button>
        )}
        <button type="button" onClick={onBack}>
          기록으로
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="이 기록의 영상 삭제"
          message="이 기록의 영상을 지울까요? 분석 결과와 맞아요/틀려요는 남아요."
          confirmLabel="삭제"
          onConfirm={() => void deleteVideos()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </main>
  );
}
