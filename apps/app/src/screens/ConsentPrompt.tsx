import { useState } from 'react';

export const CONSENT_VERSION = 'v1';
export const CONSENT_TEXT = '자세 분석 AI를 개선하는 데 내 운동 데이터(관절 좌표, 영상 구간, 맞아요/틀려요 정답)를 학습 데이터로 쓰는 데 동의합니다.';
export const CONSENT_NOTES = [
  '데이터는 내가 직접 내보내기 전에는 폰 밖으로 나가지 않아요.',
  '설정에서 언제든 끌 수 있어요. 끄면 그 뒤 기록은 내보내기에 포함되지 않아요.',
] as const;

export type ConsentPromptProps = {
  /** agreed: 학습 데이터 동의 체크 여부. 체크하지 않아도 영상 저장은 켜진다 */
  onConfirm: (agreed: boolean) => void;
  onCancel: () => void;
};

/** 영상 저장을 처음 켤 때 보이는 안내. 학습 데이터 동의는 영상 저장과 별도의 선택 항목이다 */
export function ConsentPrompt({ onConfirm, onCancel }: ConsentPromptProps) {
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="영상 저장 안내">
        <h2 className="dialog-title">영상 저장 안내</h2>
        <p>영상은 폰 안에만 저장되고 갤러리에 나오지 않아요. 운동이 끝난 뒤 자세 분석에 쓰여요.</p>
        <p>루틴마다 최근 3회는 전체 영상을 두고, 그보다 오래된 기록은 지적된 구간만 남겨요.</p>
        <label className="consent-check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>{CONSENT_TEXT}</span>
        </label>
        {CONSENT_NOTES.map((n) => (
          <p key={n} className="hint">
            {n}
          </p>
        ))}
        <p className="hint">동의하지 않아도 영상 저장과 자세 분석은 쓸 수 있어요.</p>
        <div className="row-actions">
          <button type="button" className="primary" onClick={() => onConfirm(agreed)}>
            확인
          </button>
          <button type="button" onClick={onCancel}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
