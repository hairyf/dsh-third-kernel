<div align="center"><a name="readme-top"></a>

<img src="./public/hero.png" alt="安装插件" />

# DSH Third Kernel

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

为 DeepSeek (DSH) 接入本机 **Codex** 与 **Claude Code** 内核。会话区一键新建第三方内核会话，模型与推理强度沿用官方 composer，权限沿用官方会话权限；切回 DSH 即恢复官方会话。

</div>

## 📦 安装

使用命令行安装：

```sh
dsh plugin add dsh-office-kit
```

- 样式走 [dsh-taiwind](https://github.com/hairyf/dsh-taiwind) 共享编译。
- 装完在 **设置 → 插件** 里确认已启用。

## 前置条件

| 内核 | 本机需要 | 探测方式 |
| --- | --- | --- |
| Codex | 已登录的 `codex` CLI，支持 `app-server` | `codex app-server --help` 返回 0 |
| Claude Code | 已登录的 `claude` CLI，支持 `stream-json` | `claude --help` 输出含 `stream-json` |

>  两个 CLI 都得先在终端自行登录（`codex login` / `claude auth login`），插件不代管凭证；登录状态会显示在切换器里。

## 特性


- 🧭 **内核选择器**：会话页顶部新增内核切换（Codex / Claude），选中即创建已绑定内核的新会话。
- 🏷️ **品牌标识**：会话标题区随内核切换图标与标语；第三方内核下隐藏官方「探索未至之境 / 预览版」标题，切回 DSH 自动还原。
- 🎛️ **模型选择**：输入框模型菜单改为内核自带模型目录，Codex 与 Claude 的推理档位统一展示；改动从下一轮对话起生效。
- 🔐 **权限沿用官方**：权限模式仍由官方会话权限决定，自动映射到各内核的审批与沙箱策略，不新增开关。
- 🧩 **只做增量**：AppFrame、品牌行、侧栏、会话列表、输入链、工作区均保持官方实现，插件仅通过公开插槽与投影接入。
- 🎨 **两套配色**：Codex 冷灰、Claude 暖纸，均以 `tk-` 前缀隔离，不影响官方主题。

## 🚀 快速开始

### 新建一个 Codex / Claude 会话

1. 在会话区点内核 chip（Hero 里的选择器），选 **Codex** 或 **Claude**。
2. 插件调宿主 `POST /api/tauri/bridge/sessions`，宿主起子进程、完成握手、建立会话。
3. 不可用时，选项保持禁用并显示原因（未安装 / 未登录 / 协议不兼容 / 核心不支持桥接）

## 🛠️ 开发与贡献

```sh
pnpm run lint --fix
pnpm run typecheck
pnpm run test    # 先 build 再 vitest
pnpm run build
```

### 子仓库

- [source/dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI) — 协议参考。
- [source/dsh-tauri](https://github.com/dsh-tauri/deepseek-harness-desktop)（v0.24.5）— 桌面壳参考。

```sh
git submodule update --init --recursive
```

## 📜️ 许可证

[MIT](<LICENSE.md>) © [hairyf](https://github.com/hairyf)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/dsh-third-kernel?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/dsh-third-kernel
[npm-downloads-src]: https://img.shields.io/npm/dm/dsh-third-kernel?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/dsh-third-kernel
[bundle-src]: https://img.shields.io/bundlephobia/minzip/dsh-third-kernel?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=dsh-third-kernel
[license-src]: https://img.shields.io/github/license/hairyf/dsh-third-kernel.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/hairyf/dsh-third-kernel/blob/main/LICENSE
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/dsh-third-kernel