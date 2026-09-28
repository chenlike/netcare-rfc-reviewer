import JSZip from 'jszip'
import type { RfcAuditDocument } from '@/types/rfcAudit'

export interface RfcArchive {
    readAsset: (path: string) => Promise<Blob>
    dispose: () => void
}

/** 一次加载 ZIP 索引，按需解压并复用包内资源；HTML 仍交由原预览清理器处理。 */
export async function openRfcArchive(blob: Blob, documents: RfcAuditDocument[], signal: AbortSignal): Promise<RfcArchive> {
    signal.throwIfAborted()
    if (blob.type.includes('json')) {
        let message = '方案包下载失败'
        try { const result = JSON.parse(await blob.text()); message = result.Message || result.message || message } catch { /* 非法响应使用默认提示。 */ }
        throw new Error(message)
    }
    if (blob.size > 50 * 1024 * 1024) throw new Error('方案 ZIP 超过 50 MB 预览限制')
    const manifest = new Map(documents.map(item => [item.Path, item]))
    if (!manifest.size || manifest.size > 2000 || documents.some(item => !Number.isSafeInteger(item.Size) || item.Size < 0)
        || documents.reduce((size, item) => size + item.Size, 0) > 150 * 1024 * 1024) throw new Error('方案资源清单无效或超过预览限制')
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    signal.throwIfAborted()
    for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue
        if (entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name) throw new Error('方案 ZIP 包含非规范路径')
    }
    const assets = new Map<string, Promise<Blob>>()
    let disposed = false
    const assertActive = () => { signal.throwIfAborted(); if (disposed) throw new Error('方案预览已关闭') }
    return {
        readAsset(path) {
            assertActive()
            const document = manifest.get(path)
            const entry = zip.file(path)
            if (!document || !entry) return Promise.reject(new Error(`方案包中找不到资源：${path}`))
            if (!assets.has(path)) assets.set(path, entry.async('uint8array').then(bytes => {
                assertActive()
                if (bytes.byteLength !== document.Size) throw new Error(`方案资源长度不匹配：${path}`)
                return new Blob([new Uint8Array(bytes)], { type: document.ContentType || 'application/octet-stream' })
            }))
            return assets.get(path)!
        },
        dispose() { disposed = true; assets.clear() },
    }
}
