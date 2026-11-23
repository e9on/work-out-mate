import { useState } from 'react';

// 라우터 라이브러리 없이 상태 하나로 화면을 고른다. 화면은 이후 작업에서 붙인다.
type Screen = 'home';

export function App() {
  const [screen] = useState<Screen>('home');
  return (
    <main className="app">
      {screen === 'home' && <h1 className="app-title">Work Out Mate</h1>}
    </main>
  );
}
