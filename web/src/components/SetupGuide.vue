<script setup lang="ts">
import { computed } from "vue";
import { ArrowRight, Check, Plug, ListChecks, FileArchive, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
const props = defineProps<{ open: boolean; active: boolean; step: number; page: string; busy: boolean }>();
const emit = defineEmits<{ start: []; pause: []; select: [step: number]; next: [] }>();
const steps = computed(() => [
  { title: "连接模型", description: "填写 API 地址、模型名与自己的 Key，测试连接后保存，再点击下一步。", icon: Plug, done: props.active && props.step > 1, page: "model" },
  { title: "确认审核规则", description: "查看 RFC 预置规则，确认适用；也可修改、新建或导入规则，保存后再继续。", icon: ListChecks, done: props.active && props.step > 2, page: "rules" },
  { title: "上传第一份方案", description: "选择包含 HTML、样式和图片的 ZIP，开始逐项审核。", icon: FileArchive, done: false, page: "tasks" },
]);
const nextLabel = computed(() => props.page !== steps.value[props.step - 1]!.page
  ? ['前往模型设置', '前往审核规则', '前往方案列表'][props.step - 1]
  : ['已配置，下一步', '已确认规则，下一步', '上传第一份方案'][props.step - 1]);
</script>
<template>
  <Dialog :open="open" @update:open="(value) => !value && emit('pause')">
    <DialogContent class="sm:max-w-xl setup-welcome">
      <DialogHeader>
        <div class="setup-emblem" aria-hidden="true">N</div>
        <p class="eyebrow">欢迎使用</p>
        <DialogTitle class="text-xl">Netcare RFC方案审核工具</DialogTitle>
        <DialogDescription>完成这三步，就能开始审核。配置会保存在本机，下次打开可以直接使用。</DialogDescription>
      </DialogHeader>
      <ol class="setup-steps-list">
        <li v-for="(item, index) in steps" :key="item.page">
          <span class="setup-number" :class="{ done: item.done }"><Check v-if="item.done" :size="16" /><span v-else>{{ index + 1 }}</span></span>
          <div><b>{{ item.title }}</b><p>{{ item.description }}</p></div>
        </li>
      </ol>
      <p class="field-hint">方案和审核记录保存在本机；审核时，相关方案内容会发送到你配置的模型服务。模型调用按服务商规则计费。</p>
      <DialogFooter>
        <Button variant="ghost" @click="emit('pause')">稍后配置</Button>
        <Button :disabled="busy" @click="emit('start')">从第一步开始<ArrowRight /></Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  <section v-if="active" class="setup-banner" aria-label="首次使用指引">
    <div class="setup-banner-top">
      <div class="setup-progress">
        <button v-for="(item, index) in steps" :key="item.page" :class="{ current: step === index + 1, done: item.done }" :disabled="busy || index + 1 > step" @click="emit('select', index + 1)">
          <Check v-if="item.done" :size="13" /><span v-else class="setup-step-index">{{ index + 1 }}</span>{{ item.title }}
        </button>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="暂时收起使用指引" @click="emit('pause')"><X :size="14" /></Button>
    </div>
    <div class="setup-banner-bottom">
      <p>{{ steps[step - 1]!.description }}</p>
      <Button size="sm" :disabled="busy" @click="emit('next')">{{ nextLabel }}<ArrowRight /></Button>
    </div>
  </section>
</template>
