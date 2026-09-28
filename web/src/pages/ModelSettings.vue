<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, save } from "../api";
import type { ModelSettings } from "../types/rfcAudit";
defineProps<{ directory: string }>();
const model = ref<ModelSettings>(),
  busy = ref(false),
  testing = ref(false),
  error = ref("");
onMounted(async () => {
  try {
    model.value = await api("/model");
  } catch (e: any) {
    error.value = e.message;
  }
});
async function submit(clearKey = false) {
  if (!model.value) return;
  busy.value = true;
  try {
    model.value = await save("/model", { ...model.value, clearKey });
    ElMessage.success(
      clearKey ? "已清除 API Key" : "模型配置已保存，下次启动审核时生效",
    );
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    busy.value = false;
  }
}
async function clear() {
  try {
    await ElMessageBox.confirm(
      "清除后将无法发起新的审核，正在运行的审核会使用启动时的配置继续。",
      "清除 API Key",
      { type: "warning" },
    );
    await submit(true);
  } catch {}
}
async function test() {
  testing.value = true;
  try {
    const result = await api("/model/test", { method: "POST" });
    ElMessage.success(result.message);
  } catch (e: any) {
    ElMessage.error({ message: e.message, duration: 8000 });
  } finally {
    testing.value = false;
  }
}
</script>
<template>
  <section class="page settings-page">
    <header class="page-heading">
      <div>
        <div class="eyebrow">MODEL CONNECTION</div>
        <h1>模型配置</h1>
        <p>使用自己的模型服务和 API Key，配置保存在本机。</p>
      </div>
    </header>
    <el-alert v-if="error" :title="error" type="error" />
    <el-form v-if="model" label-position="top" class="settings-form">
      <div class="card form-card">
        <h2>连接模型</h2>
        <el-form-item label="API 地址"
          ><el-input
            v-model="model.baseUrl"
            placeholder="https://api.example.com/v1"
          />
          <div class="field-hint">
            填写 Chat Completions 根地址；兼容接口通常需要保留 /v1。
          </div></el-form-item
        >
        <div class="form-grid">
          <el-form-item label="模型名称"
            ><el-input
              v-model="model.model"
              placeholder="服务商提供的模型 ID" /></el-form-item
          ><el-form-item label="接口类型"
            ><el-select v-model="model.provider"
              ><el-option label="DeepSeek" value="deepseek" /><el-option
                label="OpenAI 兼容"
                value="openai-compatible" /></el-select
          ></el-form-item>
        </div>
        <el-form-item label="API Key"
          ><el-input
            v-model="model.apiKey"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="
              model.hasApiKey ? '已保存，留空保持原 Key' : '输入你的 API Key'
            "
          />
          <div class="field-hint">
            Key 加密保存，不会回传到界面。<button
              v-if="model.hasApiKey"
              type="button"
              class="text-button danger"
              @click="clear"
            >
              清除已保存 Key
            </button>
          </div></el-form-item
        >
        <el-checkbox v-model="model.supportsImages"
          >模型支持图片输入（仅在需要补充图片证据时调用）</el-checkbox
        >
      </div>
      <div class="card form-card">
        <h2>审核偏好</h2>
        <p class="muted">
          一份方案的检查项在同一会话内完成，共享已读取的内容。模型按需要继续取证。
        </p>
        <div class="form-grid">
          <el-form-item label="温度"
            ><el-input-number
              v-model="model.temperature"
              :min="0"
              :max="2"
              :step="0.1"
            />
            <div class="field-hint">
              默认 0。思考模式下服务商可能忽略温度。
            </div></el-form-item
          ><el-form-item label="思考程度"
            ><el-select v-model="model.thinkingLevel"
              ><el-option label="关闭" value="off" /><el-option
                label="低（推荐）"
                value="low" /><el-option label="高" value="high" /><el-option
                label="最大"
                value="max" /></el-select
          ></el-form-item>
          <el-form-item label="单次输出 Token 额度"
            ><el-input-number
              v-model="model.maxTokens"
              :min="256"
              :max="131072"
              :step="1024" /></el-form-item
          ><el-form-item label="模型上下文长度"
            ><el-input-number
              v-model="model.contextWindow"
              :min="8192"
              :max="2000000"
              :step="8192"
          /></el-form-item>
          <el-form-item label="同时审核方案数"
            ><el-input-number
              v-model="model.concurrency"
              :min="1"
              :max="8" /></el-form-item
          ><el-form-item label="模型请求超时（毫秒）"
            ><el-input-number
              v-model="model.requestTimeoutMs"
              :min="10000"
              :max="600000"
              :step="10000"
          /></el-form-item>
        </div>
      </div>
      <div class="form-actions">
        <el-button type="primary" :loading="busy" @click="submit(false)"
          >保存配置</el-button
        ><el-button
          :loading="testing"
          :disabled="!model.hasApiKey"
          @click="test"
          >测试已保存的连接</el-button
        ><span class="muted">测试会向模型发送一条简短请求。</span>
      </div>
      <p class="storage-note">
        本地数据目录：<code>{{ directory }}</code>
      </p>
    </el-form>
  </section>
</template>
