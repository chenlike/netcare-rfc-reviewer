<script setup lang="ts">
import { onMounted, ref } from "vue";
import { notify, confirmAction } from "@/lib/feedback";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
const showKey = ref(false);

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
  testing.value = true;
  try {
    const result = await api("/model/test", { method: "POST" });
    notify.success(result.message);
  } catch (e: any) {
    notify.error({ message: e.message, duration: 8000 });
  } finally {
    testing.value = false;
  }
}
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
              <label>接口类型</label
              ><SelectField
                v-model="model.provider"
                label="接口类型"
                :options="[
                  { value: 'deepseek', label: 'DeepSeek' },
                  { value: 'openai-compatible', label: 'OpenAI 兼容' },
                ]"
              />
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
                  model.hasApiKey ? '留空保留已保存的 Key' : '输入你的 API Key'
                "
              /><Button
                type="button"
                variant="ghost"
                size="icon-sm"
                :aria-label="showKey ? '隐藏 API Key' : '显示 API Key'"
                @click="showKey = !showKey"
                ><EyeOff v-if="showKey" /><Eye v-else
              /></Button>
            </div>
            <p class="field-hint">
              <KeyRound :size="12" />Key 加密存储，不会回传。<button
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
              <label for="concurrency">同时审核方案数</label
              ><Input
                id="concurrency"
                v-model.number="model.concurrency"
                type="number"
                min="1"
                max="8"
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
      <div class="form-actions">
        <span class="muted">保存后对新启动的审核生效</span>
        <div class="actions">
          <Button
            type="button"
            variant="outline"
            :disabled="testing || !model.hasApiKey || busy"
            @click="test"
            ><LoaderCircle v-if="testing" class="animate-spin" /><Plug
              v-else
            />测试已保存的连接</Button
          ><Button type="submit" :disabled="busy"
            ><LoaderCircle v-if="busy" class="animate-spin" /><Check
              v-else
            />保存配置</Button
          >
        </div>
      </div>
      <p class="storage-note">
        数据位置 <code>{{ directory }}</code>
      </p>
    </form>
    <div v-else-if="!error" class="empty-state">
      <LoaderCircle class="animate-spin" />
    </div>
  </section>
</template>
