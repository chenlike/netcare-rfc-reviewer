<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import SelectField from './SelectField.vue';
import { api, save } from '../api';
import { LoaderCircle, CloudDownload, LogIn } from 'lucide-vue-next';
import type { RuleGroup, Task } from '../types/rfcAudit';

const props = defineProps<{ groups: RuleGroup[]; modelReady: boolean }>();
const emit = defineEmits<{ imported: [task: Task] }>();
const open = ref(false), number = ref(''), group = ref(''), busy = ref(false), error = ref('');
const session = ref({ available: true, state: 'disconnected', cached: false, message: '' });
const requestId = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const connecting = computed(() => ['login','verifying'].includes(session.value.state));
const canImport = computed(() => props.modelReady && !!group.value && /^NE\d{14}$/i.test(number.value.trim())
  && session.value.available && (session.value.cached || session.value.state === 'ready') && !connecting.value && !busy.value);
async function poll() {
  try { session.value = await api('/netcare/status'); }
  catch (e: any) { error.value = e.message; }
  if (!disposed && open.value) timer = setTimeout(poll, 1500);
}
watch(open, value => {
  clearTimeout(timer);
  if (value) { error.value = ''; group.value ||= props.groups.find(g => g.rules.some(r => r.enabled))?.id || ''; void poll(); }
});
watch([number, group], () => { if (!busy.value) requestId.value = ''; });
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
async function login(clear = false) {
  error.value = '';
  try { session.value = await save('/netcare/login', { clear }, 'POST'); }
  catch (e: any) { error.value = e.message; }
}
async function cancel() {
  try { session.value = await save('/netcare/cancel', {}, 'POST'); }
  catch (e: any) { error.value = e.message; }
}
async function importPlan() {
  if (!canImport.value) return;
  busy.value = true; error.value = '';
  requestId.value ||= crypto.randomUUID();
  try {
    const task = await api<Task>(`/tasks?group=${encodeURIComponent(group.value)}&fileName=${encodeURIComponent(number.value.trim().toUpperCase() + '.zip')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Id': requestId.value },
      body: JSON.stringify({ netcareNumber: number.value.trim().toUpperCase() }),
    });
    emit('imported', task); open.value = false; requestId.value = '';
  } catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <Button variant="outline" @click="open = true"><CloudDownload />从 Netcare 导入</Button>
  <Dialog :open="open" @update:open="value => { if (!busy) open = value }">
    <DialogContent class="sm:max-w-lg" @interact-outside="event => { if (busy) event.preventDefault() }">
      <DialogHeader>
        <DialogTitle>从 Netcare 导入方案</DialogTitle>
        <DialogDescription>登录后输入作业单号，自动下载 HTML 方案并开始审核。</DialogDescription>
      </DialogHeader>
      <div class="grid gap-4 py-2">
        <div v-if="!session.available" class="error-banner">请在桌面程序中使用 Netcare 登录与导入。</div>
        <div class="rounded-md border p-3 grid gap-3">
          <p class="text-sm" role="status">{{ session.message || (session.cached ? '已保存登录会话，导入时会检查是否有效' : '尚未连接 Netcare') }}</p>
          <p class="text-xs text-muted-foreground">在同一软件弹窗中完成登录，查询与下载服务均连接成功后自动关闭。登录会话保存在本机。</p>
          <div class="flex gap-2">
            <Button v-if="!connecting" variant="outline" size="sm" :disabled="busy || !session.available" @click="login()"><LogIn />{{ session.cached ? '重新连接' : '登录 Netcare' }}</Button>
            <Button v-if="!connecting && session.cached" variant="ghost" size="sm" :disabled="busy" @click="login(true)">切换账号</Button>
            <Button v-if="connecting" variant="outline" size="sm" @click="cancel()"><LoaderCircle class="animate-spin" />取消登录</Button>
          </div>
        </div>
        <label class="grid gap-2 text-sm">作业单号<Input v-model="number" placeholder="例如 NE20260828000800" :disabled="busy" maxlength="32" @keydown.enter="importPlan" /></label>
        <SelectField v-model="group" label="审核规则组" :disabled="busy" :options="groups.filter(g => g.rules.some(r => r.enabled)).map(g => ({ value: g.id, label: g.name }))" />
        <p v-if="!modelReady" class="text-sm text-muted-foreground">请先在模型设置中配置 API Key。</p>
        <p v-if="!groups.some(g => g.rules.some(r => r.enabled))" class="text-sm text-muted-foreground">请先添加至少包含一条启用规则的规则组。</p>
        <p v-if="busy" class="text-sm" role="status">{{ session.state === 'downloading' ? session.message : '正在下载并解析方案，请稍候…' }}</p>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
      </div>
      <DialogFooter>
        <Button v-if="busy" variant="outline" @click="cancel()">取消导入</Button>
        <Button variant="outline" :disabled="busy" @click="open = false">关闭</Button>
        <Button :disabled="!canImport" @click="importPlan"><LoaderCircle v-if="busy" class="animate-spin" />{{ busy ? '正在导入…' : '下载并开始审核' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
