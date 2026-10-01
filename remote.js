/**
 * GitHub-backed patch registry.
 *
 * Why this design:
 *   - **No token ever touches this plugin.** Authentication is delegated to the
 *     official `gh` CLI, which keeps its credential in the OS keyring. We only
 *     ever inspect `gh auth status` and run `gh`/`git` as subprocesses.
 *   - The registry is an ordinary **private repo** holding plain JSON patch
 *     definitions plus a `registry.json` index. Readable, diffable, and it
 *     syncs across machines the same way any repo does.
 *   - A cache clone lives under `~/.dsh/dsh-source-patch/repo`; installed patch
 *     definitions live under `~/.dsh/dsh-source-patch/patches`.
 *
 * Nothing here executes a patch. Publishing and installing only move JSON;
 * applying stays behind ctx.sourcePatch's own guards.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Registry index format version written into registry.json. */
export const REGISTRY_VERSION = 1

/** Default name of the private repo the plugin creates. */
export const DEFAULT_REPO_NAME = 'dsh-patches'

/** Where installed/cached state lives. */
export function defaultRoot() {
  return join(process.env.USERPROFILE ?? process.cwd(), '.dsh', 'dsh-source-patch')
}

async function run(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options })
    return stdout.trim()
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
    const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : ''
    const detail = stderr || stdout || error.message
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

/** sha256 of a patch definition's canonical text. */
export function digestOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The registry index entry for one patch definition. */
function registryEntry(definition, text) {
  return {
    id: definition.id,
    version: definition.version ?? 1,
    title: definition.title ?? definition.id,
    summary: definition.summary ?? '',
    requiresRestart: definition.requiresRestart ?? true,
    entry: definition.target?.entry ?? '',
    editCount: Array.isArray(definition.edits) ? definition.edits.length : 0,
    file: `patches/${definition.id}.json`,
    sha256: digestOf(text),
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

export class GitHubPatchRegistry {
  #root
  #cache
  #store
  #repoName
  #owner

  constructor(options = {}) {
    this.#root = options.root ?? defaultRoot()
    this.#cache = join(this.#root, 'repo')
    this.#store = join(this.#root, 'patches')
    this.#repoName = options.repoName ?? DEFAULT_REPO_NAME
    this.#owner = options.owner
  }

  get cacheDir() { return this.#cache }
  get storeDir() { return this.#store }
  get repoName() { return this.#repoName }

  // ------------------------------------------------------------ 环境探测

  /** Is the official `gh` CLI on PATH, and who is it logged in as? */
  async auth() {
    try {
      await run('gh', ['--version'])
    } catch {
      return {
        ghInstalled: false,
        authenticated: false,
        hint: '没有找到 GitHub CLI（gh）。装一个再登录：https://cli.github.com/ ，然后运行 gh auth login',
      }
    }
    try {
      const stdout = await run('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: ['ignore', 'pipe', 'pipe'] })
      return { ghInstalled: true, authenticated: true, ...this.#parseAuthStatus(stdout) }
    } catch (error) {
      // `gh auth status` writes to stderr and exits 1 when not logged in; the
      // message is the useful part either way.
      const text = String(error.message)
      if (/not logged in|no oauth token|authentication required/i.test(text)) {
        return { ghInstalled: true, authenticated: false, hint: '还没登录。运行 gh auth login --hostname github.com --git-protocol https --web' }
      }
      return { ghInstalled: true, authenticated: false, hint: text }
    }
  }

  #parseAuthStatus(text) {
    const account = /account\s+(\S+)/i.exec(text)?.[1]
    const scopes = /scopes:\s*(.+)/i.exec(text)?.[1]?.replace(/['"]/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    return { account, scopes }
  }

  /** Resolve the account name, preferring the live CLI over anything cached. */
  async owner() {
    if (this.#owner !== undefined) return this.#owner
    this.#owner = await run('gh', ['api', 'user', '--jq', '.login'])
    return this.#owner
  }

  // ------------------------------------------------------------ 仓库

  /** Full `owner/name`. */
  async fullName() {
    return `${await this.owner()}/${this.#repoName}`
  }

  /** Does the private patches repo exist on GitHub? */
  async repoInfo() {
    const full = await this.fullName()
    try {
      const json = await run('gh', ['repo', 'view', full, '--json', 'nameWithOwner,url,visibility,isPrivate'])
      const parsed = JSON.parse(json)
      return { exists: true, full, ...parsed }
    } catch {
      return { exists: false, full }
    }
  }

  /** Create the private repo when missing, then make sure a cache clone exists. */
  async ensureRepo() {
    const full = await this.fullName()
    const info = await this.repoInfo()
    if (!info.exists) {
      await run('gh', ['repo', 'create', full, '--private', '--description', 'DSH source patch packages managed by dsh-source-patch'])
    }
    await this.#ensureClone(full)
    return { full, created: !info.exists, cache: this.#cache }
  }

  async #ensureClone(full) {
    const url = `https://github.com/${full}.git`
    if (existsSync(join(this.#cache, '.git'))) {
      await run('git', ['-C', this.#cache, 'remote', 'set-url', 'origin', url])
      return
    }
    mkdirSync(this.#root, { recursive: true })
    await run('git', ['clone', url, this.#cache])
    // An empty repo clones without any branch to stand on.
    try {
      await run('git', ['-C', this.#cache, 'rev-parse', '--verify', 'HEAD'])
    } catch {
      await run('git', ['-C', this.#cache, 'checkout', '-b', 'main'])
    }
    // A commit identity that never leaks a real address.
    const login = await this.owner()
    await run('git', ['-C', this.#cache, 'config', 'user.name', login])
    await run('git', ['-C', this.#cache, 'config', 'user.email', `${login}@users.noreply.github.com`])
  }

  /** Refresh the cache from the remote; a missing repo is not an error here. */
  async sync() {
    const info = await this.repoInfo()
    if (!info.exists) return { synced: false, reason: '远端仓库还不存在' }
    await this.#ensureClone(info.full)
    try {
      await run('git', ['-C', this.#cache, 'pull', '--ff-only'])
      return { synced: true }
    } catch (error) {
      // A fresh remote with no commits yet is a normal state, not a failure.
      if (/couldn't find remote ref|no such ref/i.test(String(error.message))) return { synced: true, empty: true }
      throw error
    }
  }

  // ------------------------------------------------------------ 读

  /** The remote registry index (empty until something is published). */
  readRegistry() {
    const file = join(this.#cache, 'registry.json')
    if (!existsSync(file)) return { registryVersion: REGISTRY_VERSION, patches: [] }
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  /** Patch definitions already downloaded into the local store. */
  installed() {
    if (!existsSync(this.#store)) return []
    return readdirSync(this.#store)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const text = readFileSync(join(this.#store, file), 'utf8')
        const definition = JSON.parse(text)
        return { id: definition.id, version: definition.version ?? 1, title: definition.title, sha256: digestOf(text), file: join(this.#store, file) }
      })
  }

  /** Remote patches annotated with whether the local store already has them. */
  async available() {
    const synced = await this.sync()
    const registry = this.readRegistry()
    const local = new Map(this.installed().map((entry) => [entry.id, entry]))
    return {
      synced,
      patches: (registry.patches ?? []).map((entry) => {
        const here = local.get(entry.id)
        return { ...entry, installed: here !== undefined, upToDate: here !== undefined && here.sha256 === entry.sha256 }
      }),
    }
  }

  // ------------------------------------------------------------ 写

  /**
   * Copy the given patch definitions into the cache repo, refresh the index,
   * and push. Definitions are passed in already parsed so this module never
   * has to know where they came from.
   * @param definitions - `[{ id, text, definition }]` (text is the exact JSON to store).
   */
  async publish(definitions) {
    if (!Array.isArray(definitions) || definitions.length === 0) throw new Error('没有可发布的补丁')
    await this.ensureRepo()
    await this.sync().catch(() => ({ synced: false }))

    const patchesDir = join(this.#cache, 'patches')
    mkdirSync(patchesDir, { recursive: true })
    for (const item of definitions) {
      writeFileSync(join(patchesDir, `${item.id}.json`), item.text)
    }

    // The very first publish defines the inventory; later publishes add.
    const existing = this.readRegistry().patches ?? []
    const byId = new Map(existing.map((entry) => [entry.id, entry]))
    for (const item of definitions) byId.set(item.id, registryEntry(item.definition, item.text))
    const registry = {
      registryVersion: REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
      patches: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    }
    writeFileSync(join(this.#cache, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`)

    await run('git', ['-C', this.#cache, 'add', '-A'])
    let committed = true
    try {
      await run('git', ['-C', this.#cache, 'commit', '-m', `patch registry: publish ${definitions.map((d) => d.id).join(', ')}`])
    } catch (error) {
      if (/nothing to commit|no changes added/i.test(String(error.message))) committed = false
      else throw error
    }
    if (committed) await run('git', ['-C', this.#cache, 'push', '--set-upstream', 'origin', 'HEAD'])
    return { published: definitions.map((d) => d.id), committed, repo: await this.fullName() }
  }

  /** Download one patch definition from the cache into the local store. */
  async install(patchId) {
    await this.sync()
    const entry = (this.readRegistry().patches ?? []).find((item) => item.id === patchId)
    if (entry === undefined) throw new Error(`远端 registry 里没有补丁 "${patchId}"`)
    const source = join(this.#cache, 'patches', `${patchId}.json`)
    if (!existsSync(source)) throw new Error(`registry 说 ${entry.file} 存在，但缓存里找不到`)
    const text = readFileSync(source, 'utf8')
    const actual = digestOf(text)
    if (actual !== entry.sha256) throw new Error(`补丁 "${patchId}" 校验失败：registry 记的是 ${entry.sha256.slice(0, 12)}…，实际是 ${actual.slice(0, 12)}…`)
    mkdirSync(this.#store, { recursive: true })
    const target = join(this.#store, `${patchId}.json`)
    writeFileSync(target, text)
    return { patchId, version: entry.version, file: target, sha256: actual }
  }

  /** Remove a downloaded patch definition from the local store. */
  uninstall(patchId) {
    const target = join(this.#store, `${patchId}.json`)
    if (!existsSync(target)) return { patchId, removed: false }
    rmSync(target, { force: true })
    return { patchId, removed: true }
  }
}
