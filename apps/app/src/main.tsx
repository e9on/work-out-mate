import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import { installBackButton } from './platform/backButton';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 폰 뒤로 가기: 화면·대화 상자마다 쌓인 처리기로 보낸다(네이티브 앱에서만)
installBackButton().catch((e) => console.warn('뒤로 가기 처리를 켜지 못함', e));

// PC 앱 자가 점검(WOM_SELFTEST=1). 평소에는 불러오지 않는다(동적 import로 별도 조각).
if (window.wom?.selftest) {
  void import('./selftest').then((m) => m.runSelfTest());
}
