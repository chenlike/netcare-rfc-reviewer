<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  Database,
  Download,
  Upload,
  FileHeart,
  LoaderCircle,
  RefreshCw,
  FolderOpen,
  ShieldCheck,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { api, downloadFile } from "@/api";
import { confirmAction, notify } from "@/lib/feedback";
const info = ref<{
  version: string;
  directory: string;
  taskCount: number;
  groupCount: number;
  activeCount: number;
  resumableCount: number;
  packageBytes: number;
  availableBytes: number | null;
  missingPackages: number;
  backupLimit: number;
}>();
const error = ref(""),
  busy = ref(""),
  restoreInput = ref<HTMLInputElement>();
const bytes = (value: number | null) =>
  value === null
    ? "无法读取"
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(1)} GB`
      : `${(value / 1024 ** 2).toFixed(1)} MB`;
async function refresh() {
  try {
    info.value = await api("/workspace");
    error.value = "";
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(refresh);
async function download(kind: "backup" | "diagnostics") {
  if (busy.value) return;
  busy.value = kind;
  error.value = "";
  try {
    await downloadFile(
      `/${kind}`,
      `rfc-studio-${kind}-${new Date().toISOString().slice(0, 10)}.${kind === "backup" ? "zip" : "json"}`,
    );
    notify.success(kind === "backup" ? "备份已导出" : "诊断信息已导出");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = "";
  }
}
async function restore(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  if (!/\.zip$/i.test(file.name) || file.size > 251 * 1024 * 1024) {
    notify.error("请选择 250 MB 以内的 RFC Studio 备份 ZIP");
    return;
  }
  try {
    await confirmAction(
      `从「${file.name}」恢复方案和审核规则？只允许恢复到空工作空间。API Key 和当前模型设置不会变更，未完成任务需手动继续。`,
      "恢复本地备份",
      { confirmButtonText: "恢复备份" },
    );
    busy.value = "restore";
    error.value = "";
    const result = await api("/backup", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    });
    notify.success(`已恢复 ${result.tasks} 个任务和 ${result.groups} 个规则组`);
    await refresh();
  } catch (e: any) {
    if (e instanceof Error) error.value = e.message;
  } finally {
    busy.value = "";
  }
}
function mayLeave() {
  if (busy.value) {
    notify.warning("请等待备份或恢复操作完成");
    return false;
  }
  return true;
}
defineExpose({ mayLeave });
</script>
<template>
  <section class="page settings-page">
    <header class="page-heading">
      <div>
        <div class="eyebrow">偏好设置 / 工作空间</div>
        <h1>数据与帮助</h1>
        <p>管理本机数据，备份审核成果，快速定位运行问题。</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="刷新工作空间信息"
        :disabled="!!busy"
        @click="refresh"
        ><RefreshCw
      /></Button>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <template v-if="info">
      <div class="workspace-stats">
        <div class="card">
          <small>审核任务</small><b>{{ info.taskCount }}</b
          ><span
            >{{ info.activeCount }} 个处理中 ·
            {{ info.resumableCount }} 个待继续</span
          >
        </div>
        <div class="card">
          <small>方案占用</small><b>{{ bytes(info.packageBytes) }}</b
          ><span>所在磁盘可用 {{ bytes(info.availableBytes) }}</span>
        </div>
        <div class="card">
          <small>审核规则组</small><b>{{ info.groupCount }}</b
          ><span>任务保存创建时的规则快照</span>
        </div>
      </div>
      <div v-if="info.missingPackages" class="error-banner">
        {{
          info.missingPackages
        }}
        个任务的方案包缺失，无法预览或继续审核。请从完整数据备份恢复，或重新上传方案。
      </div>
      <div class="settings-section">
        <div class="section-intro">
          <Database :size="20" />
          <h2>备份与迁移</h2>
          <p>把规则、原始方案和审核结果一起带走。</p>
        </div>
        <div class="card form-card">
          <div>
            <h2>导出工作空间备份</h2>
            <p class="help-text">
              备份包含方案 ZIP、规则和审核记录，不包含 API Key
              或模型连接配置。支持 250 MB、最多 500 个任务和 500 个规则组。
            </p>
          </div>
          <div class="actions">
            <Button
              variant="outline"
              :disabled="!!busy"
              @click="download('backup')"
              ><LoaderCircle
                v-if="busy === 'backup'"
                class="animate-spin"
              /><Download v-else />{{
                busy === "backup" ? "正在准备备份…" : "导出备份"
              }}</Button
            ><Button
              variant="outline"
              :disabled="!!busy || info.taskCount > 0 || info.groupCount > 0"
              @click="restoreInput?.click()"
              ><LoaderCircle
                v-if="busy === 'restore'"
                class="animate-spin"
              /><Upload v-else />恢复备份</Button
            >
          </div>
          <p class="field-hint">
            恢复仅适用于没有任务和规则组的空工作空间，不会覆盖已有数据；未完成任务恢复后保持停止。备份包含方案原文，请妥善保管。
          </p>
          <input
            ref="restoreInput"
            type="file"
            accept=".zip"
            hidden
            @change="restore"
          />
          <details class="advanced-settings">
            <summary>超过自动备份大小时怎么办？</summary>
            <p class="help-text">
              关闭 RFC Studio 后，复制下方完整数据目录（包括数据库、master.key
              与
              packages）。迁移到新设备时，先运行一次程序，再关闭程序，将数据完整还原到新设备的数据目录。不要覆盖已有工作空间。
            </p>
          </details>
        </div>
      </div>
      <div class="settings-section">
        <div class="section-intro">
          <FileHeart :size="20" />
          <h2>运行诊断</h2>
          <p>排查模型连接和任务中断问题。</p>
        </div>
        <div class="card form-card">
          <div>
            <h2>导出诊断信息</h2>
            <p class="help-text">
              包含软件版本、运行环境、任务数量和脱敏后的近期错误。不包含
              Key、模型地址、任务标题或方案原文文件。
            </p>
          </div>
          <div>
            <Button
              variant="outline"
              :disabled="!!busy"
              @click="download('diagnostics')"
              ><Download />导出诊断 JSON</Button
            >
          </div>
          <div class="help-grid">
            <details>
              <summary>任务为什么没有完成？</summary>
              <p>
                先查看审核浮窗中的错误信息。网络、额度或模型调用问题解决后，点击“继续审核”；已提交的检查项不会重复执行。
              </p>
            </details>
            <details>
              <summary>关闭软件后还会审核吗？</summary>
              <p>
                不会。关闭桌面窗口会停止本地引擎并保留结果。重新打开后，在任务列表继续未完成的审核。
              </p>
            </details>
            <details>
              <summary>备份恢复后如何继续？</summary>
              <p>
                先连接自己的模型并测试，再从任务列表手动继续未完成项。更换电脑需要重新配置
                API Key。
              </p>
            </details>
          </div>
        </div>
      </div>
      <div class="local-directory">
        <FolderOpen :size="16" />
        <div>
          <b>本地数据目录</b><code>{{ info.directory }}</code>
        </div>
        <span>RFC Studio {{ info.version }}</span>
      </div>
    </template>
    <div v-else-if="!error" class="empty-state">
      <LoaderCircle class="animate-spin" />
    </div>
  </section>
</template>
