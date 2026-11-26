import { Controller, Get, Query } from '@nestjs/common';
import { GeminiResultStore } from './gemini-result.store';
import { InspectionStore } from './inspection.store';

@Controller('api/home')
export class HomeController {
  constructor(
    private readonly store: InspectionStore,
    private readonly geminiResults: GeminiResultStore,
  ) {}

  @Get()
  async getHome(@Query('date') requestedDate?: string): Promise<{
    date: string;
    total: number;
    ng: number;
    hold: number;
    review_pending: number;
  }> {
    const inspections = await this.store.getAll();
    const inspectionIdsWithResults = await this.geminiResults.getReviewPendingInspectionIds();
    this.geminiResults.setReviewPendingInspectionIds(new Set(inspections.map((inspection) => inspection.inspection_id)));
    const mostRecent = inspections
      .map((inspection) => inspection.inspected_at.slice(0, 10))
      .sort((a, b) => b.localeCompare(a))[0] ?? '';
    const date = inspections.length === 0 ? '' : requestedDate || mostRecent;
    const dailyInspections = date
      ? inspections.filter((inspection) => inspection.inspected_at.slice(0, 10) === date)
      : [];

    return {
      date,
      total: dailyInspections.length,
      ng: dailyInspections.filter((inspection) => inspection.decision === 'NG').length,
      hold: dailyInspections.filter((inspection) => inspection.decision === 'HOLD').length,
      review_pending: dailyInspections.filter((inspection) => inspectionIdsWithResults.has(inspection.inspection_id)).length,
    };
  }
}