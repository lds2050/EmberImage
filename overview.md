# v0.6.0 阶段 A 完成：Provider 适配层骨架

## 做了什么

为 v0.6.0 多模型支持铺路：把「请求怎么发」从主进程里抽出来，做成可替换的适配器。**此版本对用户完全无感** —— 存量连接走的是同一条代码路径，只是换了层壳。

### 1. 适配层骨架（新增）
- `src/shared/providers/index.cjs` — `resolveProvider(profile)` 按 `profile.provider` 分发；`normalizeProvider` 白名单归一（openai / seedream / gemini），未知值或未注册的 id 一律回退 **openai**。所以旧配置（config.json 里没有 provider 字段）照原样跑。
- `src/shared/providers/openai.cjs` — OpenAI 适配器，把 v0.5.4 的构造逻辑原样包装：三端点（generations / edits / models）、Bearer 头、生成 payload、multipart 编辑表单、响应归一 `{ images, text, usage }`。行为逐字节等价。

### 2. 主进程接线（等价替换）
`createGeneration` / `createEdit` / `testConnection` 三处改为向适配器取端点、认证头与请求体；`saveConnection` 持久化 `provider`；`publicProfile` 把它暴露给连接编辑器。请求体、请求头、解析结果与改动前完全一致。

### 3. 连接对话框「接口类型」
新增接口类型选择器：OpenAI 兼容（可选中）+ Seedream / Gemini（置灰，标注「后续版本开放」）。seedream/gemini 的适配器在阶段 B 落地，届时放开并接上地址/模型占位符切换。

## 验证
- `npm run check`：静态检查通过（新增两个 provider 模块已纳入 check 脚本）
- `npm test`：**115/115** 通过（新增 `test/providers.test.cjs` 14 例：分发回退、端点与 payload 等价性、multipart 字段、条件字段、响应归一、默认 profile）
- 流水线测试 **16/16** —— 本地起 HTTP 服务跑真实生成/编辑请求，证明适配器重构是行为保持的（含流式降级用例）

## 相关提交
- `f5d7706` Stage A of v0.6.0: provider adapter skeleton and interface-type selector

## 试用重点（请老板确认）
1. **旧配置无感回归**：启动后原有连接照常生成 / 编辑，结果、日志、历史条目与 v0.5.4 无差别
2. **新连接**：设置页新建连接，接口类型区显示三档、仅 OpenAI 兼容可选；保存后重开设置页回显正确
3. 生成、编辑（含 Mask 局部编辑）、测试连接、请求日志均正常

## 下一步（阶段 B）
Seedream 与 Gemini 适配器：文字生图 + 参考图编辑（Seedream 走 image 数组、Gemini 走 generateContent 的 inlineData）、1K/2K/4K 档位与 Gemini 比例档、Mask 入口在无 Mask 能力时置灰引导、能力徽章三档、历史条目记 provider。
