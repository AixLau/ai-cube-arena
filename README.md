# 魔方智竞 · AI 三阶魔方能力评测平台

AI 模型三阶魔方评测工具：填写供应商的 API 地址与密钥，系统自动获取该供应商提供的模型；勾选模型、难度与推理强度后，各模型从**同一个打乱状态**并发复原魔方，实时对比并可回放。平台本身不提供模型。

## 快速开始

```bash
npm install            # 会通过 postinstall 自动应用 patches/ 中的 cubing.js 修复
cp .env.example .env   # 可选：配置 CREDENTIAL_SECRET、HTTPS、并发等
npm run dev            # 前端 http://localhost:5173 ，后端 http://localhost:8787
```

打开「模型配置」添加供应商（协议 + API 地址 + API Key），保存后自动获取模型列表；然后在「AI 竞技场」勾选模型、选择难度与推理强度，点击「开始评测」。

生产部署：

```bash
npm run build
REQUIRE_HTTPS=true CREDENTIAL_SECRET=... npm start   # Node 服务同时提供 API 与静态页面
```

测试：`npm test`（魔方引擎、地址拼接、SSRF 防护、脱敏、四种协议适配器、多模型并发评测）。

## 功能

- **官网首页**：品牌主视觉、three.js 实时渲染的 3D 三阶魔方（悬浮、层转动、可拖拽）、环绕式模型卡片、平台优势与「接入模型 → 选择难度 → 选择模型 → 开始竞技」四步引导；第 2 步选择的阶数与打乱程度会带入竞技场。支持浅色 / 深色主题（记住选择，首帧无闪烁）。
- **多阶魔方**：2×2、3×3、4×4、5×5，统一使用 18 种外层转动；引擎按阶数生成转动置换，提示词按阶数说明朝向与编码。
- **模型配置（供应商）**：只需填写接口协议、API 地址、API Key；保存后自动调用供应商的模型列表接口获取可用模型，可随时刷新。名称、认证方式、最大并发请求数放在「高级」中，均有默认值。供应商不支持模型列表时，可在卡片上手动补充模型。支持测试连接（检查工具调用支持）、编辑、复制、删除。
- **多协议适配器**：OpenAI 兼容 Chat Completions（主力）、OpenAI Responses、Anthropic Messages、Google Gemini，各自独立实现工具调用格式；新增协议只需实现 `ProtocolAdapter`（`server/adapters/`）。
- **推理强度**：每个参赛模型可选 默认 / 低 / 中 / 高。Chat Completions 发送 `reasoning_effort`，Responses 发送 `reasoning.effort`，Anthropic 发送 `thinking.budget_tokens`，Gemini 发送 `thinkingConfig.thinkingBudget`；「默认」不发送任何参数。模型拒绝该参数时自动去掉重试一次，并在卡片与对比表中标注「已回退默认」。
- **同题评测**：服务端只打乱一次；每个模型独立的魔方状态、计步、计时、Token 统计与复原判定；真正并发运行，可配置单局并发与全局并发；单个模型暂停 / 继续 / 停止，以及终止全部。
- **实时可视化**：按参赛数量自动排列（1 个大视图、2 个左右双栏、3～4 个网格、更多自动换行），支持聚焦查看；每张卡片含独立可交互 3D 魔方、状态、最新动作、旋转次数、Token、API 调用次数、API 响应耗时、整局耗时、费用与操作历史。
- **统计与回放**：结束后生成横向对比表；保存初始状态、供应商与模型标识（不含密钥）、完整动作轨迹，支持历史列表、按真实时间轴同步回放、导出 JSON；排行榜按 供应商 + 模型 + 推理强度 汇总。
- **自由练习**：18 种基本转动、面转 / 四分之一转计数与计时。

## 评测规则

- 工具 `rotate_cube({ moves: string[] })`，每次 1～N 步，只允许 18 种记号；含非法记号或超限时整次拒绝、不执行。
- 模型只收到当前状态（状态编码规范 `facelet-net-v1`：展开图 + 逐面九宫格），收不到打乱公式。
- 统一限制：最大 API 调用次数、最大运行时间、单次调用最多步数（暂停时不计时）；总旋转次数不限。
- 连续 3 次不调用工具判定失败；网络错误、超时、429、5xx 自动重试最多 2 次（计入调用次数）。

## Token 与费用口径

- 只使用供应商返回的真实用量，未返回显示「未知」，部分缺失以 * 标注。
- 推理 Token 作为输出 Token 的组成部分单独展示，不重复累加（Gemini 的 thoughts 会并入输出后再计费）。
- 费用只采用供应商在响应中返回的计费金额（如 `usage.cost`），单位以供应商为准；供应商未返回时显示「未知」，系统不按任何价格表估算。

## Base URL 规则

| 协议 | 填写示例 | 最终请求地址 |
| --- | --- | --- |
| Chat Completions | `https://relay.example.com/v1` | `…/v1/chat/completions` |
| Responses | `https://api.openai.com/v1` | `…/v1/responses` |
| Anthropic | `https://api.anthropic.com` 或 `…/v1` | `…/v1/messages` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` | `…/models/{模型}:generateContent` |

不写死官方域名，不自动追加或重复拼接 `/v1`；已经是完整端点时原样使用。表单会实时显示最终地址，测试连接 404 时会提示是否缺少版本路径。

## 安全

- 所有模型请求由后端代理发起；浏览器仅在保存配置时提交密钥，服务端从不回传（`GET /api/providers` 只返回密钥来源）。
- 密钥默认只存在服务端内存；用户勾选且服务端配置 `CREDENTIAL_SECRET` 时才以 AES-256-GCM 加密写入 `data/credentials.json`。
- 密钥不会出现在日志、错误信息、SSE 事件、评测记录与导出文件中；上游错误内容先脱敏（含供应商打码回显的尾号）。
- 自定义地址 SSRF 防护：仅 HTTPS；拒绝内网、回环、链路本地、CGNAT、云元数据、保留与组播地址（含 IPv4 映射 IPv6）；**连接时**再次校验 DNS 解析结果（防 DNS 重绑定）；不跟随重定向；响应体大小上限。
- 服务端预置（环境变量）模型只读，复制时不带出密钥，防止被改写地址后外发。
- `REQUIRE_HTTPS=true` 强制 HTTPS 并发送 HSTS。

## 技术架构

| 部分 | 技术 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite，react-router |
| 3D 魔方 | 评测与回放：cubing.js `TwistyPlayer`（2～5 阶，层旋转动画，拖拽视角），`patches/` 修复了切换显示选项后画面回退的问题；首页主视觉：three.js（圆角块体、物理材质、环境反射） |
| 状态引擎 | `shared/cube.ts`：独立实现的 N 阶贴纸模型（6×N×N），前后端共用 |
| 后端 | Node.js + Express（tsx 运行 TypeScript），SSE 推送评测事件，undici + 自定义 DNS 校验发起上游请求 |
| 存储 | `data/providers.json`（配置，无密钥）、`data/credentials.json`（可选加密密钥）、`data/runs/*.json`（评测记录） |

```
shared/   cube.ts 状态引擎 · types.ts 共享类型 · endpoint.ts 地址拼接
server/   index.ts 路由
          adapters/  各协议适配器与安全 HTTP 客户端
          arena/     run.ts 同题评测引擎 · prompt.ts 提示词与工具定义 · store.ts 记录存储
          providers/ store.ts 配置与密钥 · test.ts 测试连接
          security/  url.ts SSRF 防护 · redact.ts 脱敏 · crypto.ts 加密
src/      pages/ 首页、竞技场、模型配置、历史回放、排行榜、自由练习 · components/ 卡片、表单、魔方视图等
```
