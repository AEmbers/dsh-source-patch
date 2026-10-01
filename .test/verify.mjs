/**
 * 端到端验证：把补丁打到一个 app.asar 的副本上，再逐项检查。
 * 全程不碰真实的安装版。
 */
import { copyFileSync, mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArchive, entryInfo } from '../apply.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const COPY = join(HERE, 'app.asar')
const PATCHED_MAIN = join(HERE, 'main.patched.mjs')

function entryBytes(buffer, parsed, entryPath) {
  const info = entryInfo(parsed.header, entryPath)
  if (!info || info.size === undefined || info.unpacked) return undefined
  const start = 8 + parsed.headerSize + Number(info.offset)
  return buffer.subarray(start, start + Number(info.size))
}

const samples = [
  'package.json',
  'lib/preload-app.cjs',
  'lib/preload-mandatory.cjs',
  'lib/welcome/welcome.js',
  'node_modules/electron-updater/out/main.js',
  'dsh/node_modules/@deepseek-ai/dsh-goal/lib/types/domain.js',
  'dsh/package.json',
]

mkdirSync(HERE, { recursive: true })
const before = statSync(COPY, { throwIfNoEntry: false })
console.log(before ? '复用已有的 asar 副本' : '复制 app.asar 到工作目录…')
if (!before) copyFileSync(SOURCE, COPY)
console.log(`副本大小 ${statSync(COPY).size}`)

console.log('\n--- 记录原副本里若干条目的字节 ---')
const originalBuf = readFileSync(COPY)
const originalParsed = parseArchive(originalBuf)
const originalSamples = new Map(samples.map((p) => [p, Buffer.from(entryBytes(originalBuf, originalParsed, p) ?? Buffer.alloc(0))]))
for (const [p, b] of originalSamples) console.log(`  ${b.length.toString().padStart(9)}  ${p}`)

console.log('\n--- 对副本执行 --apply ---')
try {
  const out = execFileSync(process.execPath, [join(HERE, '..', 'apply.mjs'), '--asar', COPY, '--apply'], { encoding: 'utf8' })
  console.log(out.trim())
} catch (error) {
  console.error(error.stdout ?? '', error.stderr ?? '', error.message)
  process.exit(1)
}

console.log('\n--- 回读并检查 ---')
const patchedBuf = readFileSync(COPY)
const patchedParsed = parseArchive(patchedBuf)
const main = entryBytes(patchedBuf, patchedParsed, 'lib/main.js').toString('utf8')
writeFileSync(PATCHED_MAIN, main)

const mustHave = [
  'persist:dsh-sidebar-browser-${createHash("sha256").update(workspace)',
  'const GRANTED_PERMISSIONS = /* @__PURE__ */ new Set(["clipboard-read"',
  'function configuredExtensions()',
  'loadExtensions(browserSession) {',
  'extensionLoads = /* @__PURE__ */ new WeakSet();',
  'plugins: true,',
  'disableDialogs: false,',
  'function installGuestDebuggingEndpoint() {',
  'installGuestDebuggingEndpoint();\nif (claimDesktopSingleInstance(app, () => {',
  'durable, workspace-scoped isolation policy',
  'callback(GRANTED_PERMISSIONS.has(permission));',
  'setPermissionCheckHandler((_contents, permission) => GRANTED_PERMISSIONS.has(permission));',
  'browserSession.on("will-download", () => {});',
]
const mustNotHave = [
  'partition = `dsh-sidebar-browser-${randomUUID()}`;',
  'plugins: false,',
  'disableDialogs: true,',
  'fixed isolation policy',
]

let failures = 0
for (const needle of mustHave) {
  const ok = main.includes(needle)
  if (!ok) failures += 1
  console.log(`  ${ok ? '✔' : '✘'} 应包含  ${needle.slice(0, 72)}`)
}
for (const needle of mustNotHave) {
  const ok = !main.includes(needle)
  if (!ok) failures += 1
  console.log(`  ${ok ? '✔' : '✘'} 应消失  ${needle.slice(0, 72)}`)
}

console.log('\n--- 其余条目必须逐字节不变 ---')
for (const [p, b] of originalSamples) {
  const now = entryBytes(patchedBuf, patchedParsed, p) ?? Buffer.alloc(0)
  const ok = now.equals(b)
  if (!ok) failures += 1
  console.log(`  ${ok ? '✔' : '✘'} ${p}  (${b.length} → ${now.length})`)
}

console.log('\n--- 变动的条目数（应当只有 lib/main.js）---')
let changed = 0
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`
    if (entry.files) walk(entry, p)
    else {
      const a = entryBytes(originalBuf, originalParsed, p)
      const b = entryBytes(patchedBuf, patchedParsed, p)
      if (a !== undefined && b !== undefined && !a.equals(b)) {
        changed += 1
        console.log(`  changed: ${p} (${a.length} → ${b.length})`)
      }
    }
  }
}
walk(originalParsed.header, '')
console.log(`  共 ${changed} 个条目内容变化`)
if (changed !== 1) { console.log('  ✘ 预期恰好 1 个'); failures += 1 }

console.log('\n--- 语法检查（对打补丁后的 lib/main.js） ---')
try {
  execFileSync(process.execPath, ['--check', PATCHED_MAIN], { encoding: 'utf8' })
  console.log('  ✔ node --check 通过')
} catch (error) {
  failures += 1
  console.log('  ✘ node --check 失败')
  console.log(String(error.stderr ?? error.message).split('\n').slice(0, 12).join('\n'))
}

console.log(`\n${failures === 0 ? '全部通过 ✔' : `${failures} 项失败 ✘`}`)
process.exitCode = failures === 0 ? 0 : 1
