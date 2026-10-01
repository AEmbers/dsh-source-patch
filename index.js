/**
 * dsh-source-patch host half.
 *
 * 给 DSH 桌面版主进程打「锚点补丁」的一键管理器。它做三件事：
 *   1. 自带补丁库（patches/*.json），能列出、校验、应用、回滚；
 *   2. 把整套能力作为服务 `ctx.sourcePatch` 发布出去，**其他插件可以声明自己需要的补丁**
 *      （`ctx.get('sourcePatch').declare({ id, patches: [...] })`），由本插件统一管账；
 *   3. 给 agent 三个工具，让它能查状态、按补丁 id 确认后应用/回滚。
 *
 * 安全纪律（不许改）：
 *   - 锚点必须恰好命中 1 次，否则整包拒绝、一个字节都不写；
 *   - 应用前必须先备份，应用后必须回读校验；
 *   - 应用/回滚必须显式确认（工具要求 confirm 等于补丁 id，不是一个 boolean）；
 *   - 补丁改的是主进程 —— 永远要重启才生效，且**绝不自动重启**。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyEdits, defaultArchivePath, detectState, readEntry, rewriteEntry } from './apply.mjs'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-source-patch'

/** We register agent tools, so the tool registry must be mounted first. */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const BUILTIN_PATCH_DIR = join(HERE, 'patches')
const BACKUP_ROOT = join(process.env.USERPROFILE ?? process.cwd(), '.dsh', 'source-patch-backups')

/** Read every bundled patch definition. */
function readBuiltinPatches() {
  if (!existsSync(BUILTIN_PATCH_DIR)) return []
  return readdirSync(BUILTIN_PATCH_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file: join(BUILTIN_PATCH_DIR, file), origin: 'builtin', bytes: readFileSync(join(BUILTIN_PATCH_DIR, file), 'utf8') }))
}

/**
 * The registry behind `ctx.sourcePatch`.
 *
 * A patch definition is `{ id, version, title, target: { entry }, edits: [...] }`.
 * Sources are either the plugin's own `patches/` directory or another plugin's
 * `declare()` call; declaration order decides who wins on an id collision, and
 * the loser is reported rather than silently dropped.
 */
export class SourcePatchRegistry {
  #declared = new Map()

  /** Register patches owned by another plugin.
   * @param declaration - `{ id, patches }`; each patch is an absolute file path or an inline definition.
   * @returns a disposer that withdraws the declaration. */
  declare(declaration) {
    if (declaration === null || typeof declaration !== 'object') throw new Error('source-patch: declare() needs an object')
    const owner = typeof declaration.id === 'string' && declaration.id.length > 0 ? declaration.id : undefined
    if (owner === undefined) throw new Error('source-patch: declare() needs a non-empty id')
    if (this.#declared.has(owner)) throw new Error(`source-patch: "${owner}" already declared patches`)
    const patches = Array.isArray(declaration.patches) ? declaration.patches : []
    this.#declared.set(owner, patches)
    return () => {
      this.#declared.delete(owner)
    }
  }

  /** Every known patch definition, with its origin. Later duplicates lose. */
  definitions() {
    const byId = new Map()
    const conflicts = []
    const consider = (patch, origin) => {
      if (patch === null || typeof patch !== 'object' || typeof patch.id !== 'string') {
        conflicts.push({ origin, reason: 'definition has no string id' })
        return
      }
      if (byId.has(patch.id)) {
        conflicts.push({ origin, patchId: patch.id, reason: `already defined by ${byId.get(patch.id).origin}` })
        return
      }
      byId.set(patch.id, { ...patch, origin })
    }
    for (const source of readBuiltinPatches()) {
      try {
        consider(JSON.parse(source.bytes), source.origin)
      } catch (error) {
        conflicts.push({ origin: source.file, reason: `not valid JSON: ${error.message}` })
      }
    }
    for (const [owner, patches] of this.#declared) {
      for (const patch of patches) {
        if (typeof patch === 'string' || patch instanceof URL) {
          const path = patch instanceof URL ? fileURLToPath(patch) : patch
          const absolute = isAbsolute(path) ? path : resolve(path)
          try {
            consider(JSON.parse(readFileSync(absolute, 'utf8')), `plugin:${owner}`)
          } catch (error) {
            conflicts.push({ origin: `plugin:${owner}`, file: absolute, reason: `cannot read: ${error.message}` })
          }
        } else {
          consider(patch, `plugin:${owner}`)
        }
      }
    }
    return { definitions: [...byId.values()], conflicts }
  }

  /**
   * Resolve the patch target (the installed app's app.asar) and one definition.
   * @returns `{ patch, archivePath, entryPath }`; throws when unusable.
   */
  resolve(patchId, archivePathOverride) {
    const { definitions } = this.definitions()
    const patch = definitions.find((entry) => entry.id === patchId)
    if (patch === undefined) throw new Error(`source-patch: unknown patch "${patchId}"`)
    const archivePath = archivePathOverride ?? defaultArchivePath()
    if (archivePath === undefined) throw new Error('source-patch: cannot locate the installed DSH app.asar (this host may not be the desktop build)')
    if (!existsSync(archivePath)) throw new Error(`source-patch: archive not found: ${archivePath}`)
    const entryPath = patch.target?.entry
    if (typeof entryPath !== 'string' || entryPath.length === 0) throw new Error(`source-patch: patch "${patchId}" has no target.entry`)
    return { patch, archivePath, entryPath }
  }

  /** Read the target entry and classify the patch as pristine / applied / partial. */
  inspect(patch, archivePath, entryPath) {
    const current = readEntry(archivePath, entryPath).toString('utf8')
    const state = detectState(current, patch.edits)
    return { state, bytes: current.length }
  }

  /** Dry-run every edit; nothing is written. */
  plan(patchId, archivePathOverride) {
    const { patch, archivePath, entryPath } = this.resolve(patchId, archivePathOverride)
    const current = readEntry(archivePath, entryPath).toString('utf8')
    const state = detectState(current, patch.edits)
    const { source, results, failed } = applyEdits(current, patch.edits)
    return {
      patchId,
      title: patch.title,
      archivePath,
      entryPath,
      state,
      failed,
      edits: results.map((result) => ({ id: result.id, title: result.title, ok: result.ok, error: result.error, addedBytes: result.addedBytes })),
      bytes: { before: current.length, after: source.length },
    }
  }

  /** Apply a patch. Requires `confirmation` to equal the patch id. */
  apply(patchId, confirmation, archivePathOverride) {
    if (confirmation !== patchId) throw new Error(`source-patch: refusing to apply "${patchId}" — confirmation must repeat the exact patch id`)
    const { patch, archivePath, entryPath } = this.resolve(patchId, archivePathOverride)
    const current = readEntry(archivePath, entryPath).toString('utf8')
    const state = detectState(current, patch.edits)
    if (state === 'applied') return { patchId, changed: false, state, message: '这个补丁已经打上了' }
    if (state === 'partial') throw new Error(`source-patch: "${patchId}" is partially applied — 先回滚再重打，不要在半应用状态上继续`)

    const { source, results, failed } = applyEdits(current, patch.edits)
    if (failed) {
      const broken = results.filter((result) => !result.ok).map((result) => `${result.id} (${result.error})`).join(', ')
      throw new Error(`source-patch: 锚点对不上，一个字节都没写 — ${broken}。通常是 DSH 升级过，需要重新对齐锚点。`)
    }

    const backupDir = join(BACKUP_ROOT, patchId)
    const original = readEntry(archivePath, entryPath)
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, 'main.js.orig'), original)
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
      patch: patchId,
      patchVersion: patch.version,
      entry: entryPath,
      archive: archivePath,
      originalBytes: original.length,
      patchedBytes: Buffer.byteLength(source),
      createdAt: new Date().toISOString(),
    }, null, 2))

    const result = rewriteEntry(archivePath, entryPath, Buffer.from(source, 'utf8'))
    const verify = readEntry(archivePath, entryPath).toString('utf8')
    if (verify !== source) throw new Error(`source-patch: 写入后回读不一致，请用 ${join(backupDir, 'main.js.orig')} 回滚`)
    return {
      patchId,
      changed: result.changed,
      state: 'applied',
      deltaBytes: result.delta,
      backup: backupDir,
      message: '已应用。必须重启 DSH 才生效 —— 本插件不会替你重启。',
    }
  }

  /** Revert a patch from its backup. Requires `confirmation` to equal the patch id. */
  revert(patchId, confirmation, archivePathOverride) {
    if (confirmation !== patchId) throw new Error(`source-patch: refusing to revert "${patchId}" — confirmation must repeat the exact patch id`)
    const { archivePath, entryPath } = this.resolve(patchId, archivePathOverride)
    const backupFile = join(BACKUP_ROOT, patchId, 'main.js.orig')
    if (!existsSync(backupFile)) throw new Error(`source-patch: no backup at ${backupFile} — 没有备份就无法回滚`)
    const original = readFileSync(backupFile)
    const result = rewriteEntry(archivePath, entryPath, original)
    return {
      patchId,
      changed: result.changed,
      state: 'pristine',
      backup: backupFile,
      message: result.changed ? '已回滚。重启 DSH 生效。' : '本来就等于备份内容，不需要回滚。',
    }
  }
}

/** One-line projection of a plan/inspect result for the model. */
function describe(entry) {
  const detail = entry.state === 'applied' ? '已应用' : entry.state === 'pristine' ? '未应用' : '半应用（需要先回滚）'
  return `${entry.patchId} [${entry.state}] ${detail} — ${entry.title ?? ''}`
}

export function apply(ctx) {
  const registry = new SourcePatchRegistry()

  /** Host service other plugins consume (and extend) through `ctx.sourcePatch`. */
  ctx.provide('sourcePatch', {
    declare: (declaration) => registry.declare(declaration),
    definitions: () => registry.definitions(),
    plan: (patchId, archivePath) => registry.plan(patchId, archivePath),
    inspect: (patchId, archivePath) => {
      const { patch, archivePath: archive, entryPath } = registry.resolve(patchId, archivePath)
      return { patchId, archivePath: archive, entryPath, ...registry.inspect(patch, archive, entryPath) }
    },
    apply: (patchId, confirmation, archivePath) => registry.apply(patchId, confirmation, archivePath),
    revert: (patchId, confirmation, archivePath) => registry.revert(patchId, confirmation, archivePath),
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'source_patch_status',
    description:
      'List the DSH source patches this plugin knows about, with each patch\'s state against the installed app: '
      + 'pristine (not applied), applied, or partial (half-applied — needs a revert first). '
      + 'Also reports the located app.asar and any definition conflicts. Read-only: applies nothing. '
      + 'Pass patchId to get one patch\'s per-edit anchor report without writing anything.',
    parameters: {
      patchId: { type: 'string', description: 'Optional: report just this patch, including its per-edit anchor dry run.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          archive: { type: 'string', required: true, description: 'Located app.asar path, or "(not found)".' },
          patches: { type: 'array', required: true, description: 'Known patches with their state.', items: { type: 'object', additionalProperties: true } },
          conflicts: { type: 'array', required: true, description: 'Patch definitions that were rejected (duplicate id, bad JSON).', items: { type: 'object', additionalProperties: true } },
          plan: { type: 'object', additionalProperties: true, description: 'Present only when patchId was given: the per-edit anchor report.' },
        },
      },
      render: (value) => {
        const lines = value.patches.map(describe)
        const head = `app.asar: ${value.archive}`
        const plan = value.plan === undefined ? '' : `\n\n${value.plan.patchId} 锚点校验：\n${value.plan.edits.map((edit) => `  ${edit.ok ? '✔' : '✘'} ${edit.id}${edit.ok ? ` (+${edit.addedBytes}B)` : ` ${edit.error}`}`).join('\n')}\n体积 ${value.plan.bytes.before} → ${value.plan.bytes.after} 字节`
        const conflicts = value.conflicts.length === 0 ? '' : `\n\n被拒的定义：\n${value.conflicts.map((item) => `  ${item.origin}: ${item.reason}`).join('\n')}`
        return `${head}\n${lines.length === 0 ? '（没有已知补丁）' : lines.join('\n')}${plan}${conflicts}`
      },
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const archive = defaultArchivePath() ?? '(not found)'
      const { definitions, conflicts } = registry.definitions()
      const patches = []
      for (const definition of definitions) {
        if (args.patchId !== undefined && definition.id !== args.patchId) continue
        try {
          const { patch, archivePath, entryPath } = registry.resolve(definition.id)
          patches.push({ patchId: definition.id, title: patch.title, origin: definition.origin, archivePath, entryPath, ...registry.inspect(patch, archivePath, entryPath) })
        } catch (error) {
          patches.push({ patchId: definition.id, title: definition.title, origin: definition.origin, state: 'unavailable', error: error.message })
        }
      }
      if (args.patchId !== undefined && patches.length === 0) throw new Error(`source-patch: unknown patch "${args.patchId}"`)
      return {
        archive,
        patches,
        conflicts,
        ...(args.patchId === undefined ? {} : { plan: registry.plan(args.patchId) }),
      }
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'source_patch_apply',
    description:
      'Apply one DSH source patch to the installed app.asar. Every anchor must match exactly once, or nothing is written. '
      + 'The original entry is backed up first and the result is read back and compared. '
      + 'Applying changes the Electron main process, so it only takes effect after a restart — this tool never restarts DSH. '
      + 'Requires `confirm` to repeat the exact patchId, so it can never fire by accident.',
    parameters: {
      patchId: { type: 'string', required: true, description: 'The patch id to apply.' },
      confirm: { type: 'string', required: true, description: 'Must repeat the exact patchId. A boolean is not accepted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patchId: { type: 'string', required: true, description: 'The patch that was applied.' },
          changed: { type: 'boolean', required: true, description: 'Whether any bytes changed (false when it was already applied).' },
          deltaBytes: { type: 'number', description: 'Net byte delta written into the archive entry.' },
          backup: { type: 'string', description: 'Directory holding the original entry for revert.' },
          message: { type: 'string', required: true, description: 'What the caller must do next.' },
        },
      },
      render: (value) => value.changed
        ? `已应用 ${value.patchId}（${value.deltaBytes >= 0 ? '+' : ''}${value.deltaBytes} 字节）。备份：${value.backup}。${value.message}`
        : `${value.patchId}：${value.message}`,
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const result = registry.apply(args.patchId, args.confirm)
      exec.signal.throwIfAborted()
      return result
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'source_patch_revert',
    description:
      'Revert one applied DSH source patch using the backup this plugin wrote when it applied the patch. '
      + 'Requires `confirm` to repeat the exact patchId. Restart DSH for the revert to take effect.',
    parameters: {
      patchId: { type: 'string', required: true, description: 'The patch id to revert.' },
      confirm: { type: 'string', required: true, description: 'Must repeat the exact patchId.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patchId: { type: 'string', required: true, description: 'The patch that was reverted.' },
          changed: { type: 'boolean', required: true, description: 'Whether any bytes changed.' },
          backup: { type: 'string', required: true, description: 'The backup file that was restored.' },
          message: { type: 'string', required: true, description: 'What the caller must do next.' },
        },
      },
      render: (value) => `${value.patchId}：${value.message}（备份：${value.backup}）`,
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      return registry.revert(args.patchId, args.confirm)
    },
  })))
}
