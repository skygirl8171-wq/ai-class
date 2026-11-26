import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Inspection } from './inspection.types';
import type {
  GeminiResultRecord,
  GeminiRunState,
  GeminiRunStatus,
} from './gemini-result.types';
import { getGeminiInfo, getStorageInfo } from './storage-mode';
import { GoogleWebAppClient } from './google-web-app.client';

const { normalizeGeminiResult } = require('../shared/gemini-result.js') as {
  normalizeGeminiResult: (value: unknown) => GeminiResultRecord['result'] | null;
};

interface GoogleGeminiResultRecord extends Omit<GeminiResultRecord, 'weight_g' | 'images' | 'result'> {
  weight_g: number | string | null;
  images: unknown;
  result: unknown;
}

interface GoogleGeminiResults {
  results: GoogleGeminiResultRecord[];
}

interface RunState {
  state: GeminiRunState;
  error?: string;
}

@Injectable()
export class GeminiResultStore {
  private readonly filePath = path.join(process.cwd(), 'runtime', 'gemini-results.json');
  private readonly runStates = new Map<string, RunState>();

  constructor(private readonly google: GoogleWebAppClient) {}

  private reviewPendingInspectionIds = new Set<string>();

  setReviewPendingInspectionIds(inspectionIds: Set<string>): void {
    this.reviewPendingInspectionIds = inspectionIds;
  }

  async getStatus(inspection: Inspection): Promise<GeminiRunStatus> {
    const results = (await this.readResults(inspection.inspection_id))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    const current = this.runStates.get(inspection.inspection_id) ?? { state: 'idle' as const };
    const latest = results[0];
    const stale = Boolean(
      latest &&
        (latest.product_id !== inspection.product_id ||
          latest.weight_g !== inspection.weight_g ||
          JSON.stringify(latest.images) !== JSON.stringify(inspection.images)),
    );

    return {
      mode: getGeminiInfo().gemini_mode,
      state: current.state,
      ...(current.state === 'failed' && current.error ? { error: current.error } : {}),
      results,
      stale,
    };
  }

  async getReviewPendingInspectionIds(): Promise<Set<string>> {
    const records = await this.readResults();
    const latestByInspection = new Map<string, GeminiResultRecord>();
    for (const record of records) {
      const previous = latestByInspection.get(record.inspection_id);
      if (!previous || record.created_at > previous.created_at) {
        latestByInspection.set(record.inspection_id, record);
      }
    }
    const inspections = getStorageInfo().storage === 'mock'
      ? this.readLocalInspections()
      : null;
    return new Set(
      [...latestByInspection.values()]
        .filter((record) => {
          if (inspections) {
            const inspection = inspections.get(record.inspection_id);
            return Boolean(
              inspection &&
                record.product_id === inspection.product_id &&
                record.weight_g === inspection.weight_g &&
                JSON.stringify(record.images) === JSON.stringify(inspection.images),
            );
          }
          return this.reviewPendingInspectionIds.has(record.inspection_id);
        })
        .map((record) => record.inspection_id),
    );
  }

  private readLocalInspections(): Map<string, Inspection> {
    const filePath = path.join(process.cwd(), 'runtime', 'local-state.json');
    if (!existsSync(filePath)) return new Map();
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || !('inspections' in value) || !Array.isArray(value.inspections)) {
      return new Map();
    }
    return new Map((value.inspections as Inspection[]).map((inspection) => [inspection.inspection_id, inspection]));
  }

  async startMock(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): Promise<GeminiRunStatus> {
    this.runStates.set(inspection.inspection_id, { state: 'running' });
    const snapshot = { ...inspection, images: [...inspection.images] };

    setTimeout(() => {
      void this.completeMock(snapshot, revision, instructionName, instructionText);
    }, 1500);

    return this.getStatus(snapshot);
  }

  async startLive(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): Promise<GeminiRunStatus> {
    this.runStates.set(inspection.inspection_id, { state: 'running' });
    const snapshot = { ...inspection, images: [...inspection.images] };
    void this.completeLive(snapshot, revision, instructionName, instructionText);
    return {
      mode: 'live',
      state: 'running',
      results: [],
      stale: false,
    };
  }

  private async completeLive(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): Promise<void> {
    try {
      const result = await this.google.call<unknown>('runGemini', {
        instruction: instructionText,
        product_name: this.productName(inspection.product_id),
        weight: inspection.weight_g === null ? '미측정' : `${inspection.weight_g}g`,
        revision,
        standard: this.readStandard(revision),
        imageIds: inspection.images
          .filter((image) => image.startsWith('/api/drive/'))
          .map((image) => image.slice('/api/drive/'.length)),
      });
      const normalized = normalizeGeminiResult(result);
      if (!normalized) throw new Error('Gemini 답이 6항목 형식이 아닙니다.');
      await this.save({
        result_id: `GR-${randomBytes(4).toString('hex')}`,
        inspection_id: inspection.inspection_id,
        created_at: this.koreanDateTime(),
        mode: 'live',
        revision,
        instruction_name: instructionName,
        instruction_text: instructionText,
        product_id: inspection.product_id,
        weight_g: inspection.weight_g,
        images: [...inspection.images],
        result: normalized,
      } as GeminiResultRecord);
      this.runStates.set(inspection.inspection_id, { state: 'idle' });
    } catch (error) {
      this.runStates.set(inspection.inspection_id, {
        state: 'failed',
        error: this.readLiveError(error),
      });
    }
  }

  private productName(productId: string): string {
    return ({
      'P-SILVER': '텀블러 실버',
      'P-WHITE': '텀블러 화이트',
      'P-BLACK': '텀블러 블랙',
    } as Record<string, string>)[productId] ?? '제품 미지정';
  }

  private readStandard(revision: 'Rev.A' | 'Rev.B'): string {
    const standardPath = path.join(process.cwd(), 'standards', `${revision}.json`);
    return readFileSync(standardPath, 'utf8');
  }

  private readLiveError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return '판독하지 못했습니다.';
  }

  private async completeMock(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): Promise<void> {
    try {
      await this.save(this.makeMockResult(inspection, revision, instructionName, instructionText));
      this.runStates.set(inspection.inspection_id, { state: 'idle' });
    } catch {
      this.runStates.set(inspection.inspection_id, {
        state: 'failed',
        error: '판독 결과를 저장하지 못했습니다.',
      });
    }
  }

  private makeMockResult(
    inspection: Inspection,
    revision: 'Rev.A' | 'Rev.B',
    instructionName: string,
    instructionText: string,
  ): GeminiResultRecord {
    const draft = '[모의 테스트 초안]';
    const weight = inspection.weight_g === null ? '미측정' : `${inspection.weight_g}g`;

    return {
      result_id: `GR-${randomBytes(4).toString('hex')}`,
      inspection_id: inspection.inspection_id,
      created_at: this.koreanDateTime(),
      mode: 'mock',
      revision,
      instruction_name: instructionName,
      instruction_text: instructionText,
      product_id: inspection.product_id,
      weight_g: inspection.weight_g,
      images: [...inspection.images],
      result: {
        판정: 'HOLD',
        불량유형: `${draft} 모의 판독에서는 불량 유형을 확정하지 않습니다. 현재 중량: ${weight}.`,
        '관찰·수치 근거': `${draft} 사진과 검사 기록은 실제 분석하지 않았습니다. 현재 중량: ${weight}.`,
        '적용 기준과 출처': `${draft} 선택한 검사기준: ${revision}.`,
        '권고 조치': `${draft} 담당자가 사진과 측정값을 직접 확인해 주세요. 현재 중량: ${weight}.`,
        '사람 승인 필요 여부': `${draft} 사람이 결과를 확인해야 합니다. 현재 중량: ${weight}.`,
      },
    };
  }

  private async readResults(inspectionId?: string): Promise<GeminiResultRecord[]> {
    if (getStorageInfo().storage === 'live') {
      const response = await this.google.call<GoogleGeminiResults>(
        'listGeminiResults',
        inspectionId ? { inspection_id: inspectionId } : {},
      );
      return (response.results ?? []).map((record) => ({
        ...record,
        weight_g: record.weight_g === null || record.weight_g === '' ? null : Number(record.weight_g),
        images: this.parseJsonArray(record.images),
        result: this.parseResult(record.result),
      }));
    }

    const records = this.readLocalResults();
    return inspectionId
      ? records.filter((record) => record.inspection_id === inspectionId)
      : records;
  }

  private parseJsonArray(value: unknown): string[] {
    const parsed = typeof value === 'string' ? this.parseJson(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private parseResult(value: unknown): GeminiResultRecord['result'] {
    const parsed = typeof value === 'string' ? this.parseJson(value) : value;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('저장된 판독 결과를 읽을 수 없습니다.');
    }
    return parsed as GeminiResultRecord['result'];
  }

  private parseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private readLocalResults(): GeminiResultRecord[] {
    if (!existsSync(this.filePath)) return [];
    const value: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    return Array.isArray(value) ? (value as GeminiResultRecord[]) : [];
  }

  private async save(record: GeminiResultRecord): Promise<void> {
    if (getStorageInfo().storage === 'live') {
      const result = await this.google.call<{ saved: number }>('saveGeminiResult', {
        record: {
          ...record,
          images: JSON.stringify(record.images),
          result: JSON.stringify(record.result),
        },
      });
      if (result.saved !== 1) throw new Error('판독 결과를 저장하지 못했습니다.');
      return;
    }

    const records = this.readLocalResults();
    records.push(record);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, this.filePath);
  }

  private koreanDateTime(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
  }
}