<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, save, downloadJson } from "../api";
import type { Rule, RuleGroup } from "../types/rfcAudit";
const groups = ref<RuleGroup[]>([]),
  draft = ref<RuleGroup>(),
  busy = ref(false),
  dirty = ref(false),
  importInput = ref<HTMLInputElement>();
async function load() {
  groups.value = await api("/groups");
}
onMounted(() => load().catch((e) => ElMessage.error(e.message)));
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
    await ElMessageBox.confirm(
      "当前修改尚未保存，是否放弃修改？",
      "未保存的规则",
      { type: "warning" },
    );
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
    ElMessage.success("规则已保存；已有任务保留创建时的规则快照");
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!draft.value?.id) return;
  try {
    await ElMessageBox.confirm(
      "删除此规则组？已有任务及其审核结果会保留。",
      "删除规则组",
      { type: "warning" },
    );
    await api(`/groups/${draft.value.id}`, { method: "DELETE" });
    draft.value = undefined;
    dirty.value = false;
    await load();
  } catch (e: any) {
    if (e instanceof Error) ElMessage.error(e.message);
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
    ElMessage.success("已导入，请检查后保存");
  } catch (e: any) {
    ElMessage.error(e.message);
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
        <div class="eyebrow">REVIEW STANDARDS</div>
        <h1>规则配置</h1>
        <p>按场景组织检查项，每个任务使用创建时的规则快照。</p>
      </div>
      <div class="actions">
        <el-button @click="importInput?.click()">导入 JSON</el-button
        ><el-button type="primary" @click="add">新建规则组</el-button>
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
      <aside class="card group-list">
        <div class="section-caption">
          规则组 <span>{{ groups.length }}</span>
        </div>
        <button
          v-for="group in groups"
          :key="group.id"
          :class="{ selected: draft?.id === group.id }"
          @click="select(group)"
        >
          <span>{{ group.name }}</span
          ><small>{{ group.rules.filter((r) => r.enabled).length }} 项</small>
        </button>
        <p v-if="!groups.length" class="empty-hint">
          新建一个规则组，或导入已有规则。
        </p>
      </aside>
      <div v-if="draft" class="rule-editor">
        <div class="card editor-heading">
          <el-input
            v-model="draft.name"
            maxlength="100"
            placeholder="规则组名称"
            @input="dirty = true"
          />
          <div class="actions">
            <span v-if="dirty" class="muted">未保存</span
            ><el-button
              v-if="draft.id"
              text
              @click="downloadJson(draft, draft.name + '.json')"
              >导出</el-button
            ><el-button v-if="draft.id" text type="danger" @click="remove"
              >删除组</el-button
            ><el-button type="primary" :loading="busy" @click="submit"
              >保存规则</el-button
            >
          </div>
        </div>
        <div
          v-for="(rule, index) in draft.rules"
          :key="rule.Id"
          class="card rule-card"
        >
          <div class="rule-card-heading">
            <span class="rule-number">{{
              String(index + 1).padStart(2, "0")
            }}</span
            ><el-input
              v-model="rule.Title"
              placeholder="检查项标题"
              @input="dirty = true"
            /><el-switch
              v-model="rule.enabled"
              inline-prompt
              active-text="启用"
              inactive-text="停用"
              @change="dirty = true"
            /><el-button
              text
              type="danger"
              @click="
                draft.rules.splice(index, 1);
                dirty = true;
              "
              >删除</el-button
            >
          </div>
          <el-input
            v-model="rule.Description"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 12 }"
            placeholder="描述检查标准，以及应当核验的证据……"
            @input="dirty = true"
          />
          <div class="rule-meta">
            <el-select v-model="rule.Level" @change="dirty = true"
              ><el-option label="必要" value="必要" /><el-option
                label="建议"
                value="建议" /></el-select
            ><el-input
              v-model="rule.Chapter"
              placeholder="相关章节（可选）"
              @input="dirty = true"
            />
          </div>
        </div>
        <el-button
          class="add-rule"
          @click="
            draft.rules.push(emptyRule());
            dirty = true;
          "
          >＋ 添加检查项</el-button
        >
      </div>
      <div v-else class="card rule-empty">
        <el-empty description="选择规则组，开始编辑审核标准" />
      </div>
    </div>
  </section>
</template>
