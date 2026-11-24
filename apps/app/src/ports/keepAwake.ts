export interface KeepAwake {
  on(): Promise<void>;
  off(): Promise<void>;
}
