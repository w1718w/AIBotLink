# IM Agent Gateway — 完整项目开发任务书

> **项目定位**：轻量、独立、可扩展的本地 Coding Agent 即时通信控制网关。  
> **目标环境**：Windows 优先；多台电脑各自运行一份网关，各连接一个 QQ 机器人；每台电脑可控制本机的 Codex 与 DSH。<br>
> **开发方式**：交给编码 Agent 自主调研、选型、实施和验收。  
> **核心要求**：不用大模型处理管理命令；网关不依赖任一 Agent 存活；保留原生会话与控制能力；先完成小而完整的可运行成果，再逐步完善。

> **使用说明**：本文是开发任务书，图示、接口和配置均为待实施方案，不代表当前系统已具备这些能力。选型依据见 [开源实现调研](research-2026-10-30.md)，本机接口探测与验证范围见 [选型验证](validation-2026-10-30.md)；正式采用前仍须核验安装版本和真实链路。本轮建议采用薄 TypeScript 网关，QQ SDK 与 Zhin 待真实 QQ 交互比较后选择，DSH 优先验证 ACP；这项建议尚待真实 QQ 与 DSH 任务链路验证，不是已定的运行架构。

---

## 一、项目背景、现状与最终目标

### 1.1 目标部署环境

目标部署支持多台 Windows 电脑，各自运行 OpenAI Codex 与 DeepSeek Harness（简称 DSH）。交互需求参考 [dsh-im](https://github.com/xmanrui/dsh-im) 的 QQ 交互、`/m` 菜单、Session、Model、Reasoning、Permission、Preset、Stop、Steer 和审批功能。网关独立于 DSH-IM 运行：DSH 失效时，Codex 仍必须可以通过 QQ 控制。

多机独立部署示例（DSH 的接入路径按第七章验证后选择）：

```text
电脑 A                                电脑 B
  QQ Bot A                             QQ Bot B
     │                                    │
  本机独立网关                         本机独立网关
     ├── Codex Adapter                     ├── Codex Adapter
     │     └── Codex                        │     └── Codex
     └── DSH Adapter                       └── DSH Adapter
           └── ACP / 按需 Companion              └── ACP / 按需 Companion
                 └── DSH 原生后端                      └── DSH 原生后端
```

各台电脑不需要跨机器协调、公共调度中心或云端服务。各套部署使用相同版本的程序，配置、凭据和状态各自独立。

### 1.2 目标使用体验

通过 QQ 或将来接入的微信等 IM：

1. 查看当前电脑已注册的 Agent、各实例可用性及正在执行的任务。
2. 在 DSH 与 Codex（未来可扩展其他 Agent）之间切换；普通消息直接发给被选中的原生 Agent。
3. 不经大模型，使用预置命令启动、停止、重启**由网关管理**的本地 Agent 后端。
4. 列出、创建、恢复和切换各 Agent 的原生会话，保留原始工作区与历史。
5. 查看并更改模型、推理强度、权限/沙箱策略、支持的 Preset 等。
6. 中断任务、追加 Steer（如果原生接口支持），处理 Agent 原生审批或提问。
7. 收到任务进度、最终回复、错误和需要的文件/图片。
8. 使用 QQ 原生命令面板、快捷按钮和参数输入，而不必全靠手打或层层文本菜单。
9. 支持 QQ、微信等不同 IM 前端共享同一个 Agent 控制后端，不需要为每个平台重复开发 DSH/Codex 接口。

**管理命令采用确定性代码执行；仅普通 Agent 任务使用目标 Agent 自身的大模型。**

### 1.3 项目非目标

这不是第二个 OpenClaw，不自行实现模型推理、工具执行、Agent 规划、记忆、RAG、向量库、MCP 生态、跨电脑任务调度、复杂 Web 控制台或 Agent 多角色协作。网关不代理模型 API，也不重写 Codex / DSH 核心。

---

## 二、最高优先级的开发原则

### 2.1 独立性与职责分离

- IM 接入和 Gateway 生命周期独立于 Codex、DSH：任一 Agent 未安装、崩溃或重启，都不能影响网关与另一 Agent。
- 不使用 DSH 调用 Codex，也不使用 Codex 调用 DSH。
- IM Adapter 只处理 IM 平台差异（消息、菜单、按钮、认证、文件）；Agent Adapter 只处理原生 Agent API；Gateway Core 只处理路由、会话绑定、进程及命令调度。
- DSH 优先验证原生 ACP 接口；只有需要控制 Desktop Host 等 ACP 未覆盖的能力时，才增加 DSH Companion。Companion 是 Host 内只连接本机网关的薄插件，**不在插件中直接接 QQ/微信**。
- 逻辑分层不意味着多进程或微服务。优先单网关进程 + 原生 Agent 进程，按实际需要增加 Companion。

### 2.2 简洁架构、适度防御和快速失败（特别重要）

**坚持 KISS（Keep It Simple, Stupid）与 Fail Fast。这个项目本质上是简单中间件，不应过度设计或过度防御。**

上游输出、下游输入若由已验证的 SDK/API 契约保证类型及格式固定，**不要层层重复检查、深度归一化、加入猜测式兼容分支、静默兜底或大量 `try/catch`**。接口不符合契约时，应抛出带有明确上下文的错误，让问题直接暴露；不要把错误吃掉，返回貌似成功的空对象、空列表或默认值。

仅在**真正的信任边界和故障边界**实施必要防御：来自 QQ/微信的不可信输入、权限身份、凭据、进程命令、对外 IPC、网络断线、限流、消息去重、审批的时效及会话归属。这些安全和外部故障处理必须保留。内部受控协议不必重复做同样的校验。

不引入复杂抽象以防范纯假想需求；不要做“万一以后支持几十种 Agent”的过早泛化。**先交付可运行、功能完整、规模小的纵向成果，再根据实际使用和缺陷决定后续扩展。** 小成果必须能完成真实用户操作闭环，而非只有接口或空壳。不要为追求表面健壮性牺牲可观察性和可维护性。

### 2.3 尽可能复用，避免维护上游 Fork

优先复用经核实可用的现成框架、官方 SDK 和协议。未确认许可的仓库只参考公开设计思路，不直接复制代码。保留使用过的开源代码版权与许可文件。引用外部项目要核对实际代码、依赖、更新状态及兼容版本，不能只靠 README 推断能力。

### 2.4 管理面不调用大模型

`/agents`、`/agent`、`/runtime`、`/sessions`、`/model`、`/reasoning`、`/permission`、`/status`、`/stop`、`/help` 等管理命令，直接调用网关或所选 Agent 的原生控制 API；不得用 LLM 来解析或执行这些命令，也不应提示另一个 Agent 代做。

---

## 三、目标架构与边界

```text
      QQ Bot / 微信 iLink / 未来其他 IM
                      │
       各 IM Platform Adapter（优先复用）
                      │
            ┌── IM Gateway Core ──┐
            │  Message Router     │
            │  Command Registry   │
            │  Command Sync       │
            │  Identity / Access  │
            │  Session Binding    │
            │  Event & Approval   │
            └─────────┬───────────┘
                      │
           Agent Runtime Manager
             + Agent Registry
                      │
             Agent Adapter API
                ┌─────┴─────┐
          Codex Adapter   DSH Adapter
                │             │
           App Server     原生 ACP
                │             │
              Codex       DSH 后端

   需要 Desktop Host 能力时：DSH Adapter → 本机 IPC → 薄 Companion → DSH Host
```

该方案要求网关作为独立服务运行，提供少量清晰的内部接口。Agent 侧可各自实现能力声明，不强求两者使用同一底层协议、权限模型或会话所有权语义。ACP 与 Companion 的能力须分别声明，不因统一命令而伪装成相同后端。

### 3.1 Agent 接口草案（按验证结果调整）

```ts
interface AgentAdapter {
  id: string;
  status(): Promise<AgentStatus>;
  capabilities(): Promise<AgentCapabilities>;
  listSessions(options?: object): Promise<SessionInfo[]>;
  createSession(options: object): Promise<SessionInfo>;
  attachSession(sessionId: string): Promise<SessionInfo>;
  getHistory(sessionId: string, limit?: number): Promise<HistoryItem[]>;
  send(sessionId: string, input: AgentInput): Promise<ExecutionResult>;
  interrupt(sessionId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<AgentEvent>;
}
```

模型、推理强度、权限、Preset、工作区、Steer、Compact、审批、文件和图片等为**可选能力**，由适配器报告，并以当前原生后端真实支持范围为准。无需为了接口整齐，把所有操作都变成必选方法或复杂的空实现。

---

## 四、候选网关及参考项目

编码 Agent 需**先核查当前版本和必要的具体源码、许可证、API，再选型**，不做无目的的大仓库通读。[开源实现调研](research-2026-10-30.md) 保存了固定提交证据与限制；这里说明候选职责和选型规则，不复制研究过程。

### 4.1 现成桥接器与原生控制参考

- **[cc-connect](https://github.com/chenhg5/cc-connect)**：多 IM、多 Agent 的现成产品候选。核查 QQ 官方 `qqbot` 路线、Codex `app_server` 后端和通用 ACP，勿混同 OneBot 接入或默认 `exec` 后端。调研提交中列 Codex 会话会改写部分原生 JSONL 元数据，且 Agent 初始化失败会使主程序退出，均与本任务硬约束冲突；README 声明 MIT，但未找到独立许可文件。只有能在明确授权和可控改造成本下消除冲突才考虑采用，不预设维护 Fork。
- **[HAPI](https://github.com/tiann/hapi)**：参考 Codex 同后端共享会话、执行所有权、原生审批仲裁和 DSH ACP 接入；它面向 Web/原生客户端，不是 QQ 聊天网关。AGPL-3.0，使用代码前核对许可要求，不按 MIT 项目处理。
- **[agent-wechat-bridge](https://github.com/xixi25937/agent-wechat-bridge)**：参考轻量 daemon、微信传输、进度与文件交付。其自有 App Server 与 Desktop 私有 IPC 是两条路径；后者依赖桌面版本，不得当成官方通用会话接管协议，也不应成为必需依赖。
- **[Takopi](https://github.com/banteg/takopi)**：参考会话路由、恢复、Runner/Transport 边界与 Steer。调研提交会自动接受部分 Codex 审批，**不得复用这一行为**。

### 4.2 [Zhin.js](https://github.com/zhinjs/zhin) — TypeScript IM 底座候选

- 方向：TypeScript/Node.js，模块化机器人框架，不必须加载它的 AI Agent 功能。
- 研究：`@zhin.js/core`、`@zhin.js/adapter-qq`、`@zhin.js/adapter-weixin-ilink`、`@zhin.js/adapter-wechat-mp`、`defineCommand`、Endpoint 与 Plugin Runtime。
- 优势：声明式命令、参数类型/校验、平台适配，便于参考 dsh-im 的 JS 代码；QQ Adapter 可以访问底层 QQ SDK API。
- 待验证：安装版本的公开 API 与导出边界；QQ 实际按钮交互与原生面板同步；微信 iLink 的账号准入；Windows 常驻表现。命令声明与底层菜单 API 存在，不等于业务命令已自动注册；按实际包版本核验，不沿用旧版本号。
- 已核查其仓库为 MIT 许可证；正式采用前仍需确认当前版本及依赖情况。

### 4.3 [TencentCloud Octop Gateway](https://github.com/TencentCloud/octop-gateway) — Python IM 底座候选

- 方向：Python 3.12+，多平台消息 Channel 与统一消息模型，QQ、微信 iLink 等接入。
- 研究：`BaseChannel`、Channel 管理、QQ Channel、微信 Channel、`InboundMessage`/事件、推送、媒体、流式和恢复。
- 优势：职责更纯粹，不需要完整 Agent 系统。
- 代价：仍需实现 Agent 会话、审批和进程管理；命令注册/参数校验/QQ 面板可能需要较多开发；Python 与主要参考实现的 JS/TS 不同。核算 QQ-only 场景的实际依赖，多平台 SDK 可能是必选依赖，不能只凭“纯网关”定位判断最轻。
- 已核查其仓库为 MIT 许可证；项目仍较新，要关注真实稳定性。

### 4.4 [dsh-im](https://github.com/xmanrui/dsh-im) — DSH 原生控制与 QQ 交互的重点参考

重点阅读（路径随上游版本核实）：

- `src/channels/qq/qq-runtime.mjs`
- `src/channels/qq/qq-bridge.mjs`
- `src/channels/qq/qq-controller.mjs`
- `src/channels/qq/markdown-reply.mjs`
- `src/channels/qq/qq-menu.mjs`
- `src/channels/shared/model-command.mjs`
- `src/channels/shared/permission-command.mjs`
- `src/channels/shared/harness-approval.mjs`
- `src/channels/shared/harness-client.mjs`
- `plugin-src/host/modern-harness-api.mjs`
- `plugin-src/host/harness-connection.mjs`
- `plugin-src/host/channels/qq/production.mjs`
- `docs/bot-commands.md`
- `docs/adr/0001-semantic-core-native-channel-adapters.md`

借鉴 DSH 原生 Session/Workspace/模型/推理/权限/Preset/审批/Stop/Steer 处理，QQ Markdown、菜单、按钮、长回复、错误回传等成熟机制。**不要将其 Host 插件作为独立网关的运行时基础**。已核查项目为 MIT 许可证，复用时按许可保留声明。

### 4.5 [AgentBridge](https://github.com/chenacc1/agentbridge) — Agent 控制桥思路参考

重点：Codex App Server、DSH ACP、DSH Desktop Companion、会话接管、控制权、审批、进程生命周期、Windows 适配、远程状态。它主要是扫码打开手机 Web 控制台，**不是微信聊天机器人网关**。先前检查未找到仓库根部独立 `LICENSE`，因此在确认授权前不要复制代码；其仍属 MVP，需验证边界条件。

### 4.6 [dsh-bridge](https://github.com/SoftDefender/dsh-bridge) — Host Adapter / Coordinator 思路参考

重点：Codex 与 DSH 分离适配、Session 控制权、Steer/Queue/Turn、持久化和 IPC。不要直接引入其多 Agent 协作、复杂队列或 Linux 特有实现；核对当前许可证文件与支持系统。

### 4.7 官方接口与 SDK

- [QQ 官方机器人文档仓库](https://github.com/tencent-connect/bot-docs)
- [QQ 官方机器人 Node.js SDK](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)
- [QQ SDK `qq-official-bot`](https://github.com/zhinjs/qq-official-bot)
- [腾讯官方 dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)
- [OpenAI Codex 源码](https://github.com/openai/codex)
- [Codex App Server 文档](https://developers.openai.com/codex/app-server)
- DSH 官方 Host / 插件 / SDK / ACP 文档：以当前安装版本及官方发布为准。

比较三类方案：现成桥接器适配、薄 TypeScript 网关（直接 QQ SDK 或 Zhin）、Python IM 底座。按可实现性、独立性、IM 原生交互、Windows、依赖规模、维护状况、许可证和持续改造成本选择。现成方案若要长期改写会话、权限或生命周期核心，不因已有功能多就优先 Fork。**不要未经验证就宣布“已经支持动态参数补全”或“可以接管所有桌面会话”。**

---

## 五、Agent Runtime Manager

它属于网关核心，**由程序代码执行，不依赖大模型**。

### 5.1 Agent 注册表

支持多个实例，初版真实验证 Codex 和 DSH。每个实例可声明：`id`、类型、显示名、可执行文件、预置启动参数、环境变量、工作目录、连接方式、自动启动策略、是否允许由网关停止/重启。

```yaml
# 仅为设计示例；正式语法以最终实现为准
agents:
  codex:
    type: codex
    executable: codex
    transport: app-server
    autoStart: false
  dsh:
    type: dsh
    executable: dsh
    transport: acp          # 按版本实测；Desktop Host 可按需选择 Companion
    profile: acp           # 以安装版本提供的 Profile 为准
    autoStart: false
```

### 5.2 运行时行为

- `/agents` 列出配置的 Agent、在线/运行状态、当前选择、受网关管理状态。
- Agent 未安装、初始化失败或协议不兼容时，只将该实例标记为不可用并返回诊断，不能让网关启动失败或中断另一 Agent。
- `/runtime start codex` 启动预先定义的程序及参数。
- `/runtime stop codex` 仅停止网关拥有的相应进程，**不误杀桌面手工启动的程序**。
- `/runtime restart dsh` 按真实所有权与状态执行。
- 优先连接可控的已运行实例（Attach First）；只有在无法连接且允许启动时才启动新实例（Spawn Second）。仅看到进程名存在不代表拥有可控制的 API 会话。
- 支持失败诊断、健康状态、适度重连、明确的进程所有权和异常退出处理。
- Windows 下考虑 `.exe`/`.cmd`/`.ps1`、路径空格、PATH、工作目录、stdio、进程树及启动方式。
- 禁止提供通用远程 Shell 执行入口；启动命令和参数必须来自本地可信配置。

---

## 六、Codex Adapter

首选 Codex 官方 **App Server**，使用安装版本已验证的协议，初版优先 stdio JSON-RPC。启动参数以该版本 `--help` 为准；不要仅因参考项目用了 `--stdio` 或其他旧写法就判断兼容或不兼容。不得模拟 CLI 键盘输入或篡改私有会话文件，包括为侧栏可见性而修改 `source`、`originator` 等元数据。

需要尽可能实现：App Server 启动/连接、线程/会话列表、新建/恢复、分页历史、Turn、事件、停止、Steer、模型目录、模型切换、Reasoning Effort、原生权限/沙箱与审批策略、审批请求/响应、提问、输出与文件回传。能力必须按安装版本分别验证：

- 从本机 CLI 导出 TypeScript 或 JSON Schema，记录对应版本。协议字段已存在、初始化成功和真实 Turn 通过是不同验证层级。
- 用原生线程列表和分页 turns/items 接口读取历史，避免依赖私有 JSONL 扫描或一次性完整历史返回。保留原生线程标识与会话树标识的区别，不自行假设二者始终相同。
- `turn/steer` 绑定观察到的活动 `expectedTurnId`；过期目标必须失败，不得转投下一 Turn。`/stop` 绑定原生活动任务。
- 处理原生审批与用户提问请求；收到 `serverRequest/resolved` 或原生失效状态后撤销交互。未知请求不能默认批准、伪造回答或错误地消费另一客户端的待答请求。
- 查询安装版本提供的模型、推理档位与权限目录，保留原生语义；实验性 permission profile 等能力单独标记，不以统一权限名称抹平差异。

**控制权须区分四种场景：**

1. 网关自己启动的后端及其线程：按明确进程所有权管理。
2. 多客户端连接同一个 App Server：仅在原生协议和平台实测支持时共享，处理并发输入及审批仲裁。
3. 已存储、可冷恢复的历史线程：恢复前核验是否仍有活动所有者。
4. Codex Desktop 或另一 App Server 持有的活动线程：不得把读到 ID 等同于能写入或接管；不绕过锁或私有协议边界。

WebSocket、`codex --remote` 等共享后端路线按安装版本与官方实验性状态验证；Windows 的传输、认证和进程退出要单独实测。共享同一后端不等于跨后端接管桌面活动线程。私有 Desktop IPC 只能作为明确标记的可选实验，不得成为网关基本链路的必选依赖。

---

## 七、DSH Adapter 与按需 Companion

先验证安装版本的原生 ACP：确认 Profile 与启动入口、完成初始化，再逐项验证会话创建/恢复/列表、历史、工作目录、模型/权限、停止、审批/提问和事件。Profile 存在不代表握手成功，握手成功也不代表全部控制能力可用；超时要记录实际失败点，不能用静默兜底伪装成已接通。

目标能力仍包括列出/绑定/创建 Session、读历史、工作区、模型、推理强度、Permission Preset、Agent Preset、Stop、Steer、Compact、审批/提问、状态事件和文件/图片。依据真实能力声明可用范围；不能为简化实现而将 ACP 不支持的 Desktop Host 能力宣称已完成。

模型与推理选项按原生 `configOptions` 获取和设置；图片、音频及嵌入上下文按 `promptCapabilities` 判断，未声明支持时不得把附件路径伪装成原生媒体输入。已经活动的会话若被原生恢复接口拒绝，应返回明确冲突，不绕过原生控制权。

关闭和恢复 Session 后重新读取原生设置；设置成功不代表跨恢复持久化。区分当前运行会话、后续 Turn 和恢复后的作用域。只有用户已明确选定且原生接口支持时，才按需要重新应用选项并回读确认，不沿用过期显示值。

分开验证 ACP 独立会话、专用 DSH Profile Host 和现有 Desktop Host 会话：它们的历史、设置和控制权未必相通，不可将恢复 ACP 会话写成接管 Desktop Host。

需要的 Desktop Host 能力未由 ACP 覆盖时，参考 dsh-im，在 Host 内增加**薄 Companion 插件**，仅暴露必要原生会话与控制 API，不直接连接 QQ/微信、不成为 Codex 入口。IPC 优先 loopback HTTP/WebSocket 或 Windows Named Pipe，默认仅本机可访问并提供必要认证，无需复杂分布式协议。

DSH 不运行或协议初始化失败时：Gateway + QQ + Codex 仍可用，DSH 状态明确提示不可用，并允许在符合配置/权限时启动配置指定的 ACP 后端或专用 Host。

---

## 八、统一命令和 QQ 自动注册

### 8.1 单一命令注册表

一个 Command Registry 同时提供：执行 handler、参数定义与校验、帮助文本、QQ 原生指令面板、快捷按钮、其他 IM 文本菜单的元数据。避免代码、帮助文档、QQ 面板三套手工维护。

推荐指令（可兼容 dsh-im 别名）：

| 命令 | 作用 | 所属层 |
|---|---|---|
| `/agents` | Agent 列表和状态 | Gateway |
| `/agent [id]` | 查询/切换当前 Agent | Gateway |
| `/runtime start\|stop\|restart <id>` | 本地预配置进程生命周期 | Gateway |
| `/status` | 网关、IM、Agent 状态 | Gateway |
| `/help`、`/m` | 帮助、交互菜单 | Gateway |
| `/sessions`、`/session [id]` | 原生会话列表/选择 | Agent |
| `/new`、`/history` | 新会话/历史 | Agent |
| `/models`、`/model [id]` | 模型目录/切换 | Agent |
| `/reasonings`、`/reasoning [level]` | 推理档位目录/切换 | Agent |
| `/permissionlist`、`/permission [id]` | 原生权限 | Agent |
| `/presets`、`/preset [id]` | 支持时使用 Agent Preset | Agent |
| `/workspace [path]` | 工作目录/工作区 | Agent |
| `/stop`、`/steer <text>`、`/compact` | 当前任务控制 | Agent |

**`/stop` 只中断当前任务，`/runtime stop ...` 才控制进程。** 设置命令必须返回实际成功/失败，说明生效作用域，并尽可能从原生后端读取结果确认；切换或恢复会话后重新读取，不能把统一名称当作相同底层语义或假定跨恢复持久化。

### 8.2 QQ 原生交互（重要）

- 分开实现和验收**全局自定义菜单、原生指令面板、消息内按钮**。当前调研的 SDK 菜单和面板主要用于把命令填入输入框；API 存在不等于自动执行，更不等于动态参数补全。按机器人账号、聊天场景和 QQ 客户端实测能力。
- **无参数快捷命令**（如 `/agents`、`/status`、`/sessions`、`/new`、`/stop`）优先用消息内原生按钮点击直接执行；验证指令型按钮自动发送或回调处理，不能仅保证“填入输入框”。回调 ACK 只解除平台等待，不代表业务执行成功。
- **带参数命令**（如 `/agent`、`/model`、`/reasoning`、`/permission`、`/session`、`/steer`）通过原生 `/` 指令面板发现和插入命令，再输入参数。参数定义与校验由网关负责；只有真实接口支持时才使用原生参数 schema 或动态补全，否则枚举值用按钮/分页菜单选择，文本型参数直接输入。
- 裸 `/model`、`/reasoning` 可查询当前值，带参数再修改，避免强行二选一。
- `/m` 只放常用操作，保持简短；按钮数量不足时按优先级降级，不建多层复杂菜单。

研究 QQ SDK 的 `getCustomMenu`、`updateCustomMenu`、`getCommandPanels`、`createCommandPanel`、`updateCommandPanel` 及 SDK 实际文档的按钮回调能力（具体名称及参数以当前版本为准）。自动同步规则：

1. 根据 Command Registry 生成所需的快捷入口和面板。
2. 读取 QQ 已有配置，尽量增量/幂等同步。
3. 不覆盖机器人上无关的手工配置；全局菜单等整体替换式更新必须先读取、合并并保留无关项；只管理明确归属本网关的面板和条目。
4. 限制、权限、功能不可用时提供 `/m` 或文字命令降级。
5. 同步失败不得使 Gateway 停止正常收发。
6. Agent 切换后更新命令执行目标和网关生成的枚举选择，**不必频繁重新注册静态命令**。

所有操作按钮绑定真实操作者、端点和操作目标；审批另绑定原生请求、Agent、Session/Turn。使用令牌和有效期时保持实现简单，不能让旧菜单按“当前选择”作用到另一任务。

### 8.3 微信等平台

Command Registry 独立于 IM。QQ 支持的原生命令不一定能在微信复用 UI，微信按已授权的 iLink/公众号接口进行文本或可用交互降级。微信 iLink 可能有资格/灰度条件，真实不可用时保留适配能力但不伪称上线。

---

## 九、会话路由、消息和状态

绑定关系建议：

```text
IM 平台 → Bot 实例 → 用户/群聊/话题 → 当前 Agent 实例 → 对应原生 Session
```

- Codex 与 DSH 各自持久保存绑定，切换 `/agent` 不删除会话和历史。
- 不同用户/聊天默认隔离；QQ 与微信的身份不可仅凭昵称合并。
- 网关重启后恢复有效绑定，重新核验 Agent 会话；不复制/维护 Agent 全部原生聊天历史。
- 对活动任务、等待审批、同会话并发写入、不同 IM 同时访问同一 Session，采用清晰且简单的所有权和冲突处理，不默认抢锁。
- 消息支持文本、Markdown、长消息拆分、必要的流式/阶段性状态、文件/图片（按平台能力）、最终回复、错误通知、审批。
- 对平台重复推送、断线重试有明确的消息 ID/操作 ID 去重规则；不能因回复超时直接重复提交可能有副作用的 Agent 任务。
- 区分尚未提交、原生已接受和结果未知。断线、超时或进程退出不能被当成未执行的证据；恢复时先核验原生状态，不盲目重放。
- 文件/图片通过可信工具或原生接口显式登记并绑定 Agent、Session/Turn，或由授权用户明确请求。助手文本中的路径、Markdown 链接和工作区扫描结果不能自动触发本地文件外发。
- 保存必要状态即可：Agent 注册、选择、会话绑定、命令面板管理标记、少量消息交付状态。SQLite 或配置文件按真实需要择一，不引入额外重型服务。

---

## 十、安全与权限边界

需要保留实际必需的安全机制，而不是以“不过度防御”为由取消边界校验：

- QQ/微信白名单、管理员或操作权限；默认不得向任何陌生用户开放本机 Coding Agent。
- 网关操作权限与 Codex/DSH 原生 Sandbox / Permission / Approval 必须分离。
- Agent 启动命令来自受信任配置，不能通过聊天传入任意 Shell 命令。
- 本机 IPC 默认回环或受控 Pipe，必要身份认证；Token/Secret 不输出日志、不提交仓库。
- 审批严格绑定原生请求 ID、Session/Turn 和 Agent，超时/重复/旧按钮不能作用于其他请求，绝不默认自动批准。原生请求已解决或失效时撤销交互，不将另一客户端已回答的请求重新批准。
- 文件发送检查来源、目标用户和路径授权，限制大小并保护凭据等敏感文件；用户明确请求文件也必须通过授权边界，不能直接提供任意本机路径读取入口。
- 真正的高风险权限变更使用原生 API，读取实际状态确认；不能只更改网关显示。
- 对外输入做必要验证；对已验证的内部固定结构**不要反复防御式检查**。

---

## 十一、测试策略：真实 E2E 优先，单元测试按需

**这里的要求不是禁止单元测试，而是改变测试资源分配。** AI 自己写实现、Mock 和单元测试，可能会让相同错误假设互相验证，得到没有实际价值的绿灯。此项目核心风险发生在真实 API、QQ 交互、进程、会话及权限的交界处。

优先验证这些真实端到端链路：

1. QQ 用户 → QQ 官方服务 → Gateway → QQ 回复（不启动 Agent、不调用模型）。
2. QQ → Gateway → Codex App Server → 真实 Codex Turn → QQ 结果（DSH 未启动）。
3. QQ → Gateway → DSH 原生后端 → QQ 结果（Codex 未启动）；分别标记 ACP 与按需 Companion 的实际验证范围。
4. QQ 菜单/面板填入、消息内无参按钮直接执行、带参命令输入/选项交互。
5. 模型、思考强度、权限真实修改后，重新读取原生状态确认生效。
6. 两种 Agent 的会话切换、恢复、历史隔离、Stop 和审批。
7. 一个 Agent 崩溃/不存在时，另一个 Agent 和 IM 网关独立工作。
8. QQ 断开重连、网关重启、消息重复、待审批失效、权限拒绝、未知提交结果不重放和文件授权。
9. 多台 Windows 电脑使用同一程序、不同配置部署。
10. 微信实际具备接入资格时进行真实链路验证。

可用 Mock 或局部集成测试帮助开发，但必须标记测试层级，**Mock 通过不等于真实 E2E 通过**。单元测试只在对命令解析、复杂状态转换、权限边界、幂等性或具体回归 Bug 有明确收益时编写，不追求数量与覆盖率。不为测试本身引入大规模接口模拟框架。

测试尽可能形成短脚本或可复现的操作记录；需要真实 QQ 按钮、扫码和用户授权的环节可以手工验收。当前缺乏账号或凭据时，不要伪造通过结果，记录阻碍条件，继续推进能真实验证的功能。

---

## 十二、分阶段交付：先完成小而完整的成果

**不要先构建一堆模块、接口、模拟器和测试，然后迟迟没有能在 QQ 使用的功能。** 以纵向切片组织开发。每阶段应有实际运行结果，而非只有文档。

### Phase 0 — 核查与最小 PoC

- 检查本机安装的 Codex、DSH、Node/Python 环境和当前工作目录。
- 利用已有调研，核验候选和 SDK 的**当前源码、许可证与实际 API**；重点核查 QQ 原生交互、Codex App Server、DSH ACP 及 Desktop Host 能力差距。
- 先淘汰与硬约束冲突的路线：列会话不得改写原生记录，审批不得默认接受，一个 Agent 未安装或初始化失败不能使网关退出，基本功能不得依赖 Desktop 私有 IPC。
- 比较现成桥接器适配与薄网关自建的真实改造成本；QQ SDK 与 Zhin 通过最小真实交互比较后选用，不预设框架。把关键依据和未决限制记入简短选型记录，链接已有研究，不重复编写大报告。
- 完成安装版本协议探测与最小技术验证；无真实账号时继续完成可验证项目，但不得把 schema 存在、初始化成功或 Mock 通过写成真实 E2E。

### Phase 1 — QQ Gateway 最小闭环

- 无 DSH/Codex 依赖即可运行网关、连接 QQ Bot。
- 实现固定命令 `/help`、`/status`、`/agents`，显示已配置实例及真实可用性；模拟数据仅用于明确标记的开发演示。
- 实现 Command Registry、QQ 原生命令注册、至少一个无参点击操作和一个带参操作/降级方式。
- 真实 QQ 消息收发验证通过。

### Phase 2 — Runtime Manager + Codex 闭环

- 在 Windows 找到并启动预配置的 Codex App Server，明确进程所有权。
- 通过 QQ 选择 Codex、创建或恢复原生会话、发送任务、拿到结果。
- 能查询并实际调整受支持的模型/推理/权限设置；具备停止与审批处理能力。
- **不启动 DSH，整个 Codex 路径仍正常。**

### Phase 3 — DSH 原生接入闭环

- 验证并接通 DSH ACP；依据 Desktop Host 能力差距，按需实现最小 Companion、IPC、Session 与控制接口。
- QQ 可以选择 DSH、运行任务、收取结果、查询/调整模型/权限，并处理原生审批。
- 分别记录 ACP 独立会话与 Desktop Host 的能力和限制，保留需要的原生会话体验，不将不支持项伪装成成功。
- **不启动 Codex，整个 DSH 路径仍正常。**

### Phase 4 — 双 Agent 切换与持久化

- `/agent` 切换后各自原生 Session 保留，回到原 Agent 可继续。
- 并发/审批/任务取消有清晰的作用域。
- 网关重启恢复绑定；其中一个 Agent 断线不连带另一个。

### Phase 5 — 多 IM、维护和分发

- 根据账号条件增加微信等平台，复用同一 Agent/Command Core。
- 完成 Windows 安装、配置、可逆卸载、启动和必要的诊断文档。
- 实测同一版本软件在多台 Windows 电脑独立部署。

如某个非核心功能受 QQ 或 DSH/Codex 当前 API 限制，记录并使用诚实的降级方案，不应阻塞其他可完整交付的功能。

---

## 十三、代码组织建议（以实际简洁性为准）

```text
im-agent-gateway/
├── src/
│   ├── core/                # 路由、命令、会话和进程管理
│   ├── agents/
│   │   ├── codex/           # Codex App Server Adapter
│   │   └── dsh/             # ACP Adapter / 按需 Companion Client
│   ├── im/                  # QQ / 微信 Adapter 与 UI 同步
│   ├── security/            # 仅必要的身份与边界校验
│   └── main.*
├── companion/dsh/          # 仅需要 Desktop Host 补充能力时创建
├── docs/
│   ├── README.md            # 文档导航
│   ├── architecture.md
│   └── compatibility.md    # 接口版本、验证范围与当前限制
├── examples/                # 配置示例
└── README.md
```

目录只是职责示意。**不要求生成空目录或为了抽象而拆几十个文件。** 能用更简单结构达到同样边界时，优先简单结构。选型、命令、协议文档在内容确需独立维护时再拆分，并更新导航，避免同一事实重复记录。

---

## 十四、长期可维护性与文档一致性

- 依赖版本锁定到真实验证过的版本；尽量使用公开 API，不 Fork 大型框架。
- Codex 和 DSH Adapter 相互独立升级。记录经过验证的协议版本和真实限制。
- 多台电脑共用同一套程序，配置和密钥分离，不为各台电脑维护独立分支。
- `README.md` 说明安装、配置、QQ 机器人绑定、启动、基本命令和升级/常见故障。
- `docs/README.md` 作为文档入口，链接现有核心文档并简述目录职责；新增、移动或删除文档时同步导航。
- `docs/architecture.md` 只描述**实际实现**的职责、边界、数据流和契约，不能把本任务书中的方案写成已实现。`docs/compatibility.md` 记录协议版本、验证范围和当前限制；选型或决策记录明确标记提案、已采用及被替代状态。
- 每个概念只保留一个权威文档位置，通过链接导航，不复制实现细节或按时间堆完成记录。只有架构、契约、理由或导航发生变化时才更新项目文档；实现与文档分开负责和审阅。
- 改动接口、命令、配置、权限或生命周期时，检查代码—文档、文档—文档一致性。尽量由命令注册表派生 `/help` 和平台菜单；发现不一致时明确提醒并修复，不要求所有文档自动生成或复杂系统。
- 功能状态明确标记：**真实 E2E 通过 / 真实接口通过 / 仅模拟验证 / 尚未验证 / 暂不支持**；不得虚构效果。

---

## 十五、最终验收清单

- [ ] 网关不启动 DSH/Codex 仍可连接 QQ，管理命令无需大模型。
- [ ] QQ 原生无参数操作可点击直接触发；带参数命令可以通过指令入口输入或可靠降级。
- [ ] QQ 命令面板多次同步不重复、不误覆盖无关设置。
- [ ] 能管理本机预注册 Agent 的启动/停止/状态，不误杀手动启动的桌面进程。
- [ ] QQ → Codex → QQ 完整真实任务闭环，DSH 无需运行。
- [ ] QQ → DSH → QQ 完整真实任务闭环，Codex 无需运行。
- [ ] 两种 Agent 的模型、推理强度、权限等修改以原生 API 实际可用能力为准，能验证生效。
- [ ] 能列出和恢复原生会话；切换 Agent 不串会话，不删除历史。
- [ ] 会话列表与历史读取不改写原生记录；已验证的共享/恢复范围与其他后端持有的活动会话明确区分。
- [ ] Stop、活动任务、审批、过期请求有正确作用域。
- [ ] 非授权 IM 用户不能执行管理操作，秘钥和 IPC 受保护。
- [ ] 其中一个 Agent 故障不影响 IM 网关及另一 Agent。
- [ ] 网关重启可恢复有效配置和会话绑定，对结果未知的任务不盲目重试。
- [ ] 文件/图片有明确来源和授权，不因助手输出本地路径而自动外发；旧按钮和已解决审批不能作用到其他任务。
- [ ] 可在多台 Windows 电脑用同一软件、不同配置分别部署 QQ Bot。
- [ ] 微信等其他 IM 通过平台 Adapter 与同一 Agent Core 对接（账号准入允许时进行真实 E2E）。
- [ ] README、配置示例、协议兼容性、实际测试结果与现有实现一致。
- [ ] 架构整体简洁；没有为假设风险增添过度防御、重复校验和过多抽象。

---

## 十六、交给编码 Agent 的直接执行要求

这是**开发委托，不是讨论题**。请直接执行：

1. 检查工作区和已安装的软件版本；按最短路径核实上述关键参考源码及许可证。
2. 基于真实 API 选最轻量、最可维护的网关底座，先给出简要技术决策并记录重要限制。
3. 立即制作 **QQ 真实命令闭环的最小可运行结果**，优先从终端启动并实测，而不是先设计完整框架。
4. 接通 Codex App Server 完整工作流，再验证并接通 DSH ACP，按 Desktop Host 能力差距补 Companion；不要让任何一个 Agent 成为另一个的必选依赖。
5. 在每个阶段优先 E2E/真实接口验证，按需写少量单元测试；发现问题直接修复并复验。
6. 维护安装文档、兼容性、进度和代码/文档一致性。未能真实验证的部分如实列出。
7. 遇到平台限制优先给出简单降级方案并继续完成可交付功能，不应长时间空转于架构讨论。

**再次强调**：这是中间件，不是 Agent 平台。内部上下游契约已经固定的地方不做无意义重复校验和宽泛兜底；该报错时明确报错。只在外部输入、认证、进程权限、审批和网络等真实边界做必要防护。**先做一个功能可用且完整的小结果，之后再扩展。保持简洁、透明、可观察、可维护。**
