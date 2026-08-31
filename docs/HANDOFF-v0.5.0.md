# EmberImage v0.5.0 开发交接摘要

> 更新于 2026-08-31 · 用途：把开发上下文交给新设备/新会话的 AI。本文件是临时交接文档，发布 v0.5.0 前可删除。

## 从哪里开始

1. 读本文件 → 2. 读 `docs/PRD-v0.5.0.md`（需求来源）→ 3. 读计划文件（**不在仓库里**，需单独拷贝，原机路径）：
   - `~/.qoder/plans/rare-beacon-gull.md` — 四阶段总计划（含阶段 D 的完整任务清单与已验证的技术事实）
   - `~/.qoder/plans/eager-fjord-lynx.md` — 阶段 C 实施计划（已完成，含对总计划的两处修正）
   - `~/.qoder-cn/plans/rapid-cloud-wren.md` — 阶段 A 收尾 + 阶段 B 实施细节
   - `~/.qoder-cn/plans/shining-fjord-puffin.md` — 试用反馈三个修复方案（已实现）

## 当前进度

| 阶段 | 状态 |
|---|---|
| A 请求与数据基础（编辑端点/素材注册/multipart/历史 v3/日志脱敏） | ✅ 完成 |
| B 核心界面（模式切换/素材面板/编辑提交/历史整合） | ✅ 完成 + 试用修复 |
| C Mask 编辑（整体/局部切换、画布编辑器、查看器叠加） | ✅ 完成 + 用户试用通过 |
| D 兼容与发布（能力状态/错误文案/升版/发布材料） | ✅ 完成，待提交发布 |

- 交付方式：每阶段完成后**停下汇报、等用户确认再继续**；只做 P0+P1，P2 暂缓。
- 代码状态：v0.5.0 全部改动待提交；版本材料就绪（0.5.0、README、`docs/releases/v0.5.0.md`）。
- 自动化验证：`npm run check && npm test` **58/58 全绿**；app.js↔index.html DOM id 双向核对通过（158 个引用）。

## 实现速查（代码定位）

- `src/main/main.cjs`：`createEdit`（镜像 `createGeneration`）、`saveMask`（校验 PNG/同尺寸、暂存注册）、**有 Mask 且主图非 PNG 时 `createEdit` 复制段自动 `toPNG()` 转换 input-0**、`assetRegistry`、单飞 `activeRequestTaskId`（首个 await 前同步赋值、外层 finally 释放）、`__testing` 钩子（含 `saveMask`）、`editRequestDetails` 脱敏日志、`hydrateEntry` 输出 `inputs[].previewUrl` 与 `mask.previewUrl`。
- `src/shared/edit-form.js`：`buildEditMetadata`/`buildEditFormData`（multipart 字段；**省略 `input_fidelity`**）。
- `src/shared/mask-model.js`：`createMaskSession(initialStrokes?)` 笔画会话（addStroke/undo/redo/clear，上限 50，可绑定外部数组持久化草稿）+ 画笔常量 10/300/80。
- `src/main/storage.cjs`：历史 v3、`tmp/history-media/thumbs`、任务临时目录生命周期、能力字段。
- `src/main/preload.cjs`：`pickImages`/`importAssets`/`importBuffer`/`removeAsset`/`saveMask`/`edit`/`cancelEdit`。
- `src/renderer/app.js`：`setCreationMode` + `modeMemory`（每模式独立快照）；`setEditScope`/`renderMaskStatus`/`discardMask`/`confirmDiscardMask`（**所有换主图路径都有确认守卫**：删首位/移位涉及首位/继续编辑/再次编辑）；`maskEditor` 画布模型（显示/导出分离：预览层橙色叠加 `source-over`+`destination-out`，导出层语义相反——画笔打透明洞、橡皮恢复不透明）；`exportMask`（全尺寸离屏画布 → toBlob PNG → `api.saveMask`）；查看器 `renderViewerImage`（mask 透明像素重着色为橙色叠加，长边上限 2048）。
- 测试：`edit-pipeline.test.cjs`（13 用例，含 saveMask/带 mask 请求/JPEG→PNG 转换/尺寸不符拒绝）、`mask-model.test.cjs`（8 用例）、`validation-edit/storage-v3/edit-request` 等。

## 已确认的关键决策（不要推翻）

1. 编辑模式成功/失败/取消后**保留素材**（PRD 12.10）。
2. 继续编辑 = 结果图成为新主图、提示词保留并全选（PRD 8.4）。
3. 按原参数再次编辑 = 恢复输入图 + 参数，**不恢复 Mask**（PRD 未要求；范围回整体）。
4. 同一时刻全应用只允许一个图片任务（单飞，避免并发计费）。
5. 技术红线：不新增 npm 依赖；Node 24 全局 `fetch`/`FormData`（**绝不手动设 Content-Type**）；Electron 44 无 `clipboard.readImage()`，粘贴走 DOM paste → `arrayBuffer()` → IPC；沙箱下 `file.path` 不可靠，禁用。
6. `/images/edits` 返回 404/405 → `editCapability:"unsupported"`；401/403/429/5xx/超时**不得**标记。
7. 日志脱敏：不得含 API Key、图片 Base64、完整本地路径。
8. localStorage 键：`emberimage-last-prompt`、`emberimage-last-edit-prompt`、`emberimage-creation-mode`。
9. **（阶段 C 修正 1）基图 PNG 转换在 `createEdit` 复制段做**，不由 `saveMask` 返回转换素材——渲染层只管 `maskAssetId`，避免额外素材生命周期联动。
10. **（阶段 C 修正 2）编辑器实现滚轮缩放 + 适合窗口/100% + 空格拖动**（PRD P0）；无惯性/触控手势。

## 下一步：提交与发布（阶段 D 收尾）

代码与文档均已就绪，只剩发布动作：
1. 审计暂存清单（无密钥/配置/大文件）后提交全部 v0.5.0 改动（提交信息风格：`Release EmberImage v0.5.0` + 要点正文）。
2. `git push origin main`；`git tag -a v0.5.0 -m "..."`；`git push origin v0.5.0` 触发 CI 三平台构建并自动创建 Release（说明取自 `docs/releases/v0.5.0.md`），流程见 `docs/RELEASING.md`。
3. CI 成功后抽查 Release 附件；本文件可在发布确认后删除。

能力状态/错误文案的实现位置：`app.js` 的 `updateCapabilityDisplay`/`refreshConnectionCapabilities`（生成与编辑的 finally 中刷新）、`friendlyError`（PRD §9.12 对齐，含 `mask_size_mismatch`/`mask_conversion_failed`/`moderation_blocked`/`content_policy_violation`/`image_generation_user_error` 等）。

三平台验证矩阵（PRD §13）：macOS 本机功能已由用户试用覆盖（A/B/C 各轮）；Windows 与 macOS Intel 的行为差异依赖 CI 构建成功 + 发布后用户抽查（拖拽/粘贴/下载/复制/废纸篓）。

## 已知限制

- EXIF 方向不自动纠正（nativeImage 与浏览器 `<img>` 行为可能不一致，极端情况下导出尺寸校验会拒绝；P2 再处理）。
- 素材排序用左右移动按钮（首版兜底，用户已接受）。
- 查看器"显示编辑区域"叠加在结果图上为**近似对齐**（输出尺寸可能与输入不同，`size=auto` 时）；在原图上精确。
- 局部编辑不自动把尺寸切到 `auto`（PRD 9.6 只是默认值建议）。
- 重绘保留笔画草稿（`state.mask.strokes` 常驻），关闭编辑器不丢；换主图才清除（有确认）。

## 手动验证状态

- 阶段 A/B：用户已本机试用正常；3 个试用问题已修复（`shining-fjord-puffin.md`）。
- 阶段 C：**待用户试用**。建议清单：局部编辑画布交互（涂抹/橡皮/撤销/重做/清空/缩放/空格拖动/预览开关）；确认后素材面板状态与重绘/清除；换主图清除确认；JPEG 主图局部编辑成功（自动转 PNG）；历史"✎ 局部编辑"徽标；查看器"显示编辑区域"叠加；整体编辑与文字生图回归。
