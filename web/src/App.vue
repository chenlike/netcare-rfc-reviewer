<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import {
  FileCheck2,
  ListChecks,
  Settings2,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Monitor,
  ChevronDown,
  ArrowUpRight,
  LoaderCircle,
  CircleHelp,
  Database,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import FeedbackHost from "@/components/FeedbackHost.vue";
import { theme, initializeTheme, setTheme, type Theme } from "@/lib/theme";
import { notify } from "@/lib/feedback";
import { api, bootstrap } from "./api";
import SetupGuide from "./components/SetupGuide.vue";
import TaskList from "./pages/TaskList.vue";
import RuleSettings from "./pages/RuleSettings.vue";
import ModelSettings from "./pages/ModelSettings.vue";
import WorkspaceSettings from "./pages/WorkspaceSettings.vue";
const page = ref("tasks"),
  ready = ref(false),
  error = ref(""),
  directory = ref(""),
  desktop = ref(false),
  compact = ref(false);
const setup = ref({ completed: false, modelReady: false, rulesReady: false });
const guideOpen = ref(false), guideActive = ref(false), guideBusy = ref(false);
async function refreshSetup() {
  try { setup.value = await api("/onboarding"); }
  catch (e: any) { notify.error(e.message); }
}
async function openGuide() {
  await refreshSetup();
  guideOpen.value = true;
}
function pauseGuide() {
  guideOpen.value = false;
  guideActive.value = false;
}
async function startGuide() {
  const destination = !setup.value.modelReady ? "model" : !setup.value.rulesReady ? "rules" : "tasks";
  if (!(await navigate(destination))) return;
  guideOpen.value = false;
  guideActive.value = true;
}
async function finishGuide() {
  if (guideBusy.value || !(await navigate("tasks"))) return;
  guideBusy.value = true;
  try {
    setup.value = await api("/onboarding/complete", { method: "POST" });
    pauseGuide();
    await nextTick();
    taskEditor.value?.openUpload();
  } catch (e: any) { notify.error(e.message); await refreshSetup(); }
  finally { guideBusy.value = false; }
}
const ruleEditor = ref<InstanceType<typeof RuleSettings>>();
const modelEditor = ref<InstanceType<typeof ModelSettings>>(),
  taskEditor = ref<InstanceType<typeof TaskList>>(),
  workspaceEditor = ref<InstanceType<typeof WorkspaceSettings>>();
const navigation = [
  { id: "tasks", label: "方案审核", icon: FileCheck2 },
  { id: "rules", label: "审核规则", icon: ListChecks },
  { id: "model", label: "模型设置", icon: Settings2 },
  { id: "workspace", label: "数据与帮助", icon: Database },
];
const themes = [
  { id: "light", label: "浅色", icon: Sun },
  { id: "dark", label: "深色", icon: Moon },
  { id: "system", label: "跟随系统", icon: Monitor },
] as const;
async function navigate(next: string) {
  if (next === page.value) return true;
  if (
    page.value === "rules" &&
    ruleEditor.value &&
    !(await ruleEditor.value.mayLeave())
  )
    return false;
  if (
    page.value === "model" &&
    modelEditor.value &&
    !(await modelEditor.value.mayLeave())
  )
    return false;
  if (
    page.value === "tasks" &&
    taskEditor.value &&
    !taskEditor.value.mayLeave()
  )
    return false;
  if (
    page.value === "workspace" &&
    workspaceEditor.value &&
    !workspaceEditor.value.mayLeave()
  )
    return false;
  page.value = next;
  return true;
}
async function changeTheme(value: Theme) {
  try {
    await setTheme(value);
  } catch (e: any) {
    notify.error(e.message);
  }
}
async function init() {
  try {
    const result = await bootstrap();
    directory.value = result.directory;
    desktop.value = result.desktop;
    initializeTheme(result.preferences?.theme);
    setup.value = result.onboarding;
    guideOpen.value = !result.onboarding.seen;
    ready.value = true;
    error.value = "";
    if (guideOpen.value) {
      await nextTick();
      await api("/onboarding/seen", { method: "POST" }).catch((e: Error) => notify.error(e.message));
    }
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(init);
</script>
<template>
  <div class="app-shell" :class="{ 'sidebar-compact': compact }">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-mark" aria-hidden="true">N</div>
        <strong v-if="!compact" class="brand-name" aria-label="Netcare RFC方案审核工具">Netcare<small>RFC方案审核工具</small></strong
        ><Button
          variant="ghost"
          size="icon-sm"
          :aria-label="compact ? '展开侧栏' : '收起侧栏'"
          @click="compact = !compact"
          ><PanelLeftOpen v-if="compact" /><PanelLeftClose v-else
        /></Button>
      </div>
      <div v-if="!compact" class="workspace-label">
        <span class="local-dot" />本地工作空间
      </div>
      <nav class="sidebar-nav" aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :title="compact ? item.label : undefined"
          @click="navigate(item.id)"
        >
          <component :is="item.icon" :size="18" /><span v-if="!compact">{{
            item.label
          }}</span>
        </button>
      </nav>

      <div class="sidebar-bottom">
        <Button variant="ghost" class="theme-trigger" aria-label="使用指引" :disabled="!ready" @click="openGuide"><CircleHelp :size="17" /><span v-if="!compact">使用指引</span></Button>
        <DropdownMenu
          ><DropdownMenuTrigger as-child
            ><Button
              variant="ghost"
              class="theme-trigger"
              :aria-label="`切换外观，当前${themes.find((t) => t.id === theme)?.label}`"
              ><component
                :is="themes.find((t) => t.id === theme)?.icon"
                :size="17" /><span v-if="!compact">{{
                themes.find((t) => t.id === theme)?.label
              }}</span
              ><ChevronDown
                v-if="!compact"
                class="ml-auto size-3" /></Button></DropdownMenuTrigger
          ><DropdownMenuContent align="start" side="top" class="w-48"
            ><DropdownMenuLabel>外观</DropdownMenuLabel
            ><DropdownMenuSeparator /><DropdownMenuItem
              v-for="item in themes"
              :key="item.id"
              @select="changeTheme(item.id)"
              ><component :is="item.icon" :size="16" />{{ item.label
              }}<span v-if="theme === item.id" class="ml-auto"
                >✓</span
              ></DropdownMenuItem
            ></DropdownMenuContent
          ></DropdownMenu
        >
        <div v-if="!compact" class="sidebar-foot" :title="directory">
          <span>{{ desktop ? "桌面版" : "本地运行" }}</span
          ><span>v1.2.0</span>
        </div>
      </div>
    </aside>
    <main class="workspace">
      <div v-if="error" class="empty-state">
        <h2>暂时无法连接工作空间</h2>
        <p class="danger">{{ error }}</p>
        <Button @click="init">重新连接</Button>
      </div>
      <template v-else-if="ready">
        <SetupGuide :open="guideOpen" :active="guideActive" :model-ready="setup.modelReady" :rules-ready="setup.rulesReady" :busy="guideBusy" @start="startGuide" @pause="pauseGuide" @navigate="navigate" @finish="finishGuide" />
        <div class="workspace-content"><TaskList
          v-if="page === 'tasks'"
          ref="taskEditor"
          @navigate="navigate" /><RuleSettings
          v-else-if="page === 'rules'"
          ref="ruleEditor" @changed="refreshSetup" /><ModelSettings v-else-if="page === 'model'" ref="modelEditor" :directory="directory" @changed="refreshSetup" /><WorkspaceSettings v-else ref="workspaceEditor" @changed="refreshSetup" /></div></template>
      <div v-else class="empty-state">
        <LoaderCircle class="animate-spin" />
        <p>正在打开工作空间…</p>
      </div>
    </main>
  </div>
  <FeedbackHost />
</template>
