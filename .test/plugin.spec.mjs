/**
 * dsh-source-patch 插件的自检：在 DSH 之外把 host 半边完整跑一遍。
 *
 * 全程不动真实安装版：只读地检查它、把改动打在 .test/app.asar 副本上。
 */
import { copyFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply as applyPlugin, name as pluginName, inject } from '../index.js'
import { markerReport, readEntry, rewriteEntry } from '../apply.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const COPY = join(HERE, 'app.asar')
const PATCH_ID = 'sidebar-browser-durable-identity'

let failures = 0
function check(label, ok, extra = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✔' : '✘'} ${label}${extra ? `  ${extra}` : ''}`)
}
function throws(label, fn) {
  try {
    fn()
    check(label, false, '(本该抛错却成功了)')
  } catch (error) {
    check(label, true, `→ ${error.message.slice(0, 90)}`)
  }
}

console.log(`插件标识  name=${pluginName}  inject=${JSON.stringify(inject)}`)

// ---------------------------------------------------------------- 假的宿主
const tools = []
const provided = new Map()
const disposers = []
const routes = []
const ctx = {
  provide: (key, value) => provided.set(key, value),
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  tools: { register: (tool) => { tools.push(tool); return () => {} } },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  webRuntime: { trustedHosts: [] },
}

/** Minimal node-request stand-in for the route handler. */
function fakeReq(method, path, { host = '127.0.0.1:19387', body, headers = {} } = {}) {
  const listeners = new Map()
  const req = {
    method,
    url: path,
    headers: { host, ...headers },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) for (const fn of listeners.get('data') ?? []) fn(Buffer.from(JSON.stringify(body)))
    for (const fn of listeners.get('end') ?? []) fn()
  })
  return req
}

/** Minimal node-response stand-in; `done()` resolves once the handler ends it. */
function fakeRes() {
  let settle
  const finished = new Promise((resolve) => { settle = resolve })
  const res = {
    status: undefined,
    body: undefined,
    writeHead(status) { res.status = status; return res },
    end(text) { res.body = text === undefined ? undefined : JSON.parse(text); settle() },
  }
  return { res, done: () => finished }
}

console.log('\n--- 挂载插件 ---')
applyPlugin(ctx)
check('发布了 ctx.sourcePatch 服务', provided.has('sourcePatch'))
check('注册了 4 个工具', tools.length === 4, tools.map((t) => t.name).join(', '))
check('工具名符合预期', ['source_patch_status', 'source_patch_apply', 'source_patch_revert', 'source_patch_remote'].every((n) => tools.some((t) => t.name === n)))

const service = provided.get('sourcePatch')

console.log('\n--- 补丁库 ---')
const { definitions, conflicts } = service.definitions()
check('发现 1 个内置补丁', definitions.length === 1, definitions.map((d) => d.id).join(', '))
check('没有定义冲突', conflicts.length === 0, JSON.stringify(conflicts))
check('补丁来自 builtin', definitions[0]?.origin === 'builtin')

console.log('\n--- 准备一个干净的副本（全程不碰真实安装版）---')
mkdirSync(HERE, { recursive: true })
copyFileSync(REAL, COPY)

// 这台机器的安装版可能已经打过补丁 —— 那是它正常的稳定状态，不是异常。
// 副本先放回原始 lib/main.js（备份由 apply() 写出），拿它做基线，
// 这个 spec 才不会因为"机器上已经装了"而整体变红。
const pristineEntry = join(process.env.USERPROFILE ?? '', '.dsh', 'source-patch-backups', PATCH_ID, 'main.js.orig')
if (existsSync(pristineEntry)) {
  rewriteEntry(COPY, definitions[0].target.entry, readFileSync(pristineEntry))
  console.log('      已把原始 lib/main.js 放回副本')
} else {
  console.log('      ⚠ 没找到原始备份；如果安装版已经打过补丁，下面的锚点会全部落空')
}

console.log('\n--- dry-run（只读副本）---')
const plan = service.plan(PATCH_ID, COPY)
check('全部锚点命中（failed=false）', plan.failed === false)
check('7 处编辑', plan.edits.length === 7)
check('状态为 pristine', plan.state === 'pristine', plan.state)
check('体积会增长', plan.bytes.after > plan.bytes.before, `${plan.bytes.before} → ${plan.bytes.after}`)
for (const edit of plan.edits) console.log(`      ${edit.ok ? '✔' : '✘'} ${edit.id}  (${edit.addedBytes >= 0 ? '+' : ''}${edit.addedBytes}B)`)

const pristineSource = readEntry(COPY, definitions[0].target.entry).toString('utf8')
const markers = markerReport(pristineSource, definitions[0].edits)
check('未打补丁时所有 marker 都不该出现', markers.every((m) => m.markerPresent === false), markers.filter((m) => m.markerPresent).map((m) => m.id).join(', '))

console.log('\n--- 应用/回滚全流程（打在副本上）---')

throws('confirm 不对时拒绝应用', () => service.apply(PATCH_ID, 'yes', COPY))
throws('confirm 传 boolean 时拒绝', () => service.apply(PATCH_ID, true, COPY))

const applied = service.apply(PATCH_ID, PATCH_ID, COPY)
check('应用成功', applied.changed === true, `delta=${applied.deltaBytes}B`)
check('回读状态为 applied', service.inspect(PATCH_ID, COPY).state === 'applied')
check('备份目录已写', existsSync(join(applied.backup, 'main.js.orig')))

const again = service.apply(PATCH_ID, PATCH_ID, COPY)
check('重复应用幂等', again.changed === false, again.message)

throws('confirm 不对时拒绝回滚', () => service.revert(PATCH_ID, 'nope', COPY))
const reverted = service.revert(PATCH_ID, PATCH_ID, COPY)
check('回滚成功', reverted.changed === true)
check('回读状态回到 pristine', service.inspect(PATCH_ID, COPY).state === 'pristine')

console.log('\n--- 其他插件声明补丁 ---')
const withdraw = service.declare({ id: 'some-other-plugin', patches: [{ id: 'inline-demo', title: '演示', target: { entry: 'lib/main.js' }, edits: [] }] })
check('声明后能列出', service.definitions().definitions.length === 2, service.definitions().definitions.map((d) => d.id).join(', '))
check('来源标注为 plugin:some-other-plugin', service.definitions().definitions.some((d) => d.origin === 'plugin:some-other-plugin'))
withdraw()
check('withdraw 后回到 1 个', service.definitions().definitions.length === 1)
throws('同一 id 重复 declare 报错', () => { service.declare({ id: 'dup', patches: [] }); service.declare({ id: 'dup', patches: [] }) })
throws('declare 缺 id 报错', () => service.declare({ patches: [] }))

console.log('\n--- 工具本身 ---')
const statusTool = tools.find((t) => t.name === 'source_patch_status')
const exec = { signal: { throwIfAborted() {} } }
const status = await statusTool.execute({}, exec)
check('source_patch_status 返回补丁列表', Array.isArray(status.patches) && status.patches.length === 1)
check('状态里带 app.asar 路径', typeof status.archive === 'string' && status.archive.length > 0, status.archive)
const one = await statusTool.execute({ patchId: PATCH_ID }, exec)
check('带 patchId 时附上 plan', one.plan?.edits?.length === 7)
console.log('\n渲染输出：\n' + statusTool.output.render(one).split('\n').map((l) => '      ' + l).join('\n'))

const applyTool = tools.find((t) => t.name === 'source_patch_apply')
const revertTool = tools.find((t) => t.name === 'source_patch_revert')

// 这两个工具故意不接受 archivePath 覆盖参数 —— 它们的目标永远是真实安装版。
// 所以这里只验它们的守门行为，绝不真的对运行中的 DSH 下手；"确实能写"由
// verify.mjs 在 .test/app.asar 副本上验证。
let guarded = false
try {
  await applyTool.execute({ patchId: PATCH_ID, confirm: 'no' }, exec)
} catch {
  guarded = true
}
check('apply 工具拒绝错误的 confirm（因此不会误动真实安装版）', guarded)
check('apply / revert 工具都在', typeof applyTool.execute === 'function' && typeof revertTool.execute === 'function')

console.log('\n--- GitHub 远端（只读部分）---')
const remoteTool = tools.find((t) => t.name === 'source_patch_remote')
const remoteStatus = await remoteTool.execute({ action: 'status' }, exec)
check('gh 已安装', remoteStatus.detail.auth.ghInstalled === true, `version=${remoteStatus.detail.auth.version ?? '?'}`)
check('gh 已登录', remoteStatus.detail.auth.authenticated === true, `account=${remoteStatus.detail.auth.account ?? '?'}`)
console.log('      ' + remoteTool.output.render(remoteStatus).replace(/\n/g, '\n      '))
try {
  await remoteTool.execute({ action: 'publish' }, exec)
  check('publish 缺 confirm 会被拒', false, '(居然成功了)')
} catch (error) {
  check('publish 缺 confirm 会被拒', /confirm/.test(error.message), error.message.slice(0, 70))
}
try {
  await remoteTool.execute({ action: 'unknown-action' }, exec)
  check('未知 action 被拒', false)
} catch (error) {
  check('未知 action 被拒', /未知的 action/.test(error.message))
}

console.log('\n--- 客户端半边走的 HTTP 路由 ---')
check('注册了 1 条路由', routes.length === 1, routes.map((r) => `${r.kind}:${r.path}`).join(', '))
const route = routes[0]
check('路由是 /source-patch/api 前缀', route?.path === '/source-patch/api' && route?.kind === 'prefix')

{
  const { res, done } = fakeRes()
  await route.handler(fakeReq('POST', '/source-patch/api/status', { body: {} }), res)
  await done()
  check('POST status → 200', res.status === 200 && res.body.ok === true)
  check('status 带补丁列表和 asar 路径', Array.isArray(res.body.value.patches) && typeof res.body.value.archive === 'string', `${res.body.value.patches.length} 个补丁`)
}
{
  const { res, done } = fakeRes()
  await route.handler(fakeReq('POST', '/source-patch/api/plan', { body: { patchId: PATCH_ID } }), res)
  await done()
  check('POST plan → 7 处锚点', res.status === 200 && res.body.value.edits.length === 7)
}
{
  const { res, done } = fakeRes()
  await route.handler(fakeReq('POST', '/source-patch/api/apply', { body: { patchId: PATCH_ID, confirm: 'wrong' } }), res)
  await done()
  check('confirm 不对 → 400 且不写盘', res.status === 400 && /confirmation/.test(res.body.error.message))
}
{
  const { res, done } = fakeRes()
  await route.handler(fakeReq('POST', '/source-patch/api/nope', { body: {} }), res)
  await done()
  check('未知方法 → 404', res.status === 404)
}
{
  const { res, done } = fakeRes()
  await route.handler(fakeReq('POST', '/source-patch/api/status', { body: {}, headers: { 'sec-fetch-site': 'cross-site' } }), res)
  await done()
  check('跨站请求被信任围栏拒绝 → 403', res.status === 403)
}
{
  const { res, done } = fakeRes()
  await route.handler(fakeReq('GET', '/source-patch/api/status'), res)
  await done()
  check('GET 被拒 → 405', res.status === 405)
}

console.log('\n--- 清理 ---')
for (const dispose of disposers) dispose()
check('所有 disposer 都是函数', disposers.length === 5, `${disposers.length} 个（4 工具 + 1 路由）`)

console.log(`\n${failures === 0 ? '全部通过 ✔' : `${failures} 项失败 ✘`}`)
process.exitCode = failures === 0 ? 0 : 1
