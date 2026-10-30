import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
//#region src/host/detect.ts
/** Children inherit the user's environment minus variables that would re-enter a harness. */
function nativeEnvironment(env = process.env) {
	const clean = { ...env };
	for (const key of Object.keys(clean)) if (/^(?:DSH_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_THREAD_ID|NODE_OPTIONS)$/i.test(key)) delete clean[key];
	return clean;
}
/** PATH directories, in order, from the process environment. */
function pathDirectories(env) {
	return (Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "").split(process.platform === "win32" ? ";" : delimiter).filter((entry) => entry !== "" && isAbsolute(entry));
}
async function executable(file) {
	try {
		if (!(await stat(file)).isFile()) return false;
		await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** Official JavaScript entry each vendor's Windows `.cmd` shim wraps. */
const SHIM_ENTRIES = {
	codex: /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/,
	claude: /node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/](?:cli\.js|bin[\\/]claude\.exe)/
};
/**
* Resolve one kernel's command without running it.
*
* npm installs three kinds of launcher: a native `.exe`, which runs directly; a
* `.cmd` shim, which `spawn` cannot execute without a shell; and — only on
* Windows — an extension-less POSIX script that is not executable there at all.
* The `.cmd` shim is therefore parsed and reduced to the entry it wraps, run with
* this process's own node binary. A shim that does not name the vendor's official
* entry is rejected rather than executed, because running an unrecognized batch
* file is a command-injection path, not a convenience.
*/
async function resolveExecutable(kernel, env = nativeEnvironment()) {
	const name = kernel === "codex" ? "codex" : "claude";
	for (const directory of pathDirectories(env)) {
		const extensions = process.platform === "win32" ? [".exe"] : [""];
		for (const extension of extensions) {
			const candidate = join(directory, `${name}${extension}`);
			if (await executable(candidate)) return {
				file: await realpath(candidate).catch(() => candidate),
				args: []
			};
		}
		if (process.platform !== "win32") continue;
		const shim = await shimCommand(join(directory, `${name}.cmd`), kernel);
		if (shim !== null) return shim;
	}
	return null;
}
/**
* Parse a Windows shim into the command that runs its payload.
* @returns the node command, or null when the shim is not the vendor's own.
*/
async function shimCommand(shim, kernel) {
	if (!await executable(shim)) return null;
	const text = await readFile(shim, "utf8").catch(() => "");
	const match = SHIM_ENTRIES[kernel].exec(text);
	if (match === null) return null;
	const entry = join(dirname(shim), match[0].replace(/[\\/]/g, "/"));
	if (!await executable(entry)) return null;
	const resolved = await realpath(entry).catch(() => entry);
	return /\.exe$/i.test(resolved) ? {
		file: resolved,
		args: []
	} : {
		file: process.execPath,
		args: [resolved]
	};
}
/** Run one bounded probe and collect its combined output. */
function probe(command, args, env, timeoutMs) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(command.file, [...command.args, ...args], {
				env,
				shell: false,
				windowsHide: true,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
		} catch (error) {
			reject(error);
			return;
		}
		let output = "";
		let bytes = 0;
		let settled = false;
		const timer = setTimeout(() => fail(/* @__PURE__ */ new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
		function cleanup() {
			clearTimeout(timer);
			child.stdout?.off("data", collect);
			child.stderr?.off("data", collect);
			child.off("close", close);
			child.off("error", fail);
		}
		function fail(error) {
			if (settled) return;
			settled = true;
			cleanup();
			child.kill();
			reject(error);
		}
		function collect(chunk) {
			bytes += chunk.byteLength;
			if (bytes > 256 * 1024) {
				fail(/* @__PURE__ */ new Error("probe output exceeded its limit"));
				return;
			}
			output += new TextDecoder().decode(chunk);
		}
		function close(code) {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({
				code,
				output
			});
		}
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", fail);
		child.on("close", close);
	});
}
/**
* Prove one kernel is usable, not merely present: the launcher must answer
* `--version` with a parseable version and advertise the streaming protocol the
* session layer drives. An install failing either check is reported as broken
* rather than handed a session.
*/
async function probeKernel(kernel, env = nativeEnvironment()) {
	const command = await resolveExecutable(kernel, env);
	if (command === null) return {
		installed: false,
		version: null,
		executable: null,
		command: null,
		hint: kernel === "codex" ? "未找到 codex 命令，选中本项会自动全局安装。" : "未找到 claude 命令，选中本项会自动全局安装。"
	};
	const label = command.args.length === 0 ? command.file : command.args.join(" ");
	try {
		const version = await probe(command, ["--version"], env, 15e3);
		if (version.code !== 0) return {
			installed: false,
			version: null,
			executable: label,
			command: null,
			hint: "内核无法启动，请检查该安装。"
		};
		const match = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(version.output);
		if (match === null) return {
			installed: false,
			version: null,
			executable: label,
			command: null,
			hint: "内核未返回可识别版本。"
		};
		const help = await probe(command, kernel === "codex" ? ["app-server", "--help"] : ["--help"], env, 15e3);
		if (!(help.code === 0 && (kernel === "codex" || /stream-json/.test(help.output)))) return {
			installed: false,
			version: match[0],
			executable: label,
			command: null,
			hint: "内核版本过旧，不支持所需的流式协议。"
		};
		return {
			installed: true,
			version: match[0],
			executable: label,
			command,
			hint: null
		};
	} catch (error) {
		return {
			installed: false,
			version: null,
			executable: label,
			command: null,
			hint: error instanceof Error ? error.message : "内核探测失败。"
		};
	}
}
//#endregion
//#region src/host/session-types.ts
/** Collect a question frame's questions into the shared shape. */
function questionsOf(value) {
	if (!Array.isArray(value) || value.length === 0) return [];
	return value.map((raw, index) => {
		const question = raw;
		const id = typeof question.id === "string" && question.id !== "" ? question.id : `q${index}`;
		const text = typeof question.question === "string" && question.question !== "" ? question.question : id;
		const options = Array.isArray(question.options) ? question.options.flatMap((entry) => {
			const option = entry;
			const label = typeof option.label === "string" ? option.label : "";
			if (label === "") return [];
			return [{
				label,
				...typeof option.description === "string" ? { description: option.description } : {}
			}];
		}) : void 0;
		return {
			id,
			question: text,
			...options === void 0 ? {} : { options },
			...typeof question.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}
		};
	});
}
/**
* Human-readable approval text: the native reason plus only the fields that
* identify what is being approved. Protocol plumbing (ids, timestamps, decision
* menus) is unreadable in a permission prompt.
*/
function approvalDetails(fallback, params, fields) {
	const lines = [typeof params.reason === "string" && params.reason.trim() !== "" ? params.reason.trim() : fallback];
	for (const field of fields) {
		const value = params[field];
		if (value === void 0 || value === null || value === "") continue;
		lines.push(`${field}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return lines.join("\n");
}
//#endregion
//#region src/host/transport.ts
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 1500;
/** Default budget for one control request. */
const REQUEST_TIMEOUT_MS = 6e4;
/** Budget for interrupt-style requests that must not hang a turn. */
const INTERRUPT_TIMEOUT_MS = 5e3;
var BridgeError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "BridgeError";
	}
};
function errorFrom(value) {
	return value instanceof Error ? value : new Error(String(value));
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
/** Parse a protocol frame, rejecting anything that is not a JSON object. */
function record(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("BRIDGE_PROTOCOL", "Expected a native protocol object");
	return value;
}
function stringField(value, key) {
	if (typeof value[key] !== "string" || value[key] === "") throw new BridgeError("BRIDGE_PROTOCOL", `Missing native protocol field: ${key}`);
	return value[key];
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** Correlates request ids with their pending promises. */
var PendingRequests = class {
	write;
	requests = /* @__PURE__ */ new Map();
	constructor(write) {
		this.write = write;
	}
	request(id, frame, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
		if (signal?.aborted) return Promise.reject(new BridgeError("BRIDGE_ABORTED", "Request was cancelled"));
		const result = deferred();
		const settle = (error, value) => {
			const pending = this.requests.get(id);
			if (!pending) return;
			this.requests.delete(id);
			clearTimeout(pending.timer);
			pending.removeAbort();
			if (error) result.reject(error);
			else result.resolve(value);
		};
		const aborted = () => settle(new BridgeError("BRIDGE_ABORTED", "Request was cancelled"));
		const timer = setTimeout(() => settle(new BridgeError("BRIDGE_REQUEST_TIMEOUT", "Native control request timed out")), timeoutMs);
		const removeAbort = () => signal?.removeEventListener("abort", aborted);
		this.requests.set(id, {
			finish: settle,
			timer,
			removeAbort
		});
		signal?.addEventListener("abort", aborted, { once: true });
		try {
			this.write(frame);
		} catch (error) {
			settle(errorFrom(error));
		}
		return result.promise;
	}
	settle(id, value, error) {
		this.requests.get(id)?.finish(error, value);
	}
	failAll(error) {
		for (const id of [...this.requests.keys()]) this.settle(id, void 0, error);
	}
};
/** One long-lived JSON-lines child process. */
var JsonLinesProcess = class {
	child;
	closed = deferred();
	input = "";
	stderr = "";
	failure;
	closing;
	stopped = false;
	exited = false;
	handler;
	failureHandler;
	constructor(command, args, cwd, env) {
		if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command.file)) throw new BridgeError("BRIDGE_UNSAFE_EXECUTABLE", "Windows 批处理包装器必须先解析为原生可执行文件");
		this.child = spawn(command.file, [...command.args, ...args], {
			cwd,
			env,
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
			if (!this.stopped) this.fail(new BridgeError("BRIDGE_PROCESS_EXIT", `内核进程已退出（${signal ?? code}）${this.stderr.trim() ? `：${this.stderr.trim()}` : ""}`));
			this.stopped = true;
			this.exited = true;
			this.closed.resolve();
		});
	}
	onMessage(handler) {
		this.handler = handler;
	}
	onFailure(handler) {
		this.failureHandler = handler;
		if (this.failure) handler(this.failure);
	}
	write(value) {
		if (this.failure) throw this.failure;
		if (this.stopped || !this.child.stdin.writable) throw new BridgeError("BRIDGE_PROCESS_CLOSED", "内核进程不可写入");
		const line = `${JSON.stringify(value)}\n`;
		if (line.length > MAX_FRAME_CHARS) throw new BridgeError("BRIDGE_FRAME_LIMIT", "原生协议帧超过传输上限");
		this.child.stdin.write(line);
	}
	fail(error) {
		if (this.failure) return;
		this.failure = error;
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
		if (graceful) {
			this.child.stdin.end();
			if (await this.waitForExit()) return;
		}
		this.child.stdin.destroy();
		this.child.kill("SIGTERM");
		if (await this.waitForExit()) return;
		this.child.kill("SIGKILL");
		if (!await this.waitForExit()) throw new BridgeError("BRIDGE_PROCESS_STOP_TIMEOUT", "内核进程未能终止");
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
				this.fail(new BridgeError("BRIDGE_FRAME_LIMIT", "原生协议帧超过传输上限"));
				return;
			}
			if (line !== "") try {
				const message = record(JSON.parse(line));
				this.handler?.(message);
			} catch (error) {
				this.fail(error instanceof BridgeError ? error : new BridgeError("BRIDGE_PROTOCOL", `无法解析原生输出：${errorFrom(error).message}`));
				return;
			}
			if (this.stopped || this.failure) return;
			end = this.input.indexOf("\n");
		}
		if (this.input.length > MAX_FRAME_CHARS) this.fail(new BridgeError("BRIDGE_FRAME_LIMIT", "原生协议帧超过传输上限"));
	}
};
//#endregion
//#region src/host/claude.ts
var ClaudeSession = class {
	transport;
	requests;
	waiters = /* @__PURE__ */ new Map();
	approvals = /* @__PURE__ */ new Map();
	nativeId = randomUUID();
	active;
	failure;
	disposed = false;
	disposePromise;
	constructor(executable, cwd) {
		this.transport = new JsonLinesProcess(executable, [
			"--print",
			"--verbose",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--permission-prompt-tool",
			"stdio",
			`--session-id=${this.nativeId}`
		], cwd, {
			...nativeEnvironment(),
			CLAUDE_CODE_SDK_READS_SESSION_STATE: "1"
		});
		this.requests = new PendingRequests((value) => this.transport.write(value));
		this.transport.onFailure((error) => {
			this.failure = error;
			this.requests.failAll(error);
			this.waiters.clear();
			this.approvals.clear();
			this.active?.finish(error);
		});
		this.transport.onMessage((message) => this.receive(message));
	}
	get id() {
		return this.nativeId;
	}
	async open(signal) {
		signal.throwIfAborted();
		const reported = optionalString(record(await this.control({
			subtype: "initialize",
			hooks: { SessionStart: [{ hookCallbackIds: ["dsh-third-kernel"] }] }
		}, signal)).session_id);
		if (reported !== void 0 && reported !== this.nativeId) throw new BridgeError("BRIDGE_RESUME_MISMATCH", "Claude 返回了不同的会话标识");
	}
	async models(signal) {
		const response = record(await this.control({ subtype: "initialize" }, signal));
		if (!Array.isArray(response.models)) return [];
		return response.models.flatMap((value) => {
			const model = record(value);
			const name = optionalString(model.displayName) ?? optionalString(model.value);
			if (name === void 0) return [];
			const levels = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((level) => typeof level === "string") : [];
			return [levels.length === 0 ? name : `${name} · ${levels.join("/")}`];
		});
	}
	async *run(input, signal) {
		if (this.disposed || this.failure) throw this.failure ?? new BridgeError("BRIDGE_PROCESS_CLOSED", "Claude 会话已关闭");
		if (this.active !== void 0) throw new BridgeError("BRIDGE_BUSY", "Claude 会话已有正在进行的回合");
		const events = [];
		let wake;
		let finished = false;
		let terminalError;
		const state = {
			yieldEvent: (event) => {
				events.push(event);
				wake?.();
				wake = void 0;
			},
			finish: (error) => {
				terminalError = error;
				finished = true;
				wake?.();
				wake = void 0;
			},
			tools: /* @__PURE__ */ new Map(),
			streamed: /* @__PURE__ */ new Set(),
			resultReceived: false
		};
		this.active = state;
		const aborted = () => {
			if (!state.resultReceived) this.control({ subtype: "interrupt" }, void 0, INTERRUPT_TIMEOUT_MS).catch(() => {});
		};
		signal.addEventListener("abort", aborted, { once: true });
		try {
			this.transport.write({
				type: "user",
				session_id: this.nativeId,
				uuid: randomUUID(),
				parent_tool_use_id: null,
				message: {
					role: "user",
					content: [{
						type: "text",
						text: input.text
					}]
				}
			});
			while (true) {
				if (events.length > 0) {
					const event = events.shift();
					yield event;
					if (event.type === "done") return;
					continue;
				}
				if (finished) {
					if (terminalError !== void 0) {
						yield {
							type: "error",
							message: terminalError.message
						};
						return;
					}
					yield { type: "done" };
					return;
				}
				await new Promise((resolve) => {
					wake = resolve;
				});
			}
		} catch (error) {
			const reason = errorFrom(error);
			if (this.failure === void 0 && !signal.aborted) this.transport.fail(reason);
			yield {
				type: "error",
				message: reason.message
			};
		} finally {
			signal.removeEventListener("abort", aborted);
			this.approvals.clear();
			if (this.active === state) this.active = void 0;
		}
	}
	answer(id, value) {
		const waiter = this.waiters.get(id);
		if (waiter === void 0) return;
		this.waiters.delete(id);
		if (waiter.kind === "approval" && value.kind === "approval") waiter.resolve(value.allowed);
		else if (waiter.kind === "question" && value.kind === "question") waiter.resolve(value.answers);
	}
	async interrupt() {
		if (this.active !== void 0) await this.control({ subtype: "interrupt" }, void 0, INTERRUPT_TIMEOUT_MS).catch(() => {});
	}
	dispose() {
		this.disposePromise ??= this.close();
		return this.disposePromise;
	}
	async close() {
		this.disposed = true;
		const error = new BridgeError("BRIDGE_PROCESS_CLOSED", "Claude 会话已关闭");
		this.requests.failAll(error);
		this.waiters.clear();
		this.approvals.clear();
		this.active?.finish(error);
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
	receive(message) {
		const type = stringField(message, "type");
		if (type === "control_response") {
			const response = record(message.response);
			const id = stringField(response, "request_id");
			if (response.subtype === "success") this.requests.settle(id, response.response ?? {});
			else this.requests.settle(id, void 0, new BridgeError("BRIDGE_NATIVE_REQUEST", optionalString(response.error) ?? "内核拒绝了控制请求"));
			return;
		}
		if (type === "control_request") {
			const id = stringField(message, "request_id");
			this.handleRequest(id, record(message.request)).catch((error) => {
				this.transport.write({
					type: "control_response",
					response: {
						subtype: "error",
						request_id: id,
						error: errorFrom(error).message
					}
				});
			});
			return;
		}
		if (type === "control_cancel_request") {
			const id = stringField(message, "request_id");
			this.approvals.get(id)?.abort(new BridgeError("BRIDGE_REQUEST_CLOSED", "Claude 撤回了该请求"));
			this.approvals.delete(id);
			return;
		}
		if (type === "conversation_reset") throw new BridgeError("BRIDGE_NATIVE_RESET", "Claude 重置了会话，已绑定会话不能被静默替换");
		const turn = this.active;
		if (type === "result") {
			const error = message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools" ? new BridgeError("BRIDGE_ABORTED", "回合已取消") : message.is_error === true || message.subtype !== "success" ? new BridgeError("BRIDGE_NATIVE_TURN", optionalString(message.result) ?? JSON.stringify(message.errors ?? message.subtype)) : void 0;
			if (turn === void 0) {
				if (error !== void 0) this.transport.fail(error);
				return;
			}
			turn.resultReceived = true;
			turn.finish(error);
			return;
		}
		if (turn === void 0) return;
		if (type === "stream_event") this.stream(turn, record(message.event ?? {}));
		else if (type === "assistant") this.assistantText(turn, record(message.message ?? {}));
		else this.toolResults(turn, record(message.message ?? {}));
	}
	/** Translate one streamed content-block delta; mirrors the Anthropic stream events. */
	stream(turn, event) {
		const type = optionalString(event.type);
		const index = typeof event.index === "number" ? event.index : 0;
		if (type === "content_block_start") {
			const block = record(event.content_block ?? {});
			if (block.type === "tool_use") {
				const id = stringField(block, "id");
				turn.tools.set(id, {
					output: "",
					ended: false
				});
				turn.yieldEvent({
					type: "tool-start",
					id,
					name: stringField(block, "name"),
					input: JSON.stringify(block.input ?? {})
				});
			}
			return;
		}
		if (type !== "content_block_delta") return;
		const delta = record(event.delta ?? {});
		if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
			turn.streamed.add(index);
			turn.yieldEvent({
				type: "text",
				id: `t${index}`,
				delta: delta.text
			});
		} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") turn.yieldEvent({
			type: "thinking",
			id: `r${index}`,
			delta: delta.thinking
		});
	}
	/** Text-only fallback for blocks that carried no streamed partials. */
	assistantText(turn, message) {
		if (!Array.isArray(message.content)) return;
		message.content.forEach((value, index) => {
			const block = record(value);
			if (block.type !== "text" || typeof block.text !== "string" || block.text === "") return;
			if (turn.streamed.has(index)) return;
			turn.streamed.add(index);
			turn.yieldEvent({
				type: "text",
				id: `t${index}`,
				delta: block.text
			});
		});
	}
	/** Complete tools announced by an earlier frame once their results arrive. */
	toolResults(turn, message) {
		if (!Array.isArray(message.content)) return;
		for (const value of message.content) {
			const block = record(value);
			if (block.type !== "tool_result") continue;
			const id = stringField(block, "tool_use_id");
			const tool = turn.tools.get(id);
			if (tool === void 0 || tool.ended) continue;
			tool.ended = true;
			const output = Array.isArray(block.content) ? block.content.map((part) => {
				const inner = record(part);
				return inner.type === "text" && typeof inner.text === "string" ? inner.text : JSON.stringify(inner);
			}).join("\n") : optionalString(block.content) ?? JSON.stringify(block.content ?? "");
			turn.yieldEvent({
				type: "tool-end",
				id,
				output,
				error: block.is_error === true
			});
		}
	}
	/** Answer a server-to-client control request: permissions and questions. */
	async handleRequest(id, request) {
		const turn = this.active;
		const subtype = optionalString(request.subtype) ?? "";
		const respond = (result) => {
			this.transport.write({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: id,
					response: result
				}
			});
		};
		if (subtype === "can_use_tool") {
			if (turn === void 0) {
				respond({
					behavior: "deny",
					message: "没有进行中的回合"
				});
				return;
			}
			const tool = optionalString(request.tool_name) ?? "tool";
			turn.yieldEvent({
				type: "approval",
				id,
				kind: "tool",
				title: `${tool} 需要许可`,
				details: approvalDetails(`Claude 请求运行 ${tool}`, record(request.input ?? {}), [
					"command",
					"file_path",
					"path",
					"url",
					"pattern"
				])
			});
			respond(await new Promise((resolve) => {
				this.waiters.set(id, {
					kind: "approval",
					resolve
				});
			}) ? {
				behavior: "allow",
				updatedInput: record(request.input ?? {})
			} : {
				behavior: "deny",
				message: "用户拒绝了该操作"
			});
			return;
		}
		if (subtype === "ask_user_question" || subtype === "user_question") {
			if (turn === void 0) {
				respond({ answers: {} });
				return;
			}
			const questions = questionsOf(request.questions);
			turn.yieldEvent({
				type: "question",
				id,
				questions
			});
			respond({ answers: await new Promise((resolve) => {
				this.waiters.set(id, {
					kind: "question",
					resolve
				});
			}) });
			return;
		}
		respond({});
	}
};
//#endregion
//#region src/host/codex.ts
const INITIALIZATION = {
	clientInfo: {
		name: "dsh-third-kernel",
		title: "DSH third-party kernel",
		version: "0.1.0"
	},
	capabilities: { experimentalApi: true }
};
const EFFORT_NAMES = /* @__PURE__ */ new Map([
	["none", "Off"],
	["minimal", "Minimal"],
	["low", "Low"],
	["medium", "Medium"],
	["high", "High"],
	["xhigh", "Extra High"],
	["max", "Max"]
]);
var CodexSession = class {
	resolveCwd;
	transport;
	requests;
	waiters = /* @__PURE__ */ new Map();
	approvals = /* @__PURE__ */ new Map();
	commandItems = /* @__PURE__ */ new Set();
	requestId = 0;
	nativeId = "";
	active;
	failure;
	disposed = false;
	disposePromise;
	constructor(executable, cwd, resolveCwd) {
		this.resolveCwd = resolveCwd;
		this.transport = new JsonLinesProcess(executable, [
			"app-server",
			"--listen",
			"stdio://"
		], cwd, nativeEnvironment());
		this.requests = new PendingRequests((value) => this.transport.write(value));
		this.transport.onFailure((error) => {
			this.failure = error;
			this.requests.failAll(error);
			this.waiters.clear();
			this.approvals.clear();
			this.active?.finish(error);
		});
		this.transport.onMessage((message) => this.receive(message));
	}
	get id() {
		return this.nativeId;
	}
	/** Complete the handshake and open the native thread this session owns. */
	async open(signal) {
		signal.throwIfAborted();
		if (typeof record(await this.request("initialize", INITIALIZATION, signal)).userAgent !== "string") throw new BridgeError("BRIDGE_PROTOCOL", "Codex 未在初始化时表明身份");
		this.transport.write({
			method: "initialized",
			params: {}
		});
		const thread = record(await this.request("thread/start", { cwd: this.resolveCwd() }, signal));
		this.nativeId = stringField(record(thread.thread), "id");
	}
	async models(signal) {
		const response = record(await this.request("model/list", {
			limit: 100,
			includeHidden: false
		}, signal));
		if (!Array.isArray(response.data)) return [];
		return response.data.flatMap((value) => {
			const model = value;
			const id = optionalString(model.model) ?? optionalString(model.id);
			if (id === void 0) return [];
			const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.flatMap((entry) => {
				const label = entry.reasoningEffort;
				if (typeof label !== "string" || label === "") return [];
				return [EFFORT_NAMES.get(label) ?? label];
			}) : [];
			return [efforts.length === 0 ? id : `${id} · ${efforts.join("/")}`];
		});
	}
	async *run(input, signal) {
		if (this.disposed || this.failure) throw this.failure ?? new BridgeError("BRIDGE_PROCESS_CLOSED", "Codex 会话已关闭");
		if (this.active !== void 0) throw new BridgeError("BRIDGE_BUSY", "Codex 会话已有正在进行的回合");
		const events = [];
		let wake;
		let finished = false;
		let terminalError;
		const state = {
			yieldEvent: (event) => {
				events.push(event);
				wake?.();
				wake = void 0;
			},
			finish: (error) => {
				terminalError = error;
				finished = true;
				wake?.();
				wake = void 0;
			},
			tools: /* @__PURE__ */ new Map(),
			assistants: /* @__PURE__ */ new Set(),
			text: /* @__PURE__ */ new Map(),
			thinking: /* @__PURE__ */ new Map(),
			track: /* @__PURE__ */ new Map(),
			interrupted: false
		};
		this.active = state;
		const aborted = () => {
			state.interrupted = true;
			if (this.activeTurnId !== void 0 && !this.interruptSent) {
				this.interruptSent = true;
				this.request("turn/interrupt", {
					threadId: this.nativeId,
					turnId: this.activeTurnId
				}, void 0, INTERRUPT_TIMEOUT_MS).catch(() => {});
			}
		};
		signal.addEventListener("abort", aborted, { once: true });
		try {
			const response = record(await this.request("turn/start", {
				threadId: this.nativeId,
				input: [{
					type: "text",
					text: input.text,
					text_elements: []
				}]
			}, signal));
			this.activeTurnId = stringField(record(response.turn), "id");
			if (signal.aborted) aborted();
			while (true) {
				if (events.length > 0) {
					const event = events.shift();
					yield event;
					if (event.type === "done") return;
					continue;
				}
				if (finished) {
					if (terminalError !== void 0) {
						yield {
							type: "error",
							message: terminalError.message
						};
						return;
					}
					yield { type: "done" };
					return;
				}
				await new Promise((resolve) => {
					wake = resolve;
				});
			}
		} catch (error) {
			const reason = errorFrom(error);
			if (this.failure === void 0 && !signal.aborted) this.transport.fail(reason);
			yield {
				type: "error",
				message: reason.message
			};
		} finally {
			signal.removeEventListener("abort", aborted);
			this.activeTurnId = void 0;
			this.interruptSent = false;
			this.approvals.clear();
			if (this.active === state) this.active = void 0;
		}
	}
	activeTurnId;
	interruptSent = false;
	answer(id, value) {
		const waiter = this.waiters.get(id);
		if (waiter === void 0) return;
		this.waiters.delete(id);
		if (waiter.kind === "approval" && value.kind === "approval") waiter.resolve(value.allowed);
		else if (waiter.kind === "question" && value.kind === "question") waiter.resolve(value.answers);
	}
	async interrupt() {
		if (this.activeTurnId === void 0) return;
		await this.request("turn/interrupt", {
			threadId: this.nativeId,
			turnId: this.activeTurnId
		}, void 0, INTERRUPT_TIMEOUT_MS).catch(() => {});
	}
	dispose() {
		this.disposePromise ??= this.close();
		return this.disposePromise;
	}
	async close() {
		this.disposed = true;
		const error = new BridgeError("BRIDGE_PROCESS_CLOSED", "Codex 会话已关闭");
		this.requests.failAll(error);
		this.waiters.clear();
		this.approvals.clear();
		this.active?.finish(error);
		try {
			await this.transport.close(this.active === void 0);
		} catch {}
	}
	request(method, params, signal, timeoutMs) {
		const id = ++this.requestId;
		return this.requests.request(id, {
			id,
			method,
			params
		}, signal, timeoutMs);
	}
	receive(message) {
		const id = message.id;
		const method = optionalString(message.method);
		if (typeof id === "number" || typeof id === "string") {
			if (method === void 0) {
				const error = message.error === void 0 ? void 0 : record(message.error);
				this.requests.settle(id, message.result, error === void 0 ? void 0 : new BridgeError("BRIDGE_NATIVE_REQUEST", optionalString(error.message) ?? JSON.stringify(error)));
				return;
			}
			this.handleRequest(id, method, record(message.params ?? {})).catch((error) => {
				this.transport.write({
					id,
					error: {
						code: -32603,
						message: errorFrom(error).message
					}
				});
			});
			return;
		}
		if (method === void 0) return;
		this.notify(method, record(message.params ?? {}));
	}
	/** Answer a server-to-client request: approvals and user-input prompts. */
	async handleRequest(id, method, params) {
		const turn = this.active;
		const turnId = optionalString(params.turnId);
		const belongs = turn !== void 0 && params.threadId === this.nativeId && (turnId === void 0 || turnId === this.activeTurnId) && !this.waiters.has(String(id));
		const key = String(id);
		try {
			if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
				const command = method === "item/commandExecution/requestApproval";
				if (!belongs) {
					this.transport.write({
						id,
						result: { decision: "decline" }
					});
					return;
				}
				turn.yieldEvent({
					type: "approval",
					id: key,
					kind: command ? "command" : "file",
					title: command && typeof params.command === "string" ? params.command : command ? "Codex 命令执行" : "Codex 文件变更",
					details: approvalDetails(command ? "Codex 需要执行命令" : "Codex 需要修改文件", params, command ? ["command", "cwd"] : ["grantRoot"])
				});
				const allowed = await new Promise((resolve) => {
					this.waiters.set(key, {
						kind: "approval",
						resolve
					});
				});
				const decisions = params.availableDecisions;
				const once = !Array.isArray(decisions) || decisions.includes("accept");
				this.transport.write({
					id,
					result: { decision: once ? allowed ? "accept" : "decline" : "cancel" }
				});
				return;
			}
			if (method === "item/permissions/requestApproval") {
				if (!belongs) {
					this.transport.write({
						id,
						result: {
							permissions: {},
							scope: "turn"
						}
					});
					return;
				}
				turn.yieldEvent({
					type: "approval",
					id: key,
					kind: "tool",
					title: "Codex 请求额外权限",
					details: approvalDetails("Codex 请求额外权限", params, ["permissions"])
				});
				const allowed = await new Promise((resolve) => {
					this.waiters.set(key, {
						kind: "approval",
						resolve
					});
				});
				this.transport.write({
					id,
					result: {
						permissions: allowed ? record(params.permissions ?? {}) : {},
						scope: "turn"
					}
				});
				return;
			}
			if (method === "item/tool/requestUserInput") {
				if (!belongs) {
					this.transport.write({
						id,
						error: {
							code: -32601,
							message: "没有对应的进行中回合"
						}
					});
					return;
				}
				const questions = questionsOf(params.questions);
				turn.yieldEvent({
					type: "question",
					id: key,
					questions
				});
				const answers = await new Promise((resolve) => {
					this.waiters.set(key, {
						kind: "question",
						resolve
					});
				});
				this.transport.write({
					id,
					result: { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: Array.isArray(answers[question.id]) ? answers[question.id] : [answers[question.id] ?? ""] }])) }
				});
				return;
			}
			this.transport.write({
				id,
				error: {
					code: -32601,
					message: `不支持的内核请求：${method}`
				}
			});
		} finally {
			this.approvals.delete(id);
		}
	}
	notify(method, params) {
		const turn = this.active;
		if (turn === void 0 || params.threadId !== this.nativeId) return;
		const nativeTurn = method === "turn/started" || method === "turn/completed" ? record(params.turn ?? {}) : void 0;
		const turnId = nativeTurn?.id ?? params.turnId;
		if (typeof turnId === "string") {
			if (turnId !== this.activeTurnId && this.activeTurnId !== void 0) return;
			this.activeTurnId ??= turnId;
		}
		switch (method) {
			case "turn/started": return;
			case "turn/completed": {
				const completed = nativeTurn ?? {};
				if (Array.isArray(completed.items)) for (const value of completed.items) {
					const item = record(value);
					const tool = turn.tools.get(String(item.id));
					if (tool !== void 0 && !tool.ended && (item.status === "completed" || item.status === "failed" || item.status === "declined")) this.item(turn, item, true);
				}
				const status = optionalString(completed.status) ?? "completed";
				if (status === "interrupted" && !turn.interrupted) turn.finish(new BridgeError("BRIDGE_NATIVE_INTERRUPTED", "Codex 中断了该回合"));
				else if (status !== "completed" && status !== "interrupted") turn.finish(new BridgeError("BRIDGE_NATIVE_TURN", `Codex 回合以 ${status} 结束`));
				else turn.finish(turn.interrupted ? new BridgeError("BRIDGE_ABORTED", "回合已取消") : void 0);
				return;
			}
			case "error":
				if (params.willRetry !== true) turn.finish(new BridgeError("BRIDGE_NATIVE_TURN", optionalString(record(params.error ?? {}).message) ?? JSON.stringify(params.error ?? params)));
				return;
			case "item/agentMessage/delta":
			case "item/plan/delta": {
				const id = stringField(params, "itemId");
				const delta = stringField(params, "delta");
				turn.text.set(id, (turn.text.get(id) ?? "") + delta);
				turn.yieldEvent({
					type: "text",
					id,
					delta
				});
				return;
			}
			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/textDelta": {
				const id = stringField(params, "itemId");
				const delta = stringField(params, "delta");
				const name = `${id}:${method === "item/reasoning/textDelta" ? "raw" : "summary"}`;
				turn.thinking.set(name, (turn.thinking.get(name) ?? "") + delta);
				if (!turn.track.has(id)) turn.track.set(id, name);
				if (turn.track.get(id) === name) turn.yieldEvent({
					type: "thinking",
					id,
					delta
				});
				return;
			}
			case "item/commandExecution/outputDelta":
			case "item/fileChange/outputDelta": {
				const tool = turn.tools.get(stringField(params, "itemId"));
				if (tool !== void 0) {
					const delta = optionalString(params.delta) ?? "";
					tool.output += delta;
					if (delta !== "") turn.yieldEvent({
						type: "tool-output",
						id: stringField(params, "itemId"),
						delta
					});
				}
				return;
			}
			case "item/started":
			case "item/completed": this.item(turn, record(params.item ?? {}), method === "item/completed");
		}
	}
	/** Project one native item into assistant text / thinking / tool events. */
	item(turn, item, completed) {
		const id = stringField(item, "id");
		const type = stringField(item, "type");
		if (type === "commandExecution") this.commandItems.add(id);
		const tool = nativeTool(item);
		if (tool !== void 0) {
			if (!turn.tools.has(id)) {
				turn.tools.set(id, {
					output: "",
					ended: false
				});
				turn.yieldEvent({
					type: "tool-start",
					id,
					name: tool.name,
					input: tool.input
				});
			}
			const state = turn.tools.get(id);
			if (completed && !state.ended) {
				state.ended = true;
				const output = optionalString(item.aggregatedOutput) ?? (state.output !== "" ? state.output : JSON.stringify(item.result ?? item.contentItems ?? item.changes ?? item.error ?? item));
				const error = item.status === "failed" || item.status === "declined" || item.error !== void 0 && item.error !== null || item.success === false || typeof item.exitCode === "number" && item.exitCode !== 0;
				turn.yieldEvent({
					type: "tool-end",
					id,
					output,
					error
				});
			}
			return;
		}
		if (!completed || turn.assistants.has(id)) return;
		if (type === "agentMessage" || type === "plan") {
			turn.assistants.add(id);
			if (turn.text.has(id)) return;
			const full = optionalString(item.text) ?? "";
			if (full !== "") turn.yieldEvent({
				type: "text",
				id,
				delta: full
			});
			return;
		}
		let text = "";
		if (type === "reasoning") {
			text = arrayText(item.summary) || turn.thinking.get(`${id}:summary`) || arrayText(item.content) || turn.thinking.get(`${id}:raw`) || "";
			if (turn.thinking.has(`${id}:summary`) || turn.thinking.has(`${id}:raw`)) text = "";
		} else if (type === "enteredReviewMode" || type === "exitedReviewMode") text = optionalString(item.review) ?? "";
		else if (type === "userMessage" || type === "hookPrompt" || type === "contextCompaction" || type === "subAgentActivity") return;
		else text = JSON.stringify(item);
		turn.assistants.add(id);
		if (text !== "") turn.yieldEvent({
			type: "text",
			id: `${id}:final`,
			delta: text
		});
	}
};
/** Join a native array of text parts, ignoring any non-string entry. */
function arrayText(value) {
	return Array.isArray(value) ? value.filter((part) => typeof part === "string").join("\n") : "";
}
/** Human-readable tool identity for one native item, or undefined when it is not a tool. */
function nativeTool(item) {
	switch (item.type) {
		case "commandExecution": return {
			name: "command",
			input: JSON.stringify({
				command: item.command,
				cwd: item.cwd
			})
		};
		case "fileChange": return {
			name: "fileChange",
			input: JSON.stringify({ changes: item.changes })
		};
		case "mcpToolCall": return {
			name: `mcp::${String(item.server)}/${String(item.tool)}`,
			input: JSON.stringify(item.arguments ?? {})
		};
		case "dynamicToolCall": return {
			name: String(item.tool),
			input: JSON.stringify(item.arguments ?? {})
		};
		case "collabAgentToolCall": return {
			name: `agent::${String(item.tool)}`,
			input: JSON.stringify({
				prompt: item.prompt,
				model: item.model
			})
		};
		case "webSearch":
		case "imageView":
		case "imageGeneration":
		case "sleep": {
			const { id: _id, type, ...rest } = item;
			return {
				name: String(type),
				input: JSON.stringify(rest)
			};
		}
		default: return;
	}
}
//#endregion
//#region src/host/registry.ts
const sessions = /* @__PURE__ */ new Map();
/**
* Start a kernel child in `cwd`, complete its handshake, and register it.
* The native id is the browser-facing key, so a restarted kernel gets a fresh
* one and stale requests fail closed instead of reaching a stranger.
*/
async function openSession(kernel, executable, cwd) {
	const signal = AbortSignal.timeout(3e4);
	const session = kernel === "codex" ? new CodexSession(executable, cwd, () => cwd) : new ClaudeSession(executable, cwd);
	try {
		await session.open(signal);
	} catch (error) {
		await session.dispose().catch(() => {});
		throw error;
	}
	sessions.set(session.id, session);
	return session;
}
/** Terminate every live kernel; used by the plugin's disposal path. */
async function disposeSessions() {
	const live = [...sessions.values()];
	sessions.clear();
	await Promise.all(live.map((session) => session.dispose().catch(() => {})));
}
//#endregion
//#region src/shared/protocol.ts
/** Plugin id and wire contract shared by the host and browser halves. */
const PLUGIN_ID = "dsh-third-kernel";
/** Route prefix owning every kernel request on the authenticated `/api` channel. */
const API_PREFIX = "/api/third-kernel";
const THIRD_PARTY_KERNELS = ["codex", "claude"];
/**
* Global npm package backing each kernel. Installing it globally is what
* `npm i -g` below performs, and the postinstall of `@anthropic-ai/claude-code`
* is what fetches its platform binary.
*/
const KERNEL_PACKAGES = {
	codex: "@openai/codex@latest",
	claude: "@anthropic-ai/claude-code@latest"
};
const ROUTES = {
	state: `${API_PREFIX}/state`,
	install: `${API_PREFIX}/install`,
	session: `${API_PREFIX}/session`,
	turn: `${API_PREFIX}/turn`,
	answer: `${API_PREFIX}/answer`,
	interrupt: `${API_PREFIX}/interrupt`,
	close: `${API_PREFIX}/close`
};
//#endregion
//#region src/host/installer.ts
/** Percent each phase reports while it owns the install. */
const PHASES = [
	{
		pattern: /npm (?:http fetch|WARN|notice)/i,
		message: "正在解析依赖…",
		percent: 20
	},
	{
		pattern: /reify|idealTree|placeDep/i,
		message: "正在下载内核包…",
		percent: 45
	},
	{
		pattern: /link|bin|postinstall/i,
		message: "正在链接可执行文件…",
		percent: 75
	}
];
/**
* Resolve the npm command that can install globally on this machine. npm's own
* JS entry is preferred over the `npm.cmd` shim because spawn cannot execute a
* batch file without a shell.
*/
function npmCommand() {
	return {
		file: process.execPath,
		args: [`${process.execPath.slice(0, Math.max(process.execPath.lastIndexOf("\\"), process.execPath.lastIndexOf("/")))}${process.platform === "win32" ? "\\" : "/"}node_modules${process.platform === "win32" ? "\\" : "/"}npm${process.platform === "win32" ? "\\" : "/"}bin${process.platform === "win32" ? "\\" : "/"}npm-cli.js`]
	};
}
/** Whether a path-derived npm entry is worth trying before the PATH lookup. */
async function npmEntry() {
	const candidate = npmCommand();
	const { access } = await import("node:fs/promises");
	try {
		await access(candidate.args[0]);
		return candidate;
	} catch {
		return {
			file: process.platform === "win32" ? "npm.cmd" : "npm",
			args: []
		};
	}
}
/**
* Start one global install. The handle's `events` iterable is single-use and
* ends after a terminal `done` or `error`; `cancel` stops the child and is
* idempotent.
*/
function installKernel(kernel) {
	const queue = [];
	let wake;
	let finished = false;
	let child;
	let cancelled = false;
	let percent = 5;
	const push = (event) => {
		queue.push(event);
		wake?.();
		wake = void 0;
	};
	const finish = (event) => {
		if (finished) return;
		finished = true;
		push(event);
	};
	(async () => {
		const npm = await npmEntry();
		if (cancelled) {
			finish({
				type: "error",
				message: "已取消安装。"
			});
			return;
		}
		push({
			type: "step",
			message: "正在准备安装…",
			percent
		});
		child = spawn(npm.file, [
			...npm.args,
			"install",
			"--global",
			KERNEL_PACKAGES[kernel]
		], {
			env: {
				...nativeEnvironment(),
				npm_config_fund: "false",
				npm_config_audit: "false"
			},
			shell: false,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stderr = "";
		let buffered = "";
		const consume = (chunk) => {
			buffered += chunk;
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (line === "") continue;
				for (const step of PHASES) if (step.percent > percent && step.pattern.test(line)) {
					percent = step.percent;
					push({
						type: "step",
						message: step.message,
						percent
					});
				}
				push({
					type: "tick",
					percent
				});
			}
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", consume);
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-4e3);
			consume(chunk);
		});
		child.on("error", (error) => {
			finish({
				type: "error",
				message: `无法启动 npm：${error.message}`
			});
		});
		child.on("close", (code) => {
			if (cancelled) {
				finish({
					type: "error",
					message: "已取消安装。"
				});
				return;
			}
			if (code !== 0) {
				finish({
					type: "error",
					message: stderr.trim() || `npm 退出码 ${code ?? "unknown"}`
				});
				return;
			}
			PHASES.length;
			percent = 90;
			push({
				type: "step",
				message: "正在验证内核…",
				percent
			});
			probeKernel(kernel).then((result) => {
				if (cancelled) {
					finish({
						type: "error",
						message: "已取消安装。"
					});
					return;
				}
				if (!result.installed) {
					finish({
						type: "error",
						message: result.hint ?? "安装完成但内核无法启动。"
					});
					return;
				}
				percent = 100;
				push({
					type: "step",
					message: "安装完成",
					percent
				});
				finish({
					type: "done",
					version: result.version
				});
			});
		});
	})();
	return {
		events: { async *[Symbol.asyncIterator]() {
			while (true) {
				if (queue.length > 0) {
					yield queue.shift();
					continue;
				}
				if (finished) return;
				await new Promise((resolve) => {
					wake = resolve;
				});
			}
		} },
		cancel: () => {
			if (cancelled) return;
			cancelled = true;
			child?.kill();
		}
	};
}
//#endregion
//#region src/host/routes.ts
function json(value, status = 200) {
	return Response.json(value, { status });
}
/**
* Stream newline-delimited JSON so the browser reads events as they happen.
* Closing the request (or the client navigating away) cancels the producer.
*/
function ndjson(signal, source) {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const item of source) {
					if (signal.aborted) break;
					controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`));
				}
				controller.close();
			} catch (error) {
				controller.enqueue(encoder.encode(`${JSON.stringify({
					type: "error",
					message: error instanceof Error ? error.message : String(error)
				})}\n`));
				controller.close();
			}
		},
		cancel() {}
	});
	return new Response(stream, { headers: {
		"content-type": "application/x-ndjson; charset=utf-8",
		"cache-control": "no-store",
		"x-accel-buffering": "no"
	} });
}
function isThirdParty(id) {
	return typeof id === "string" && THIRD_PARTY_KERNELS.includes(id);
}
/** The switcher's whole state: one detection row per kernel. */
async function statePayload() {
	return {
		kernels: [{
			id: "dsh",
			installed: true,
			version: null,
			executable: null,
			hint: null
		}, ...await Promise.all(THIRD_PARTY_KERNELS.map(async (id) => {
			const result = await probeKernel(id);
			return {
				id,
				installed: result.installed,
				version: result.version,
				executable: result.executable,
				hint: result.hint
			};
		}))],
		cwd: process.cwd()
	};
}
/** Resolve a requested directory to an existing absolute path. */
async function resolveCwd(requested) {
	if (requested === void 0 || requested === null || requested === "") return process.cwd();
	if (typeof requested !== "string") throw new Error("BRIDGE_REQUEST_INVALID: cwd");
	const absolute = resolve(requested);
	if (!(await stat(absolute)).isDirectory()) throw new Error("BRIDGE_REQUEST_INVALID: cwd 不是目录");
	return realpath(absolute);
}
async function body(request) {
	const value = await request.json().catch(() => void 0);
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/** Build the exact routes this plugin contributes. */
function buildRoutes() {
	return [
		{
			path: ROUTES.state,
			methods: ["GET"],
			requestBody: "buffered",
			fetch: async () => json(await statePayload())
		},
		{
			path: ROUTES.install,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const input = await body(request);
				if (!isThirdParty(input?.kernel)) return json({ error: "BRIDGE_BACKEND_INVALID: 请选择 Codex 或 Claude。" }, 400);
				const handle = installKernel(input.kernel);
				request.signal.addEventListener("abort", handle.cancel, { once: true });
				return ndjson(request.signal, handle.events);
			}
		},
		{
			path: ROUTES.session,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const input = await body(request);
				if (!isThirdParty(input?.kernel)) return json({ error: "BRIDGE_BACKEND_INVALID: 请选择 Codex 或 Claude。" }, 400);
				let cwd;
				try {
					cwd = await resolveCwd(input.cwd);
				} catch (error) {
					return json({ error: error instanceof Error ? error.message : "BRIDGE_REQUEST_INVALID" }, 400);
				}
				const probe = await probeKernel(input.kernel);
				if (!probe.installed || probe.command === null) return json({
					error: probe.hint ?? "内核未安装",
					installed: false
				}, 409);
				try {
					const session = await openSession(input.kernel, probe.command, cwd);
					const models = await session.models().catch(() => []);
					return json({
						id: session.id,
						kernel: input.kernel,
						cwd,
						models
					});
				} catch (error) {
					return json({ error: error instanceof Error ? error.message : "BRIDGE_SESSION_FAILED" }, 500);
				}
			}
		},
		{
			path: ROUTES.turn,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const input = await body(request);
				if (typeof input?.id !== "string" || typeof input.text !== "string" || input.text.trim() === "") return json({ error: "BRIDGE_REQUEST_INVALID: id/text" }, 400);
				const session = sessions.get(input.id);
				if (session === void 0) return json({ error: "BRIDGE_SESSION_UNKNOWN: 会话不存在或已关闭" }, 404);
				return ndjson(request.signal, session.run({ text: input.text }, request.signal));
			}
		},
		{
			path: ROUTES.answer,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const input = await body(request);
				if (typeof input?.id !== "string" || typeof input.requestId !== "string") return json({ error: "BRIDGE_REQUEST_INVALID: id/requestId" }, 400);
				const session = sessions.get(input.id);
				if (session === void 0) return json({ error: "BRIDGE_SESSION_UNKNOWN" }, 404);
				if (typeof input.allowed === "boolean") session.answer(input.requestId, {
					kind: "approval",
					allowed: input.allowed
				});
				else if (input.answers !== null && typeof input.answers === "object" && !Array.isArray(input.answers)) session.answer(input.requestId, {
					kind: "question",
					answers: input.answers
				});
				else return json({ error: "BRIDGE_REQUEST_INVALID: allowed/answers" }, 400);
				return json({ ok: true });
			}
		},
		{
			path: ROUTES.interrupt,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const input = await body(request);
				if (typeof input?.id !== "string") return json({ error: "BRIDGE_REQUEST_INVALID: id" }, 400);
				await sessions.get(input.id)?.interrupt();
				return json({ ok: true });
			}
		},
		{
			path: ROUTES.close,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const input = await body(request);
				if (typeof input?.id !== "string") return json({ error: "BRIDGE_REQUEST_INVALID: id" }, 400);
				const session = sessions.get(input.id);
				if (session !== void 0) {
					sessions.delete(input.id);
					await session.dispose();
				}
				return json({ ok: true });
			}
		}
	];
}
/** Register every route; the returned disposer releases the whole set. */
function mountRoutes(ctx) {
	const connection = ctx.get("connection");
	if (connection === void 0) throw new Error("dsh-third-kernel: 需要 connection 服务来承载内核接口");
	const disposers = buildRoutes().map((route) => connection.fetch.register(route));
	return () => {
		for (const dispose of disposers) dispose().catch(() => {});
	};
}
//#endregion
//#region src/index.ts
const name = PLUGIN_ID;
const inject = ["connection"];
/**
* Mount the kernel API. The effect's disposer closes every live kernel child, so
* unloading the plugin never leaves an orphaned app-server behind.
*/
function apply(ctx) {
	ctx.effect(() => {
		const dispose = mountRoutes(ctx);
		return () => {
			dispose();
			disposeSessions();
		};
	}, `${PLUGIN_ID}: kernel API`);
}
//#endregion
export { apply, inject, name };
