<div align="center"><a name="readme-top"></a>

# DSH Third Kernel

[![CI][ci-src]][ci-href]
[![License][license-src]][license-href]

为 DeepSeekRuntime (DSH) 接入本机 **Codex** 与 **Claude Code** 内核。会话区一键新建第三方内核会话，模型与推理强度沿用官方 composer，权限沿用官方会话权限；切回 DSH 即恢复官方会话。

- **DSH**（默认）：官方内核，界面与会话完全不动。
- **Codex**：驱动本机 `codex app-server`（stdio JSONL）。
- **Claude Code**：驱动本机 `claude --print --input-format stream-json`。
</div>

## 📦 安装

尚未发布到 npm（`dsh-third-kernel` 在 registry 上仍是 404），先本地构建再挂到 profile：

```sh
git clone https://github.com/hairyf/dsh-third-kernel
cd dsh-third-kernel
pnpm install
pnpm run build
```

- 本插件自带 `cordis.patch.yml`，随 bundle 一起插入 `dsh-third-kernel` 与 `dsh-taiwind`。
- 样式走 [dsh-taiwind](https://github.com/hairyf/dsh-taiwind) 共享编译：`package.json` 的 `dsh.taiwind` 指向 `src/main.css`。**宿主没启用 `dsh-taiwind` 时，内核控件会缺样式。**
- 装完在 **设置 → 插件** 里确认已启用。

## 前置条件

| 内核 | 本机需要 | 探测方式 |
| --- | --- | --- |
| Codex | 已登录的 `codex` CLI，支持 `app-server` | `codex app-server --help` 返回 0 |
| Claude Code | 已登录的 `claude` CLI，支持 `stream-json` | `claude --help` 输出含 `stream-json` |

- 两个 CLI 都得先在终端自行登录（`codex login` / `claude auth login`），插件不代管凭证；登录状态会显示在切换器里。
- CLI 只从 `PATH` 解析。Windows 上的 `.cmd` 包装器会被解析成它包住的厂商入口（`@openai/codex` / `@anthropic-ai/claude-code`），包装器指向别处则直接拒绝——那是一条命令注入路径。
- 运行时由 DSH 宿主提供；本仓未声明 `engines`，随宿主 Node 版本走。

## 特性

- 🧭 **会话区内核选择器**：挂在 `conversation.hero.agentPreset`，列出 Codex / Claude；选中即新建一个已校验绑定的原生内核会话。
- 🏷️ **品牌与身份**：`conversation.hero.brand.mark` 换成内核图标加内核标语（字号沿用官方 26px 标题行，行高不变），官方标题组「探索未至之境 / 预览版」在第三方内核下隐藏；切回 DSH 自动恢复官方鲸鱼标记与标题。`conversation.session.header.lineage` 追加内核标识。
- 📋 **侧栏会话标识**：`sidebar.session.row.leading` 与 `sidebar.session.row.hover` 显示该会话绑定的内核，未绑定时不渲染。
- 🎛️ **模型选择器接管**：`conversation.input.model` 换成内核自带的模型目录（Codex 的 `supportedReasoningEfforts` 与 Claude 的 `supportedEffortLevels` 归一化成同一份 `efforts` 列表）；改动只作用于下一完整轮次。
- 🔐 **权限不变**：权限模式仍由官方会话权限投影决定，映射到 Codex 的 `approvalPolicy` + `sandboxPolicy`、Claude 的 `set_permission_mode` 控制请求，插件不另造开关。
- 🧩 **不接管官方状态**：AppFrame、品牌行、侧栏外壳、会话列表、输入链、工作区仍归官方；插件只通过公开 slot 与 `sessionProjections`（`bridgeKernel` / `bridgeModel`）做增量。
- 🎨 **两套视觉 token**：`src/main.css` 定义冷灰（Codex）与暖纸（Claude）配色及衬线 prose，全部 `tk-` 前缀，不污染官方主题。

## 🚀 快速开始

### 新建一个 Codex / Claude 会话

1. 在会话区点内核 chip（Hero 里的选择器），选 **Codex** 或 **Claude**。
2. 插件调宿主 `POST /api/tauri/bridge/sessions`，宿主起子进程、完成握手、建会话，客户端校验 `bridgeKernel` 投影与新建会话一一对应后才打开；校验不过直接报错，不会打开一个「看起来像」的会话。
3. 本地 CLI 没装、协议不兼容或宿主桥接不可用时，选项保持禁用并显示原因（未安装 / 未登录 / 协议不兼容 / 核心不支持桥接）。

### 换模型与推理强度

第三方内核会话的 composer 模型选择器会列出该内核的模型目录；模型与推理深度只影响**下一完整轮次**，不能换掉当前会话的内核。

### 切回官方外观

选 **DSH** 新建会话即回到官方内核；已绑定原生内核的会话保持绑定（会话内换内核被明确拒绝），派生 / fork 的会话不能续原生内核。

## 📚 配置与限制

主机侧插件配置（`src/host/config/options.ts`）：

```yaml
- id: dsh-third-kernel
  config:
    codexPath: C:\Users\me\AppData\Roaming\npm\codex.cmd
    claudePath: C:\Users\me\AppData\Roaming\npm\claude.cmd
    probeTimeoutMs: 5000
```

- `codexPath` / `claudePath`：显式指定 CLI 绝对路径，覆盖 `PATH` 探测（必须绝对路径且可执行）。
- `probeTimeoutMs`：探测超时，默认 5s。

已知限制：

- **平台**：Windows 已实测（含 `.cmd` 包装器解析）；macOS / Linux 未验证。
- **主题未接线**：`src/main.css` 的内核配色作用在 `[data-dsh-third-kernel]` 上，目前只有 `html[data-dsh-third-kernel-shell]`（由 `src/client/components/kernel-brand.tsx` 设置）被写入，因此现在实际生效的是隐藏官方侧栏面板行与页脚；整页换肤尚未接线。
- **样式依赖**：缺 `dsh-taiwind` 时控件无样式。
- **桥接能力**：宿主未提供完整官方桥接接口时，第三方内核整体禁用并给出明确错误，不静默半工作。

## 🛠️ 开发与贡献

```sh
pnpm run lint --fix
pnpm run typecheck
pnpm run test    # 先 build 再 vitest
pnpm run build
```

架构一句话：Host half（`src/index.ts` + `src/host/`）探测 CLI、管理子进程与 JSONL 协议、在已鉴权的 `/api` 通道上注册 `/api/tauri/bridge/{backends,models,sessions}`；Client half（`src/client/`）只做 slot 装饰与本地生命周期；共享协议在 `src/shared/`。

- 协议适配器：`src/host/backends/codex.ts`、`src/host/backends/claude.ts`（共用 `src/host/backends/transport.ts` 的 JSONL 传输与请求关联）。
- CLI 探测：`src/host/utils/detection.ts`；会话 / 模型 / 投影：`src/host/service/`。
- 路由与入参校验：`src/host/server/routes/`。
- 测试：`src/host/server/index.test.ts`（路由与入参校验）、`test/claude-backends.test.ts`（Claude 适配器）、`test/api-snapshot.test.ts`（`dist` 公开 API 快照）、`test/locale-subscription.test.ts`（客户端语言订阅）覆盖当前生效路径；`test/codex-session.test.ts` 在本机装有 Codex CLI 时真实起子进程跑一轮，未安装则断言跳过、不假绿，但它与 `test/turn-options*.test.ts`、`test/persistence.test.ts`、`test/codex-text.test.ts` 仍指向清理前的旧适配器（`src/host/codex.ts` / `src/host/claude.ts` / `src/host/detect.ts` / `src/host/routes.ts`），这些文件不在 `src/host/apply.ts` 的可达图内。

### 验证状态

- ✅ Codex：本机 CLI 0.162.0 上跑过真实子进程 / 流式 smoke test，并在浏览器里验过第三方 slot 装饰。
- ✅ Claude：本机 CLI 2.1.296 上验过握手、模型目录、消息、权限；宿主能力不可用时返回明确错误。
- ✅ 公开 slot 装饰：官方占用者存在和为空时都有安全降级；切回 DSH 恢复官方控件。
- ✅ 浏览器实测（DSH Web，profile 内挂载本插件）：选 Codex 后 hero 只剩「Codex 内核」、预览版徽章隐藏、composer 模型选择器列出 bridge/codex 的模型；先切 Claude 再清空回 DSH，官方鲸鱼标记、标题与 `DeepSeek-V4.1-Flash` 全部恢复。
- ⚠️ 完整 `pnpm test` 未作为交付通过信号；当前聚焦测试仍覆盖部分旧适配器路径，不能单独证明清理后的 active adapter 全路径。
- ⚠️ Claude 的新建会话依赖宿主 profile 提供完整桥接能力；桥接不可用时返回明确错误，不静默伪造会话。

### 子仓库

- [source/dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI) — 协议参考。
- [source/dsh-tauri](https://github.com/dsh-tauri/deepseek-harness-desktop)（v0.24.5）— 桌面壳参考。

```sh
git submodule update --init --recursive
```

## 📜️ 许可证

[MIT](<LICENSE.md>) © [hairyf](https://github.com/hairyf)

<!-- Badges -->

[ci-src]: https://img.shields.io/github/actions/workflow/status/hairyf/dsh-third-kernel/ci.yml?branch=main&style=flat&colorA=080f12&colorB=1fa669&label=CI
[ci-href]: https://github.com/hairyf/dsh-third-kernel/actions/workflows/ci.yml
[license-src]: https://img.shields.io/github/license/hairyf/dsh-third-kernel.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/hairyf/dsh-third-kernel/blob/main/LICENSE.md
