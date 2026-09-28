<template>
    <div class="rfc-markdown" :class="{ compact }" v-html="html" @click.stop @keydown.stop />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ text: string; compact?: boolean }>()
// 审核内容与方案引用均不可信，只允许文本排版，不加载图片或执行 HTML。
const html = computed(() => {
    const fragment = DOMPurify.sanitize(marked.parse(props.text, { async: false, gfm: true, breaks: true }), {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a'],
        ALLOWED_ATTR: ['href', 'title', 'start', 'align'],
        RETURN_DOM_FRAGMENT: true,
    })
    fragment.querySelectorAll('a').forEach(link => {
        const href = link.getAttribute('href') || ''
        if (!/^https?:\/\//i.test(href)) link.removeAttribute('href')
        else { link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer') }
    })
    const container = document.createElement('div')
    container.append(fragment)
    return container.innerHTML
})
</script>

<style scoped>
.rfc-markdown { color: var(--foreground); font-size: 13px; line-height: 1.75; overflow-wrap: anywhere; }
.rfc-markdown :deep(p) { margin: 0 0 8px; }
.rfc-markdown :deep(h1), .rfc-markdown :deep(h2), .rfc-markdown :deep(h3), .rfc-markdown :deep(h4), .rfc-markdown :deep(h5), .rfc-markdown :deep(h6) { margin: 12px 0 6px; font-size: 14px; line-height: 1.5; font-weight: 600; color: var(--foreground); }
.rfc-markdown :deep(ul), .rfc-markdown :deep(ol) { margin: 6px 0 10px; padding-left: 22px; }
.rfc-markdown :deep(ul) { list-style: disc; }
.rfc-markdown :deep(ol) { list-style: decimal; }
.rfc-markdown :deep(li) { margin: 4px 0; }
.rfc-markdown :deep(strong) { font-weight: 600; color: var(--foreground); }
.rfc-markdown :deep(em) { font-style: italic; }
.rfc-markdown :deep(code) { padding: 2px 4px; border-radius: 4px; background: var(--muted); font-family: Consolas, monospace; font-size: 12px; }
.rfc-markdown :deep(pre) { margin: 8px 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--muted); overflow: auto; white-space: pre; }
.rfc-markdown :deep(pre code) { padding: 0; background: none; }
.rfc-markdown :deep(blockquote) { margin: 8px 0; padding: 4px 10px; border-left: 3px solid var(--border); color: var(--muted-foreground); }
.rfc-markdown :deep(table) { display: block; max-width: 100%; overflow-x: auto; margin: 8px 0; border-collapse: collapse; }
.rfc-markdown :deep(th), .rfc-markdown :deep(td) { padding: 6px 8px; border: 1px solid var(--border); min-width: 70px; }
.rfc-markdown :deep(th) { background: var(--muted); font-weight: 600; }
.rfc-markdown :deep(a) { color: var(--foreground); text-decoration: underline; }
.rfc-markdown :deep(hr) { margin: 12px 0; border: 0; border-top: 1px solid var(--border); }
.rfc-markdown :deep(> :first-child) { margin-top: 0; }
.rfc-markdown :deep(> :last-child) { margin-bottom: 0; }
.compact { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; pointer-events: none; }
</style>
