<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
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
    ElMessage.warning("请选择 ZIP 方案和规则组");
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
    ElMessage.error({ message: e.message, duration: 6000 });
  } finally {
    uploading.value = false;
  }
}
function chooseFile(event: Event) {
  const next = (event.target as HTMLInputElement).files?.[0];
  if (!next) return;
  if (!/\.zip$/i.test(next.name) || next.size > 50 * 1024 * 1024) {
    ElMessage.error("请选择 50 MB 以内的 ZIP 方案包");
    return;
  }
  file.value = next;
}
async function remove(task: Task) {
  try {
    await ElMessageBox.confirm(
      `删除「${task.Title}」及本地方案包？进行中的审核会同时停止。`,
      "删除任务",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
    await api(`/tasks/${task.Id}`, { method: "DELETE" });
    await refresh();
    ElMessage.success("任务已删除");
  } catch (e: any) {
    if (e instanceof Error) ElMessage.error(e.message);
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
        <div class="eyebrow">REVIEW WORKSPACE</div>
        <h1>
          方案审核 <span class="heading-count">{{ tasks.length }}</span>
        </h1>
        <p>上传方案，逐项核验，让每一条结论都有据可查。</p>
      </div>
      <el-button type="primary" size="large" @click="uploadOpen = true"
        >＋ 上传方案</el-button
      >
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="!modelReady || !groups.length" class="onboarding card">
      <div>
        <b>开始你的第一次审核</b>
        <p>配置模型连接，添加审核规则，然后上传包含 HTML 的方案 ZIP。</p>
      </div>
      <div class="actions">
        <el-button v-if="!modelReady" @click="emit('navigate', 'model')"
          >配置模型 →</el-button
        ><el-button v-if="!groups.length" @click="emit('navigate', 'rules')"
          >添加规则 →</el-button
        >
      </div>
    </div>
    <div class="card task-table">
      <div class="table-toolbar">
        <div class="section-caption">
          全部方案
          <span v-if="active" class="running-label"
            >{{ active }} 个正在处理</span
          >
        </div>
        <el-input
          v-model="query"
          placeholder="搜索方案名称"
          clearable
          style="width: 250px"
        />
      </div>
      <el-table
        v-loading="loading"
        :data="filtered"
        empty-text="还没有审核任务，上传方案开始吧"
        @row-dblclick="(task: Task) => (selected = task.Id)"
      >
        <el-table-column label="方案名称" min-width="300"
          ><template #default="{ row }"
            ><button class="task-name" @click="selected = row.Id">
              <span class="file-icon">H</span
              ><span
                >{{ row.Title }}<small>{{ row.GroupName }}</small></span
              >
            </button></template
          ></el-table-column
        >
        <el-table-column label="状态" width="105"
          ><template #default="{ row }"
            ><span class="status-pill" :class="row.Status">{{
              statusText(row.Status)
            }}</span></template
          ></el-table-column
        >
        <el-table-column label="审核进度" width="155"
          ><template #default="{ row }"
            ><div class="mini-progress">
              <i
                :style="{
                  width:
                    (row.TotalCount
                      ? (row.CompletedCount / row.TotalCount) * 100
                      : 0) + '%',
                }"
              />
            </div>
            <small class="muted"
              >{{ row.CompletedCount }} / {{ row.TotalCount }} 项</small
            ></template
          ></el-table-column
        >
        <el-table-column label="待修改" width="85"
          ><template #default="{ row }"
            ><span :class="row.FailedCount ? 'danger' : 'muted'">{{
              row.FailedCount
            }}</span></template
          ></el-table-column
        >
        <el-table-column label="创建时间" width="135"
          ><template #default="{ row }">{{
            dateText(row.CreatedAt)
          }}</template></el-table-column
        >
        <el-table-column label="操作" width="130" fixed="right"
          ><template #default="{ row }"
            ><el-button link type="primary" @click="selected = row.Id"
              >查看</el-button
            ><el-button link type="danger" @click="remove(row)"
              >删除</el-button
            ></template
          ></el-table-column
        >
      </el-table>
    </div>
    <el-dialog
      v-model="uploadOpen"
      title="上传方案"
      width="520px"
      :close-on-click-modal="!uploading"
      :close-on-press-escape="!uploading"
      :show-close="!uploading"
    >
      <template v-if="modelReady && groups.length"
        ><label class="upload-zone"
          ><input
            type="file"
            accept=".zip,application/zip"
            :disabled="uploading"
            @change="chooseFile"
          /><span class="upload-glyph">↑</span
          ><b>{{ file?.name || "选择 ZIP 方案包" }}</b
          ><small
            >保留 HTML、样式及图片的原始目录结构 · 最大 50 MB</small
          ></label
        ><el-form label-position="top"
          ><el-form-item label="审核规则组"
            ><el-select v-model="groupId" style="width: 100%"
              ><el-option
                v-for="group in groups"
                :key="group.id"
                :label="`${group.name} · ${group.rules.filter((r) => r.enabled).length} 项`"
                :value="group.id" /></el-select></el-form-item
        ></el-form>
        <p class="muted">
          以方案文件名自动命名，上传后立即开始审核。
        </p></template
      >
      <el-empty v-else description="请先配置模型并添加至少一条启用的规则" />
      <template #footer
        ><el-button :disabled="uploading" @click="uploadOpen = false"
          >取消</el-button
        ><el-button
          type="primary"
          :loading="uploading"
          :disabled="!file || !groupId || !modelReady"
          @click="upload"
          >上传并开始审核</el-button
        ></template
      >
    </el-dialog>
  </section>
</template>
