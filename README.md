# dsh-source-patch

给 **DSH 桌面版主进程**打补丁的一键工具 + 补丁定义库。

起因：DSH 的「一切皆插件」覆盖的是**应用层**（Host 服务 / 客户端 UI / Agent 工具），
而 Electron 外壳（主进程 + preload）是**插件的运行环境**，不开放给插件 ——
`will-attach-webview` 那道闸门挡住了渲染进程通往 `nodeIntegration` 的路，
这是故意的安全边界。所以想让侧边栏浏览器「有身份、功能完整、agent 能操控」，
只能动主进程源码。官方升级一次就得重打一次，于是有了这个包。

## 用法一：命令行

```powershell
cd <这个仓库>

node apply.mjs --status      # 看一眼：目标在哪、补丁是 pristine / applied / partial
node apply.mjs               # 默认 dry-run：逐条校验锚点，不写盘
node apply.mjs --apply       # 真的打进去（会先备份）
node apply.mjs --revert      # 用备份回滚
```

参数：`--asar <path>` 换目标、`--patch <file>` 换补丁、`--backup-dir <dir>` 换备份位置。

**打完必须重启 DSH** —— 补丁改的是主进程的 `lib/main.js`，进程已经把它读进内存了。

## 用法二：作为 DSH 插件

这个目录**本身就是一个 DSH bundle 插件**。装进 profile：

```powershell
dsh plugin --profile desktop add <这个目录的绝对路径>
```

装完后它提供三样东西。

### 1. 服务 `ctx.sourcePatch` —— 给其他插件复用

别的插件（尤其是那些同样需要动源码的）只要声明，就由本插件统一管账：

```js
export const inject = ['sourcePatch']
export function apply(ctx) {
  ctx.effect(() => ctx.sourcePatch.declare({
    id: 'my-plugin',
    patches: [new URL('./my.patch.json', import.meta.url)],   // 绝对路径 / URL / 内联定义都行
  }))
}
```

接口：`declare` · `definitions` · `inspect(id)` · `plan(id)` · `apply(id, confirmation)` · `revert(id, confirmation)`。

同一个补丁 id 重复声明会被**当场拒绝**并记为冲突，不会静默覆盖。

### 2. 三个 agent 工具

| 工具 | 作用 |
|---|---|
| `source_patch_status` | 只读。列出补丁 + 状态（pristine / applied / partial）+ app.asar 位置；带 `patchId` 时附上逐条锚点 dry-run。 |
| `source_patch_apply` | 应用。要求 `confirm` **等于补丁 id**（不是 boolean），误触发不了。 |
| `source_patch_revert` | 从备份回滚。同样要求 `confirm` 等于补丁 id。 |

**两个写工具都不会重启 DSH** —— 只告诉你"重启才生效"。

### 3. 内置补丁库

就是下面那个 `sidebar-browser-durable-identity`。

### 自检

```powershell
node .test/plugin.spec.mjs
```

它会：在**只读**模式下校验真实安装版 → 把改动打在 `.test/app.asar` 副本上跑完整应用/回滚流程 →
验证幂等、验证 confirm 守卫、验证别的插件 declare/withdraw、验证工具本身。
副本会临时占 121MB，跑完可以删。

> `.test/` 需要 `@deepseek-ai/dsh-tools` 才能解析 `index.js`。真实 profile 里本来就有；
> 在工作区里则靠 `../node_modules/@deepseek-ai/dsh-tools` 那个**仅测试用**的 shim。
> 这个 shim 刻意放在**包外** —— 放在包内会遮蔽 profile 里真正的 `dsh-tools`。

## 用法三：跨设备 —— GitHub 私有补丁仓库

插件可以把补丁包放到你 GitHub 上的一个 **私有仓库** 里。换台机器装同一个插件，就能把补丁拉回来。

### 认证：靠官方 `gh`，本插件永远不碰你的 token

它只调用官方 GitHub CLI（`gh`），token 存在操作系统的凭据库里（Windows 是凭据管理器）。

- **没装 gh** → 提示你去 <https://cli.github.com/> 装一个
- **装了但没登录** → 提示你运行一次：

  ```powershell
  gh auth login --hostname github.com --git-protocol https --web
  ```

  这条命令走**设备码流程**：终端给你一个一次性代码，同时在浏览器里打开 GitHub，
  你确认一次就完事。之后本插件直接复用这份登录态 —— 不需要你到任何地方粘贴 PAT。

### 仓库

默认在 `<你的账号>/dsh-patches`，**私有**，首次 `publish` 时自动创建。里面就是可读可 diff 的纯 JSON：

```
registry.json          # 索引：id / version / title / sha256 / 编辑数 / 体积
patches/<id>.json      # 完整的补丁定义
```

### 操作

对 agent 说一句就行（工具 `source_patch_remote`）：

| action | 干什么 | 要 confirm 吗 |
|---|---|---|
| `status` | gh 装没装、登录没登录、私有仓库在不在 | 不用 |
| `available` | 远端有哪些补丁、本地装没装、有没有新版本 | 不用 |
| `installed` | 本地 store 里有哪些 | 不用 |
| `publish` | 把本地补丁推上去（缺省全推，可传 id 过滤） | 需要 `confirm="publish"` |
| `install` | 下载某个补丁到本地 store（带 sha256 校验） | 需要 `confirm` 等于补丁 id |
| `uninstall` | 从本地 store 删掉 | 需要 `confirm` 等于补丁 id |

也可以在别的插件里直接用服务：

```js
const remote = ctx.get('sourcePatch').remote
await remote.ensureRepo()
await remote.publish(['sidebar-browser-durable-identity'])
await remote.install('sidebar-browser-durable-identity')
```

### 本地位置

```
~/.dsh/dsh-source-patch/repo/       # 私有仓库的缓存 clone
~/.dsh/dsh-source-patch/patches/    # 从远端装下来的补丁定义
```

`patches/` 里的定义会被 `ctx.sourcePatch.definitions()` 当作 `store` 来源一起列出来 ——
**装下来就能直接用**，和内置补丁一视同仁。

### 边界（不长但重要）

`publish` 和 `install` **只搬 JSON**。它们不会应用补丁；应用仍然要单独过一次
`source_patch_apply`（还得 confirm 等于补丁 id），而且任何一步都**不会替你重启 DSH**。

## 它改了什么

目标：安装版 `resources/app.asar` 里的 `lib/main.js`（打包后的主进程，约 480KB）。
补丁 `sidebar-browser-durable-identity` 共 7 处编辑，净增 1515 字节：

| # | 锚点 | 改动 |
|---|---|---|
| 1 | `durable-partition` | `` `dsh-sidebar-browser-${randomUUID()}` `` → `` `persist:dsh-sidebar-browser-${sha256(workspace)}` ``。原来是无 `persist:` 的内存分区，退出即失；现在落到磁盘，按 workspace 稳定分键。 |
| 2 | `policy-header` | 注释从 "fixed isolation policy" 改成 "durable, workspace-scoped"；注入 `GRANTED_PERMISSIONS` 白名单与 `configuredExtensions()`（读 `DSH_DESKTOP_BROWSER_EXTENSIONS`）。 |
| 3 | `plugins-enabled` | `plugins: false` → `true`：放开 Chromium 内嵌插件（PDF 阅读器等）。 |
| 4 | `dialogs-enabled` | `disableDialogs: true` → `false`：放开 alert / confirm / prompt。 |
| 5 | `extension-registry-field` | 给 guest 拥有者加 `extensionLoads = new WeakSet()`。 |
| 6 | `session-policy` | 整个 `configureSession` 换掉：加扩展加载；权限请求/查询改走白名单；**删掉 `will-download` 的 `preventDefault`**（放行下载）。设备权限与屏幕共享维持拒绝。 |
| 7 | `guest-cdp-endpoint` | 新增 `installGuestDebuggingEndpoint()`：读 `DSH_DESKTOP_CDP_PORT`，设了就开一个**只绑 127.0.0.1** 的 CDP 端点，供 agent 操控侧边栏里的 guest。默认关闭，非法值直接抛错。 |

放宽的权限白名单：
`clipboard-read`、`clipboard-sanitized-write`、`fullscreen`、`geolocation`、`media`、`notifications`、`pointerLock`。

## 设计：为什么它敢改你的安装

1. **锚点必须唯一。** 每处编辑是一个正则，**必须恰好命中 1 次**，否则整包拒绝、**一个字节都不写**。
   第一次试跑时 3 处锚点各命中 3/3/2 次 —— 工具立刻罢工而不是"尽量猜"。
2. **先自我校验。** 动手前把解析出来的 asar 头部 JSON 重新 pickle 回去，
   必须和原文件里的头部字节**逐字节相同**。对不上就说明我们没看懂这个 asar，直接放弃。
3. **只重写一个文件。** asar 是「头部 pickle + 连续数据区」。改一个文件的尺寸会让它之后的条目整体平移，
   所以工具会重写头部里的 offset、把数据区其余部分原样搬运，而**不重新打包**整个包。
4. **写前备份，写后回读。** 备份只存原始的 `lib/main.js`（约 480KB），回滚够用；
   写完立刻从磁盘重新读一遍并比对，不一致就报错让你回滚。
5. **锁定检测。** 打不开写句柄（DSH 正在跑）就明确报错，而不是写到一半。

## 升级之后怎么办

官方升级会换掉整个 `app.asar`，补丁随之失效。这时：

```powershell
node apply.mjs --status     # 应该显示 pristine
node apply.mjs              # dry-run 校验锚点
```

- **全部命中** → `--apply` 直接重打。
- **有锚点没命中** → 说明目标代码变了。工具会列出是哪几处；
  用 `.test/verify.mjs` 那套办法把新版本的 `lib/main.js` 抽出来对照，
  改 `patches/*.json` 里的 `find` 正则即可。**不要**去放宽"必须命中 1 次"的约束。

## 安全提醒（认真读）

这个包的能力本质上等于「**改写 DSH 主进程**」。主进程有完整机器权限，
所以一旦被滥用，效果等同于在下次启动时执行任意代码。

因此本包刻意保持：
**永远显示改了什么 · 永远先备份 · 永远要人工加 `--apply` · 锚点对不上就拒绝。**

将来把它封装成插件时，这几条必须原样保留 —— 不能有"自动应用"的路径。

## 目录

```
index.js                                    host 半边：ctx.sourcePatch 服务 + 三个 agent 工具
cordis.patch.yml                            插件行（dsh.bundle.patch 那一层）
package.json                                插件清单（dsh.bundle.patch / manifestVersion）
apply.mjs                                   引擎 + CLI（index.js 就是 import 它）
patches/sidebar-browser-durable-identity.json   补丁定义（锚点正则 + 替换模板 + marker）
.test/plugin.spec.mjs                       插件自检
.test/verify.mjs                            asar 读写引擎的端到端验证
```

`apply.mjs` 导出的可复用部分：
`parseArchive` / `buildHeaderPickle` / `entryInfo` / `readEntry` / `rewriteEntry` /
`applyEdits` / `detectState` / `markerReport` / `defaultArchivePath`。

## 已验证

对 121,348,951 字节的真实 `app.asar` 副本执行 `--apply`：

- 7/7 处锚点各命中 1 次
- `lib/main.js` 490,173 → 491,688 字节
- **有且仅有** `lib/main.js` 变化（全量比对 11,470 个打包条目）
- 抽样条目（`package.json` / `lib/preload-*.cjs` / `lib/welcome/welcome.js` /
  `node_modules/electron-updater/out/main.js` / `dsh/package.json` …）逐字节不变
- 打补丁后的 `lib/main.js` 通过 `node --check`
- `app.asar.unpacked/` 完全不碰

**尚未验证**：打完补丁的 App 真的能启动。这需要替换真实安装（得先关掉正在运行的 DSH），
留待实际应用时确认。

插件的自检（`node .test/plugin.spec.mjs`）已验证：

- 挂载后发布 `ctx.sourcePatch`，注册 3 个工具，disposer 全部可回收
- 补丁库发现 1 个内置补丁、无定义冲突
- **只读地**校验真实安装版：7/7 锚点命中、状态 pristine、所有 marker 在未打补丁时都不存在
- 在副本上跑完整生命周期：应用（+1515B）→ 状态 applied → 幂等（重复应用 changed=false）→ 回滚 → pristine
- `confirm` 不等于补丁 id（含传 boolean）时，应用与回滚都被拒绝
- 另一个插件 `declare` 后能被列出并标注来源，`withdraw` 后消失；重复 id / 缺 id 会报错
- **DSH 正在运行时应用会安全失败**：报 `EPERM` 并说明原因，且**不留下半成品文件**

最后一条是真跑出来的 —— 测试对着正在运行的安装版调用工具，rename 被系统拒绝，
工具清掉了 121MB 的临时文件再抛出可读错误。这正是设计要的结果。

## 备份位置

`%USERPROFILE%\.dsh\source-patch-backups\<patch-id>\`
—— `main.js.orig`（原始字节）+ `manifest.json`（版本、字节数、时间）。
