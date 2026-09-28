<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { notify, confirmAction } from "@/lib/feedback";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import SelectField from "@/components/SelectField.vue";
import {
  Plus,
  Search,
  FileArchive,
  ArrowUpRight,
  Trash2,
  Upload,
  LoaderCircle,
  ArrowRight,
  Check,
  Circle,
  Pencil,
  Play,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-vue-next";

import { api, save, uploadTask, dateText, statusText } from "../api";
import type { Task, RuleGroup } from "../types/rfcAudit";
import ReviewDetail from "./ReviewDetail.vue";
const emit = defineEmits<{ navigate: [page: string] }>();
const tasks = ref<Task[]>([]),
  groups = ref<RuleGroup[]>([]),
  selected = ref(""),
  modelReady = ref(false),
  uploadOpen = ref(false),
  queue = ref<UploadEntry[]>([]),
  groupId = ref(""),
  uploading = ref(false),
  loading = ref(true),
  error = ref(""),
  query = ref("");
interface UploadEntry {
  id: string;
  file: File;
  status: "waiting" | "uploading" | "done" | "error";
  progress: number;
  error: string;
  group?: string;
  taskId?: string;
}
const uploadStep = ref(1), references = ref<File[]>([]);
const referencesLocked = computed(() => uploading.value || queue.value.some(q => !!q.group));
const statusFilter = ref("all"),
  page = ref(1),
  batchBusy = ref(false),
  renaming = ref<Task>(),
  renameTitle = ref(""),
  renameBusy = ref(false);
const recoverable = computed(() =>
  tasks.value.filter((t) => ["failed", "cancelled"].includes(t.Status)),
);
const filtered = computed(() =>
  tasks.value.filter(
    (t) =>
      (t.Title + " " + t.GroupName)
        .toLowerCase()
        .includes(query.value.toLowerCase()) &&
      (statusFilter.value === "all" ||
        (statusFilter.value === "active"
          ? ["running", "queued"].includes(t.Status)
          : statusFilter.value === "attention"
            ? ["failed", "cancelled"].includes(t.Status)
            : statusFilter.value === "issues"
              ? t.FailedCount > 0
              : t.Status === "completed")),
  ),
);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / 20)),
);
const paged = computed(() =>
  filtered.value.slice((page.value - 1) * 20, page.value * 20),
);
watch([query, statusFilter], () => (page.value = 1));
watch(pageCount, (count) => (page.value = Math.min(page.value, count)));
const active = computed(
  () =>
    tasks.value.filter((t) => ["running", "queued"].includes(t.Status)).length,
);
let timer: ReturnType<typeof setTimeout> | undefined,
  alive = true;
async function refresh() {
  try {
    const list = await api<Task[]>("/tasks");
    if (alive) {
      tasks.value = list;
      error.value = "";
    }
  } catch (e: any) {
    if (alive) error.value = e.message;
  } finally {
    loading.value = false;
  }
}
async function poll() {
  await refresh();
  if (alive) timer = setTimeout(poll, 3000);
}
onMounted(async () => {
  void poll();
  try {
    const [rules, model] = await Promise.all([
      api<RuleGroup[]>("/groups"),
      api("/model"),
    ]);
    groups.value = rules.filter((g) => g.rules.some((r) => r.enabled));
    groupId.value = groups.value[0]?.id || "";
    modelReady.value = model.hasApiKey;
  } catch (e: any) {
    error.value = e.message;
  }
});
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(timer);
});
async function upload() {
  if (uploading.value || !groupId.value || !queue.value.length) return;
  uploading.value = true;
  const pending = queue.value.filter((q) => q.status !== "done");
  let successes = 0;
  try {
    for (const entry of pending) {
      entry.status = "uploading";
      entry.progress = 0;
      entry.error = "";
      entry.group ||= groupId.value;
      try {
        const task = await uploadTask(
          entry.file,
          entry.group,
          entry.id,
          (value) => (entry.progress = value),
          references.value,
        );
        entry.status = "done";
        entry.taskId = task.Id;
        successes++;
      } catch (e: any) {
        entry.status = "error";
        entry.error = e.message;
      }
      await refresh();
    }
    if (successes) {
      notify.success(`已创建 ${successes} 个审核任务`);
      statusFilter.value = "all";
      query.value = "";
      page.value = 1;
    }
    if (queue.value.every((q) => q.status === "done")) {
      if (queue.value.length === 1) selected.value = queue.value[0]!.taskId!;
      uploadOpen.value = false;
      queue.value = [];
      references.value = [];
      uploadStep.value = 1;
    }
  } finally {
    uploading.value = false;
  }
}
function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement;
  for (const file of Array.from(input.files || [])) {
    if (queue.value.length >= 20) {
      notify.warning("每批最多选择 20 份方案");
      break;
    }
    if (!/\.zip$/i.test(file.name) || file.size > 50 * 1024 * 1024) {
      notify.error(`${file.name}：请选择 50 MB 以内的 ZIP 文件`);
      continue;
    }
    if (
      queue.value.some(
        (q) =>
          q.file.name === file.name &&
          q.file.size === file.size &&
          q.file.lastModified === file.lastModified,
      )
    )
      continue;
    queue.value.push({
      id: crypto.randomUUID(),
      file,
      status: "waiting",
      progress: 0,
      error: "",
    });
  }
  input.value = "";
}
function chooseReferences(event: Event) {
  const input = event.target as HTMLInputElement;
  for (const file of Array.from(input.files || [])) {
    if (references.value.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) continue;
    if (!/\.(pdf|docx|html?|txt|md|png|jpe?g|webp)$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024) {
      notify.error(`${file.name}：请选择支持的格式，单份最大 20 MB`); continue;
    }
    if (references.value.length >= 12 || references.value.reduce((n, f) => n + f.size, 0) + file.size > 50 * 1024 * 1024) {
      notify.error('参考资料最多 12 份，合计最大 50 MB'); break;
    }
    references.value.push(file);
  }
  input.value = '';
}
async function resumeTasks(list: Task[]) {
  if (batchBusy.value || !list.length) return;
  try {
    await confirmAction(
      `继续 ${list.length} 个未完成任务？已有结论会保留，仅审核剩余项目，并使用当前模型配置。`,
      "继续审核",
      { confirmButtonText: "继续审核" },
    );
    batchBusy.value = true;
    let success = 0;
    const errors: string[] = [];
    for (const task of list)
      try {
        await api(`/tasks/${task.Id}/retry`, { method: "POST" });
        success++;
      } catch (e: any) {
        errors.push(e.message);
      }
    await refresh();
    if (success) notify.success(`已恢复 ${success} 个任务`);
    if (errors.length)
      notify.error(`${errors.length} 个任务未恢复：${errors[0]}`);
  } catch (e: any) {
    if (e instanceof Error) notify.error(e.message);
  } finally {
    batchBusy.value = false;
  }
}
function rename(task: Task) {
  renaming.value = task;
  renameTitle.value = task.Title;
}
async function submitRename() {
  if (!renaming.value || renameBusy.value) return;
  renameBusy.value = true;
  try {
    await save(
      `/tasks/${renaming.value.Id}`,
      { Title: renameTitle.value },
      "PATCH",
    );
    renaming.value = undefined;
    await refresh();
    notify.success("方案名称已更新");
  } catch (e: any) {
    notify.error(e.message);
  } finally {
    renameBusy.value = false;
  }
}
function mayLeave() {
  if (uploading.value) {
    notify.warning("文件正在上传，请等待这批上传完成");
    return false;
  }
  return true;
}
function openUpload() {
  selected.value = "";
  uploadOpen.value = true;
}
defineExpose({ mayLeave, openUpload });
async function remove(task: Task) {
  try {
    await confirmAction(
      `删除「${task.Title}」及本地方案包？进行中的审核会同时停止。`,
      "删除任务",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
    await api(`/tasks/${task.Id}`, { method: "DELETE" });
    await refresh();
    notify.success("任务已删除");
  } catch (e: any) {
    if (e instanceof Error) notify.error(e.message);
  }
}
</script>
<template>
  <ReviewDetail
    v-if="selected"
    :id="selected"
    @back="
      selected = '';
      refresh();
    "
  />
  <section v-else class="page task-page">
    <header class="page-heading">
      <div>
        <div class="eyebrow">工作空间 / 方案</div>
        <h1>
          方案审核 <span class="heading-count">{{ tasks.length }}</span>
        </h1>
        <p>读懂方案，核验细节，让每一条结论都有据可查。</p>
      </div>
      <Button @click="uploadOpen = true"><Plus />新建审核</Button>
    </header>
    <div v-if="error" role="alert" class="error-banner">{{ error }}</div>
    <div v-if="!modelReady || !groups.length" class="onboarding card">
      <div>
        <div class="eyebrow">开始使用</div>
        <h2>准备好你的审核工作空间</h2>
        <p>连接模型、设置规则，剩下的交给审核 Agent。</p>
      </div>
      <div class="setup-steps">
        <button @click="emit('navigate', 'model')">
          <Check v-if="modelReady" class="success" /><span
            v-else
            class="step-number"
            >1</span
          >
          <div><b>连接模型</b><small>使用自己的 API Key</small></div>
          <ArrowUpRight /></button
        ><button @click="emit('navigate', 'rules')">
          <Check v-if="groups.length" class="success" /><span
            v-else
            class="step-number"
            >2</span
          >
          <div><b>设置审核规则</b><small>按业务场景定义检查项</small></div>
          <ArrowUpRight />
        </button>
      </div>
    </div>
    <div v-if="recoverable.length" class="recovery-banner">
      <div>
        <b>{{ recoverable.length }} 个审核尚未完成</b>
        <p>已确认的结果会保留，可继续处理剩余检查项。</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        :disabled="batchBusy"
        @click="resumeTasks(recoverable)"
        ><Play />继续未完成任务</Button
      >
    </div>
    <div class="table-toolbar">
      <div class="section-caption">
        <SelectField
          v-model="statusFilter"
          label="筛选任务状态"
          :options="[
            { value: 'all', label: '全部方案' },
            { value: 'active', label: '正在处理' },
            { value: 'attention', label: '待继续' },
            { value: 'issues', label: '有修改建议' },
            { value: 'completed', label: '已完成' },
          ]"
        />
        <span v-if="active" class="running-label"
          ><span class="local-dot" />{{ active }} 个正在处理</span
        >
      </div>
      <div class="search-field">
        <Search :size="15" /><Input
          v-model="query"
          aria-label="搜索方案"
          placeholder="搜索方案…"
        />
      </div>
    </div>
    <div class="task-table">
      <table v-if="filtered.length">
        <thead>
          <tr>
            <th>方案名称</th>
            <th>状态</th>
            <th>审核进度</th>
            <th>需修改</th>
            <th>创建时间</th>
            <th class="text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="task in paged"
            :key="task.Id"
            @dblclick="selected = task.Id"
          >
            <td>
              <button class="task-name" @click="selected = task.Id">
                <span class="file-icon"><FileArchive :size="19" /></span
                ><span
                  >{{ task.Title }}<small>{{ task.GroupName }}</small></span
                >
              </button>
            </td>
            <td>
              <span class="status-pill" :class="task.Status"
                ><i />{{ statusText(task.Status) }}</span
              >
            </td>
            <td>
              <div class="mini-progress">
                <i
                  :style="{
                    width:
                      (task.TotalCount
                        ? (task.CompletedCount / task.TotalCount) * 100
                        : 0) + '%',
                  }"
                />
              </div>
              <small class="muted"
                >{{ task.CompletedCount }} / {{ task.TotalCount }}</small
              >
            </td>
            <td>
              <span :class="task.FailedCount ? 'issue-count' : 'muted'">{{
                task.FailedCount || "—"
              }}</span>
            </td>
            <td class="muted whitespace-nowrap">
              {{ dateText(task.CreatedAt) }}
            </td>
            <td>
              <div class="actions justify-end">
                <Button variant="ghost" size="sm" @click="selected = task.Id"
                  >打开<ArrowUpRight /></Button
                ><Button
                  v-if="['failed', 'cancelled'].includes(task.Status)"
                  variant="ghost"
                  size="icon-sm"
                  :disabled="batchBusy"
                  :aria-label="`继续审核 ${task.Title}`"
                  @click="resumeTasks([task])"
                  ><Play /></Button
                ><Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="`重命名 ${task.Title}`"
                  @click="rename(task)"
                  ><Pencil :size="14" /></Button
                ><Button
                  variant="ghost"
                  size="icon-sm"
                  class="delete-action"
                  :aria-label="`删除 ${task.Title}`"
                  @click="remove(task)"
                  ><Trash2 :size="15"
                /></Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-state">
        <LoaderCircle v-if="loading" class="animate-spin" /><template v-else
          ><div class="empty-icon">
            <FileArchive :size="28" :stroke-width="1.4" />
          </div>
          <h2>{{ query || statusFilter !== 'all' ? "没有找到相关方案" : "让下一份方案，更有把握" }}</h2>
          <p>
            {{
              query || statusFilter !== 'all'
                ? "换个关键词或筛选条件试试。"
                : "上传包含 HTML 和图片的 ZIP 方案包，即可开始逐项审核。"
            }}
          </p>
          <Button v-if="!query && statusFilter === 'all'" variant="outline" @click="uploadOpen = true"
            ><Plus />上传第一份方案</Button
          ></template
        >
      </div>
    </div>
    <div class="list-foot">
      <span>共 {{ filtered.length }} 个方案 · 每页 20 个</span>
      <div class="actions">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="上一页"
          :disabled="page <= 1"
          @click="page--"
          ><ChevronLeft /></Button
        ><span>{{ page }} / {{ pageCount }}</span
        ><Button
          variant="ghost"
          size="icon-sm"
          aria-label="下一页"
          :disabled="page >= pageCount"
          @click="page++"
          ><ChevronRight
        /></Button>
      </div>
    </div>
    <Dialog
      :open="!!renaming"
      @update:open="
        (value) => {
          if (!value && !renameBusy) renaming = undefined;
        }
      "
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>重命名方案</DialogTitle
          ><DialogDescription
            >只修改显示名称，方案文件和审核结果会保留。</DialogDescription
          ></DialogHeader
        ><Input
          v-model="renameTitle"
          maxlength="500"
          aria-label="方案名称"
          @keydown.enter="submitRename"
        /><DialogFooter
          ><Button
            variant="outline"
            :disabled="renameBusy"
            @click="renaming = undefined"
            >取消</Button
          ><Button
            :disabled="renameBusy || !renameTitle.trim()"
            @click="submitRename"
            >保存</Button
          ></DialogFooter
        ></DialogContent
      ></Dialog
    >
    <Dialog
      :open="uploadOpen"
      @update:open="
        (value) => {
          if (!uploading) uploadOpen = value;
        }
      "
      ><DialogContent
        :show-close-button="!uploading"
        class="sm:max-w-lg"
        @escape-key-down="(event) => uploading && event.preventDefault()"
        @interact-outside="(event) => uploading && event.preventDefault()"
        ><DialogHeader
          ><DialogTitle>新建方案审核</DialogTitle
          ><DialogDescription
            >先选择主方案，再添加参考资料；确认后开始审核。</DialogDescription
          ></DialogHeader
        >
        <template v-if="modelReady && groups.length">
          <div class="upload-stepper"><span :class="{ active: uploadStep === 1 }">1 · 主方案</span><ChevronRight :size="14" /><span :class="{ active: uploadStep === 2 }">2 · 参考资料</span></div>
          <template v-if="uploadStep === 1"><label class="upload-zone"
            ><input
              type="file"
              multiple
              accept=".zip,application/zip"
              :disabled="uploading"
              @change="chooseFile"
            /><span class="upload-glyph"><Upload :size="24" /></span
            ><b>{{
              queue.length
                ? `已选择 ${queue.length} 份方案 · 点击添加`
                : "选择一个或多个 ZIP 方案包"
            }}</b
            ><small>每份最大 50 MB · 每批最多 20 份</small></label
          >
          <div v-if="queue.length" class="upload-queue">
            <div v-for="entry in queue" :key="entry.id" class="upload-entry">
              <div>
                <b>{{ entry.file.name }}</b
                ><small
                  :class="entry.status === 'error' ? 'danger' : 'muted'"
                  >{{
                    entry.status === "uploading"
                      ? entry.progress === 100
                        ? "正在解析方案…"
                        : `上传 ${entry.progress}%`
                      : entry.status === "done"
                        ? "已创建任务"
                        : entry.status === "error"
                          ? entry.error
                          : `${(entry.file.size / 1024 / 1024).toFixed(2)} MB · 等待上传`
                  }}</small
                >
              </div>
              <Check
                v-if="entry.status === 'done'"
                :size="15"
                class="success"
              /><LoaderCircle
                v-else-if="entry.status === 'uploading'"
                :size="15"
                class="animate-spin"
              /><Button
                v-else
                variant="ghost"
                size="icon-sm"
                :disabled="uploading"
                :aria-label="`移除 ${entry.file.name}`"
                @click="queue = queue.filter((q) => q.id !== entry.id)"
                ><X :size="14"
              /></Button>
            </div>
          </div>
          <div v-if="queue.length" class="actions justify-between">
            <small class="muted">清空选择不会删除已创建的任务。</small>
            <Button variant="ghost" size="sm" :disabled="uploading" @click="queue = []">清空选择</Button>
          </div>
          <div class="field">
            <label>审核规则组</label
            ><SelectField
              v-model="groupId"
              label="审核规则组"
              :disabled="uploading || queue.some((q) => !!q.group)"
              :options="
                groups.map((g) => ({
                  value: g.id,
                  label: `${g.name} · ${g.rules.filter((r) => r.enabled).length} 项`,
                }))
              "
            />
          </div>
          <p class="field-hint">
            按文件名命名；下一步可添加指导书等参考资料。
          </p></template>
          <template v-else>
            <p class="field-hint">已选择 {{ queue.length }} 份主方案，使用「{{ groups.find(g => g.id === groupId)?.name }}」。本批方案共用以下资料；没有参考资料可直接开始。</p>
            <label class="upload-zone"><input type="file" multiple accept=".pdf,.docx,.html,.htm,.txt,.md,.png,.jpg,.jpeg,.webp" :disabled="referencesLocked" @change="chooseReferences" /><Upload :size="24" /><b>添加指导书或其他参考资料</b><small>PDF、DOCX、HTML、TXT、Markdown、图片</small><small>最多 12 份 · 单份 20 MB · 合计 50 MB · PDF 最多 300 页</small></label>
            <div v-if="references.length" class="upload-queue"><div v-for="(file, index) in references" :key="index" class="upload-entry"><div><b>{{ file.name }}</b><small class="muted">{{ (file.size / 1024 / 1024).toFixed(2) }} MB</small></div><Button variant="ghost" size="icon-sm" :disabled="referencesLocked" :aria-label="`移除参考资料 ${file.name}`" @click="references.splice(index, 1)"><X :size="14" /></Button></div></div>
            <p class="field-hint">资料只辅助核验，结论仍定位到主方案。PDF 扫描页和图片需模型支持图片理解；资料按需读取以减少 Token 消耗。</p>
            <p v-if="referencesLocked && !uploading" class="field-hint">已尝试上传的任务保持原文件以便安全重试；如需更换参考资料，请返回上一步清空方案选择后重新选取。</p>
            <div v-if="queue.some(q => q.status !== 'waiting')" class="upload-queue"><div v-for="entry in queue" :key="entry.id" class="upload-entry"><div><b>{{ entry.file.name }}</b><small :class="entry.error ? 'danger' : 'muted'">{{ entry.error || (entry.status === 'done' ? '已创建任务' : `上传与解析 ${entry.progress}%`) }}</small></div></div></div>
          </template></template
        >
        <div v-else class="empty-state compact-empty">
          <Circle />
          <p>请先连接模型，并添加至少一条启用的审核规则。</p>
          <div class="actions">
            <Button
              variant="outline"
              @click="
                uploadOpen = false;
                emit('navigate', !modelReady ? 'model' : 'rules');
              "
              >前往配置<ArrowRight
            /></Button>
          </div>
        </div>
        <DialogFooter
          ><Button
            variant="outline"
            :disabled="uploading"
            @click="uploadOpen = false"
            >关闭</Button
          ><Button v-if="uploadStep === 2 && modelReady && groups.length" variant="outline" :disabled="uploading" @click="uploadStep = 1">上一步</Button><Button
            :disabled="
              uploading ||
              !queue.some((q) => q.status !== 'done') ||
              !groupId ||
              !modelReady
            "
            @click="uploadStep === 1 ? (uploadStep = 2) : upload()"
            ><LoaderCircle v-if="uploading" class="animate-spin" /><ArrowRight
              v-else
            />{{
              uploading
                ? "正在上传…"
                : uploadStep === 1 ? "下一步：参考资料" : queue.some((q) => q.status === "error")
                  ? "重试失败文件"
                  : "上传并开始审核"
            }}</Button
          ></DialogFooter
        >
      </DialogContent></Dialog
    >
  </section>
</template>
