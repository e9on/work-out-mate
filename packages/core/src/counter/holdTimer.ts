export type HoldConfig = {
  /** 자세가 이만큼 이어져야 시작으로 인정(ms). 시작 시각은 처음 true였던 프레임 */
  startAfterMs: number;
  /** 자세가 깨지거나 null이어도 이 시간까지는 계속 센다(ms) */
  graceMs: number;
};

export type HoldState = 'idle' | 'holding' | 'ended';

/**
 * 매달리기 시간 측정기. 프레임마다 update(t, holding)을 한 번 부르면 그 자리에서 판단한다.
 * 시간은 인자 t로만 본다.
 */
export class HoldTimer {
  private st: HoldState = 'idle';
  private t0 = 0;
  private lastTrueT = 0;
  private breakT: number | null = null;
  private candidate = false;

  constructor(private readonly cfg: HoldConfig) {}

  get state(): HoldState {
    return this.st;
  }

  /** 버틴 시간(ms). grace 구간은 자세가 돌아오면 포함, 끝나면 제외. */
  get heldMs(): number {
    if (this.st === 'idle') return 0;
    return (this.breakT ?? this.lastTrueT) - this.t0;
  }

  reset(): void {
    this.st = 'idle';
    this.t0 = 0;
    this.lastTrueT = 0;
    this.breakT = null;
    this.candidate = false;
  }

  update(t: number, holding: boolean | null): void {
    if (this.st === 'ended') return;

    if (this.st === 'idle') {
      if (holding !== true) {
        this.candidate = false;
        return;
      }
      if (!this.candidate) {
        this.candidate = true;
        this.t0 = t;
      }
      this.lastTrueT = t;
      if (t - this.t0 >= this.cfg.startAfterMs) this.st = 'holding';
      return;
    }

    // holding. grace가 이미 지났으면 true여도 이어 세지 않고 끝낸다.
    if (this.breakT !== null && t - this.breakT >= this.cfg.graceMs) {
      this.st = 'ended';
      return;
    }
    if (holding === true) {
      this.breakT = null;
      this.lastTrueT = t;
      return;
    }
    if (this.breakT === null) this.breakT = t;
    if (t - this.breakT >= this.cfg.graceMs) this.st = 'ended';
  }
}
