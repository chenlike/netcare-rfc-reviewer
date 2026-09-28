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
import { api, downloadFile, downloadJson, save } from "@/api";
import { Switch } from "@/components/ui/switch";
import { initializeTheme } from "@/lib/theme";
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
const configInput = ref<HTMLInputElement>(), includeKey = ref(false);
const emit = defineEmits<{ changed: [] }>();
async function exportConfig() {
  if (busy.value) return;
  busy.value = 'config-export';
  error.value = '';
  try {
    const result = await save('/configuration/export', { includeKey: includeKey.value }, 'POST');
    if (await downloadJson(result, `netcare-config-${new Date().toISOString().slice(0, 10)}.json`))
      notify.success('配置已导出');
  } catch (e: any) { error.value = e.message; }
  finally { busy.value = ''; }
}
async function importConfig(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (!file || busy.value) return;
  busy.value = 'config-import';
  error.value = '';
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('配置文件不能超过 10 MB');
    const value = JSON.parse(await file.text());
    if (value?.format !== 'netcare-rfc-configuration' || value.version !== 1 || !Array.isArray(value.groups))
      throw new Error('请选择本工具导出的配置 JSON');
    await confirmAction(
      `将新增 ${value.groups.length} 个规则组，并替换模型连接、审核参数和主题。${value.model?.apiKey ? '文件中的 API Key 将替换当前 Key。' : '文件未携带 Key：相同 API 地址保留当前 Key，地址变更时清除旧 Key。'}已有审核记录不变，正在执行的任务继续使用原配置。`,
      '导入配置', { confirmButtonText: '导入配置' },
    );
    const result = await save('/configuration/import', value, 'POST');
    initializeTheme(result.preferences.theme);
    emit('changed');
    notify.success(`配置已导入，新增 ${result.groups} 个规则组${result.hasApiKey ? '' : '；请配置 API Key'}`);
    await refresh();
  } catch (e: any) { if (e instanceof Error) error.value = e.message; }
  finally { busy.value = ''; }
}
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
    const saved = await downloadFile(
      `/${kind}`,
      `rfc-studio-${kind}-${new Date().toISOString().slice(0, 10)}.${kind === "backup" ? "zip" : "json"}`,
    );
    if (saved) notify.success(kind === "backup" ? "备份已导出" : "诊断信息已导出");
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
    notify.error("请选择 250 MB 以内的 Netcare RFC方案审核工具 备份 ZIP");
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
          <ShieldCheck :size="20" />
          <h2>配置导入导出</h2>
          <p>迁移审核规则、API 连接和使用偏好。</p>
        </div>
        <div class="card form-card">
          <p class="help-text">包含全部规则组、模型地址与名称、思考程度、审核参数和主题，不包含方案文件与审核记录。配置 JSON 最大 10 MB。</p>
          <div class="switch-row">
            <div><label for="export-api-key">导出时包含 API Key</label><p>开启后 Key 将以明文写入配置文件，请仅用于自己的设备迁移。</p></div>
            <Switch id="export-api-key" v-model="includeKey" :disabled="!!busy" />
          </div>
          <div class="actions">
            <Button variant="outline" :disabled="!!busy" @click="exportConfig"><LoaderCircle v-if="busy === 'config-export'" class="animate-spin" /><Download v-else />导出配置</Button>
            <Button variant="outline" :disabled="!!busy" @click="configInput?.click()"><LoaderCircle v-if="busy === 'config-import'" class="animate-spin" /><Upload v-else />导入配置</Button>
          </div>
          <p class="field-hint">导入的规则作为新组添加，保留已有规则；模型与偏好设置将替换，API Key 导入后在本机加密保存。</p>
          <input ref="configInput" type="file" accept=".json,application/json" hidden @change="importConfig" />
        </div>
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
              备份包含方案 ZIP、参考资料、任务 Prompt 快照、规则和审核记录，不包含 API Key
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
              关闭 Netcare RFC方案审核工具 后，复制下方完整数据目录（包括数据库、master.key
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
        <span>Netcare RFC方案审核工具 {{ info.version }}</span>
      </div>
    </template>
    <div v-else-if="!error" class="empty-state">
      <LoaderCircle class="animate-spin" />
    </div>
  </section>
</template>
