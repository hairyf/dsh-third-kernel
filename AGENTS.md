# AGENTS.md

## 1. 项目架构与目录契约

* **架构**：Host half (`src/host/*`、`src/index.ts`) / Client half (`src/client/*`)，共享协议在 `src/shared/protocol.ts`。
* **宿主侧**：
  * `src/index.ts`：cordis `apply`，注册 `/api` 路由与生命週期清理。
  * `src/host/detect.ts`：从 PATH 解析并探测 CLI，返回 `KernelCommand`。
  * `src/host/installer.ts`：流式全局安装，进度按 npm 阶段推进。
  * `src/host/codex.ts` / `src/host/claude.ts`：各自 JSONL 协议适配器，实现 `KernelSession`。
  * `src/host/transport.ts`：JSONL 子进程与请求关联。
  * `src/host/routes.ts`：已鉴权 `/api` 通道上的精确路由，**所有入参在此校验**。
* **客户端侧**：
  * `src/client/constants.ts`：**唯一**集中存放 UI 常量与文案的位置。
  * `src/client/components/kernel-icons.tsx`：内核图标（Codex/Claude 使用上游真实路径，DSH 用官方 `FishLogo`）。
  * `src/client/components/brand.tsx`：官方品牌行 + hover 菜单。
  * `src/client/components/kernel-overlay.tsx`：接管层（`shell.overlay`）。
  * `src/client/components/codex-page.tsx` / `claude-page.tsx`：两套独立内核页面。
  * `src/client/lib/runner.ts`：**唯一**的流式回合状态机。

## 2. 编码与技术规范

* **基础**：TypeScript (`strict`, `noUnusedLocals`)、ESM (`"type": "module"`)、pnpm catalog 管理依赖。
* **风格**：`@antfu/eslint-config`（无 Prettier）；相对路径导入；类型/常量显式导入。
* **组件**：kebab-case 文件；**优先复用官方 `@deepseek-ai/dsh-client-ui-primitives`**，禁止重画官方已有图形。

## 3. 样式与生命周期规则

* **样式**：经 [dsh-taiwind](https://github.com/hairyf/dsh-taiwind) 共享编译。`src/main.css` 是未编译的 CSS-first 入口，在 `package.json` 以 `dsh.taiwind` 声明。
  * 自定义 token/工具类一律 `tk-` 前缀，避免污染官方主题。
  * 需要覆盖官方 CSS module 的**非分层**声明时用 `!` 前缀工具类（如 `min-w-[248px]!`）。
  * 官方主题会给 `button`/`input` 设显式颜色，因此内核页面必须在 `[data-dsh-third-kernel]` 作用域内重置控件继承色。
* **生命周期**：所有监听/定时器/子进程都必须有 disposer，由 `ctx.effect()` 托管；卸载插件不得留下孤儿进程。

## 4. Slot 与宿主安全规则

* **切换入口**：`sidebar.brand.mark` / `sidebar.brand.name` 是 `single` 槽，官方占用在 priority 0；本插件以 **priority -1** 遮蔽（同优先级重复注册会抛错）。
* **接管层**：注册进 `shell.overlay`（`list`、additive、全视口），**禁止**注册 `root`——会永久遮蔽官方 AppFrame 且销毁官方会话状态。
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

* `test/codex-*.test.ts` 会在本机装有 Codex CLI 时**真实启动子进程**并校验流式回合；未安装时断言跳过，不会假绿。
* **检查清单**：共享类型/常量已归位 ｜ effect 均有 disposer ｜ Slot 不抢占 `root` ｜ 无未验证即宣称可用的功能 ｜ README 的验证状态与实际一致。
