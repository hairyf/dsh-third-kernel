# dsh-third-kernel

[![CI][ci-src]][ci-href]
[![License][license-src]][license-href]

为 DeepSeek Harness 增加**第三方内核**：在侧边栏品牌位 hover 即可切换，选中后整个界面换成该内核自己的完整 Agent 页面；本机没装就自动全局安装。

- **DSH**（官方）：原样不动的官方界面。
- **Codex**：基于本机 `codex app-server`，独立设计的单色界面。
- **Claude Code**：基于本机 `claude --print --input-format stream-json`，独立设计的中性暖色界面。

## 为什么不是复用官方界面

官方 UI 与官方 Session/Composer/投影体系强绑定。第三方内核的会话不是官方会话，硬塞进去会同时破坏两边。因此两套内核页面是**独立实现**的界面（侧边栏、会话区、输入区均自建），但**图标、菜单、输入等原子组件优先复用官方** `@deepseek-ai/dsh-client-ui-primitives`，视觉与控制手感与官方一致。

参照上游已移除该功能的 `dsh-tauri-kernel`（`dsh-tauri` v0.24.2）的协议经验，但不再依赖 `dsh-tauri`。

## 交互

1. **切换入口**：官方侧边栏品牌行（`.hHd-Xa_logoRow`）。hover 鲸鱼/文字时弹出官方 `Menu` 下拉，列出三个内核。
2. **接管方式**：只替换两个插槽 —— 侧边栏（`sidebar`）与会话区（`main` 的 `conversation` 键）。框架、顶栏、右栏、输入链仍是官方的。两个槽都是 `single`，所以占用绑定在“当前选择”上：选中第三方内核才注册，切回 DSH 立即释放，官方内容原样回来。
3. **未安装**：选中缺装内核后直接进入全屏安装页（Logo + 内核名 + 进度条），由本机 npm 全局安装，装完自动进入该内核页面。安装是「选择即开始」，所以列表里**不再标注未安装**。
4. **进度是真实的**：进度按 npm 阶段推进（解析 → 下载 → 链接 → 验证），且只有 `--version` 探测通过后才到 100%。

## 安装

```sh
pnpm add dsh-third-kernel
```

在 profile 的 `cordis.patch.yml` 里启用（本插件自带 `cordis.patch.yml`，会随插件一起启用 `dsh-taiwind`）：

```yaml
- insert:
    - id: dsh-third-kernel
      name: dsh-third-kernel
    - id: dsh-taiwind
      name: dsh-taiwind
```

样式通过 [dsh-taiwind](https://github.com/hairyf/dsh-taiwind) 编译：本包 `package.json` 声明 `dsh.taiwind: "src/main.css"`，类名由共享编译器从构建产物收集。**若宿主未启用 `dsh-taiwind`，内核页面会缺样式**——这是共享编译器的既定工作方式，不是本插件可绕过的。

## 前置条件

| 内核 | 本机需要 | 说明 |
| --- | --- | --- |
| Codex | `codex` CLI ≥ 支持 `app-server` | 缺失时自动 `npm i -g @openai/codex@latest` |
| Claude Code | `claude` CLI ≥ 支持 `stream-json` | 缺失时自动 `npm i -g @anthropic-ai/claude-code@latest` |

两者各自需要先在本机完成登录（`codex login` / `claude auth login`），插件不会代管凭证。

## 实现要点

- **宿主半**（`src/host/`）：`detect.ts` 解析并探测 CLI；`installer.ts` 流式安装；`codex.ts` / `claude.ts` 各自实现一个 JSONL 协议适配器；`routes.ts` 在已鉴权的 `/api` 通道上注册精确路由，所有入参在此校验。
- **客户端半**（`src/client/`）：`components/kernel-switcher.tsx` 是官方 Menu 封装（每个实例独立 hover 态，两个入口不会同时打开）；`components/kernel-sidebar.tsx` 与 `kernel-conversation.tsx` 是插槽占用者；`codex-thread.tsx` 与 `claude-thread.tsx` 是两套独立会话区；`lib/runner.ts` 是唯一的流式状态机。
- **安全边界**：CLI 只从 PATH 解析，Windows 的 `.cmd` 包装器必须指向厂商官方入口才会被解析执行，否则拒绝——否则就是一条命令注入路径。

## 已验证 / 未验证

- ✅ Codex：真实子进程、真实流式 `PONG` 回合、无重复文本（`test/codex-*.test.ts` 与浏览器实测）。
- ✅ 官方品牌行外观未变（复用官方 `FishLogo`/`BrandWordmark`）、hover 打开后移入不消失、一次只开一个菜单、宽度与官方图标正确。
- ✅ 插槽级替换：仅侧边栏与会话区变化，官方框架与右栏保留；切回 DSH 无损。
- ✅ 真实 Codex 回合通过界面跑通（回复不重复）。
- ⚠️ Claude：握手、模型列表、消息流均已在本机实测通过；本机未登录时回合会如实显示 “Not logged in · Please run /login”。登录后的完整回合未实测。

## License

[MIT](./LICENSE.md) © [hairyf](https://github.com/hairyf)

<!-- Badges -->

[ci-src]: https://img.shields.io/github/actions/workflow/status/hairyf/dsh-third-kernel/ci.yml?branch=main&style=flat&colorA=080f12&colorB=1fa669&label=CI
[ci-href]: https://github.com/hairyf/dsh-third-kernel/actions/workflows/ci.yml
[license-src]: https://img.shields.io/github/license/hairyf/dsh-third-kernel.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/hairyf/dsh-third-kernel/blob/main/LICENSE.md
