import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PC 앱 자가 점검(WOM_SELFTEST=1). 평소에는 불러오지 않는다(동적 import로 별도 조각).
if (window.wom?.selftest) {
  void import('./selftest').then((m) => m.runSelfTest());
}
