import { describe, expect, it, vi } from 'vitest';

const writeFile = vi.fn();
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Documents: 'DOCUMENTS', Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: (o: { directory: string }) => writeFile(o) },
}));

const { createExportFile } = await import('../src/platform/exportFile');

describe('createExportFile(Android)', () => {
  it('문서 폴더 저장이 실패하면 앱 전용 폴더에 저장하고, 안내는 한국어로만(영어 오류 원인 없음)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFile.mockImplementation(async (o: { directory: string }) => {
      if (o.directory === 'DOCUMENTS') throw new Error('Permission denied');
      return { uri: 'file:///data/user/0/app/files/a.jsonl' };
    });
    const msg = await createExportFile().save('a.jsonl', '{}');
    expect(msg).toBe('문서 폴더에 저장하지 못해 앱 전용 폴더에 저장했어요: files/a.jsonl (file:///data/user/0/app/files/a.jsonl)');
    expect(msg).not.toMatch(/Permission|denied/);
  });
});
