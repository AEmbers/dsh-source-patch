/**
 * The in-place write is the path that lets the panel apply a patch while DSH is
 * still running, so it has to be proven, not assumed: it edits a 121 MB archive
 * by appending and re-pointing the header instead of replacing the file.
 *
 * The whole real archive is copied to a temp file and checked against itself —
 * the target entry must read back as the patched source, and every other entry
 * must keep the exact offset and size it had, which is what makes the append
 * safe on a live file.
 */

import { copyFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { applyEdits, defaultArchivePath, parseArchive, readEntry, rewriteEntryInPlace } = await import(
  pathToFileURL(join(root, 'apply.mjs')).href
)

const require = createRequire(import.meta.url)
let asar = null
for (const candidate of [
  'D:/deepseek-harness/node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar',
  '@electron/asar',
]) {
  try { asar = require(candidate); break } catch { /* try the next one */ }
}

let failures = 0
function check(label, ok, detail) {
  if (ok) { console.log(`  ✔ ${label}${detail !== undefined ? `  ${detail}` : ''}`); return }
  failures += 1
  console.log(`  ✘ ${label}${detail !== undefined ? `  ${detail}` : ''}`)
}

/** Flatten the archive's nested file tree into path -> entry. */
function flatten(node, prefix = '') {
  const out = new Map()
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`
    if (value.files !== undefined) for (const [k, v] of flatten(value, path)) out.set(k, v)
    else out.set(path, value)
  }
  return out
}

const source = defaultArchivePath()
if (source === undefined) {
  console.log('跳过：这台机器上没有安装版的 app.asar')
  process.exit(0)
}

const scratch = join(tmpdir(), `dsh-inplace-${process.pid}.asar`)
console.log(`源归档 ${source}`)
console.log(`副本   ${scratch}\n`)
copyFileSync(source, scratch)

try {
  const patch = JSON.parse(readFileSync(join(root, 'patches', 'sidebar-browser-durable-identity.json'), 'utf8'))
  const beforeBuffer = readFileSync(scratch)
  const before = parseArchive(beforeBuffer)
  const beforeFiles = flatten(before.header)
  const sizeBefore = statSync(scratch).size

  const current = readEntry(scratch, 'lib/main.js').toString('utf8')
  const { source: patched, failed } = applyEdits(current, patch.edits)
  check('补丁锚点全部命中', !failed)
  if (failed) process.exit(1)

  const mode = rewriteEntryInPlace(scratch, 'lib/main.js', Buffer.from(patched, 'utf8'))
  check('返回 in-place 模式', mode === 'in-place', mode)

  const after = parseArchive(readFileSync(scratch))
  check('headerSize 没有变化', after.headerSize === before.headerSize, `${before.headerSize} → ${after.headerSize}`)
  check('size-pickle 首部没有变化', readFileSync(scratch).readUInt32LE(0) === beforeBuffer.readUInt32LE(0))

  // The whole new entry is appended, not just its growth: rewriting the bytes
  // where they already sit would shift every file after it, which is exactly the
  // thing that makes an in-place write unsafe on a live archive. 490 KB of dead
  // weight on a 121 MB archive is the price of being able to patch while DSH runs.
  const grown = statSync(scratch).size - sizeBefore
  const appended = Buffer.byteLength(patched, 'utf8')
  check('文件长大了整整一个新条目（追加，不搬别的文件）', grown === appended, `+${grown} 字节（新条目 ${appended}）`)

  const afterFiles = flatten(after.header)
  check('条目总数没变', afterFiles.size === beforeFiles.size, `${beforeFiles.size} → ${afterFiles.size}`)

  let movedOthers = 0
  for (const [path, entry] of beforeFiles) {
    if (path === '/lib/main.js') continue
    const now = afterFiles.get(path)
    // Compare as strings: unpacked entries carry no offset, and Number(undefined)
    // is NaN, which never equals itself.
    if (now === undefined || String(now.offset) !== String(entry.offset) || String(now.size) !== String(entry.size)) movedOthers += 1
  }
  check('其它文件的偏移与大小一个都没动', movedOthers === 0, `动了 ${movedOthers} 个`)

  const target = afterFiles.get('/lib/main.js')
  check('目标条目指向归档末尾', Number(target.offset) === sizeBefore - (8 + before.headerSize), `${target.offset}`)
  check('目标条目大小等于新内容', Number(target.size) === Buffer.byteLength(patched, 'utf8'))

  const readBack = readEntry(scratch, 'lib/main.js').toString('utf8')
  check('回读等于打过补丁的源码', readBack === patched, `${readBack.length} 字符`)

  const untouched = beforeFiles.get('/lib/package.json')
  if (untouched !== undefined) {
    const same = readEntry(scratch, 'lib/package.json').equals(readEntry(source, 'lib/package.json'))
    check('未触及的条目内容逐字节相同', same)
  }

  if (asar !== null) {
    // listPackage also returns directories, so it is always longer than the
    // file-only map; what matters is that it can walk the rewritten archive.
    const listing = asar.listPackage(scratch)
    check('@electron/asar 能把改写后的归档列出来', listing.length > beforeFiles.size, `${listing.length} 条（含目录，文件 ${beforeFiles.size}）`)
    const viaAsar = asar.extractFile(scratch, 'lib/main.js').toString('utf8')
    check('@electron/asar 读出的 main.js 就是打过补丁的', viaAsar === patched)
  } else {
    console.log('  · 跳过 @electron/asar 交叉验证（没找到这个包）')
  }

  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
  process.exit(failures === 0 ? 0 : 1)
} finally {
  rmSync(scratch, { force: true })
}
