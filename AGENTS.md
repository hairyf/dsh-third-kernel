# AGENTS.md

## 1. 项目架构与目录契约

* **架构**：Host half（`src/index.ts` + `src/host/*`）/ Client half（`src/client/*`），共享协议在 `src/shared/`。
* **宿主侧**（唯一生效路径，全部挂在 `src/host/apply.ts` 的 `ctx.effect` 里）：
  * `src/host/apply.ts`：装好 context、注册 projection / 模型 / checkpoint，挂钩 `agent/pre-step`、`agent/request`、`llm/stream`、`tools/*`、`session/event`、`agent/disposed`，最后挂 `server(ctx)`。
  * `src/host/server/`：`index.ts` 在已鉴权的 `connection.fetch` 上注册 `/api/tauri/bridge/{backends,models,sessions}`；每个 `routes/*` 文件只做入参校验，`request.ts` 提供 `RequestError`。
  * `src/host/service/`：`session.ts`（原生会话生命周期与 `NativeSink` 转发）、`adapter.ts`（官方回合准入 + `llm/stream` 队列）、`sink.ts`（把原生事件翻成官方 `StreamChunk` 与工具结果）、`sink.types.ts`、`identity.ts`（`bridgeKernel` 投影）、`model.ts`（`bridgeModel` 投影与模型目录）、`checkpoint.ts`、`backend.ts`。
  * `src/host/backends/`：`codex.ts`（`codex app-server` JSON-RPC）、`claude.ts`（`claude --print --input-format stream-json` 控制面）、`transport.ts`（JSONL 子进程与请求关联）、`types.ts`（`NativeSink` / `NativeSession`）。
  * `src/host/utils/`：`detection.ts`（PATH → CLI，含 Windows `.cmd` 解析）、`runtime-modules.ts`、`runtime-version.ts`、`abort.ts`。`src/host/config/`：常量、`Config`、运行时单例。
  * `src/host/{codex,claude,routes,transport,detect,installer,registry,session-types}.ts` 是清理前的旧适配器，**不在 `apply.ts` 的可达图内**，只被 `test/turn-options*.test.ts`、`test/codex-*.test.ts` 引用。改动生效路径时不要顺手改它们，也不要以为它们还在跑。
* **客户端侧**：
  * `src/client/register/kernel.ts`：所有 slot 装饰的唯一注册入口；`src/client/register/kernel-model.ts`：每会话模型目录租约。
  * `src/client/components/slot-decoration.ts`：把官方单值槽包一层（priority 比官方低 1），官方缺失时自己以最低负优先级顶上。
  * `src/client/components/{hero-kernel,model-kernel,kernel-brand,session-kernel,session-kernel-hover}.tsx`：四个装饰组件 + 身份发布 hook `useKernelShell`。
  * `src/client/service/`：`kernel-identity.ts`（投影 → `BackendId`）、`kernel-model.ts`、`kernel-model.utils.ts`、`kernel-session.ts`、`kernel-version.ts`；`src/client/store/`：`kernel-store`（`selected` / `backends`）与 `native-model`（每会话模型目录快照）。
  * `src/client/constants/index.ts`：**唯一**集中存放 UI 常量与文案的位置；`src/client/locales/` 放双语文案。

## 2. 编码与技术规范

* **基础**：TypeScript (`strict`, `noUnusedLocals`)、ESM (`"type": "module"`)、pnpm catalog 管理依赖。
* **风格**：`@antfu/eslint-config`（无 Prettier）；相对路径导入；类型/常量显式导入。
* **组件**：kebab-case 文件；**优先复用官方 `@deepseek-ai/dsh-client-ui-primitives`**，禁止重画官方已有图形。
* **协议字段**：一切原生字段名、枚举与事件形状必须对 `source/dsh-tui` 的生成类型或真实 CLI 抓包取证，不得臆断。

## 3. 样式与生命周期规则

* **样式**：经 [dsh-taiwind](https://github.com/hairyf/dsh-taiwind) 共享编译。`src/main.css` 是未编译的 CSS-first 入口，在 `package.json` 以 `dsh.taiwind` 声明。
  * 自定义 token/工具类一律 `tk-` 前缀，避免污染官方主题。
  * 需要覆盖官方 CSS module 的**非分层**声明时用 `!` 前缀工具类（如 `min-w-[248px]!`）。
  * 官方 hero 标题组（探索未至之境 / 预览版）不是 slot，只能按 class 片段隐藏（当前用 `[class*="_titleGroup"]`，锚定 CSS module 的稳定片段而非哈希全名）。
  * 内核配色作用在 `[data-dsh-third-kernel]` 上；只有 `html[data-dsh-third-kernel-shell="codex|claude"]` 由 `useKernelShell` 写入，整页换肤尚未接线。
* **生命周期**：所有监听/定时器/子进程都必须有 disposer，由 `ctx.effect()` 或 `LifecycleController` 托管；卸载插件不得留下孤儿进程。

## 4. Slot 与宿主安全规则

* **装饰方式**：`registerSlotDecoration` 对 `single` 槽注册优先级 **官方 - 1** 的包装（同优先级重复注册会抛错），`wrap` 模式把官方组件作为 `Original` 传入；官方渲染器带 `children` 时**不要**转发 `children`（`SlotCore` 会因重复声明子槽抛错），改为注入 passthrough `renderSlot`。
* **生效槽位**：`conversation.hero.agentPreset`（内核选择器）、`conversation.hero.brand.mark`（品牌标记）、`conversation.session.header.lineage`（会话标识）、`conversation.input.model`（模型选择器）、`sidebar.session.row.leading` / `.hover`。
* **身份发布**：`useKernelShell` 同时供 hero 与会话头使用——任一时刻只有一个挂载，两处都必须调用，否则品牌标记与 `预览版` 不跟随。
* **禁止**注册 `root` 或 `shell.overlay` 接管层：会永久遮蔽官方 AppFrame 且销毁官方会话状态。
* **宿主侧**：CLI 只从 PATH 解析；Windows `.cmd` 包装器必须指向厂商官方入口才解析执行，否则拒绝（否则即命令注入）。
* **API**：仅注册在 `connection.fetch`（已带 Host/Origin 与鉴权栅栏），并自行校验方法、路径与 body。

## 5. 退级策略（优先级从高到低）

1. **官方公开 API**：严格对照已安装版本 `.d.ts`（禁止臆断）。
2. **官方组件**：优先复用 primitives 与 slot 契约。
3. **降级/禁用**：无解时明确报错并禁用功能，严禁静默半工作状态。

## 6. 验证与交付检查

```bash
pnpm run lint --fix
pnpm run typecheck
pnpm run test
pnpm run build
```

* 本机 `tsc` / 全仓 `eslint` 都很慢（>2 分钟）：优先单文件 `node node_modules/eslint/bin/eslint.js <files>`，全仓 lint 放后台跑。
* `vitest.config.ts` 只收 `test/**` 与 `src/**`——`source/` 下的参考检出有各自的测试与依赖，跑进来只会假失败。
* `test/codex-*.test.ts` 与 `test/turn-options.test.ts` 的第 4 跳会在本机装有 CLI 时**真实启动子进程**；未安装、未登录或离线时跳过或失败都在报告里写清楚，不许改断言掩盖。
* `test/codex-protocol.test.ts` 与 `test/claude-backends.test.ts` 用 stub 子进程覆盖不需要网络的协议回归（原生 error 收尾、`task_notification` 收尾、token usage 换算）。
* **检查清单**：共享类型/常量已归位 ｜ effect 均有 disposer ｜ Slot 不抢占 `root` ｜ 无未验证即宣称可用的功能 ｜ README 的验证状态与实际一致。
