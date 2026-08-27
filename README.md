# EmberImage

一个本地优先的 GPT Image 2 桌面客户端。输入自己的 OpenAI 或兼容 API 地址与密钥，即可通过图形界面完成文字生图。

## 当前版本

V0.3.1 已实现：

- 多份独立连接配置，可分别保存名称、Base URL、模型、密钥策略、总超时和流式开关；
- GPT Image 2 提示词、尺寸、质量、数量、背景、格式、压缩率和审核级别；
- 自定义尺寸的 16 倍数、宽高比、像素范围校验；
- 普通 JSON 响应，以及可选的 SSE 部分图流式预览（默认关闭）；
- Base64 图片响应与兼容接口 URL 响应；
- 生成中状态、取消、错误分类与请求 ID；
- 单张/批量下载、复制原图、在文件夹中显示；
- 生成结果和画廊图片双击放大预览；
- 卡片式画廊、搜索、收藏、复用提示词、按原参数再生成和移到废纸篓；
- 设置页右上角请求日志抽屉，可查看完整请求参数（不含 API Key）、耗时、Request ID、响应摘要和失败响应体；
- 窗口缩放时按固定设计画布等比例适配，不产生页面滚动条；
- 会话内密钥，或重新打开应用后自动解密的本机加密密钥。



## 密钥策略

- 默认“仅本次会话”：密钥只驻留 Electron 主进程内存，退出应用即清除；
- 可选“本机加密保存”：API Key 使用独立随机设备密钥和 AES-256-GCM 加密，应用重新打开后自动解密；
- 设备密钥以 `0600` 权限保存在当前用户应用目录，不使用系统钥匙串。它避免 API Key 明文落盘；
- API Key 不写入生成历史、图片参数或请求日志；请求日志会保留完整提示词和其他 API 参数；
- 非本机地址必须使用 HTTPS。

## 本地运行

需要 Node.js 20 或更新版本。

```bash
npm install
npm start
```

测试与静态语法检查：

```bash
npm test
npm run check
```

## 下载与安装包

项目通过 GitHub Actions 分别构建：

- Windows x64：NSIS `.exe` 安装程序；
- macOS Apple Silicon：arm64 `.dmg`；
- macOS Intel：x64 `.dmg`。

安装包会附加在 GitHub 仓库的 Releases 页面。当前安装包未购买商业代码签名证书，因此 macOS Gatekeeper 或 Windows SmartScreen 可能在首次运行时显示安全提示。

维护者发布新版本的完整步骤见 [`docs/RELEASING.md`](docs/RELEASING.md)。

## 默认 API

- Base URL：`https://api.openai.com/v1`
- Endpoint：`POST /images/generations`
- Model：`gpt-image-2`

兼容服务需要实现 OpenAI 图片生成响应格式。客户端支持 `data[].b64_json`，也兼容部分服务返回的 `data[].url`。启用流式请求时，兼容服务还需支持 GPT Image 的 SSE 事件格式。

## 流式请求说明

流式模式可以更早返回部分图片、改善等待反馈，也可能降低部分代理的空闲连接超时风险。它不会缩短模型生成时间，也不能保证避免服务端总超时，因此每份连接仍有独立的 30–900 秒请求总超时，流式开关默认关闭。

## 数据位置

EmberImage 使用 `userData` 目录。单条历史的“删除”会把对应原图移到系统废纸篓；“清空记录”只清空历史索引并保留原图。
