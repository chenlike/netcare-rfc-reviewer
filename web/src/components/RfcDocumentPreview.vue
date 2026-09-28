<template>
    <section class="document-preview">
        <div v-if="state.loading" class="preview-loading"><LoaderCircle class="animate-spin" :size="22" />正在准备方案…</div><div v-if="state.error" class="error-banner" role="alert">{{ state.error }}</div>
        <div v-if="state.warnings.length" class="preview-note">{{ state.warnings.join('；') }}</div>
        <iframe v-if="state.html" ref="frame" class="preview-frame" :srcdoc="state.html" sandbox="allow-same-origin"
            referrerpolicy="no-referrer" title="RFC 方案文档预览" @load="onFrameLoaded" />
        <div v-else-if="!state.loading && !state.error" class="empty-state">暂无可预览的 HTML 方案</div>
    </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { notify } from '@/lib/feedback'
import { LoaderCircle } from 'lucide-vue-next'
import { downloadPackage } from '../api'
import type { RfcAuditCheck, RfcAuditDocument } from '@/types/rfcAudit'
import { buildRfcPreview, clearRfcHighlight, locateRfcFinding, type RfcPreview } from './rfcPreview'
import { openRfcArchive, type RfcArchive } from './rfcArchive'

const props = defineProps<{ taskId: string; entryPath: string; documents: RfcAuditDocument[]; finding: RfcAuditCheck | null; findingKey?: number }>()
const frame = ref<HTMLIFrameElement | null>(null)
const state = reactive({
    path: '', html: '', loading: false, error: '', warnings: [] as string[], locationMessage: '',
    htmlDocuments: computed(() => props.documents.filter(item => /\.html?$/i.test(item.Path))),
})
let generation = 0
let preview: RfcPreview | null = null
let controller: AbortController | null = null
let pendingAnchor: { path: string; fragment: string } | null = null
let archivePromise: Promise<RfcArchive> | null = null
let archiveController: AbortController | null = null

/** 同一任务切换 HTML 时共享压缩包，只有重新加载、切换任务或卸载才释放。 */
function releaseArchive() {
    archiveController?.abort()
    if (archivePromise) void archivePromise.then(archive => archive.dispose(), () => {})
    archivePromise = null
    archiveController = null
}

/** 仅通过授权下载接口请求一次完整 ZIP，不再逐项调用 Asset。 */
function getArchive() {
    if (!archivePromise) {
        const active = new AbortController()
        archiveController = active
        const taskId = props.taskId, documents = props.documents
        archivePromise = downloadPackage(taskId, active.signal).then(blob => openRfcArchive(blob, documents, active.signal)).catch(error => {
            if (archiveController === active) archivePromise = null
            throw error
        })
    }
    return archivePromise
}

function loadSelectedPage() {
    if (state.loading || !state.path) return
    pendingAnchor = null
    releaseArchive()
    void load()
}

/** 切换任务时取消资源请求并回收 Blob，防止旧任务迟到的响应覆盖新预览。 */
async function load() {
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    const documentPath = state.path, documents = props.documents
    preview?.dispose()
    preview = null
    Object.assign(state, { loading: true, html: '', error: '', warnings: [], locationMessage: '' })
    try {
        if (!documentPath) return
        const archive = await getArchive()
        signal.throwIfAborted()
        const readAsset = (path: string) => { signal.throwIfAborted(); return archive.readAsset(path) }
        const source = await (await readAsset(documentPath)).text()
        const next = await buildRfcPreview(source, documentPath, documents, readAsset)
        if (current !== generation) { next.dispose(); return }
        preview = next
        state.html = next.html
        state.warnings = next.warnings
    } catch (error: any) {
        if (current === generation && !signal.aborted) state.error = error?.response?.data?.Message || error.message || '方案预览加载失败，请重新加载'
    } finally { if (current === generation) state.loading = false }
}

function locate() {
    const finding = props.finding
    const doc = frame.value?.contentDocument
    if (doc) clearRfcHighlight(doc)
    if (!finding) return
    if (finding.Status !== 'completed') { state.locationMessage = '待确认，尚无评审定位。'; return }
    if ((finding.DocumentPath || props.entryPath) !== state.path) {
        state.locationMessage = '当前查看其他方案页面，可再次点击右侧检查项返回此项原文。'
        return
    }
    if (!finding.Selector && !finding.Quote) {
        state.locationMessage = '全文意见：此项针对整体方案或缺失内容，没有对应的原文段落。'
        return
    }
    if (!doc) return
    const target = locateRfcFinding(doc, finding.Selector, finding.Quote, finding)
    state.locationMessage = target ? '' : '未能在当前页面找到匹配原文，请结合检查描述和原文引用确认。'
}

/** 每次点击都可重新定位，独立的序号避免同一对象重复选中时 Vue 不触发监听。 */
async function focusFinding() {
    pendingAnchor = null
    state.locationMessage = ''
    const finding = props.finding
    if (!finding || finding.Status !== 'completed') { locate(); return }
    const target = finding.DocumentPath || props.entryPath
    if (target && !state.htmlDocuments.some(item => item.Path === target)) {
        if (frame.value?.contentDocument) clearRfcHighlight(frame.value.contentDocument)
        state.locationMessage = `检查项引用的页面不存在：${target}`
        return
    }
    if (target && target !== state.path) { state.path = target; await load() }
    else locate()
}

function scrollToAnchor(doc: Document, fragment: string) {
    try { doc.getElementById(decodeURIComponent(fragment))?.scrollIntoView({ block: 'start' }) }
    catch { /* 无效锚点保持当前方案，不尝试外部导航。 */ }
}

function onFrameLoaded(event: Event) {
    if (event.currentTarget !== frame.value) return
    const doc = frame.value?.contentDocument
    doc?.addEventListener('click', event => {
        const anchor = (event.target as Element | null)?.closest('a')
        if (!anchor) return
        // srcdoc 的基准 URL 继承主页面，锚点必须在预览 DOM 内滚动，避免导航到业务站点。
        event.preventDefault()
        const target = anchor.getAttribute('data-rfc-document')
        if (target && state.htmlDocuments.some(item => item.Path === target)) {
            const fragment = anchor.getAttribute('data-rfc-fragment') || ''
            if (target === state.path) { scrollToAnchor(doc!, fragment); return }
            pendingAnchor = { path: target, fragment }
            state.path = target
            void load()
        } else {
            const href = anchor.getAttribute('href') || ''
            if (href.startsWith('#') && doc) scrollToAnchor(doc, href.slice(1))
        }
    })
    if (pendingAnchor?.path === state.path && doc) {
        scrollToAnchor(doc, pendingAnchor.fragment)
        pendingAnchor = null
        if (props.finding) state.locationMessage = '当前查看方案引用页面，可再次点击右侧检查项返回检查项原文。'
    } else locate()
}

watch(() => props.taskId, () => {
    releaseArchive()
    pendingAnchor = null
    state.path = props.entryPath || state.htmlDocuments[0]?.Path || ''
    void load()
}, { immediate: true })
watch([() => props.finding, () => props.findingKey], () => { void focusFinding() })
watch(() => state.locationMessage, message => {
    if (message && props.finding?.Status === 'completed') notify.info({ message, duration: 3500 })
})
defineExpose({ focusFinding, reload: loadSelectedPage, loading: computed(() => state.loading) })
onBeforeUnmount(() => { generation++; controller?.abort(); preview?.dispose(); releaseArchive() })
</script>

<style scoped>
.document-preview { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.preview-frame { flex: 1; width: 100%; min-height: 0; border: 0; background: #fff; }
.preview-note { padding: 8px 12px; color: var(--muted-foreground); font-size: 12px; line-height: 1.5; border-top: 1px solid var(--border); background: var(--muted); }
</style>
