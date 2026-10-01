/**
 * dsh-source-patch 插件的自检：在 DSH 之外把 host 半边完整跑一遍。
 *
 * 全程不动真实安装版：只读地检查它、把改动打在 .test/app.asar 副本上。
 */
import { copyFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply as applyPlugin, name as pluginName, inject } from '../index.js'
import { defaultArchivePath, markerReport, readEntry } from '../apply.mjs'

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
const ctx = {
  provide: (key, value) => provided.set(key, value),
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  tools: { register: (tool) => { tools.push(tool); return () => {} } },
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

console.log('\n--- dry-run（只读真实安装版）---')
const plan = service.plan(PATCH_ID)
check('全部锚点命中（failed=false）', plan.failed === false)
check('7 处编辑', plan.edits.length === 7)
check('状态为 pristine', plan.state === 'pristine', plan.state)
check('体积会增长', plan.bytes.after > plan.bytes.before, `${plan.bytes.before} → ${plan.bytes.after}`)
for (const edit of plan.edits) console.log(`      ${edit.ok ? '✔' : '✘'} ${edit.id}  (${edit.addedBytes >= 0 ? '+' : ''}${edit.addedBytes}B)`)

const pristineSource = readEntry(defaultArchivePath(), definitions[0].target.entry).toString('utf8')
const markers = markerReport(pristineSource, definitions[0].edits)
check('未打补丁时所有 marker 都不该出现', markers.every((m) => m.markerPresent === false), markers.filter((m) => m.markerPresent).map((m) => m.id).join(', '))

console.log('\n--- 应用/回滚全流程（打在副本上）---')
if (!existsSync(COPY)) {
  console.log(`      复制 ${statSync(REAL).size} 字节到 .test/app.asar …`)
  copyFileSync(REAL, COPY)
}
const leftover = service.inspect(PATCH_ID, COPY).state
if (leftover !== 'pristine') {
  service.revert(PATCH_ID, PATCH_ID, COPY)
  console.log(`      副本残留状态为 ${leftover}，已先回滚到 pristine`)
}

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
try {
  const viaTool = await applyTool.execute({ patchId: PATCH_ID, confirm: PATCH_ID }, exec)
  check('工具能应用（真实安装版可写）', viaTool.changed === true, `delta=${viaTool.deltaBytes}B`)
  await revertTool.execute({ patchId: PATCH_ID, confirm: PATCH_ID }, exec)
  check('工具能回滚', service.inspect(PATCH_ID, COPY).state === 'pristine')
} catch (error) {
  // DSH 正在跑 → 真实 app.asar 被占用。这正是必须安全失败的路径。
  check('DSH 在跑时安全失败并给出可读原因', /DSH 正在运行|关掉 DSH|cannot replace/.test(error.message), error.message.slice(0, 130))
  check('失败后没有留下半成品文件', !existsSync(`${REAL}.dsh-patch.new`))
}

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

console.log('\n--- 清理 ---')
for (const dispose of disposers) dispose()
check('所有 disposer 都是函数', disposers.length === 4)

console.log(`\n${failures === 0 ? '全部通过 ✔' : `${failures} 项失败 ✘`}`)
process.exitCode = failures === 0 ? 0 : 1
