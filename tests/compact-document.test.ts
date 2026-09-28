import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePackage, compactRead, compactSearch, blockReference, resolveCompactReference,
  imageReference, validateEvidence, estimateTokens,
} from '../src/agents/rfc-review/document.js'
import { zipHtml } from './helpers.js'

test('small read budgets preserve every source character and never split a surrogate pair', async () => {
  const pkg = await parsePackage(zipHtml(`<h1>变更步骤</h1><p>${'第1步🚀检查版本🛰️。'.repeat(500)}</p><p>最后确认回退条件。</p>`))
  const reconstructed = new Map<string, string>()
  let cursor: string | undefined, pages = 0
  do {
    const page = compactRead(pkg, { tokenBudget: 256, cursor })
    assert.ok(page.ranges.length > 0, 'every nonempty page must make source progress')
    for (const range of page.ranges) {
      const source = pkg.blocks.find(block => block.id === range.blockId)!
      const previous = reconstructed.get(range.blockId) ?? ''
      assert.equal(range.start, previous.length)
      assert.equal(range.end, range.start + range.text.length)
      assert.equal(range.text, source.text.slice(range.start, range.end))
      assert.ok(!/^[\uDC00-\uDFFF]/u.test(range.text), 'a fragment cannot start with a low surrogate')
      assert.ok(!/[\uD800-\uDBFF]$/u.test(range.text), 'a fragment cannot end with a high surrogate')
      reconstructed.set(range.blockId, previous + range.text)
    }
    assert.notEqual(page.data.nextCursor, cursor ?? '__first_page__')
    cursor = page.data.nextCursor
    assert.ok(++pages < 1000, 'pagination must terminate')
  } while (cursor)
  assert.ok(pages > 2)
  for (const block of pkg.blocks) assert.equal(reconstructed.get(block.id), block.text)
})

test('read cursors cannot be reused for another package or another requested scope', async () => {
  const raw = zipHtml(`<h1>第一章</h1><p>${'现场版本核查。'.repeat(500)}</p><h1>第二章</h1><p>回退条件。</p>`)
  const pkg = await parsePackage(raw)
  const other = await parsePackage(zipHtml(`<h1>不同方案</h1><p>${'其他版本信息。'.repeat(500)}</p>`))
  const first = compactRead(pkg, { tokenBudget: 256, refs: ['B2'] })
  assert.ok(first.data.nextCursor)
  assert.throws(() => compactRead(other, { tokenBudget: 256, refs: ['B2'], cursor: first.data.nextCursor }))
  assert.throws(() => compactRead(pkg, { tokenBudget: 256, refs: ['B4'], cursor: first.data.nextCursor }))
  assert.throws(() => compactRead(pkg, { tokenBudget: 256, cursor: first.data.nextCursor }))
})

test('multi-query search returns windows around actual hits with exact source ranges and pagination', async () => {
  const pkg = await parsePackage(zipHtml(`<h1>概况</h1><p>${'背景说明。'.repeat(500)}目标版本为8.6.1。${'补充背景。'.repeat(500)}</p>`
    + `<p>${'其他说明。'.repeat(500)}失败后执行回退。${'补充其他。'.repeat(500)}</p><p>第二处目标版本记录。</p>`))
  const first = compactSearch(pkg, ['目标版本', '执行回退'], { tokenBudget: 800, limit: 2, snippetChars: 200 })
  assert.equal(first.data.total, 3)
  assert.ok(first.data.nextCursor)
  assert.equal(first.ranges.length, 2)
  assert.ok(first.ranges.some(range => range.text.includes('目标版本')))
  assert.ok(first.ranges.some(range => range.text.includes('执行回退')))
  for (const range of first.ranges) {
    const block = pkg.blocks.find(item => item.id === range.blockId)!
    assert.equal(range.text, block.text.slice(range.start, range.end))
    assert.ok(range.start > 1000, 'search must show hit vicinity rather than the beginning of a long block')
    assert.ok(range.text.length <= 240)
    assert.ok(range.text.length < block.text.length)
  }
  const second = compactSearch(pkg, ['目标版本', '执行回退'], { tokenBudget: 800, limit: 2, snippetChars: 200, cursor: first.data.nextCursor })
  assert.equal(second.ranges.length, 1)
  assert.ok(second.ranges[0]!.text.includes('第二处目标版本'))
  assert.ok(!second.data.nextCursor)
  assert.throws(() => compactSearch(pkg, ['完全不同'], { cursor: first.data.nextCursor }))
})

test('short block references resolve uniquely and table source quotes retain the original DOM protocol', async () => {
  const pkg = await parsePackage(zipHtml('<h1>批次</h1><table><tr><th>任务</th><th colspan="2">执行时间</th></tr>'
    + '<tr><td rowspan="2">升级</td><td></td><td><input type="checkbox" checked>完成</td></tr><tr><td>18:00</td><td>19:00</td></tr></table>'))
  const refs = pkg.blocks.map(block => blockReference(pkg, block.id))
  assert.equal(new Set(refs).size, pkg.blocks.length)
  for (const block of pkg.blocks) {
    const ref = blockReference(pkg, block.id), resolved = resolveCompactReference(pkg, ref)
    assert.equal(resolved.blockId, block.id)
    assert.equal(resolved.documentPath, block.documentPath)
    assert.equal(resolved.selector, block.selector)
    assert.doesNotThrow(() => validateEvidence(pkg, { Verdict: 'passed', DocumentPath: resolved.documentPath, Selector: resolved.selector, Quote: block.text }))
  }
  const rows = pkg.blocks.filter(block => block.kind === 'table')
  assert.equal(rows[0]!.text, '| 任务 | 执行时间')
  assert.equal(rows[1]!.text, '| 升级 | | [已选] 完成')
  const page = compactRead(pkg, { refs: rows.map(row => blockReference(pkg, row.id)), tokenBudget: 2000 })
  for (const range of page.ranges) assert.equal(range.text, pkg.blocks.find(block => block.id === range.blockId)!.text.slice(range.start, range.end))
})

test('image references resolve only to image identity even when also present in a text block', async () => {
  const pkg = await parsePackage(zipHtml('<h1>拓扑</h1><p>主机连接<svg width="10" height="10"><title>节点</title><rect width="10" height="10" fill="red"/></svg></p>'))
  assert.equal(pkg.images.length, 1)
  const image = pkg.images[0]!, ref = imageReference(pkg, image.id)
  assert.match(ref, /^I\d+$/u)
  const resolved = resolveCompactReference(pkg, ref)
  assert.equal(resolved.imageId, image.id)
  assert.equal(resolved.blockId, undefined)
  assert.equal(resolved.selector, image.selector)
  assert.equal(resolved.documentPath, image.documentPath)
})

test('dense search matches stay in small windows and repeated search pages respect the total budget', async () => {
  const pkg = await parsePackage(zipHtml(`<p>${'关键词' + '资料'.repeat(30)}</p>`.repeat(30)))
  for (const isRead of [undefined, () => true]) {
    let cursor: string | undefined, pages = 0
    do {
      const page = compactSearch(pkg, '关键词', { tokenBudget: 128, cursor, isRead })
      assert.ok(estimateTokens(JSON.stringify(page.data)) <= 128)
      assert.notEqual(page.data.nextCursor, cursor ?? '__first_page__')
      assert.ok(page.ranges.every(range => range.text.length <= 200))
      cursor = page.data.nextCursor
      assert.ok(++pages < 100)
    } while (cursor)
  }
  const dense = await parsePackage(zipHtml(`<p>${('关键词' + '正文'.repeat(40)).repeat(100)}</p>`))
  const page = compactSearch(dense, '关键词')
  assert.ok(page.ranges.length <= 5)
  assert.ok(page.ranges.every(range => range.text.length <= 200))
  assert.ok(page.data.nextCursor)
})

test('rowspan zero stays within its row group and section reading includes its child headings', async () => {
  const pkg = await parsePackage(zipHtml('<h1>步骤</h1><h2>批次</h2><table><thead><tr><th rowspan="0">列名</th><th>时间</th></tr></thead>'
    + '<tbody><tr><td>升级</td><td>18:00</td></tr></tbody></table><h1>附件</h1><p>附录</p>'))
  const page = compactRead(pkg, { section: 'S1' })
  assert.ok(page.data.text.includes('升级'))
  assert.ok(!page.data.text.includes('附录'))
  assert.match(page.data.text, /row=2[^\n]*cells=c1,c2/)
})
