import { createHash } from 'node:crypto'
import path from 'node:path'
import * as cheerio from 'cheerio'
import { parse as parseSelector, type Selector } from 'css-what'
import type { AnyNode, Element } from 'domhandler'
import sharp from 'sharp'
import yauzl from 'yauzl'

/** 静态材料块；选择器只用于定位，永远不作为脚本执行。 */
export interface DocumentBlock {
  id: string; documentPath: string; selector: string; text: string; heading: string
  kind: 'text' | 'heading' | 'table' | 'image'; imageIds: string[]
}
export interface DocumentSummary { path: string; title: string; blockCount: number }
export interface DocumentImage { id: string; documentPath: string; selector: string; path: string; mimeType: string; data: Buffer; width: number; height: number }
export interface ReviewPackage {
  documents: DocumentSummary[]; blocks: DocumentBlock[]; images: DocumentImage[]
  warnings: string[]; packageHash: string
  assets?: { path: string; size: number }[]
}
export interface EvidenceLocation { DocumentPath?: string; Selector?: string; Quote?: string; Verdict?: string }
const doms = new WeakMap<ReviewPackage, Map<string, cheerio.CheerioAPI>>()
const MAX_ZIP = 50 * 1024 * 1024
const MAX_ENTRY = 50 * 1024 * 1024
const MAX_TOTAL = 150 * 1024 * 1024
const MAX_TEXT = 5_000_000
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim()
/** 表格布局只在内存中保存；模型读取时按需返回相关行的短引用。 */
const tableLayouts = new WeakMap<Element, { row: number; cells: { node: Element; column: number; rowspan: number; colspan: number }[] }>()

/** 计算合并单元格的真实列位置，不能把上一行跨行单元格占用的位置丢掉。 */
function tableLayout($: cheerio.CheerioAPI, row: Element) {
  if (!tableLayouts.has(row)) {
    const table = $(row).closest('table').get(0)
    const rows = table ? $(table).find('tr').toArray().filter(item => $(item).closest('table').get(0) === table) : [row]
    const occupied = new Map<number, number>()
    rows.forEach((item, index) => {
      if (index === 0 || rows[index - 1]!.parent !== item.parent) occupied.clear()
      let groupEnd = index + 1
      while (groupEnd < rows.length && rows[groupEnd]!.parent === item.parent) groupEnd++
      let column = 1
      const cells: { node: Element; column: number; rowspan: number; colspan: number }[] = []
      $(item).children('td,th').each((_, cell) => {
        while ((occupied.get(column) ?? -1) >= index) column++
        const rawRowspan = Number($(cell).attr('rowspan') ?? 1)
        const rowspan = rawRowspan === 0 ? groupEnd - index : Math.max(1, Math.min(groupEnd - index, Math.trunc(rawRowspan) || 1))
        const colspan = Math.max(1, Math.min(1000, Math.trunc(Number($(cell).attr('colspan') ?? 1)) || 1))
        cells.push({ node: cell as Element, column, rowspan, colspan })
        for (let col = column; col < column + colspan; col++) occupied.set(col, index + rowspan - 1)
        column += colspan
      })
      tableLayouts.set(item as Element, { row: index + 1, cells })
    })
  }
  return tableLayouts.get(row)!
}

const locationPseudos = new Set(['root', 'scope', 'empty', 'first-child', 'last-child', 'only-child',
  'first-of-type', 'last-of-type', 'only-of-type', 'checked', 'disabled', 'enabled', 'required', 'optional', 'any-link', 'link'])
const locationNthPseudos = new Set(['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type'])
const locationSelectorPseudos = new Set(['is', 'where', 'not', 'has'])

/** 限定为浏览器与解析器共有的定位语法，递归拒绝 jQuery 扩展，不能只检查最外层伪类。 */
function validateLocationSelector(selectors: Selector[][], relative = false, insideHas = false): void {
  if (!selectors.length) throw new Error('INVALID_SELECTOR')
  for (const group of selectors) {
    if (!group.length) throw new Error('INVALID_SELECTOR')
    let previousWasCombinator = false
    for (let index = 0; index < group.length; index++) {
      const token = group[index]!
      const combinator = ['child', 'descendant', 'adjacent', 'sibling'].includes(token.type)
      if (combinator) {
        if ((!relative && index === 0) || previousWasCombinator || index === group.length - 1) throw new Error('INVALID_SELECTOR')
      } else if (token.type === 'tag' || token.type === 'universal') {
        if (token.namespace !== null) throw new Error('INVALID_SELECTOR')
      } else if (token.type === 'attribute') {
        if (token.action === 'not' || token.namespace !== null) throw new Error('INVALID_SELECTOR')
      } else if (token.type === 'pseudo') {
        if (locationSelectorPseudos.has(token.name)) {
          if (!Array.isArray(token.data) || (token.name === 'has' && insideHas)) throw new Error('INVALID_SELECTOR')
          validateLocationSelector(token.data, token.name === 'has', insideHas || token.name === 'has')
        } else if (locationNthPseudos.has(token.name)) {
          if (typeof token.data !== 'string') throw new Error('INVALID_SELECTOR')
        } else if (!locationPseudos.has(token.name) || token.data !== null) {
          throw new Error('INVALID_SELECTOR')
        }
      } else {
        // 伪元素、非标准父组合器等不能作为原文元素定位。
        throw new Error('INVALID_SELECTOR')
      }
      previousWasCombinator = combinator
    }
  }
}

/** 校验包路径，不解压到文件系统，也不允许路径别名冲突。 */
function safePath(name: string): string {
  const normalized = name.replace(/\\/g, '/').normalize('NFC')
  const parts = normalized.replace(/\/$/, '').split('/')
  if (!normalized || normalized.startsWith('/') || /[:\u0000-\u001f\u007f]/u.test(normalized)
    || parts.some(part => !part || part === '.' || part === '..' || /[ .]$/u.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error('UNSAFE_ZIP_ENTRY')
  return normalized
}

/** 按实际解压字节数限制内存，避免依赖可伪造的 ZIP 目录大小。 */
export async function readArchive(raw: Buffer): Promise<Map<string, Buffer>> {
  if (!raw.length || raw.length > MAX_ZIP) throw new Error('ZIP_SIZE_LIMIT')
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(raw, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new Error('INVALID_ZIP'))
      const entries = new Map<string, Buffer>(), names = new Set<string>()
      let count = 0, total = 0, failed = false
      const fail = (cause: unknown) => { if (!failed) { failed = true; zip.close(); reject(cause) } }
      zip.on('error', fail)
      zip.on('end', () => { if (!failed) resolve(entries) })
      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          if (++count > 10_000) throw new Error('ZIP_ENTRY_LIMIT')
          const name = safePath(entry.fileName), key = name.replace(/\/$/, '').toLocaleLowerCase('en-US')
          if (names.has(key)) throw new Error('DUPLICATE_ZIP_ENTRY')
          names.add(key)
          if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000 || entry.isEncrypted()) throw new Error('UNSAFE_ZIP_ENTRY')
          if (entry.uncompressedSize > MAX_ENTRY || total + entry.uncompressedSize > MAX_TOTAL
            || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 2000) throw new Error('ZIP_EXPANSION_LIMIT')
          if (name.endsWith('/')) { zip.readEntry(); return }
          zip.openReadStream(entry, (readError, stream) => {
            if (readError || !stream) return fail(new Error('INVALID_ZIP_ENTRY'))
            const chunks: Buffer[] = []; let size = 0
            stream.on('error', fail)
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length; total += chunk.length
              if (size > MAX_ENTRY || total > MAX_TOTAL) { stream.destroy(); fail(new Error('ZIP_EXPANSION_LIMIT')); return }
              chunks.push(chunk)
            })
            stream.on('end', () => { if (!failed) { entries.set(name, Buffer.concat(chunks)); zip.readEntry() } })
          })
        } catch (cause) { fail(cause) }
      })
      zip.readEntry()
    })
  })
}

function decodeHtml(raw: Buffer): string {
  const prefix = raw.subarray(0, 4096).toString('ascii')
  const charset = /charset\s*=\s*["']?([\w-]+)/iu.exec(prefix)?.[1]
  if (charset && /^(gbk|gb2312|gb18030|big5|utf-16le)$/iu.test(charset)) return new TextDecoder(charset).decode(raw)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw) }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(raw) }
}

/** 使用同类型兄弟序号，防止删除脚本后文本节点定位发生漂移。 */
function selectorFor(node: Element): string {
  const parts: string[] = []
  let current: AnyNode | null = node
  while (current && current.type !== 'root') {
    if ('tagName' in current) {
      const element = current as Element
      const siblings = element.parent?.children.filter(sibling => 'tagName' in sibling && sibling.tagName === element.tagName) ?? [element]
      parts.unshift(`${element.tagName}:nth-of-type(${siblings.indexOf(element) + 1})`)
    }
    current = current.parent
  }
  return parts.join(' > ')
}

/** 保留导出表单的已选/未选状态，防止把提示文字误当成填写结果。 */
function readableText($: cheerio.CheerioAPI, node: AnyNode): string {
  const copy = $(node).clone()
  copy.find('script,style,noscript,template').remove()
  copy.find('[data-hd-owschecked]').each((_, child) => {
    const value = $(child).attr('data-hd-owschecked')?.toUpperCase()
    if (value === 'Y' || value === 'N') $(child).prepend(value === 'Y' ? '[已选：' : '[未选：').append('] ')
  })
  copy.find('[data-hd-promptmessage="true"]').prepend('[表单提示：').append('] ')
  copy.find('input').each((_, child) => {
    const input = $(child), type = input.attr('type')?.toLowerCase()
    input.replaceWith(type === 'checkbox' || type === 'radio' ? (input.attr('checked') !== undefined ? ' [已选] ' : ' [未选] ') : ` ${input.attr('value') ?? ''} `)
  })
  copy.find('br').replaceWith('\n')
  copy.find('td,th').prepend(' | ')
  return normalize(copy.text())
}

async function normalizedImage(raw: Buffer, isSvg: boolean): Promise<{ data: Buffer; mimeType: string; width: number; height: number }> {
  if (raw.length > 20 * 1024 * 1024) throw new Error('IMAGE_SIZE_LIMIT')
  if (isSvg) {
    const $ = cheerio.load(raw.toString('utf8'), { xmlMode: true })
    $('script,foreignObject,style').remove()
    $('*').each((_, node) => {
      if (!('attribs' in node)) return
      for (const [name, value] of Object.entries(node.attribs)) {
        if (/^on/iu.test(name) || /url\s*\(/iu.test(value)
          || (/(?:href|src)$/iu.test(name) && !value.startsWith('#') && !value.startsWith('data:image/'))) $(node).removeAttr(name)
      }
    })
    raw = Buffer.from($.xml())
  }
  const pipeline = sharp(raw, { limitInputPixels: 40_000_000, animated: false })
  const metadata = await pipeline.metadata()
  if (!metadata.width || !metadata.height) throw new Error('IMAGE_INVALID')
  // 保留原始分辨率，密集拓扑图可以在后续工具调用中裁切放大。
  const data = await pipeline.png().toBuffer()
  if (data.length > 20 * 1024 * 1024) throw new Error('IMAGE_SIZE_LIMIT')
  return { data, mimeType: 'image/png', width: metadata.width, height: metadata.height }
}

/** 读取全部 HTML，既不执行脚本，也不请求包内的任何远程地址。 */
export async function parsePackage(raw: Buffer): Promise<ReviewPackage> {
  const entries = await readArchive(raw)
  const result: ReviewPackage = { documents: [], blocks: [], images: [], warnings: [], packageHash: digest(raw) }
  const parsed = new Map<string, cheerio.CheerioAPI>()
  doms.set(result, parsed)
  const hasBookmap = [...entries.keys()].some(name => /(?:^|\/)zh-cn_bookmap_[^/]+\.html$/iu.test(name))
  let totalText = 0, totalImageBytes = 0
  for (const [documentPath, content] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.html?$/iu.test(documentPath)) continue
    const $ = cheerio.load(decodeHtml(content)); parsed.set(documentPath, $)
    const exportedArticles = $('article.articleBox[data-hd-id]').length > 0
    // 方案中心的执行页是导航外壳，作为包内资源保留，不把按钮文案当作方案正文。
    if (hasBookmap && /(?:^|\/)resource\/execute_page\.html$/iu.test(documentPath) && !exportedArticles) continue
    const scope = exportedArticles ? 'article.articleBox' : 'body'
    const first = result.blocks.length
    let heading = ''
    const imageNodes = $(`${scope} img, ${scope} svg`).toArray().filter((node): node is Element => 'tagName' in node)
    for (const node of imageNodes) {
      const selector = selectorFor(node), id = digest(`${documentPath}:${selector}`).slice(0, 24)
      let source = $(node).attr('src') ?? '', data: Buffer | undefined, svg = node.tagName === 'svg'
      if (svg) { source = `inline-svg:${id}`; data = Buffer.from($.html(node)) }
      else if (/^data:image\//iu.test(source)) {
        const match = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([a-z\d+/=\s]+)$/iu.exec(source)
        if (match) { data = Buffer.from(match[2]!, 'base64'); svg = match[1]!.toLowerCase() === 'svg+xml'; source = `inline-image:${id}` }
      } else if (source && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(source)) {
        try {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(documentPath), decodeURIComponent(source.split(/[?#]/u)[0]!)))
          if (!target.startsWith('../') && !target.startsWith('/')) { data = entries.get(target); source = target; svg = /\.svg$/iu.test(target) }
        } catch { /* 无效引用作为警告，不能猜测图片内容。 */ }
      }
      if (!data) { result.warnings.push(`${documentPath} 图片无法读取：${source.slice(0, 200)}`); continue }
      try {
        const image = await normalizedImage(data, svg)
        if (result.images.length >= 1000 || totalImageBytes + image.data.length > 128 * 1024 * 1024) {
          result.warnings.push(`${documentPath} 图片总量超过读取限制：${source.slice(0, 200)}`)
          continue
        }
        totalImageBytes += image.data.length
        result.images.push({ id, documentPath, selector, path: source, ...image })
      } catch { result.warnings.push(`${documentPath} 图片格式或大小不支持：${source.slice(0, 200)}`) }
    }
    const candidate = 'h1,h2,h3,h4,h5,h6,p,li,tr,pre,blockquote,figcaption'
    $(`${scope} *`).each((_, node) => {
      if (!('tagName' in node) || $(node).parents('script,style,noscript,template').length) return
      const tag = node.tagName
      // 表格整行和列表项保持上下文；其后代不重复进入模型上下文。
      if ($(node).parents('tr,li,pre,blockquote').length) return
      const isImage = tag === 'img' || tag === 'svg'
      const selected = $(node).is(candidate) || (['div', 'section', 'article', 'main'].includes(tag) && !$(node).find(candidate).length && !$(node).children('div,section,article,main').length)
      if (!selected && !isImage) return
      const selector = selectorFor(node)
      const text = isImage ? normalize($(node).attr('alt') ?? $(node).find('title').first().text()) : readableText($, node)
      const imageIds = result.images.filter(image => image.documentPath === documentPath && (image.selector === selector || image.selector.startsWith(`${selector} > `))).map(image => image.id)
      if (!text && !isImage) return
      if (/^h[1-6]$/u.test(tag)) heading = text
      totalText += text.length
      if (totalText > MAX_TEXT || result.blocks.length > 30_000) throw new Error('DOCUMENT_SIZE_LIMIT')
      result.blocks.push({ id: digest(`${documentPath}:${selector}`).slice(0, 24), documentPath, selector, text, heading,
        kind: isImage ? 'image' : /^h[1-6]$/u.test(tag) ? 'heading' : tag === 'tr' ? 'table' : 'text', imageIds })
    })
    if (result.blocks.length === first) {
      const body = $('body').get(0)!, text = readableText($, body)
      if (text) {
        totalText += text.length
        if (totalText > MAX_TEXT) throw new Error('DOCUMENT_SIZE_LIMIT')
        result.blocks.push({ id: digest(documentPath).slice(0, 24), documentPath, selector: selectorFor(body), text, heading: '', kind: 'text', imageIds: [] })
      }
    }
    result.documents.push({ path: documentPath, title: $('title').text() || (exportedArticles ? $('.header > span').last().text() : '') || $('h1').first().text() || documentPath, blockCount: result.blocks.length - first })
  }
  if (!result.documents.length || !result.blocks.length) throw new Error('DOCUMENT_PARSE_EMPTY')
  result.warnings = [...new Set(result.warnings)]
  result.assets = [...entries].map(([path, data]) => ({ path, size: data.length }))
  return result
}

export function readBlocks(pkg: ReviewPackage, documentPath?: string, offset = 0, limit = 20) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('INVALID_PAGE')
  if (documentPath && !pkg.documents.some(document => document.path === documentPath)) throw new Error('DOCUMENT_NOT_FOUND')
  const source = pkg.blocks.filter(block => !documentPath || block.documentPath === documentPath)
  const blocks = source.slice(offset, offset + limit)
  return { blocks, nextOffset: offset + blocks.length, hasMore: offset + blocks.length < source.length }
}

export function searchDocument(pkg: ReviewPackage, query: string, documentPath?: string): DocumentBlock[] {
  if (!query.trim()) throw new Error('EMPTY_QUERY')
  return pkg.blocks.filter(block => (!documentPath || block.documentPath === documentPath) && `${block.heading} ${block.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 30)
}

export function getImage(pkg: ReviewPackage, id: string): { type: 'image'; mimeType: string; data: string } {
  const image = pkg.images.find(item => item.id === id)
  if (!image) throw new Error('IMAGE_NOT_FOUND')
  return { type: 'image', mimeType: image.mimeType, data: image.data.toString('base64') }
}

/** 使用原图裁切；模型可多次查看拓扑不同区域而不丢失小字号和连线。 */
export async function getImageRegion(pkg: ReviewPackage, id: string, region?: { x: number; y: number; width: number; height: number }): Promise<{ type: 'image'; mimeType: string; data: string }> {
  const image = pkg.images.find(item => item.id === id)
  if (!image) throw new Error('IMAGE_NOT_FOUND')
  const pipeline = sharp(image.data)
  if (region) {
    const { x, y, width, height } = region
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) throw new Error('INVALID_IMAGE_REGION')
    const left = Math.floor(x * image.width), top = Math.floor(y * image.height)
    if (left >= image.width || top >= image.height) throw new Error('INVALID_IMAGE_REGION')
    pipeline.extract({ left, top, width: Math.min(image.width - left, Math.max(1, Math.ceil(width * image.width))), height: Math.min(image.height - top, Math.max(1, Math.ceil(height * image.height))) })
  }
  const data = await pipeline.resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
  return { type: 'image', mimeType: 'image/png', data: data.toString('base64') }
}

/** 写回前核对定位及原文，拒绝模型杜撰的选择器和引文。 */
export function validateEvidence(pkg: ReviewPackage, evidence: EvidenceLocation): void {
  if (!evidence.DocumentPath && !evidence.Selector && !evidence.Quote && evidence.Verdict === 'failed') return
  const $ = doms.get(pkg)?.get(evidence.DocumentPath ?? '')
  if (!$ || typeof evidence.Selector !== 'string' || !evidence.Selector || evidence.Selector.length > 2000) throw new Error('EVIDENCE_LOCATION_REQUIRED')
  let nodes
  try {
    validateLocationSelector(parseSelector(evidence.Selector))
    // 仅查询已载入文档；$(字符串) 会把 HTML 字符串解释为新建脱离文档的节点。
    nodes = $.root().find(evidence.Selector)
  } catch { throw new Error('INVALID_SELECTOR') }
  if (nodes.length !== 1) throw new Error('EVIDENCE_SELECTOR_NOT_UNIQUE')
  let ancestor: AnyNode = nodes.get(0)!
  while (ancestor.parent) ancestor = ancestor.parent
  if (ancestor !== $.root().get(0)) throw new Error('INVALID_SELECTOR')
  const removedFromPreview = 'head,script,style,noscript,iframe,frame,frameset,object,embed,base,meta,template,portal'
  if ((!nodes.is('body') && !nodes.parents('body').length) || nodes.is(removedFromPreview) || nodes.parents(removedFromPreview).length) {
    throw new Error('EVIDENCE_HIDDEN_CONTENT')
  }
  const quote = normalize(evidence.Quote ?? '')
  if (quote && !readableText($, nodes.get(0)!).includes(quote) && !normalize(nodes.text()).includes(quote)) throw new Error('EVIDENCE_QUOTE_MISMATCH')
  if (!quote && !pkg.images.some(image => image.documentPath === evidence.DocumentPath && image.selector === evidence.Selector)) throw new Error('EVIDENCE_QUOTE_REQUIRED')
}

export interface ReadRange { blockId: string; start: number; end: number; text: string }
export interface CompactPage { data: { text: string; nextCursor?: string; total?: number }; ranges: ReadRange[] }
interface Section { ref: string; documentPath: string; title: string; start: number; end: number; level: number }
interface CompactIndex {
  sections: Section[]; blockSections: Map<string, string>; metadata: Map<string, string>;
  blocks: Map<string, DocumentBlock>; images: Map<string, DocumentImage>;
}
const compactIndexes = new WeakMap<ReviewPackage, CompactIndex>()

/** 启发式估算仅控制本地返回量；实际账单以供应商 usage 为准。 */
export function estimateTokens(text: string): number {
  let units = 0
  for (const char of text) units += char.codePointAt(0)! < 128 ? 1 : 4
  return Math.ceil(units / 4)
}

export function blockReference(pkg: ReviewPackage, id: string): string {
  const index = pkg.blocks.findIndex(block => block.id === id)
  if (index < 0) throw new Error('BLOCK_NOT_FOUND')
  return `B${index + 1}`
}
export function imageReference(pkg: ReviewPackage, id: string): string {
  const index = pkg.images.findIndex(image => image.id === id)
  if (index < 0) throw new Error('IMAGE_NOT_FOUND')
  return `I${index + 1}`
}

function compactIndex(pkg: ReviewPackage): CompactIndex {
  const existing = compactIndexes.get(pkg)
  if (existing) return existing
  const index: CompactIndex = { sections: [], blockSections: new Map(), metadata: new Map(),
    blocks: new Map(pkg.blocks.map((block, i) => [`B${i + 1}`, block])),
    images: new Map(pkg.images.map((image, i) => [`I${i + 1}`, image])) }
  let current: Section | undefined
  const open: Section[] = [], tableIds = new Map<Element, string>(), nodeBlocks = new Map<AnyNode, string>()
  for (const [i, block] of pkg.blocks.entries()) {
    const $ = doms.get(pkg)?.get(block.documentPath), node = $?.root().find(block.selector).get(0)
    if (node) nodeBlocks.set(node, `B${i + 1}`)
    if (!current || current.documentPath !== block.documentPath || block.kind === 'heading') {
      const level = block.kind === 'heading' && node && 'tagName' in node ? Number(node.tagName.slice(1)) || 1 : 0
      while (open.length && (open.at(-1)!.documentPath !== block.documentPath || open.at(-1)!.level >= level)) open.pop()!.end = i
      current = { ref: `S${index.sections.length + 1}`, documentPath: block.documentPath,
        title: block.kind === 'heading' ? block.text : '正文', start: i, end: pkg.blocks.length, level }
      index.sections.push(current); open.push(current)
    }
    index.blockSections.set(block.id, current.ref)
  }
  for (const block of pkg.blocks) {
    const images = block.imageIds.map(id => imageReference(pkg, id))
    const parts = [index.blockSections.get(block.id)!]
    if (block.kind === 'image') parts.push('image')
    if (images.length) parts.push(`images=${images.join(',')}`)
    if (block.kind === 'table') {
      const $ = doms.get(pkg)!.get(block.documentPath)!, node = $.root().find(block.selector).get(0) as Element
      const table = $(node).closest('table').get(0) as Element | undefined
      if (table) {
        if (!tableIds.has(table)) tableIds.set(table, `T${tableIds.size + 1}`)
        const rows = $(table).find('tr').toArray().filter(row => $(row).closest('table').get(0) === table)
        const first = rows.map(row => nodeBlocks.get(row)).find(Boolean)
        const headers = rows.filter(row => $(row).children('th').length > 0).map(row => nodeBlocks.get(row)).filter(Boolean)
        const layout = tableLayout($, node)
        const cells = layout.cells.map(cell => `c${cell.column}${cell.rowspan !== 1 || cell.colspan !== 1 ? `(${cell.rowspan}x${cell.colspan})` : ''}${readableText($, cell.node) || $(cell.node).find('img,svg,input').length ? '' : '=empty'}`)
        parts.push(`table=${tableIds.get(table)}`, `row=${layout.row}`, ...(first ? [`first=${first}`] : []),
          ...(headers.length ? [`headers=${headers.join(',')}`] : []), `cells=${cells.join(',')}`)
      }
    }
    index.metadata.set(block.id, parts.join(' '))
  }
  compactIndexes.set(pkg, index)
  return index
}

export function resolveReference(pkg: ReviewPackage, ref: string): { block?: DocumentBlock; image?: DocumentImage; documentPath: string; selector: string; ref: string } {
  const index = compactIndex(pkg)
  // 内部旧图片 ID 仍可用于已有调用；新的模型工具只展示 I#。
  const image = index.images.get(ref) ?? pkg.images.find(image => image.id === ref)
  if (image) return { image, documentPath: image.documentPath, selector: image.selector, ref: imageReference(pkg, image.id) }
  const block = index.blocks.get(ref) ?? pkg.blocks.find(block => block.id === ref)
  if (block) return { block, documentPath: block.documentPath, selector: block.selector, ref: blockReference(pkg, block.id) }
  throw new Error('REFERENCE_NOT_FOUND')
}
export function resolveCompactReference(pkg: ReviewPackage, ref: string): { documentPath: string; selector: string; blockId?: string; imageId?: string } {
  const source = resolveReference(pkg, ref)
  return { documentPath: source.documentPath, selector: source.selector,
    ...(source.image ? { imageId: source.image.id } : { blockId: source.block!.id }) }
}

/** 旧 CSS 别名同样必须落在实际阅读过的节点，不能借用其他节点的同文内容。 */
export function evidenceBlockIds(pkg: ReviewPackage, documentPath: string, selector: string, containedOnly = false): string[] {
  const $ = doms.get(pkg)?.get(documentPath)
  if (!$) return []
  const target = $.root().find(selector)
  if (target.length !== 1) return []
  const node = target.get(0)!
  const ancestorOf = (parent: AnyNode, child: AnyNode) => {
    let at: AnyNode | null = child
    while (at) { if (at === parent) return true; at = at.parent }
    return false
  }
  return pkg.blocks.filter(block => {
    if (block.documentPath !== documentPath) return false
    const source = $.root().find(block.selector).get(0)
    return source && (ancestorOf(node, source) || (!containedOnly && ancestorOf(source, node)))
  }).map(block => block.id)
}

interface PageOptions { cursor?: string; tokenBudget?: number }
interface Scope { document?: string; section?: string }
interface ReadOptions extends PageOptions, Scope {
  refs?: string[]; offset?: number; limit?: number; textOffset?: number; isRead?: (range: ReadRange) => boolean
}
interface SearchOptions extends PageOptions, Scope { limit?: number; snippetChars?: number; isRead?: (range: ReadRange) => boolean }

function tokenBudget(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 128 || result > 32000) throw new Error('INVALID_READING_BUDGET')
  return result
}
// 游标绑定包内容与查询范围，不暴露文件路径，不受预算变化影响。
function scopeKey(pkg: ReviewPackage, value: unknown): string { return digest(`${pkg.packageHash}:${JSON.stringify(value)}`).slice(0, 16) }
function cursorFor(scope: string, position: number, offset: number): string {
  return Buffer.from(JSON.stringify([scope, position, offset])).toString('base64url')
}
function cursorAt(cursor: string | undefined, scope: string): [number, number] | undefined {
  if (!cursor) return undefined
  try {
    if (cursor.length > 4000 || !/^[\w-]+$/u.test(cursor)) throw new Error()
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== scope || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0 || !Number.isSafeInteger(parsed[2]) || parsed[2] < 0) throw new Error()
    return [parsed[1], parsed[2]]
  } catch { throw new Error('INVALID_READING_CURSOR') }
}
function dataPage(text: string, nextCursor?: string, total?: number): CompactPage['data'] {
  return { text, ...(nextCursor ? { nextCursor } : {}), ...(total !== undefined ? { total } : {}) }
}
function fits(data: CompactPage['data'], budget: number): boolean { return estimateTokens(JSON.stringify(data)) <= budget }
function boundary(text: string, end: number): number {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!)) return end - 1
  return end
}
function largestEnd(text: string, start: number, maxEnd: number, accept: (end: number) => boolean): number {
  let low = start, high = maxEnd
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (accept(mid)) low = mid
    else high = mid - 1
  }
  return boundary(text, low)
}
function documentPath(pkg: ReviewPackage, ref?: string): string | undefined {
  if (!ref) return undefined
  const value = /^D[1-9]\d*$/u.test(ref) ? pkg.documents[Number(ref.slice(1)) - 1]?.path : ref
  if (!value || !pkg.documents.some(doc => doc.path === value)) throw new Error('DOCUMENT_NOT_FOUND')
  return value
}
function scopedBlocks(pkg: ReviewPackage, scope: Scope): DocumentBlock[] {
  const doc = documentPath(pkg, scope.document), index = compactIndex(pkg)
  const section = scope.section ? index.sections.find(section => section.ref === scope.section) : undefined
  if (scope.section && (!section || (doc && doc !== section.documentPath))) throw new Error('SECTION_NOT_FOUND')
  return pkg.blocks.filter((block, i) => (!doc || block.documentPath === doc) && (!section || (i >= section.start && i < section.end)))
}

/** 目录/图片元数据也可续读，长标题或警告不会挤掉后面的正文入口。 */
function compactIndexPage(pkg: ReviewPackage, lines: string[], kind: unknown, options: PageOptions, total: number): CompactPage {
  const budget = tokenBudget(options.tokenBudget, 600), key = scopeKey(pkg, kind)
  const content = lines.join('\n'), position = cursorAt(options.cursor, key)
  const start = position?.[1] ?? 0
  if ((position && position[0] !== 0) || start > content.length || boundary(content, start) !== start) throw new Error('INVALID_READING_CURSOR')
  const make = (end: number) => dataPage(content.slice(start, end), end < content.length ? cursorFor(key, 0, end) : undefined, total)
  const end = largestEnd(content, start, Math.min(content.length, start + budget * 4), stop => fits(make(stop), budget))
  if (end === start && start < content.length) throw new Error('READING_BUDGET_TOO_SMALL_INCREASE_TOKEN_BUDGET')
  return { data: make(end), ranges: [] }
}

export function compactOutline(pkg: ReviewPackage, options: PageOptions = {}): CompactPage {
  const index = compactIndex(pkg)
  const lines = ['B=正文 I=图片 S=章节；目录不是已读证据。']
  pkg.documents.forEach((doc, i) => lines.push(`D${i + 1} ${doc.title} (${doc.blockCount}块)`))
  for (const section of index.sections) lines.push(`${section.ref} D${pkg.documents.findIndex(doc => doc.path === section.documentPath) + 1} B${section.start + 1}..B${section.end} ${section.title}`)
  if (pkg.images.length) lines.push(`图片${pkg.images.length}张；需要时list_documents(images=true)或读取正文中的I引用。`)
  for (const warning of pkg.warnings) lines.push(`警告 ${warning}`)
  return compactIndexPage(pkg, lines, 'outline', options, index.sections.length)
}

export function compactImages(pkg: ReviewPackage, options: PageOptions & Scope = {}): CompactPage {
  const blocks = scopedBlocks(pkg, options), ids = new Set(blocks.flatMap(block => block.imageIds))
  const doc = documentPath(pkg, options.document)
  const source = pkg.images.filter(image => (!doc || image.documentPath === doc) && (!options.section || ids.has(image.id)))
  const lines = source.map(image => {
    const block = blocks.find(block => block.imageIds.includes(image.id))
    return `${imageReference(pkg, image.id)}${block ? ` ${blockReference(pkg, block.id)} ${compactIndex(pkg).blockSections.get(block.id)}` : ''} ${image.width}x${image.height}`
  })
  return compactIndexPage(pkg, lines, ['images', options.document, options.section], options, source.length)
}

export function compactRead(pkg: ReviewPackage, options: ReadOptions = {}): CompactPage {
  const budget = tokenBudget(options.tokenBudget, 2000), index = compactIndex(pkg)
  const source = scopedBlocks(pkg, options)
  const selected = options.refs ? options.refs.map(ref => {
    const block = resolveReference(pkg, ref).block
    if (!block || !source.includes(block)) throw new Error('BLOCK_NOT_IN_READING_SCOPE')
    return block
  }).filter((block, i, list) => list.indexOf(block) === i) : source
  const offset = options.offset ?? 0, textOffset = options.textOffset ?? 0, limit = options.limit ?? Number.MAX_SAFE_INTEGER
  if (![offset, textOffset, limit].every(Number.isSafeInteger) || offset < 0 || textOffset < 0 || limit < 1) throw new Error('INVALID_PAGE')
  const key = scopeKey(pkg, ['read', options.document, options.section, options.refs, offset, textOffset])
  let [position, start] = cursorAt(options.cursor, key) ?? [offset, textOffset]
  if (position > selected.length || (position < selected.length && (start > selected[position]!.text.length || boundary(selected[position]!.text, start) !== start)) || (position === selected.length && start !== 0)) throw new Error('INVALID_READING_CURSOR')
  const ranges: ReadRange[] = []
  let text = '', count = 0
  while (position < selected.length && count < limit) {
    const block = selected[position]!, ref = blockReference(pkg, block.id), length = block.text.length
    const make = (end: number, repeated = false) => {
      const next = end < length ? cursorFor(key, position, end) : position + 1 < selected.length ? cursorFor(key, position + 1, 0) : undefined
      const line = repeated ? `[${ref} @${start}:${end}/${length} 已读；full=true重看]` : `[${ref} ${index.metadata.get(block.id)} @${start}:${end}/${length}]\n${block.text.slice(start, end)}`
      return dataPage(text + (text ? '\n' : '') + line, next, selected.length)
    }
    // 按本页拟返回的范围去重，不把未展示的其余正文当作已读。
    let end = largestEnd(block.text, start, Math.min(length, start + budget * 4), stop => fits(make(stop), budget))
    const whole: ReadRange = { blockId: block.id, start, end: length, text: block.text.slice(start) }
    const repeatedWhole = options.isRead?.(whole) && fits(make(length, true), budget)
    if (repeatedWhole) end = length
    if (end === start && start < length) {
      if (text) break
      throw new Error('READING_BUDGET_TOO_SMALL_INCREASE_TOKEN_BUDGET')
    }
    const range = { blockId: block.id, start, end, text: block.text.slice(start, end) }
    const repeated = Boolean(repeatedWhole || options.isRead?.(range))
    const page = make(end, repeated)
    if (!fits(page, budget)) {
      if (text) break
      throw new Error('READING_BUDGET_TOO_SMALL_INCREASE_TOKEN_BUDGET')
    }
    text = page.text
    if (!repeated) ranges.push(range)
    count++
    if (end < length) { start = end; break }
    position++; start = 0
  }
  return { data: dataPage(text, position < selected.length ? cursorFor(key, position, start) : undefined, selected.length), ranges }
}

export function compactSearch(pkg: ReviewPackage, queries: string | string[], options: SearchOptions = {}): CompactPage {
  const budget = tokenBudget(options.tokenBudget, 800), source = scopedBlocks(pkg, options)
  const terms = [...new Set((Array.isArray(queries) ? queries : [queries]).map(query => query.trim()).filter(Boolean))]
  if (!terms.length || terms.length > 8) throw new Error('EMPTY_OR_EXCESSIVE_QUERY')
  const width = options.snippetChars ?? 200, limit = options.limit ?? 5
  if (!Number.isSafeInteger(width) || width < 1 || width > 4000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('INVALID_PAGE')
  const hits: Array<{ block: DocumentBlock; start: number; end: number }> = []
  for (const block of source) {
    const windows: Array<[number, number]> = []
    for (const term of terms) {
      let previous: [number, number] | undefined
      // Unicode大小写变换可能改变长度，使用原串正则索引保证 coverage 不漂移。
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      for (const match of block.text.matchAll(new RegExp(escaped, 'giu'))) {
        const at = match.index!, windowWidth = Math.max(width, match[0].length)
        if (previous && at + match[0].length <= previous[1]) continue
        const start = boundary(block.text, Math.max(0, at - Math.floor((windowWidth - match[0].length) / 2)))
        const end = boundary(block.text, Math.min(block.text.length, start + windowWidth))
        previous = [start, end]; windows.push(previous)
      }
    }
    windows.sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const window of windows) {
      const last = merged.at(-1)
      if (last && window[1] <= last[1]) continue
      if (last && window[0] <= last[1] && window[1] - last[0] <= Math.max(width, ...terms.map(term => term.length))) last[1] = window[1]
      else merged.push([...window])
    }
    for (const [start, end] of merged) hits.push({ block, start, end })
  }
  const key = scopeKey(pkg, ['search', options.document, options.section, terms, width])
  let [position, offset] = cursorAt(options.cursor, key) ?? [0, 0]
  if (position > hits.length || (position === hits.length && offset !== 0)) throw new Error('INVALID_READING_CURSOR')
  let text = '', count = 0
  const ranges: ReadRange[] = []
  while (position < hits.length && count < limit) {
    const hit = hits[position]!, start = hit.start + offset
    if (start > hit.end || boundary(hit.block.text, start) !== start) throw new Error('INVALID_READING_CURSOR')
    const make = (end: number, repeated = false) => dataPage(text + (text ? '\n' : '') +
      `[${blockReference(pkg, hit.block.id)} ${compactIndex(pkg).blockSections.get(hit.block.id)} @${start}:${end}/${hit.block.text.length}${repeated ? ' 已读；full=true重看' : ''}]${repeated ? '' : '\n' + hit.block.text.slice(start, end)}`,
      end < hit.end ? cursorFor(key, position, end - hit.start) : position + 1 < hits.length ? cursorFor(key, position + 1, 0) : undefined, hits.length)
    let end = largestEnd(hit.block.text, start, Math.min(hit.end, start + budget * 4), stop => fits(make(stop), budget))
    const whole = { blockId: hit.block.id, start, end: hit.end, text: hit.block.text.slice(start, hit.end) }
    const repeatedWhole = options.isRead?.(whole) && fits(make(hit.end, true), budget)
    if (repeatedWhole) end = hit.end
    if (end === start && start < hit.end) { if (text) break; throw new Error('READING_BUDGET_TOO_SMALL_INCREASE_TOKEN_BUDGET') }
    const range = { blockId: hit.block.id, start, end, text: hit.block.text.slice(start, end) }
    const repeated = Boolean(repeatedWhole || options.isRead?.(range))
    const page = make(end, repeated)
    if (!fits(page, budget)) { if (text) break; throw new Error('READING_BUDGET_TOO_SMALL_INCREASE_TOKEN_BUDGET') }
    text = page.text
    if (!repeated) ranges.push(range)
    count++
    if (end < hit.end) { offset = end - hit.start; break }
    position++; offset = 0
  }
  return { data: dataPage(text, position < hits.length ? cursorFor(key, position, offset) : undefined, hits.length), ranges }
}
