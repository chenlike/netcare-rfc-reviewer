export interface RfcAuditCheck {
  Id: string;
  Title: string;
  Description: string;
  Level: string;
  Chapter?: string;
  Status: string;
  Verdict: string;
  Finding: string;
  Suggestion: string;
  DocumentPath: string;
  Selector: string;
  Quote: string;
}
export interface RfcAuditDocument {
  Path: string;
  Size: number;
  ContentType: string;
}
export interface Rule {
  Id: string;
  Title: string;
  Description: string;
  Level: string;
  Chapter: string;
  enabled: boolean;
}
export interface RuleGroup {
  id: string;
  name: string;
  rules: Rule[];
  updatedAt: string;
}
export interface Task {
  Id: string;
  Title: string;
  GroupName: string;
  Status: string;
  EntryPath: string;
  CreatedAt: string;
  UpdatedAt: string;
  LastError: string;
  DurationMs?: number;
  TotalCount: number;
  CompletedCount: number;
  FailedCount: number;
  Usage?: { input: number; output: number; cache: number };
}
export interface Detail {
  Task: Task;
  Checklist: RfcAuditCheck[];
  Documents: RfcAuditDocument[];
  Warnings: string[];
  Activity: { Preview: string; UpdatedAt: string } | null;
}
export interface ModelSettings {
  baseUrl: string;
  model: string;
  apiKey?: string;
  hasApiKey?: boolean;
  provider: string;
  supportsImages: boolean;
  thinkingLevel: string;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  concurrency: number;
  requestTimeoutMs: number;
}
