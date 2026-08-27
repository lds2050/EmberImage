# EmberImage 发布说明

本项目使用 GitHub Actions 在真实的 Windows 与 macOS 构建机上生成安装包。发布者不需要在自己的 Mac 上交叉编译 Windows 安装包。

## 用户数据不会被发布

应用的连接配置、加密 API Key、生成历史、请求日志和生成图片位于 Electron 的用户数据目录，不在源码仓库内。Git 只提交项目目录中未被 `.gitignore` 排除的文件。

提交前执行以下命令检查即将进入版本库的文件：

```bash
git status --short
git diff --cached
```

任何真实密钥、`.env`、`.npmrc`、证书、`node_modules`、`release` 和本地安装包都不应出现在输出中。

## 首次发布

```bash
git init -b main
git add .
git status
git commit -m "Release EmberImage v0.3.1"
git remote add origin git@github.com:lds2050/EmberImage.git
git push -u origin main
git tag -a v0.3.1 -m "EmberImage v0.3.1"
git push origin v0.3.1
```

推送 `v0.3.1` 标签后，`.github/workflows/release.yml` 会自动执行：

1. 在 Windows 构建 `EmberImage-0.3.1-win-x64.exe`；
2. 在 macOS 构建 Apple Silicon 版 `EmberImage-0.3.1-mac-arm64.dmg`；
3. 在 macOS 构建 Intel 版 `EmberImage-0.3.1-mac-x64.dmg`；
4. 三个任务和测试都成功后创建 GitHub Release，并附上三个安装包。

所有安装包使用最高压缩，并只保留中文与英文 Electron 语言资源。macOS 分架构发布可以避免通用包同时携带两套 Chromium，用户只需下载与自己电脑芯片匹配的文件。

## 后续发布新版本

先修改 `package.json` 的版本号并提交，例如发布 0.3.2：

```bash
npm version patch
git push origin main
git push origin v0.3.2
```

版本类型：

- `npm version patch`：小修复，例如 0.3.1 → 0.3.2；
- `npm version minor`：新增功能，例如 0.3.1 → 0.4.0；
- `npm version major`：不兼容的大改动，例如 0.3.1 → 1.0.0。

## 未签名安装包提示

当前免费发布流程没有 Apple Developer ID 与 Windows 代码签名证书：

- macOS 首次打开可能提示开发者无法验证，可在“系统设置 → 隐私与安全性”中选择仍要打开；
- Windows 可能显示 Microsoft Defender SmartScreen，用户需选择“更多信息 → 仍要运行”。

代码签名证书不会放进仓库。以后购买证书时，应通过 GitHub Actions Secrets 配置签名与 Apple 公证。
