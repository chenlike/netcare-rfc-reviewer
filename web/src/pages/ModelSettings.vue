<script setup lang="ts">
import { onMounted, ref, computed, watch, onBeforeUnmount } from "vue";
import { notify, confirmAction } from "@/lib/feedback";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_RFC_PROMPT } from '../../../src/agents/rfc-review/prompt';
import { Switch } from "@/components/ui/switch";
import SelectField from "@/components/SelectField.vue";
import {
  Plug,
  SlidersHorizontal,
  KeyRound,
  LoaderCircle,
  Check,
  Eye,
  EyeOff,
  ChevronRight,
} from "lucide-vue-next";
const showKey = ref(false),
  baseline = ref(""),
  testResult = ref<{ message: string; latencyMs: number; note: string }>(),
  testError = ref("");

import { api, save } from "../api";
import type { ModelSettings } from "../types/rfcAudit";
defineProps<{ directory: string }>();
const emit = defineEmits<{ changed: [] }>();
const model = ref<ModelSettings>(),
  busy = ref(false),
  testing = ref(false),
  error = ref("");
onMounted(async () => {
  try {
    model.value = await api("/model");
    baseline.value = JSON.stringify(model.value);
  } catch (e: any) {
    error.value = e.message;
  }
});
async function submit(clearKey = false) {
  if (!model.value || busy.value || testing.value) return;
  busy.value = true;
  try {
    model.value = await save("/model", { ...model.value, provider: "openai-compatible", clearKey });
    baseline.value = JSON.stringify(model.value);
    testResult.value = undefined;
    testError.value = "";
    emit("changed");
    notify.success(
      clearKey ? "已清除 API Key" : "模型配置已保存，下次启动审核时生效",
    );
  } catch (e: any) {
    notify.error(e.message);
  } finally {
    busy.value = false;
  }
}
async function clear() {
  try {
    await confirmAction(
      "清除后将无法发起新的审核，正在运行的审核会使用启动时的配置继续。",
      "清除 API Key",
      { type: "warning" },
    );
    await submit(true);
  } catch {}
}
async function test() {
  if (busy.value || testing.value) return;
  testing.value = true;
  try {
    testError.value = "";
    testResult.value = undefined;
    const result = await save("/model/test", { ...model.value, provider: "openai-compatible" }, "POST");
    testResult.value = result;
    notify.success(`${result.message} · ${result.latencyMs} ms`);
  } catch (e: any) {
    testError.value = e.message;
  } finally {
    testing.value = false;
  }
}
const dirty = computed(
  () => !!model.value && baseline.value !== JSON.stringify(model.value),
);
async function mayLeave() {
  if (busy.value || testing.value) {
    notify.warning("请等待当前操作完成");
    return false;
  }
  if (!dirty.value) return true;
  try {
    await confirmAction("模型设置还未保存，是否放弃修改？", "未保存的配置", {
      confirmButtonText: "放弃修改",
    });
    return true;
  } catch {
    return false;
  }
}
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = "";
  }
};
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => window.removeEventListener("beforeunload", beforeUnload));
watch(
  model,
  () => {
    testResult.value = undefined;
    testError.value = "";
  },
  { deep: true },
);
defineExpose({ mayLeave });
</script>
<template>
  <section class="page settings-page">
    <header class="page-heading">
      <div>
        <div class="eyebrow">偏好设置 / 模型</div>
        <h1>模型设置</h1>
        <p>选择你的模型，按自己的方式审核。</p>
      </div>
      <span v-if="model?.hasApiKey" class="connection-badge"
        ><span class="local-dot" />已配置连接</span
      >
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <form
      v-if="model"
      class="settings-form"
      novalidate
      @submit.prevent="submit(false)"
    >
      <fieldset :disabled="busy || testing" class="contents">
      <div class="settings-section">
        <div class="section-intro">
          <Plug :size="20" />
          <h2>模型连接</h2>
          <p>支持 DeepSeek 与 OpenAI 兼容服务。配置仅保存在本机。</p>
        </div>
        <div class="card form-card">
          <div class="field">
            <label for="model-url">API 地址</label
            ><Input
              id="model-url"
              v-model="model.baseUrl"
              placeholder="https://api.example.com/v1"
            />
            <p class="field-hint">
              Chat Completions 根地址，兼容接口通常需要保留 /v1。
            </p>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="model-name">模型名称</label
              ><Input
                id="model-name"
                v-model="model.model"
                placeholder="服务商提供的模型 ID"
              />
            </div>
            <div class="field">
              <label for="model-api-type">接口类型</label>
              <Input id="model-api-type" model-value="OpenAI 兼容接口" readonly />
            </div>
          </div>
          <div class="field">
            <label for="model-key"
              >API Key
              <span v-if="model.hasApiKey" class="muted font-normal"
                >已加密保存</span
              ></label
            >
            <div class="key-field">
              <Input
                id="model-key"
                v-model="model.apiKey"
                :type="showKey ? 'text' : 'password'"
                autocomplete="new-password"
                :placeholder="
                  model.hasApiKey ? '****************' : '输入你的 API Key'
                "
              /><Button
                v-if="model.apiKey"
                type="button"
                variant="ghost"
                size="icon-sm"
                :aria-label="showKey ? '隐藏 API Key' : '显示 API Key'"
                @click="showKey = !showKey"
                ><EyeOff v-if="showKey" /><Eye v-else
              /></Button>
            </div>
            <p class="field-hint">
              <KeyRound :size="12" />{{ model.hasApiKey ? '已保存并加密；输入新 Key 可替换，留空保留原 Key。' : 'Key 加密存储，不会回传。' }}<button
                v-if="model.hasApiKey"
                type="button"
                class="text-button danger"
                @click="clear"
              >
                清除已保存 Key
              </button>
            </p>
          </div>
          <div class="switch-row">
            <div>
              <label for="vision">图片理解</label>
              <p>仅在需要补充图片证据时读取图片</p>
            </div>
            <Switch id="vision" v-model="model.supportsImages" />
          </div>
        </div>
      </div>
      <div class="settings-section">
        <div class="section-intro">
          <SlidersHorizontal :size="20" />
          <h2>审核偏好</h2>
          <p>同一方案共享上下文和已读内容；有疑问时继续取证。</p>
        </div>
        <div class="card form-card">
          <div class="form-grid">
            <div class="field">
              <label for="temperature">温度</label
              ><Input
                id="temperature"
                v-model.number="model.temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
              />
              <p class="field-hint">默认 0；思考模式可能忽略此参数。</p>
            </div>
            <div class="field">
              <label>思考程度</label
              ><SelectField
                v-model="model.thinkingLevel"
                label="思考程度"
                :options="[
                  { value: 'off', label: '关闭' },
                  { value: 'low', label: '低 · 推荐' },
                  { value: 'high', label: '高' },
                  { value: 'max', label: '最大' },
                ]"
              />
            </div>
            <div class="field">
              <label for="timeout">请求超时 · 毫秒</label
              ><Input
                id="timeout"
                v-model.number="model.requestTimeoutMs"
                type="number"
                min="10000"
                max="600000"
                step="10000"
              />
            </div>
          </div>
          <details class="advanced-settings">
            <summary>高级参数<ChevronRight :size="15" /></summary>
            <div class="form-grid">
              <div class="field">
                <label for="max-tokens">单次输出 Token 上限</label
                ><Input
                  id="max-tokens"
                  v-model.number="model.maxTokens"
                  type="number"
                  min="256"
                  max="131072"
                  step="1024"
                />
              </div>
              <div class="field">
                <label for="context">模型上下文长度</label
                ><Input
                  id="context"
                  v-model.number="model.contextWindow"
                  type="number"
                  min="8192"
                  max="2000000"
                  step="8192"
                />
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="settings-section">
        <div class="section-intro"><SlidersHorizontal :size="20" /><h2>基础审核 Prompt</h2><p>定义 Agent 的审核方式与输出风格。</p></div>
        <div class="card form-card">
          <label for="base-prompt">审核指令</label>
          <Textarea id="base-prompt" v-model="model.basePrompt" :rows="12" maxlength="20000" class="font-mono text-xs leading-relaxed" />
          <div class="actions justify-between"><small class="muted">{{ model.basePrompt?.length || 0 }} / 20000 字</small><Button type="button" variant="ghost" size="sm" @click="model.basePrompt = DEFAULT_RFC_PROMPT">恢复默认 Prompt</Button></div>
          <p class="field-hint">保存后用于新任务，并随任务冻结；已有任务继续时沿用原指令。留空使用默认值。工具的证据校验和逐项提交约束仍然生效，配置导出也包含此项。</p>
        </div>
      </div>
      <div v-if="testResult" class="connection-result" role="status">
        <b>{{ testResult.message }} · {{ testResult.latencyMs }} ms</b>
        <p>{{ testResult.note }} 此次测试没有保存配置。</p>
      </div>
      <div v-if="testError" class="error-banner" role="alert">
        {{ testError }}
      </div>
      <div class="form-actions">
        <span class="muted">{{
          dirty ? "有未保存的修改" : "保存后对新启动的审核生效"
        }}</span>
        <div class="actions">
          <Button
            type="button"
            variant="outline"
            :disabled="
              testing || !(model.apiKey?.trim() || model.hasApiKey) || busy
            "
            @click="test"
            ><LoaderCircle v-if="testing" class="animate-spin" /><Plug
              v-else
            />测试当前连接</Button
          ><Button type="submit" :disabled="busy || testing"
            ><LoaderCircle v-if="busy" class="animate-spin" /><Check
              v-else
            />保存配置</Button
          >
        </div>
      </div>
      <p class="storage-note">
        数据位置 <code>{{ directory }}</code>
      </p>
      </fieldset>
    </form>
    <div v-else-if="!error" class="empty-state">
      <LoaderCircle class="animate-spin" />
    </div>
  </section>
</template>
