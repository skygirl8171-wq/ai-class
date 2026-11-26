export type StorageMode = 'mock' | 'live';

export interface StorageInfo {
  storage: StorageMode;
  label: string;
}

export type GeminiMode = 'off' | 'mock' | 'live';

export interface GeminiInfo {
  gemini_mode: GeminiMode;
  gemini_label: string;
}

export function getStorageInfo(): StorageInfo {
  if (process.env.STORAGE_MODE === 'live') {
    return { storage: 'live', label: 'Google 시트·드라이브(live)' };
  }

  return { storage: 'mock', label: '내 컴퓨터(mock)' };
}

export function getGeminiInfo(): GeminiInfo {
  const mode = getGeminiMode();
  const labels: Record<GeminiMode, string> = {
    off: '꺼짐(off)',
    mock: '연습용(mock)',
    live: '실제 Gemini(live)',
  };

  return { gemini_mode: mode, gemini_label: labels[mode] };
}

export function getGeminiMode(): GeminiMode {
  const configuredMode = process.env.GEMINI_MODE;
  if (configuredMode === 'off' || configuredMode === 'mock' || configuredMode === 'live') {
    return configuredMode;
  }

  if (configuredMode === undefined || configuredMode === '') {
    return process.env.STORAGE_MODE === 'live' ? 'live' : 'off';
  }

  throw new Error(
    'GEMINI_MODE는 off, mock, live 중 하나여야 합니다. .env의 판독 방식을 확인하세요.',
  );
}

export function validateModes(): void {
  const storageMode = process.env.STORAGE_MODE;
  if (storageMode !== undefined && storageMode !== '' && storageMode !== 'mock' && storageMode !== 'live') {
    throw new Error('STORAGE_MODE는 mock 또는 live여야 합니다. .env의 저장 방식을 확인하세요.');
  }

  const geminiMode = getGeminiMode();
  if (storageMode === 'mock' && geminiMode === 'live') {
    throw new Error(
      'STORAGE_MODE=mock에서는 GEMINI_MODE=live를 사용할 수 없습니다. .env의 판독 방식을 off 또는 mock으로 바꾸세요.',
    );
  }

  if (storageMode === 'live' && geminiMode === 'mock') {
    throw new Error(
      'STORAGE_MODE=live에서는 GEMINI_MODE=mock을 사용할 수 없습니다. .env의 판독 방식을 off 또는 live로 바꾸세요.',
    );
  }
}