import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
// 内部包的 import 统一走 compat.js：包缺失/改名时只降级对应功能，不让插件加载失败。
import {
	SessionId,
	boundContextSummary,
	createUserMessage,
	defineTool,
	probeServices,
	reportDegradation,
} from "./compat.js";
import {
	NO_START_CAPABILITIES,
	assertUsableCwd,
	settleRunResult,
	subprocessRunHandle,
} from "@deepseek-ai/dsh-subagent";
import { SharedProviderGate } from "./shared-gate.js";

//#region 元数据
/**
* 把外部订阅制 CLI 聚合为 dsh 子代理提供方。
* 每个已配置后端都会在 `ctx.subagents` 上注册为具名 `SubagentProvider`;
* 配套的 `@deepseek-ai/dsh-tool-subagent` 实例(见 cordis.patch.yml)
* 把它暴露给模型。后端均一次性执行:启动 CLI 子进程,
* 通过 stdin 送入提示词,再把 Claude 风格的 `stream-json` 事件流
* 收敛为 `SubagentResult`。
*/
// 插件名与包名保持一致（dsh 的插件管理器按包名对账，写死旧名会在改名后对不上）。
const name = (() => {
	try {
		return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).name;
	} catch {
		return "dsh-cli-hub";
	}
})();
const inject = ["subagents", "tools", "commands"];
//#endregion

//#region CLI 路径探测
const platform = process.platform;
/** 每个内置后端的候选可执行文件路径,越具体的越靠前。 */
const KNOWN_BINARIES = {
	qoder: [
		join(homedir(), ".qoder", "bin", "qodercli", platform === "win32" ? "qodercli.exe" : "qodercli"),
	],
	qodercn: [
		join(homedir(), ".qoder-cn", "bin", "qoderclicn", platform === "win32" ? "qoderclicn.exe" : "qoderclicn"),
	],
	opencode: [
		join(homedir(), ".opencode", "bin", platform === "win32" ? "opencode.exe" : "opencode"),
	],
	pi: [
		join(homedir(), ".pi", "agent", "bin", "pi-launcher.js"),
	],
	codebuddy: [
		join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy"),
	],
	codex: [
		// 优先原生 exe:cmd 包装脚本在 detached 模式下会静默退出
		join(
			homedir(), "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "node_modules", "@openai",
			process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64",
			"vendor", process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc",
			"bin", "codex.exe",
		),
		join(homedir(), "AppData", "Roaming", "npm", "codex.cmd"),
		join(homedir(), "AppData", "Roaming", "npm", "codex"),
	],
	claude: [
		join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
		join(homedir(), "AppData", "Roaming", "npm", "claude.cmd"),
		join(homedir(), "AppData", "Roaming", "npm", "claude"),
	],
};
/** 内置目录都找不到时,PATH 兜底使用的命令名。 */
const PATH_BINARIES = {
	qoder: ["qodercli"],
	qodercn: ["qoderclicn"],
	opencode: ["opencode"],
	pi: ["pi"],
	codebuddy: ["codebuddy"],
	codex: ["codex"],
	claude: ["claude"],
};
function isExecutablePath(candidate) {
	try {
		if (platform === "win32") return existsSync(candidate);
		accessSync(candidate, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** 在 PATH 中按命令名查找可执行文件(Windows 按 PATHEXT 补扩展名)。 */
function resolveFromPathNames(names, stats) {
	const dirs = (process.env.PATH ?? "")
		.split(delimiter)
		.map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
		.filter(Boolean);
	const extensions = platform === "win32"
		? (() => {
			const allowed = [".com", ".exe", ".bat", ".cmd"];
			const fromEnv = (process.env.PATHEXT ?? "").split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => allowed.includes(ext));
			return fromEnv.length > 0 ? fromEnv : [".exe", ".cmd", ".bat", ".com"];
		})()
		: [""];
	for (const dir of dirs) {
		for (const name of names) {
			const variants = platform !== "win32"
				? [name]
				: extensions.some((ext) => name.toLowerCase().endsWith(ext))
					? [name]
					: extensions.map((ext) => `${name}${ext}`);
			for (const variant of variants) {
				const candidate = join(dir, variant);
				// 供扫描方统计实际探测过的候选路径数。
				if (stats) stats.scanned += 1;
				if (isExecutablePath(candidate)) return candidate;
			}
		}
	}
	return undefined;
}
/** 设置页可添加的内置后端;是否启用由用户显式选择。 */
const BUILTIN_PROVIDERS = [
	{ name: "qoder", driver: "qoder-json" },
	{ name: "qodercn", driver: "qoder-json" },
	{ name: "opencode", driver: "opencode-json" },
	{ name: "pi", driver: "pi-json" },
	{ name: "codebuddy", driver: "codebuddy-json" },
	{ name: "codex", driver: "codex-json" },
	{ name: "claude", driver: "claude-json" },
];
/** 预设 persona 中每个内置后端的一句话说明。 */
const BACKEND_GUIDES = {
	qoder: "Qoder 国际版订阅额度,适合强推理与长任务",
	qodercn: "Qoder 国内版订阅额度,适合强推理与长任务",
	opencode: "OpenCode,优先使用免费的 *-free 模型,适合常规编码与批量工作",
	pi: "Pi 编码代理,适合需要工具链配合的实现任务",
	codebuddy: "腾讯 CodeBuddy Code,模型目录丰富,适合中文任务与常规编码",
	codex: "OpenAI Codex CLI 订阅,适合代码实现、重构与审查",
	claude: "Claude Code CLI,按本机 Claude 配置(如 Anthropic/DeepSeek 网关)运行,适合长上下文编码",
};
/**
* 各驱动支持的「思考强度」档位(实测自 CLI 帮助与二进制枚举)。
* 不在这张表里的驱动不支持强度参数:调用时传了会被明确拒绝,而不是静默忽略。
*/
const EFFORT_LEVELS = {
	"pi-json": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	"codex-json": ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};
/** 取某个驱动支持的强度档位;不支持时返回空数组。 */
function effortLevelsFor(driver) {
	return EFFORT_LEVELS[driver] ?? [];
}
/** pi 的受管安装根目录。 */
function piInstallRoot() {
	return join(homedir(), ".pi", "agent", "install");
}
/**
* 直接解析 pi 的实际 CLI 入口,绕过 `pi-launcher.js`。
* 启动器的内部 spawnSync 没有 windowsHide,会让 Windows 11
* 为真正的 CLI 新开一个终端窗口。
*/
function resolvePiCli() {
	try {
		const installRoot = piInstallRoot();
		const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
		if (!version || version === "." || version === ".." || !/^[0-9A-Za-z._+-]+$/.test(version)) return undefined;
		const packageDir = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
		const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
		if (!bin) return undefined;
		const cli = join(packageDir, bin);
		return existsSync(cli) ? cli : undefined;
	} catch {
		return undefined;
	}
}
/**
* Claude Code 没有模型目录命令,优先读取本机 settings/env
* 中实际映射的模型;没有自定义映射时才退回官方别名。
*/
function claudeModels() {
	let settings = {};
	try {
		settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
	} catch {}
	const env = { ...process.env, ...(settings.env ?? {}) };
	const keys = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
	const models = [...new Set(keys
		.map((key) => env[key])
		.filter((value) => typeof value === "string" && value.trim())
		.map((value) => value.trim()))];
	return models.length > 0 ? models : ["default", "fable", "opus", "sonnet", "haiku", "opusplan"];
}
/** 为 `{{subagent_backends}}` 提示词变量渲染当前启用的后端、调度模式和并发上限。 */
function backendGuide(providers, mode, runningOf) {
	if (providers.length === 0) return "(当前没有启用外部 CLI 后端,不要调用不存在的委派工具)";
	const header = mode === "balanced"
		? "调度模式: 平均分配(插件自动选择当前任务最少的后端,并遵守各自并发上限)"
		: "调度模式: 优先启动(插件从你调用的后端开始,按下列顺序自动转给下一个有空位的后端;全部满则等待)";
	const shared = "并发上限在所有 dsh 任务间共享";
	const lines = providers.map((entry) => {
		const limit = Math.max(1, Number(entry.maxConcurrency) || 2);
		const running = runningOf?.(entry.name) ?? 0;
		const models = Array.isArray(entry.models) && entry.models.length > 0
			? entry.models
			: entry.model
				? [entry.model]
				: [];
		const levels = effortLevelsFor(entry.driver ?? "qoder-json");
		const detail = [
			models.length > 0 ? `模型: 默认 ${models[0]};可选 ${models.join(" / ")}` : "模型: 使用 CLI 自己的默认设置",
		];
		if (levels.length > 0) {
			const current = entry.reasoningEffort && entry.reasoningEffort !== "auto" ? `;当前 ${entry.reasoningEffort}` : ";当前用配置默认";
			detail.push(`强度: ${levels.join(" / ")}${current}`);
		}
		detail.push(models.length > 0 || levels.length > 0
			? "调用时可用 model / reasoning 参数临时指定,省略则用上面配置"
			: "该后端不支持 model / reasoning 参数,不要传");
		return [`- ${entry.name}:${BACKEND_GUIDES[entry.name] ?? "外部 CLI 子代理,按需选用"} (并发上限 ${limit},当前运行 ${running})`, ...detail.map((text) => `  ${text}`)].join("\n");
	});
	return [header, shared, ...lines].join("\n");
}
/**
* 解析后端可执行文件:显式配置的路径优先;否则取
* 第一个存在的内置候选。既无内置条目又无显式路径的名称
* 属于配置错误,在启动时而不是加载时暴露。
* @param providerName - 后端注册名。
* @param explicit - 配置中的可执行文件路径(如有)。
* @returns 绝对路径;尚未安装时返回 `undefined`。
*/
function resolveBinary(providerName, explicit) {
	if (explicit) {
		if (/[\\/]/.test(explicit) || /^[A-Za-z]:/.test(explicit)) return explicit;
		return resolveFromPathNames([explicit]) ?? explicit;
	}
	if (providerName === "pi") {
		const cli = resolvePiCli();
		if (cli) return cli;
	}
	for (const candidate of KNOWN_BINARIES[providerName] ?? []) {
		try {
			// eslint-disable-next-line no-empty -- 探测路径读取失败时允许空 catch
			if (existsSync(candidate)) return candidate;
		} catch {}
	}
	return resolveFromPathNames(PATH_BINARIES[providerName] ?? [providerName]);
}
//#endregion

//#region 配置结构
const ProviderConfig = z.object({
	/** 注册名;必须与 patch 中 `dsh-tool-subagent` 的 provider 一致。 */
	name: z.string().required(),
	/** 传输驱动:qoder-json | opencode-json | pi-json | codebuddy-json | codex-json | claude-json。 */
	driver: z.string().default("qoder-json"),
	/** CLI 绝对路径;省略则按内置名称自动探测。 */
	binary: z.string(),
	/** 无头运行的 CLI 权限模式;无法弹窗询问,故默认放行。 */
	permissionMode: z.string().default("bypass_permissions"),
	/** 强制指定模型 id;省略则使用 CLI 自己的默认值(如免费额度)。 */
	model: z.string(),
	/** 有序的模型回退链;非空时覆盖 `model`。 */
	models: z.array(z.string()).default([]),
	/** 整条回退链共用的总等待预算,单位秒。 */
	allowedWaitSeconds: z.number().min(1),
	/** 传给 CLI 的思考程度:auto|none|low|medium|high|xhigh|max|ultracode。 */
	reasoningEffort: z.string().default("auto"),
	/** 显式上下文窗口(正整数 token);省略则使用 CLI 默认值。 */
	contextWindow: z.number().min(1),
	/** 单次委派的墙钟上限(秒),可选。 */
	timeoutSeconds: z.number().min(1),
	/** CLI 连续无输出的秒数,达到后提醒父 agent;0 表示关闭。 */
	stallWarnSeconds: z.number().min(0),
	/** 原样追加的额外 CLI 参数(高级覆盖项)。 */
	extraArgs: z.array(z.string()).default([]),
	/** 同时最多执行几个该后端子代理;超出后排队。 */
	maxConcurrency: z.number().min(1).default(2),
	/** 是否启用;停用只关开关、保留模型等设置,不删条目。 */
	enabled: z.boolean().default(true),
});
const PANEL_DEFAULTS = {
	dock: true,
	tab: true,
	scope: "session",
	autoHideSeconds: 30,
	maxCards: 20,
	allowStop: true,
	includeNative: false,
	hideWhenIdle: false,
	showCost: false,
	includeExternal: true,
	externalMatch: "pi-run.ps1",
};
/** 运行面板开关;写在插件配置里,cordis.patch.yml 可见,改动即时生效。 */
const PanelConfig = z.object({
	/** 是否显示输入框上方 dock。 */
	dock: z.boolean().default(true).volatile(),
	/** 是否显示「子代理」标签页。 */
	tab: z.boolean().default(true).volatile(),
	/** 范围:session(只本会话)或 all(全部会话)。 */
	scope: z.string().default("session").volatile(),
	/** 完成卡片在 dock 停留的秒数;0 表示不显示已完成卡片。 */
	autoHideSeconds: z.number().min(0).default(30).volatile(),
	/** dock / Tab 列表最多显示多少条。 */
	maxCards: z.number().min(1).max(60).default(20).volatile(),
	/** 是否显示「停止」按钮(kill 子进程)。 */
	allowStop: z.boolean().default(true).volatile(),
	/** 是否把 dsh 自带子代理(subagent / subagent_fork / teammate)并入面板;只读。 */
	includeNative: z.boolean().default(false).volatile(),
	/** 空闲(没有运行中/刚结束)时隐藏 dock;默认 false = 常驻一行。 */
	hideWhenIdle: z.boolean().default(false).volatile(),
	/** 是否在面板显示成本金额($);默认关闭。 */
	showCost: z.boolean().default(false).volatile(),
	/** 是否把「外部脚本派发的任务」(如用 pwsh 跑 pi-run.ps1 起的 pi)并入面板;只读。 */
	includeExternal: z.boolean().default(true).volatile(),
	/** 外部任务的命令行匹配规则:逗号或空白分隔的关键字,命令行包含任一即算。 */
	externalMatch: z.string().default("pi-run.ps1").volatile(),
});
const Config = z.object({
	/** 调度模式:priority(按后端顺序优先启动)或 balanced(平均分配)。 */
	scheduleMode: z.string().default("priority").volatile(),
	/** `/sub_agent_status` 列出最近运行的数量(1-24)。 */
	statusListLimit: z.number().min(1).max(24).default(16).volatile(),
	providers: z
		.array(ProviderConfig)
		.default([])
		.volatile(),
	/** 运行面板开关(输入框 dock / 子代理 Tab / 统计与停止)。 */
	panel: PanelConfig,
});

/** 读取当前生效的面板开关(未配置时用默认值)。 */
function readPanelCfg(config) {
	const raw = config?.panel;
	const pick = (key) => {
		const value = raw?.[key];
		const resolved = typeof value?.get === "function" ? value.get() : value;
		return resolved === undefined || resolved === null ? PANEL_DEFAULTS[key] : resolved;
	};
	return {
		dock: Boolean(pick("dock")),
		tab: Boolean(pick("tab")),
		scope: pick("scope") === "all" ? "all" : "session",
		autoHideSeconds: Number(pick("autoHideSeconds")) || 0,
		maxCards: Math.max(1, Number(pick("maxCards")) || 20),
		allowStop: Boolean(pick("allowStop")),
		includeNative: Boolean(pick("includeNative")),
		hideWhenIdle: Boolean(pick("hideWhenIdle")),
		showCost: Boolean(pick("showCost")),
		includeExternal: Boolean(pick("includeExternal")),
		externalMatch: String(pick("externalMatch") ?? PANEL_DEFAULTS.externalMatch),
	};
}
//#endregion

/** 并发槽位跨 dsh 进程共享,不同任务/实例共用同一份上限。 */
const providerGate = new SharedProviderGate();

/**
* 按调度模式为任务选择实际执行后端:
* priority 从所选后端开始向后找第一个有空位的,全部满则等待;
* balanced 选择当前占用最少的后端,平手时按累计使用次数轮流。
*/
class ProviderScheduler {
	#uses = new Map();
	async acquire(specs, requested, mode, signal, onWait) {
		const pool = specs.filter((spec) => spec.binary && existsSync(spec.binary));
		if (pool.length === 0) throw new Error("no enabled provider has a usable CLI binary");
		const requestedAt = pool.findIndex((spec) => spec.name === requested);
		for (;;) {
			if (signal?.aborted) throw new Error("cancelled");
			let ordered;
			if (mode === "balanced") {
				ordered = [...pool].sort((a, b) =>
					providerGate.active(a.name) - providerGate.active(b.name)
					|| (this.#uses.get(a.name) ?? 0) - (this.#uses.get(b.name) ?? 0)
					|| pool.indexOf(a) - pool.indexOf(b));
			} else {
				ordered = pool.slice(requestedAt >= 0 ? requestedAt : 0);
			}
			for (const spec of ordered) {
				const release = providerGate.tryAcquire(spec.name, spec.maxConcurrency);
				if (release) {
					this.#uses.set(spec.name, (this.#uses.get(spec.name) ?? 0) + 1);
					return { spec, release };
				}
			}
			onWait?.();
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}
const providerScheduler = new ProviderScheduler();

//#region qoder-json 驱动
/**
* 面向使用 Claude 风格 `stream-json` 协议的 CLI
* (`qodercli`、`qoderclicn` 等)的一次性提供方:提示词经 stdin 送入,
* 转录事件从 stdout 读取,以 `result` 事件结束。不声明启动期
* 能力,也不继承父上下文,因此模型工具会使用
* “看不到当前对话”的措辞。
*/
class QoderJsonProvider {
	name;
	capabilities = NO_START_CAPABILITIES;
	inheritsParentContext = false;
	#getSpec;
	#getAgent;
	#getSchedule;

	constructor(name, getSpec, getAgent, getSchedule) {
		this.name = name;
		this.#getSpec = getSpec;
		this.#getAgent = getAgent;
		this.#getSchedule = getSchedule;
	}

	async start(request) {
		assertUsableCwd(this.name, "cwd", request.cwd);
		const spec = this.#getSpec();
		if (!spec) {
			throw new Error(`${this.name}: provider is no longer present in the dsh-cli-hub config.`);
		}
		// 委派工具按需带上来的覆盖项(主控指定);没带就完全用配置。
		const wish = {
			model: typeof request.model === "string" && request.model.trim() ? request.model.trim() : undefined,
			reasoning: typeof request.reasoning === "string" && request.reasoning.trim() ? request.reasoning.trim() : undefined,
		};
		const prompt = promptText(request.prompt);
		const id = SessionId(randomUUID());
		const activity = activityLedger.begin({ id, provider: this.name, driver: spec.driver, parentId: request.parent?.id ?? null, label: request.label ?? "", prompt: prompt.slice(0, 160), stallWarnSeconds: spec.stallWarnSeconds });
		let currentRun;
		let cancelled = false;
		let lastDiagnostic;
		const aborted = new Promise((resolve) => request.signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
		const onAbort = () => {
			cancelled = true;
			void currentRun?.dispose();
		};

		const runChain = async (target) => {
			// 调用方(主控)可以临时指定模型和强度:指定的模型排在回退链最前,
			// 强度覆盖配置值;其余字段仍用配置里的 spec。
			const effective = wish.reasoning ? { ...target, reasoningEffort: wish.reasoning } : target;
			const base = wish.model
				? [wish.model, ...target.models.filter((model) => model !== wish.model)]
				: target.models;
			const chain = base.length > 0 ? base : [undefined];
			// 卡片要显示「这次实际用的模型和强度」:先把意图写进运行记录,CLI 报出真实模型后再覆盖。
			activity.override("effort", effective.reasoningEffort && effective.reasoningEffort !== "auto" ? effective.reasoningEffort : null);
			const deadline = Date.now() + target.allowedWaitSeconds * 1000;
			const tried = [];
			for (const model of chain) {
				if (cancelled) throw new Error("cancelled");
				const label = model ?? "(CLI 默认)";
				// 先记下这次要用的模型,CLI 报出真实模型后再覆盖。
				if (model) activity.override("model", model);
				activity.record("model", `正在尝试模型 ${label}`);
				const driver = DRIVERS[target.driver];
				const spawnSpec = spawnCommand(target.driver, target);
				const run = new QoderJsonRun({
					id,
					activity,
					parentAgent: this.#getAgent?.(request.parent?.id),
					stallWarnSeconds: target.stallWarnSeconds,
					warnAfterFirstEvent: true,
					driver,
					driverName: target.driver,
					provider: target.name,
					label: request.label ?? "",
					promptSummary: prompt.slice(0, 160),
					parentId: request.parent?.id,
					command: spawnSpec.command,
					args: [...spawnSpec.prefix, ...driver.buildArgs(effective, model)],
					env: spawnSpec.env,
					cwd: request.cwd,
					prompt,
					signal: request.signal,
					timeoutMs: target.timeoutSeconds ? target.timeoutSeconds * 1000 : 0,
				});
				currentRun = run;
				const remaining = Math.max(0, deadline - Date.now());
				const waitMs = target.stallWarnSeconds > 0 ? Math.min(target.stallWarnSeconds * 1000, remaining) : remaining;
				const first = await Promise.race([
					run.firstEvent.then(() => "ready"),
					new Promise((resolve) => setTimeout(() => resolve("timeout"), waitMs)),
					aborted,
				]);
				if (first === "aborted" || cancelled) {
					await run.dispose();
					throw new Error("cancelled");
				}
				if (first === "ready") {
					const result = await run.handle().result;
					await run.dispose();
					if (result.stopReason === "completed") return result;
					if (cancelled) throw new Error("cancelled");
					tried.push(`${label}: ${result.stopReason}${result.diagnostic ? ` — ${result.diagnostic.slice(0, 160)}` : ""}`);
					activity.record("error", `${label} 失败(${result.stopReason}),尝试下一个模型`);
					if (Date.now() >= deadline) break;
					continue;
				}
				tried.push(`${label}: ${Math.round(waitMs / 1000)} 秒无输出`);
				activity.record("error", `${label} ${Math.round(waitMs / 1000)} 秒无输出,切换下一个模型`);
				await run.dispose();
				if (Date.now() >= deadline) break;
			}
			lastDiagnostic = `所有模型均失败或超过允许等待时间(${target.allowedWaitSeconds}s)。尝试记录:\n${tried.join("\n")}`;
			activity.record("error", lastDiagnostic);
			throw new Error(lastDiagnostic);
		};

		const attempt = async () => {
			const schedule = this.#getSchedule?.() ?? { specs: [spec], mode: "priority" };
			let waiting = false;
			const selected = await providerScheduler.acquire(
				schedule.specs,
				this.name,
				schedule.mode,
				request.signal,
				() => {
					if (waiting) return;
					waiting = true;
					activity.record("queue", "所有可用后端均已达到并发上限(含其他 dsh 任务),等待空位");
				},
			);
			const target = selected.spec;
			activity.provider(target.name);
			activity.record("queue", target.name === this.name
				? `使用 ${target.name}(并发上限 ${target.maxConcurrency ?? 2})`
				: `已从 ${this.name} 转给 ${target.name}(并发上限 ${target.maxConcurrency ?? 2})`);
			try {
				return await runChain(target);
			} finally {
				selected.release();
			}
		};

		const result = settleRunResult({
			attempt,
			collectOutput: () => [],
			collectDiagnostic: () => lastDiagnostic,
			cancelled: () => cancelled,
			signal: request.signal,
			onAbort,
		});
		return subprocessRunHandle({
			id,
			result,
			signal: request.signal,
			onAbort,
			requestCancel: () => {
				cancelled = true;
				void currentRun?.dispose();
			},
			teardown: async () => {
				await currentRun?.dispose();
			},
		});
	}
}

/**
* 每个 CLI 的传输驱动。驱动负责构造 argv、把原始
* JSON 事件追踪到共享运行状态,并列出可用模型 id。完成信号是
* CLI 的 `result` 事件(qoder)或进程以 0 退出(opencode/pi)。
*/
const DRIVERS = {
	"qoder-json": {
		buildArgs(spec, model) {
			const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--permission-mode", spec.permissionMode];
			if (model) args.push("--model", model);
			if (spec.reasoningEffort && spec.reasoningEffort !== "auto") args.push("--reasoning-effort", spec.reasoningEffort);
			if (spec.contextWindow) args.push("--context-window", String(spec.contextWindow));
			args.push(...(spec.extraArgs ?? []));
			return args;
		},
		consume(event, sink) {
			sink.session(event.session_id);
			if (event.type === "result") {
				sink.credits({ total: typeof event.total_credits === "number" ? event.total_credits : 0, billable: sink.billable(), model: sink.modelName() });
				sink.result(typeof event.result === "string" ? event.result : "", event.is_error === true);
				return;
			}
			if (event.type === "assistant" && event.message?.usage) {
				const usage = event.message.usage;
				sink.usage({ billable: usage.billable, model: event.message.model });
			}
			if ((event.type === "assistant" || event.type === "user") && event.message?.content) {
				for (const block of event.message.content) {
					if (block.type === "text" && block.text) sink.text(block.text, event.type === "assistant");
					else if (block.type === "thinking" && block.thinking) sink.record("think", block.thinking);
					else if (block.type === "tool_use") sink.tool(block.name, block.input);
				}
			}
		},
		modelArgs: () => ["--list-models"],
		parseModels: (out) => out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== "MODEL"),
		usesResultEvent: true,
	},
	"codebuddy-json": {
		buildArgs(spec, model) {
			const modes = { bypass_permissions: "bypassPermissions", accept_edits: "acceptEdits", dont_ask: "dontAsk", auto: "auto", default: "default", plan: "plan" };
			const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--permission-mode", modes[spec.permissionMode] ?? "bypassPermissions"];
			if (model) args.push("--model", model);
			if (spec.reasoningEffort && spec.reasoningEffort !== "auto") args.push("--effort", spec.reasoningEffort);
			args.push(...(spec.extraArgs ?? []));
			return args;
		},
		consume(event, sink) {
			sink.session(event.session_id);
			if (event.type === "result") {
				if (typeof event.total_credits === "number") {
					sink.credits({ total: event.total_credits, billable: sink.billable(), model: sink.modelName() });
				} else if (typeof event.total_cost_usd === "number" && event.total_cost_usd > 0) {
					sink.cost(event.total_cost_usd);
				}
				sink.result(typeof event.result === "string" ? event.result : "", event.is_error === true);
				return;
			}
			if (event.type === "assistant" && event.message?.usage) {
				sink.usage({ billable: event.message.usage.billable, model: event.message.model });
			}
			if (event.type === "assistant" && event.message?.content) {
				for (const block of event.message.content) {
					if (block.type === "text" && block.text) sink.text(block.text, true);
					else if (block.type === "thinking" && block.thinking) sink.record("think", block.thinking);
					else if (block.type === "tool_use") sink.tool(block.name, block.input);
				}
			}
		},
		modelArgs: () => ["--help"],
		rates: codebuddyRates,
		parseModels: (out) => {
			const match = /Currently supported:\s*\(([^)]+)\)/.exec(out);
			return match ? match[1].split(",").map((model) => model.trim()).filter(Boolean) : [];
		},
		usesResultEvent: true,
	},
	"claude-json": {
		buildArgs(spec, model) {
			const modes = { accept_edits: "acceptEdits", auto: "auto", dont_ask: "dontAsk", plan: "plan", bypass_permissions: "bypassPermissions" };
			const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose"];
			if (modes[spec.permissionMode]) args.push("--permission-mode", modes[spec.permissionMode]);
			if (model) args.push("--model", model);
			const effort = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", ultracode: "max" }[spec.reasoningEffort];
			if (effort) args.push("--effort", effort);
			args.push(...(spec.extraArgs ?? []));
			return args;
		},
		consume(event, sink) {
			sink.session(event.session_id);
			if (event.type === "system" && event.subtype === "init") {
				if (event.model) sink.usage({ model: event.model });
				return;
			}
			if (event.type === "result") {
				if (typeof event.total_cost_usd === "number" && event.total_cost_usd > 0) sink.cost(event.total_cost_usd);
				const models = event.modelUsage ? Object.keys(event.modelUsage) : [];
				if (models.length > 0) sink.usage({ model: models[0] });
				sink.result(typeof event.result === "string" ? event.result : "", event.is_error === true);
				return;
			}
			if (event.type === "assistant" && event.message?.content) {
				if (event.message.model) sink.usage({ model: event.message.model });
				for (const block of event.message.content) {
					if (block.type === "text" && block.text) sink.text(block.text, true);
					else if (block.type === "thinking" && block.thinking) sink.record("think", block.thinking);
					else if (block.type === "tool_use") sink.tool(block.name, block.input);
				}
			}
		},
		models: claudeModels,
		usesResultEvent: true,
	},
	"codex-json": {
		buildArgs(spec, model) {
			const sandbox = { accept_edits: ["--approve-for-me"], auto: ["-s", "workspace-write"], dont_ask: ["-s", "workspace-write"], default: ["-s", "read-only"], plan: ["-s", "read-only"] };
			const access = spec.permissionMode === "bypass_permissions"
				? ["--dangerously-bypass-approvals-and-sandbox"]
				: sandbox[spec.permissionMode] ?? ["-s", "workspace-write"];
			const args = ["exec", "--json", "--skip-git-repo-check", "--color", "never", ...access];
			if (model) args.push("--model", model);
			const effort = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", ultracode: "ultra" }[spec.reasoningEffort];
			if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
			if (spec.contextWindow) args.push("-c", `model_context_window=${spec.contextWindow}`);
			args.push(...(spec.extraArgs ?? []));
			return args;
		},
		consume(event, sink) {
			if (event.type === "thread.started") {
				sink.session(event.thread_id);
				return;
			}
			if (event.type === "item.started") {
				const item = event.item ?? {};
				if (item.type === "command_execution") sink.tool("shell", { command: item.command ?? "" });
				else if (item.type === "mcp_tool_call") sink.tool(`${item.server ?? "mcp"}.${item.tool ?? "tool"}`, item.arguments);
				else if (item.type === "web_search") sink.tool("web_search", { pattern: item.query ?? "" });
				return;
			}
			if (event.type === "item.completed") {
				const item = event.item ?? {};
				if (item.type === "agent_message" && item.text) sink.text(item.text, true);
				else if (item.type === "reasoning" && item.text) sink.record("think", item.text);
				else if (item.type === "command_execution") {
					const output = String(item.aggregated_output ?? "").trim();
					sink.record("tool", `exit ${item.exit_code ?? "?"}${output ? `: ${output.slice(0, 500)}` : ""}`);
				} else if (item.type === "file_change") {
					const files = (item.changes ?? []).map((change) => change.path).filter(Boolean).join(", ");
					if (files) sink.record("tool", `file_change ${files}`);
				} else if (item.type === "todo_list") {
					const todos = (item.items ?? []).map((todo) => `${todo.completed ? "✔" : "·"} ${todo.text ?? ""}`).join("\n");
					if (todos) sink.record("todo", todos);
				} else if (item.type === "error" && item.message) {
					sink.record("error", item.message);
				}
				return;
			}
			if (event.type === "turn.completed") {
				const usage = event.usage;
				if (usage) sink.record("usage", `in ${usage.input_tokens ?? 0} / out ${usage.output_tokens ?? 0} tokens`);
				sink.result("", false);
				return;
			}
			if (event.type === "turn.failed") {
				sink.result(event.error?.message ?? event.message ?? "codex turn failed", true);
				return;
			}
			if (event.type === "error" && event.message) sink.record("error", event.message);
		},
		modelArgs: () => ["debug", "models"],
		parseModels: (out) => {
			try {
				const catalog = JSON.parse(out);
				return (catalog.models ?? []).filter((model) => model.visibility === "list").map((model) => model.slug).filter(Boolean);
			} catch {
				return [];
			}
		},
		usesResultEvent: true,
	},
	"opencode-json": {
		buildArgs(spec, model) {
			const args = ["run", "--standalone", "--auto", "--format", "json"];
			if (model) args.push("--model", model);
			args.push(...(spec.extraArgs ?? []));
			return args;
		},
		consume(event, sink) {
			sink.session(event.sessionID);
			const part = event.part ?? {};
			if (event.type === "text" && part.text) sink.text(part.text, true);
			else if (event.type === "reasoning" && part.text) sink.record("think", part.text);
			else if (event.type === "tool_use") sink.tool(part.tool ?? part.name ?? "tool", part.state?.input ?? part.input ?? part.args);
			else if (event.type === "error") sink.record("error", part.message ?? part.error ?? JSON.stringify(part).slice(0, 300));
			else if (event.type === "step_finish" && part.cost) sink.cost(part.cost);
		},
		modelArgs: () => ["models"],
		parseModels: (out) => out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/\s/.test(line)),
		usesResultEvent: false,
	},
	"pi-json": {
		buildArgs(spec, model) {
			const args = ["-p", "--mode", "json"];
			if (model) args.push("--model", model);
			if (spec.reasoningEffort && spec.reasoningEffort !== "auto") args.push("--thinking", spec.reasoningEffort);
			args.push(...(spec.extraArgs ?? []));
			return args;
		},
		consume(event, sink) {
			// pi 的事件没有顶层 id（会话 id 由 CLI 自己管），只在真有 id 时才上报。
			if (typeof event?.id === "string" && event.id) sink.session(event.id);
			if (event.message?.role === "assistant" && typeof event.message.model === "string") {
				// pi 在每条助手消息上带 provider + model(可能是 magpie 组名),用它显示真实调用的模型。
				sink.usage({ model: event.message.provider ? `${event.message.provider}/${event.message.model}` : event.message.model });
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const message = event.message;
				for (const block of message.content ?? []) {
					if (block.type === "text" && block.text) sink.text(block.text, true);
					else if (block.type === "thinking" && block.thinking) sink.record("think", block.thinking);
					else if (block.type === "toolCall") sink.tool(block.name, block.arguments);
				}
				if (typeof message.usage?.cost?.total === "number" && message.usage.cost.total > 0) sink.cost(message.usage.cost.total);
			} else if (event.type === "tool_execution_start") {
				sink.tool(event.toolName, event.args);
			} else if (event.type === "agent_settled") {
				sink.result("", event.aborted === true);
			}
		},
		modelArgs: () => ["--list-models"],
		parseModels: (out) => out.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).filter((cells) => cells.length >= 2).map((cells) => `${cells[0]}/${cells[1]}`),
		usesResultEvent: false,
	},
};

/** 解析某个驱动的启动命令(pi/codebuddy 通过 node 启动;.cmd 通过 cmd.exe)。 */
function spawnCommand(driverName, spec) {
	if (spec.binary && /\.(cmd|bat)$/i.test(spec.binary)) {
		return { command: process.env.ComSpec || "cmd.exe", prefix: ["/c", spec.binary] };
	}
	if (driverName === "pi-json" && spec.binary && spec.binary.endsWith(".js")) {
		if (/[\\/]pi-launcher\.js$/i.test(spec.binary)) return { command: process.execPath, prefix: [spec.binary] };
		return {
			command: process.execPath,
			prefix: [spec.binary],
			env: { PI_MANAGED_INSTALL_ROOT: piInstallRoot() },
		};
	}
	if (driverName === "pi-json" && spec.binary) {
		const launcher = spec.binary.replace(/([\\/])pi$/, "$1pi-launcher.js");
		if (launcher !== spec.binary) return { command: process.execPath, prefix: [launcher] };
	}
	if (driverName === "codebuddy-json" && spec.binary && !/\.exe$/i.test(spec.binary)) {
		return { command: process.execPath, prefix: [spec.binary] };
	}
	return { command: spec.binary, prefix: [] };
}

/** 按 Windows 命令行规则给单个参数加引号。 */
function quoteWindowsArg(arg) {
	if (!arg) return '""';
	if (!/[\s"]/u.test(arg)) return arg;
	return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** 把请求提示词中的文本块拼接成单条 stdin 内容。 */
function promptText(blocks) {
	return blocks
		.map((block) => (block && block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

//#region 活动账本(聊天工具行的实时进度)
const MAX_RUNS = 24;
const MAX_EVENTS = 200;
const MAX_EVENT_TEXT = 1500;

/**
* 有界的近期子运行内存账本,记录解析后的 CLI 事件。
* 浏览器工具视图按运行 id 轮询(该 uuid 由 `start()` 生成,
* 委派工具会在 `started subagent <id>` 中回显),`sub_agent_status`
* 工具则把它提供给父 agent,让委派出去的子代理读起来像
* 本地子任务:实时状态、可展开的转录和可查询的进度日志。
*/
class ActivityLedger {
	runs = [];
	begin(meta) {
		const entry = { ...meta, sessionId: null, startedAt: Date.now(), endedAt: null, status: "running", events: [] };
		this.runs.unshift(entry);
		if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
		return {
			record(kind, text) {
				if (entry.events.length >= MAX_EVENTS) entry.events.shift();
				entry.events.push({ t: Date.now(), kind, text: String(text ?? "").slice(0, MAX_EVENT_TEXT) });
			},
			meta(key, value) {
				if (value != null && entry[key] == null) entry[key] = value;
			},
			/** 无条件覆盖元数据:派发时先写意图模型,CLI 报出实际模型后再盖掉。 */
			override(key, value) {
				if (value != null) entry[key] = value;
			},
			provider(name) {
				if (name) entry.provider = name;
			},
			finish(status, summary) {
				if (entry.status !== "running") return;
				entry.status = status;
				entry.endedAt = Date.now();
				if (summary) this.record("result", summary);
			},
			snapshot() {
				return { status: entry.status, sessionId: entry.sessionId, credits: entry.credits, costUsd: entry.costUsd, startedAt: entry.startedAt, model: entry.model };
			},
		};
	}
	view(id) {
		const run = this.runs.find((candidate) => candidate.id === id);
		if (!run) return null;
		return { ...run, eventCount: run.events.length, events: run.events.slice() };
	}
	recent(limit) {
		return this.runs.slice(0, limit).map((run) => ({ ...run, eventCount: run.events.length, events: run.events.slice(-12) }));
	}
		snapshot(limit = MAX_RUNS) {
		const now = Date.now();
		const runs = this.runs.slice(0, limit).map((run) => {
			const last = run.events[run.events.length - 1];
			const running = run.status === "running";
			const idleMs = now - (last?.t ?? run.startedAt ?? now);
			const stallWarn = run.stallWarnSeconds ?? 90;
			return {
				id: run.id, provider: run.provider ?? "", driver: run.driver ?? "",
				label: run.label ?? "", parentId: run.parentId ?? null,
				status: run.status, startedAt: run.startedAt ?? null, endedAt: run.endedAt ?? null,
				restored: run.restored === true,
				model: run.model ?? null, effort: run.effort ?? null, credits: run.credits ?? null,
				costUsd: typeof run.costUsd === "number" ? run.costUsd : null,
				sessionId: run.sessionId ?? null, eventCount: run.events.length,
				lastEvent: last ? { kind: last.kind, text: String(last.text ?? "").slice(0, 300), t: last.t } : null,
				idleSeconds: running ? Math.max(0, Math.round(idleMs / 1000)) : 0,
				stalled: running && stallWarn > 0 && idleMs >= stallWarn * 1000,
				prompt: String(run.prompt ?? "").slice(0, 200),
			};
		});
		const count = (status) => this.runs.filter((run) => run.status === status).length;
		const stats = {
			total: this.runs.length,
			running: count("running"),
			completed: count("completed"),
			error: count("error"),
			aborted: count("aborted"),
			costUsd: this.runs.reduce((sum, run) => sum + (typeof run.costUsd === "number" ? run.costUsd : 0), 0),
		};
		return { runs, stats, now };
	}
	/** 接管一条持久化运行(同 id 会替换内存中的副本)。 */
	adopt(meta) {
		const entry = { events: [], sessionId: null, endedAt: null, ...meta, restored: true };
		const at = this.runs.findIndex((run) => run.id === entry.id);
		if (at >= 0) this.runs.splice(at, 1);
		this.runs.push(entry);
		this.runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
		if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
		return entry;
	}
}
const activityLedger = new ActivityLedger();
//#endregion

//#region 持久化(崩溃后可恢复的运行)
const DSH_DATA_ROOT = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const RUNS_DIR = join(DSH_DATA_ROOT, "storages", "dsh-cli-hub", "runs");
// 改名前的旧目录（dsh-cli-subagent / 更早的 dsh-subagent）：首次启动时把运行索引搬过来，历史不丢。
const LEGACY_RUNS_DIRS = ["dsh-cli-subagent", "dsh-subagent"].map((name) => join(DSH_DATA_ROOT, "storages", name, "runs"));
const INDEX_PATH = join(RUNS_DIR, "index.json");
const HIDDEN_RUNNER = fileURLToPath(new URL("./hidden-runner.cjs", import.meta.url));

function runPromptPath(id) {
	return join(RUNS_DIR, `${id}.prompt.txt`);
}
function runConfigPath(id) {
	return join(RUNS_DIR, `${id}.hide.json`);
}
function runRunnerErrPath(id) {
	return join(RUNS_DIR, `${id}.runner.err.log`);
}
function cleanupRunFiles(id) {
	try { rmSync(runPromptPath(id), { force: true }); } catch {}
	try { rmSync(runConfigPath(id), { force: true }); } catch {}
}

function ensureRunsDir() {
	try {
		// 老版本的目录（dsh-cli-subagent / dsh-subagent）：新目录还没有时把旧文件搬过来（只搬一次）。
		if (!existsSync(RUNS_DIR)) {
			for (const legacy of LEGACY_RUNS_DIRS) {
				if (!existsSync(legacy)) continue;
				mkdirSync(RUNS_DIR, { recursive: true });
				for (const entry of readdirSync(legacy)) {
					try {
						writeFileSync(join(RUNS_DIR, entry), readFileSync(join(legacy, entry)));
					} catch {}
				}
				break;
			}
		}
	} catch {}
	try {
		mkdirSync(RUNS_DIR, { recursive: true });
	} catch {}
}
function readRunIndex() {
	try {
		const data = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}
function writeRunIndex(runs) {
	try {
		ensureRunsDir();
		const tmp = `${INDEX_PATH}.tmp`;
		writeFileSync(tmp, JSON.stringify(runs.slice(0, MAX_RUNS), null, 1));
		renameSync(tmp, INDEX_PATH);
	} catch {}
}
function upsertRunIndex(meta) {
	const runs = readRunIndex();
	const at = runs.findIndex((run) => run?.id === meta.id);
	if (at >= 0) runs[at] = { ...runs[at], ...meta };
	else runs.unshift(meta);
	writeRunIndex(runs);
}
function runLogPath(id) {
	return join(RUNS_DIR, `${id}.jsonl`);
}
function runErrPath(id) {
	return join(RUNS_DIR, `${id}.err.log`);
}
/** 读取文件自 `offset` 起新增的字节;返回文本和新偏移量。 */
function readAppended(path, offset) {
	let fd;
	try {
		fd = openSync(path, "r");
	} catch {
		return { text: "", offset };
	}
	try {
		const size = fstatSync(fd).size;
		if (size <= offset) return { text: "", offset };
		const buffer = Buffer.alloc(size - offset);
		readSync(fd, buffer, 0, buffer.length, offset);
		return { text: buffer.toString("utf8"), offset: size };
	} catch {
		return { text: "", offset };
	} finally {
		closeSync(fd);
	}
}
/** 文件末尾若干字节,用于诊断。 */
function readTail(path, max = 4096) {
	try {
		const text = readFileSync(path, "utf8");
		return text.slice(-max);
	} catch {
		return "";
	}
}
function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 把一条运行的持久化日志折叠进账本条目;返回新的字节偏移量。 */
function foldRunLog(meta, entry, offset, final = false) {
	const driver = DRIVERS[meta.driver];
	if (!driver) return offset;
	const { text, offset: next } = readAppended(meta.logPath ?? runLogPath(meta.id), offset);
	if (!text) return next;
	const lastNewline = text.lastIndexOf("\n");
	if (lastNewline < 0 && !final) return offset;
	const complete = lastNewline >= 0 ? text.slice(0, final ? text.length : lastNewline) : text;
	const consumed = final ? next : offset + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
	const sink = {
		record: (kind, value) => {
			entry.events.push({ t: Date.now(), kind, text: String(value ?? "").slice(0, MAX_EVENT_TEXT) });
			if (entry.events.length > MAX_EVENTS) entry.events.shift();
		},
		text: (value) => sink.record("text", value),
		tool: (name, input) => {
			const detail = typeof input?.command === "string" ? input.command : input?.file_path ?? input?.path ?? input?.pattern ?? "";
			sink.record("tool", `${name ?? "tool"} ${detail}`.trim());
		},
		session: (sessionId) => {
			if (sessionId && entry.sessionId == null) entry.sessionId = sessionId;
		},
		usage: (usage) => {
			if (typeof usage?.billable === "boolean") entry.billable = usage.billable;
			if (typeof usage?.model === "string") entry.model = usage.model;
		},
		billable: () => entry.billable,
		modelName: () => entry.model,
		credits: (credits) => {
			entry.credits = credits;
		},
		cost: (usd) => {
			entry.costUsd = usd;
		},
		result: (value, isError) => {
			entry.status = isError ? "error" : "completed";
			entry.endedAt = Date.now();
			if (value) sink.record("result", value);
		},
	};
	let buffer = "";
	for (const line of complete.split("\n")) {
		buffer = line.trim();
		if (!buffer) continue;
		try {
			driver.consume(JSON.parse(buffer), sink);
		} catch {}
	}
	return consumed;
}

/** 为主机停机或重启期间完成的运行生成提示文本。 */
function lateNoticeText(meta, entry) {
	const closing = [...entry.events].reverse().find((event) => event.kind === "result")?.text ?? "";
	const body = closing ? `
结果:
${closing.slice(0, 1500)}` : "";
	return `后台子代理 ${meta.provider} 已结束(dsh 重启前发起,CLI 未中断,状态:${entry.status})。运行 id: ${meta.id}。${body}
调用 sub_agent_status 可查看完整过程。`;
}

/**
* 重新接管上一个宿主进程持久化的运行:重建转录,
* 继续跟踪仍在运行的运行(其 CLI 在崩溃中存活),并在父 agent
* 恢复在线后补发完成通知。
*/
function resumePersistedRuns(ctx) {
	const getAgent = (id) => ctx.get("agents")?.get?.(id);
	const index = readRunIndex();
	for (const meta of index) {
		if (!meta?.id) continue;
		const entry = activityLedger.adopt(meta);
		let offset = foldRunLog(meta, entry, 0);
		if (entry.status === "running" && !pidAlive(meta.pid)) {
			// CLI 可能在宿主停机期间已经完成:先折叠日志尾部,
			// 只有仍未收敛的运行才判定为失败。
			offset = foldRunLog(meta, entry, offset, true);
			if (entry.status === "running") {
				entry.status = "error";
				entry.endedAt = Date.now();
			}
			upsertRunIndex({ id: meta.id, status: entry.status, endedAt: entry.endedAt ?? Date.now(), pid: null });
		}
		if (entry.status !== "running") {
			cleanupRunFiles(meta.id);
			upsertRunIndex({ id: meta.id, status: entry.status, endedAt: entry.endedAt ?? Date.now(), sessionId: entry.sessionId, credits: entry.credits, costUsd: entry.costUsd, pid: null });
			if (!meta.notified) {
				const agent = getAgent(meta.parentId);
				if (agent && typeof agent.followup === "function") {
					try {
						agent.followup(createUserMessage({
							content: [{ type: "text", text: lateNoticeText(meta, entry) }],
							source: { kind: "subagent-settled", form: "notice", summary: boundContextSummary(`重启前发起的子代理已结束`), senderSessionId: meta.id },
						}));
						upsertRunIndex({ id: meta.id, notified: true });
					} catch {}
				}
			}
			continue;
		}
		const releaseSlot = providerGate.reserve(meta.provider ?? "unknown");
		ctx.effect(() => {
			let deadTicks = 0;
			const timer = setInterval(() => {
				offset = foldRunLog(meta, entry, offset);
				if (entry.status === "running" && !pidAlive(meta.pid)) {
					deadTicks += 1;
					if (deadTicks >= 20) {
						offset = foldRunLog(meta, entry, offset, true);
						if (entry.status === "running") {
							entry.status = "error";
							entry.endedAt = Date.now();
						}
					}
				} else if (entry.status === "running") {
					deadTicks = 0;
				}
				if (entry.status === "running") return;
				clearInterval(timer);
				releaseSlot();
				cleanupRunFiles(meta.id);
				upsertRunIndex({ id: meta.id, status: entry.status, endedAt: entry.endedAt, sessionId: entry.sessionId, credits: entry.credits, costUsd: entry.costUsd, pid: null });
				const agent = getAgent(meta.parentId);
				if (agent && typeof agent.followup === "function") {
					try {
						agent.followup(createUserMessage({
							content: [{ type: "text", text: lateNoticeText(meta, entry) }],
							source: { kind: "subagent-settled", form: "notice", summary: boundContextSummary(`重启前发起的子代理已结束`), senderSessionId: meta.id },
						}));
						upsertRunIndex({ id: meta.id, notified: true });
					} catch {}
				}
			}, 500);
			return () => {
				clearInterval(timer);
				releaseSlot();
			};
		});
	}
}
//#endregion

/**
* 拥有一个已启动的 CLI 子进程及其生命周期:按行缓冲解析 stdout、
* 取消/超时清理,以及结果收敛。与提供方分离,
* 保证多次启动彼此独立。
*/
class QoderJsonRun {
	#child;
	#signal;
	#timeoutMs;
	#stdoutBuf = "";
	#assistantText = [];
	#resultEvent;
	#spawnError;
	#exitInfo;
	#timedOut = false;
	#cancelled = false;
	#settledText = "";
	#timeoutTimer;
	#onAbort;
	#id;
	#activity;
	#credits = { total: undefined, billable: undefined, model: undefined };
	#parentAgent;
	#stallWarnSeconds;
	#lastEventAt;
	#stallWarned = false;
	#stallTimer;
	#warnAfterFirstEvent;
	#gotFirstEvent = false;
	#firstEventResolve;
	#firstEventPromise;
	#driver;
	#costUsd;
	#logPath;
	#errPath;
	#logOffset = 0;
	#tailTimer;
	#promptPath;
	#configPath;
	#runnerErrPath;
	#meta;

	constructor(opts) {
		this.#id = opts.id;
		this.#activity = opts.activity;
		this.#driver = opts.driver;
		this.#parentAgent = opts.parentAgent;
		this.#stallWarnSeconds = opts.stallWarnSeconds ?? 0;
		this.#warnAfterFirstEvent = opts.warnAfterFirstEvent === true;
		this.#firstEventPromise = new Promise((resolve) => {
			this.#firstEventResolve = resolve;
		});
		this.#lastEventAt = Date.now();
		this.#signal = opts.signal;
		this.#timeoutMs = opts.timeoutMs;
		// 输出持久化:子进程直接写文件并以 detached 方式运行,
		// 因此 dsh 崩溃既不会中断其 stdout,也不会丢失转录;宿主
		// 跟踪日志,并在重启后继续跟踪。
		ensureRunsDir();
		this.#logPath = runLogPath(this.#id);
		this.#errPath = runErrPath(this.#id);
		const useHiddenRunner = platform === "win32" && existsSync(HIDDEN_RUNNER);
		if (useHiddenRunner) {
			// Windows 下经隐藏控制台包装启动:detached 保证崩溃后存活,
			// 隐藏控制台避免 CLI 的 shell 子进程闪出黑框。
			this.#promptPath = runPromptPath(this.#id);
			this.#configPath = runConfigPath(this.#id);
			this.#runnerErrPath = runRunnerErrPath(this.#id);
			writeFileSync(this.#promptPath, opts.prompt);
			writeFileSync(this.#configPath, JSON.stringify({
				File: opts.command,
				Arguments: opts.args.map(quoteWindowsArg).join(" "),
				Stdin: this.#promptPath,
				Stdout: this.#logPath,
				Stderr: this.#errPath,
				Env: opts.env ?? {},
			}));
			this.#child = spawn(process.execPath, [HIDDEN_RUNNER, this.#configPath, this.#runnerErrPath], {
				cwd: opts.cwd,
				stdio: "ignore",
				windowsHide: true,
				detached: true,
			});
		} else {
			const outFd = openSync(this.#logPath, "a");
			const errFd = openSync(this.#errPath, "a");
			try {
				this.#child = spawn(opts.command, opts.args, {
					cwd: opts.cwd,
					stdio: ["pipe", outFd, errFd],
					windowsHide: true,
					detached: true,
					...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
				});
			} finally {
				closeSync(outFd);
				closeSync(errFd);
			}
			this.#child.stdin.on("error", () => {});
			this.#child.stdin.write(opts.prompt);
			this.#child.stdin.end();
		}
		this.#child.unref();
		this.#meta = {
			id: this.#id,
			provider: opts.provider ?? "",
			driver: opts.driverName ?? "",
			label: opts.label ?? "",
			prompt: opts.promptSummary ?? "",
			parentId: opts.parentId ?? "",
			pid: this.#child.pid ?? null,
			startedAt: Date.now(),
			status: "running",
			logPath: this.#logPath,
		};
		upsertRunIndex(this.#meta);
		this.#tailTimer = setInterval(() => this.#drainLog(), 250);
		this.#child.on("error", (error) => {
			this.#spawnError = error;
			this.#activity?.finish("error", `spawn failed: ${error?.message ?? error}`);
		});
		this.#child.on("close", (code, signal) => {
			this.#exitInfo = { code, signal };
			this.#drainLog(true);
			clearInterval(this.#stallTimer);
			if (code !== 0 && !this.#resultEvent) this.#activity?.finish("error", `CLI exited with code ${code}`);
			this.#persistFinish();
		});
		if (this.#stallWarnSeconds > 0) {
			this.#stallTimer = setInterval(() => this.#checkStall(), Math.min(15000, Math.max(2000, this.#stallWarnSeconds * 500)));
		}
		if (this.#timeoutMs > 0) {
			this.#timeoutTimer = setTimeout(() => {
				this.#timedOut = true;
				this.#activity?.record("error", `timed out after ${this.#timeoutMs / 1000}s`);
				this.#killTree();
			}, this.#timeoutMs);
		}
		this.#onAbort = () => {
			this.#cancelled = true;
			this.#activity?.finish("aborted");
			this.#killTree();
		};
		this.#signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	/**
	* 停止本次尝试并等待进程退出。幂等;供
	* 回退链清理从未发布句柄的尝试。
	*/
	async dispose() {
		this.#cancelled = true;
		if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
		clearInterval(this.#stallTimer);
		clearInterval(this.#tailTimer);
		this.#signal.removeEventListener("abort", this.#onAbort);
		this.#killTree();
		await this.#waitForExit();
	}

	/**
	* 在解析到第一个 CLI 事件时完成,让模型回退链
	* 无需读取转录就能区分排队/卡住的模型与已接受的模型。
	*/
	get firstEvent() {
		return this.#firstEventPromise;
	}

	handle() {
		const result = settleRunResult({
			attempt: () => this.#attempt(),
			collectOutput: () => this.#collectOutput(),
			collectDiagnostic: () => this.#collectDiagnostic(),
			cancelled: () => this.#cancelled,
			signal: this.#signal,
			onAbort: this.#onAbort,
		});
		return subprocessRunHandle({
			id: this.#id,
			result,
			signal: this.#signal,
			onAbort: this.#onAbort,
			requestCancel: () => {
				this.#cancelled = true;
				this.#activity?.finish("aborted");
				this.#killTree();
			},
			teardown: () => this.#waitForExit(),
		});
	}

	/** 读取新追加的日志字节,把完整的 JSON 行折叠进状态。 */
	#drainLog(final = false) {
		const { text, offset } = readAppended(this.#logPath, this.#logOffset);
		if (!text) return;
		this.#logOffset = offset;
		this.#stdoutBuf += text;
		let newline;
		while ((newline = this.#stdoutBuf.indexOf("\n")) >= 0) {
			const line = this.#stdoutBuf.slice(0, newline).trim();
			this.#stdoutBuf = this.#stdoutBuf.slice(newline + 1);
			if (line) this.#consumeEvent(line);
		}
		if (final && this.#stdoutBuf.trim()) {
			const line = this.#stdoutBuf.trim();
			this.#stdoutBuf = "";
			this.#consumeEvent(line);
		}
	}

	/** 持久化本次运行的终态。 */
	#persistFinish() {
		clearInterval(this.#tailTimer);
		cleanupRunFiles(this.#id);
		const state = this.#activity?.snapshot?.() ?? {};
		let status = state.status ?? "completed";
		// 进程已退出但活动账本尚未收敛时在这里补终态,
		// 避免无 result 事件的驱动把索引永久留在 running。
		if (status === "running") {
			if (this.#driver.usesResultEvent) status = "error";
			else if (!this.#timedOut && this.#exitInfo?.code === 0) {
				this.#activity?.finish("completed", this.#assistantText.at(-1) || undefined);
				status = "completed";
			} else {
				status = "error";
			}
		}
		upsertRunIndex({
			id: this.#id,
			status,
			endedAt: Date.now(),
			sessionId: state.sessionId ?? null,
			credits: state.credits ?? null,
			costUsd: this.#costUsd ?? null,
			model: this.#credits.model ?? null,
			pid: null,
		});
	}

	#consumeEvent(line) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		// 空行、null 或非对象行不算事件：驱动各自按自己的格式解析，这里只挡住明显无效的行。
		if (!event || typeof event !== "object") return;
		this.#lastEventAt = Date.now();
		this.#stallWarned = false;
		if (!this.#gotFirstEvent) {
			this.#gotFirstEvent = true;
			this.#firstEventResolve?.();
		}
		const sink = {
			record: (kind, text) => this.#activity?.record(kind, text),
			text: (text, assistant) => {
				if (assistant) this.#assistantText.push(text);
				this.#activity?.record("text", text);
			},
			tool: (name, input) => {
				const detail = typeof input?.command === "string" ? input.command : input?.file_path ?? input?.path ?? input?.pattern ?? "";
				this.#activity?.record("tool", `${name ?? "tool"} ${detail}`.trim());
			},
			session: (sessionId) => this.#activity?.meta("sessionId", sessionId),
			usage: (usage) => {
				if (typeof usage?.billable === "boolean") this.#credits.billable = usage.billable;
				if (typeof usage?.model === "string") { this.#credits.model = usage.model; (this.#activity?.override ?? this.#activity?.meta)?.call(this.#activity, "model", usage.model); }
			},
			billable: () => this.#credits.billable,
			modelName: () => this.#credits.model,
			credits: (credits) => this.#activity?.meta("credits", credits),
			cost: (usd) => {
				this.#costUsd = usd;
				this.#activity?.meta("costUsd", usd);
			},
			result: (text, isError) => {
				this.#resultEvent = { text, isError };
				this.#settledText = text;
				this.#activity?.finish(isError ? "error" : "completed", text || (!isError ? this.#assistantText.at(-1) : undefined) || undefined);
			},
		};
		this.#driver.consume(event, sink);
	}

	/**
	* CLI 长时间无输出时,每个静默周期只唤醒父 agent 一次
	* (进程挂起、模型排队、网络中断)。父 agent 随后可以
	* 查询 sub_agent_status、继续等待或中断,而不是盲目挂着。
	*/
	#checkStall() {
		if (this.#stallWarned || this.#exitInfo || this.#cancelled) return;
		if (this.#warnAfterFirstEvent && !this.#gotFirstEvent) return;
		const idleSeconds = Math.round((Date.now() - this.#lastEventAt) / 1000);
		if (idleSeconds < this.#stallWarnSeconds) return;
		this.#stallWarned = true;
		this.#activity?.record("error", `no output for ${idleSeconds}s — warned the parent`);
		const agent = this.#parentAgent;
		if (!agent || typeof agent.followup !== "function") return;
		try {
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: `⚠️ 子代理已 ${idleSeconds} 秒没有任何输出(可能卡住、网络不通或模型排队)。运行 id: ${this.#id}。你可以调用 sub_agent_status 查看详情并决定继续等待或中断。`,
				}],
				source: {
					kind: "subagent-settled",
					form: "notice",
					summary: boundContextSummary(`子代理无输出 ${idleSeconds} 秒`),
					senderSessionId: this.#id,
				},
			}));
		} catch {}
	}

	/** 等待子进程收敛,再把转录映射为结果。 */
	async #attempt() {
		try {
			await this.#waitForExit();
			if (this.#spawnError) throw this.#spawnError;
			if (this.#resultEvent) {
				if (this.#resultEvent.isError) {
					return {
						output: this.#collectOutput(),
						diagnostic: this.#resultDiagnostic(),
						stopReason: "error",
					};
				}
				return { output: this.#collectOutput(), stopReason: "completed" };
			}
			// 没有终止 result 事件的驱动(opencode/pi)以进程退出作为收敛信号。
			const exitCode = this.#exitInfo?.code;
			if (!this.#driver.usesResultEvent && !this.#timedOut && exitCode === 0) {
				this.#activity?.finish("completed", this.#assistantText.at(-1) || undefined);
				return { output: this.#collectOutput(), stopReason: "completed" };
			}
			if (this.#timedOut) throw new Error(`timed out after ${this.#timeoutMs / 1000}s`);
			throw new Error(
				`CLI exited (code=${exitCode} signal=${this.#exitInfo?.signal}) without a result event`,
			);
		} finally {
			if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
		}
	}

	#collectOutput() {
		const text = this.#settledText || this.#assistantText.join("");
		return text ? [{ type: "text", text }] : [];
	}

	#collectDiagnostic() {
		const runnerErr = this.#runnerErrPath ? readTail(this.#runnerErrPath, 2048) : "";
		const pieces = [readTail(this.#errPath), runnerErr, this.#exitInfo && `exit code=${this.#exitInfo.code} signal=${this.#exitInfo.signal}`].filter(Boolean);
		return pieces.join("\n") || undefined;
	}

	#resultDiagnostic() {
		const subtype = this.#resultEvent?.subtype ?? "error";
		const errors = Array.isArray(this.#resultEvent?.errors) ? this.#resultEvent.errors.join("; ") : "";
		const result = this.#settledText;
		return [subtype, result, errors, readTail(this.#errPath)].filter(Boolean).join(" — ");
	}

	#waitForExit() {
		if (this.#exitInfo) return Promise.resolve();
		return new Promise((resolve) => this.#child.once("close", resolve));
	}

	#killTree() {
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		if (platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(this.#child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => this.#child.kill("SIGKILL"));
			return;
		}
		try {
			this.#child.kill("SIGKILL");
		} catch {}
	}
}
//#endregion

//#region 探测(设置页 RPC)
/**
* 读取 CodeBuddy CLI 自己缓存的模型目录(`~/.codebuddy/local_storage/entry_*.info`),
* 返回模型 id → 额度倍率。该文件由 CLI 在登录后同步,取修改时间最新且
* 含模型列表的一份;读不到就返回空,设置页不显示倍率。
*/
function codebuddyRates() {
	const dir = join(homedir(), ".codebuddy", "local_storage");
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return {};
	}
	let newest = null;
	for (const entry of entries) {
		if (!entry.endsWith(".info")) continue;
		const file = join(dir, entry);
		try {
			const models = JSON.parse(readFileSync(file, "utf8"))?.[0]?.data?.models;
			if (!Array.isArray(models) || models.length === 0) continue;
			const mtime = statSync(file).mtimeMs;
			if (!newest || mtime > newest.mtime) newest = { mtime, models };
		} catch {}
	}
	const rates = {};
	for (const model of newest?.models ?? []) {
		const id = String(model?.id ?? "");
		const match = /x([0-9]+(?:\.[0-9]+)?)\s*credits/.exec(String(model?.credits ?? ""));
		if (id && match) rates[id] = `${match[1]}x`;
	}
	return rates;
}
const PROBE_TTL_MS = 5 * 60 * 1000;
const probeCache = new Map();
const LATEST_TTL_MS = 10 * 60 * 1000;
const latestCache = new Map();
/** 可自动更新的后端:更新命令。 */
const UPDATE_ARGS = {
	qoder: ["update"],
	qodercn: ["update"],
	opencode: ["upgrade"],
	pi: ["update"],
	codebuddy: ["update"],
	codex: ["update"],
	claude: ["update"],
};
/** 从 npm 查询最新版的后端。 */
const NPM_PACKAGES = {
	codex: "@openai/codex",
	claude: "@anthropic-ai/claude-code",
	codebuddy: "@tencent-ai/codebuddy-code",
	pi: "@earendil-works/pi-coding-agent",
};

/** 运行一次短命的 CLI 查询,并以去除首尾空白的 stdout 完成。 */
function runCli(binary, args, timeoutMs = 30000, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(env ? { env } : {}) });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timed out: ${args.join(" ")}`));
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr.trim() || `exit code ${code}`));
		});
	});
}

function parseVersionParts(value) {
	const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? "").replace(/^v/i, "").trim());
	if (!match) return null;
	return { numbers: match[1].split(".").map(Number), prerelease: match[2] ?? "" };
}
function compareVersions(a, b) {
	const left = parseVersionParts(a);
	const right = parseVersionParts(b);
	if (!left || !right) return 0;
	const length = Math.max(left.numbers.length, right.numbers.length);
	for (let i = 0; i < length; i += 1) {
		const x = left.numbers[i] ?? 0;
		const y = right.numbers[i] ?? 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease > right.prerelease ? 1 : -1;
}
/** 查询后端最新版本:Qoder 用 update --check,其余支持的后端查 npm。 */
async function latestVersionFor(spec) {
	const hit = latestCache.get(spec.name);
	if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.value;
	let latest = null;
	try {
		if (spec.name === "qoder" || spec.name === "qodercn") {
			const spawnSpec = spawnCommand(spec.driver, spec);
			const env = spawnSpec.env ? { ...process.env, ...spawnSpec.env } : undefined;
			const output = await runCli(spawnSpec.command, [...spawnSpec.prefix, "update", "--check"], 20000, env);
			const versions = [...String(output).matchAll(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)].map((match) => match[1]);
			latest = versions.at(-1) ?? null;
		} else if (NPM_PACKAGES[spec.name]) {
			const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGES[spec.name]}/latest`, { signal: AbortSignal.timeout(6000) });
			if (response.ok) {
				const data = await response.json();
				if (typeof data?.version === "string") latest = data.version;
			}
		}
	} catch {}
	latestCache.set(spec.name, { at: Date.now(), value: latest });
	return latest;
}

/** 某个后端的存在性、版本和模型目录,带 TTL 缓存。 */
async function probeBackend(spec) {
	const hit = probeCache.get(spec.name);
	if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
	const driver = DRIVERS[spec.driver] ?? DRIVERS["qoder-json"];
	const rates = typeof driver.rates === "function" ? driver.rates() : undefined;
	const value = { name: spec.name, driver: spec.driver, binary: spec.binary ?? null, exists: false, version: null, latestVersion: null, updateAvailable: false, models: [], rates, error: null };
	if (!spec.binary || !existsSync(spec.binary)) {
		value.error = "CLI binary not found. Install the CLI or set a binary path.";
	} else {
		try {
			const spawnSpec = spawnCommand(spec.driver, spec);
			const run = (args) => runCli(spawnSpec.command, [...spawnSpec.prefix, ...args], 30000, spawnSpec.env ? { ...process.env, ...spawnSpec.env } : undefined);
			const rawVersion = (await run(["--version"])).trim().split(/\r?\n/)[0];
			value.version = (/(\d+\.\d+\.\d+[\w.-]*)/.exec(rawVersion) ?? [rawVersion])[0];
			value.models = typeof driver.models === "function" ? driver.models() : driver.parseModels(await run(driver.modelArgs()));
			value.exists = true;
			value.latestVersion = await latestVersionFor(spec);
			value.updateAvailable = Boolean(value.latestVersion && value.version && compareVersions(value.latestVersion, value.version) > 0);
		} catch (error) {
			value.error = String(error?.message ?? error).slice(0, 512);
		}
	}
	probeCache.set(spec.name, { at: Date.now(), value });
	return value;
}

/** 调用后端自带的更新命令,成功后重新探测版本。 */
async function updateBackend(spec, registry) {
	if (providerGate.active(spec.name) > 0) throw new Error("该后端还有运行中的子代理,请等它们结束后再更新");
	const args = UPDATE_ARGS[spec.name];
	if (!args) throw new Error("该后端不支持自动更新");
	const spawnSpec = spawnCommand(spec.driver, spec);
	const env = spawnSpec.env ? { ...process.env, ...spawnSpec.env } : undefined;
	try {
		await runCli(spawnSpec.command, [...spawnSpec.prefix, ...args], 180000, env);
	} catch (error) {
		throw new Error(`CLI 更新失败: ${String(error?.message ?? error).slice(0, 300)}`);
	}
	probeCache.delete(spec.name);
	latestCache.delete(spec.name);
	const nextSpec = registry.get(spec.name) ?? builtinSpec(spec.name) ?? spec;
	return probeBackend(nextSpec);
}

/**
* 通过 Codex 订阅插件所用的同一条已认证 /api 桥提供设置页接口:
* 每个端点一个 POST 路由,使用 `{type,rpcId,result}`
* 信封。无凭据宿主(headless)中不存在,设置页也无意义。
*/
//#region 内置子代理观测
/** 子代理时序投影的最近一次读数:子会话被拆掉后,耗时仍有值可显示。 */
const nativeTimingCache = new Map();
/**
* natives 行的短缓存:runs 每 2 秒被轮询一次,dock/Tab/设置页可能同时各拉一份,
* 5 秒内复用同一份结果,避免重复做 sessions.list() 与父会话投影快照。
*/
const NATIVE_ROWS_TTL_MS = 5_000;
/** @type {Map<string, { at: number, value: any[] }>} */
const nativeRowsCache = new Map();

/** 取一个 live Session;不 live 时返回 undefined,调用方按缺失降级。 */
function liveSessionOf(ctx, id) {
	try {
		return ctx?.get?.("sessions")?.get?.(id);
	} catch {
		return undefined;
	}
}

/** 读一条会话的客户端投影值;服务缺失或读数异常都返回空对象(不让面板整块报错)。 */
function projectionValuesOf(ctx, session, keys) {
	if (!session) return {};
	try {
		const values = ctx?.get?.("sessionProjections")?.snapshot?.(session, keys)?.values;
		return values && typeof values === "object" ? values : {};
	} catch {
		return {};
	}
}

/** 内置子代理名:投影里的 name → label → id 前 8 位。 */
function nativeNameOf(entry) {
	const named = typeof entry?.name === "string" ? entry.name.trim() : "";
	if (named) return named;
	const labeled = typeof entry?.label === "string" ? entry.label.trim() : "";
	if (labeled) return labeled;
	return String(entry?.id ?? "").slice(0, 8);
}

/** 读子会话耗时:settledMs 加上未关闭回合的 through - since(through 更稳);没有投影时返回 null。 */
function nativeElapsedOf(timing) {
	if (!timing || typeof timing !== "object") return null;
	const settled = typeof timing.settledMs === "number" && Number.isFinite(timing.settledMs) ? timing.settledMs : 0;
	const active = timing?.active;
	const since = typeof active?.since === "number" ? active.since : undefined;
	const through = typeof active?.through === "number" ? active.through : undefined;
	const openMs = since !== undefined && through !== undefined ? Math.max(0, through - since) : 0;
	const total = settled + openMs;
	return Number.isFinite(total) ? Math.max(0, Math.round(total)) : null;
}

/**
* 把 dsh 自带子代理映射成面板行(runs 快照的 `natives` 字段)。
* 父会话目录取 `subagentCatalog`(name/label/mode/createdAt),
* 子会话耗时取 `subagentTiming`;读不到的字段一律降级为 null/占位,不抛。
* @param ctx 插件作用域
* @param panel 面板配置桥接(includeNative 关闭时直接返回空数组)
* @param payload runs 路由的入参,parentId 指定单个父会话
* @returns 内置子代理行数组
*/
function nativeRunsFor(ctx, panel, payload) {
	// includeNative 关闭时完全不碰会话服务:默认路径的开销保持为零。
	if (!panel?.read?.().includeNative) return [];
	// 只有真的要用投影时才报告缺服务,避免启动期误报(服务可能还没注册)。
	const flags = probeServices(ctx, { quiet: true });
	if (!flags.sessions || !flags.sessionProjections) {
		reportDegradation("sessionProjections/sessions 不可用，内置子代理的名字与耗时降级为占位");
		return [];
	}
	const requested = typeof payload?.parentId === "string" ? payload.parentId.trim() : "";
	const cacheKey = requested || "*";
	const cached = nativeRowsCache.get(cacheKey);
	if (cached && Date.now() - cached.at < NATIVE_ROWS_TTL_MS) return cached.value;
	const rows = collectNativeRows(ctx, requested);
	nativeRowsCache.set(cacheKey, { at: Date.now(), value: rows });
	// 父会话来来去去:缓存不无限长,超限先删最早的一条(不动刚写进去的那条)。
	if (nativeRowsCache.size > 32) {
		for (const key of nativeRowsCache.keys()) {
			if (key === cacheKey) continue;
			nativeRowsCache.delete(key);
			break;
		}
	}
	return rows;
}

/**
* 真正读投影、拼 natives 行;由 nativeRunsFor 做开关、探测与短缓存。
* @param ctx 插件作用域
* @param requested 指定的单个父会话 id,空串表示扫「全部」
* @returns 内置子代理行数组
*/
function collectNativeRows(ctx, requested) {
	/** @type {string[]} */
	let parents;
	if (requested) {
		parents = [requested];
	} else {
		// 未指定父会话(「全部」范围):只扫非子代理的 live 会话,并设数量上限,避免长会话列表拖慢轮询。
		try {
			parents = (ctx?.get?.("sessions")?.list?.() ?? [])
				.filter((session) => session?.header?.origin !== "subagent")
				.map((session) => String(session?.id ?? ""))
				.filter(Boolean)
				.slice(0, 30);
		} catch {
			parents = [];
		}
	}
	const rows = [];
	const seen = new Set();
	for (const parentId of parents) {
		const catalog = projectionValuesOf(ctx, liveSessionOf(ctx, parentId), ["subagentCatalog"]).subagentCatalog;
		if (!Array.isArray(catalog)) continue;
		for (const entry of catalog) {
			// mode=external 是本插件派出的外部 CLI,已经在 runs 里,这里只补 dsh 自带的。
			if (!entry?.id || entry.mode === "external" || seen.has(entry.id)) continue;
			seen.add(entry.id);
			const childId = String(entry.id);
			const childSession = liveSessionOf(ctx, childId);
			const timing = childSession ? projectionValuesOf(ctx, childSession, ["subagentTiming"]).subagentTiming : undefined;
			if (timing) {
				nativeTimingCache.set(childId, { timing, at: Date.now() });
				// 长会话里子代理会很多:超限就丢最早的一条,缓存不无限长。
				if (nativeTimingCache.size > 200) {
					const oldest = nativeTimingCache.keys().next().value;
					if (oldest !== undefined && oldest !== childId) nativeTimingCache.delete(oldest);
				}
			}
			const effectiveTiming = timing ?? nativeTimingCache.get(childId)?.timing;
			const active = effectiveTiming?.active;
			const live = Boolean(childSession);
			// 回合开着(active 存在)就是 running;读得到投影且回合已收盘就是 inactive;
			// 只有投影整个读不到时才退到 dsh 的「有常驻会话即 running」。
			const turnOpen = live && Boolean(active);
			const activity = turnOpen ? "running" : effectiveTiming ? "inactive" : live ? "running" : "inactive";
			// 客户端约定:运行中不给 elapsedMs,由界面按 startedAt 实时算(见 panel 的 elapsedText)。
			const elapsedMs = activity === "running" ? null : nativeElapsedOf(effectiveTiming);
			const startedAt = typeof entry.createdAt === "number" ? entry.createdAt : null;
			rows.push({
				id: childId,
				parentId,
				name: nativeNameOf(entry),
				label: typeof entry.label === "string" ? entry.label : "",
				mode: typeof entry.mode === "string" ? entry.mode : "unknown",
				activity,
				live,
				turnRunning: turnOpen,
				elapsedMs,
				settledMs: typeof effectiveTiming?.settledMs === "number" ? effectiveTiming.settledMs : null,
				startedAt,
				// 下面几个是为了能直接当面板行用而与外部 CLI 行对齐的字段。
				native: true,
				provider: "dsh 内置",
				// 已收盘但没正常完成(lastTurnCompleted=false)标成 error,和其它行的状态语义对齐。
				status: activity === "running" ? "running" : effectiveTiming?.lastTurnCompleted === false ? "error" : "completed",
				endedAt: activity === "running" ? null : startedAt !== null && elapsedMs !== null ? startedAt + elapsedMs : null,
				idleSeconds: active && typeof active.through === "number" ? Math.max(0, Math.round((Date.now() - active.through) / 1000)) : 0,
				model: null,
				costUsd: null,
				stalled: false,
			});
		}
	}
	return rows;
}
//#endregion

//#region 外部脚本派发的任务(pwsh 跑 pi-run.ps1 等)
// 只读 dsh 的 jobs 服务:不改任务、不接管进程。command 行包含任一匹配关键字才算。
/** 从完整命令行里取一个 -Flag 后面的值(支持双引号/单引号/裸值)。 */
function flagValueOf(label, flag) {
	const re = new RegExp(`-${flag}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`, "i");
	const match = re.exec(label);
	if (!match) return "";
	return String(match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** 外部任务的显示名:优先取 -Task 的文件名,取不到就截断命令行。 */
function externalLabelOf(label) {
	const task = flagValueOf(label, "Task");
	if (task) {
		const base = task.split(/[\\/]/).pop() || task;
		return base.replace(/\.(md|markdown|txt)$/i, "");
	}
	return label.slice(0, 120);
}

/** 面板配置里的匹配规则:逗号/分号/空白分隔,统一小写比较。 */
function externalMatchers(panel) {
	const raw = String(panel?.read?.()?.externalMatch ?? "");
	return raw.split(/[,;\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/** 取 jobs 服务;拿不到返回 undefined,调用方静默降级,不影响插件主体。 */
function jobsServiceOf(ctx) {
	try { return ctx?.get?.("jobs"); } catch { return undefined; }
}

/** 参与外部观测的 live 主会话 id;有上限,避免长会话列表拖慢轮询。 */
function observedSessionIds(ctx, requested) {
	if (requested) return [requested];
	try {
		return (ctx?.get?.("sessions")?.list?.() ?? [])
			.filter((session) => session?.header?.origin !== "subagent")
			.map((session) => String(session?.id ?? ""))
			.filter(Boolean)
			.slice(0, 30);
	} catch { return []; }
}

/**
* 把「用脚本起的后台任务」映射成面板行,字段与 runs 快照对齐。
* job 字段缺失时一律降级为 null/0,不抛。
*/
function externalRowsFor(ctx, panel, payload) {
	const cfg = panel?.read?.() ?? PANEL_DEFAULTS;
	const matchers = externalMatchers(panel);
	// 诊断信息随 runs 一起返回:静默失效时能看出是「没开」「读不到服务」还是「没命中」。
	const info = { enabled: cfg.includeExternal !== false, reason: "", matchers, jobs: 0, matched: 0 };
	if (!info.enabled) { info.reason = "disabled"; return { rows: [], info }; }
	if (matchers.length === 0) { info.reason = "no-matchers"; return { rows: [], info }; }
	const jobs = jobsServiceOf(ctx);
	if (!jobs || typeof jobs.list !== "function") { info.reason = "jobs-unavailable"; return { rows: [], info }; }
	const requested = typeof payload?.parentId === "string" ? payload.parentId.trim() : "";
	const rows = [];
	for (const owner of observedSessionIds(ctx, requested)) {
		let listed;
		try { listed = jobs.list(owner) ?? []; } catch { continue; }
		for (const job of listed) {
			info.jobs += 1;
			const label = String(job?.label ?? "");
			if (!label) continue;
			const lower = label.toLowerCase();
			if (!matchers.some((needle) => lower.includes(needle))) continue;
			const running = job.status === "running" || job.status === "stopping";
			const startedAt = typeof job.startedAt === "number" ? job.startedAt : null;
			const endedAt = typeof job.finishedAt === "number" ? job.finishedAt : null;
			const detail = typeof job.detail === "string" ? job.detail : "";
			const progress = typeof job.progress === "string" ? job.progress : "";
			rows.push({
				id: `ext:${job.id}`,
				external: true,
				provider: "外部脚本",
				driver: "job",
				label: externalLabelOf(label),
				parentId: owner,
				status: running ? "running" : job.status === "completed" ? "completed" : job.status === "killed" ? "aborted" : "error",
				startedAt,
				endedAt,
				restored: false,
				model: flagValueOf(label, "Model") || null,
				effort: flagValueOf(label, "Thinking") || null,
				credits: null,
				costUsd: null,
				sessionId: null,
				eventCount: 0,
				lastEvent: progress || detail
					? { kind: progress ? "progress" : "detail", text: String(progress || detail).slice(0, 300), t: endedAt ?? Date.now() }
					: null,
				idleSeconds: running && startedAt !== null ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0,
				stalled: false,
				prompt: label.slice(0, 200),
			});
		}
	}
	info.matched = rows.length;
	return { rows, info };
}

/** 找某个 job 的归属会话 id:kill 的鉴权要按 owner 传。 */
function externalJobOwnerOf(ctx, jobId) {
	const jobs = jobsServiceOf(ctx);
	if (!jobs || typeof jobs.list !== "function") return undefined;
	for (const owner of observedSessionIds(ctx, "")) {
		try {
			if ((jobs.list(owner) ?? []).some((job) => job?.id === jobId)) return owner;
		} catch {}
	}
	return undefined;
}
//#endregion

//#region 本机 CLI 扫描缓存
/** scan 结果缓存时长;key 区分 fast/全扫两种结果。 */
const SCAN_TTL_MS = 60_000;
/** @type {Map<string, { at: number, value: any }>} */
const scanCache = new Map();
//#endregion

function registerProbeRoutes(connection, registry, panel, backends, ctx) {
	const route = (endpoint, handle) => connection.fetch.register({
		path: `/api/dsh-cli-hub/${endpoint}`,
		methods: ["POST"],
		requestBody: "buffered",
		async fetch(request) {
			const method = `dsh-cli-hub/${endpoint}`;
			let envelope;
			try {
				envelope = await request.json();
			} catch {
				return Response.json({ type: "server-response", rpcId: null, result: { ok: false, error: { code: "invalid", message: "invalid JSON", details: { issues: [] } } } });
			}
			let result;
			try {
				if (envelope?.method !== method) throw new Error("method mismatch");
				result = { ok: true, value: await handle(envelope.payload ?? {}, request.signal, request) };
			} catch (error) {
				result = { ok: false, error: { code: "internal", message: "dsh-cli-hub probe failed", details: { issues: [String(error?.message ?? error).slice(0, 256)] } } };
			}
			return Response.json({ type: "server-response", rpcId: envelope?.rpcId ?? null, result });
		},
	});
	return [
		route("probe", (payload) => {
			const name = String(payload?.name ?? "");
			const spec = registry.get(name) ?? builtinSpec(name);
			if (!spec) throw new Error("unknown provider");
			return probeBackend(spec);
		}),
		route("refresh", (payload) => {
			const name = String(payload?.name ?? "");
			probeCache.delete(name);
			latestCache.delete(name);
			const spec = registry.get(name) ?? builtinSpec(name);
			if (!spec) throw new Error("unknown provider");
			return probeBackend(spec);
		}),
		route("update", (payload) => {
			const name = String(payload?.name ?? "");
			const spec = registry.get(name) ?? builtinSpec(name);
			if (!spec) throw new Error("unknown provider");
			return updateBackend(spec, registry);
		}),
		route("activity", (payload) => ({ run: activityLedger.view(String(payload?.runId ?? "")), now: Date.now() })),
		route("runs", (payload) => {
			const limit = Math.min(60, Math.max(1, Number(payload?.limit) || 24));
			const snap = activityLedger.snapshot(limit);
			const parentId = payload?.parentId ? String(payload.parentId) : "";
			// 外部脚本任务(pwsh 跑 pi-run.ps1 等):只读 jobs 服务,与 runs 合并后统一排序。
			let external = { rows: [], info: null };
			try { external = externalRowsFor(ctx, panel, payload); } catch { external = { rows: [], info: { enabled: true, reason: "error", matchers: [], jobs: 0, matched: 0 } }; }
			if (external.rows.length > 0) {
				snap.runs = [...snap.runs, ...external.rows]
					.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
					.slice(0, limit);
			}
			snap.external = external.info;
			if (parentId) snap.runs = snap.runs.filter((run) => run.parentId === parentId);
			// 过滤/合并后重新统计,避免顶部计数串到别的会话。
			const count = (status) => snap.runs.filter((run) => run.status === status).length;
			snap.stats = {
				total: snap.runs.length,
				running: count("running"),
				completed: count("completed"),
				error: count("error"),
				aborted: count("aborted"),
				costUsd: snap.runs.reduce((sum, run) => sum + (typeof run.costUsd === "number" ? run.costUsd : 0), 0),
			};
			snap.cfg = panel?.read?.() ?? PANEL_DEFAULTS;
			// 内置子代理行:读不到投影/服务时返回空数组,不影响 runs 主体结构。
			try {
				snap.natives = nativeRunsFor(ctx, panel, payload);
			} catch {
				snap.natives = [];
			}
			return snap;
		}),
		route("backends", () => {
			// 只返回「本机检测到的」和「用户已配置过的」后端:
			// 没装的内置条目不再以「未安装」卡片出现在设置页。
			const configured = backends.read();
			const byName = new Map(configured.map((entry) => [entry.name, entry]));
			const builtinByName = new Map(BUILTIN_PROVIDERS.map((entry) => [entry.name, entry]));
			// 已配置过的不再重复探测(即使二进制丢了也要返回,installed=false 由界面标注)。
			const detectedNames = BUILTIN_PROVIDERS
				.map((entry) => entry.name)
				.filter((name) => {
					if (byName.has(name)) return false;
					const binary = resolveBinary(name);
					return Boolean(binary && existsSync(binary));
				});
			const names = [...new Set([...byName.keys(), ...detectedNames])];
			const items = names.map((name) => {
				const entry = byName.get(name);
				const binary = resolveBinary(name, entry?.binary);
				return {
					name,
					driver: entry?.driver ?? builtinByName.get(name)?.driver ?? "qoder-json",
					installed: Boolean(binary && existsSync(binary)),
					configured: Boolean(entry),
					enabled: Boolean(entry) && entry.enabled !== false,
					binary: binary ?? null,
					model: entry?.model ?? "",
					models: Array.isArray(entry?.models) ? entry.models : [],
					reasoningEffort: entry?.reasoningEffort ?? "auto",
					maxConcurrency: Number(entry?.maxConcurrency) || 2,
					allowedWaitSeconds: Number(entry?.allowedWaitSeconds) || 300,
					guide: BACKEND_GUIDES[name] ?? "",
				};
			});
			// 已启用 → 已配置未启用 → 仅检测到未配置,同组按名字排。
			const rank = (item) => (item.enabled ? 0 : item.configured ? 1 : 2);
			items.sort((a, b) => (rank(a) === rank(b) ? a.name.localeCompare(b.name) : rank(a) - rank(b)));
			return { items, drivers: Object.keys(DRIVERS) };
		}),
		route("native-interrupt", (payload) => {
			// 中断 dsh 自带的子代理:{kind:'user'} 是浏览器用户的授权,不需要 live Agent;
			// interrupt 是 fire-and-return,目标已结束或被拆掉时按 no-op 处理成功。
			const sessionId = String(payload?.sessionId ?? "").trim();
			if (!sessionId) return { ok: false, error: "sessionId is required" };
			// 会话 id 是 uuid 形状:过长/带空白的一律当非法输入拒掉,不往服务里送。
			if (sessionId.length > 256 || /\s/.test(sessionId)) return { ok: false, error: "invalid sessionId" };
			// 缺服务时在 compat 层留一行说明,本路由只返回 unsupported。
			if (!probeServices(ctx).interrupt) return { ok: false, error: "unsupported" };
			let service;
			try {
				service = ctx?.get?.("subagents");
			} catch {
				service = undefined;
			}
			if (typeof service?.interrupt !== "function") return { ok: false, error: "unsupported" };
			try {
				const receipt = service.interrupt(sessionId, { kind: "user" });
				if (receipt && typeof receipt.then === "function") {
					return receipt.then(
						() => ({ ok: true }),
						(error) => ({ ok: false, error: String(error?.message ?? error) }),
					);
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error) };
			}
		}),
		route("scan", (payload, _signal, request) => {
			// 扫描本机可用的内置 CLI 候选:固定路径 → PATH 命令名 → APPDATA 下的 npm 常见包装。
			// 只识别内置清单里的名字(driver 必须已知),4 秒预算内超时即返回已找到的。
			// fast 模式只查已知固定路径与 PATH,不进用户 bin / npm 目录。
			const fast = payload?.fast === true;
			// 强刷:payload.refresh=true 或 URL 带 ?refresh=1。
			let refresh = payload?.refresh === true;
			if (!refresh) {
				try {
					refresh = new URL(request?.url ?? "http://localhost/").searchParams.get("refresh") === "1";
				} catch {}
			}
			const cacheKey = fast ? "fast" : "full";
			const cached = scanCache.get(cacheKey);
			// 面板每次点「搜索本机 CLI」都发空 payload:默认重扫,只有显式 cache:true 的调用方吃缓存。
			// 否则用户刚添加完后端再点扫描,60 秒内会拿到旧的 configured 标记。
			const mayCache = payload?.cache === true;
			if (!refresh && mayCache && cached && Date.now() - cached.at < SCAN_TTL_MS) return { ...cached.value, cached: true };
			if (refresh) scanCache.delete(cacheKey);
			const startedAt = Date.now();
			try {
				const expired = () => Date.now() - startedAt >= 4000;
				const builtinByName = new Map(BUILTIN_PROVIDERS.map((entry) => [entry.name, entry]));
				const configuredNames = new Set(backends.read().map((entry) => entry.name));
				/** name → 解析到的二进制路径;同一后端只留第一个命中的。 */
				const found = new Map();
				let scanned = 0;
				const probe = (name, candidate) => {
					if (found.has(name) || !candidate) return;
					scanned += 1;
					try {
						if (existsSync(candidate) && statSync(candidate).isFile()) found.set(name, candidate);
					} catch {}
				};
				// ① KNOWN_BINARIES 里的固定候选路径。
				for (const [name, candidates] of Object.entries(KNOWN_BINARIES)) {
					if (!builtinByName.has(name) || expired()) continue;
					for (const candidate of candidates) {
						if (expired()) break;
						probe(name, candidate);
					}
				}
				// ② PATH 中按 PATH_BINARIES 的命令名找(计数经 stats 传出)。
				const pathStats = { scanned: 0 };
				for (const [name, names] of Object.entries(PATH_BINARIES)) {
					if (!builtinByName.has(name) || found.has(name) || expired()) continue;
					const resolved = resolveFromPathNames(names, pathStats);
					if (resolved) found.set(name, resolved);
				}
				scanned += pathStats.scanned;
				// ③ 用户 bin 目录:~/.local/bin 以及 POSIX 常见的 /usr/local/bin、/opt/homebrew/bin。
				// 只按已知名字精确探测,不枚举目录;fast 模式跳过。
				if (!fast && !expired()) {
					const userBinDirs = [join(homedir(), ".local", "bin")];
					if (platform !== "win32") userBinDirs.push("/usr/local/bin", "/opt/homebrew/bin");
					for (const dir of userBinDirs) {
						if (expired()) break;
						for (const [name, names] of Object.entries(PATH_BINARIES)) {
							if (!builtinByName.has(name) || found.has(name) || expired()) continue;
							for (const commandName of names) {
								if (expired()) break;
								probe(name, join(dir, platform === "win32" ? `${commandName}.exe` : commandName));
							}
						}
					}
				}
				// ④ APPDATA 下的 npm 常见 cmd/ps1 包装;与前面命中重复的自动跳过,fast 模式跳过。
				if (!fast && !expired()) {
					const npmDir = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm");
					for (const name of ["pi", "codex", "claude"]) {
						if (found.has(name) || expired()) continue;
						for (const file of platform === "win32" ? [`${name}.cmd`, `${name}.ps1`] : [name]) {
							if (expired()) break;
							probe(name, join(npmDir, file));
						}
					}
				}
				const candidates = [...found.entries()]
					.map(([name, binary]) => ({
						name,
						binary,
						driver: builtinByName.get(name).driver,
						installed: true,
						configured: configuredNames.has(name),
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
				const result = { candidates, tookMs: Date.now() - startedAt, scanned, fast, cached: false };
				scanCache.set(cacheKey, { at: Date.now(), value: result });
				return result;
			} catch (error) {
				// 扫描失败也要给面板一个可用结构,不把异常抛到 RPC 外层。
				return { candidates: [], tookMs: Date.now() - startedAt, scanned: 0, fast, cached: false, error: String(error?.message ?? error).slice(0, 200) };
			}
		}),
		route("backend-check", (payload) => {
			// 「手动添加」里的检测按钮:只做路径解析与文件存在性判断,不执行目标程序。
			const explicit = String(payload?.binary ?? "").trim();
			const name = String(payload?.name ?? "").trim();
			const checkFile = (resolved) => {
				try {
					if (resolved && existsSync(resolved) && statSync(resolved).isFile()) return resolved;
				} catch {}
				return null;
			};
			let binary = null;
			if (explicit) {
				// 与 resolveBinary 的显式路径分支一致:绝对/含分隔符原样用,纯命令名走 PATH。
				binary = checkFile(resolveBinary("", explicit));
			} else if (name) {
				binary = checkFile(resolveBinary(name));
			}
			const lower = binary ? binary.split(/[\\/]/).pop().toLowerCase() : "";
			const byKeyword = [
				["codebuddy", "codebuddy-json"],
				["opencode", "opencode-json"],
				["qoder", "qoder-json"],
				["codex", "codex-json"],
				["claude", "claude-json"],
				["pi", "pi-json"],
			].find(([keyword]) => lower.includes(keyword));
			const driver =
				(name && backends.read().find((entry) => entry.name === name)?.driver)
				|| BUILTIN_PROVIDERS.find((entry) => entry.name === name)?.driver
				|| byKeyword?.[1]
				|| null;
			return { ok: Boolean(binary), binary, driver };
		}),
		route("backend", async (payload) => {
			// 启用/停用一个后端:停用只把 enabled 置 false,保留模型/强度/并发等设置。
			const name = String(payload?.name ?? "").trim();
			if (!name) throw new Error("backend name is required");
			const enabled = payload?.enabled !== false;
			const driver = String(payload?.driver ?? "").trim();
			const binary = String(payload?.binary ?? "").trim();
			await backends.update((list) => {
				const next = list.map((entry) => (entry.name === name ? { ...entry } : entry));
				const at = next.findIndex((entry) => entry.name === name);
				if (at < 0) {
					if (!enabled) return list;
					const builtin = BUILTIN_PROVIDERS.find((entry) => entry.name === name);
					const entry = { name, driver: driver || builtin?.driver || "qoder-json", enabled: true };
					if (binary) entry.binary = binary;
					next.push(entry);
					return next;
				}
				next[at].enabled = enabled;
				if (driver) next[at].driver = driver;
				if (binary) next[at].binary = binary;
				return next;
			});
			return { ok: true };
		}),
		route("backend-config", async (payload) => {
			// 改单个后端的默认模型 / 强度 / 并发上限 / 二进制路径;停用中的后端也允许改。
			const name = String(payload?.name ?? "").trim();
			if (!name) throw new Error("backend name is required");
			const patch = payload?.patch ?? {};
			let found = false;
			await backends.update((list) => list.map((entry) => {
				if (entry.name !== name) return entry;
				found = true;
				const merged = { ...entry };
				if (typeof patch.model === "string") {
					const model = patch.model.trim();
					if (model) merged.model = model;
					else delete merged.model;
				}
				if (Array.isArray(patch.models)) {
					const values = patch.models.map((item) => String(item).trim()).filter(Boolean);
					if (values.length > 0) merged.models = values;
					else delete merged.models;
				}
				if (typeof patch.reasoningEffort === "string") {
					const effort = patch.reasoningEffort.trim();
					if (effort && effort !== "auto") merged.reasoningEffort = effort;
					else delete merged.reasoningEffort;
				}
				if (patch.maxConcurrency !== void 0) {
					merged.maxConcurrency = Math.max(1, Math.min(32, Number(patch.maxConcurrency) || 0));
				}
				if (typeof patch.binary === "string") {
					const binary = patch.binary.trim();
					if (binary) merged.binary = binary;
					else delete merged.binary;
				}
				return merged;
			}));
			if (!found) throw new Error(`后端 ${name} 不在配置里`);
			return { ok: true };
		}),
		route("panel", async (payload) => {
			const current = panel?.read?.() ?? PANEL_DEFAULTS;
			const patch = {};
			if (payload?.reset === true) Object.assign(patch, PANEL_DEFAULTS);
			else {
				const key = String(payload?.key ?? "");
				if (!(key in PANEL_DEFAULTS)) throw new Error(`unknown panel option ${key}`);
				let value = payload?.value;
				if (typeof PANEL_DEFAULTS[key] === "boolean") value = Boolean(value);
				else if (typeof PANEL_DEFAULTS[key] === "number") value = Math.max(0, Number(value) || 0);
				else if (key === "scope") value = value === "all" ? "all" : "session";
				else value = String(value ?? "").trim().slice(0, 300);
				patch[key] = value;
			}
			if (typeof panel?.write !== "function") throw new Error("当前 profile 不支持写回配置");
			await panel.write(patch);
			return { cfg: { ...current, ...patch } };
		}),
		route("stop", (payload) => {
			const id = String(payload?.runId ?? "");
			// 外部脚本任务:走 dsh jobs 的 kill;鉴权按任务归属会话传,找不到就如实返回。
			if (id.startsWith("ext:")) {
				const jobId = id.slice(4);
				const jobs = jobsServiceOf(ctx);
				if (!jobs || typeof jobs.kill !== "function") return { ok: false, stopped: false, error: "jobs service unavailable" };
				const owner = externalJobOwnerOf(ctx, jobId);
				if (!owner) return { ok: false, stopped: false, error: "job not found in live sessions" };
				try {
					jobs.kill(jobId, owner, "stopped from dsh-cli-hub panel");
					return { ok: true, stopped: true };
				} catch (error) {
					return { ok: false, stopped: false, error: String(error?.message ?? error).slice(0, 200) };
				}
			}
			const meta = readRunIndex().find((run) => run.id === id);
			const pid = meta?.pid;
			if (!pid || !pidAlive(pid)) return { ok: true, stopped: false };
			try {
				if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
				else process.kill(pid, "SIGKILL");
			} catch {}
			upsertRunIndex({ id, status: "aborted", endedAt: Date.now(), pid: null });
			return { ok: true, stopped: true };
		}),
	];
}
//#endregion

//#region 装配
/** 把可能是 volatile 引用的 `providers` 配置字段展开为普通数组。 */
function readProviders(config) {
	const raw = typeof config?.providers?.get === "function" ? config.providers.get() : config?.providers;
	return Array.isArray(raw) ? raw : [];
}

/** 读取可能是 volatile 引用的标量配置字段。 */
function readScalar(value, fallback) {
	const raw = typeof value?.get === "function" ? value.get() : value;
	return raw ?? fallback;
}

/** 把一条原始后端配置规范化为解析后的 spec(自动探测可执行文件)。 */
function normalizeSpec(entry) {
	const models = Array.isArray(entry.models) && entry.models.length > 0
		? entry.models
		: entry.model
			? [entry.model]
			: [];
	return {
		name: entry.name,
		driver: entry.driver ?? "qoder-json",
		binary: resolveBinary(entry.name, entry.binary),
		permissionMode: entry.permissionMode ?? "bypass_permissions",
		models,
		allowedWaitSeconds: entry.allowedWaitSeconds ?? 300,
		reasoningEffort: entry.reasoningEffort ?? "auto",
		contextWindow: entry.contextWindow ?? undefined,
		timeoutSeconds: entry.timeoutSeconds ?? undefined,
		stallWarnSeconds: entry.stallWarnSeconds ?? 90,
		extraArgs: entry.extraArgs ?? [],
		maxConcurrency: entry.maxConcurrency ?? 2,
	};
}

/** 把一条内置配置解析为 spec,即使它当前尚未启用。 */
function builtinSpec(name) {
	const entry = BUILTIN_PROVIDERS.find((candidate) => candidate.name === name);
	return entry ? normalizeSpec(entry) : undefined;
}

/** 把一条账本运行渲染成紧凑、上下文安全的摘要,供模型读取。 */
function digestRun(run, eventBudget) {
	const credits = run.credits
		? ` | credits: ${run.credits.total > 0 ? run.credits.total.toFixed(4) : run.credits.billable === false ? "free" : "0"}`
		: typeof run.costUsd === "number"
			? ` | cost: $${run.costUsd.toFixed(4)}`
			: "";
	const idleSeconds = run.status === "running" ? Math.round((Date.now() - (run.events.at(-1)?.t ?? run.startedAt)) / 1000) : 0;
	const idle = run.status === "running" ? ` | idle: ${idleSeconds}s${run.stallWarnSeconds > 0 && idleSeconds >= run.stallWarnSeconds ? " (⚠️ possibly stalled)" : ""}` : "";
	const head = `run ${run.id} | ${run.provider} | ${run.status} | ${Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000)}s | label: ${run.label || "(none)"}${run.sessionId ? ` | cli session: ${run.sessionId}` : ""}${credits}${idle}`;
	const events = run.events.slice(-eventBudget).map((event) => `  [+${Math.round((event.t - run.startedAt) / 1000)}s] ${event.kind}: ${event.text.slice(0, 200).replace(/\s+/g, " ")}`);
	const omitted = run.events.length - events.length;
	return [head, ...(omitted > 0 ? [`  … (${omitted} earlier events omitted)`] : []), ...events].join("\n");
}

/** 把已配置后端注册为 `ctx.subagents` 上的具名提供方。 */
function apply(ctx, config) {
	// 提供方 spec 实时读取,提供方集合则在
	// volatile 配置更新时重新对齐,因此在设置页增删后端
	// 无需重新注册提供方,也无需重启宿主。
	const liveSpec = (name) => {
		const entry = readProviders(config).find((candidate) => candidate.name === name);
		return entry ? normalizeSpec(entry) : undefined;
	};
	const registry = {
		list: () => readProviders(config).map((entry) => entry.name),
		get: (name) => liveSpec(name),
	};
	const schedule = () => ({
		specs: readProviders(config).map(normalizeSpec),
		mode: readScalar(config.scheduleMode, "priority"),
	});
	const registrations = new Map();

	const buildCommand = (providerName) => ctx.commands.register({
		name: `sub_${providerName}`,
		description: `把这一行任务交给 ${providerName} 子代理(经由工具调用,实时进度/扣费/完成通知齐全)`,
		input: { hint: "任务描述" },
		handler(invocation) {
			const task = invocation.rawInput.trim();
			if (!task) return { kind: "error", text: `用法: /sub_${providerName} <任务描述>` };
			try {
				invocation.agent.followup(createUserMessage({
					content: [{ type: "text", text: `请调用名为 ${providerName} 的委派工具(外部 CLI 子代理工具,不是 LLM provider,不要调用 list_subagent_models;也不要改用 subagent/subagent_fork)把以下任务交给子代理(不要自己执行)。完成后把子代理的结果转述给我。\n\n任务:\n${task}` }],
					source: { kind: "user" },
				}));
				return { kind: "success", text: `已交给会话:即将用 ${providerName} 工具委派,实时进度会显示在工具行里。` };
			} catch (error) {
				return { kind: "error", text: `${providerName} 指令失败: ${String(error?.message ?? error).slice(0, 300)}` };
			}
		},
	});

	const syncBackends = () => {
		const entries = new Map();
		for (const entry of readProviders(config)) {
			if (entry.enabled === false) continue;
			if (!DRIVERS[entry.driver ?? "qoder-json"]) {
				ctx.logger?.warn?.(`dsh-cli-hub: unknown driver "${entry.driver}" for provider "${entry.name}", skipped`);
				continue;
			}
			if (!entries.has(entry.name)) entries.set(entry.name, entry);
		}
		for (const [providerName, record] of registrations) {
			if (entries.has(providerName)) continue;
			record.provider?.();
			record.command?.();
			record.tool?.();
			registrations.delete(providerName);
		}
		for (const [providerName, entry] of entries) {
			let record = registrations.get(providerName);
			if (!record) {
				record = { provider: undefined, command: undefined, tool: undefined };
				registrations.set(providerName, record);
			}
			if (!record.tool && defineTool) {
				// 自带委派工具:与官方 @deepseek-ai/dsh-tool-subagent 等价,但把 catalog/工具行
				// 的 label 变成「后端名 · 任务描述」,让编队面板里显示成 codex/pi 而不是纯描述。
				const definition = defineTool({
					name: providerName,
					description: `Delegate a self-contained task to the ${providerName} external CLI subagent. It works in its own context and returns its final result, not its intermediate steps. This backend is one-shot and does not accept follow-up messages.`,
					parameters: {
						cwd: { type: "string", description: "Initial child working directory. Relative paths use your current directory; omitted inherits it." },
						description: { type: "string", required: true, description: "A short (3-5 word) description of the delegated task, for display." },
						prompt: { type: "string", required: true, description: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs." },
						model: { type: "string", description: "Optional model override for this call. Only a model listed for this backend in the backend guide is accepted; omit to use the configured default (and its fallback chain)." },
						reasoning: { type: "string", description: "Optional thinking-effort override for this call, e.g. pi: off/minimal/low/medium/high/xhigh/max, codex: minimal/low/medium/high/xhigh/max/ultra. Omit to use the configured effort; backends without effort support reject this parameter." },
					},
					output: {
						schema: { type: "object", additionalProperties: false, properties: { kind: { type: "string", required: true, const: "activation" }, subagentId: { type: "string", required: true } } },
						render: (_args, value) => [{ type: "text", text: `started subagent ${value.subagentId}` }],
					},
					isConcurrencySafe: () => true,
					async execute(args, exec) {
						const parent = exec.agent;
						if (!parent) throw new Error(`${providerName} subagent tool requires a calling agent (exec.agent was undefined)`);
						const summary = String(args.description ?? "").trim();
						const label = summary ? `${providerName} · ${summary}` : providerName;
						// 白名单校验在调用时按 live spec 做:模型改配置后立即生效,不合法的值明确报错而不是静默忽略。
						const live = liveSpec(providerName);
						const models = Array.isArray(live?.models) ? live.models : [];
						const model = typeof args.model === "string" ? args.model.trim() : "";
						if (model && models.length > 0 && !models.includes(model)) {
							throw new Error(`${providerName}: 不支持的模型 "${model}";可选: ${models.join(", ")}`);
						}
						const levels = effortLevelsFor(live?.driver ?? "qoder-json");
						const reasoning = typeof args.reasoning === "string" ? args.reasoning.trim() : "";
						if (reasoning && levels.length === 0) {
							throw new Error(`${providerName}: 该后端不支持 reasoning 参数(没有可用的思考强度档)`);
						}
						if (reasoning && !levels.includes(reasoning)) {
							throw new Error(`${providerName}: 不支持的思考强度 "${reasoning}";可选: ${levels.join(", ")}`);
						}
						// spec 字段必须平铺：dsh 的 startActivation 读 spec.parent/spec.prompt，
						// 包进 request 子对象会让 spec.parent 变成 undefined（旧版曾这么写，
						// 表现为 ToolCallError: Cannot read properties of undefined (reading 'id')）。
						const started = await ctx.subagents.startActivation({
							provider: providerName,
							label,
							delivery: "parent",
							signal: exec.signal,
							parent,
							prompt: [{ type: "text", text: args.prompt }],
							...(args.cwd === void 0 ? {} : { cwd: args.cwd }),
							...(model ? { model } : {}),
							...(reasoning ? { reasoning } : {}),
						});
						return { kind: "activation", subagentId: started.childId };
					},
				});
				const disposeTool = ctx.tools.register(definition);
				record.tool = () => {
					try { disposeTool?.(); } catch {}
				};
			}
			if (!record.provider) {
				record.provider = ctx.subagents.registerProvider(new QoderJsonProvider(
					providerName,
					() => liveSpec(providerName),
					(id) => ctx.get("agents")?.get?.(id),
					schedule,
				));
			}
			// 只有本机确实存在对应 CLI 时斜杠指令才有用;
			// 否则跳过,避免指令菜单出现死路。
			const commandBinary = resolveBinary(providerName, entry.binary);
			const commandAvailable = Boolean(commandBinary && existsSync(commandBinary));
			if (commandAvailable && !record.command) record.command = buildCommand(providerName);
			else if (!commandAvailable && record.command) {
				record.command();
				record.command = undefined;
			}
		}
	};
	ctx.effect(() => {
		syncBackends();
		const off = ctx.on("loader/volatile-update", (paths) => {
			if (paths.some((path) => path[0] === "providers")) syncBackends();
		});
		return () => {
			off?.();
			for (const record of registrations.values()) {
				record.provider?.();
				record.command?.();
				record.tool?.();
			}
			registrations.clear();
		};
	});
	ctx.effect(() => {
		// defineTool 缺失时跳过注册，不让工具表出现半个坏定义。
		if (!defineTool) return () => {};
		const dispose = ctx.tools.register(defineTool({
			name: "sub_agent_status",
			description: "Check progress of background external-CLI subagent delegations at any time. Omit run_id to list recent runs with their latest activity; pass the run id returned by a delegation (`started subagent <id>`) for that run's event transcript (thinking, tool calls, output). Use this instead of blind sleeping when asked how a delegated child is going.",
			parameters: {
				run_id: {
					type: "string",
					description: "Run id from a delegation tool result. Omit to list recent runs.",
				},
			},
			output: {
				schema: { type: "string" },
				render: (_args, result) => [{ type: "text", text: result }],
			},
			execute(args) {
				const runId = args?.run_id ? String(args.run_id) : undefined;
				if (runId) {
					const run = activityLedger.view(runId);
					return Promise.resolve(run ? digestRun(run, 40) : `unknown run id ${runId}; recent ids: ${activityLedger.runs.map((candidate) => candidate.id).join(", ") || "(none)"}`);
				}
				const runs = activityLedger.recent(6);
				if (runs.length === 0) return Promise.resolve("no external subagent runs recorded yet");
				return Promise.resolve(runs.map((run) => digestRun(run, 5)).join("\n\n"));
			},
		}));
		return () => dispose?.();
	});
	ctx.effect(() => {
		const dispose = ctx.commands.register({
			name: "sub_agent_status",
			description: "查看已启用外包子代理的运行状态与最近事件",
			input: { hint: "run_id(可省略,默认列出最近运行)" },
			handler(invocation) {
				const runId = invocation.rawInput.trim();
				if (runId) {
					const run = activityLedger.view(runId);
					return {
						kind: "success",
						text: run ? digestRun(run, 40) : `未找到运行 ${runId};最近运行: ${activityLedger.runs.map((candidate) => candidate.id).join(", ") || "(无)"}`,
					};
				}
				const runs = activityLedger.recent(Math.min(24, Math.max(1, readScalar(config.statusListLimit, 16))));
				return { kind: "success", text: runs.length ? runs.map((run) => digestRun(run, 8)).join("\n\n") : "暂无外包子代理运行记录" };
			},
		});
		return () => dispose?.();
	});
	ctx.effect(() => {
		resumePersistedRuns(ctx);
		return () => {};
	});
	const panelBridge = {
		read: () => readPanelCfg(config),
		/** 把面板开关写回本插件的配置行(cordis.patch.yml);写不进去由客户端本地兜底。 */
		write: async (patch) => {
			let editor;
			try { editor = ctx.get("configEditor"); } catch { editor = undefined; }
			const entry = ctx.fiber?.entry;
			if (!editor || typeof editor.edit !== "function" || entry === undefined) throw new Error("当前 profile 不支持写回配置");
			await editor.edit(entry, (current) => ({ ...(current ?? {}), panel: { ...(current?.panel ?? {}), ...patch } }));
		},
	};
	/** 设置页读写 providers 数组的桥接:read 给实时列表,update 在最新配置上就地改(避免整段覆盖丢字段)。 */
	const providersBridge = {
		read: () => readProviders(config),
		update: async (mutate) => {
			let editor;
			try { editor = ctx.get("configEditor"); } catch { editor = undefined; }
			const entry = ctx.fiber?.entry;
			if (!editor || typeof editor.edit !== "function" || entry === undefined) throw new Error("当前 profile 不支持写回配置");
			await editor.edit(entry, (current) => {
				const list = Array.isArray(current?.providers) ? current.providers : [];
				return { ...(current ?? {}), providers: mutate(list) };
			});
		},
		write: async (next) => {
			let editor;
			try { editor = ctx.get("configEditor"); } catch { editor = undefined; }
			const entry = ctx.fiber?.entry;
			if (!editor || typeof editor.edit !== "function" || entry === undefined) throw new Error("当前 profile 不支持写回配置");
			await editor.edit(entry, (current) => ({ ...(current ?? {}), providers: next }));
		},
	};
	ctx.inject(["connection"], (scoped) => {
		scoped.effect(() => {
			const disposers = registerProbeRoutes(scoped.connection, registry, panelBridge, providersBridge, scoped);
			return () => disposers.forEach((dispose) => dispose());
		});
	});
	ctx.inject(["systemPrompt"], (scoped) => {
		scoped.effect(() => scoped.systemPrompt.variable("subagent_backends", () => backendGuide(
			readProviders(config),
			readScalar(config.scheduleMode, "priority"),
			(name) => providerGate.active(name),
		)), "dsh-cli-hub: backend guide");
	});
}
//#endregion

export { Config, apply, inject, name };
