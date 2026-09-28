<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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
} from "lucide-vue-next";

import { api, dateText, statusText } from "../api";
import type { Task, RuleGroup } from "../types/rfcAudit";
import ReviewDetail from "./ReviewDetail.vue";
const emit = defineEmits<{ navigate: [page: string] }>();
const tasks = ref<Task[]>([]),
  groups = ref<RuleGroup[]>([]),
  selected = ref(""),
  modelReady = ref(false),
  uploadOpen = ref(false),
  file = ref<File>(),
  groupId = ref(""),
  uploading = ref(false),
  loading = ref(true),
  error = ref(""),
  query = ref("");
const filtered = computed(() =>
  tasks.value.filter((t) =>
    t.Title.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
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
  if (!file.value || !groupId.value) {
    notify.warning("请选择 ZIP 方案和规则组");
    return;
  }
  uploading.value = true;
  try {
    const task = await api<Task>(
      `/tasks?group=${encodeURIComponent(groupId.value)}&fileName=${encodeURIComponent(file.value.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file.value,
      },
    );
    uploadOpen.value = false;
    file.value = undefined;
    selected.value = task.Id;
    await refresh();
  } catch (e: any) {
    notify.error({ message: e.message, duration: 6000 });
  } finally {
    uploading.value = false;
  }
}
function chooseFile(event: Event) {
  const next = (event.target as HTMLInputElement).files?.[0];
  if (!next) return;
  if (!/\.zip$/i.test(next.name) || next.size > 50 * 1024 * 1024) {
    notify.error("请选择 50 MB 以内的 ZIP 方案包");
    return;
  }
  file.value = next;
}
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
    <div class="table-toolbar">
      <div class="section-caption">
        全部方案
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
            v-for="task in filtered"
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
          <h2>{{ query ? "没有找到相关方案" : "让下一份方案，更有把握" }}</h2>
          <p>
            {{
              query
                ? "换个关键词试试。"
                : "上传包含 HTML 和图片的 ZIP 方案包，即可开始逐项审核。"
            }}
          </p>
          <Button v-if="!query" variant="outline" @click="uploadOpen = true"
            ><Plus />上传第一份方案</Button
          ></template
        >
      </div>
    </div>
    <div class="list-foot">
      <span>方案与记录保存在本机</span><span>支持 HTML 方案包 · ZIP</span>
    </div>
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
            >上传方案包，Agent 将按所选规则逐项核验。</DialogDescription
          ></DialogHeader
        >
        <template v-if="modelReady && groups.length"
          ><label class="upload-zone"
            ><input
              type="file"
              accept=".zip,application/zip"
              :disabled="uploading"
              @change="chooseFile"
            /><span class="upload-glyph"><Upload :size="24" /></span
            ><b>{{ file?.name || "点击选择 ZIP 方案包" }}</b
            ><small>保留 HTML、样式与图片 · 最大 50 MB</small
            ><span v-if="file" class="file-size"
              >{{ (file.size / 1024 / 1024).toFixed(2) }} MB · 点击更换</span
            ></label
          >
          <div class="field">
            <label>审核规则组</label
            ><SelectField
              v-model="groupId"
              label="审核规则组"
              :disabled="uploading"
              :options="
                groups.map((g) => ({
                  value: g.id,
                  label: `${g.name} · ${g.rules.filter((r) => r.enabled).length} 项`,
                }))
              "
            />
          </div>
          <p class="field-hint">
            以方案文件名自动命名，上传后立即开始。
          </p></template
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
            >取消</Button
          ><Button
            :disabled="uploading || !file || !groupId || !modelReady"
            @click="upload"
            ><LoaderCircle v-if="uploading" class="animate-spin" /><ArrowRight
              v-else
            />{{ uploading ? "正在上传…" : "开始审核" }}</Button
          ></DialogFooter
        >
      </DialogContent></Dialog
    >
  </section>
</template>
