<script setup lang="ts">
import { onMounted, ref } from "vue";
import { DocumentChecked, Setting, Tickets } from "@element-plus/icons-vue";
import { bootstrap } from "./api";
import TaskList from "./pages/TaskList.vue";
import RuleSettings from "./pages/RuleSettings.vue";
import ModelSettings from "./pages/ModelSettings.vue";
const page = ref("tasks"),
  ready = ref(false),
  error = ref(""),
  directory = ref("");
const ruleEditor = ref<InstanceType<typeof RuleSettings>>();
async function navigate(next: string) {
  if (next === page.value) return;
  if (
    page.value === "rules" &&
    ruleEditor.value &&
    !(await ruleEditor.value.mayLeave())
  )
    return;
  page.value = next;
}
async function init() {
  try {
    const result = await bootstrap();
    directory.value = result.directory;
    ready.value = true;
    error.value = "";
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(init);
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-icon">R</span>
        <div>RFC Studio<small>方案审核工作台</small></div>
      </div>
      <div class="nav-caption">工作空间</div>
      <button :class="{ active: page === 'tasks' }" @click="navigate('tasks')">
        <el-icon><DocumentChecked /></el-icon>方案审核
      </button>
      <button :class="{ active: page === 'rules' }" @click="navigate('rules')">
        <el-icon><Tickets /></el-icon>规则配置
      </button>
      <button :class="{ active: page === 'model' }" @click="navigate('model')">
        <el-icon><Setting /></el-icon>模型配置
      </button>
      <div class="sidebar-foot">
        <i /> 本地独立运行<small :title="directory">数据保存在此设备</small>
      </div>
    </aside>
    <main class="workspace">
      <div v-if="error" class="page">
        <el-alert :title="error" type="error" :closable="false" /><el-button
          @click="init"
          >重新连接</el-button
        >
      </div>
      <template v-else-if="ready">
        <TaskList v-if="page === 'tasks'" @navigate="navigate" />
        <RuleSettings v-else-if="page === 'rules'" ref="ruleEditor" />
        <ModelSettings v-else :directory="directory" />
      </template>
    </main>
  </div>
</template>
