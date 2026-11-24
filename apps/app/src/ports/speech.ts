export interface Speech {
  speak(text: string): Promise<'ok' | 'unsupported'>;
  cancel(): void;
}
