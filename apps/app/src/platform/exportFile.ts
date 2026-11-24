import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { ExportFile } from '../form/exportData';

/** Android: 문서(Documents) 폴더 먼저, 실패하면 앱 전용(Data) 폴더. 저장 위치를 한국어로 돌려준다. */
async function saveNative(name: string, text: string): Promise<string> {
  try {
    const res = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Documents, encoding: Encoding.UTF8 });
    return `문서 폴더 Documents/${name} (${res.uri})`;
  } catch (e1) {
    try {
      const res = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Data, encoding: Encoding.UTF8 });
      return `앱 전용 폴더 files/${name} (${res.uri}) - 문서 폴더 저장 실패: ${e1 instanceof Error ? e1.message : String(e1)}`;
    } catch (e2) {
      throw new Error(`문서 폴더와 앱 전용 폴더 모두 저장 실패 (${e2 instanceof Error ? e2.message : String(e2)})`);
    }
  }
}

/** 웹: 브라우저 다운로드. objectURL은 바로 해제한다. */
async function saveWeb(name: string, text: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return `다운로드 폴더 ${name}`;
}

export function createExportFile(): ExportFile {
  return { save: (name, text) => (Capacitor.isNativePlatform() ? saveNative(name, text) : saveWeb(name, text)) };
}
