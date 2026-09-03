# EmberImage 路线图

> 当前版本：**v0.6.0**（多模型支持）。本文件随开发迭代更新；已发布的能力以 [Releases](https://github.com/lds2050/EmberImage/releases) 为准，分版本详情见 [`docs/releases/`](releases/)。

## 版本进度

| 版本 | 主题 | 状态 |
|---|---|---|
| v0.4.x | 基础生图 / 编辑 / 画廊历史 | ✅ 已发布 |
| v0.5.x | 图像工具箱（选区 / Mask / 背景移除）· 提示词库 | ✅ 已发布 |
| v0.6.0 | 多模型支持（Seedream / Gemini / 三档能力） | ✅ 已发布 |
| v0.7.0 | 多轮改图 | 🔜 规划中 |
| — | 社区化（License / 贡献指南 / 路线图公开） | 🟡 推进中 |

## 规划中（Next）

### v0.7.0 — 多轮改图
多轮（multi-turn）改图让同一张图可以连续对话式调整，无需反复拖回结果图。

- **OpenAI**：本地会话链，将历史结果作为参考图持续回传，维持同一主题一致性。
- **Gemini**：原生多轮（`generateContent` 支持多轮图片上下文），直接吃红利，届时在 Gemini 下启用连贯会话。
- 统一一个"会话 / 多轮"入口，与现有单张生成并列，避免打乱既有流程。

## 探索中 / 暂不承诺

- **更多 Provider 适配**（如 Midjourney 代理类）——仅在 OpenAI 兼容不覆盖、且能维持"零第三方中转 + 可审计"承诺时考虑，优先级 P2。
- **网页版 / 云端同步**——与本项目"本地优先、隐私优先"定位冲突，原则上不做，除非明确改变产品定位。

## 维护说明

- 本路线图是**计划而非承诺**，排序会随反馈与精力调整。
- 想推动某一项，欢迎开 issue 讨论（[Feature request](https://github.com/lds2050/EmberImage/issues/new/choose)）。
- 贡献方式见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。
