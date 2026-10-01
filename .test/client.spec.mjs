/**
 * 客户端半边的冒烟测试。
 *
 * `lib/client.js` 是手写的、符合 DSH 客户端模块格式的文件（`window.__ModuleLoader__.load`）。
 * 这里用一个假 loader + 假 React 把它装起来，验证：
 *   - 它确实是用 load({ id, factory }) 注册的；
 *   - factory 跑完后导出了 apply / inject；
 *   - apply 注册了侧边栏 Tab 和对应的 body 槽位；
 *   - body 组件能真的渲染出一棵树（hook 用假的）。
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label, ok, extra = '') {
  if (!ok) failures += 1
  console.log(`  ${ok ? '✔' : '✘'} ${label}${extra ? `  ${extra}` : ''}`)
}

// ---------------------------------------------------------------- 假 loader

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

await import(pathToFileURL(join(HERE, '..', 'lib', 'client.js')).href)

check('调用了 window.__ModuleLoader__.load', loaded !== null)
check('模块 id 是 dsh-source-patch', loaded?.id === 'dsh-source-patch', loaded?.id)
check('factory 是函数', typeof loaded?.factory === 'function')

// ---------------------------------------------------------------- 假 React

const hooks = { states: [] }
const fakeReact = {
  createElement(type, props, ...children) {
    return { $$element: true, type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
}
hooks.fakeReact = fakeReact

const requested = []
const fakeRequire = (id) => {
  requested.push(id)
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require("${id}")`)
}

// ---------------------------------------------------------------- 取模块

const moduleExports = loaded.factory(fakeRequire)
check('只 require 了 react', requested.length === 1 && requested[0] === 'react', requested.join(', '))
check('导出了 apply', typeof moduleExports.apply === 'function')
check('导出了 inject', Array.isArray(moduleExports.inject), JSON.stringify(moduleExports.inject))
check('inject 里含 slots 和 sidebarRightTabs', moduleExports.inject.includes('slots') && moduleExports.inject.includes('sidebarRightTabs'))

// ---------------------------------------------------------------- 挂载

const tabs = []
const slots = []
const disposers = []
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  sidebarRightTabs: { register: (definition) => { tabs.push(definition); return () => {} } },
  slots: { inject: (name, fn) => { fn(); return () => {} }, register: (spec, component) => { slots.push({ spec, component }); return () => {} } },
}

moduleExports.apply(ctx)

check('注册了 1 个 Tab', tabs.length === 1)
const tab = tabs[0]
check('Tab id / kind 正确', tab?.id === 'dsh-source-patch' && tab?.kind === 'sourcePatch', `${tab?.id} / ${tab?.kind}`)
check('Tab 是单实例且 keepMounted', tab?.multiple === false && tab?.keepMounted === true)
check('Tab 标题是「补丁管理」', tab?.title?.('') === '补丁管理')
check('Tab 有「开始」菜单入口', Array.isArray(tab?.guide) && tab.guide.length === 1 && tab.guide[0].title === '补丁管理')
check('注册了 1 个 body 槽位', slots.length === 1)
check('槽位 key 与 Tab id 一致', slots[0]?.spec?.key === 'dsh-source-patch' && slots[0]?.spec?.name === 'sidebar.right.pane.tab')
check('body 是组件', typeof slots[0]?.component === 'function')

// ---------------------------------------------------------------- 渲染

let tree
try {
  tree = slots[0].component({})
  check('body 能渲染出一棵树', tree?.$$element === true, `根节点 ${tree?.type}`)
} catch (error) {
  check('body 能渲染出一棵树', false, error.message)
}

/** 数一数树里出现了多少个指定字符串。 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') {
    if (typeof node === 'string') out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  collect(node.props?.children, out)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

const texts = tree === undefined ? [] : collect(tree)
const joined = texts.join(' | ')
check('渲染里出现「补丁管理」', joined.includes('补丁管理'))
check('渲染里出现「GitHub 私有补丁仓库」', joined.includes('GitHub 私有补丁仓库'))
check('渲染里出现「刷新」按钮', joined.includes('刷新'))
check('渲染里出现「发布全部」', joined.includes('发布全部'))
console.log(`      文本节点 ${texts.length} 个`)

console.log(`\n${failures === 0 ? '全部通过 ✔' : `${failures} 项失败 ✘`}`)
process.exitCode = failures === 0 ? 0 : 1
