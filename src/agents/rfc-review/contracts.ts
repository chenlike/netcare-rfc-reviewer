export interface ChecklistItem {
  Id: string; Title: string; Description: string; Level: string; Chapter?: string; Status?: string | number;
}
export type Verdict = 'passed' | 'failed' | 'not_applicable';
export interface ReviewResult {
  ChecklistId: string; Verdict: Verdict; Description: string; Suggestion: string; Level: string;
  DocumentPath: string; Selector: string; Quote: string;
}
