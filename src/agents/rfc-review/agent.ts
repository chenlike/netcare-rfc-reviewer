import type { AgentDefinition, AgentExecutionContext } from '../../core/agent.js';
import type { RfcReviewConfig as ReviewConfig } from './config.js';
import type { ChecklistItem, ReviewResult } from './contracts.js';
import type { ReviewPackage } from './document.js';
import { PiReviewer, type Reviewer } from './reviewer.js';

export interface RfcReviewInput {
  title: string; entryPath: string; pkg: ReviewPackage; checklist: ChecklistItem[];
}

/** 输入已解析的方案与规则，输出逐项结论；Agent 不知道结果保存在哪里。 */
export class RfcReviewAgent implements AgentDefinition<RfcReviewInput, ReviewResult> {
  readonly type = 'rfc-review';
  readonly description = '依据冻结的检查项审核 HTML 方案及图片，输出可定位的逐项结论';
  private readonly reviewer: Reviewer;
  constructor(config: ReviewConfig, reviewer?: Reviewer) { this.reviewer = reviewer ?? new PiReviewer(config); }
  parseInput(value: unknown): RfcReviewInput {
    if (!value || typeof value !== 'object') throw new Error('INVALID_RFC_INPUT');
    const input = value as RfcReviewInput;
    if (typeof input.title !== 'string' || typeof input.entryPath !== 'string' || !input.pkg || !Array.isArray(input.pkg.documents) || !Array.isArray(input.pkg.blocks) || !Array.isArray(input.pkg.images) || !Array.isArray(input.pkg.warnings)) throw new Error('INVALID_RFC_INPUT');
    if (!Array.isArray(input.checklist) || !input.checklist.length || input.checklist.length > 500) throw new Error('INVALID_RFC_CHECKLIST');
    const ids = new Set<string>();
    for (const item of input.checklist) {
      if (!item || !['Id', 'Title', 'Description', 'Level'].every(key => typeof item[key as keyof ChecklistItem] === 'string') || !item.Id.trim() || !item.Title.trim() || ids.has(item.Id)) throw new Error('INVALID_RFC_CHECKLIST');
      ids.add(item.Id);
    }
    return input;
  }
  async run(context: AgentExecutionContext<RfcReviewInput, ReviewResult>): Promise<void> {
    await this.reviewer.review({
      request: { TaskId: context.runId, Title: context.input.title, EntryPath: context.input.entryPath },
      pkg: context.input.pkg, pending: context.input.checklist, signal: context.signal,
      assertActive: context.assertActive, submit: context.emit,
      reportActivity: context.reportActivity,
    });
  }
}
