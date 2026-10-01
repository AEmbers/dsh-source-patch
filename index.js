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
import { applyEdits, archiveFsName, defaultArchivePath, detectState, readEntry, rewriteEntry } from './apply.mjs'
import { isTrustedApiRequest } from './fence.js'
import { GitHubPatchRegistry } from './remote.js'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-source-patch'

/** Agent tools, plus the web server routes the client half talks to. */
export const inject = ['tools', 'webServer', 'webRuntime']

const HERE = dirname(fileURLToPath(import.meta.url))
const BUILTIN_PATCH_DIR = join(HERE, 'patches')
const BACKUP_ROOT = join(process.env.USERPROFILE ?? process.cwd(), '.dsh', 'source-patch-backups')

/** The GitHub-backed registry; also owns the local store path. */
const remote = new GitHubPatchRegistry()
const STORE_PATCH_DIR = remote.storeDir

/** Read every bundled patch definition. */
function readBuiltinPatches() {
  if (!existsSync(BUILTIN_PATCH_DIR)) return []
  return readdirSync(BUILTIN_PATCH_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file: join(BUILTIN_PATCH_DIR, file), origin: 'builtin', bytes: readFileSync(join(BUILTIN_PATCH_DIR, file), 'utf8') }))
}

/** Read patch definitions pulled down from the private registry repo. */
function readStorePatches() {
  if (!existsSync(STORE_PATCH_DIR)) return []
  return readdirSync(STORE_PATCH_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file: join(STORE_PATCH_DIR, file), origin: 'store', bytes: readFileSync(join(STORE_PATCH_DIR, file), 'utf8') }))
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
    const consider = (patch, origin, file, text) => {
      if (patch === null || typeof patch !== 'object' || typeof patch.id !== 'string') {
        conflicts.push({ origin, reason: 'definition has no string id' })
        return
      }
      if (byId.has(patch.id)) {
        const existing = byId.get(patch.id)
        // The same definition reachable from two places (bundled + pulled from
        // the registry) is not a conflict — the first source simply wins.
        if (typeof text === 'string' && text === existing.sourceText) return
        conflicts.push({ origin, patchId: patch.id, reason: `already defined by ${existing.origin}, 且内容不同` })
        return
      }
      byId.set(patch.id, { ...patch, origin, sourceFile: file, sourceText: text })
    }
    for (const source of [...readBuiltinPatches(), ...readStorePatches()]) {
      try {
        consider(JSON.parse(source.bytes), source.origin, source.file, source.bytes)
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
            consider(JSON.parse(readFileSync(absolute, 'utf8')), `plugin:${owner}`, absolute, readFileSync(absolute, 'utf8'))
          } catch (error) {
            conflicts.push({ origin: `plugin:${owner}`, file: absolute, reason: `cannot read: ${error.message}` })
          }
        } else {
          consider(patch, `plugin:${owner}`, undefined, JSON.stringify(patch, null, 2) + '\n')
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
      mode: result.mode,
      deltaBytes: result.delta,
      backup: backupDir,
      message: result.mode === 'in-place'
        ? '已应用（原地写入，没有替换文件 —— 所以 DSH 开着也能打）。重启 DSH 生效，本插件不会替你重启。'
        : '已应用。必须重启 DSH 才生效 —— 本插件不会替你重启。',
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

  /**
   * Publish patch definitions to the private registry repo.
   * @param patchIds - ids to publish; omitted publishes everything currently known.
   */
  async publish(patchIds) {
    const { definitions } = this.definitions()
    const wanted = patchIds === undefined || patchIds.length === 0
      ? definitions
      : definitions.filter((definition) => patchIds.includes(definition.id))
    if (wanted.length === 0) throw new Error('没有匹配的补丁可发布')
    const missing = wanted.filter((definition) => typeof definition.sourceText !== 'string')
    if (missing.length > 0) throw new Error(`这些补丁没有可发布的文本形式：${missing.map((d) => d.id).join(', ')}`)
    return remote.publish(wanted.map((definition) => ({ id: definition.id, definition, text: definition.sourceText })))
  }
}

/** One-line projection of a plan/inspect result for the model. */
function describe(entry) {
  const detail = entry.state === 'applied' ? '已应用' : entry.state === 'pristine' ? '未应用' : '半应用（需要先回滚）'
  return `${entry.patchId} [${entry.state}] ${detail} — ${entry.title ?? ''}`
}

// ------------------------------------------------------------ client 半边的 HTTP API

/** Read a small JSON request body; anything oversized or unparsable is a client error. */
function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function requirePatchId(body) {
  const id = body?.patchId
  if (typeof id !== 'string' || id === '') throw new Error('patchId is required')
  return id
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

    /**
     * The GitHub-backed side: authenticate through the `gh` CLI (this plugin
     * never sees a token), keep a private repo of patch packages, and move
     * JSON in and out of it so the same patches follow you across machines.
     */
    remote: {
      auth: () => remote.auth(),
      repo: () => remote.repoInfo(),
      ensureRepo: () => remote.ensureRepo(),
      sync: () => remote.sync(),
      available: () => remote.available(),
      installed: () => remote.installed(),
      install: (patchId) => remote.install(patchId),
      uninstall: (patchId) => remote.uninstall(patchId),
      publish: (patchIds) => registry.publish(patchIds),
      paths: () => ({ cache: remote.cacheDir, store: remote.storeDir, repo: remote.repoName }),
    },
  })

  // ------------------------------------------------------------ 客户端半边走的 HTTP API
  // 客户端半边活在渲染进程里，够不到宿主进程；这里给它一条本地路由。
  // 信任围栏是防 DNS rebinding / 跨站用的 —— 这条路由能改主进程，所以不是可选项。
  const apiMethods = {
    status: async () => {
      const { definitions, conflicts } = registry.definitions()
      const patches = definitions.map((definition) => {
        try {
          const { patch, archivePath, entryPath } = registry.resolve(definition.id)
          return {
            id: definition.id,
            title: patch.title,
            summary: patch.summary,
            origin: definition.origin,
            version: definition.version ?? 1,
            editCount: Array.isArray(patch.edits) ? patch.edits.length : 0,
            requiresRestart: patch.requiresRestart !== false,
            archivePath,
            entryPath,
            ...registry.inspect(patch, archivePath, entryPath),
          }
        } catch (error) {
          return { id: definition.id, title: definition.title, origin: definition.origin, state: 'unavailable', error: error.message }
        }
      })
      return {
        archive: defaultArchivePath() ?? null,
        patches,
        conflicts,
        paths: { backupRoot: BACKUP_ROOT, store: STORE_PATCH_DIR, cache: remote.cacheDir, archiveFs: archiveFsName },
      }
    },
    plan: async (body) => registry.plan(requirePatchId(body)),
    apply: async (body) => registry.apply(requirePatchId(body), body?.confirm),
    revert: async (body) => registry.revert(requirePatchId(body), body?.confirm),
    remoteStatus: async () => {
      const auth = await remote.auth()
      const repo = auth.authenticated ? await remote.repoInfo() : { exists: false, full: await remote.fullName().catch(() => undefined) }
      return { auth, repo, repoName: remote.repoName, paths: { cache: remote.cacheDir, store: remote.storeDir } }
    },
    remoteAvailable: async () => remote.available(),
    remoteInstalled: async () => ({ patches: remote.installed() }),
    remotePublish: async (body) => registry.publish(Array.isArray(body?.patchIds) && body.patchIds.length > 0 ? body.patchIds : undefined),
    remoteInstall: async (body) => remote.install(requirePatchId(body)),
    remoteUninstall: async (body) => remote.uninstall(requirePatchId(body)),
  }

  if (ctx.webServer !== undefined) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/source-patch/api',
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, ctx.webRuntime?.trustedHosts ?? [])) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith('/source-patch/api/') ? pathname.slice('/source-patch/api/'.length) : undefined
        const handler = method === undefined || method.includes('/') ? undefined : apiMethods[method]
        if (handler === undefined) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown source-patch API method "${method ?? ''}"` } })
          return
        }
        try {
          const payload = await readJsonBody(req)
          writeJson(res, 200, { ok: true, value: await handler(payload) })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } })
        }
      },
    }), 'dsh-source-patch: /source-patch/api routes')
  }

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

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'source_patch_remote',
    description:
      'Manage DSH source-patch packages through a private GitHub repo, so the same patches follow you across machines. '
      + 'Authentication is delegated to the official `gh` CLI — this plugin never handles a token, and the one-time login is `gh auth login --hostname github.com --git-protocol https --web`. '
      + 'Actions: '
      + 'status (is gh installed / logged in / does the private patches repo exist), '
      + 'available (remote registry entries vs what is installed locally), '
      + 'installed (local store contents), '
      + 'publish (push local patch definitions to the private repo), '
      + 'install (download one patch definition into the local store), '
      + 'uninstall (drop one from the local store). '
      + 'publish requires confirm="publish"; install and uninstall require confirm to repeat the exact patchId. '
      + 'Installing only downloads a JSON definition — applying it is a separate, separately-confirmed step, and neither restarts DSH.',
    parameters: {
      action: { type: 'string', required: true, description: 'status | available | installed | publish | install | uninstall' },
      patchId: { type: 'string', description: 'Required for install and uninstall. For publish, an optional comma-separated filter; omit to publish everything known.' },
      confirm: { type: 'string', description: 'publish requires "publish"; install and uninstall require the exact patchId.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, description: 'The action that ran.' },
          ok: { type: 'boolean', required: true, description: 'Whether it succeeded.' },
          detail: { type: 'object', additionalProperties: true, description: 'Action-specific payload.' },
        },
      },
      render: (value) => {
        const d = value.detail ?? {}
        switch (value.action) {
          case 'status':
            return `gh: ${d.auth?.ghInstalled ? '已安装' : '未安装'} · 登录: ${d.auth?.authenticated ? `是（${d.auth.account ?? '?'}）` : '否'} · 补丁仓库 ${d.repo?.full ?? '?'}: ${d.repo?.exists ? `存在（${d.repo.visibility ?? ''}）` : '还不存在'}`
              + (d.auth?.authenticated ? '' : `\n需要先登录：${d.auth?.hint ?? 'gh auth login'}`)
          case 'available':
            return (d.patches ?? []).length === 0
              ? '远端 registry 里还没有补丁'
              : (d.patches).map((p) => `  ${p.installed ? (p.upToDate ? '✔' : '↑') : '·'} ${p.id} v${p.version}  ${p.title}${p.installed ? (p.upToDate ? ' (已安装)' : ' (有更新)') : ''}`).join('\n')
          case 'installed':
            return (d.patches ?? []).length === 0 ? '本地 store 里没有从远端装的补丁' : d.patches.map((p) => `  ${p.id} v${p.version}  ${p.title}`).join('\n')
          case 'publish': {
            // The node half reports a single patch for a filtered publish and a
            // list for a bulk one; render both without assuming either shape.
            const items = Array.isArray(d.published) ? d.published : [d]
            const list = items
              .map((p) => (typeof p === 'string' ? p : [p.id ?? p.patchId, p.version].filter(Boolean).join(' ')))
              .filter((s) => s.length > 0)
              .join(', ')
            const repo = d.repo?.full ?? d.repo ?? '?'
            return `已发布 ${list.length > 0 ? list : '（没有可发布的补丁）'} → ${repo}${d.committed === false ? '（内容没变化，未产生新提交）' : ''}`
          }
          case 'install':
            return `已安装 ${d.patchId} v${d.version} → ${d.file}`
          case 'uninstall':
            return d.removed ? `已卸载 ${d.patchId}` : `${d.patchId} 本来就没装`
          default:
            return JSON.stringify(d)
        }
      },
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const action = args.action
      switch (action) {
        case 'status': {
          const auth = await remote.auth()
          const repo = auth.authenticated ? await remote.repoInfo() : { exists: false, full: await remote.fullName().catch(() => undefined) }
          return { action, ok: true, detail: { auth, repo, paths: { cache: remote.cacheDir, store: remote.storeDir } } }
        }
        case 'available':
          return { action, ok: true, detail: await remote.available() }
        case 'installed':
          return { action, ok: true, detail: { patches: remote.installed() } }
        case 'publish': {
          if (args.confirm !== 'publish') throw new Error('发布需要 confirm="publish"')
          const filter = typeof args.patchId === 'string' && args.patchId.trim() !== '' ? args.patchId.split(',').map((s) => s.trim()).filter(Boolean) : undefined
          return { action, ok: true, detail: await registry.publish(filter) }
        }
        case 'install': {
          if (typeof args.patchId !== 'string' || args.patchId === '') throw new Error('install 需要 patchId')
          if (args.confirm !== args.patchId) throw new Error(`安装需要 confirm 等于补丁 id（"${args.patchId}"）`)
          return { action, ok: true, detail: await remote.install(args.patchId) }
        }
        case 'uninstall': {
          if (typeof args.patchId !== 'string' || args.patchId === '') throw new Error('uninstall 需要 patchId')
          if (args.confirm !== args.patchId) throw new Error(`卸载需要 confirm 等于补丁 id（"${args.patchId}"）`)
          return { action, ok: true, detail: remote.uninstall(args.patchId) }
        }
        default:
          throw new Error(`未知的 action "${action}"，可选：status / available / installed / publish / install / uninstall`)
      }
    },
  })))
}
