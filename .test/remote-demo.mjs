/**
 * 真跑一次 GitHub 侧：建私有补丁仓库 → 发布内置补丁 → 列远端 → 下拉安装。
 * 会真的在你的 GitHub 上创建（私有）仓库并推送。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GitHubPatchRegistry } from '../remote.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const registry = new GitHubPatchRegistry()

console.log('--- auth ---')
console.log(JSON.stringify(await registry.auth(), null, 2))

console.log('\n--- ensureRepo ---')
console.log(JSON.stringify(await registry.ensureRepo(), null, 2))

const file = join(HERE, '..', 'patches', 'sidebar-browser-durable-identity.json')
const text = readFileSync(file, 'utf8')
const definition = JSON.parse(text)

console.log('\n--- publish ---')
console.log(JSON.stringify(await registry.publish([{ id: definition.id, definition, text }]), null, 2))

console.log('\n--- available ---')
console.log(JSON.stringify(await registry.available(), null, 2))

console.log('\n--- install ---')
console.log(JSON.stringify(await registry.install(definition.id), null, 2))

console.log('\n--- installed ---')
console.log(JSON.stringify(registry.installed(), null, 2))
