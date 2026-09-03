# EmberImage 🔥

> **English version → [README.en.md](README.en.md)**

<p align="center">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-9cf?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/runtime%20deps-zero-success?style=flat-square" alt="Zero runtime deps">
  <img src="https://img.shields.io/badge/models-GPT%20Image%20·%20Seedream%20·%20Gemini-brightgreen?style=flat-square" alt="Models">
  <img src="https://img.shields.io/badge/language-JavaScript-f1e05a?style=flat-square&logo=javascript" alt="Language">
</p>

**EmberImage** 是一个**本地优先**的 AI 图片生成桌面客户端。输入你自己的 API 地址与密钥，用图形界面完成文字生图与图片编辑——不经过任何第三方中转，你的提示词与图片只发往你配置的服务。

纯原生 JavaScript 构建（Electron 44，**零运行时 npm 依赖**），无框架、无构建步骤，轻量且易于审查。

---

## 特性一览

| 类别 | 说明 |
|---|---|
| 🖼️ **文字生图** | 自定义尺寸/比例/质量/数量/格式，Base64 或 URL 响应，可选流式预览 |
| ✏️ **图片编辑** | 1–16 张参考图 + 自然语言，整体重绘、风格转换、元素增删、多图合成 |
| 🎯 **Mask 局部编辑** | 全屏画布涂抹修改区域，画笔/选区/自动主体/背景移除，导出精确 RGBA Mask |
| 🧰 **选区工具** | 魔棒、套索、自动主体、反选/羽化，选区一键转编辑区域，Worker 不卡界面 |
| 🖌️ **背景移除** | 本地识别主体透明化，边缘羽化，零 API 消耗 |
| 🗂️ **画廊与历史** | 搜索/收藏/复用/批量下载，编辑历史保存独立输入副本 |
| 📌 **提示词库** | 分类/搜索/收藏置顶/使用次数/批量管理，双向一键转存 |
| 🌐 **多模型** | 同一界面切换 **OpenAI 兼容 / Seedream（火山方舟）/ Gemini** 三种接口 |
| 🔐 **隐私优先** | 密钥仅本机、可 AES-256-GCM 加密落盘，API Key 永不写日志 |

---

## 快速开始

### 下载安装包

前往 [Releases](https://github.com/lds2050/EmberImage/releases) 下载对应平台安装包：

- **macOS Apple Silicon**：`EmberImage-x.x.x-arm64.dmg`
- **macOS Intel**：`EmberImage-x.x.x-x64.dmg`
- **Windows x64**：`EmberImage-x.x.x-x64.exe`（NSIS 安装程序）

> [!NOTE]
> 安装包尚未购买商业代码签名证书，首次启动时 macOS Gatekeeper 或 Windows SmartScreen 可能显示安全提示——请确认下载自本仓库官方 Releases 页。

### 从源码运行

需要 **Node.js 20+**：

```bash
npm install
npm start
```

跑测试与静态语法检查：

```bash
npm test
npm run check
```

---

## 使用入门

1. 打开「设置」→ 新建连接，选择**接口类型**、填写 Base URL 与 API Key；
2. 回到「生成」页输入提示词，点击生成；
3. 需要改图时切到「编辑」tab，拖入 1–16 张参考图并描述修改要求。

> 首次可点「新建 OpenAI 默认配置」一键填好官方地址。多份连接可在侧边栏快速切换。

---

## 能力总览

三种接口类型的能力差异如下（在连接编辑器里也能实时看到）：

| 能力 | OpenAI 兼容 | Seedream (火山方舟) | Gemini |
|---|---|---|---|
| **文字生图** | ✅ | ✅ | ✅ |
| **参考图编辑** | ✅ | ✅ | ✅ |
| **Mask 局部编辑** | ✅ | ❌（不支持） | ❌（不支持） |
| **多图一次生成** | ✅ | ✅ | 串行逐张 |
| 认证方式 | `Authorization: Bearer` | `Authorization: Bearer` | `x-goog-api-key` |
| 默认接口 | `api.openai.com/v1` | `ark.cn-beijing.volces.com/api/v3` | `generativelanguage.googleapis.com/v1beta` |
| 默认模型 | `gpt-image-2` | `doubao-seedream-4-0-250828` | `gemini-3-pro-image-preview` |

> 更早的中转 / 其他 OpenAI 兼容服务可直接选用「OpenAI 兼容」。未实现 `/images/edits` 的服务会被自动标记为「不支持图片编辑」，文字生图不受影响。

---

## 功能详解

### 文字生图

- 通过 `POST /images/generations` 生成全新图片，模型名称可自定义；
- 尺寸支持自动、按比例（1K/2K/4K × 8 种常用比例）与自定义宽高，实时显示最终像素；
- 自定义尺寸带 16 倍数、宽高比与像素范围校验；
- 可配置质量、数量、背景、格式、压缩率与审核级别；
- 支持 Base64 与 URL 响应，可选 SSE 部分图流式预览（默认关闭）；
- 完整的状态反馈：生成中、取消、错误分类与请求 ID。

### 图片编辑

- 导入 1–16 张图片（选择器/拖拽/粘贴），自然语言整体重绘、风格转换、元素增删、多参考图合成；
- 素材卡片拖拽排序；右键菜单可放大预览、移除背景、移除素材；
- 导入带旋转信息的 JPEG（如手机竖拍）自动摆正，与提交给服务的图一致；
- 结果可一键「继续编辑」（结果图成为新主图）或按原参数再编辑；
- 非 PNG 主图在局部编辑提交前自动无损转 PNG，**原文件不被修改**。

### Mask 局部编辑

- 全屏画布涂抹修改区域：画笔/橡皮、撤销/重做、缩放与空格拖动；
- 快捷键 `[` `]` 调画笔大小，`⌘/Ctrl+Z` 撤销、`⌘/Ctrl+Shift+Z` 重做；
- 一键反选蒙版，切换为已标记范围的补集；
- 自动导出为 API 要求的同尺寸 RGBA Mask；
- 查看器中原图/结果对比，编辑区域逐像素精确对齐。

### 选区工具

用选区代替手涂、获得精确边界，选好一键转为编辑区域：

- **魔棒**：按颜色相似度扩散，容差 0–128，支持「连续」与「全图」；
- **套索**：手绘多边形轮廓，松手自动闭合；
- **自动主体**：一键启发式圈出画面主体，超长图自动降采样不卡界面；
- **Shift 加选 / Alt 减选**，可叠加或挖去；
- **反选 / 羽化（0–20）/ 取消选区**；
- **应用为 Mask**（或 `Delete`）：选区与手涂进入同一撤销栈，可混合撤销重做；
- `Esc` 取消当前选区；选区计算跑在独立 Worker，失败或超时自动降级主线程。

### 背景移除

- 素材卡片右键菜单或查看器「移除背景」入口；
- 本地识别主体并透明化背景，边缘自动羽化，**不消耗 API 额度**；
- 棋盘格预览确认后，可导出透明 PNG，或一键加入素材继续编辑。

### 画廊与历史

- 卡片画廊：搜索、收藏、复用提示词、按原参数再生成、移到废纸篓；
- 类型与输入数量徽标、双击放大预览；
- 单张/批量下载、复制原图、在文件夹中显示；
- 编辑历史保存输入图与 Mask 独立副本，原文件移动/删除后仍可再编辑。

### 提示词库

- 独立提示词页：新建/编辑/删除，正文与自由分类，分类输入自动联想；
- 分类筛选 chips（带计数）与多关键词模糊搜索，可叠加；
- 收藏置顶 + 使用次数统计，越用越靠前；
- 批量管理：多选删除、批量移动分类、分类重命名（重名合并）；
- 双向转存：生成页与画廊一键存入（自动查重），卡片可复制文本；
- 数据本地存于 `prompts.json`（上限 500 条）。

### 连接与兼容

- 多份独立连接，分别保存名称、Base URL、模型、密钥策略、超时与流式开关；
- 按实际请求结果标记生成/编辑支持情况（404/405 标记不支持，仅作提示）。

---

## 密钥与隐私

- **默认“仅本次会话”**：密钥只驻留 Electron 主进程内存，退出即清除；
- **可选“本机加密保存”**：API Key 以独立随机设备密钥 + AES-256-GCM 加密，重启自动解密；
- 设备密钥以 `0600` 权限保存于用户应用目录，不用系统钥匙串，避免明文落盘；
- API Key **永不**写入生成历史、图片参数或请求日志；请求日志保留完整提示词与其他 API 参数（可自定义关闭）；
- 非本机地址必须使用 HTTPS。

## 流式请求说明

流式模式能更早返回部分图、改善等待反馈，也可能降低部分代理的空闲连接超时风险；它不缩短生成时间，也不保证避免服务端总超时——因此每份连接仍有独立 30–900 秒总超时，流式开关默认关闭。

若兼容服务对「流式 + 部分图片」返回特定 400（如 `partial_images requires stream=true`，常见于网关剥离 `stream` 却透传 `partial_images`），客户端会**自动改用非流式重试一次**并提示，无需手动关闭。

## 数据位置

EmberImage 使用系统的 `userData` 目录。单条历史「删除」把对应原图移到系统废纸篓；「清空记录」只清空索引并保留原图。

---

## 开发

- 纯 CJS + 原生 JS，无构建步骤；测试用 Node 内置 `node --test`；
- 目录：`src/main`（Electron 主进程）、`src/renderer`（界面）、`src/shared`（纯逻辑与 Provider 适配器，主/渲染进程共享）、`test`（单测与端到端流水线测试）；
- 多模型接入点：`src/shared/providers/` 下每个适配器实现统一的 `endpoints/headers/buildGenerationBody/buildEditBody/parseResponse` 接口，注册进 `index.cjs` 即可扩展新接口。

## 文档

- 完整维护与发布流程：[`docs/RELEASING.md`](docs/RELEASING.md)
- 各版本更新说明：[`docs/releases/`](docs/releases/)

---

<p align="center">
  <sub>由 <a href="https://github.com/lds2050">lds2050</a> 维护 · 本地优先 · 隐私优先 · 🔥</sub>
</p>
