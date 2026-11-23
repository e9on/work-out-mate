import type { EngineView } from '../workout/engine';

export type CameraErrorViewProps = { kind: NonNullable<EngineView['cameraError']>; onRetry: () => void; onHome: () => void };

const MESSAGE: Record<CameraErrorViewProps['kind'], string> = {
  denied: '카메라 권한이 필요해요. 설정에서 허용한 뒤 다시 시도해 주세요',
  notFound: '카메라를 찾을 수 없어요',
  other: '카메라를 켜지 못했어요',
};

/** 카메라를 켜지 못했을 때: 이유별 문구, 다시 시도, 홈으로 */
export function CameraErrorView({ kind, onRetry, onHome }: CameraErrorViewProps) {
  return (
    <section className="camera-error screen-cover" aria-label="카메라 오류">
      <p className="error-text camera-error-text" role="alert">
        {MESSAGE[kind]}
      </p>
      <div className="home-footer">
        <button type="button" onClick={onRetry}>
          다시 시도
        </button>
        <button type="button" onClick={onHome}>
          홈으로
        </button>
      </div>
    </section>
  );
}
