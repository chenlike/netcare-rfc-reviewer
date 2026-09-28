<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { notify, confirmAction } from "@/lib/feedback";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Download,
  RotateCw,
  Sparkles,
  ChevronUp,
  ChevronDown,
  GripVertical,
} from "lucide-vue-next";
import { api, statusText, downloadFile } from "../api";
import type { Detail, RfcAuditCheck } from "../types/rfcAudit";
import RfcDocumentPreview from "../components/RfcDocumentPreview.vue";
import RfcMarkdown from "../components/RfcMarkdown.vue";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
const exporting = ref(false);
async function exportReport(format: "md" | "html" | "json") {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await downloadFile(
      `/tasks/${props.id}/report?format=${format}`,
      `${detail.value?.Task.Title || "方案"}-审核报告.${format}`,
    );
  } catch (e: any) {
    notify.error(e.message);
  } finally {
    exporting.value = false;
  }
}
const props = defineProps<{ id: string }>(),
  emit = defineEmits<{ back: [] }>();
const detail = ref<Detail>(),
  selectedId = ref(""),
  findingKey = ref(0),
  filter = ref("issues"),
  collapsed = ref(false),
  error = ref(""),
  busy = ref(false);
const stage = ref<HTMLElement>(),
  panel = ref<HTMLElement>(),
  preview = ref<InstanceType<typeof RfcDocumentPreview>>();
const position = ref<{ x: number; y: number }>(),
  dragging = ref(false);
const finding = computed(
  () => detail.value?.Checklist.find((c) => c.Id === selectedId.value) || null,
);
const pending = computed(
  () =>
    detail.value?.Checklist.filter((c) => c.Status !== "completed").length || 0,
);
const issues = computed(
  () =>
    detail.value?.Checklist.filter((c) => c.Verdict === "failed").length || 0,
);
const passed = computed(
  () =>
    detail.value?.Checklist.filter(
      (c) => c.Status === "completed" && c.Verdict !== "failed",
    ).length || 0,
);
const checks = computed(
  () =>
    detail.value?.Checklist.filter(
      (c) =>
        filter.value === "all" ||
        (filter.value === "issues"
          ? c.Verdict === "failed"
          : filter.value === "pending"
            ? c.Status !== "completed"
            : c.Status === "completed" && c.Verdict !== "failed"),
    ) || [],
);
const running = computed(() =>
  ["queued", "running"].includes(detail.value?.Task.Status || ""),
);
let alive = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  observer: ResizeObserver | undefined;
async function refresh() {
  try {
    const result = await api<Detail>(`/tasks/${props.id}`);
    if (!alive) return;
    const first = !detail.value,
      wasRunning = running.value;
    detail.value = result;
    error.value = "";
    if (first && !issues.value)
      filter.value = pending.value ? "pending" : "passed";
    else if (
      wasRunning &&
      !running.value &&
      !pending.value &&
      filter.value === "pending"
    )
      filter.value = issues.value ? "issues" : "passed";
  } catch (e: any) {
    if (alive) error.value = e.message;
  }
}
async function poll() {
  await refresh();
  if (alive) timer = setTimeout(poll, running.value ? 2000 : 6000);
}
onMounted(async () => {
  void poll();
  await nextTick();
  observer = new ResizeObserver(clamp);
  if (stage.value) observer.observe(stage.value);
});
watch(panel, (next, previous) => {
  if (previous) observer?.unobserve(previous);
  if (next) observer?.observe(next);
});
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(timer);
  observer?.disconnect();
  endDrag();
});
function select(check: RfcAuditCheck) {
  selectedId.value = selectedId.value === check.Id ? "" : check.Id;
  findingKey.value++;
}
function clamp() {
  if (!position.value || !panel.value || !stage.value) return;
  position.value = {
    x: Math.max(
      8,
      Math.min(
        position.value.x,
        stage.value.clientWidth - panel.value.offsetWidth - 8,
      ),
    ),
    y: Math.max(
      8,
      Math.min(
        position.value.y,
        stage.value.clientHeight -
          Math.min(panel.value.offsetHeight, stage.value.clientHeight - 16) -
          8,
      ),
    ),
  };
}
let drag:
  | { id: number; offsetX: number; offsetY: number; target: HTMLElement }
  | undefined;
function startDrag(event: PointerEvent) {
  if (
    event.button !== 0 ||
    (event.target as Element).closest("button,a") ||
    !panel.value ||
    !stage.value
  )
    return;
  const rect = panel.value.getBoundingClientRect();
  drag = {
    id: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    target: event.currentTarget as HTMLElement,
  };
  drag.target.setPointerCapture(event.pointerId);
  dragging.value = true;
  moveDrag(event);
  event.preventDefault();
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId || !stage.value) return;
  const rect = stage.value.getBoundingClientRect();
  position.value = {
    x: event.clientX - rect.left - drag.offsetX,
    y: event.clientY - rect.top - drag.offsetY,
  };
  clamp();
}
function endDrag() {
  if (drag?.target.hasPointerCapture(drag.id))
    drag.target.releasePointerCapture(drag.id);
  drag = undefined;
  dragging.value = false;
}
async function toggle() {
  collapsed.value = !collapsed.value;
  await nextTick();
  clamp();
}
async function action(name: "cancel" | "retry") {
  try {
    if (name === "cancel")
      await confirmAction(
        "停止当前审核？已提交的结果会保留，之后可继续。",
        "停止审核",
        { type: "warning" },
      );
    busy.value = true;
    await api(`/tasks/${props.id}/${name}`, { method: "POST" });
    await refresh();
  } catch (e: any) {
    if (e instanceof Error) notify.error(e.message);
  } finally {
    busy.value = false;
  }
}
const resultLabel = (c: RfcAuditCheck) =>
  c.Status !== "completed"
    ? "待审核"
    : c.Verdict === "failed"
      ? "需修改"
      : c.Verdict === "not_applicable"
        ? "不适用"
        : "通过";
</script>
<template>
  <div class="review-page">
    <header class="review-toolbar">
      <button class="back-button" @click="emit('back')">
        <ArrowLeft :size="16" />返回</button
      ><span class="review-title" :title="detail?.Task.Title">{{
        detail?.Task.Title || "正在加载方案…"
      }}</span
      ><a :href="`/api/tasks/${id}/download`" class="toolbar-link"
        ><Download :size="15" />下载</a
      ><button
        class="text-button"
        @click="preview?.reload()"
        aria-label="重新加载方案"
      >
        <RotateCw :size="15" />
      </button>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div ref="stage" class="review-stage">
      <RfcDocumentPreview
        v-if="detail"
        ref="preview"
        :task-id="id"
        :entry-path="detail.Task.EntryPath"
        :documents="detail.Documents"
        :finding="finding"
        :finding-key="findingKey"
      />
      <div v-if="dragging" class="drag-shield" />
      <aside
        v-if="detail"
        ref="panel"
        class="review-float"
        :class="{ collapsed, dragging }"
        :style="
          position
            ? { left: position.x + 'px', top: position.y + 'px', right: 'auto' }
            : undefined
        "
      >
        <header
          class="float-header"
          @pointerdown="startDrag"
          @pointermove="moveDrag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
          @lostpointercapture="endDrag"
        >
          <span class="agent-icon"><Sparkles :size="18" /></span>
          <div>
            <b>方案审核</b
            ><small
              >{{ detail.Task.CompletedCount }} /
              {{ detail.Task.TotalCount }} 项<span v-if="collapsed && issues">
                · {{ issues }} 项需修改</span
              ></small
            >
          </div>
          <button
            :aria-label="collapsed ? '展开审核面板' : '收起审核面板'"
            :title="collapsed ? '展开' : '收起'"
            @click="toggle"
          >
            <ChevronDown v-if="collapsed" :size="17" /><ChevronUp
              v-else
              :size="17"
            />
          </button>
        </header>
        <template v-if="!collapsed">
          <div class="float-status">
            <span class="status-pill" :class="detail.Task.Status">{{
              statusText(detail.Task.Status)
            }}</span>
            <div class="actions">
              <Button
                v-if="running"
                variant="ghost"
                size="sm"
                :disabled="busy"
                @click="action('cancel')"
                >停止</Button
              ><Button
                v-else-if="['failed', 'cancelled'].includes(detail.Task.Status)"
                variant="ghost"
                size="sm"
                :disabled="busy"
                @click="action('retry')"
                >继续审核</Button
              ><DropdownMenu
                ><DropdownMenuTrigger as-child
                  ><Button variant="ghost" size="sm" :disabled="exporting"
                    >导出报告</Button
                  ></DropdownMenuTrigger
                ><DropdownMenuContent
                  ><DropdownMenuItem @select="exportReport('html')"
                    >HTML · 离线阅读 / 打印</DropdownMenuItem
                  ><DropdownMenuItem @select="exportReport('md')"
                    >Markdown · 编辑与分享</DropdownMenuItem
                  ><DropdownMenuItem @select="exportReport('json')"
                    >JSON · 完整结构数据</DropdownMenuItem
                  ></DropdownMenuContent
                ></DropdownMenu
              >
            </div>
          </div>
          <details v-if="detail.Warnings.length" class="package-warnings">
            <summary>方案提示 · {{ detail.Warnings.length }}</summary>
            <p v-for="warning in detail.Warnings" :key="warning">
              {{ warning }}
            </p>
          </details>
          <div v-if="detail.Task.LastError" class="run-error">
            {{ detail.Task.LastError }}
          </div>
          <div v-if="detail.Activity" class="activity-line">
            <i />{{ detail.Activity.Preview }}
          </div>
          <nav class="check-filters">
            <button
              v-for="option in [
                { id: 'issues', title: '需修改', count: issues },
                { id: 'pending', title: '待审核', count: pending },
                { id: 'passed', title: '通过', count: passed },
                { id: 'all', title: '全部', count: detail.Task.TotalCount },
              ]"
              :key="option.id"
              :class="{
                active: filter === option.id,
                issue: option.id === 'issues',
              }"
              @click="filter = option.id"
            >
              {{ option.title }} <span>{{ option.count }}</span>
            </button>
          </nav>
          <div class="check-list">
            <div v-if="!checks.length" class="check-empty">
              {{
                filter === "issues"
                  ? "目前没有发现需要修改的项目"
                  : "此分类暂无检查项"
              }}
            </div>
            <article
              v-for="check in checks"
              :key="check.Id"
              class="check-card"
              :class="{
                expanded: selectedId === check.Id,
                failed: check.Verdict === 'failed',
              }"
            >
              <button
                class="check-heading"
                :aria-expanded="selectedId === check.Id"
                @click="select(check)"
              >
                <span class="check-symbol" :class="check.Verdict">{{
                  check.Status !== "completed"
                    ? "·"
                    : check.Verdict === "failed"
                      ? "!"
                      : "✓"
                }}</span
                ><span>{{ check.Title }}</span
                ><span class="expand-glyph">{{
                  selectedId === check.Id ? "−" : "＋"
                }}</span>
              </button>
              <div class="check-subline">
                <span
                  :class="check.Verdict === 'failed' ? 'danger' : 'muted'"
                  >{{ resultLabel(check) }}</span
                ><span>{{ check.Chapter || check.Level }}</span>
              </div>
              <div v-if="selectedId === check.Id" class="check-body">
                <template v-if="check.Status === 'completed'"
                  ><div
                    v-if="check.Suggestion && check.Verdict === 'failed'"
                    class="suggestion-box"
                  >
                    <div class="section-caption">修改建议</div>
                    <RfcMarkdown :text="check.Suggestion" />
                  </div>
                  <p v-else-if="check.Verdict === 'passed'" class="passed-note">
                    此项审核通过
                  </p>
                  <details
                    class="finding-details"
                    :open="check.Verdict === 'not_applicable'"
                  >
                    <summary>审核发现与依据</summary>
                    <RfcMarkdown :text="check.Finding || '暂无补充说明'" />
                    <blockquote v-if="check.Quote">
                      {{ check.Quote }}
                    </blockquote>
                  </details>
                  <button
                    v-if="check.Selector || check.Quote"
                    class="text-button"
                    @click="findingKey++"
                  >
                    定位原文 ↗
                  </button></template
                >
                <p v-else class="muted">等待 Agent 核验，结果会自动更新。</p>
                <details class="rule-details">
                  <summary>检查规则 · {{ check.Level }}</summary>
                  <RfcMarkdown :text="check.Description" />
                </details>
              </div>
            </article>
          </div>
          <footer class="float-footer">
            <span>点击检查项定位原文 · 拖动顶部移动面板</span
            ><span v-if="detail.Task.DurationMs">
              · 累计 {{ Math.ceil(detail.Task.DurationMs / 60000) }} 分钟</span
            >
            <details v-if="detail.Task.Usage">
              <summary>Token 用量</summary>
              <span
                >输入 {{ detail.Task.Usage.input.toLocaleString() }} · 输出
                {{ detail.Task.Usage.output.toLocaleString() }} · 缓存读取
                {{ detail.Task.Usage.cache.toLocaleString() }}</span
              >
            </details>
          </footer>
        </template>
      </aside>
    </div>
  </div>
</template>
