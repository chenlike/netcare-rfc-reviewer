import type { ChecklistItem } from './contracts.js';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** Describe only the current action/result. No model calls, transcript rewrites or raw argument dumps. */
export function reviewActivity(checklist: ChecklistItem[]) {
  const title = (id: unknown) => checklist.find(item => item.Id === id)?.Title ?? '检查项';
  const verdict = (value: unknown) => value === 'passed' ? '通过' : value === 'failed' ? '需修改' : value === 'not_applicable' ? '不适用' : '待确认';
  return {
    describeToolCall(name: string, args: unknown): string | undefined {
      const value = record(args), again = value.cursor ? '（续页）' : '';
      switch (name) {
        case 'list_references': return '查看参考资料目录';
        case 'search_references': return `检索参考资料：${text(value.query)}`;
        case 'read_reference': return `查阅指导资料 ${text(value.referenceId)} · 页/段 ${value.section}${again}`;
        case 'inspect_reference_image': return `查看参考原页/图片 ${text(value.referenceId)} · ${value.image}`;
        case 'list_documents': return `查看${value.images ? '图片引用' : '方案目录'}${again}${value.section ? ' ' + text(value.section) : ''}`;
        case 'read_document': {
          const refs = Array.isArray(value.refs) ? value.refs.slice(0, 6).map(text).join(', ') : '';
          return `读取原文${again}${value.full ? '（重新展开）' : ''}：${refs || text(value.section) || text(value.document) || '方案正文'}`;
        }
        case 'search_document': return `检索方案${again}：${Array.isArray(value.query) ? value.query.map(text).join(' / ') : text(value.query)}`;
        case 'inspect_image': {
          const region = record(value.region);
          return `查看图片 ${text(value.imageId)}${value.region ? `（裁切 ${region.x},${region.y},${region.width},${region.height}）` : ''}${value.full ? '（重新展开）' : ''}`;
        }
        case 'submit_checklist_result': return `准备提交「${title(value.checklistId)}」：${verdict(value.verdict)}；${text(value.description)}`;
        case 'report_blocked': return '报告审核阻塞';
        default: return undefined;
      }
    },
    describeToolResult(name: string, result: unknown, isError: boolean): string | undefined {
      const content = record(result).content;
      const raw = Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => text(part.text)).join(' ') : '';
      if (isError) return `工具失败：${raw || '未提供错误说明'}`;
      let data: Record<string, any>;
      try { data = record(JSON.parse(raw)); } catch { return undefined; }
      switch (name) {
        case 'read_document':
        case 'search_document': {
          const body = text(data.text);
          const excerpt = body.replace(/^\[B\d+[^\n]*\]\n?/gmu, '').trim();
          const page = data.nextCursor ? '，可继续翻页' : '';
          if (!excerpt && body.includes('已读')) return `复用已读内容${page}`;
          if (name === 'search_document' && data.total === 0) return '未找到匹配内容，尚不能据此判定缺失';
          const count = name === 'search_document' ? `匹配片段 ${data.total ?? '?'} 处` : '已读取原文';
          return `${count}${page}${excerpt ? '：' + excerpt : '，本页无新增文字'}`;
        }
        case 'list_documents': return `已返回目录/引用${data.nextCursor ? '，可继续翻页' : ''}：${text(data.text)}`;
        case 'inspect_image': return `${data.alreadyInspected ? '复用已查看图片' : '已读取图片'} ${text(data.ref)}`;
        case 'submit_checklist_result': return data.remaining === undefined
          ? `「${title(data.checklistId)}」已确认，无需重复写入`
          : `已提交「${title(data.checklistId)}」，剩余 ${data.remaining} 项`;
        case 'report_blocked': return `审核阻塞：${text(data.reason)}`;
        default: return undefined;
      }
    }
  };
}
