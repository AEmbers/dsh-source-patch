// A client module must never be able to take the sidebar down with it: every
// step here is guarded, and a failure degrades to "this plugin registers no UI"
// plus one console.error. The node-side half keeps working regardless.
try {
window.__ModuleLoader__.load({
	id: "dsh-source-patch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		try {
			const React = require("react");
		const h = React.createElement;

		// ------------------------------------------------------------------ 常量

		/** Tab id and slot key; must be unique across the sidebar. */
		const TAB_ID = "dsh-source-patch";
		/** Tab kind; private so the official browser tab keeps its own kind. */
		const TAB_KIND = "sourcePatch";
		/** The host half's fenced route prefix (see fence.js on the host side). */
		const API_PREFIX = "/source-patch/api";

		const STATE_TEXT = { pristine: "未应用", applied: "已应用", partial: "半应用", unavailable: "不可用" };
		const STATE_COLOR = { pristine: "#8b949e", applied: "#3fb950", partial: "#d29922", unavailable: "#f85149" };
		const ORIGIN_TEXT = { builtin: "内置", store: "已安装" };

		// ------------------------------------------------------------------ 与宿主通信

		/** POST one method on the host route; a non-ok envelope becomes a thrown Error. */
		async function call(method, body) {
			const response = await fetch(`${API_PREFIX}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {}),
			});
			let payload;
			try {
				payload = await response.json();
			} catch {
				throw new Error(`HTTP ${response.status}`);
			}
			if (!payload.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
			return payload.value;
		}

		// ------------------------------------------------------------------ 样式

		const panel = { padding: "10px 12px", display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px", lineHeight: "1.5", color: "inherit", overflowY: "auto", height: "100%", boxSizing: "border-box" };
		const card = { border: "1px solid rgba(128,128,128,0.28)", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" };
		const row = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
		const muted = { opacity: 0.62 };
		const mono = { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: "11px", wordBreak: "break-all" };
		const button = { font: "inherit", padding: "3px 10px", borderRadius: "6px", border: "1px solid rgba(128,128,128,0.4)", background: "transparent", color: "inherit", cursor: "pointer" };
		const buttonPrimary = { ...button, borderColor: "rgba(63,185,80,0.7)", background: "rgba(63,185,80,0.12)" };
		const buttonDanger = { ...button, borderColor: "rgba(248,81,73,0.7)", background: "rgba(248,81,73,0.12)" };
		const sectionTitle = { fontWeight: 600, fontSize: "12px" };

		function Badge(props) {
			return h("span", {
				style: { color: props.color, border: `1px solid ${props.color}`, borderRadius: "999px", padding: "0 7px", fontSize: "11px", whiteSpace: "nowrap" },
			}, props.text);
		}

		// ------------------------------------------------------------------ 主体

		function SourcePatchBody() {
			const [status, setStatus] = React.useState(null);
			const [remote, setRemote] = React.useState(null);
			const [available, setAvailable] = React.useState(null);
			const [plan, setPlan] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			// Two-step confirmation: the first click arms, the second one commits.
			const [armed, setArmed] = React.useState(null);

			const refresh = React.useCallback(async () => {
				try {
					setStatus(await call("status"));
					setNotice(null);
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				}
			}, []);

			const refreshRemote = React.useCallback(async () => {
				try {
					setRemote(await call("remoteStatus"));
					setAvailable(await call("remoteAvailable"));
				} catch (error) {
					setNotice({ kind: "error", text: String(error.message ?? error) });
				}
			}, []);

			React.useEffect(() => { void refresh(); void refreshRemote(); }, [refresh, refreshRemote]);

			/** Run one host action, then re-read whatever it could have changed. */
			const run = async (label, operation, after) => {
				setBusy(label);
				setNotice(null);
				try {
					const value = await operation();
					await Promise.all(after.map((fn) => fn()));
					setNotice({ kind: "ok", text: `${label}：完成${value?.message !== undefined ? ` — ${value.message}` : ""}` });
				} catch (error) {
					setNotice({ kind: "error", text: `${label}失败 — ${String(error.message ?? error)}` });
				} finally {
					setBusy(null);
					setArmed(null);
				}
			};

			const arm = (key) => setArmed((current) => (current === key ? null : key));

			const patchRow = (patch) => {
				const color = STATE_COLOR[patch.state] ?? "#8b949e";
				const label = STATE_TEXT[patch.state] ?? patch.state;
				const applyKey = `${patch.id}:apply`;
				const revertKey = `${patch.id}:revert`;
				const canApply = patch.state === "pristine" && patch.requiresRestart !== undefined;
				const canRevert = patch.state === "applied";
				return h("div", { key: patch.id, style: { ...card, gap: "6px" } },
					h("div", { style: row },
						h("span", { style: { flex: "1 1 auto", fontWeight: 600 } }, patch.title ?? patch.id),
						h(Badge, { text: label, color }),
					),
					h("div", { style: { ...row, ...muted, ...mono } },
						patch.id,
						" · ",
						ORIGIN_TEXT[patch.origin] ?? patch.origin,
						typeof patch.editCount === "number" ? ` · ${patch.editCount} 处编辑` : "",
						patch.bytes !== undefined ? ` · ${patch.bytes} 字节` : "",
					),
					patch.summary !== undefined && patch.summary !== ""
						? h("div", { style: muted }, patch.summary)
						: null,
					patch.error !== undefined ? h("div", { style: { color: "#f85149" } }, patch.error) : null,
					patch.requiresRestart === true
						? h("div", { style: muted }, "改动主进程 —— 应用后需要重启 DSH 才生效，本插件不会替你重启。")
						: null,
					h("div", { style: row },
						canApply
							? h("button", {
								style: armed === applyKey ? buttonDanger : buttonPrimary,
								disabled: busy !== null,
								onClick: () => {
									if (armed !== applyKey) { arm(applyKey); return; }
									void run(`应用 ${patch.id}`, () => call("apply", { patchId: patch.id, confirm: patch.id }), [refresh]);
								},
							}, armed === applyKey ? "确认应用？" : "应用")
							: null,
						canRevert
							? h("button", {
								style: armed === revertKey ? buttonDanger : button,
								disabled: busy !== null,
								onClick: () => {
									if (armed !== revertKey) { arm(revertKey); return; }
									void run(`回滚 ${patch.id}`, () => call("revert", { patchId: patch.id, confirm: patch.id }), [refresh]);
								},
							}, armed === revertKey ? "确认回滚？" : "回滚")
							: null,
						h("button", {
							style: button,
							disabled: busy !== null,
							onClick: async () => {
								try {
									const value = await call("plan", { patchId: patch.id });
									setPlan({ patchId: patch.id, value });
								} catch (error) {
									setNotice({ kind: "error", text: `校验失败 — ${String(error.message ?? error)}` });
								}
							},
						}, "锚点校验"),
					),
					plan !== null && plan.patchId === patch.id
						? h("div", { style: { ...mono, display: "flex", flexDirection: "column", gap: "2px" } },
							plan.value.edits.map((edit) => h("div", {
								key: edit.id,
								style: { color: edit.ok ? "#3fb950" : "#f85149" },
							}, `${edit.ok ? "✔" : "✘"} ${edit.id}${edit.ok ? ` (+${edit.addedBytes}B)` : ` ${edit.error}`}`)),
							h("div", { style: muted }, `体积 ${plan.value.bytes.before} → ${plan.value.bytes.after} 字节`),
						)
						: null,
				);
			};

			const availableRow = (entry) => {
				const installedLabel = entry.installed ? (entry.upToDate ? "已安装" : "有更新") : "未安装";
				const installKey = `${entry.id}:install`;
				const uninstallKey = `${entry.id}:uninstall`;
				return h("div", { key: entry.id, style: row },
					h(Badge, { text: installedLabel, color: entry.installed ? (entry.upToDate ? "#3fb950" : "#d29922") : "#8b949e" }),
					h("span", { style: { flex: "1 1 auto" } }, `${entry.id} v${entry.version}`),
					entry.upToDate
						? h("button", {
							style: armed === uninstallKey ? buttonDanger : button,
							disabled: busy !== null,
							onClick: () => {
								if (armed !== uninstallKey) { arm(uninstallKey); return; }
								void run(`卸载 ${entry.id}`, () => call("remoteUninstall", { patchId: entry.id }), [refreshRemote, refresh]);
							},
						}, armed === uninstallKey ? "确认卸载？" : "卸载")
						: h("button", {
							style: buttonPrimary,
							disabled: busy !== null,
							onClick: () => void run(`安装 ${entry.id}`, () => call("remoteInstall", { patchId: entry.id }), [refreshRemote, refresh]),
						}, entry.installed ? "更新" : "安装"),
				);
			};

			const gh = remote?.auth;
			const repo = remote?.repo;

			return h("div", { style: panel },
				h("div", { style: row },
					h("span", { style: sectionTitle }, "补丁管理"),
					h("span", { style: { flex: "1 1 auto" } }),
					h("button", { style: button, disabled: busy !== null, onClick: () => void refresh() }, "刷新"),
				),
				h("div", { style: { ...mono, ...muted } }, status?.archive ?? "（还没读取到 app.asar）"),
				status !== null && status.conflicts.length > 0
					? h("div", { style: { ...card, borderColor: "rgba(210,153,34,0.6)" } },
						h("div", { style: sectionTitle }, "被拒的补丁定义"),
						status.conflicts.map((conflict, index) => h("div", { key: index, style: mono }, `${conflict.origin}: ${conflict.reason}`)),
					)
					: null,
				h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
					status === null
						? h("div", { style: muted }, "读取中…")
						: status.patches.length === 0
							? h("div", { style: muted }, "没有已知补丁。")
							: status.patches.map(patchRow),
				),

				// ---------------------------------------------------------- GitHub
				h("div", { style: card },
					h("div", { style: row },
						h("span", { style: sectionTitle }, "GitHub 私有补丁仓库"),
						h("span", { style: { flex: "1 1 auto" } }),
						h("button", { style: button, disabled: busy !== null, onClick: () => void refreshRemote() }, "刷新"),
						h("button", {
							style: buttonPrimary,
							disabled: busy !== null,
							onClick: () => void run("发布全部补丁", () => call("remotePublish", {}), [refreshRemote]),
						}, "发布全部"),
					),
					gh === undefined
						? h("div", { style: muted }, "读取中…")
						: gh.ghInstalled !== true
							? h("div", { style: { color: "#d29922" } }, gh.hint ?? "没找到 GitHub CLI（gh）")
							: gh.authenticated !== true
								? h("div", { style: { color: "#d29922" } },
									"还没登录 GitHub。运行一次：",
									h("div", { style: mono }, "gh auth login --hostname github.com --git-protocol https --web"),
									h("div", { style: muted }, "走设备码流程：终端给一个一次性代码 + 浏览器确认。本插件不接触你的 token。"),
								)
								: h("div", { style: mono },
									`已登录 ${gh.account ?? "?"}`,
									h("div", null, `仓库 ${remote.repoName}：${repo?.exists ? `${repo.full}（${repo.visibility ?? "?"}）` : "还不存在，首次发布会自动创建"}`),
								),
					available !== null && available.patches.length > 0
						? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
							h("div", { style: { ...sectionTitle, ...muted } }, "远端可用"),
							available.patches.map(availableRow),
						)
						: null,
				),

				notice !== null
					? h("div", { style: { ...card, borderColor: notice.kind === "ok" ? "rgba(63,185,80,0.6)" : "rgba(248,81,73,0.6)", color: notice.kind === "ok" ? "#3fb950" : "#f85149" } }, notice.text)
					: null,
				busy !== null ? h("div", { style: muted }, `${busy}…`) : null,
			);
		}

		// ------------------------------------------------------------------ 注册

		/** The sidebar tab definition: a private kind, one instance, menu entry. */
		function definition() {
			return {
				id: TAB_ID,
				kind: TAB_KIND,
				multiple: false,
				keepMounted: true,
				title: () => "补丁管理",
				guide: [{
					id: "open-source-patch",
					order: 55,
					// `guide[].title` and `guide[].description` are THUNKS, not
					// strings (SidebarRightGuideEntry in tab-registry.ts). A plain
					// string makes GuideBody throw `entry.title is not a function`
					// and takes the entire guide page down with it.
					title: () => "补丁管理",
					description: () => "查看、校验、应用、回滚 DSH 源码补丁，并同步到 GitHub 私有补丁仓库",
				}],
			};
		}

		const inject = ["slots", "sidebarRightTabs"];

		function apply(ctx) {
			ctx.effect(() => ctx.sidebarRightTabs.register(definition()), "dsh-source-patch: tab");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
			}, SourcePatchBody)), "dsh-source-patch: body");
		}

		exports.apply = apply;
		exports.inject = inject;
		} catch (error) {
			console.error("[dsh-source-patch] 客户端模块初始化失败；本插件这次不注册任何 UI，侧边栏不受影响", error);
			exports.apply = () => {};
			exports.inject = [];
		}
		return module.exports;
	}
});
} catch (error) {
	console.error("[dsh-source-patch] 客户端模块注册失败；本插件这次不注册任何 UI，侧边栏不受影响", error);
}
