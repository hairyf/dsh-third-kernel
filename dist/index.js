import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { homedir } from "node:os";
//#region src/shared/constants.ts
const PLUGIN_ID = "dsh-tauri-kernel";
//#endregion
//#region src/host/config/runtime.ts
const runtime = {
	detections: /* @__PURE__ */ new Map(),
	sessions: /* @__PURE__ */ new Map(),
	pending: /* @__PURE__ */ new Map(),
	removals: /* @__PURE__ */ new Map(),
	closings: /* @__PURE__ */ new Map(),
	controllers: /* @__PURE__ */ new Map(),
	claims: /* @__PURE__ */ new Map(),
	sinks: /* @__PURE__ */ new Map(),
	exchanges: /* @__PURE__ */ new Map(),
	steps: /* @__PURE__ */ new Map(),
	modelWrites: /* @__PURE__ */ new Map(),
	checkpoints: /* @__PURE__ */ new Map(),
	verified: /* @__PURE__ */ new Map(),
	/** Agents whose scope already selects the official native tool executor. */
	executors: /* @__PURE__ */ new WeakSet(),
	bindingSchema: void 0,
	optionsSchema: void 0,
	catalogSchema: void 0,
	ready: false,
	lifetime: new AbortController()
};
async function resetRuntime() {
	runtime.ready = false;
	runtime.bindingSchema = void 0;
	runtime.optionsSchema = void 0;
	runtime.catalogSchema = void 0;
	runtime.lifetime.abort(/* @__PURE__ */ new Error("BRIDGE_DISPOSED"));
	for (const controller of runtime.controllers.values()) controller.abort(/* @__PURE__ */ new Error("BRIDGE_DISPOSED"));
	const exchanges = [...runtime.exchanges.values()];
	for (const exchange of exchanges) exchange.state.controller.abort(/* @__PURE__ */ new Error("BRIDGE_DISPOSED"));
	await Promise.allSettled([
		...[...runtime.pending.values()].map((pending) => pending.task),
		...runtime.removals.values(),
		...runtime.closings.values(),
		...runtime.modelWrites.values(),
		...runtime.checkpoints.values(),
		...exchanges.map((exchange) => exchange.state.task)
	]);
	const disposed = await Promise.allSettled(exchanges.map((exchange) => exchange.dispose()));
	const entries = [...runtime.sessions.values()];
	runtime.sessions.clear();
	runtime.pending.clear();
	runtime.removals.clear();
	runtime.closings.clear();
	runtime.controllers.clear();
	runtime.claims.clear();
	runtime.sinks.clear();
	runtime.exchanges.clear();
	runtime.steps.clear();
	runtime.modelWrites.clear();
	runtime.checkpoints.clear();
	runtime.verified.clear();
	runtime.executors = /* @__PURE__ */ new WeakSet();
	runtime.detections.clear();
	const outcomes = await Promise.allSettled(entries.map((entry) => entry.session.dispose()));
	const failures = [...disposed, ...outcomes].filter((outcome) => outcome.status === "rejected");
	if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "BRIDGE_DISPOSE_FAILED");
}
//#endregion
//#region src/host/context.ts
let owner;
function activateHost(ctx, config) {
	if (owner) throw new Error("BRIDGE_OWNER_CONFLICT: 原生桥接已激活。");
	const current = {
		ctx,
		config
	};
	owner = current;
	return () => {
		if (owner === current) owner = void 0;
	};
}
function getHostContext() {
	if (!owner) throw new Error("BRIDGE_DISPOSED: 原生桥接未激活。");
	return owner.ctx;
}
function getHostConfig() {
	if (!owner) throw new Error("BRIDGE_DISPOSED: 原生桥接未激活。");
	return owner.config;
}
//#endregion
//#region src/host/server/request.ts
var RequestError = class extends Error {};
async function readBody(request) {
	let body;
	try {
		body = await request.json();
	} catch {
		throw new RequestError("BRIDGE_REQUEST_INVALID: 请求体必须是 JSON 对象。");
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) throw new RequestError("BRIDGE_REQUEST_INVALID: 请求体必须是 JSON 对象。");
	return body;
}
//#endregion
//#region src/shared/version.ts
/**
* The single DSH core baseline this plugin supports. `package.json` pins the
* same line through `peerDependencies`, so DSH refuses to load the plugin on
* anything older and this constant only exists for runtime diagnostics and the
* client-side capability gate.
*/
const KERNEL_CORE_BASELINE = "0.2.2-rc.1";
function parse(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\d.a-z-]+))?(?:\+[\d.a-z-]+)?$/i.exec(version.trim());
	if (match === null) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		pre: match[4] === void 0 ? [] : match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part)
	};
}
function comparePrerelease(left, right) {
	if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const a = left[index];
		const b = right[index];
		if (a === void 0) return -1;
		if (b === void 0) return 1;
		if (a === b) continue;
		if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
		if (typeof a === "number") return -1;
		if (typeof b === "number") return 1;
		return a < b ? -1 : 1;
	}
	return 0;
}
/** Semver-ish comparison against the supported core baseline; `undefined` when unparseable. */
function kernelVersionAtLeast(version, baseline = KERNEL_CORE_BASELINE) {
	if (typeof version !== "string" || version.trim() === "") return void 0;
	const left = parse(version);
	const right = parse(baseline);
	if (left === null || right === null) return void 0;
	for (const key of [
		"major",
		"minor",
		"patch"
	]) if (left[key] !== right[key]) return left[key] > right[key];
	return comparePrerelease(left.pre, right.pre) >= 0;
}
//#endregion
//#region src/host/utils/detection.ts
function nativeEnvironment(env = process.env) {
	const clean = { ...env };
	for (const key of Object.keys(clean)) if (/^(?:DSH_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_THREAD_ID|CODEX_INTERNAL_ORIGINATOR_OVERRIDE|NODE_OPTIONS)$/i.test(key)) delete clean[key];
	return clean;
}
async function resolveNativeCommand(backend, override, options = {}) {
	const platform = options.platform ?? process.platform;
	const env = nativeEnvironment(options.env);
	const extensions = platform === "win32" ? [
		".exe",
		".cmd",
		".ps1",
		""
	] : [""];
	let entry;
	if (override !== void 0) {
		if (!override.trim() || !isAbsolute(override)) throw new Error("BRIDGE_EXECUTABLE_PATH: 请配置本机 CLI 的绝对路径。");
		if (!await executable(override, platform)) throw new Error("BRIDGE_EXECUTABLE_MISSING: 配置的 CLI 不存在或不可执行。");
		entry = override;
	} else {
		const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
		for (const directory of pathValue.split(platform === "win32" ? ";" : delimiter)) {
			if (!directory || !isAbsolute(directory)) continue;
			for (const extension of extensions) {
				const candidate = join(directory, `${backend}${extension}`);
				if (await executable(candidate, platform)) {
					entry = candidate;
					break;
				}
			}
			if (entry) break;
		}
		if (!entry) throw new Error(`BRIDGE_EXECUTABLE_MISSING: 本机未安装 ${backend === "codex" ? "Codex" : "Claude"} CLI，或其不在 PATH 中。`);
	}
	let packageRoot;
	const suffix = extname(entry).toLowerCase();
	if (suffix === ".cmd" || suffix === ".ps1") {
		const text = await boundedRead(entry);
		const match = new RegExp(`(?:node_modules[/\\\\]${backend === "codex" ? "@openai[/\\\\]codex[/\\\\]bin[/\\\\]codex\\.js" : "@anthropic-ai[/\\\\]claude-code[/\\\\](?:cli\\.js|bin[/\\\\]claude(?:\\.exe)?)"})`, "i").exec(text);
		if (!match) throw new Error("BRIDGE_SHIM_UNSUPPORTED: 此命令包装器无法安全解析，请配置原生可执行文件路径。");
		entry = join(dirname(entry), match[0].replace(/[\\/]/g, "/"));
		packageRoot = backend === "claude" && /\.js$/i.test(entry) ? dirname(entry) : dirname(dirname(entry));
	}
	entry = await realpath(entry);
	const script = /\.[cm]?js$/i.test(entry);
	if (packageRoot !== void 0 || script) {
		const root = packageRoot ?? (backend === "codex" ? dirname(dirname(entry)) : dirname(entry));
		const metadata = JSON.parse(await boundedRead(join(root, "package.json")));
		const expected = backend === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
		if (metadata.name !== expected) throw new Error("BRIDGE_PACKAGE_MISMATCH: CLI 包装器不是所选内核的官方安装。");
	}
	if (script) {
		const root = backend === "codex" ? dirname(dirname(entry)) : dirname(entry);
		if (backend === "claude") return {
			file: process.execPath,
			args: [entry],
			env
		};
		const target = codexTarget(platform, options.arch ?? process.arch);
		const platformPackage = `@openai/codex-${platform === "win32" ? "win32" : platform}-${options.arch ?? process.arch}`;
		let vendor = join(root, "vendor");
		try {
			vendor = join(dirname(createRequire(join(root, "package.json")).resolve(`${platformPackage}/package.json`)), "vendor");
		} catch {}
		entry = join(vendor, target, "bin", platform === "win32" ? "codex.exe" : "codex");
	}
	if (!await executable(entry, platform)) throw new Error("BRIDGE_EXECUTABLE_MISSING: 官方 CLI 安装缺少原生可执行文件，请重新安装。");
	return {
		file: await realpath(entry),
		args: [],
		env
	};
}
async function detectBackend(backend, override, options = {}) {
	const detection = {
		id: backend,
		installed: false,
		auth: "unknown",
		version: null,
		drift: false,
		hint: null
	};
	try {
		const command = await resolveNativeCommand(backend, override, options);
		const timeout = options.timeoutMs ?? 5e3;
		const version = await probe(command, ["--version"], timeout);
		if (version.code !== 0) throw new Error("BRIDGE_PROBE_FAILED: CLI 版本探测失败，请在终端检查该安装。");
		detection.version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(version.output)?.[0] ?? null;
		if (!detection.version) throw new Error("BRIDGE_VERSION_UNRECOGNIZED: CLI 未返回可识别版本。");
		const help = await probe(command, backend === "codex" ? ["app-server", "--help"] : ["--help"], timeout);
		if (help.code !== 0 || backend === "claude" && !/stream-json/.test(help.output)) {
			detection.drift = true;
			throw new Error("BRIDGE_PROTOCOL_UNAVAILABLE: 本机 CLI 不支持所需桥接协议，请更新 CLI。");
		}
		detection.installed = true;
		const auth = await probe(command, backend === "codex" ? ["login", "status"] : [
			"auth",
			"status",
			"--json"
		], timeout).catch(() => void 0);
		if (auth) if (backend === "codex") detection.auth = auth.code === 0 ? "ok" : "unknown";
		else try {
			const status = JSON.parse(auth.output);
			detection.auth = status.loggedIn === false ? "missing" : auth.code === 0 && status.loggedIn === true ? "ok" : "unknown";
		} catch {}
		detection.hint = detection.auth === "missing" ? "请先在终端运行 claude auth login。" : detection.auth === "unknown" ? backend === "codex" ? "无法确认 Codex 认证状态；请检查原生 CLI 的 provider 配置和认证方式。" : "无法确认登录状态；原生 CLI 会在连接时检查认证。" : null;
		return {
			detection,
			command
		};
	} catch (error) {
		detection.hint = error instanceof Error && error.message.startsWith("BRIDGE_") ? error.message : "BRIDGE_PROBE_FAILED: 无法探测本机 CLI，请检查配置路径和安装。";
		return { detection };
	}
}
async function executable(file, platform) {
	try {
		if (!(await stat(file)).isFile()) return false;
		await access(file, platform === "win32" || /\.(?:cmd|ps1)$/i.test(file) ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
async function boundedRead(file) {
	if ((await stat(file)).size > 128 * 1024) throw new Error("BRIDGE_SHIM_TOO_LARGE: CLI 包装器文件异常。");
	return readFile(file, "utf8");
}
function codexTarget(platform, arch) {
	const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : void 0;
	const os = platform === "win32" ? "pc-windows-msvc" : platform === "darwin" ? "apple-darwin" : platform === "linux" ? "unknown-linux-musl" : void 0;
	if (!cpu || !os) throw new Error("BRIDGE_PLATFORM_UNSUPPORTED: 此平台没有可用的本机 Codex CLI。");
	return `${cpu}-${os}`;
}
async function probe(command, args, timeoutMs) {
	return new Promise((resolveProbe, reject) => {
		const child = spawn(command.file, [...command.args, ...args], {
			env: command.env,
			windowsHide: true,
			shell: false,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let output = "";
		let bytes = 0;
		let settled = false;
		const timer = setTimeout(() => fail(/* @__PURE__ */ new Error("BRIDGE_PROBE_TIMEOUT: 本机 CLI 探测超时。")), Math.min(3e4, Math.max(100, timeoutMs)));
		function cleanup() {
			clearTimeout(timer);
			child.stdout.off("data", collect);
			child.stderr.off("data", collect);
			child.off("close", close);
		}
		function fail(error) {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
			child.stdout.resume();
			child.stderr.resume();
			try {
				child.kill();
			} catch {}
		}
		function collect(chunk) {
			bytes += chunk.byteLength;
			if (bytes > 128 * 1024) {
				fail(/* @__PURE__ */ new Error("BRIDGE_PROBE_OUTPUT_LIMIT: CLI 探测输出异常。"));
				return;
			}
			output += chunk.toString("utf8");
		}
		function close(code) {
			if (settled) return;
			settled = true;
			cleanup();
			child.off("error", fail);
			resolveProbe({
				code,
				output
			});
		}
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", fail);
		child.once("close", close);
	});
}
//#endregion
//#region src/host/utils/runtime-modules.ts
/**
* DSH 0.2.2 replaced `tools.presentAs('native')` with executor selection:
* `tools.setExecutor(...)` is the one per-scope provider. Bridged sessions feed
* native tool calls into the official pipeline as model-direct calls, which a
* PTC presentation would reject as `UNKNOWN_TOOL`, so the scope must select the
* official native executor for the duration of the native turn.
*/
async function loadNativeExecutor(loader) {
	const module = await loader.import("@deepseek-ai/dsh-tool-executor-native");
	const resolved = module?.NativeToolExecutor ?? loader.unwrapExports(module)?.NativeToolExecutor;
	if (typeof resolved !== "function") throw new TypeError("BRIDGE_RUNTIME_EXPORT_MISSING: @deepseek-ai/dsh-tool-executor-native.NativeToolExecutor");
	return resolved;
}
/** Public pipeline used for executor-owned native replay capabilities. */
async function loadToolPipeline(loader) {
	const module = await loader.import("@deepseek-ai/dsh-tools/pipeline");
	const pipeline = module?.ToolExecutionPipeline ? module : loader.unwrapExports(module);
	if (typeof pipeline?.ToolExecutionPipeline !== "function" || typeof pipeline.executeToolBatch !== "function") throw new TypeError("BRIDGE_RUNTIME_EXPORT_MISSING: @deepseek-ai/dsh-tools/pipeline");
	return pipeline;
}
async function loadRuntimeZod(loader) {
	const value = await loader.import("zod");
	const resolved = value?.z ?? loader.unwrapExports(value)?.z;
	if (typeof resolved?.object !== "function" || typeof resolved.string !== "function" || typeof resolved.enum !== "function" || typeof resolved.number !== "function" || typeof resolved.array !== "function") throw new TypeError("BRIDGE_RUNTIME_EXPORT_MISSING: zod.z");
	return resolved;
}
/**
* The runtime exports this plugin contracts on. Every one of them is part of
* the pinned core line, so a missing export is a hard `BRIDGE_CORE_UNAVAILABLE`
* — never a silent degraded mode on an older core.
*/
async function loadRuntimeModules(loader) {
	const [llm, session] = await Promise.all([loader.import("@deepseek-ai/dsh-llm"), loader.import("@deepseek-ai/dsh-session")]);
	return {
		ToolCallId: resolveExport(loader, llm, "ToolCallId"),
		LlmAdapter: resolveExport(loader, llm, "LlmAdapter"),
		isAgentLoopRequest: resolveExport(loader, llm, "isAgentLoopRequest"),
		appendPluginRecord: resolveExport(loader, session, "appendPluginRecord"),
		pluginRecordOf: resolveExport(loader, session, "pluginRecordOf")
	};
}
function optionalExport(loader, value, key) {
	const direct = value?.[key];
	if (typeof direct === "function") return direct;
	const fallback = loader.unwrapExports(value)?.[key];
	return typeof fallback === "function" ? fallback : void 0;
}
function resolveExport(loader, value, key) {
	const value_ = optionalExport(loader, value, key);
	if (value_ === void 0) throw new TypeError(`BRIDGE_RUNTIME_EXPORT_MISSING: ${key}`);
	return value_;
}
//#endregion
//#region src/host/utils/runtime-version.ts
const RUNTIME_PACKAGE = "@deepseek-ai/dsh-app-boot";
function runtimeExport(loader, value, key) {
	const direct = value?.[key];
	if (direct !== void 0) return direct;
	return loader.unwrapExports(value)?.[key];
}
async function runtimeVersion(loader) {
	try {
		const version = runtimeExport(loader, await loader.import(RUNTIME_PACKAGE), "getDshRuntimeVersion");
		if (typeof version !== "function") return null;
		const value = version();
		return typeof value === "string" && value.trim() !== "" ? value : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/host/service/backend.ts
const backend = {
	async resolve(id) {
		const ctx = getHostContext();
		const config = getHostConfig();
		const result = await detectBackend(id, id === "codex" ? config.codexPath : config.claudePath, { timeoutMs: config.probeTimeoutMs });
		try {
			await loadRuntimeModules(ctx.loader);
			if (!runtime.ready || typeof ctx.sessions.get !== "function" || typeof ctx.agents.turnBoundaryOf !== "function") throw new Error("BRIDGE_CORE_UNAVAILABLE: 当前核心未提供完整的官方内核桥接接口。");
			runtime.lifetime.signal.throwIfAborted();
			result.detection.bridgeReady = true;
		} catch {
			result.detection.bridgeReady = false;
			if (result.detection.installed) result.detection.hint = "BRIDGE_CORE_UNAVAILABLE: 当前核心未提供完整的官方内核桥接接口，不能连接本机 CLI。";
			delete result.command;
		}
		if (!runtime.lifetime.signal.aborted) runtime.detections.set(id, result.detection);
		return result;
	},
	async getCatalog() {
		const ctx = getHostContext();
		const results = await Promise.all([backend.resolve("codex"), backend.resolve("claude")]);
		const version = await runtimeVersion(ctx.loader);
		const supported = kernelVersionAtLeast(version);
		return [{
			id: "dsh",
			installed: true,
			auth: "ok",
			version,
			drift: supported === false,
			hint: supported === false ? `BRIDGE_CORE_UNSUPPORTED: 需要 DSH ${KERNEL_CORE_BASELINE} 或更新的核心。` : null
		}, ...results.map((result) => result.detection)];
	}
};
//#endregion
//#region src/host/server/routes/backends/get.ts
function getBackends() {
	return backend.getCatalog();
}
//#endregion
//#region src/host/config/constants.ts
const BRIDGE_PROVIDER = "dsh-tauri-kernel";
const KERNEL_RECORD_TYPE = "plugin:dsh-tauri-kernel/kernel";
const MODEL_RECORD_TYPE = "plugin:dsh-tauri-kernel/model";
//#endregion
//#region src/host/utils/abort.ts
async function waitFor(pending, signal) {
	if (signal.aborted) {
		pending.catch(() => void 0);
		signal.throwIfAborted();
	}
	let cancel;
	const aborted = new Promise((_, reject) => {
		cancel = () => reject(signal.reason);
		signal.addEventListener("abort", cancel, { once: true });
	});
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
//#endregion
//#region src/host/service/checkpoint.ts
/** Retained handle: the registry-level `stateOf` is deprecated in DSH 0.2.2. */
let handle$2;
const checkpoint = {
	async register() {
		const ctx = getHostContext();
		const lifetime = runtime.lifetime;
		const z = await loadRuntimeZod(ctx.loader);
		lifetime.signal.throwIfAborted();
		if (runtime.lifetime !== lifetime || getHostContext() !== ctx) throw new Error("BRIDGE_DISPOSED: Checkpoint projection owner changed during registration");
		const watermarkSchema = z.object({
			type: z.enum([KERNEL_RECORD_TYPE, MODEL_RECORD_TYPE]),
			seq: z.number().int().nonnegative(),
			encodedData: z.string()
		}).strict().readonly().nullable();
		const registered = await ctx.sessionProjections.register({
			key: "bridgeCheckpoint",
			stateSchema: z.object({
				ownerSessionId: z.string().min(1),
				inheritedEventCount: z.number().int().nonnegative(),
				binding: watermarkSchema,
				model: watermarkSchema
			}).strict().readonly(),
			init: (header, inheritedEventCount) => Object.freeze({
				ownerSessionId: header.id,
				inheritedEventCount,
				binding: null,
				model: null
			}),
			apply(state, event) {
				const type = event.type;
				if (event.ignorable !== true || type !== "plugin:dsh-tauri-kernel/model" && type !== "plugin:dsh-tauri-kernel/kernel") return state;
				if (type === "plugin:dsh-tauri-kernel/kernel" && event.seq < state.inheritedEventCount) return state;
				const watermark = Object.freeze({
					type,
					seq: event.seq,
					encodedData: encode(event.data)
				});
				return Object.freeze({
					...state,
					[type === "plugin:dsh-tauri-kernel/model" ? "model" : "binding"]: watermark
				});
			},
			stateVersion: 1
		});
		lifetime.signal.throwIfAborted();
		if (runtime.lifetime !== lifetime || getHostContext() !== ctx) {
			await registered.dispose();
			throw new Error("BRIDGE_DISPOSED: Checkpoint projection owner changed during registration");
		}
		handle$2 = registered;
		return async () => {
			if (handle$2 === registered) handle$2 = void 0;
			await registered.dispose();
		};
	},
	/** Folded checkpoint watermark state of one official session. */
	stateOf(value) {
		return handle$2?.stateOf(value);
	},
	mark(agent, type, seq, data) {
		const watermark = watermarks(agent).find((record) => record.type === type);
		if (watermark?.seq !== seq || watermark.encodedData !== encode(data)) throw new Error("BRIDGE_RECORD_NOT_COMMITTED: 官方记录的持久化水位不一致。");
		runtime.verified.get(agent)?.delete(type);
	},
	isVerified(agent) {
		return watermarks(agent).every((record) => sameWatermark(record, runtime.verified.get(agent)?.get(record.type)));
	},
	async flush(agent, signal, force = false) {
		const lifetime = runtime.lifetime;
		const scoped = AbortSignal.any([signal, lifetime.signal]);
		while (true) {
			assertLive$2(agent, lifetime, scoped);
			const previous = runtime.checkpoints.get(agent);
			if (previous) {
				await waitFor(previous.catch(() => void 0), scoped);
				continue;
			}
			const records = watermarks(agent).filter((record) => !sameWatermark(record, runtime.verified.get(agent)?.get(record.type)));
			if (records.length === 0 && !force) return;
			const task = persist(agent, records, lifetime, scoped);
			runtime.checkpoints.set(agent, task);
			task.finally(() => {
				if (runtime.checkpoints.get(agent) === task) runtime.checkpoints.delete(agent);
			}).catch(() => void 0);
			await waitFor(task, scoped);
			force = false;
		}
	}
};
function watermarks(agent) {
	const state = checkpoint.stateOf(agent.session);
	if (!state || state.ownerSessionId !== agent.id || state.inheritedEventCount !== agent.session.inheritedEventCount) throw new Error("BRIDGE_CORE_UNAVAILABLE: 官方会话记录的持久化投影不可用。");
	return [state.model, agent.session.header.isSeeded ? state.binding : null].filter((value) => value !== null);
}
async function persist(agent, records, lifetime, signal) {
	const ctx = getHostContext();
	const persistence = ctx.get("sessionPersistence");
	const refusal = records.length === 0 || records.some((record) => record.type === "plugin:dsh-tauri-kernel/model") ? "BRIDGE_MODEL_NOT_PERSISTED" : "BRIDGE_BINDING_NOT_PERSISTED";
	if (typeof persistence?.open !== "function" || typeof persistence.flush !== "function" || !await ctx.sessions.flush(agent.session)) throw new Error(`${refusal}: 官方会话记录无法持久保存。`);
	assertLive$2(agent, lifetime, signal);
	await persistence.flush();
	assertLive$2(agent, lifetime, signal);
	const reader = await persistence.open(agent.id, "read", { signal });
	try {
		assertLive$2(agent, lifetime, signal);
		const header = agent.session.header;
		if (reader.id !== agent.id || reader.header.id !== header.id || reader.header.cwd !== header.cwd || reader.header.agentPreset !== header.agentPreset || reader.header.parentSession !== header.parentSession || reader.header.isSeeded !== header.isSeeded || reader.inheritedEventCount !== agent.session.inheritedEventCount) throw new Error(`${refusal}: 官方持久会话与当前会话身份不一致。`);
		for (const record of records) {
			const { events } = await reader.read(record.seq, 1, { signal });
			assertLive$2(agent, lifetime, signal);
			const event = events[0];
			if (events.length !== 1 || event?.seq !== record.seq || event.type !== record.type || event.ignorable !== true || encode(event.data) !== record.encodedData) throw new Error(`${refusal}: 官方持久记录未包含当前选择或原生绑定。`);
		}
	} finally {
		await reader.close();
	}
	assertLive$2(agent, lifetime, signal);
	let verified = runtime.verified.get(agent);
	if (!verified) {
		verified = /* @__PURE__ */ new Map();
		runtime.verified.set(agent, verified);
	}
	for (const record of records) if (watermarks(agent).some((current) => sameWatermark(current, record))) verified.set(record.type, record);
}
function sameWatermark(left, right) {
	return right !== void 0 && left.type === right.type && left.seq === right.seq && left.encodedData === right.encodedData;
}
function encode(data) {
	if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("BRIDGE_RECORD_NOT_COMMITTED: 官方桥接记录必须是完整对象。");
	return JSON.stringify(data, Object.keys(data).sort());
}
function assertLive$2(agent, lifetime, signal) {
	signal.throwIfAborted();
	const ctx = getHostContext();
	if (!runtime.ready || runtime.lifetime !== lifetime || ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session) throw new Error("BRIDGE_AGENT_REPLACED: 官方会话已关闭或被替换。");
}
//#endregion
//#region src/host/service/identity.ts
/**
* The retained projection handle. DSH 0.2.2 turned `sessionProjections.register`
* into an awaitable that yields a `ProjectionHandle`; the deprecated
* registry-level `stateOf(session, key)` returns `unknown` and logs a warning,
* so every read in this plugin goes through the handle this module owns.
*/
let handle$1;
const identity = {
	async register() {
		const ctx = getHostContext();
		const lifetime = runtime.lifetime;
		const z = await loadRuntimeZod(ctx.loader);
		lifetime.signal.throwIfAborted();
		if (runtime.lifetime !== lifetime || getHostContext() !== ctx) throw new Error("BRIDGE_DISPOSED: Kernel projection owner changed during registration");
		const nonemptyId = z.string().min(1).refine((value) => value.trim().length > 0);
		const bindingSchema = z.object({
			backend: z.enum(["codex", "claude"]),
			nativeSessionId: nonemptyId,
			sessionId: nonemptyId
		}).strict().readonly();
		const viewSchema = bindingSchema.nullable();
		const stateSchema = z.object({
			ownerSessionId: nonemptyId,
			inheritedEventCount: z.number().int().nonnegative(),
			inheritedBinding: viewSchema,
			binding: viewSchema
		}).strict().readonly();
		const projections = ctx.get("sessionProjections");
		if (typeof projections?.register !== "function") throw new Error("BRIDGE_CORE_UNAVAILABLE: The official session projection registry is unavailable");
		const registered = await projections.register({
			key: "bridgeKernel",
			stateSchema,
			init: (header, inheritedEventCount) => Object.freeze({
				ownerSessionId: header.id,
				inheritedEventCount,
				inheritedBinding: null,
				binding: null
			}),
			apply(state, event) {
				if (event.type !== "plugin:dsh-tauri-kernel/kernel" || event.ignorable !== true) return state;
				const candidate = parseBinding(event.data);
				if (event.seq < state.inheritedEventCount) {
					if (state.inheritedBinding !== null && sameBinding$1(state.inheritedBinding, candidate)) return state;
					return Object.freeze({
						...state,
						inheritedBinding: candidate
					});
				}
				if (candidate.sessionId !== state.ownerSessionId) throw new Error("BRIDGE_INHERITED_SESSION: An inherited native binding cannot execute for a different official session");
				if (state.binding !== null) {
					assertSameBinding(state.binding, candidate);
					return state;
				}
				assertDistinctNative(state.inheritedBinding, candidate);
				return Object.freeze({
					...state,
					binding: candidate
				});
			},
			wire: {
				viewSchema,
				view: (state) => state.binding
			},
			stateVersion: 2
		});
		lifetime.signal.throwIfAborted();
		if (runtime.lifetime !== lifetime || getHostContext() !== ctx) {
			await registered.dispose();
			throw new Error("BRIDGE_DISPOSED: Kernel projection owner changed during registration");
		}
		handle$1 = registered;
		runtime.bindingSchema = bindingSchema;
		const dispose = ctx.on("agent/created", ({ agent, source }) => {
			if (source !== "resume" || identity.stateOf(agent.session)?.binding == null) return;
			const binding = identity.resolve(agent);
			const fallback = ctx.get("agentDefaultModel")?.currentSelection();
			if (agent.options.provider === void 0 && agent.options.model === void 0 || agent.options.provider === fallback?.provider && agent.options.model === fallback?.model) identity.hydrate(agent);
			else if (agent.options.provider === "dsh-tauri-kernel" && agent.options.model === binding.backend) identity.hydrate(agent);
		}, { global: true });
		return async () => {
			dispose();
			if (handle$1 === registered) handle$1 = void 0;
			if (runtime.bindingSchema === bindingSchema) runtime.bindingSchema = void 0;
			await registered.dispose();
		};
	},
	/** The committed kernel projection of one official session, or `undefined` before registration. */
	stateOf(value) {
		return handle$1?.stateOf(value);
	},
	hydrate(agent) {
		const binding = identity.resolve(agent);
		agent.options.provider = BRIDGE_PROVIDER;
		agent.options.model = binding.backend;
	},
	async append(agent, binding) {
		const candidate = parseBinding(binding);
		if (candidate.sessionId !== agent.session.id) throw new Error("BRIDGE_INHERITED_SESSION: A native binding must belong to the exact official session");
		const ctx = getHostContext();
		const previous = identity.requireState(agent.session);
		assertOwner(previous, agent.session);
		if (previous.binding !== null) assertSameBinding(parseBinding(previous.binding), candidate);
		assertDistinctNative(previous.inheritedBinding, candidate);
		const modules = await loadRuntimeModules(ctx.loader);
		const current = identity.requireState(agent.session);
		assertOwner(current, agent.session);
		if (current.binding !== null) {
			assertSameBinding(parseBinding(current.binding), candidate);
			return agent.session.seq - 1;
		}
		assertDistinctNative(current.inheritedBinding, candidate);
		const nextSeq = agent.session.seq;
		const committedSeq = modules.appendPluginRecord(agent.session, KERNEL_RECORD_TYPE, candidate);
		if (!Number.isSafeInteger(committedSeq) || committedSeq !== nextSeq || agent.session.seq !== nextSeq + 1) throw new Error("BRIDGE_BINDING_NOT_COMMITTED: The official plugin record was not appended at the session cursor");
		const committed = identity.requireState(agent.session);
		if (committed.binding === null) throw new Error("BRIDGE_BINDING_NOT_COMMITTED: The native identity is absent from the official projection");
		assertOwner(committed, agent.session);
		assertSameBinding(parseBinding(committed.binding), candidate);
		return committedSeq;
	},
	/** The registered handle's state, or the documented "projection is gone" failure. */
	requireState(value) {
		if (handle$1 === void 0) throw new Error("BRIDGE_CORE_UNAVAILABLE: The official kernel projection is not registered");
		return handle$1.stateOf(value);
	},
	resolve(agent) {
		const state = identity.requireState(agent.session);
		assertOwner(state, agent.session);
		if (state.binding === null) throw new Error("BRIDGE_BINDING_MISSING: The official session has no native kernel binding");
		const binding = parseBinding(state.binding);
		if (binding.sessionId !== agent.session.id) throw new Error("BRIDGE_INHERITED_SESSION: An inherited native binding cannot execute for a different official session");
		return binding;
	},
	inherited(value) {
		const state = identity.requireState(value);
		assertOwner(state, value);
		if (state.inheritedBinding === null) return null;
		const binding = parseBinding(state.inheritedBinding);
		if (value.header.isSeeded !== true || !value.header.parentSession || state.inheritedEventCount === 0 || binding.sessionId !== value.header.parentSession) throw new Error("BRIDGE_INHERITED_SESSION: The inherited native binding must belong to the exact official fork parent");
		return binding;
	}
};
function parseBinding(value) {
	if (!runtime.bindingSchema) throw new Error("BRIDGE_CORE_UNAVAILABLE: The official kernel projection is not registered");
	const parsed = runtime.bindingSchema.safeParse(value);
	if (!parsed.success) throw new Error("BRIDGE_BINDING_INVALID: Expected a complete supported backend, nonempty native session id, and nonempty official session id");
	return parsed.data;
}
function assertSameBinding(current, candidate) {
	if (!sameBinding$1(current, candidate)) throw new Error("BRIDGE_BINDING_IMMUTABLE: The official native kernel binding cannot be replaced");
}
function sameBinding$1(current, candidate) {
	return current.backend === candidate.backend && current.nativeSessionId === candidate.nativeSessionId && current.sessionId === candidate.sessionId;
}
function assertOwner(state, session) {
	if (state.ownerSessionId !== session.id || state.inheritedEventCount !== session.inheritedEventCount) throw new Error("BRIDGE_INHERITED_SESSION: The native projection must belong to the exact official session and fork boundary");
}
function assertDistinctNative(inherited, candidate) {
	if (inherited?.backend === candidate.backend && inherited.nativeSessionId === candidate.nativeSessionId) throw new Error("BRIDGE_INHERITED_SESSION: A fork must receive a distinct native session identity");
}
//#endregion
//#region src/host/backends/transport.ts
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const MAX_QUEUED_FRAMES = 8192;
const CLOSE_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 6e4;
const INTERRUPT_TIMEOUT_MS = 5e3;
var NativeBridgeError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "NativeBridgeError";
	}
};
function errorFrom(value) {
	return value instanceof Error ? value : new Error(String(value));
}
function abortError(signal) {
	return signal.reason instanceof Error ? signal.reason : new NativeBridgeError("BRIDGE_ABORTED", "Native turn was cancelled");
}
function record(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Expected a native protocol object");
	return value;
}
function stringField(value, key) {
	if (typeof value[key] !== "string" || value[key] === "") throw new NativeBridgeError("BRIDGE_PROTOCOL", `Missing native protocol field: ${key}`);
	return value[key];
}
/**
* Split official user content into ordered native runs, preserving the model's
* original text/image interleaving. Adjacent text merges into one run, an image
* keeps its durable reference so each kernel resolves the host path or the
* verified bytes it needs, and a message with no blocks keeps one empty text
* run. Content no native kernel accepts fails closed rather than submitting a
* partial prompt.
* @param messages - the admitted official user messages.
* @param attachments - official attachment access, absent without an image provider.
* @returns one ordered run list per message.
*/
function nativeRuns(messages, attachments) {
	return messages.map((message) => {
		const runs = [];
		for (const block of message.content) {
			if (block.type === "text") {
				const last = runs.at(-1);
				if (last?.type === "text") runs[runs.length - 1] = {
					type: "text",
					text: last.text + block.text
				};
				else runs.push({
					type: "text",
					text: block.text
				});
				continue;
			}
			if (block.type === "image" && attachments !== void 0) {
				runs.push({
					type: "image",
					ref: block.attachment
				});
				continue;
			}
			throw new NativeBridgeError("BRIDGE_UNSUPPORTED_CONTENT", `Native bridge does not yet support user content: ${block.type}`);
		}
		return runs.length === 0 ? [{
			type: "text",
			text: ""
		}] : runs;
	});
}
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	promise.catch(() => {});
	return {
		promise,
		resolve,
		reject
	};
}
var JsonLinesProcess = class {
	child;
	closed = deferred();
	input = "";
	stderr = "";
	failure;
	closing;
	stopped = false;
	exited = false;
	queue = [];
	draining = false;
	handler;
	failureHandler;
	constructor(command, args, cwd) {
		if (/\.(?:cmd|bat)$/i.test(command.file)) throw new NativeBridgeError("BRIDGE_UNSAFE_EXECUTABLE", "Resolve Windows batch shims to the native executable or node + official entrypoint");
		this.child = spawn(command.file, [...command.args, ...args], {
			cwd,
			env: command.env ?? nativeEnvironment(),
			shell: false,
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.readChunk(chunk));
		this.child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-16384);
		});
		this.child.stdout.on("error", (error) => this.fail(error));
		this.child.stdin.on("error", (error) => this.fail(error));
		this.child.on("error", (error) => this.fail(error));
		this.child.once("close", (code, signal) => {
			if (!this.stopped) this.fail(new NativeBridgeError("BRIDGE_PROCESS_EXIT", `Native process exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
			this.stopped = true;
			this.exited = true;
			this.closed.resolve();
		});
	}
	onMessage(handler) {
		this.handler = handler;
		this.drain();
	}
	onFailure(handler) {
		this.failureHandler = handler;
		if (this.failure) handler(this.failure);
	}
	write(value) {
		if (this.failure) throw this.failure;
		if (this.stopped || !this.child.stdin.writable) throw new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Native process is not writable");
		const line = `${JSON.stringify(value)}\n`;
		if (line.length > MAX_FRAME_CHARS) throw new NativeBridgeError("BRIDGE_FRAME_LIMIT", "Native protocol frame exceeds the bounded transport limit");
		this.child.stdin.write(line);
	}
	fail(error) {
		if (this.failure) return;
		this.failure = error;
		this.queue = [];
		this.failureHandler?.(error);
		this.close().catch(() => {});
	}
	close(graceful = false) {
		this.closing ??= this.stop(graceful);
		return this.closing;
	}
	async stop(graceful) {
		if (this.exited) return;
		this.stopped = true;
		this.queue = [];
		if (graceful) {
			this.child.stdin.end();
			if (await this.waitForExit()) return;
		}
		this.child.stdin.destroy();
		this.child.kill("SIGTERM");
		if (await this.waitForExit()) return;
		this.child.kill("SIGKILL");
		if (!await this.waitForExit()) throw new NativeBridgeError("BRIDGE_PROCESS_STOP_TIMEOUT", "Native process did not exit after termination");
	}
	async waitForExit() {
		let timer;
		const exited = await Promise.race([this.closed.promise.then(() => true), new Promise((resolve) => {
			timer = setTimeout(resolve, CLOSE_TIMEOUT_MS, false);
		})]);
		clearTimeout(timer);
		return exited;
	}
	readChunk(chunk) {
		if (this.stopped) return;
		this.input += chunk;
		let end = this.input.indexOf("\n");
		while (end >= 0) {
			const line = this.input.slice(0, end).trim();
			this.input = this.input.slice(end + 1);
			if (line.length > MAX_FRAME_CHARS) {
				this.fail(new NativeBridgeError("BRIDGE_FRAME_LIMIT", "Native protocol frame exceeds the bounded transport limit"));
				return;
			}
			if (line) try {
				const message = record(JSON.parse(line));
				const result = this.handler?.(message);
				if (result) Promise.resolve(result).catch((error) => this.fail(errorFrom(error)));
				else if (!this.handler) this.queue.push(message);
			} catch (error) {
				this.fail(error instanceof NativeBridgeError ? error : new NativeBridgeError("BRIDGE_PROTOCOL", `Invalid native JSONL: ${errorFrom(error).message}`));
				return;
			}
			if (this.queue.length > MAX_QUEUED_FRAMES) {
				this.fail(new NativeBridgeError("BRIDGE_QUEUE_LIMIT", "Native notification queue exceeded its bounded limit"));
				return;
			}
			if (this.stopped || this.failure) return;
			end = this.input.indexOf("\n");
		}
		if (this.input.length > MAX_FRAME_CHARS) this.fail(new NativeBridgeError("BRIDGE_FRAME_LIMIT", "Native protocol frame exceeds the bounded transport limit"));
	}
	drain() {
		if (this.draining || !this.handler || this.stopped || this.failure) return;
		this.draining = true;
		try {
			for (const message of this.queue.splice(0)) {
				if (this.stopped || this.failure) break;
				const result = this.handler(message);
				if (result) Promise.resolve(result).catch((error) => this.fail(errorFrom(error)));
			}
		} catch (error) {
			this.fail(errorFrom(error));
		} finally {
			this.draining = false;
		}
	}
};
var PendingRequests = class {
	write;
	requests = /* @__PURE__ */ new Map();
	constructor(write) {
		this.write = write;
	}
	request(id, frame, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
		if (signal?.aborted) return Promise.reject(abortError(signal));
		const result = deferred();
		const finish = (error) => {
			const pending = this.requests.get(id);
			if (!pending) return;
			this.requests.delete(id);
			clearTimeout(pending.timer);
			pending.removeAbort();
			result.reject(error);
		};
		const aborted = () => finish(abortError(signal));
		const timer = setTimeout(() => finish(new NativeBridgeError("BRIDGE_REQUEST_TIMEOUT", "Native control request timed out")), timeoutMs);
		const removeAbort = () => signal?.removeEventListener("abort", aborted);
		this.requests.set(id, {
			result,
			timer,
			removeAbort
		});
		signal?.addEventListener("abort", aborted, { once: true });
		try {
			this.write(frame);
		} catch (error) {
			finish(errorFrom(error));
		}
		return result.promise;
	}
	settle(id, value, error) {
		const pending = this.requests.get(id);
		if (!pending) return;
		this.requests.delete(id);
		clearTimeout(pending.timer);
		pending.removeAbort();
		if (error) pending.result.reject(error);
		else pending.result.resolve(value);
	}
	failAll(error) {
		for (const id of this.requests.keys()) this.settle(id, void 0, error);
	}
};
//#endregion
//#region src/host/backends/claude.ts
/**
* Convert one Claude API usage record into the official vocabulary, whose cache
* counts are disjoint from `inputTokens` (the CLI already reports them apart,
* so nothing is subtracted; source/dsh-tui/src/backends/claude/translate/content.ts:13-22).
*/
function claudeUsage(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
	const fields = value;
	const count = (key) => {
		const raw = fields[key];
		return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : void 0;
	};
	const input = count("input_tokens");
	const output = count("output_tokens");
	const cacheRead = count("cache_read_input_tokens");
	const cacheWrite = count("cache_creation_input_tokens");
	if (input === void 0 && output === void 0 && cacheRead === void 0 && cacheWrite === void 0) return void 0;
	return {
		inputTokens: input ?? 0,
		outputTokens: output ?? 0,
		...cacheRead === void 0 || cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
		...cacheWrite === void 0 || cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }
	};
}
const TERMINAL_TASK_STATUSES = /* @__PURE__ */ new Set([
	"completed",
	"failed",
	"stopped",
	"killed"
]);
const DEFERRING_TASK_TYPES = /* @__PURE__ */ new Set(["local_agent", "local_workflow"]);
const SESSION_START_HOOK_ID = "dsh-native-session-identity";
function questionsOf(input) {
	if (!Array.isArray(input.questions) || input.questions.length === 0) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude user-input request is missing questions");
	const ids = /* @__PURE__ */ new Set();
	return input.questions.map((value) => {
		const question = record(value);
		const id = stringField(question, "question");
		if (ids.has(id)) throw new NativeBridgeError("BRIDGE_UNSUPPORTED_QUESTION", "Claude question text must be unique to preserve answer identities");
		ids.add(id);
		if (question.isSecret === true) throw new NativeBridgeError("BRIDGE_UNSUPPORTED_QUESTION", "Secret native questions cannot be recorded in the official session log");
		return {
			id,
			question: id,
			...typeof question.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {},
			...Array.isArray(question.options) ? { options: question.options.map((value) => {
				const option = record(value);
				return {
					label: stringField(option, "label"),
					...typeof option.description === "string" ? { description: option.description } : {}
				};
			}) } : {}
		};
	});
}
function resultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude tool result is missing content");
	return content.map((value) => {
		const block = record(value);
		return block.type === "text" && typeof block.text === "string" ? block.text : JSON.stringify(block);
	}).join("\n");
}
var ClaudeSession = class {
	sink;
	options;
	attachments;
	transport;
	requests;
	approvals = /* @__PURE__ */ new Map();
	nativeId;
	active;
	failure;
	disposed = false;
	opening = true;
	disposePromise;
	identity = deferred();
	identityConfirmed = false;
	identityTimer;
	capabilities = /* @__PURE__ */ new Set();
	startupModel;
	effectiveModel;
	defaultsPending;
	catalog;
	appliedOptions = {
		model: null,
		reasoningEffort: null
	};
	permission;
	constructor(command, cwd, storedId, sink, options, attachments) {
		this.sink = sink;
		this.options = options;
		this.attachments = attachments;
		this.nativeId = options?.forkFrom ? "" : storedId ?? randomUUID();
		this.defaultsPending = storedId !== null || options?.forkFrom !== void 0;
		this.permission = options?.permission ? { ...options.permission } : void 0;
		this.transport = new JsonLinesProcess({
			...command,
			env: {
				...command.env ?? nativeEnvironment(),
				CLAUDE_CODE_SDK_READS_SESSION_STATE: "1"
			}
		}, [
			"--print",
			"--verbose",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--permission-prompt-tool",
			"stdio",
			"--allow-dangerously-skip-permissions",
			"--settings",
			"{\"useAutoModeDuringPlan\":false}",
			...options?.permission ? ["--permission-mode", "default"] : [],
			...options?.forkFrom ? [`--resume=${options.forkFrom}`, "--fork-session"] : [storedId === null ? `--session-id=${this.id}` : `--resume=${this.id}`]
		], cwd);
		this.requests = new PendingRequests((value) => this.transport.write(value));
		this.transport.onFailure((error) => {
			this.failure = error;
			this.identity.reject(error);
			this.requests.failAll(error);
			this.active?.result.reject(error);
			this.withdrawApprovals(error);
		});
		this.transport.onMessage((message) => this.receive(message));
	}
	get id() {
		return this.nativeId;
	}
	async open(signal) {
		const aborted = () => this.identity.reject(abortError(signal));
		try {
			signal.throwIfAborted();
			signal.addEventListener("abort", aborted, { once: true });
			this.identityTimer = setTimeout(() => {
				const error = new NativeBridgeError("BRIDGE_NATIVE_BIND_UNCONFIRMED", "Claude did not acknowledge the native session before user input; a reserved UUID is not a running conversation");
				this.identity.reject(error);
				this.requests.failAll(error);
			}, REQUEST_TIMEOUT_MS);
			const initialization = {
				subtype: "initialize",
				hooks: { SessionStart: [{ hookCallbackIds: [SESSION_START_HOOK_ID] }] }
			};
			const response = record(await this.control(initialization, signal));
			this.checkIdentity(response);
			this.noteCapabilities(response);
			if (response.models !== void 0) this.catalog = this.modelCatalog(response.models, this.startupModel);
			if (this.failure) throw this.failure;
			if (!this.identityConfirmed) {
				const snapshot = record(await this.control(initialization, signal));
				this.checkIdentity(snapshot);
			}
			await this.identity.promise;
			if (this.failure) throw this.failure;
			signal.throwIfAborted();
			this.opening = false;
		} catch (error) {
			await this.dispose();
			throw error;
		} finally {
			clearTimeout(this.identityTimer);
			signal.removeEventListener("abort", aborted);
		}
	}
	modelCatalog(values, defaultModel) {
		if (!Array.isArray(values)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude initialization is missing supported models");
		const models = /* @__PURE__ */ new Map();
		const resolved = /* @__PURE__ */ new Map();
		for (const value of values) {
			const model = record(value);
			const id = stringField(model, "value");
			const levels = model.supportedEffortLevels;
			if (levels !== void 0 && (!Array.isArray(levels) || levels.some((value) => typeof value !== "string" || value === ""))) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude model reasoning capabilities are invalid");
			const efforts = Array.isArray(levels) && model.supportsEffort !== false ? levels.map((id) => ({
				id: String(id),
				name: String(id)
			})) : [];
			const info = {
				id,
				name: stringField(model, "displayName"),
				...typeof model.description === "string" ? { description: model.description } : {},
				...efforts.length > 0 ? { reasoning: { efforts } } : {}
			};
			models.set(id, info);
			if (typeof model.resolvedModel === "string" && model.resolvedModel !== "") resolved.set(model.resolvedModel, id);
			if (models.size > 1e4) throw new NativeBridgeError("BRIDGE_PROTOCOL_LIMIT", "Claude model listing exceeded its limit");
		}
		const anchor = defaultModel ?? this.effectiveModel;
		const name = anchor === void 0 ? "default" : models.has(anchor) ? anchor : resolved.get(anchor) ?? "default";
		return {
			models: [...models.values()],
			...models.has(name) ? { defaultModel: name } : {}
		};
	}
	async models(signal) {
		signal.throwIfAborted();
		if (this.disposed || this.failure) throw this.failure ?? new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Claude session was disposed");
		if (!this.catalog) throw new NativeBridgeError("BRIDGE_MODEL_DISCOVERY_UNAVAILABLE", "Claude did not expose supported models in its public initialize response");
		const models = [...this.catalog.models];
		for (const id of [this.startupModel, this.effectiveModel]) if (id && !models.some((model) => model.id === id)) models.push({
			id,
			name: id
		});
		return {
			...this.catalog,
			models
		};
	}
	async applyOptions(options, signal) {
		if (options.model === null && options.reasoningEffort === null && this.appliedOptions.model === null && this.appliedOptions.reasoningEffort === null) return;
		const modelChanged = this.defaultsPending || options.model !== this.appliedOptions.model;
		const effortChanged = this.defaultsPending || options.reasoningEffort !== this.appliedOptions.reasoningEffort;
		if (!modelChanged && !effortChanged) return;
		if (options.model !== null || options.reasoningEffort !== null) {
			const catalog = await this.models(signal);
			const model = options.model ?? (modelChanged ? void 0 : this.startupModel);
			if (!model) throw new NativeBridgeError("BRIDGE_DEFAULT_UNAVAILABLE", "Claude did not report a provable default model for reasoning validation");
			const info = catalog.models.find((value) => value.id === model);
			if (options.model !== null && !info) throw new NativeBridgeError("BRIDGE_MODEL_UNAVAILABLE", `Claude did not advertise model: ${options.model}`);
			if (options.reasoningEffort !== null && !info?.reasoning?.efforts.some((value) => value.id === options.reasoningEffort)) throw new NativeBridgeError("BRIDGE_EFFORT_UNSUPPORTED", `Claude did not advertise reasoning effort ${options.reasoningEffort} for ${model}`);
		}
		try {
			if (modelChanged) {
				await this.control({
					subtype: "set_model",
					model: options.model
				}, signal);
				this.effectiveModel = options.model ?? void 0;
				if (options.model === null) this.startupModel = void 0;
			}
			if (effortChanged || modelChanged) await this.control({
				subtype: "apply_flag_settings",
				settings: { effortLevel: options.reasoningEffort }
			}, signal);
			this.appliedOptions = options;
			this.defaultsPending = false;
		} catch (error) {
			this.transport.fail(errorFrom(error));
			throw error;
		}
	}
	async applyPermission(permission, signal) {
		const mode = permission.sandbox === "read-only" ? "plan" : permission.sandbox === "workspace-write" ? "acceptEdits" : permission.approval === "never" ? permission.sandbox === "danger-full-access" ? "bypassPermissions" : "dontAsk" : "default";
		try {
			const response = record(await this.control({
				subtype: "set_permission_mode",
				mode
			}, signal));
			if (response.mode !== void 0 && response.mode !== mode) throw new NativeBridgeError("BRIDGE_PERMISSION_MISMATCH", "Claude 未确认请求的权限模式，已阻止本轮运行。");
		} catch (error) {
			this.transport.fail(errorFrom(error));
			throw error;
		}
	}
	async submit(messages, signal, options, permission) {
		signal.throwIfAborted();
		if (this.disposed || this.failure) throw this.failure ?? new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Claude session was disposed");
		if (this.active) throw new NativeBridgeError("BRIDGE_BUSY", "Claude native session already has an active run");
		const runs = nativeRuns(messages, this.attachments);
		if (runs.length === 0) throw new NativeBridgeError("BRIDGE_EMPTY_INPUT", "Claude native run requires a user message");
		const selection = options ? { ...options } : void 0;
		const policy = permission ? { ...permission } : this.permission;
		const run = {
			result: deferred(),
			signal,
			messages: /* @__PURE__ */ new Map(),
			finalFrames: /* @__PURE__ */ new Map(),
			lanes: /* @__PURE__ */ new Map(),
			tools: /* @__PURE__ */ new Set(),
			endedTools: /* @__PURE__ */ new Set(),
			tasks: /* @__PURE__ */ new Set(),
			deferringTasks: /* @__PURE__ */ new Set(),
			stoppedTasks: /* @__PURE__ */ new Set(),
			resultReceived: false,
			inputId: randomUUID(),
			submitted: false,
			interruptPending: false,
			interruptSent: false
		};
		this.active = run;
		const aborted = () => {
			if (run.submitted) this.interrupt(run);
		};
		signal.addEventListener("abort", aborted, { once: true });
		try {
			if (policy) {
				await this.applyPermission(policy, signal);
				this.permission = policy;
			}
			if (selection && (this.defaultsPending || selection.model !== this.appliedOptions.model || selection.reasoningEffort !== this.appliedOptions.reasoningEffort)) await this.applyOptions(selection, signal);
			signal.throwIfAborted();
			const content = [];
			for (const run of runs.flat()) {
				if (run.type === "text") {
					content.push({
						type: "text",
						text: run.text
					});
					continue;
				}
				const source = await this.attachments.read(run.ref, signal);
				if (source.base64 === void 0) throw new NativeBridgeError("BRIDGE_PROTOCOL", "The official attachment store returned no readable image bytes");
				content.push({
					type: "image",
					source: {
						type: "base64",
						media_type: source.mediaType,
						data: source.base64
					}
				});
			}
			signal.throwIfAborted();
			run.submitted = true;
			this.transport.write({
				type: "user",
				session_id: this.id,
				uuid: run.inputId,
				parent_tool_use_id: null,
				message: {
					role: "user",
					content
				}
			});
			await run.result.promise;
			signal.throwIfAborted();
		} catch (error) {
			if (run.submitted && !signal.aborted) this.transport.fail(errorFrom(error));
			throw this.failure ?? (signal.aborted ? abortError(signal) : error);
		} finally {
			signal.removeEventListener("abort", aborted);
			clearTimeout(run.interruptTimer);
			this.withdrawApprovals(new NativeBridgeError("BRIDGE_REQUEST_CLOSED", "Native run has ended"));
			this.active = void 0;
		}
	}
	dispose() {
		this.disposePromise ??= this.close();
		return this.disposePromise;
	}
	async close() {
		this.disposed = true;
		const error = new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Claude native session was disposed");
		this.identity.reject(error);
		clearTimeout(this.identityTimer);
		this.withdrawApprovals(error);
		this.requests.failAll(error);
		this.active?.result.reject(error);
		try {
			await this.transport.close(this.active === void 0);
		} catch {}
	}
	control(request, signal, timeoutMs) {
		const id = randomUUID();
		return this.requests.request(id, {
			type: "control_request",
			request_id: id,
			request
		}, signal, timeoutMs);
	}
	checkIdentity(message, required = false) {
		if (required || typeof message.session_id === "string") {
			const id = stringField(message, "session_id");
			if (this.opening && this.options?.forkFrom && this.nativeId === "") {
				if (id === this.options.forkFrom) throw new NativeBridgeError("BRIDGE_FORK_MISMATCH", "Claude fork did not acknowledge a new native session");
				this.nativeId = id;
			} else if (id !== this.id) throw new NativeBridgeError("BRIDGE_RESUME_MISMATCH", "Claude reported a different native session; refusing to replace the stored binding");
			this.identityConfirmed = true;
			this.identity.resolve();
		}
	}
	noteCapabilities(message) {
		if (Array.isArray(message.capabilities)) {
			for (const capability of message.capabilities) if (typeof capability === "string") this.capabilities.add(capability);
		}
	}
	receive(message) {
		const type = stringField(message, "type");
		if (type === "control_response") {
			const response = record(message.response);
			const id = stringField(response, "request_id");
			if (response.subtype === "success") this.requests.settle(id, response.response ?? {});
			else if (response.subtype === "error") this.requests.settle(id, void 0, new NativeBridgeError("BRIDGE_NATIVE_REQUEST", stringField(response, "error")));
			else throw new NativeBridgeError("BRIDGE_PROTOCOL", "Unsupported Claude control response");
			return;
		}
		if (type === "control_request") {
			const id = stringField(message, "request_id");
			this.answer(id, record(message.request)).catch((error) => this.transport.fail(errorFrom(error)));
			return;
		}
		if (type === "control_cancel_request") {
			const id = stringField(message, "request_id");
			this.approvals.get(id)?.abort(new NativeBridgeError("BRIDGE_REQUEST_CLOSED", "Claude withdrew the control request"));
			this.approvals.delete(id);
			return;
		}
		if (type === "conversation_reset") throw new NativeBridgeError("BRIDGE_NATIVE_RESET", "Claude reset its conversation; the existing official session binding cannot be silently changed");
		const run = this.active;
		if (type === "result") {
			const error = message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools" ? new NativeBridgeError("BRIDGE_NATIVE_INTERRUPTED", "Claude interrupted its native turn") : message.is_error === true || message.subtype !== "success" ? new NativeBridgeError("BRIDGE_NATIVE_TURN", typeof message.result === "string" && message.result !== "" ? message.result : JSON.stringify(message.errors ?? message.subtype)) : void 0;
			if (!run && error) {
				this.transport.fail(error);
				return;
			}
			this.checkIdentity(message, true);
			if (!run) {
				if (!this.opening) throw new NativeBridgeError("BRIDGE_UNEXPECTED_TURN", "Claude completed a run outside the official agent turn");
				return;
			}
			run.resultReceived = true;
			run.error = error;
			const usage = claudeUsage(message.usage);
			if (usage !== void 0) this.sink.usage(usage);
			this.finish(run);
			return;
		}
		this.checkIdentity(message, type === "system" && (message.subtype === "init" || message.subtype === "background_tasks_changed"));
		if (type === "system" && message.subtype === "init") {
			this.noteCapabilities(message);
			if (this.opening && typeof message.model === "string" && message.model !== "") {
				this.effectiveModel ??= message.model;
				if (!this.defaultsPending) this.startupModel ??= message.model;
			}
		}
		if (!run) {
			if (type === "assistant" || type === "stream_event" || type === "system" && message.subtype === "task_started") throw new NativeBridgeError("BRIDGE_UNEXPECTED_TURN", "Claude produced work outside the official agent turn");
			return;
		}
		switch (type) {
			case "system":
				if (message.subtype === "session_state_changed") {
					run.state = stringField(message, "state");
					if (run.state === "idle" && !run.resultReceived) {
						run.error ??= new NativeBridgeError("BRIDGE_NATIVE_INTERRUPTED", "Claude went idle without reporting a turn result");
						run.resultReceived = true;
					}
					this.finish(run);
				} else if (message.subtype === "task_started") {
					const id = stringField(message, "task_id");
					run.tasks.add(id);
					if (typeof message.task_type === "string" && DEFERRING_TASK_TYPES.has(message.task_type)) run.deferringTasks.add(id);
					if (run.signal.aborted) this.stopTask(run, id);
				} else if (message.subtype === "task_notification") {
					const id = stringField(message, "task_id");
					run.tasks.delete(id);
					run.deferringTasks.delete(id);
					this.finish(run);
				} else if (message.subtype === "task_updated") {
					const status = record(message.patch).status;
					if (typeof status === "string" && TERMINAL_TASK_STATUSES.has(status)) {
						const id = stringField(message, "task_id");
						run.tasks.delete(id);
						run.deferringTasks.delete(id);
						this.finish(run);
					}
				}
				return;
			case "stream_event":
				if (message.parent_tool_use_id != null) return;
				run.resultReceived = false;
				run.error = void 0;
				this.stream(run, message);
				return;
			case "assistant":
				if (message.parent_tool_use_id != null) return;
				if (typeof message.uuid === "string") {
					const body = JSON.stringify(message.message);
					const previous = run.finalFrames.get(message.uuid);
					if (previous !== void 0) {
						if (previous !== body) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude changed a previously settled assistant frame");
						return;
					}
					run.finalFrames.set(message.uuid, body);
				}
				if (message.parent_tool_use_id == null) {
					run.resultReceived = false;
					run.error = void 0;
				}
				this.assistant(run, record(message.message));
				return;
			case "user": if (message.parent_tool_use_id == null) this.toolResults(run, record(message.message));
		}
	}
	finish(run) {
		if (!run.resultReceived || (run.signal.aborted ? run.tasks.size : run.deferringTasks.size) !== 0 || run.interruptPending || run.state !== void 0 && run.state !== "idle") return;
		if (run.error && !run.signal.aborted) run.result.reject(run.error);
		else run.result.resolve();
	}
	stream(run, message) {
		const event = record(message.event);
		const lane = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : "";
		if (event.type === "message_start") {
			const id = stringField(record(event.message), "id");
			run.lanes.set(lane, id);
			if (!run.messages.has(id)) run.messages.set(id, {
				blocks: /* @__PURE__ */ new Map(),
				nextFinalIndex: 0
			});
			return;
		}
		const id = run.lanes.get(lane);
		if (!id) return;
		const state = run.messages.get(id);
		if (event.type === "content_block_start") {
			const index = this.blockIndex(event);
			const block = record(event.content_block);
			state.blocks.set(index, {
				type: stringField(block, "type"),
				...typeof block.id === "string" ? { callId: block.id } : {}
			});
			const nativeId = `${id}:block:${index}`;
			if (block.type === "text" && typeof block.text === "string" && block.text !== "") this.sink.text(nativeId, block.text);
			else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") this.sink.thinking(nativeId, block.thinking);
		} else if (event.type === "content_block_delta") {
			const index = this.blockIndex(event);
			const delta = record(event.delta);
			const nativeId = `${id}:block:${index}`;
			if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") this.sink.text(nativeId, delta.text);
			else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") this.sink.thinking(nativeId, delta.thinking);
		}
	}
	blockIndex(event) {
		if (typeof event.index !== "number" || !Number.isSafeInteger(event.index) || event.index < 0) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude stream block index is invalid");
		return event.index;
	}
	assistant(run, body) {
		const id = stringField(body, "id");
		if (!Array.isArray(body.content)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude assistant message is missing content");
		const state = run.messages.get(id) ?? {
			blocks: /* @__PURE__ */ new Map(),
			nextFinalIndex: 0
		};
		run.messages.set(id, state);
		const aggregate = body.content.length > 1;
		for (const [position, value] of body.content.entries()) {
			const block = record(value);
			const type = stringField(block, "type");
			const serialized = JSON.stringify(block);
			const matching = [...state.blocks.entries()].find(([, existing]) => existing.final === void 0 && existing.type === type && (type !== "tool_use" || existing.callId === block.id));
			const index = (aggregate && state.blocks.get(position)?.type === type ? position : void 0) ?? matching?.[0] ?? state.nextFinalIndex;
			const existing = state.blocks.get(index);
			if (existing?.final === serialized) continue;
			if (existing?.final !== void 0) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude changed a previously settled assistant block");
			state.blocks.set(index, {
				type,
				final: serialized,
				...typeof block.id === "string" ? { callId: block.id } : {}
			});
			state.nextFinalIndex = Math.max(state.nextFinalIndex, index + 1);
			let content;
			if (type === "text" && typeof block.text === "string") content = {
				type: "text",
				text: block.text
			};
			else if (type === "thinking" && typeof block.thinking === "string") content = {
				type: "thinking",
				text: block.thinking
			};
			else if (type === "tool_use") content = {
				type: "tool-call",
				id: stringField(block, "id"),
				name: stringField(block, "name"),
				arguments: JSON.stringify(block.input ?? {})
			};
			else if (type === "redacted_thinking") continue;
			else throw new NativeBridgeError("BRIDGE_UNSUPPORTED_EVENT", `Unsupported Claude assistant content: ${type}`);
			this.sink.assistant(`${id}:block:${index}`, [content]);
			if (content.type === "tool-call" && !run.tools.has(content.id)) {
				run.tools.add(content.id);
				this.sink.toolStart(content.id, content.name, content.arguments);
			}
		}
	}
	toolResults(run, body) {
		if (!Array.isArray(body.content)) return;
		for (const value of body.content) {
			const block = record(value);
			if (block.type !== "tool_result") continue;
			const id = stringField(block, "tool_use_id");
			if (run.endedTools.has(id)) continue;
			if (!run.tools.has(id)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude tool result has no native tool call in the active run");
			run.endedTools.add(id);
			this.sink.toolEnd(id, resultText(block.content), block.is_error === true);
		}
	}
	interrupt(run) {
		if (run.interruptSent) return;
		run.interruptSent = true;
		run.interruptTimer = setTimeout(() => {
			this.transport.fail(new NativeBridgeError("BRIDGE_INTERRUPT_TIMEOUT", "Claude did not settle the interrupted run; its process was closed"));
		}, INTERRUPT_TIMEOUT_MS);
		run.interruptPending = true;
		const settle = () => {
			run.interruptPending = false;
			this.finish(run);
		};
		this.control({
			subtype: "interrupt",
			...this.capabilities.has("interrupt_cancel_queued_v1") ? { cancel_queued: true } : {}
		}, void 0, INTERRUPT_TIMEOUT_MS).then(settle, settle);
		for (const id of run.tasks) this.stopTask(run, id);
	}
	stopTask(run, id) {
		if (run.stoppedTasks.has(id)) return;
		run.stoppedTasks.add(id);
		this.control({
			subtype: "stop_task",
			task_id: id
		}, void 0, INTERRUPT_TIMEOUT_MS).catch(() => {});
	}
	withdrawApprovals(error) {
		for (const controller of this.approvals.values()) controller.abort(error);
		this.approvals.clear();
	}
	async answer(id, request) {
		const controller = new AbortController();
		this.approvals.set(id, controller);
		const run = this.active;
		const signal = run ? AbortSignal.any([run.signal, controller.signal]) : controller.signal;
		try {
			if (request.subtype === "hook_callback") {
				const input = record(request.input);
				if (request.callback_id !== SESSION_START_HOOK_ID || input.hook_event_name !== "SessionStart") throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude invoked an unregistered native identity hook");
				this.checkIdentity(input, true);
				if (this.opening && typeof input.model === "string" && input.model !== "") {
					this.effectiveModel ??= input.model;
					if (!this.defaultsPending) this.startupModel ??= input.model;
				}
				this.transport.write({
					type: "control_response",
					response: {
						subtype: "success",
						request_id: id,
						response: {}
					}
				});
				return;
			}
			if (request.subtype !== "can_use_tool") {
				this.replyError(id, `Unsupported native control request: ${String(request.subtype)}`);
				return;
			}
			const tool = stringField(request, "tool_name");
			const input = record(request.input);
			const callId = stringField(request, "tool_use_id");
			let response = {
				behavior: "deny",
				message: "Native tool request is unavailable or cancelled"
			};
			if (run && !signal.aborted && !this.disposed) {
				if (tool === "AskUserQuestion") {
					const questions = questionsOf(input);
					const received = await this.sink.questions(callId, questions, signal);
					const answers = Object.fromEntries(questions.map((question) => {
						const value = received[question.id];
						if (typeof value !== "string" && !Array.isArray(value)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Claude question response is missing an answer");
						return [question.id, Array.isArray(value) ? value.join(", ") : value];
					}));
					if (!signal.aborted) response = {
						behavior: "allow",
						updatedInput: {
							...input,
							answers
						}
					};
				} else if (this.permission?.sandbox === "read-only") response = {
					behavior: "deny",
					message: "当前会话为只读；请先在权限菜单切换模式。"
				};
				else if (this.permission?.approval !== "never") {
					if (await this.sink.approval(callId, {
						kind: tool === "Bash" ? "command" : [
							"Write",
							"Edit",
							"MultiEdit",
							"NotebookEdit"
						].includes(tool) ? "file" : "tool",
						title: typeof request.title === "string" ? request.title : tool,
						details: stripVTControlCharacters([
							...new Set([
								request.decision_reason,
								request.description,
								input.description
							].filter((value) => typeof value === "string" && value !== "")),
							...typeof request.blocked_path === "string" ? [`blocked_path: ${request.blocked_path}`] : [],
							...Object.entries(input).filter(([key, value]) => key !== "description" || typeof value !== "string").map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`)
						].join("\n\n"))
					}, signal) && !signal.aborted) response = {
						behavior: "allow",
						updatedInput: input
					};
				}
			}
			if (!controller.signal.aborted) this.transport.write({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: id,
					response
				}
			});
		} catch (error) {
			if (!controller.signal.aborted) this.replyError(id, errorFrom(error).message);
			if (request.subtype === "hook_callback") this.transport.fail(errorFrom(error));
		} finally {
			this.approvals.delete(id);
		}
	}
	replyError(id, error) {
		this.transport.write({
			type: "control_response",
			response: {
				subtype: "error",
				request_id: id,
				error
			}
		});
	}
};
async function createClaudeSession(command, cwd, nativeSessionId, sink, signal, options, attachments) {
	if (options?.forkFrom !== void 0 && (nativeSessionId !== null || options.forkFrom === "")) throw new NativeBridgeError("BRIDGE_FORK_INVALID", "Claude fork requires a source session and no existing native binding");
	const session = new ClaudeSession(command, cwd, nativeSessionId, sink, options, attachments);
	await session.open(signal);
	return session;
}
//#endregion
//#region src/host/backends/codex.ts
const INITIALIZATION = {
	clientInfo: {
		name: "dsh-tauri-kernel",
		title: "DSH native session bridge",
		version: "1.0.0"
	},
	capabilities: { experimentalApi: true }
};
/**
* Config every thread runs under.
*
* `request_user_input` is gated off in Default mode unless its experimental tool
* switch is on; without it the model reports "request_user_input is unavailable
* in Default mode" instead of raising the question our `item/tool/requestUserInput`
* handler answers. The switch is a `tools` config table (verified against codex
* 0.162's config schema: `tools.experimental_request_user_input.enabled` is a
* boolean, sibling to `tools.update_plan.enabled`).
*/
const THREAD_CONFIG = { tools: { experimental_request_user_input: { enabled: true } } };
const CODEX_REASONING_EFFORT_NAMES = /* @__PURE__ */ new Map([
	["none", "Off"],
	["minimal", "Minimal"],
	["low", "Low"],
	["medium", "Medium"],
	["high", "High"],
	["xhigh", "Extra High"],
	["max", "Max"],
	["ultra", "Ultra"]
]);
/**
* Human-readable approval text: the native reason plus only the fields that
* identify what is being approved. The raw request envelope (ids, timestamps,
* decision menus) is protocol plumbing and is unreadable in a permission prompt.
*/
function approvalDetails(fallback, params, fields, extra = []) {
	const lines = [typeof params.reason === "string" && params.reason.trim() !== "" ? params.reason : fallback];
	for (const field of fields) {
		const value = params[field];
		if (value === void 0 || value === null || value === "") continue;
		lines.push(`${field}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return [...lines, ...extra].join("\n");
}
/**
* Read the proposed file changes a `fileChange` item carries. The approval
* request itself names no files, so the prompt can only list them from the item
* the native kernel announced for the same identity.
*/
function changedLines(item) {
	if (!Array.isArray(item.changes)) return [];
	return item.changes.flatMap((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const path = value.path;
		return typeof path === "string" && path !== "" ? [path] : [];
	});
}
/**
* Convert the latest `TokenUsageBreakdown` into the official vocabulary. Codex
* counts cached and cache-written prompt tokens inside `inputTokens`, while
* the official counts are disjoint, so the uncached share is what remains
* (source/dsh-tui/src/backends/codex/translate/usage.ts:13-27). A total the
* provider aggregates differently is not forwarded.
*/
function codexUsage(value) {
	const breakdown = value.last;
	if (!breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) return void 0;
	const fields = breakdown;
	const count = (key) => {
		const raw = fields[key];
		return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
	};
	const input = count("inputTokens");
	const output = count("outputTokens");
	if (input === 0 && output === 0) return void 0;
	const cacheRead = count("cachedInputTokens");
	const cacheWrite = count("cacheWriteInputTokens");
	return {
		inputTokens: Math.max(0, input - cacheRead - cacheWrite),
		outputTokens: output,
		...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
		...cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }
	};
}
/**
* Whether the native request still offers a plain one-shot `accept`. The DSH
* approval seam only grants `allowed-once`, so a decision menu without that
* entry cannot be answered truthfully; cancelling leaves the choice to the user
* instead of silently minting an execpolicy amendment or a session-scoped grant.
*/
function acceptsOnce(params) {
	return !Array.isArray(params.availableDecisions) || params.availableDecisions.includes("accept");
}
function nativeTool(item) {
	switch (item.type) {
		case "commandExecution": return {
			name: "commandExecution",
			arguments: JSON.stringify({
				command: item.command,
				cwd: item.cwd
			})
		};
		case "fileChange": return {
			name: "fileChange",
			arguments: JSON.stringify({ changes: item.changes })
		};
		case "mcpToolCall": return {
			name: `mcp::${stringField(item, "server")}/${stringField(item, "tool")}`,
			arguments: JSON.stringify(item.arguments ?? {})
		};
		case "dynamicToolCall": return {
			name: stringField(item, "tool"),
			arguments: JSON.stringify(item.arguments ?? {})
		};
		case "collabAgentToolCall": return {
			name: `collabAgent::${stringField(item, "tool")}`,
			arguments: JSON.stringify({
				prompt: item.prompt,
				receiverThreadIds: item.receiverThreadIds,
				model: item.model
			})
		};
		case "webSearch":
		case "imageView":
		case "imageGeneration":
		case "sleep": {
			const { id: _id, type, ...arguments_ } = item;
			return {
				name: String(type),
				arguments: JSON.stringify(arguments_)
			};
		}
		default: return;
	}
}
var CodexSession = class {
	command;
	sink;
	cwd;
	attachments;
	transport;
	requests;
	approvals = /* @__PURE__ */ new Map();
	catalogProcesses = /* @__PURE__ */ new Set();
	catalogRequest = 0;
	requestId = 0;
	nativeId = "";
	active;
	failure;
	disposed = false;
	disposePromise;
	cleanup;
	interruptedTurns = /* @__PURE__ */ new Set();
	backgroundBaseline;
	commandItems = /* @__PURE__ */ new Set();
	/** Proposed file changes per announced `fileChange` item, for its approval prompt. */
	changedFiles = /* @__PURE__ */ new Map();
	baselineModel;
	baselineProvider;
	baselineEffort;
	effectiveModel;
	defaultsPending = false;
	catalog;
	appliedOptions = {
		model: null,
		reasoningEffort: null
	};
	effortOverridden = false;
	constructor(command, sink, cwd, attachments) {
		this.command = command;
		this.sink = sink;
		this.cwd = cwd;
		this.attachments = attachments;
		this.transport = new JsonLinesProcess(command, [
			"app-server",
			"--listen",
			"stdio://"
		], cwd);
		this.requests = new PendingRequests((value) => this.transport.write(value));
		this.transport.onFailure((error) => {
			this.failure = error;
			this.requests.failAll(error);
			this.active?.result.reject(error);
			for (const transport of this.catalogProcesses) transport.fail(error);
			for (const controller of this.approvals.values()) controller.abort(error);
			this.approvals.clear();
		});
		this.transport.onMessage((message) => this.receive(message));
	}
	get id() {
		return this.nativeId;
	}
	async open(cwd, storedId, signal, options) {
		signal.throwIfAborted();
		try {
			await this.request("initialize", INITIALIZATION, signal);
			this.transport.write({
				method: "initialized",
				params: {}
			});
			const forkFrom = options?.forkFrom;
			const permission = options?.permission;
			const response = record(await this.request(forkFrom ? "thread/fork" : storedId === null ? "thread/start" : "thread/resume", {
				...forkFrom ? { threadId: forkFrom } : storedId === null ? {} : { threadId: storedId },
				cwd,
				...forkFrom !== void 0 || storedId !== null ? { excludeTurns: true } : {},
				config: THREAD_CONFIG,
				...permission?.approval === void 0 ? {} : { approvalPolicy: permission.approval === "never" ? "never" : "on-request" },
				...permission?.sandbox === void 0 ? {} : { sandbox: permission.sandbox }
			}, signal));
			const id = stringField(record(response.thread), "id");
			if (storedId !== null && id !== storedId) throw new NativeBridgeError("BRIDGE_RESUME_MISMATCH", "Codex resumed a different native thread; refusing to replace the stored binding");
			if (forkFrom && id === forkFrom) throw new NativeBridgeError("BRIDGE_FORK_MISMATCH", "Codex fork did not acknowledge a new native thread");
			this.nativeId = id;
			if (typeof response.modelProvider === "string" && response.modelProvider !== "") this.baselineProvider = response.modelProvider;
			this.defaultsPending = storedId !== null || forkFrom !== void 0;
			this.effortOverridden = this.defaultsPending;
			if (typeof response.model === "string" && response.model !== "") {
				this.effectiveModel = response.model;
				if (!this.defaultsPending) this.baselineModel = response.model;
			}
			if (!this.defaultsPending && (response.reasoningEffort === null || typeof response.reasoningEffort === "string")) this.baselineEffort = response.reasoningEffort;
			this.backgroundBaseline = new Set((await this.listTerminals(signal)).map((terminal) => terminal.processId));
			signal.throwIfAborted();
		} catch (error) {
			await this.dispose();
			throw error;
		}
	}
	async models(signal) {
		signal.throwIfAborted();
		if (this.disposed || this.failure) throw this.failure ?? new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Codex session was disposed");
		const generation = ++this.catalogRequest;
		this.catalog = void 0;
		const transport = new JsonLinesProcess(this.command, [
			"app-server",
			"--listen",
			"stdio://"
		], this.cwd);
		const requests = new PendingRequests((value) => transport.write(value));
		let requestId = 0;
		let failure;
		let defaultModel;
		let defaultEffort;
		const models = /* @__PURE__ */ new Map();
		const abort = new AbortController();
		const aborted = () => abort.abort(abortError(signal));
		signal.addEventListener("abort", aborted, { once: true });
		const timer = setTimeout(() => abort.abort(new NativeBridgeError("BRIDGE_REQUEST_TIMEOUT", "Codex model discovery timed out")), REQUEST_TIMEOUT_MS);
		this.catalogProcesses.add(transport);
		transport.onFailure((error) => {
			failure = error;
			requests.failAll(error);
		});
		transport.onMessage((message) => {
			const id = message.id;
			if (typeof id === "number" || typeof id === "string") if ("result" in message || "error" in message) {
				const error = message.error ? record(message.error) : void 0;
				requests.settle(id, message.result, error ? new NativeBridgeError("BRIDGE_NATIVE_REQUEST", typeof error.message === "string" ? error.message : JSON.stringify(error)) : void 0);
			} else transport.write({
				id,
				error: {
					code: -32601,
					message: "Read-only model discovery cannot handle native server requests"
				}
			});
		});
		function request(method, params) {
			const id = ++requestId;
			return requests.request(id, {
				id,
				method,
				params
			}, abort.signal);
		}
		try {
			await request("initialize", INITIALIZATION);
			transport.write({
				method: "initialized",
				params: {}
			});
			const config = record(record(await request("config/read", {
				includeLayers: false,
				cwd: this.cwd
			})).config);
			const configuredModel = typeof config.model === "string" && config.model !== "" ? config.model : void 0;
			if (this.baselineProvider !== void 0 && typeof config.model_provider === "string" && config.model_provider !== this.baselineProvider) throw new NativeBridgeError("BRIDGE_PROVIDER_CHANGED", "Codex provider changed after this session was created; create a new native session to use its models");
			defaultModel = this.baselineModel ?? configuredModel;
			defaultEffort = this.baselineEffort === void 0 ? config.model_reasoning_effort : this.baselineEffort;
			const cursors = /* @__PURE__ */ new Set();
			let cursor = null;
			do {
				if (cursors.size >= 100) throw new NativeBridgeError("BRIDGE_PROTOCOL_LIMIT", "Codex model listing exceeded its page limit");
				const response = record(await request("model/list", {
					cursor,
					limit: 100,
					includeHidden: false
				}));
				if (!Array.isArray(response.data)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex model listing is missing data");
				for (const value of response.data) {
					const model = record(value);
					const id = stringField(model, "model");
					if (!Array.isArray(model.supportedReasoningEfforts)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex model is missing reasoning capabilities");
					const efforts = model.supportedReasoningEfforts.map((value) => {
						const effort = record(value);
						const id = stringField(effort, "reasoningEffort");
						return {
							id,
							name: CODEX_REASONING_EFFORT_NAMES.get(id) ?? id,
							...typeof effort.description === "string" ? { description: effort.description } : {}
						};
					});
					const defaultEffort = typeof model.defaultReasoningEffort === "string" && efforts.some((effort) => effort.id === model.defaultReasoningEffort) ? model.defaultReasoningEffort : void 0;
					models.set(id, {
						id,
						name: stringField(model, "displayName"),
						...typeof model.description === "string" ? { description: model.description } : {},
						...efforts.length > 0 ? { reasoning: {
							efforts,
							...defaultEffort === void 0 ? {} : { defaultEffort }
						} } : {}
					});
					if (models.size > 1e4) throw new NativeBridgeError("BRIDGE_PROTOCOL_LIMIT", "Codex model listing exceeded its limit");
				}
				if (response.nextCursor !== null && response.nextCursor !== void 0 && typeof response.nextCursor !== "string") throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex model cursor is invalid");
				cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
				if (cursor !== null) {
					if (cursors.has(cursor)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex model listing repeated a cursor");
					cursors.add(cursor);
				}
			} while (cursor !== null);
			for (const id of [
				configuredModel,
				defaultModel,
				this.effectiveModel
			]) if (id && !models.has(id)) models.set(id, {
				id,
				name: id
			});
			abort.signal.throwIfAborted();
			if (failure || this.failure || this.disposed) throw failure ?? this.failure ?? new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Codex session was disposed");
		} catch (error) {
			failure ??= errorFrom(error);
		} finally {
			clearTimeout(timer);
			requests.failAll(new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Codex model discovery was closed"));
		}
		try {
			await transport.close(true);
			this.catalogProcesses.delete(transport);
		} catch {} finally {
			signal.removeEventListener("abort", aborted);
		}
		signal.throwIfAborted();
		if (failure || this.failure || this.disposed) throw failure ?? this.failure ?? new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Codex session was disposed");
		const catalog = {
			models: [...models.values()],
			...defaultModel === void 0 ? {} : { defaultModel },
			...defaultModel !== void 0 && typeof defaultEffort === "string" && defaultEffort !== "" ? { defaultReasoningEffort: defaultEffort } : {}
		};
		if (generation === this.catalogRequest) {
			this.baselineModel ??= defaultModel;
			if (this.baselineEffort === void 0 && (defaultEffort === null || typeof defaultEffort === "string")) this.baselineEffort = defaultEffort;
			this.catalog = catalog;
		}
		return catalog;
	}
	async turnOptions(options, signal) {
		const modelChanged = this.defaultsPending || options.model !== this.appliedOptions.model;
		const effortChanged = this.defaultsPending || options.reasoningEffort !== this.appliedOptions.reasoningEffort;
		if (options.model === null && options.reasoningEffort === null && this.appliedOptions.model === null && this.appliedOptions.reasoningEffort === null) return {};
		const catalog = this.catalog ?? await this.models(signal);
		const model = options.model ?? this.baselineModel;
		if (!model) throw new NativeBridgeError("BRIDGE_DEFAULT_UNAVAILABLE", "Codex did not report its default model");
		const info = catalog.models.find((value) => value.id === model);
		if (!info) throw new NativeBridgeError("BRIDGE_MODEL_UNAVAILABLE", `Codex did not advertise model: ${model}`);
		let effort = options.reasoningEffort;
		if (effort !== null && !info.reasoning?.efforts.some((value) => value.id === effort)) throw new NativeBridgeError("BRIDGE_EFFORT_UNSUPPORTED", `Codex did not advertise reasoning effort ${effort} for ${model}`);
		if (effort === null && (modelChanged || effortChanged)) {
			effort = model === this.baselineModel ? this.baselineEffort ?? info.reasoning?.defaultEffort ?? null : info.reasoning?.defaultEffort ?? null;
			if (effort === null && (this.effortOverridden || model !== this.effectiveModel)) throw new NativeBridgeError("BRIDGE_DEFAULT_UNAVAILABLE", `Codex did not report a restorable default reasoning effort for ${model}`);
		}
		return {
			...options.model !== null || modelChanged ? { model } : {},
			...effort === null ? {} : { effort }
		};
	}
	async submit(messages, signal, options, permission) {
		signal.throwIfAborted();
		if (this.disposed || this.failure) throw this.failure ?? new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Codex session was disposed");
		if (this.active) throw new NativeBridgeError("BRIDGE_BUSY", "Codex native session already has an active turn");
		const runs = nativeRuns(messages, this.attachments);
		if (runs.length === 0) throw new NativeBridgeError("BRIDGE_EMPTY_INPUT", "Codex native turn requires a user message");
		this.changedFiles.clear();
		const selection = options ? { ...options } : void 0;
		const policy = {
			...permission?.approval === void 0 ? {} : { approvalPolicy: permission.approval === "never" ? "never" : "on-request" },
			...permission?.sandbox === void 0 ? {} : { sandboxPolicy: {
				"read-only": {
					type: "readOnly",
					networkAccess: false
				},
				"workspace-write": {
					type: "workspaceWrite",
					writableRoots: [this.cwd],
					networkAccess: false,
					excludeTmpdirEnvVar: false,
					excludeSlashTmp: false
				},
				"danger-full-access": { type: "dangerFullAccess" }
			}[permission.sandbox] }
		};
		const turn = {
			result: deferred(),
			signal,
			submitted: false,
			interruptSent: false,
			baseline: /* @__PURE__ */ new Set(),
			commandItems: /* @__PURE__ */ new Set(),
			tools: /* @__PURE__ */ new Map(),
			assistants: /* @__PURE__ */ new Set(),
			text: /* @__PURE__ */ new Map(),
			thinking: /* @__PURE__ */ new Map(),
			liveThinking: /* @__PURE__ */ new Map()
		};
		this.active = turn;
		const aborted = () => {
			if (turn.submitted) this.interrupt(turn);
		};
		signal.addEventListener("abort", aborted, { once: true });
		try {
			const overrides = selection ? await this.turnOptions(selection, signal) : {};
			const input = [];
			for (const run of runs.flat()) {
				if (run.type === "text") {
					input.push({
						type: "text",
						text: run.text,
						text_elements: []
					});
					continue;
				}
				input.push(await this.imageInput(run.ref, signal));
			}
			signal.throwIfAborted();
			turn.baseline = new Set((await this.listTerminals(signal)).map((terminal) => terminal.processId));
			signal.throwIfAborted();
			turn.submitted = true;
			const response = record(await this.request("turn/start", {
				threadId: this.id,
				input,
				...overrides,
				...policy
			}));
			if (selection) {
				this.appliedOptions = selection;
				if (overrides.model !== void 0 || overrides.effort !== void 0) this.defaultsPending = false;
			}
			if (overrides.model !== void 0) this.effectiveModel = overrides.model;
			if (overrides.effort !== void 0) this.effortOverridden = true;
			const id = stringField(record(response.turn), "id");
			if (turn.id && id !== turn.id) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex turn/start response disagrees with turn/started");
			turn.id = id;
			if (signal.aborted) this.interrupt(turn);
			await turn.result.promise;
			if (turn.cleanup) await turn.cleanup;
			if (signal.aborted) {
				await this.cleanupTerminals(turn);
				signal.throwIfAborted();
			}
			if (turn.terminalError) {
				await this.cleanupTerminals(turn);
				throw turn.terminalError;
			}
		} catch (error) {
			if (turn.submitted && !signal.aborted && turn.terminalError === void 0) this.transport.fail(errorFrom(error));
			throw this.failure ?? (signal.aborted ? abortError(signal) : error);
		} finally {
			signal.removeEventListener("abort", aborted);
			clearTimeout(turn.interruptTimer);
			for (const controller of this.approvals.values()) controller.abort(new NativeBridgeError("BRIDGE_REQUEST_CLOSED", "Native turn has ended"));
			this.approvals.clear();
			this.active = void 0;
		}
	}
	dispose() {
		this.disposePromise ??= this.close();
		return this.disposePromise;
	}
	async close() {
		this.disposed = true;
		const error = new NativeBridgeError("BRIDGE_PROCESS_CLOSED", "Codex native session was disposed");
		this.active?.result.reject(error);
		for (const transport of this.catalogProcesses) transport.fail(error);
		for (const controller of this.approvals.values()) controller.abort(error);
		this.approvals.clear();
		try {
			if (this.id !== "" && this.backgroundBaseline && !this.failure) await this.cleanupTerminals();
		} finally {
			this.requests.failAll(error);
			for (const transport of [this.transport, ...this.catalogProcesses]) try {
				await transport.close();
			} catch {}
		}
	}
	request(method, params, signal, timeoutMs) {
		const id = ++this.requestId;
		return this.requests.request(id, {
			id,
			method,
			params
		}, signal, timeoutMs);
	}
	interrupt(turn) {
		if (!turn.interruptTimer) turn.interruptTimer = setTimeout(() => {
			this.transport.fail(new NativeBridgeError("BRIDGE_INTERRUPT_TIMEOUT", "Codex did not settle the interrupted turn; its process was closed"));
		}, INTERRUPT_TIMEOUT_MS);
		if (!turn.id || turn.interruptSent) return;
		turn.interruptSent = true;
		this.interruptedTurns.add(turn.id);
		turn.cleanup = (async () => {
			await this.cleanupTerminals(turn);
			try {
				await this.request("turn/interrupt", {
					threadId: this.id,
					turnId: turn.id
				}, void 0, INTERRUPT_TIMEOUT_MS);
			} catch {}
			await this.cleanupTerminals(turn);
		})();
		turn.cleanup.catch(() => {});
	}
	async listTerminals(signal) {
		const terminals = [];
		const cursors = /* @__PURE__ */ new Set();
		let cursor = null;
		do {
			const response = record(await this.request("thread/backgroundTerminals/list", {
				threadId: this.id,
				cursor,
				limit: 100
			}, signal, INTERRUPT_TIMEOUT_MS));
			if (!Array.isArray(response.data)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex background terminal listing is missing data");
			for (const value of response.data) {
				const terminal = record(value);
				terminals.push({
					itemId: stringField(terminal, "itemId"),
					processId: stringField(terminal, "processId")
				});
				if (terminals.length > 1e4) throw new NativeBridgeError("BRIDGE_PROTOCOL_LIMIT", "Codex background terminal listing exceeded its limit");
			}
			if (response.nextCursor !== null && response.nextCursor !== void 0 && typeof response.nextCursor !== "string") throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex background terminal cursor is invalid");
			cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
			if (cursor !== null) {
				if (cursors.has(cursor)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex background terminal listing repeated a cursor");
				cursors.add(cursor);
			}
		} while (cursor !== null);
		return terminals;
	}
	cleanupTerminals(turn) {
		const cleanup = async () => {
			const owns = (terminal) => turn ? turn.commandItems.has(terminal.itemId) || !turn.baseline.has(terminal.processId) : this.commandItems.has(terminal.itemId) || !this.backgroundBaseline.has(terminal.processId);
			for (const terminal of (await this.listTerminals()).filter(owns)) await this.request("thread/backgroundTerminals/terminate", {
				threadId: this.id,
				processId: terminal.processId
			}, void 0, INTERRUPT_TIMEOUT_MS);
			if ((await this.listTerminals()).some(owns)) throw new NativeBridgeError("BRIDGE_INTERRUPT_CLEANUP_FAILED", "Codex retained interrupted background terminals");
		};
		const pending = (this.cleanup ?? Promise.resolve()).then(cleanup);
		this.cleanup = pending;
		return pending;
	}
	receive(message) {
		const id = message.id;
		if ((typeof id === "number" || typeof id === "string") && ("result" in message || "error" in message)) {
			const error = message.error ? record(message.error) : void 0;
			this.requests.settle(id, message.result, error ? new NativeBridgeError("BRIDGE_NATIVE_REQUEST", typeof error.message === "string" ? error.message : JSON.stringify(error)) : void 0);
			return;
		}
		const method = stringField(message, "method");
		const params = record(message.params ?? {});
		if (typeof id === "number" || typeof id === "string") {
			this.answer(id, method, params).catch((error) => this.transport.fail(errorFrom(error)));
			return;
		}
		if (method === "serverRequest/resolved") {
			if (params.threadId !== this.id) return;
			const requestId = params.requestId;
			if (typeof requestId === "number" || typeof requestId === "string") {
				this.approvals.get(requestId)?.abort(new NativeBridgeError("BRIDGE_REQUEST_CLOSED", "Codex resolved the server request"));
				this.approvals.delete(requestId);
			}
			return;
		}
		if (params.threadId === this.id && method === "item/started" && typeof params.turnId === "string" && this.interruptedTurns.has(params.turnId)) {
			const item = record(params.item);
			if (item.type === "commandExecution" && typeof item.processId === "string") (async () => {
				await this.request("thread/backgroundTerminals/terminate", {
					threadId: this.id,
					processId: item.processId
				}, void 0, INTERRUPT_TIMEOUT_MS);
				if ((await this.listTerminals()).some((terminal) => terminal.processId === item.processId)) throw new NativeBridgeError("BRIDGE_INTERRUPT_CLEANUP_FAILED", "Codex retained a late interrupted command");
			})().catch((error) => this.transport.fail(errorFrom(error)));
		}
		const turn = this.active;
		if (!turn || params.threadId !== this.id) return;
		const nativeTurn = method === "turn/started" || method === "turn/completed" ? record(params.turn) : void 0;
		const turnId = nativeTurn?.id ?? params.turnId;
		if (typeof turnId === "string") {
			if (turn.id && turnId !== turn.id) return;
			turn.id ??= turnId;
		}
		if (turn.signal.aborted) this.interrupt(turn);
		switch (method) {
			case "turn/started": return;
			case "turn/completed": {
				if (Array.isArray(nativeTurn.items)) for (const value of nativeTurn.items) {
					const item = record(value);
					const tool = turn.tools.get(stringField(item, "id"));
					if (tool && !tool.ended && (item.status === "completed" || item.status === "failed" || item.status === "declined")) this.item(turn, item, true);
				}
				const status = stringField(nativeTurn, "status");
				if (status === "interrupted" && !turn.signal.aborted) turn.terminalError = new NativeBridgeError("BRIDGE_NATIVE_INTERRUPTED", "Codex interrupted the native turn");
				else if (status !== "completed" && status !== "interrupted") turn.terminalError = new NativeBridgeError("BRIDGE_NATIVE_TURN", `Codex turn ended with ${status}: ${JSON.stringify(nativeTurn.error ?? {})}`);
				turn.result.resolve();
				return;
			}
			case "error":
				if (params.willRetry !== true) {
					turn.terminalError = new NativeBridgeError("BRIDGE_NATIVE_TURN", JSON.stringify(params.error ?? params));
					turn.result.resolve();
				}
				return;
			case "thread/tokenUsage/updated": {
				const usage = codexUsage(record(params.tokenUsage));
				if (usage !== void 0) this.sink.usage(usage);
				return;
			}
			case "item/agentMessage/delta":
			case "item/plan/delta": {
				const id = stringField(params, "itemId");
				const delta = stringField(params, "delta");
				turn.text.set(id, (turn.text.get(id) ?? "") + delta);
				this.sink.text(id, delta);
				return;
			}
			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/textDelta": {
				const id = stringField(params, "itemId");
				const delta = stringField(params, "delta");
				const track = `${id}:${method === "item/reasoning/textDelta" ? "raw" : "summary"}`;
				turn.thinking.set(track, (turn.thinking.get(track) ?? "") + delta);
				if (!turn.liveThinking.has(id)) turn.liveThinking.set(id, track);
				if (turn.liveThinking.get(id) === track) this.sink.thinking(id, delta);
				return;
			}
			case "item/reasoning/summaryPartAdded": {
				const id = stringField(params, "itemId");
				if (turn.liveThinking.get(id) === `${id}:summary`) this.sink.thinking(id, "\n\n");
				return;
			}
			case "item/commandExecution/outputDelta":
			case "item/fileChange/outputDelta": {
				const tool = turn.tools.get(stringField(params, "itemId"));
				if (tool) tool.output += typeof params.delta === "string" ? params.delta : "";
				return;
			}
			case "item/commandExecution/terminalInteraction": {
				const tool = turn.tools.get(stringField(params, "itemId"));
				const stdin = typeof params.stdin === "string" ? params.stdin : "";
				if (tool && stdin !== "") tool.output += `⏎ ${stdin}`;
				return;
			}
			case "item/started":
			case "item/completed": this.item(turn, record(params.item), method === "item/completed");
		}
	}
	item(turn, item, completed) {
		const id = stringField(item, "id");
		const type = stringField(item, "type");
		if (item.type === "commandExecution") {
			turn.commandItems.add(id);
			this.commandItems.add(id);
		} else if (item.type === "fileChange") {
			const lines = changedLines(item);
			if (lines.length > 0) this.changedFiles.set(id, lines);
		}
		const tool = nativeTool(item);
		if (tool) {
			if (!turn.tools.has(id)) {
				this.sink.assistant(`${id}:call`, [{
					type: "tool-call",
					id,
					name: tool.name,
					arguments: tool.arguments
				}]);
				this.sink.toolStart(id, tool.name, tool.arguments);
				turn.tools.set(id, {
					output: "",
					ended: false
				});
			}
			const state = turn.tools.get(id);
			if (completed && !state.ended) {
				state.ended = true;
				const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : state.output || JSON.stringify(item.result ?? item.contentItems ?? item.changes ?? item.error ?? item);
				const error = item.status === "failed" || item.status === "declined" || item.error != null || item.success === false || typeof item.exitCode === "number" && item.exitCode !== 0;
				this.sink.toolEnd(id, output, error);
			}
			return;
		}
		if (!completed || turn.assistants.has(id)) return;
		const content = [];
		switch (type) {
			case "agentMessage":
			case "plan":
				content.push({
					type: "text",
					text: typeof item.text === "string" ? item.text : turn.text.get(id) ?? ""
				});
				break;
			case "reasoning": {
				const summary = Array.isArray(item.summary) ? item.summary.filter((part) => typeof part === "string").join("\n") : "";
				const raw = Array.isArray(item.content) ? item.content.filter((part) => typeof part === "string").join("\n") : "";
				content.push({
					type: "thinking",
					text: summary || turn.thinking.get(`${id}:summary`) || raw || turn.thinking.get(`${id}:raw`) || ""
				});
				break;
			}
			case "userMessage":
			case "hookPrompt":
			case "contextCompaction":
			case "subAgentActivity": return;
			case "enteredReviewMode":
			case "exitedReviewMode":
				content.push({
					type: "text",
					text: typeof item.review === "string" ? item.review : ""
				});
				break;
			default:
				content.push({
					type: "text",
					text: JSON.stringify(item)
				});
				break;
		}
		turn.assistants.add(id);
		this.sink.assistant(id, content);
	}
	/** Official image as native `UserInput`; a host path avoids re-encoding the bytes. */
	async imageInput(ref, signal) {
		const path = this.attachments?.path(ref);
		if (path !== void 0) return {
			type: "localImage",
			path
		};
		const source = await this.attachments.read(ref, signal);
		if (source.base64 === void 0) throw new NativeBridgeError("BRIDGE_PROTOCOL", "The official attachment store returned no readable image bytes");
		return {
			type: "image",
			url: `data:${source.mediaType};base64,${source.base64}`
		};
	}
	async answer(id, method, params) {
		const controller = new AbortController();
		this.approvals.set(id, controller);
		const turn = this.active;
		const signal = turn ? AbortSignal.any([turn.signal, controller.signal]) : controller.signal;
		const itemId = typeof params.itemId === "string" ? params.itemId : String(id);
		let result;
		try {
			const belongs = turn && params.threadId === this.id && (turn.id === void 0 || params.turnId === turn.id) && !signal.aborted;
			if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
				const command = method === "item/commandExecution/requestApproval";
				const allowed = belongs ? await this.sink.approval(itemId, {
					kind: command ? "command" : "file",
					title: command && typeof params.command === "string" ? params.command : command ? "Codex command execution" : "Codex file changes",
					details: approvalDetails(command ? "Codex needs to run a command" : "Codex needs to change files", params, command ? ["command", "cwd"] : ["grantRoot"], command ? [] : this.changedFiles.get(itemId) ?? [])
				}, signal) : false;
				result = { decision: acceptsOnce(params) ? allowed && !signal.aborted ? "accept" : "decline" : "cancel" };
			} else if (method === "item/permissions/requestApproval") result = {
				permissions: (belongs ? await this.sink.approval(itemId, {
					kind: "tool",
					title: "Codex additional permissions",
					details: approvalDetails("Codex requests additional permissions", params, ["permissions"])
				}, signal) : false) && !signal.aborted ? record(params.permissions) : {},
				scope: "turn"
			};
			else if (method === "item/tool/requestUserInput") {
				if (!belongs) throw new NativeBridgeError("BRIDGE_REQUEST_CLOSED", "No active turn for the native user-input request");
				if (!Array.isArray(params.questions)) throw new NativeBridgeError("BRIDGE_PROTOCOL", "Codex user-input request is missing questions");
				const questions = params.questions.map((value) => {
					const question = record(value);
					if (question.isSecret === true) throw new NativeBridgeError("BRIDGE_UNSUPPORTED_QUESTION", "Secret native questions cannot be recorded in the official session log");
					return {
						id: stringField(question, "id"),
						question: stringField(question, "question"),
						...Array.isArray(question.options) ? { options: question.options.map((value) => {
							const option = record(value);
							return {
								label: stringField(option, "label"),
								...typeof option.description === "string" ? { description: option.description } : {}
							};
						}) } : {}
					};
				});
				const answers = await this.sink.questions(itemId, questions, signal);
				result = { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: Array.isArray(answers[question.id]) ? answers[question.id] : [answers[question.id] ?? ""] }])) };
			} else {
				this.transport.write({
					id,
					error: {
						code: -32601,
						message: `Unsupported native server request: ${method}`
					}
				});
				return;
			}
			if (!controller.signal.aborted) this.transport.write({
				id,
				result
			});
		} catch (error) {
			if (!controller.signal.aborted) this.transport.write({
				id,
				error: {
					code: -32603,
					message: errorFrom(error).message
				}
			});
		} finally {
			this.approvals.delete(id);
		}
	}
};
async function createCodexSession(command, cwd, nativeSessionId, sink, signal, options, attachments) {
	if (options?.forkFrom !== void 0 && (nativeSessionId !== null || options.forkFrom === "")) throw new NativeBridgeError("BRIDGE_FORK_INVALID", "Codex fork requires a source thread and no existing native binding");
	const session = new CodexSession(command, sink, cwd, attachments);
	await session.open(cwd, nativeSessionId, signal, options);
	return session;
}
//#endregion
//#region src/host/paths.ts
function resolveUngroupedSessionPath(env = process.env) {
	const configured = env.DSH_HOME?.trim();
	return join(resolve(configured ? configured === "~" ? homedir() : /^~[\\/]/.test(configured) ? join(homedir(), configured.slice(2)) : configured : join(homedir(), ".dsh")), "ungrouped");
}
//#endregion
//#region src/host/service/sink.ts
const MAX_QUEUED_CHUNKS = 8192;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_TURN_BYTES = 64 * 1024 * 1024;
const MAX_TURN_TOOLS = 1024;
const sink = {
	async create(input) {
		const ctx = getHostContext();
		const modules = await loadRuntimeModules(ctx.loader);
		const { agent, signal } = input;
		signal.throwIfAborted();
		runtime.lifetime.signal.throwIfAborted();
		if (runtime.exchanges.has(agent.id)) throw new Error("BRIDGE_BUSY: 此会话已有原生回合。");
		await ensureNativeExecutor(ctx, agent, signal);
		const controller = new AbortController();
		const state = {
			input,
			controller,
			signal: AbortSignal.any([
				signal,
				controller.signal,
				runtime.lifetime.signal
			]),
			streams: /* @__PURE__ */ new Map(),
			assistants: /* @__PURE__ */ new Map(),
			tools: /* @__PURE__ */ new Map(),
			registrations: /* @__PURE__ */ new Map(),
			queue: [],
			queuedBytes: 0,
			outputBytes: 0,
			segment: 0,
			nextIndex: 0,
			lastStep: input.step,
			active: true,
			done: false,
			finalConsumed: false,
			native: {
				text(id, text) {
					delta(id, "text", text);
				},
				thinking(id, text) {
					delta(id, "reasoning", text);
				},
				assistant(id, content) {
					assertActive();
					const encoded = JSON.stringify(content);
					const committed = state.assistants.get(id);
					if (committed !== void 0) {
						if (committed !== encoded) throw new Error("BRIDGE_ASSISTANT_CONFLICT: 原生消息的重复提交不一致。");
						return;
					}
					const current = track(id);
					const used = /* @__PURE__ */ new Set();
					const calls = [];
					for (const block of content) {
						if (block.type === "tool-call") {
							if (state.tools.has(block.id) || state.tools.size >= MAX_TURN_TOOLS) throw new Error("BRIDGE_TOOL_CONFLICT: 原生工具身份重复或超过回合限制。");
							const name = toolName(block.name);
							const tool = createTool(name, block.arguments);
							state.tools.set(block.id, tool);
							register(name);
							calls.push({
								index: state.nextIndex++,
								call: {
									...block,
									name
								}
							});
							continue;
						}
						const type = block.type === "thinking" ? "reasoning" : "text";
						let index = current.blocks.find((candidate) => candidate.type === type && !used.has(candidate.index))?.index;
						if (index === void 0) {
							index = startBlock(current, type);
							push({
								type: type === "text" ? "text-delta" : "reasoning-delta",
								index,
								text: block.text
							});
						}
						used.add(index);
						push({
							type: "block-end",
							index,
							block: {
								type,
								text: block.text
							}
						});
					}
					for (const block of current.blocks) if (!used.has(block.index)) push({
						type: "block-end",
						index: block.index,
						block: {
							type: block.type,
							text: ""
						}
					});
					current.content = content;
					state.assistants.set(id, encoded);
					account(encoded);
					if (calls.length > 0) {
						if ([...state.streams.values()].some((value) => value.segment === state.segment && value.content === void 0)) throw new Error("BRIDGE_ASSISTANT_UNSETTLED: 原生工具边界前仍有未确认消息。");
						for (const { index, call } of calls) {
							const block = {
								...call,
								id: modules.ToolCallId(call.id)
							};
							push({
								type: "block-start",
								index,
								blockType: "tool-call"
							});
							push({
								type: "tool-call-delta",
								index,
								id: block.id,
								name: block.name,
								argumentsDelta: block.arguments
							});
							push({
								type: "block-end",
								index,
								block
							});
						}
						push({
							type: "finish",
							reason: { kind: "tool-calls" }
						});
						state.segment++;
						state.nextIndex = 0;
					}
				},
				usage(reported) {
					assertActive();
					push({
						type: "usage",
						usage: reported
					});
				},
				toolStart(id, name, arguments_) {
					assertActive();
					const current = state.tools.get(id);
					if (!current || current.name !== toolName(name) || current.arguments !== arguments_) throw new Error("BRIDGE_TOOL_NOT_PRESENTED: 工具开始前没有对应的官方工具消息。");
					current.started = true;
				},
				toolEnd(id, output, isError = false) {
					assertActive();
					const current = state.tools.get(id);
					if (!current?.started) throw new Error("BRIDGE_TOOL_NOT_STARTED: 原生工具结果没有对应调用。");
					if (current.result !== void 0) {
						if (current.result.output !== output || current.result.isError !== isError) throw new Error("BRIDGE_TOOL_RESULT_CONFLICT: 原生工具的重复结果不一致。");
						return;
					}
					account(output);
					current.result = {
						output,
						isError
					};
					current.resolve(current.result);
				},
				async approval(id, request, requestSignal) {
					assertActive();
					const current = state.tools.get(id);
					const outcome = await getHostContext().approval.request({
						agent,
						toolName: current?.name ?? request.title,
						...current === void 0 ? {} : { callId: modules.ToolCallId(id) },
						reason: request.details,
						signal: requestSignal === void 0 ? state.signal : AbortSignal.any([state.signal, requestSignal])
					});
					assertActive();
					requestSignal?.throwIfAborted();
					return outcome === "allowed-once";
				},
				async questions(id, questions, requestSignal) {
					assertActive();
					const answer = await getHostContext().userQuestions.ask({
						agent,
						questions,
						wait: { callId: modules.ToolCallId(id) },
						signal: requestSignal === void 0 ? state.signal : AbortSignal.any([state.signal, requestSignal])
					});
					assertActive();
					requestSignal?.throwIfAborted();
					const result = {};
					for (const question of questions) {
						const item = answer.answers.find((candidate) => candidate.id === question.id);
						if (!item) throw new Error("BRIDGE_QUESTION_ANSWER_MISSING: 问题未得到完整回答。");
						const values = [...item.selected, ...item.custom === void 0 ? [] : [item.custom]];
						result[question.id] = question.multiSelect ? values : values.join(", ");
					}
					return result;
				}
			}
		};
		function assertActive() {
			const host = getHostContext();
			if (!state.active || host.agents.get(agent.id) !== agent || host.sessions.get(agent.id) !== agent.session) throw new Error("BRIDGE_NOTIFICATION_OUTSIDE_TURN: 原生内核在回合结束后继续输出。");
			state.signal.throwIfAborted();
		}
		function account(text) {
			const bytes = Buffer.byteLength(text);
			state.outputBytes += bytes;
			if (state.outputBytes > MAX_TURN_BYTES) throw new Error("BRIDGE_STREAM_OVERFLOW: 原生回合超过输出限制。");
			return bytes;
		}
		function push(chunk) {
			state.signal.throwIfAborted();
			const bytes = account(JSON.stringify(chunk));
			if (state.queue.length >= MAX_QUEUED_CHUNKS || state.queuedBytes + bytes > MAX_QUEUED_BYTES) throw new Error("BRIDGE_STREAM_OVERFLOW: 原生输出超过缓冲限制。");
			state.queue.push(chunk);
			state.queuedBytes += bytes;
			state.wake?.();
			state.wake = void 0;
		}
		function track(id) {
			assertActive();
			let current = state.streams.get(id);
			if (!current) {
				current = {
					blocks: [],
					deltaSlots: /* @__PURE__ */ new Map(),
					segment: state.segment
				};
				state.streams.set(id, current);
			}
			if (current.content !== void 0 || current.segment !== state.segment) throw new Error("BRIDGE_ASSISTANT_ALREADY_SETTLED: 原生消息已提交或跨越工具边界。");
			return current;
		}
		function startBlock(current, type) {
			const index = state.nextIndex++;
			current.blocks.push({
				index,
				type
			});
			push({
				type: "block-start",
				index,
				blockType: type
			});
			return index;
		}
		function delta(id, type, text) {
			const current = track(id);
			let index = current.deltaSlots.get(type);
			if (index === void 0) {
				index = startBlock(current, type);
				current.deltaSlots.set(type, index);
			}
			push({
				type: type === "text" ? "text-delta" : "reasoning-delta",
				index,
				text
			});
		}
		function register(name) {
			if (state.registrations.has(name)) return;
			const dispose = agent.ctx.tools.register({
				name,
				description: "等待本机内核已经发起的工具结果；不执行 DSH 工具。",
				parameters: {
					type: "object",
					additionalProperties: true
				},
				output: {
					schema: { type: "string" },
					render: (_args, value) => [{
						type: "text",
						text: String(value)
					}]
				},
				isConcurrencySafe: () => true,
				async execute() {
					throw new Error("BRIDGE_TOOL_ROUTE_UNAVAILABLE: 原生调用未经过官方工具检查。");
				}
			});
			state.registrations.set(name, dispose);
		}
		const official = {
			state,
			settle(error) {
				if (!state.active) return;
				if (error === void 0 && !state.signal.aborted) if ([...state.streams.values()].some((current) => current.content === void 0)) error = /* @__PURE__ */ new Error("BRIDGE_ASSISTANT_UNSETTLED: 原生内核没有确认最终消息。");
				else {
					const pending = [...state.tools].filter(([, tool]) => tool.result === void 0).map(([id, tool]) => ({
						id,
						name: tool.name
					}));
					if (pending.length > 0) error = /* @__PURE__ */ new Error(`BRIDGE_TOOL_UNSETTLED: 原生内核没有确认全部工具结果。未确认工具：${JSON.stringify(pending)}`);
				}
				state.failure = error ?? (state.signal.aborted ? state.signal.reason : void 0);
				state.active = false;
				try {
					if (state.failure === void 0) push({
						type: "finish",
						reason: { kind: "stop" }
					});
				} catch (failure) {
					state.failure = failure;
				} finally {
					if (state.failure !== void 0) for (const tool of state.tools.values()) tool.reject(state.failure);
					state.done = true;
					state.wake?.();
					state.wake = void 0;
				}
			},
			async dispose() {
				if (state.disposal) return state.disposal;
				state.active = false;
				controller.abort(/* @__PURE__ */ new Error("BRIDGE_TURN_CLOSED"));
				for (const tool of state.tools.values()) tool.reject(state.failure ?? controller.signal.reason);
				state.disposal = (async () => {
					const outcomes = await Promise.allSettled([...state.registrations.values()].map((dispose) => Promise.resolve().then(dispose)));
					state.registrations.clear();
					if (runtime.exchanges.get(agent.id) === official) runtime.exchanges.delete(agent.id);
					const failures = outcomes.filter((outcome) => outcome.status === "rejected");
					if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "BRIDGE_TOOLS_DISPOSE_FAILED");
				})();
				return state.disposal;
			}
		};
		runtime.exchanges.set(agent.id, official);
		return official;
	},
	async admitTool(exec, next) {
		const official = exec.agent === void 0 ? void 0 : runtime.exchanges.get(exec.agent.id);
		if (!official) return next();
		try {
			expectedTool(official.state, exec);
			official.state.signal.throwIfAborted();
			exec.signal.throwIfAborted();
			return { kind: "allow" };
		} catch (error) {
			official.state.controller.abort(error);
			await official.state.task;
			throw error;
		}
	},
	async executeTool(exec, next) {
		const official = exec.agent === void 0 ? void 0 : runtime.exchanges.get(exec.agent.id);
		if (!official) return next();
		const state = official.state;
		const abort = () => state.controller.abort(exec.signal.reason);
		try {
			const tool = expectedTool(state, exec);
			if (tool.dispatched) throw new Error("BRIDGE_TOOL_ALREADY_DISPATCHED: 不能重复派发原生工具调用。");
			tool.dispatched = true;
			exec.signal.addEventListener("abort", abort, { once: true });
			if (exec.signal.aborted) abort();
			state.signal.throwIfAborted();
			const result = await tool.wait;
			exec.signal.throwIfAborted();
			state.signal.throwIfAborted();
			const content = [{
				type: "text",
				text: result.output
			}];
			return result.isError ? {
				isError: true,
				error: {
					message: result.output || "Native tool failed",
					info: {
						name: "NativeToolError",
						code: "BRIDGE_NATIVE_TOOL_ERROR"
					}
				},
				content
			} : {
				isError: false,
				value: result.output,
				content
			};
		} catch (error) {
			state.controller.abort(error);
			await state.task;
			throw error;
		} finally {
			exec.signal.removeEventListener("abort", abort);
		}
	},
	async finishTool(exec, _result, next) {
		const official = exec.agent === void 0 ? void 0 : runtime.exchanges.get(exec.agent.id);
		if (!official) return next();
		try {
			expectedTool(official.state, exec);
			return { kind: "accept" };
		} catch (error) {
			official.state.controller.abort(error);
			await official.state.task;
			throw error;
		}
	},
	commitTool(value, event) {
		if (event.type !== "tool/result" || event.surfaceOp !== "append") return;
		const official = runtime.exchanges.get(value.id);
		if (!official || official.state.input.agent.session !== value || official.state.input.turn !== event.data.turn) return;
		const state = official.state;
		const tool = state.tools.get(event.data.message.toolCallId);
		if (!tool || tool.step !== event.data.step || !tool.accepted || tool.committed || !tool.result || tool.result.isError !== (event.data.message.isError === true) || !isDeepStrictEqual(event.data.message.content, [{
			type: "text",
			text: tool.result.output
		}]) || tool.result.isError && event.data.error?.code !== "BRIDGE_NATIVE_TOOL_ERROR" || event.data.meta !== void 0) {
			state.failure = /* @__PURE__ */ new Error("BRIDGE_TOOL_RESULT_REJECTED: 官方日志没有完整保留原生工具结果。");
			state.controller.abort(state.failure);
			return;
		}
		tool.committed = true;
	},
	acceptTool(exec, result) {
		const official = exec.agent === void 0 ? void 0 : runtime.exchanges.get(exec.agent.id);
		if (!official) return void 0;
		try {
			const tool = expectedTool(official.state, exec);
			if (!tool.dispatched || !tool.result || result.isError !== tool.result.isError || result.additionalContexts?.length || result.concludesTurn || !isDeepStrictEqual(result.content, [{
				type: "text",
				text: tool.result.output
			}]) || !result.isError && result.value !== tool.result.output || result.isError && result.error.info?.code !== "BRIDGE_NATIVE_TOOL_ERROR") throw new Error("BRIDGE_TOOL_RESULT_REJECTED: 官方工具结果与原生结果不一致，不能继续原生回合。");
			tool.accepted = true;
		} catch (error) {
			official.state.failure = error;
			official.state.controller.abort(error);
		}
	}
};
/**
* Select native replay through the official pipeline in the agent's scope. DSH
* 0.2.2 allows exactly one executor per scope and its disposer clears the
* selection, so this installs the executor once per agent and lets the agent's
* scope own the effect. A preset that already selected another presentation is
* refused loudly instead of silently degrading into `UNKNOWN_TOOL` results.
*/
async function ensureNativeExecutor(ctx, agent, signal) {
	if (runtime.executors.has(agent)) return;
	let NativeToolExecutor;
	let pipelineModule;
	try {
		[NativeToolExecutor, pipelineModule] = await Promise.all([loadNativeExecutor(ctx.loader), loadToolPipeline(ctx.loader)]);
	} catch (cause) {
		throw new Error("BRIDGE_CORE_UNAVAILABLE: 官方原生工具执行器不可用，无法回放本机内核的工具调用。", { cause });
	}
	signal.throwIfAborted();
	try {
		const native = new NativeToolExecutor(agent.ctx);
		const pipeline = new pipelineModule.ToolExecutionPipeline(agent.ctx, { get(name, scope, toolSet) {
			const state = runtime.exchanges.get(agent.id)?.state;
			if (scope === agent && state?.registrations.has(name)) return agent.ctx.tools.executable(name, scope);
			return agent.ctx.tools.executable(name, scope, toolSet);
		} });
		agent.ctx.tools.setExecutor({
			describe: (tools) => native.describe(tools),
			execute: (input) => pipelineModule.executeToolBatch(input, pipeline, () => 10)
		});
	} catch (cause) {
		throw new Error("BRIDGE_TOOL_PRESENTATION_UNSUPPORTED: 此会话的预设已选定其它工具呈现方式，原生内核不能回放工具调用。", { cause });
	}
	runtime.executors.add(agent);
}
function createTool(name, arguments_) {
	let resolve;
	let reject;
	const wait = new Promise((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	wait.catch(() => void 0);
	return {
		name,
		arguments: arguments_,
		started: false,
		dispatched: false,
		accepted: false,
		committed: false,
		wait,
		resolve,
		reject
	};
}
function expectedTool(state, exec) {
	const tool = state.tools.get(exec.callId);
	if (state.input.agent !== exec.agent || !tool || exec.parent !== void 0 || tool.name !== exec.name || !sameArguments(tool.arguments, exec.arguments)) throw new Error("BRIDGE_TOOL_NOT_PRESENTED: 没有对应的原生工具调用。");
	return tool;
}
function sameArguments(raw, value) {
	try {
		return isDeepStrictEqual(raw === "" ? {} : JSON.parse(raw), value);
	} catch {
		return raw === value;
	}
}
function toolName(name) {
	if (name === "AskUserQuestion") return "ask_user_question";
	return name === "run_code" ? "native_run_code" : name;
}
//#endregion
//#region src/host/service/session.ts
const session = {
	async create(id, workspaceId, directory, agentPreset) {
		const ctx = getHostContext();
		const lifetime = runtime.lifetime;
		if (!runtime.ready) throw new Error("BRIDGE_CORE_UNAVAILABLE: 原生桥接尚未就绪。");
		if (workspaceId !== void 0 && directory !== void 0) throw new Error("BRIDGE_LOCATION_CONFLICT: 不能同时指定工作区与目录。");
		const resolved = await backend.resolve(id);
		if (!resolved.detection.installed || !resolved.command || resolved.detection.auth === "missing") throw new Error(resolved.detection.hint ?? "BRIDGE_BACKEND_UNAVAILABLE: 本机内核不可用。");
		const workspace = workspaceId === void 0 ? void 0 : ctx.workspaceRegistry.get(workspaceId);
		if (workspaceId !== void 0 && !workspace) throw new Error("BRIDGE_WORKSPACE_NOT_FOUND: 工作区不存在。");
		let cwd = workspace?.path ?? directory;
		if (cwd === void 0) {
			cwd = resolveUngroupedSessionPath();
			await mkdir(cwd, { recursive: true });
		}
		const location = await stat(cwd).catch(() => void 0);
		if (!isAbsolute(cwd) || location?.isDirectory() !== true) throw new Error("BRIDGE_CWD_INVALID: 会话目录必须是已存在的绝对目录。");
		cwd = await realpath(cwd);
		lifetime.signal.throwIfAborted();
		const preset = await ctx.agentPresets.resolve(agentPreset);
		lifetime.signal.throwIfAborted();
		if (preset.broken) throw new Error(`BRIDGE_PRESET_UNAVAILABLE: ${preset.broken}`);
		const sessionId = `session-${randomUUID()}`;
		let handle;
		try {
			handle = await ctx.agents.withoutInitiator(() => ctx.agents.create({
				sessionId,
				agentOptions: {
					provider: BRIDGE_PROVIDER,
					model: id
				},
				meta: {
					cwd,
					agentPreset: preset.id
				},
				signal: lifetime.signal,
				async setup(agentCtx, agent) {
					const startup = new AbortController();
					agentCtx.effect(() => async () => {
						startup.abort(/* @__PURE__ */ new Error("BRIDGE_SETUP_CLOSED"));
						await session.remove(agent.id, agent);
					}, "bridge native session setup");
					const signal = AbortSignal.any([startup.signal, lifetime.signal]);
					signal.throwIfAborted();
					await ctx.agentPresets.mount(agentCtx, preset.id);
					signal.throwIfAborted();
					agentCtx.fiber.assertActive();
					session.validateComposition(agent);
					const entry = await open(agent, id, null, signal);
					signal.throwIfAborted();
					agentCtx.fiber.assertActive();
					await identity.append(agent, entry.binding);
					signal.throwIfAborted();
					agentCtx.fiber.assertActive();
					return { commit() {
						signal.throwIfAborted();
						agentCtx.fiber.assertActive();
						if (runtime.lifetime !== lifetime || !runtime.ready || !sameBinding(identity.resolve(agent), entry.binding) || agent.options.provider !== "dsh-tauri-kernel" || agent.options.model !== id) throw new Error("BRIDGE_BINDING_NOT_COMMITTED: 原生身份未写入官方投影。");
					} };
				}
			}));
			runtime.lifetime.signal.throwIfAborted();
			if (workspace) await workspace.attachSession(sessionId);
			runtime.lifetime.signal.throwIfAborted();
			if (ctx.agents.get(sessionId) !== handle.agent || ctx.sessions.get(sessionId) !== handle.agent.session) throw new Error("BRIDGE_AGENT_REPLACED: 新会话已关闭或被替换。");
			return { sessionId };
		} catch (error) {
			const failures = (await Promise.allSettled([handle?.dispose(), session.remove(sessionId)])).filter((result) => result.status === "rejected");
			if (failures.length > 0) throw new AggregateError([error, ...failures.map((result) => result.reason)], "BRIDGE_CREATION_ROLLBACK_FAILED");
			throw error;
		}
	},
	async createInherited(source, create) {
		const ctx = getHostContext();
		const state = identity.stateOf(source);
		if (state?.binding === null || state?.binding === void 0) {
			if (state?.inheritedBinding !== null && state?.inheritedBinding !== void 0 || source.requestHeader()?.config.provider === "dsh-tauri-kernel") throw new Error("BRIDGE_BINDING_MISSING: 源会话尚未完成原生绑定，不能派生工作树会话。");
			return create();
		}
		const lifetime = runtime.lifetime;
		const parent = await resolveParent(source.id, lifetime.signal);
		await waitFor(parent.whenIdle(), lifetime.signal);
		lifetime.signal.throwIfAborted();
		if (parent.session !== source) throw new Error("BRIDGE_FORK_SOURCE_CHANGED: 源会话实例已被替换，请重新创建工作树会话。");
		return parent.runMaintenance(async (signal) => {
			signal.throwIfAborted();
			lifetime.signal.throwIfAborted();
			if (runtime.lifetime !== lifetime) throw new Error("BRIDGE_DISPOSED: 原生派生的桥接生命周期已结束。");
			const cursor = source.seq;
			const handle = await create(AbortSignal.any([signal, lifetime.signal]));
			try {
				signal.throwIfAborted();
				lifetime.signal.throwIfAborted();
				if (runtime.lifetime !== lifetime || source.seq !== cursor || ctx.agents.get(source.id) !== parent) throw new Error("BRIDGE_FORK_SOURCE_CHANGED: 源会话在原生派生期间发生变化。");
				return handle;
			} catch (error) {
				await handle.dispose();
				throw error;
			}
		});
	},
	async prepare(source, agent, signal) {
		const state = identity.stateOf(source);
		const binding = state?.binding;
		if (binding === null || binding === void 0) {
			if (state?.inheritedBinding !== null && state?.inheritedBinding !== void 0 || source.requestHeader()?.config.provider === "dsh-tauri-kernel") throw new Error("BRIDGE_BINDING_MISSING: 源会话尚未完成原生绑定，不能派生工作树会话。");
			return;
		}
		if (binding.sessionId !== source.id || agent.session.header.parentSession !== source.id || !agent.session.header.isSeeded) throw new Error("BRIDGE_FORK_INVALID: 原生派生必须来自当前官方父会话。");
		const inherited = identity.inherited(agent.session);
		if (!inherited || !sameBinding(inherited, binding)) throw new Error("BRIDGE_FORK_INVALID: 原生派生与官方继承前缀不一致。");
		return bindFork(agent, binding, signal, source);
	},
	async repairInherited(agent, signal) {
		const ctx = getHostContext();
		const state = identity.stateOf(agent.session);
		const scoped = AbortSignal.any([signal, runtime.lifetime.signal]);
		if (state?.binding !== null && state?.binding !== void 0) return;
		const inherited = identity.inherited(agent.session);
		if (!inherited) return;
		const parent = await resolveParent(inherited.sessionId, scoped);
		await waitFor(parent.whenIdle(), scoped);
		const cursor = agent.session.inheritedEventCount;
		await waitFor(parent.runMaintenance(async (maintenance) => {
			const repairing = AbortSignal.any([scoped, maintenance]);
			if (parent.session.seq !== cursor) throw new Error("BRIDGE_FORK_SOURCE_CHANGED: 父会话已改变，不能将较新的原生历史替代继承前缀。");
			(await bindFork(agent, inherited, repairing, parent.session)).commit();
			await checkpoint.flush(agent, repairing);
			repairing.throwIfAborted();
			if (parent.session.seq !== cursor) throw new Error("BRIDGE_FORK_SOURCE_CHANGED: 父会话在原生派生期间发生变化。");
		}), scoped);
		signal.throwIfAborted();
		if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session) throw new Error("BRIDGE_AGENT_REPLACED: 工作树会话已关闭或被替换。");
	},
	async *title(options) {
		const ctx = getHostContext();
		const agent = options.sessionId === void 0 ? void 0 : ctx.agents.get(options.sessionId);
		if (!runtime.ready || options.provider !== "dsh-tauri-kernel" || options.purpose !== "session-title" || !agent || ctx.sessions.get(agent.id) !== agent.session || options.signal === void 0 || identity.resolve(agent).backend !== options.model) throw new Error("BRIDGE_TITLE_REQUEST_INVALID: 标题请求缺少对应的原生会话。");
		const route = ctx.get("agentDefaultModel")?.currentSelection();
		if (!route || route.provider === "dsh-tauri-kernel") throw new Error("BRIDGE_TITLE_MODEL_UNAVAILABLE: 标题生成需要可用的 DSH 默认模型。");
		const signal = AbortSignal.any([options.signal, runtime.lifetime.signal]);
		signal.throwIfAborted();
		const call = await ctx.llm.prepareCall({
			provider: route.provider,
			model: route.model,
			reasoningEffort: route.reasoningEffort,
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			stop: options.stop
		}, signal);
		yield* call.stream({
			...options,
			...call.config,
			signal
		});
	},
	async connect(agent, signal) {
		const binding = identity.resolve(agent);
		try {
			return (await open(agent, binding.backend, binding.nativeSessionId, signal)).session;
		} catch (error) {
			if (/BRIDGE_NATIVE_TURN|No conversation found/.test(error instanceof Error ? error.message : String(error))) throw new Error("BRIDGE_SESSION_UNRECOVERABLE: 原生会话记录已不存在，请新建会话。");
			throw error;
		}
	},
	validateComposition(agent) {
		const ctx = getHostContext();
		if (typeof ctx.agentPresets.inspectCompositions !== "function") return;
		for (const composition of ctx.agentPresets.inspectCompositions(agent.ctx)) if (composition.modules.some((module) => module.moduleName === "@deepseek-ai/dsh-hooks-codex" || module.moduleName === "@deepseek-ai/dsh-hooks-claude-code")) throw new Error("BRIDGE_HOOK_COMPOSITION_UNSUPPORTED: 原生会话不能叠加官方 Codex / Claude hooks，避免重复执行本机配置。");
	},
	async execute(input) {
		if (input.binding.sessionId !== input.agent.session.id || !sameBinding(identity.stateOf(input.agent.session)?.binding, input.binding)) throw new Error("BRIDGE_BINDING_MISMATCH: 不能替换已有会话的原生内核。");
		input.signal.throwIfAborted();
		const current = runtime.exchanges.get(input.agent.id);
		if (current) {
			const state = current.state;
			if (state.input.agent !== input.agent || state.input.turn !== input.turn || state.input.signal !== input.signal || input.step <= state.lastStep || !sameBinding(state.input.binding, input.binding) || state.finalConsumed) throw new Error("BRIDGE_TURN_MISMATCH: 原生回合不能重试、替换或跨回合复用。");
			for (const tool of state.tools.values()) if (tool.step !== void 0 && tool.step <= state.lastStep && !tool.committed) throw new Error("BRIDGE_TOOL_RESULT_REJECTED: 官方工具结果尚未完整提交。");
			state.signal.throwIfAborted();
			if (state.failure !== void 0) throw state.failure;
			state.lastStep = input.step;
			return current;
		}
		const official = await sink.create(input);
		const state = official.state;
		runtime.sinks.set(input.agent.id, state.native);
		state.task = (async () => {
			try {
				const entry = await open(input.agent, input.binding.backend, input.binding.nativeSessionId, state.signal);
				state.signal.throwIfAborted();
				if (!sameBinding(entry.binding, input.binding)) throw new Error("BRIDGE_RESUME_MISMATCH: 原生内核未恢复已绑定的会话。");
				await entry.session.submit(input.messages, state.signal, input.options, permissionOf(input.agent.session));
				official.settle();
			} catch (error) {
				official.settle(error);
			} finally {
				if (runtime.sinks.get(input.agent.id) === state.native) runtime.sinks.delete(input.agent.id);
			}
		})();
		return official;
	},
	async finish(agent, turn) {
		const official = runtime.exchanges.get(agent.id);
		if (!official || official.state.input.agent !== agent || official.state.input.turn !== turn) return;
		const previous = runtime.closings.get(agent.id);
		if (previous) return previous;
		const task = drainTurn(official);
		runtime.closings.set(agent.id, task);
		try {
			await task;
		} finally {
			if (runtime.closings.get(agent.id) === task) runtime.closings.delete(agent.id);
		}
	},
	async remove(sessionId, owner) {
		if (owner !== void 0 && !ownsSession(sessionId, owner)) return;
		const previous = runtime.removals.get(sessionId);
		if (previous) return previous;
		const task = close(sessionId, owner);
		runtime.removals.set(sessionId, task);
		try {
			await task;
		} finally {
			if (runtime.removals.get(sessionId) === task) runtime.removals.delete(sessionId);
		}
	},
	async dispose() {
		runtime.lifetime.abort(/* @__PURE__ */ new Error("BRIDGE_DISPOSED"));
		const agents = new Set([...runtime.sessions.values()].map((entry) => entry.agent));
		for (const step of runtime.steps.values()) agents.add(step.agent);
		for (const agent of agents) agent.cancel({ kind: "disposed" });
		const idle = await Promise.allSettled([...agents].map((agent) => agent.whenIdle()));
		await resetRuntime();
		const failures = idle.filter((result) => result.status === "rejected");
		if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "BRIDGE_IDLE_FAILED");
	}
};
async function drainTurn(official) {
	const state = official.state;
	const complete = state.done && state.finalConsumed && !state.signal.aborted && state.failure === void 0 && [...state.tools.values()].every((tool) => tool.committed);
	if (!complete) state.controller.abort(state.failure ?? /* @__PURE__ */ new Error("BRIDGE_PREMATURE_TURN_END: 官方回合提前结束，已停止原生内核。"));
	try {
		await state.task;
		if (!complete) throw state.failure ?? state.signal.reason ?? /* @__PURE__ */ new Error("BRIDGE_PREMATURE_TURN_END");
	} finally {
		try {
			if (!complete) await session.remove(state.input.agent.id, state.input.agent);
		} finally {
			await official.dispose();
		}
	}
}
async function bindFork(agent, source, signal, parent) {
	const lifetime = runtime.lifetime;
	const startup = new AbortController();
	agent.ctx.effect(() => async () => {
		startup.abort(/* @__PURE__ */ new Error("BRIDGE_SETUP_CLOSED"));
		await session.remove(agent.id, agent);
	}, "bridge native fork setup");
	const scoped = AbortSignal.any([
		signal,
		startup.signal,
		lifetime.signal
	]);
	const ctx = getHostContext();
	try {
		scoped.throwIfAborted();
		agent.ctx.fiber.assertActive();
		session.validateComposition(agent);
		assertForkSource(parent, agent, source);
		const hasConversation = parent.deriveMessages().some((message) => message.role === "assistant" || message.role === "tool" || message.role === "user" && message.source.kind === "user");
		const entry = await open(agent, source.backend, null, scoped, hasConversation ? { forkFrom: source.nativeSessionId } : void 0);
		assertForkSource(parent, agent, source);
		scoped.throwIfAborted();
		agent.ctx.fiber.assertActive();
		if (entry.binding.nativeSessionId === source.nativeSessionId) throw new Error("BRIDGE_FORK_MISMATCH: 工作树必须获得独立的原生会话身份。");
		const seq = await identity.append(agent, entry.binding);
		if (agent.options.provider === void 0 && agent.options.model === void 0) identity.hydrate(agent);
		if (ctx.agents.get(agent.id) === agent && ctx.sessions.get(agent.id) === agent.session) checkpoint.mark(agent, KERNEL_RECORD_TYPE, seq, entry.binding);
		scoped.throwIfAborted();
		agent.ctx.fiber.assertActive();
		return { commit() {
			scoped.throwIfAborted();
			agent.ctx.fiber.assertActive();
			assertForkSource(parent, agent, source);
			if (runtime.lifetime !== lifetime || !runtime.ready || !sameBinding(identity.resolve(agent), entry.binding) || identity.stateOf(agent.session)?.inheritedBinding?.sessionId !== agent.session.header.parentSession) throw new Error("BRIDGE_BINDING_NOT_COMMITTED: 工作树原生身份未写入官方投影。");
		} };
	} catch (error) {
		await session.remove(agent.id, agent);
		throw error;
	}
}
async function resolveParent(sessionId, signal) {
	const ctx = getHostContext();
	runtime.lifetime.signal.throwIfAborted();
	const live = ctx.agents.get(sessionId);
	if (live) return live;
	const controller = ctx.get("sessionController");
	if (typeof controller?.resolveAgent !== "function") throw new Error("BRIDGE_FORK_SOURCE_UNAVAILABLE: 无法读取原生派生的官方父会话。");
	const result = await waitFor(controller.resolveAgent(sessionId), signal);
	signal.throwIfAborted();
	if ("error" in result) throw result.error;
	runtime.lifetime.signal.throwIfAborted();
	if (!result.agent) throw new Error("BRIDGE_FORK_SOURCE_UNAVAILABLE: 官方父会话无法恢复。");
	return result.agent;
}
function assertForkSource(parent, child, binding) {
	if (parent.id !== child.session.header.parentSession || parent.seq !== child.session.inheritedEventCount || !sameBinding(identity.stateOf(parent)?.binding, binding)) throw new Error("BRIDGE_FORK_SOURCE_CHANGED: 父会话与当前继承前缀不一致，请重新创建工作树会话。");
}
async function close(sessionId, owner) {
	if (owner !== void 0 && !ownsSession(sessionId, owner)) return;
	const controller = runtime.controllers.get(sessionId);
	controller?.abort(/* @__PURE__ */ new Error("BRIDGE_SESSION_DISPOSED"));
	const pending = runtime.pending.get(sessionId);
	if (pending) await pending.task.catch(() => void 0);
	const entry = runtime.sessions.get(sessionId);
	if (entry) {
		try {
			await entry.session.dispose();
		} catch (error) {
			getHostContext().logger?.warn?.("dsh-tauri-kernel: native process termination failed", error);
		}
		if (runtime.sessions.get(sessionId) === entry) runtime.sessions.delete(sessionId);
		if (runtime.claims.get(keyOf(entry.binding)) === sessionId) runtime.claims.delete(keyOf(entry.binding));
	}
	if (runtime.controllers.get(sessionId) === controller) runtime.controllers.delete(sessionId);
}
async function open(agent, id, storedId, signal, options) {
	signal.throwIfAborted();
	runtime.lifetime.signal.throwIfAborted();
	if (runtime.removals.has(agent.id)) throw new Error("BRIDGE_SESSION_CLOSING: 原生会话正在关闭。");
	const current = runtime.sessions.get(agent.id);
	if (current) {
		if (current.agent !== agent || current.binding.backend !== id || storedId !== null && current.binding.nativeSessionId !== storedId) throw new Error("BRIDGE_NATIVE_OWNER_CONFLICT: 原生会话已有其它所有者。");
		return current;
	}
	const pending = runtime.pending.get(agent.id);
	if (pending) {
		if (pending.agent !== agent) throw new Error("BRIDGE_NATIVE_OWNER_CONFLICT: 待连接的原生会话属于其它所有者。");
		const entry = await pending.task;
		signal.throwIfAborted();
		if (entry.agent !== agent || entry.binding.backend !== id || storedId !== null && entry.binding.nativeSessionId !== storedId) throw new Error("BRIDGE_NATIVE_OWNER_CONFLICT: 待连接的原生会话属于其它所有者。");
		return entry;
	}
	const controller = new AbortController();
	runtime.controllers.set(agent.id, controller);
	const task = connect(agent, id, storedId, controller, AbortSignal.any([
		runtime.lifetime.signal,
		controller.signal,
		signal
	]), options);
	const opening = {
		agent,
		controller,
		task
	};
	runtime.pending.set(agent.id, opening);
	try {
		return await task;
	} finally {
		if (runtime.pending.get(agent.id) === opening) runtime.pending.delete(agent.id);
		if (!runtime.sessions.has(agent.id) && runtime.controllers.get(agent.id) === controller) runtime.controllers.delete(agent.id);
	}
}
async function connect(agent, id, storedId, controller, signal, options) {
	const resolved = await backend.resolve(id);
	signal.throwIfAborted();
	if (!resolved.detection.installed || !resolved.command || resolved.detection.auth === "missing") throw new Error(resolved.detection.hint ?? "BRIDGE_BACKEND_UNAVAILABLE: 本机内核不可用。");
	const nativeSink = {
		text: (...args) => activeSink(agent, controller).text(...args),
		thinking: (...args) => activeSink(agent, controller).thinking(...args),
		assistant: (...args) => activeSink(agent, controller).assistant(...args),
		usage: (...args) => activeSink(agent, controller).usage(...args),
		toolStart: (...args) => activeSink(agent, controller).toolStart(...args),
		toolEnd: (...args) => activeSink(agent, controller).toolEnd(...args),
		approval: (...args) => activeSink(agent, controller).approval(...args),
		questions: (...args) => activeSink(agent, controller).questions(...args)
	};
	const factory = id === "codex" ? createCodexSession : createClaudeSession;
	const permission = permissionOf(agent.session);
	const native = await factory(resolved.command, agent.session.header.cwd, storedId, nativeSink, signal, permission === void 0 ? options : {
		...options,
		permission
	}, nativeAttachments(getHostContext()));
	try {
		signal.throwIfAborted();
		if (!native.id || storedId !== null && storedId !== native.id) throw new Error("BRIDGE_RESUME_MISMATCH: 原生内核返回了不同的会话身份。");
		const binding = {
			backend: id,
			nativeSessionId: native.id,
			sessionId: agent.session.id
		};
		const owner = runtime.claims.get(keyOf(binding));
		if (owner !== void 0 && owner !== agent.id) throw new Error("BRIDGE_NATIVE_OWNER_CONFLICT: 原生会话已绑定其它官方会话。");
		const entry = {
			agent,
			binding,
			session: native,
			controller
		};
		runtime.claims.set(keyOf(binding), agent.id);
		runtime.sessions.set(agent.id, entry);
		return entry;
	} catch (error) {
		await native.dispose();
		throw error;
	}
}
/** Official attachment access for native prompts; absent without an image provider. */
function nativeAttachments(ctx) {
	const store = ctx.get("attachments");
	if (store === void 0) return void 0;
	return {
		path: (ref) => store.imageHostPath(ref),
		async read(ref, signal) {
			const stored = await store.readImage(ref, signal);
			if (!(stored.data instanceof Uint8Array) || stored.ref.mediaType.length === 0) throw new NativeBridgeError("BRIDGE_PROTOCOL", "The official attachment store returned an unreadable image");
			return {
				mediaType: stored.ref.mediaType,
				base64: Buffer.from(stored.data).toString("base64")
			};
		}
	};
}
function ownsSession(sessionId, owner) {
	const entry = runtime.sessions.get(sessionId);
	const pending = runtime.pending.get(sessionId);
	return entry?.agent === owner || pending?.agent === owner;
}
function activeSink(agent, controller) {
	controller.signal.throwIfAborted();
	const current = runtime.sinks.get(agent.id);
	const exchange = runtime.exchanges.get(agent.id);
	if (runtime.controllers.get(agent.id) !== controller || exchange?.state.input.agent !== agent || exchange.state.native !== current) throw new Error("BRIDGE_NOTIFICATION_OUTSIDE_TURN: 原生内核在官方回合外或替换后输出。");
	return exchange.state.native;
}
/**
* DSH 0.2.2 replaced the single `permissions` projection payload (sandbox and
* approval knobs) with `PermissionSelection` (a preset name only). The two knob
* owners expose their own session override again, so read them where they live.
*/
function permissionOf(value) {
	const ctx = getHostContext();
	const sandbox = ctx.get("sandboxPolicy")?.overrideOf(value);
	const approval = ctx.approval.overrideOf(value);
	if (sandbox === void 0 && approval === void 0) return void 0;
	return {
		sandbox,
		approval
	};
}
function sameBinding(left, right) {
	return left?.backend === right.backend && left.nativeSessionId === right.nativeSessionId && left.sessionId === right.sessionId;
}
function keyOf(binding) {
	return `${binding.backend}:${binding.nativeSessionId}`;
}
//#endregion
//#region src/host/service/model.ts
/** Retained handle: the registry-level `stateOf` is deprecated in DSH 0.2.2. */
let handle;
const model = {
	async register() {
		const ctx = getHostContext();
		const lifetime = runtime.lifetime;
		const z = await loadRuntimeZod(ctx.loader);
		lifetime.signal.throwIfAborted();
		if (runtime.lifetime !== lifetime || getHostContext() !== ctx) throw new Error("BRIDGE_DISPOSED: Model projection owner changed during registration");
		const identifier = z.string().min(1).max(512).refine((value) => value.trim().length > 0);
		const optionsSchema = z.object({
			model: identifier.nullable(),
			reasoningEffort: identifier.nullable()
		}).strict().readonly();
		const catalogSchema = z.object({
			models: z.array(z.object({
				id: identifier,
				name: z.string().min(1),
				description: z.string().optional(),
				reasoning: z.object({
					efforts: z.array(z.object({
						id: identifier,
						name: z.string().min(1),
						description: z.string().optional()
					})).min(1),
					defaultEffort: identifier.optional()
				}).optional()
			})).max(2048),
			defaultModel: identifier.optional(),
			defaultReasoningEffort: identifier.optional()
		});
		const registered = await ctx.sessionProjections.register({
			key: "bridgeModel",
			stateSchema: optionsSchema,
			init: () => ({
				model: null,
				reasoningEffort: null
			}),
			apply(state, event) {
				if (event.type !== "plugin:dsh-tauri-kernel/model" || event.ignorable !== true) return state;
				const next = parseOptions(event.data);
				return sameOptions(state, next) ? state : next;
			},
			wire: {
				viewSchema: optionsSchema,
				view: (state) => state
			},
			stateVersion: 1
		});
		lifetime.signal.throwIfAborted();
		if (runtime.lifetime !== lifetime || getHostContext() !== ctx) {
			await registered.dispose();
			throw new Error("BRIDGE_DISPOSED: Model projection owner changed during registration");
		}
		handle = registered;
		runtime.optionsSchema = optionsSchema;
		runtime.catalogSchema = catalogSchema;
		return async () => {
			if (handle === registered) handle = void 0;
			if (runtime.optionsSchema === optionsSchema) runtime.optionsSchema = void 0;
			if (runtime.catalogSchema === catalogSchema) runtime.catalogSchema = void 0;
			await registered.dispose();
		};
	},
	/** Folded native turn options of one official session. */
	stateOf(value) {
		return handle?.stateOf(value);
	},
	resolve(agent) {
		const value = model.stateOf(agent.session);
		if (value === void 0) throw new Error("BRIDGE_CORE_UNAVAILABLE: 原生模型投影不可用。");
		return parseOptions(value);
	},
	async forTurn(agent, signal) {
		const lifetime = runtime.lifetime;
		const scoped = AbortSignal.any([signal, lifetime.signal]);
		while (true) {
			const pending = runtime.modelWrites.get(agent);
			if (pending) await waitFor(pending.catch(() => void 0), scoped);
			await checkpoint.flush(agent, scoped);
			assertLive$1(agent, lifetime);
			scoped.throwIfAborted();
			if (!runtime.modelWrites.has(agent) && checkpoint.isVerified(agent)) return model.resolve(agent);
		}
	},
	async getCatalog(sessionId) {
		const lifetime = runtime.lifetime;
		const agent = await resolveAgent(sessionId, lifetime);
		const binding = identity.resolve(agent);
		const catalog = await getCatalog(agent, lifetime);
		assertLive$1(agent, lifetime);
		return {
			...catalog,
			backend: binding.backend,
			current: model.resolve(agent)
		};
	},
	async select(sessionId, options) {
		const next = parseOptions(options);
		const lifetime = runtime.lifetime;
		const agent = await resolveAgent(sessionId, lifetime);
		identity.resolve(agent);
		const previous = runtime.modelWrites.get(agent);
		const task = (async () => {
			if (previous) await waitFor(previous.catch(() => void 0), lifetime.signal);
			assertSelection(await getCatalog(agent, lifetime), next);
			assertLive$1(agent, lifetime);
			const modules = await waitFor(loadRuntimeModules(getHostContext().loader), lifetime.signal);
			assertLive$1(agent, lifetime);
			if (!sameOptions(model.resolve(agent), next)) {
				const cursor = agent.session.seq;
				const seq = modules.appendPluginRecord(agent.session, MODEL_RECORD_TYPE, next);
				checkpoint.mark(agent, MODEL_RECORD_TYPE, seq, next);
				if (seq !== cursor || agent.session.seq !== cursor + 1 || !sameOptions(model.resolve(agent), next)) throw new Error("BRIDGE_MODEL_NOT_COMMITTED: 原生模型选择未写入官方会话。");
			}
			await checkpoint.flush(agent, lifetime.signal, true);
			assertLive$1(agent, lifetime);
		})();
		runtime.modelWrites.set(agent, task);
		try {
			await task;
			return next;
		} finally {
			if (runtime.modelWrites.get(agent) === task) runtime.modelWrites.delete(agent);
		}
	}
};
function parseOptions(value) {
	if (!runtime.optionsSchema) throw new Error("BRIDGE_CORE_UNAVAILABLE: 原生模型投影不可用。");
	const parsed = runtime.optionsSchema.safeParse(value);
	if (!parsed.success) throw new Error("BRIDGE_MODEL_INVALID: 模型与推理深度必须是完整的原生选项。");
	return parsed.data;
}
async function resolveAgent(sessionId, lifetime) {
	const ctx = getHostContext();
	lifetime.signal.throwIfAborted();
	let agent = ctx.agents.get(sessionId);
	if (!agent) {
		const controller = ctx.get("sessionController");
		if (typeof controller?.resolveAgent !== "function") throw new Error("BRIDGE_SESSION_UNAVAILABLE: 无法恢复官方会话。");
		const resolved = await waitFor(controller.resolveAgent(sessionId), lifetime.signal);
		if ("error" in resolved) throw resolved.error;
		agent = resolved.agent;
	}
	if (!agent) throw new Error("BRIDGE_SESSION_UNAVAILABLE: 官方会话未返回有效的代理。");
	assertLive$1(agent, lifetime);
	identity.resolve(agent);
	return agent;
}
async function getCatalog(agent, lifetime) {
	assertLive$1(agent, lifetime);
	const native = await waitFor(session.connect(agent, lifetime.signal), lifetime.signal);
	assertLive$1(agent, lifetime);
	if (typeof native.models !== "function") throw new Error("BRIDGE_MODEL_UNSUPPORTED: 当前本机内核未提供模型目录。");
	const catalogSchema = runtime.catalogSchema;
	if (!catalogSchema) throw new Error("BRIDGE_CORE_UNAVAILABLE: 原生模型投影不可用。");
	const parsed = catalogSchema.safeParse(await waitFor(native.models(lifetime.signal), lifetime.signal));
	assertLive$1(agent, lifetime);
	if (!parsed.success) throw new Error("BRIDGE_MODEL_CATALOG_INVALID: 本机内核返回了不完整的模型目录。");
	const catalog = parsed.data;
	const ids = /* @__PURE__ */ new Set();
	for (const entry of catalog.models) {
		if (ids.has(entry.id)) throw new Error("BRIDGE_MODEL_CATALOG_INVALID: 本机模型目录包含重复标识。");
		ids.add(entry.id);
		const efforts = entry.reasoning?.efforts;
		if (efforts && (new Set(efforts.map((effort) => effort.id)).size !== efforts.length || entry.reasoning?.defaultEffort !== void 0 && !efforts.some((effort) => effort.id === entry.reasoning?.defaultEffort))) throw new Error("BRIDGE_MODEL_CATALOG_INVALID: 本机模型的推理深度目录不一致。");
	}
	if (catalog.defaultModel !== void 0 && !ids.has(catalog.defaultModel)) throw new Error("BRIDGE_MODEL_CATALOG_INVALID: 原生默认模型未包含在模型目录中。");
	if (catalog.defaultReasoningEffort !== void 0 && catalog.defaultModel === void 0) throw new Error("BRIDGE_MODEL_CATALOG_INVALID: 原生默认推理深度未关联默认模型。");
	return catalog;
}
function assertSelection(catalog, options) {
	const id = options.model ?? catalog.defaultModel;
	const entry = catalog.models.find((item) => item.id === id);
	if (options.model !== null && entry === void 0) throw new Error("BRIDGE_MODEL_UNAVAILABLE: 请选择当前原生内核支持的模型。");
	if (options.reasoningEffort !== null && !entry?.reasoning?.efforts.some((effort) => effort.id === options.reasoningEffort)) throw new Error("BRIDGE_REASONING_UNAVAILABLE: 当前原生模型不支持该推理深度。");
}
function sameOptions(left, right) {
	return left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
function assertLive$1(agent, lifetime) {
	lifetime.signal.throwIfAborted();
	const ctx = getHostContext();
	if (!runtime.ready || runtime.lifetime !== lifetime || ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session) throw new Error("BRIDGE_AGENT_REPLACED: 原生会话已关闭或被替换。");
}
//#endregion
//#region src/host/server/routes/models/get.ts
function getModels(request) {
	const ids = new URL(request.url).searchParams.getAll("sessionId");
	if (ids.length !== 1 || !ids[0].trim()) throw new RequestError("BRIDGE_SESSION_INVALID: 请指定原生会话。");
	return model.getCatalog(ids[0]);
}
//#endregion
//#region src/host/server/routes/models/post.ts
async function postModels(request) {
	const body = await readBody(request);
	if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new RequestError("BRIDGE_SESSION_INVALID: 请指定原生会话。");
	for (const key of ["model", "reasoningEffort"]) if (body[key] !== null && (typeof body[key] !== "string" || !body[key].trim())) throw new RequestError(`BRIDGE_MODEL_INVALID: ${key}`);
	return model.select(body.sessionId, {
		model: body.model,
		reasoningEffort: body.reasoningEffort
	});
}
//#endregion
//#region src/host/server/routes/sessions/post.ts
async function postSessions(request) {
	const body = await readBody(request);
	if (body.backend !== "codex" && body.backend !== "claude") throw new RequestError("BRIDGE_BACKEND_INVALID: 请选择 Codex 或 Claude。");
	for (const key of [
		"workspaceId",
		"cwd",
		"agentPreset"
	]) if (body[key] !== void 0 && (typeof body[key] !== "string" || !body[key].trim())) throw new RequestError(`BRIDGE_REQUEST_INVALID: ${key}`);
	if (body.workspaceId !== void 0 && body.cwd !== void 0) throw new RequestError("BRIDGE_LOCATION_INVALID: workspaceId 与 cwd 不能同时指定。");
	try {
		return await session.create(body.backend, body.workspaceId, body.cwd, body.agentPreset);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (!message.startsWith("BRIDGE_")) throw error;
		throw new RequestError(message);
	}
}
//#endregion
//#region src/host/server/index.ts
function server(ctx) {
	return ctx.effect(function* () {
		const routes = [
			{
				path: "/api/tauri/bridge/backends",
				methods: ["GET", "HEAD"],
				requestBody: "buffered",
				fetch: respond(getBackends)
			},
			{
				path: "/api/tauri/bridge/models",
				methods: [
					"GET",
					"HEAD",
					"POST"
				],
				requestBody: "buffered",
				fetch: respond((request) => request.method === "POST" ? postModels(request) : getModels(request))
			},
			{
				path: "/api/tauri/bridge/sessions",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: respond(postSessions)
			}
		];
		for (const route of routes) yield ctx.connection.fetch.register(route);
	}, "native bridge: authenticated Fetch routes");
	function respond(handler) {
		return async (request) => {
			let response;
			try {
				if (getHostContext() !== ctx) throw new Error("BRIDGE_DISPOSED: 原生桥接已卸载。");
				response = Response.json(await handler(request));
			} catch (error) {
				if (error instanceof RequestError) response = Response.json({ error: error.message }, { status: 400 });
				else {
					ctx.logger.error("Native bridge request failed", error);
					response = Response.json({ error: "BRIDGE_INTERNAL_ERROR: 原生桥接请求失败。" }, { status: 500 });
				}
			}
			return request.method === "HEAD" ? new Response(null, {
				status: response.status,
				headers: response.headers
			}) : response;
		};
	}
}
//#endregion
//#region src/host/service/adapter.ts
/**
* Sources that carry DSH-side environment state rather than content addressed to
* the model: policy switches, cwd notices, plugin run outcomes, and snapshots.
* The native kernel owns its own equivalents, so these never become native input
* and must not abort a running native turn. Real user instructions stay absent
* on purpose — steering a running native turn is still refused.
*/
const ENVIRONMENT_SOURCES = /* @__PURE__ */ new Set([
	"runtime-context",
	"time-context",
	"user-approval",
	"working-directory",
	"cordis-host-runner",
	"ptc-mode",
	"skill-catalog"
]);
const adapter = {
	async register() {
		const ctx = getHostContext();
		const modules = await loadRuntimeModules(ctx.loader);
		runtime.lifetime.signal.throwIfAborted();
		class NativeAdapter extends modules.LlmAdapter {
			providerInfo(provider) {
				return {
					id: provider,
					name: "本机内核桥接"
				};
			}
			providerRetryPolicy() {
				return {
					mode: "normal",
					maxRetries: 0,
					retryableCodes: [],
					initialDelayMs: 500,
					maxDelayMs: 1e4,
					jitterRatio: 0
				};
			}
			async listModels() {
				return [];
			}
			async resolveModel(provider, model, signal) {
				signal?.throwIfAborted();
				if (provider !== "dsh-tauri-kernel" || model !== "codex" && model !== "claude") throw new Error("BRIDGE_ROUTE_INVALID: 原生内核路由无效。");
				return {
					provider,
					id: model,
					name: model === "codex" ? "Codex" : "Claude"
				};
			}
			stream(options) {
				return adapter.stream(options);
			}
		}
		const dispose = ctx.llm.registerAdapter([BRIDGE_PROVIDER], new NativeAdapter());
		runtime.ready = true;
		return () => {
			runtime.ready = false;
			dispose();
		};
	},
	async admit(payload, next) {
		const closing = runtime.closings.get(payload.agent.id);
		if (closing) await closing.catch(() => void 0);
		let decision;
		try {
			decision = await next();
			const current = runtime.exchanges.get(payload.agent.id);
			if (current) {
				const state = current.state;
				if (decision.kind !== "enter" || payload.signal.aborted || state.failure !== void 0 || state.input.agent !== payload.agent || state.input.turn !== payload.turn || state.input.signal !== payload.signal || payload.messages.some((message) => continuationMessage(message, state.input.messages)) || decision.messages.some((message) => continuationMessage(message, state.input.messages) && !payload.messages.includes(message)) || state.finalConsumed) {
					state.controller.abort(state.failure ?? /* @__PURE__ */ new Error("BRIDGE_STEERING_UNSUPPORTED: 原生回合不支持中途追加指令或提前结束。"));
					await session.finish(payload.agent, state.input.turn);
					throw state.signal.reason;
				}
			}
		} catch (error) {
			const current = runtime.exchanges.get(payload.agent.id);
			if (current) {
				current.state.controller.abort(error);
				await session.finish(payload.agent, current.state.input.turn);
			}
			throw error;
		}
		if (decision.kind !== "enter" || payload.signal.aborted) return decision;
		await session.repairInherited(payload.agent, payload.signal);
		const binding = identity.stateOf(payload.agent.session)?.binding;
		if (binding === null || binding === void 0) {
			if (payload.agent.session.requestHeader()?.config.provider === "dsh-tauri-kernel") throw new Error("BRIDGE_BINDING_MISSING: 原生内核的官方身份记录缺失。");
			return decision;
		}
		identity.resolve(payload.agent);
		session.validateComposition(payload.agent);
		assertLive(payload.agent, payload.signal);
		runtime.steps.set(payload.agent.id, {
			...payload,
			messages: decision.messages.filter(nativeMessage),
			dispatched: false
		});
		return decision;
	},
	async request(payload, next) {
		const config = await next();
		const ctx = getHostContext();
		const projected = identity.stateOf(payload.agent.session)?.binding;
		if (projected === null || projected === void 0) {
			if (config.provider === "dsh-tauri-kernel" || payload.agent.session.requestHeader()?.config.provider === "dsh-tauri-kernel") throw new Error("BRIDGE_BINDING_MISSING: 原生内核的官方身份记录缺失。");
			return config;
		}
		const binding = identity.resolve(payload.agent);
		assertLive(payload.agent, payload.signal);
		const fallback = ctx.get("agentDefaultModel")?.currentSelection();
		const bound = config.provider === "dsh-tauri-kernel" && config.model === binding.backend;
		const ambient = payload.agent.session.requestHeader() === void 0 && fallback !== void 0 && config.provider === fallback.provider && config.model === fallback.model && config.reasoningEffort === fallback.reasoningEffort && config.maxTokens === void 0 && config.temperature === void 0 && config.stop === void 0;
		if (!bound && !ambient) throw new Error(`BRIDGE_KERNEL_IMMUTABLE: 已绑定会话不能切换内核或由 DSH 覆写原生选项（请求 ${config.provider}/${config.model}，当前内核 ${binding.backend}）。`);
		const { reasoningEffort: _effort, maxTokens: _maxTokens, temperature: _temperature, stop: _stop, ...native } = config;
		return {
			...native,
			provider: BRIDGE_PROVIDER,
			model: binding.backend
		};
	},
	async *capture(options, next) {
		if (options.provider !== "dsh-tauri-kernel") {
			yield* next();
			return;
		}
		if (options.purpose === "session-title") {
			yield* next();
			return;
		}
		const ctx = getHostContext();
		const modules = await loadRuntimeModules(ctx.loader);
		if (options.purpose !== void 0 || !modules.isAgentLoopRequest(options) || options.sessionId === void 0 || options.signal === void 0) throw new Error("BRIDGE_AUXILIARY_REQUEST: 原生内核仅接受官方会话回合，不支持辅助模型调用。");
		const admitted = runtime.steps.get(options.sessionId);
		if (!admitted || admitted.dispatched || admitted.request !== void 0 || admitted.signal !== options.signal) throw new Error("BRIDGE_STEP_UNAVAILABLE: 没有对应的官方已接纳回合。");
		assertLive(admitted.agent, options.signal);
		const boundary = ctx.agents.turnBoundaryOf(admitted.agent.session);
		if (boundary.lastTurn !== admitted.turn || boundary.openTurnStartSeq === null || boundary.lastStepBoundary?.kind !== "start" || boundary.lastStepBoundary.seq !== boundary.lastStepStartSeq) throw new Error("BRIDGE_STEP_UNAVAILABLE: 官方回合边界不再有效。");
		admitted.request = options;
		try {
			yield* next();
		} finally {
			if (runtime.steps.get(options.sessionId) === admitted) runtime.steps.delete(options.sessionId);
		}
	},
	async *stream(options) {
		if (options.purpose === "session-title") {
			yield* session.title(options);
			return;
		}
		const admitted = options.sessionId === void 0 ? void 0 : runtime.steps.get(options.sessionId);
		if (!admitted || admitted.dispatched || !admitted.request || options.purpose !== void 0 || options.signal !== admitted.signal || options.provider !== "dsh-tauri-kernel" || options.model !== admitted.request.model) throw new Error("BRIDGE_STEP_UNAVAILABLE: 原生请求未通过官方回合检查。");
		const binding = identity.resolve(admitted.agent);
		if (binding.backend !== options.model) throw new Error("BRIDGE_BINDING_MISMATCH: 请求与已提交的原生内核不一致。");
		assertLive(admitted.agent, admitted.signal);
		admitted.dispatched = true;
		const optionsForTurn = runtime.exchanges.get(admitted.agent.id)?.state.input.options ?? await model.forTurn(admitted.agent, admitted.signal);
		const state = (await session.execute({
			...admitted,
			binding,
			options: optionsForTurn
		})).state;
		let yieldedBoundary = false;
		try {
			while (true) {
				assertLive(admitted.agent, admitted.signal);
				state.signal.throwIfAborted();
				if (state.queue.length === 0) {
					if (state.done) {
						if (state.failure !== void 0) throw state.failure;
						throw new Error("BRIDGE_STREAM_UNSETTLED: 原生回合缺少终止边界。");
					}
					let wake;
					await new Promise((resolve) => {
						wake = resolve;
						state.wake = wake;
						state.signal.addEventListener("abort", wake, { once: true });
					}).finally(() => {
						state.signal.removeEventListener("abort", wake);
						if (state.wake === wake) state.wake = void 0;
					});
					continue;
				}
				const chunk = state.queue.shift();
				state.queuedBytes -= Buffer.byteLength(JSON.stringify(chunk));
				if (chunk.type === "block-end" && chunk.block.type === "tool-call") state.tools.get(chunk.block.id).step = admitted.step;
				if (chunk.type === "finish") {
					if (chunk.reason.kind === "stop") {
						await state.task;
						if (!state.done || state.failure !== void 0) throw state.failure ?? /* @__PURE__ */ new Error("BRIDGE_NATIVE_UNSETTLED: 原生回合尚未停止。");
						state.finalConsumed = true;
					}
					yieldedBoundary = true;
				}
				yield chunk;
				if (yieldedBoundary) return;
			}
		} finally {
			if (!yieldedBoundary) {
				state.controller.abort(/* @__PURE__ */ new Error("BRIDGE_STREAM_CLOSED"));
				await session.finish(admitted.agent, state.input.turn);
			}
			if (runtime.steps.get(admitted.agent.id) === admitted) runtime.steps.delete(admitted.agent.id);
		}
	},
	async remove(agent) {
		const current = runtime.exchanges.get(agent.id);
		if (current?.state.input.agent === agent) await session.finish(agent, current.state.input.turn);
		if (runtime.steps.get(agent.id)?.agent === agent) runtime.steps.delete(agent.id);
		await session.remove(agent.id, agent);
	},
	end(value, event) {
		sink.commitTool(value, event);
		if (event.type === "step/end" || event.type === "turn/end") {
			runtime.steps.delete(value.id);
			const current = runtime.exchanges.get(value.id);
			if (event.type === "turn/end" && current?.state.input.agent.session === value) session.finish(current.state.input.agent, current.state.input.turn).catch((error) => getHostContext().logger.warn("dsh-tauri-kernel: native turn drainage failed", error));
		}
	}
};
function nativeMessage(message) {
	return !ENVIRONMENT_SOURCES.has(message.source.kind);
}
function continuationMessage(message, entered) {
	if (message.source.kind === "agent-instructions") return !entered.some((previous) => JSON.stringify(previous.source) === JSON.stringify(message.source) && JSON.stringify(previous.content) === JSON.stringify(message.content));
	return nativeMessage(message);
}
function assertLive(agent, signal) {
	signal.throwIfAborted();
	runtime.lifetime.signal.throwIfAborted();
	if (!runtime.ready) throw new Error("BRIDGE_DISPOSED: 原生桥接已卸载。");
	const ctx = getHostContext();
	if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.id) !== agent.session || agent.status !== "running") throw new Error("BRIDGE_AGENT_REPLACED: 官方会话已关闭或被替换。");
}
//#endregion
//#region src/host/apply.ts
function apply(ctx, config = {}) {
	ctx.effect(async function* () {
		yield activateHost(ctx, config);
		runtime.lifetime = new AbortController();
		yield () => session.dispose();
		yield await identity.register();
		yield await model.register();
		yield await checkpoint.register();
		yield ctx.provide("nativeSessionBridge", {
			create: session.createInherited,
			prepare: session.prepare
		});
		yield ctx.on("agent/pre-step", adapter.admit, {
			global: true,
			prepend: true
		});
		yield ctx.on("agent/request", adapter.request, {
			global: true,
			prepend: true
		});
		yield ctx.on("llm/stream", adapter.capture, {
			global: true,
			prepend: true
		});
		yield ctx.on("tools/pre-execute", sink.admitTool, {
			global: true,
			prepend: true
		});
		yield ctx.on("tools/execute", sink.executeTool, {
			global: true,
			prepend: true
		});
		yield ctx.on("tools/post-execute", sink.finishTool, {
			global: true,
			prepend: true
		});
		yield ctx.on("tools/result", sink.acceptTool, { global: true });
		yield ctx.on("agent/turn-stopping", ({ agent, turn }) => session.finish(agent, turn), { global: true });
		yield ctx.on("session/event", adapter.end, { global: true });
		yield ctx.on("agent/disposed", ({ agent }) => {
			adapter.remove(agent).catch((error) => ctx.logger.warn("dsh-tauri-kernel: native session disposal failed", error));
		}, { global: true });
		yield await adapter.register();
		yield () => session.dispose();
		yield server(ctx);
	}, `${PLUGIN_ID}: official native adapter`);
}
//#endregion
//#region src/index.ts
const name = PLUGIN_ID;
const inject = [
	"connection",
	"llm",
	"agents",
	"sessions",
	"sessionProjections",
	"workspaceRegistry",
	"agentPresets",
	"loader",
	"approval",
	"userQuestions"
];
//#endregion
export { apply, inject, name };
