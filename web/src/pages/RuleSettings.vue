<script setup lang="ts">
import { onMounted, ref } from "vue";
import { notify, confirmAction } from "@/lib/feedback";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import SelectField from "@/components/SelectField.vue";
import {
  Plus,
  Upload,
  Download,
  Trash2,
  ListChecks,
  LoaderCircle,
  Check,
  FolderClosed,
} from "lucide-vue-next";

import { api, save, downloadJson } from "../api";
import type { Rule, RuleGroup } from "../types/rfcAudit";
import preset from "../../../presets/rfc-standard.json";
const emit = defineEmits<{ changed: [] }>();
const groups = ref<RuleGroup[]>([]),
  draft = ref<RuleGroup>(),
  busy = ref(false),
  dirty = ref(false),
  importInput = ref<HTMLInputElement>();
async function load() {
  groups.value = await api("/groups");
  emit("changed");
}
onMounted(() => load().catch((e) => notify.error(e.message)));
function emptyRule(): Rule {
  return {
    Id: crypto.randomUUID(),
    Title: "",
    Description: "",
    Level: "必要",
    Chapter: "",
    enabled: true,
  };
}
async function mayLeave() {
  if (!dirty.value) return true;
  try {
    await confirmAction("当前修改尚未保存，是否放弃修改？", "未保存的规则", {
      type: "warning",
    });
    return true;
  } catch {
    return false;
  }
}
async function select(group: RuleGroup) {
  if (!(await mayLeave())) return;
  draft.value = JSON.parse(JSON.stringify(group));
  dirty.value = false;
}
async function add() {
  if (!(await mayLeave())) return;
  draft.value = {
    id: "",
    name: "新规则组",
    rules: [emptyRule()],
    updatedAt: "",
  };
  dirty.value = true;
}
async function submit() {
  if (!draft.value) return;
  busy.value = true;
  try {
    draft.value = await save(
      "/groups" + (draft.value.id ? "/" + draft.value.id : ""),
      draft.value,
      draft.value.id ? "PUT" : "POST",
    );
    dirty.value = false;
    await load();
    notify.success("规则已保存；已有任务保留创建时的规则快照");
  } catch (e: any) {
    notify.error(e.message);
  } finally {
    busy.value = false;
  }
}
async function usePreset() {
  if (!(await mayLeave())) return;
  draft.value = { id: "", name: preset.name, rules: structuredClone(preset.rules), updatedAt: "" };
  dirty.value = true;
  notify.success("已载入 24 项 RFC 预置规则，请核对后保存为自己的规则组");
}
async function remove() {
  if (!draft.value?.id) return;
  try {
    await confirmAction(
      "删除此规则组？已有任务及其审核结果会保留。",
      "删除规则组",
      { type: "warning" },
    );
    await api(`/groups/${draft.value.id}`, { method: "DELETE" });
    draft.value = undefined;
    dirty.value = false;
    await load();
  } catch (e: any) {
    if (e instanceof Error) notify.error(e.message);
  }
}
async function importRules(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("规则文件不能超过 2 MB");
    const raw = JSON.parse(await file.text());
    const rules = Array.isArray(raw) ? raw : raw.rules || raw.Checklist;
    if (!Array.isArray(rules))
      throw new Error("JSON 应包含规则数组或 rules 字段");
    if (!(await mayLeave())) return;
    draft.value = {
      id: "",
      name: raw.name || file.name.replace(/\.json$/i, ""),
      updatedAt: "",
      rules: rules.map((r: any) => ({
        Id: String(r.Id || crypto.randomUUID()),
        Title: String(r.Title || ""),
        Description: String(r.Description || ""),
        Chapter: String(r.Chapter || ""),
        Level: String(r.Level || "必要"),
        enabled: r.enabled !== false,
      })),
    };
    dirty.value = true;
    notify.success("已导入，请检查后保存");
  } catch (e: any) {
    notify.error(e.message);
  } finally {
    (event.target as HTMLInputElement).value = "";
  }
}
defineExpose({ mayLeave });
</script>
<template>
  <section class="page rule-page">
    <header class="page-heading">
      <div>
        <div class="eyebrow">工作空间 / 审核标准</div>
        <h1>审核规则</h1>
        <p>把经验变成标准，让每一次审核都有章可循。</p>
      </div>
      <div class="actions">
        <Button variant="outline" @click="usePreset"><ListChecks />使用 RFC 预置规则</Button>
        <Button variant="outline" @click="importInput?.click()"
          ><Upload />导入 JSON</Button
        ><Button @click="add"><Plus />新建规则组</Button>
      </div>
    </header>
    <input
      ref="importInput"
      type="file"
      accept=".json,application/json"
      hidden
      @change="importRules"
    />
    <div class="rule-layout">
      <aside class="group-list">
        <div class="section-caption">
          规则组<span>{{ groups.length }}</span>
        </div>
        <button
          v-for="group in groups"
          :key="group.id"
          :class="{ selected: draft?.id === group.id }"
          @click="select(group)"
        >
          <FolderClosed :size="16" /><span>{{ group.name }}</span
          ><small>{{ group.rules.filter((r) => r.enabled).length }}</small>
        </button>
        <p v-if="!groups.length" class="empty-hint">
          还没有规则组。<br />新建或导入一组标准。
        </p>
        <div class="group-foot">新任务使用最新规则，已有任务保留规则快照。</div>
      </aside>
      <div v-if="draft" class="rule-editor">
        <div class="editor-heading">
          <div class="editor-title">
            <label class="sr-only" for="group-name">规则组名称</label
            ><Input
              id="group-name"
              v-model="draft.name"
              maxlength="100"
              placeholder="规则组名称"
              @input="dirty = true"
            /><span class="muted"
              >{{ draft.rules.length }} 项检查<span v-if="dirty">
                · 未保存</span
              ></span
            >
          </div>
          <div class="actions">
            <Button
              v-if="draft.id"
              variant="ghost"
              size="icon-sm"
              aria-label="导出规则组"
              @click="downloadJson(draft, draft.name + '.json').catch(e => notify.error(e.message))"
              ><Download /></Button
            ><Button
              v-if="draft.id"
              variant="ghost"
              size="icon-sm"
              aria-label="删除规则组"
              class="delete-action"
              @click="remove"
              ><Trash2 /></Button
            ><Button :disabled="busy" size="sm" @click="submit"
              ><LoaderCircle v-if="busy" class="animate-spin" /><Check
                v-else
              />保存规则</Button
            >
          </div>
        </div>
        <div
          v-for="(rule, index) in draft.rules"
          :key="rule.Id"
          class="card rule-card"
          :class="{ 'rule-disabled': !rule.enabled }"
        >
          <div class="rule-card-heading">
            <span class="rule-number">{{
              String(index + 1).padStart(2, "0")
            }}</span
            ><Input
              v-model="rule.Title"
              :aria-label="`第 ${index + 1} 项标题`"
              placeholder="检查项标题"
              @input="dirty = true"
            /><Switch
              v-model="rule.enabled"
              :aria-label="`启用第 ${index + 1} 项`"
              @update:model-value="dirty = true"
            /><Button
              variant="ghost"
              size="icon-sm"
              :aria-label="`删除第 ${index + 1} 项`"
              class="delete-action"
              @click="
                draft.rules.splice(index, 1);
                dirty = true;
              "
              ><Trash2 :size="15"
            /></Button>
          </div>
          <Textarea
            v-model="rule.Description"
            :aria-label="`第 ${index + 1} 项检查标准`"
            :rows="3"
            placeholder="描述检查标准，以及应当核验的证据…"
            @input="dirty = true"
          />
          <p v-if="rule.Title.includes('2个运行高峰期') && rule.Description.includes('一个运行高峰期')" class="field-hint">
            待核对：原标题要求 2 个运行高峰期，正文要求 1 个且大于 48 小时。已保留原文，请按实际标准统一后保存。
          </p>
          <div class="rule-meta">
            <SelectField
              v-model="rule.Level"
              label="规则等级"
              :options="[
                { value: '必要', label: '必要' },
                { value: '重要', label: '重要' },
                { value: '建议', label: '建议' },
              ]"
              @update:model-value="dirty = true"
            /><Input
              v-model="rule.Chapter"
              aria-label="相关章节"
              placeholder="相关章节（可选）"
              @input="dirty = true"
            />
          </div>
        </div>
        <Button
          variant="outline"
          class="add-rule"
          @click="
            draft.rules.push(emptyRule());
            dirty = true;
          "
          ><Plus />添加检查项</Button
        >
      </div>
      <div v-else class="rule-empty empty-state">
        <div class="empty-icon">
          <ListChecks :size="28" :stroke-width="1.4" />
        </div>
        <h2>好的审核，从清晰的规则开始</h2>
        <p>可以从 24 项 RFC 预置规则开始，再按实际业务调整。</p>
        <div class="actions"><Button @click="usePreset"><ListChecks />使用 RFC 预置规则</Button><Button variant="outline" @click="add"><Plus />创建规则组</Button></div>
      </div>
    </div>
  </section>
</template>
