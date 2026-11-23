// 자가 점검 전용 워커(selftest.ts에서만 만든다). 받은 외부 주소로 fetch를 시도하고 결과 문자열을 돌려준다.
// 이 요청은 main 프로세스의 네트워크 차단에 걸려 실패해야 한다.
self.onmessage = async (ev: MessageEvent<string>) => {
  let out: string;
  try {
    await fetch(ev.data, { mode: 'no-cors' });
    out = '성공(문제)';
  } catch (e) {
    out = `실패(정상) ${e instanceof Error ? e.message : String(e)}`;
  }
  self.postMessage(out);
};
