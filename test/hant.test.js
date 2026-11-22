import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConverter, resolveVariant, VARIANTS } from '../lib/hant.js'

const hk = createConverter({ variant: 's2hk' })
const twp = createConverter({ variant: 's2twp' })

test('converts the phrasing table the spec asks for', () => {
  assert.equal(hk('帮我把这个 function 改成 async'), '幫我把這個 function 改成 async')
  assert.equal(twp('帮我把这个 function 改成 async'), '幫我把這個 function 改成 async')

  assert.equal(hk('软件和打印机'), '軟件和打印機')
  assert.equal(twp('软件和打印机'), '軟體和印表機')

  assert.equal(hk('变量名改成 userNameList'), '變量名改成 userNameList')
  assert.equal(twp('变量名改成 userNameList'), '變數名改成 userNameList')

  // Vocabulary, not just glyphs: the two variants disagree on purpose.
  assert.equal(hk('后台服务、内存、视频、默认值'), '後台服務、內存、視頻、默認值')
  assert.equal(twp('后台服务、内存、视频、默认值'), '後臺服務、記憶體、影片、預設值')
})

test('leaves fenced blocks, inline spans, URLs and paths alone', () => {
  const source = [
    '把这个 `变量` 改成乾',
    '```js',
    'const 变量 = 1 // 后台',
    '```',
    '文档在 https://example.com/软件/打印机 和 src/components/button.js 里',
  ].join('\n')
  const converted = hk(source)
  assert.ok(converted.includes('`变量`'), 'inline span must stay verbatim')
  assert.ok(converted.includes('const 变量 = 1 // 后台'), 'fenced block must stay verbatim')
  assert.ok(converted.includes('https://example.com/软件/打印机'), 'URL must stay verbatim')
  assert.ok(converted.includes('src/components/button.js'), 'path must stay verbatim')
  assert.ok(converted.startsWith('把這個'), 'text outside spans is still converted')
})

test('a path with Han characters is not treated as code', () => {
  // Only ASCII segments are protected; a Han path is prose and gets converted.
  assert.equal(hk('看 src/组件/按钮.js'), '看 src/組件/按鈕.js')
})

test('keeps Han text around a slash convertible', () => {
  // A slash only protects a span when ASCII sits on both sides of it.
  assert.equal(hk('这个 或/和 那个'), '這個 或/和 那個')
})

test('applies the glossary after conversion, longest match first', () => {
  const convert = createConverter({ variant: 's2twp', glossary: { 軟體: '軟件', 記憶體: '內存', 記憶: '記憶X' } })
  assert.equal(convert('软件和内存'), '軟件和內存')
  assert.equal(convert('记忆'), '記憶X')
  assert.equal(convert('记忆体'), '內存')
})

test('accepts a glossary key written in simplified characters', () => {
  const convert = createConverter({ variant: 's2twp', glossary: { 软件: '軟件' } })
  assert.equal(convert('软件'), '軟件')
})

test('glossary does not reach inside protected spans', () => {
  const convert = createConverter({ variant: 's2twp', glossary: { 軟體: '軟件' } })
  assert.equal(convert('`软件` 和 软件'), '`软件` 和 軟件')
})

test('returns trivial input unchanged', () => {
  for (const value of ['', 'hello world', 'userNameList', '12345', '🎉🎉']) {
    assert.equal(hk(value), value)
  }
  assert.equal(hk(undefined), undefined)
})

test('protectCodeSpans can be switched off', () => {
  const convert = createConverter({ variant: 's2hk', protectCodeSpans: false })
  assert.equal(convert('`变量`'), '`變量`')
})

test('rejects unknown variants without throwing', () => {
  const warnings = []
  assert.equal(resolveVariant(undefined), 's2hk')
  assert.equal(resolveVariant('s2twp'), 's2twp')
  assert.equal(resolveVariant('s2kr', (message) => warnings.push(message)), 's2hk')
  assert.equal(warnings.length, 1)
  for (const variant of VARIANTS) assert.equal(createConverter({ variant })(   '软件'), variant === 's2hk' || variant === 's2tw' ? '軟件' : variant === 's2twp' ? '軟體' : '軟件')
})
