import type { RfcAuditCheck, RfcAuditDocument } from '@/types/rfcAudit'

export interface RfcPreview {
    html: string
    warnings: string[]
    dispose: () => void
}

export type RfcFindingTone = 'success' | 'danger' | 'warning' | 'info'

/** 结论决定主色；未通过项再按必要/建议区分，避免必要项已通过仍显示红色。 */
export function rfcFindingTone(finding?: Pick<RfcAuditCheck, 'Verdict' | 'Level' | 'Status'>): RfcFindingTone {
    if (!finding) return 'warning'
    if (finding.Status !== 'completed') return 'info'
    if (finding.Verdict === 'passed') return 'success'
    if (finding.Verdict === 'failed') return /建议|可选|推荐|advis|recommend|optional|suggest/i.test(finding.Level) ? 'warning' : 'danger'
    return 'info'
}

/** 切换选中项时只撤销评审标记，保留方案自身的样式。 */
export function clearRfcHighlight(doc: Document) {
    doc.querySelectorAll('[data-rfc-highlight]').forEach(element => {
        element.removeAttribute('data-rfc-highlight')
        element.removeAttribute('data-rfc-highlight-tone')
    })
}

/** 只解析方案包内的相对路径；不能借预览请求访问其他任务或站外地址。 */
export function resolveDocumentPath(reference: string, fromPath: string): string | null {
    const value = reference.trim()
    if (!value || value.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('/') || value.includes('\\')) return null
    try {
        const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0] || '')
        if (!decoded || decoded.startsWith('/') || decoded.includes('\\')) return null
        const segments = fromPath.split('/').slice(0, -1)
        for (const segment of decoded.split('/')) {
            if (!segment || segment === '.') continue
            if (segment === '..') {
                if (!segments.length) return null
                segments.pop()
            } else segments.push(segment)
        }
        return segments.join('/')
    } catch { return null }
}

/** 下载后的资源只以 Blob URL 进入无脚本沙箱，登录令牌始终留在请求层。 */
export async function buildRfcPreview(
    source: string,
    path: string,
    documents: RfcAuditDocument[],
    readAsset: (path: string) => Promise<Blob>,
): Promise<RfcPreview> {
    const doc = new DOMParser().parseFromString(source, 'text/html')
    const manifest = new Map(documents.map(item => [item.Path, item]))
    const urls: string[] = []
    const cache = new Map<string, Promise<string>>()
    const warnings = new Set<string>()
    const dispose = () => urls.forEach(url => URL.revokeObjectURL(url))
    const makeUrl = (blob: Blob) => {
        const url = URL.createObjectURL(blob)
        urls.push(url)
        return url
    }

    async function localAsset(reference: string, basePath: string): Promise<string> {
        if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(reference)) return reference
        const target = resolveDocumentPath(reference, basePath)
        if (!target || !manifest.has(target)) return ''
        const entry = manifest.get(target)!
        if (!/^(image\/|font\/|audio\/|video\/|application\/(?:font-|vnd\.ms-fontobject|x-font-))/i.test(entry.ContentType)
            && !/\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|mp4|webm|mp3|ogg)$/i.test(target)) return ''
        if (!cache.has(target)) cache.set(target, readAsset(target).then(makeUrl).catch(() => {
            warnings.add(`资源无法加载：${target}`)
            return ''
        }))
        return cache.get(target)!
    }

    async function rewriteCss(css: string, basePath: string, ancestors = new Set<string>()): Promise<string> {
        // 对导入先递归展开；循环导入与包外 URL 均不进入预览。
        const imports = Array.from(css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"'\s);]+)["']?\s*\)?([^;]*);/gi))
        for (const match of imports) {
            const target = resolveDocumentPath(match[1] || '', basePath)
            let replacement = ''
            if (target && manifest.has(target) && /\.css$/i.test(target) && !ancestors.has(target)) {
                try {
                    const imported = await rewriteCss(await (await readAsset(target)).text(), target, new Set([...ancestors, target]))
                    const media = (match[2] || '').trim()
                    replacement = media ? `@media ${media} { ${imported} }` : imported
                } catch { warnings.add(`样式无法加载：${target}`) }
            }
            css = css.replace(match[0], replacement)
        }
        const refs = Array.from(css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi))
        for (const match of refs) {
            const reference = match[2] || ''
            if (reference.startsWith('blob:') || reference.startsWith('#')) continue
            const next = await localAsset(reference, basePath)
            css = css.replace(match[0], `url("${next}")`)
        }
        return css.replace(/@import[^;]*;?/gi, '')
    }

    try {
        // CSP 作为第二道约束，避免遗漏的 URL 属性或 CSS 转义触发网络访问。
        doc.querySelectorAll('script, iframe, frame, frameset, object, embed, base, meta, template, portal').forEach(node => node.remove())
        // Huawei 导出的目录由原脚本负责展开；评审采用完整静态目录，避免禁脚本后章节不可达。
        doc.querySelectorAll<HTMLElement>('#navigationTree [data-catanum]').forEach(node => node.style.setProperty('display', 'block', 'important'))
        doc.querySelectorAll('details').forEach(node => node.setAttribute('open', ''))
        for (const element of Array.from(doc.querySelectorAll('*'))) {
            // 原方案可能用表单容器承载正文；保留标签与兄弟顺序以维护 CSS 定位，仅禁用交互。
            if (element.matches('input,button,textarea,select')) element.setAttribute('disabled', '')
            for (const attribute of Array.from(element.attributes)) {
                const name = attribute.name.toLowerCase()
                if (name.startsWith('on') || ['srcdoc', 'srcset', 'ping', 'action', 'formaction', 'autofocus', 'nonce', 'integrity', 'contenteditable'].includes(name)) element.removeAttribute(attribute.name)
            }
            const style = element.getAttribute('style')
            if (style) element.setAttribute('style', await rewriteCss(style, path))
            if (element.tagName === 'LINK') {
                const target = resolveDocumentPath(element.getAttribute('href') || '', path)
                if (element.getAttribute('rel')?.toLowerCase() === 'stylesheet' && target && manifest.has(target) && /\.css$/i.test(target)) {
                    try {
                        const sheet = doc.createElement('style')
                        sheet.textContent = await rewriteCss(await (await readAsset(target)).text(), target, new Set([target]))
                        element.replaceWith(sheet)
                    } catch { warnings.add(`样式无法加载：${target}`); element.remove() }
                } else element.remove()
                continue
            }
            if (element.tagName === 'STYLE') element.textContent = await rewriteCss(element.textContent || '', path)
            for (const name of ['src', 'poster', 'background', 'xlink:href']) {
                const reference = element.getAttribute(name)
                if (reference !== null) {
                    if (name === 'xlink:href' && reference.startsWith('#')) continue
                    const url = await localAsset(reference, path)
                    if (url) element.setAttribute(name, url)
                    else element.removeAttribute(name)
                }
            }
            if (element.hasAttribute('href')) {
                const href = element.getAttribute('href') || ''
                const target = resolveDocumentPath(href, path)
                element.removeAttribute('href')
                if (element.tagName === 'A' && href.startsWith('#')) element.setAttribute('href', href)
                else if (element.tagName === 'A' && target && manifest.has(target) && /\.html?$/i.test(target)) {
                    element.setAttribute('href', '#')
                    element.setAttribute('data-rfc-document', target)
                    const fragment = href.indexOf('#')
                    if (fragment >= 0) element.setAttribute('data-rfc-fragment', href.slice(fragment + 1))
                } else if (element.namespaceURI === 'http://www.w3.org/2000/svg' && href.startsWith('#')) element.setAttribute('href', href)
            }
            element.removeAttribute('target')
            element.removeAttribute('download')
        }
        const policy = doc.createElement('meta')
        policy.httpEquiv = 'Content-Security-Policy'
        policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
        doc.head.prepend(policy)
        const style = doc.createElement('style')
        style.textContent = `html { overflow-wrap: anywhere; } img { max-width: 100%; }
            [data-rfc-highlight] { outline: 3px solid #e6a23c !important; outline-offset: 3px !important; background-color: #fdf6ec !important; scroll-margin: 32px; }
            [data-rfc-highlight-tone="danger"] { outline-color: #f56c6c !important; background-color: #fef0f0 !important; }
            [data-rfc-highlight-tone="success"] { outline-color: #67c23a !important; background-color: #f0f9eb !important; }
            [data-rfc-highlight-tone="info"] { outline-color: #909399 !important; outline-style: dashed !important; background-color: #f4f4f5 !important; }`
        doc.head.append(style)
        return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, warnings: [...warnings], dispose }
    } catch (error) { dispose(); throw error }
}

/** 模型只提供 CSS 选择器和原文，不执行模型返回的任何定位代码。 */
export function locateRfcFinding(doc: Document, selector?: string, quote?: string, finding?: Pick<RfcAuditCheck, 'Verdict' | 'Level' | 'Status'>): Element | null {
    clearRfcHighlight(doc)
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
    const expected = normalize(quote || '')
    const matchesQuote = (element: Element) => {
        if (!expected || normalize(element.textContent || '').includes(expected)) return true
        // 执行层会为表格单元和方案导出表单增加可读标注，定位时保留相同语义。
        const clone = element.cloneNode(true) as Element
        clone.querySelectorAll('script,style,noscript,template').forEach(node => node.remove())
        const checkedNodes = [...(clone.matches('[data-hd-owschecked]') ? [clone] : []), ...clone.querySelectorAll('[data-hd-owschecked]')]
        checkedNodes.forEach(node => {
            const value = node.getAttribute('data-hd-owschecked')?.toUpperCase()
            if (value === 'Y' || value === 'N') { node.prepend(value === 'Y' ? '[已选：' : '[未选：'); node.append('] ') }
        })
        clone.querySelectorAll('[data-hd-promptmessage="true"]').forEach(node => { node.prepend('[表单提示：'); node.append('] ') })
        clone.querySelectorAll('input').forEach(node => {
            const type = node.getAttribute('type')?.toLowerCase()
            node.replaceWith(type === 'checkbox' || type === 'radio' ? (node.hasAttribute('checked') ? ' [已选] ' : ' [未选] ') : ` ${node.getAttribute('value') || ''} `)
        })
        clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'))
        clone.querySelectorAll('td,th').forEach(node => node.prepend(' | '))
        return normalize(clone.textContent || '').includes(expected)
    }
    let target: Element | null = null
    const validTarget = (element: Element) => doc.body.contains(element) && (element !== doc.body || !!expected)
        && !element.closest('script,style,noscript,template,head')
    if (selector) {
        try {
            const candidates = doc.querySelectorAll(selector)
            const candidate = candidates.length === 1 ? candidates[0] : null
            if (candidate && validTarget(candidate) && matchesQuote(candidate)) target = candidate
        } catch { /* 无效选择器继续用原文定位，不执行脚本。 */ }
    }
    if (!target && expected) {
        const candidates = Array.from(doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,tr,td,th,pre,code,figcaption,div,section,span,blockquote'))
            .filter(element => validTarget(element) && matchesQuote(element))
        // 同一段文字会同时命中外层章节和内层段落；只保留最深节点。
        // 两个独立分支仍然命中时无法证明位置唯一，不能任取第一个或最短的段落。
        const deepest = candidates.filter(candidate => !candidates.some(other => other !== candidate && candidate.contains(other)))
        if (deepest.length === 1) target = deepest[0] || null
    }
    if (target) {
        target.setAttribute('data-rfc-highlight', 'true')
        target.setAttribute('data-rfc-highlight-tone', rfcFindingTone(finding))
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    return target
}
