/**
 * dsh-source-patch — 把锚点补丁安全地打进 DSH 安装版的 resources/app.asar。
 *
 * 设计要点：
 * 1. 目标文件是 asar 里的 lib/main.js（打包后的主进程）。asar 是「头部 pickle + 连续数据区」，
 *    每个文件在头部记录 offset/size。改一个文件的字节数会让它之后的文件全部平移，
 *    所以我们整体重写：新头部 + 数据区原样拼接（只替换那一个文件）。
 * 2. 补丁是「锚点正则 + 替换模板」，每个锚点必须恰好命中 1 次，否则整包拒绝、一个字节都不写。
 * 3. 动手前先做一次自我校验：把解析出来的头部 JSON 重新 pickle 回去，
 *    必须和原文件里的头部字节逐字节相同 —— 否则说明我们没看懂这个 asar，直接放弃。
 * 4. 备份只存原始 lib/main.js（约 480KB）就够回滚；可选的整包备份另说。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The fs view used for the archive itself.
 *
 * Under Electron the main `fs` is patched so `resources/app.asar` looks like a
 * **directory**: `existsSync` answers yes while `readFileSync` throws
 * `ENOENT: not found in <archive>`. Inside the DSH desktop host that is exactly
 * what happens, and it is invisible from a plain `node` CLI. `original-fs` is
 * Electron's unpatched view and opens the archive as the ordinary file it is;
 * outside Electron the require fails and plain `node:fs` is already correct.
 */
export const archiveFs = (() => {
  try {
    const original = createRequire(import.meta.url)('original-fs')
    return typeof original?.readFileSync === 'function' ? original : nodeFs
  } catch {
    return nodeFs
  }
})()

/** Which fs module the archive operations actually use ("original-fs" or "node:fs"). */
export const archiveFsName = archiveFs === nodeFs ? 'node:fs' : 'original-fs'

// ---------------------------------------------------------------- asar 结构

/** 读头部：前 8 字节是 size-pickle，其后 size 字节是 header-pickle。 */
export function parseArchive(buffer) {
  const headerSize = buffer.readUInt32LE(4)
  const headerBytes = buffer.subarray(8, 8 + headerSize)
  const jsonLength = headerBytes.readUInt32LE(4)
  const headerString = headerBytes.subarray(8, 8 + jsonLength).toString('utf8')
  return { headerSize, headerBytes, headerString, header: JSON.parse(headerString) }
}

/** 反向构造 header-pickle：[uint32 payloadSize][uint32 strLen][str]。 */
export function buildHeaderPickle(headerString) {
  const json = Buffer.from(headerString, 'utf8')
  const payload = Buffer.allocUnsafe(4 + json.length)
  payload.writeUInt32LE(json.length, 0)
  json.copy(payload, 4)
  const out = Buffer.allocUnsafe(4 + payload.length)
  out.writeUInt32LE(payload.length, 0)
  payload.copy(out, 4)
  return out
}

function allFileEntries(header) {
  const out = []
  ;(function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`
      if (entry.files) walk(entry, p)
      else out.push({ path: p, info: entry })
    }
  })(header, '')
  return out
}

export function entryInfo(header, entryPath) {
  let node = header
  for (const part of entryPath.split('/').filter(Boolean)) {
    node = node?.files?.[part]
    if (node === undefined) return undefined
  }
  return node?.files === undefined ? node : undefined
}

// ---------------------------------------------------------------- 读 / 写

/** 用一个新的文件内容替换 asar 里的某个条目，保持其余字节完全不变。 */
export function rewriteEntry(archivePath, entryPath, newContent) {
  const buffer = archiveFs.readFileSync(archivePath)
  const parsed = parseArchive(buffer)

  // 自我校验：只有当我们能逐字节还原头部时才敢写。
  const rebuilt = buildHeaderPickle(parsed.headerString)
  if (!rebuilt.equals(parsed.headerBytes)) {
    throw new Error(`asar header round-trip mismatch (${rebuilt.length} vs ${parsed.headerBytes.length}) — refusing to write`)
  }

  const info = entryInfo(parsed.header, entryPath)
  if (info === undefined || info.size === undefined) throw new Error(`asar entry not found or is a directory: ${entryPath}`)
  if (info.unpacked === true) throw new Error(`asar entry is unpacked (lives in app.asar.unpacked): ${entryPath}`)

  const oldSize = Number(info.size)
  const oldOffset = Number(info.offset)
  const dataStart = 8 + parsed.headerSize
  const start = dataStart + oldOffset
  const end = start + oldSize
  const oldContent = buffer.subarray(start, end)

  if (newContent.equals(oldContent)) return { changed: false, oldContent, delta: 0 }

  const delta = newContent.length - oldSize

  // 头部里的 offset 是相对数据区起点的；排在目标之后的所有条目整体平移。
  info.size = newContent.length
  for (const { info: other } of allFileEntries(parsed.header)) {
    if (other.offset === undefined) continue
    const offset = Number(other.offset)
    if (offset > oldOffset) other.offset = String(offset + delta)
  }

  // 头部自身长度会变 → 数据区整体后移，而偏移数字的位数又会影响头部长度。
  // 所以迭代到不动点：直到「头部长度推出来的平移量」和「已经应用的平移量」一致。
  const shiftAll = (amount) => {
    if (amount === 0) return
    for (const { info: other } of allFileEntries(parsed.header)) {
      if (other.offset === undefined) continue
      other.offset = String(Number(other.offset) + amount)
    }
  }
  let headerPickle = buildHeaderPickle(JSON.stringify(parsed.header))
  for (let pass = 0, applied = 0; pass < 8; pass += 1) {
    const wanted = headerPickle.length - parsed.headerSize
    if (wanted === applied) break
    shiftAll(wanted - applied)
    applied = wanted
    headerPickle = buildHeaderPickle(JSON.stringify(parsed.header))
  }

  const sizePrefix = Buffer.allocUnsafe(8)
  sizePrefix.writeUInt32LE(4, 0)
  sizePrefix.writeUInt32LE(headerPickle.length, 4)

  const out = Buffer.concat([
    sizePrefix,
    headerPickle,
    buffer.subarray(dataStart, start),
    newContent,
    buffer.subarray(end),
  ])

  const staging = `${archivePath}.dsh-patch.new`
  archiveFs.writeFileSync(staging, out)
  try {
    archiveFs.renameSync(staging, archivePath)
    return { changed: true, oldContent, delta, mode: 'replace' }
  } catch (error) {
    archiveFs.rmSync(staging, { force: true })
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EBUSY') {
      throw new Error(`cannot replace ${archivePath} (${error.code ?? error.message})`, { cause: error })
    }
    // The running host holds the archive open, so Windows refuses to REPLACE the
    // file. Growing it in place never replaces it — see rewriteEntryInPlace.
    return { changed: true, oldContent, delta, mode: rewriteEntryInPlace(archivePath, entryPath, newContent) }
  }
}

/**
 * Patch one entry **without replacing the archive file**, so it works while DSH
 * is running.
 *
 * Replacing `app.asar` needs DELETE access, which the Electron host denies while
 * it holds the archive open. Appending does not. So the entry's new bytes are
 * written to the very END of the archive and the header is pointed at them,
 * which means **no other file's bytes move** and every other offset stays valid.
 *
 * Two consequences make this safe to do on a live file:
 *   - the header pickle is padded back to its exact original length, so the data
 *     region never shifts either (JSON ignores the trailing spaces);
 *   - the append happens first and the header last, so a concurrent reader sees
 *     either the old archive or the new one, never a torn one.
 *
 * The price is the superseded bytes: they stay in the archive as dead weight
 * (a few hundred KB for one entry) until the app is reinstalled.
 *
 * @returns the mode string ("in-place") for the caller to report.
 */
export function rewriteEntryInPlace(archivePath, entryPath, newContent) {
  const buffer = archiveFs.readFileSync(archivePath)
  const parsed = parseArchive(buffer)
  const rebuilt = buildHeaderPickle(parsed.headerString)
  if (!rebuilt.equals(parsed.headerBytes)) {
    throw new Error('asar header round-trip mismatch — refusing to write in place')
  }

  const info = entryInfo(parsed.header, entryPath)
  if (info === undefined || info.size === undefined) throw new Error(`asar entry not found: ${entryPath}`)
  if (info.unpacked === true) throw new Error(`asar entry is unpacked (lives in app.asar.unpacked): ${entryPath}`)

  const dataStart = 8 + parsed.headerSize
  info.offset = String(buffer.length - dataStart)
  info.size = newContent.length

  const jsonBudget = parsed.headerSize - 8
  let headerJson = JSON.stringify(parsed.header)
  if (headerJson.length > jsonBudget) {
    throw new Error(`header would grow by ${headerJson.length - jsonBudget} bytes; cannot patch in place`)
  }
  headerJson = headerJson.padEnd(jsonBudget, ' ')
  const headerPickle = buildHeaderPickle(headerJson)
  if (headerPickle.length !== parsed.headerSize) {
    throw new Error(`padding did not restore the header size (${headerPickle.length} vs ${parsed.headerSize})`)
  }

  const fd = archiveFs.openSync(archivePath, 'r+')
  try {
    archiveFs.writeSync(fd, newContent, 0, newContent.length, buffer.length)
    archiveFs.writeSync(fd, headerPickle, 0, headerPickle.length, 8)
  } finally {
    archiveFs.closeSync(fd)
  }
  return 'in-place'
}

export function readEntry(archivePath, entryPath) {
  const buffer = archiveFs.readFileSync(archivePath)
  const parsed = parseArchive(buffer)
  const info = entryInfo(parsed.header, entryPath)
  if (info === undefined || info.size === undefined) throw new Error(`asar entry not found: ${entryPath}`)
  if (info.unpacked === true) throw new Error(`asar entry is unpacked: ${entryPath}`)
  const start = 8 + parsed.headerSize + Number(info.offset)
  return Buffer.from(buffer.subarray(start, start + Number(info.size)))
}

// ---------------------------------------------------------------- 补丁引擎

function expandTemplate(template, match) {
  return template.replace(/\$(\d+)/g, (_whole, digits) => match[Number(digits)] ?? '')
}

/** 让锚点对 CRLF 也成立：源码用什么换行，正则与替换就跟着用什么换行。 */
function alignNewlines(pattern, text) {
  return text.includes('\r\n') ? pattern.replace(/\\n/g, '\\r?\\n') : pattern
}

export function applyEdits(source, edits) {
  const crlf = source.includes('\r\n')
  let out = source
  const results = []
  for (const edit of edits) {
    const pattern = alignNewlines(edit.find, source)
    const flags = `g${edit.flags ?? ''}`
    let matches
    try {
      matches = [...out.matchAll(new RegExp(pattern, flags))]
    } catch (error) {
      results.push({ id: edit.id, ok: false, error: `invalid anchor regex: ${error.message}` })
      continue
    }
    if (matches.length !== 1) {
      results.push({ id: edit.id, ok: false, error: `anchor matched ${matches.length} times, expected exactly 1` })
      continue
    }
    const match = matches[0]
    const replacement = crlf ? expandTemplate(edit.replace, match).split('\n').join('\r\n') : expandTemplate(edit.replace, match)
    out = out.slice(0, match.index) + replacement + out.slice(match.index + match[0].length)
    results.push({ id: edit.id, ok: true, title: edit.title, addedBytes: replacement.length - match[0].length })
  }
  return { source: out, results, failed: results.some((r) => !r.ok) }
}

/**
 * 补丁处于什么状态。
 *
 * 判据是每个编辑的 `marker`（只会在应用之后出现的短字符串），而不是「锚点还在不在」——
 * 因为有些替换会把命中的那一行原样吐回去（比如把一行代码包进新函数里），
 * 用锚点判断会把「已应用」误判成「半应用」。
 * 没有 marker 的编辑退回用锚点判断。
 */
export function detectState(source, edits) {
  let markerTotal = 0
  let markerPresent = 0
  let anchorTotal = 0
  let anchorAbsent = 0
  for (const edit of edits) {
    if (typeof edit.marker === 'string' && edit.marker.length > 0) {
      markerTotal += 1
      if (source.includes(edit.marker)) markerPresent += 1
      continue
    }
    anchorTotal += 1
    const hits = [...source.matchAll(new RegExp(alignNewlines(edit.find, source), 'g' + (edit.flags ?? '')))].length
    if (hits === 0) anchorAbsent += 1
  }
  const allApplied = markerPresent === markerTotal && anchorAbsent === anchorTotal
  if (allApplied && (markerTotal > 0 || anchorTotal > 0)) return 'applied'
  if (markerPresent === 0 && anchorAbsent === 0) return 'pristine'
  return 'partial'
}

/** 哪些 marker 已经出现 / 还没出现，给报错用。 */
export function markerReport(source, edits) {
  return edits.map((edit) => ({
    id: edit.id,
    markerPresent: typeof edit.marker === 'string' && edit.marker.length > 0 ? source.includes(edit.marker) : undefined,
  }))
}

// ---------------------------------------------------------------- CLI

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PATCH = join(HERE, 'patches', 'sidebar-browser-durable-identity.json')
const DEFAULT_BACKUP = join(process.env.USERPROFILE ?? process.cwd(), '.dsh', 'source-patch-backups')

/** 安装版 DSH 的 app.asar：先按 Electron 可执行文件推，再退回 %LOCALAPPDATA% 下的默认安装位置。 */
export function defaultArchivePath() {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    join(dirname(process.execPath), 'resources', 'app.asar'),
    localAppData === '' ? '' : join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  ]
  for (const candidate of candidates) if (candidate !== '' && existsSync(candidate)) return candidate
  return undefined
}

/**
 * Confirm the archive is there before doing any work.
 *
 * Deliberately does NOT probe for exclusive write access: while DSH runs the
 * host holds the archive, and the in-place path is exactly the mode that still
 * works then. Whether a write is possible is decided by the write itself.
 */
function assertWritable(archivePath) {
  try {
    archiveFs.accessSync(archivePath)
  } catch (error) {
    throw new Error(`archive not readable: ${archivePath} (${error.code ?? error.message})`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? fallback : args[index + 1]
  }
  const mode = args.includes('--apply') ? 'apply' : args.includes('--revert') ? 'revert' : args.includes('--status') ? 'status' : 'dry-run'
  const archivePath = flag('asar', defaultArchivePath())
  const patchPath = flag('patch', DEFAULT_PATCH)
  const backupRoot = flag('backup-dir', DEFAULT_BACKUP)

  const patch = JSON.parse(readFileSync(patchPath, 'utf8'))
  const entryPath = patch.target.entry
  console.log(`补丁    ${patch.id}  (${patch.edits.length} 处编辑)`)
  console.log(`目标    ${archivePath}`)
  console.log(`条目    ${entryPath}`)

  if (archivePath === undefined || !existsSync(archivePath)) throw new Error(`找不到 DSH 安装版的 app.asar（用 --asar 指定）：${archivePath ?? '(没解析出路径)'}`)

  const original = readEntry(archivePath, entryPath)
  const current = original.toString('utf8')
  const state = detectState(current, patch.edits)

  const backupDir = join(backupRoot, patch.id)
  const backupFile = join(backupDir, 'main.js.orig')
  const manifestFile = join(backupDir, 'manifest.json')
  const hasBackup = existsSync(backupFile)
  console.log(`状态    ${state}${hasBackup ? '（有备份，可回滚）' : ''}`)

  if (mode === 'status') return

  if (mode === 'revert') {
    if (!hasBackup) throw new Error(`no backup at ${backupFile} — 无法回滚`)
    const saved = readFileSync(backupFile)
    assertWritable(archivePath)
    const result = rewriteEntry(archivePath, entryPath, saved)
    console.log(result.changed ? `✔ 已回滚（-${-result.delta} 字节）` : '已经就是备份内容，无需回滚')
    console.log('重启 DSH 生效。')
    return
  }

  const { source: patched, results, failed } = applyEdits(current, patch.edits)
  for (const result of results) {
    console.log(result.ok ? `  ✔ ${result.id}  (+${result.addedBytes}B)  ${result.title ?? ''}` : `  ✘ ${result.id}  ${result.error}`)
  }
  if (failed) {
    console.error('\n有锚点没命中 —— 补丁与这个版本不匹配，一个字节都没写。')
    console.error('这通常意味着 DSH 升级过、目标代码变了；需要重新对齐锚点（见 README）。')
    process.exitCode = 1
    return
  }

  const growth = patched.length - current.length
  console.log(`\n校验通过：${patch.edits.length}/${patch.edits.length} 处锚点各命中 1 次，体积 ${current.length} → ${patched.length} 字节 (${growth >= 0 ? '+' : ''}${growth})`)

  if (mode === 'dry-run') {
    console.log('这是 dry-run，没有写盘。加 --apply 才会真的改。')
    return
  }

  assertWritable(archivePath)
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(backupFile, original)
  writeFileSync(manifestFile, JSON.stringify({
    patch: patch.id,
    patchVersion: patch.version,
    entry: entryPath,
    archive: archivePath,
    originalBytes: original.length,
    patchedBytes: Buffer.byteLength(patched),
    createdAt: new Date().toISOString(),
  }, null, 2))

  const result = rewriteEntry(archivePath, entryPath, Buffer.from(patched, 'utf8'))

  // 写完之后从磁盘重新读一遍，确认 asar 还能解析、目标文件真的是新内容。
  const verify = readEntry(archivePath, entryPath).toString('utf8')
  if (verify !== patched) throw new Error('verification failed after write — 请用备份回滚')
  console.log(`✔ 已应用（${result.delta >= 0 ? '+' : ''}${result.delta} 字节）`)
  console.log(`备份    ${backupFile}`)
  console.log('重启 DSH 生效。')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`\n✘ ${error.message}`)
    process.exitCode = 1
  })
}
