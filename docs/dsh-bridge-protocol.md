# DSH Host 桥接接口

AIBotLink 网关通过本机回环接口接入运行中的 DeepSeek Harness Host。本文定义网关消费的接口契约：桥接端写入连接记录，网关读取记录后以认证 HTTP RPC 和一条事件流连接访问桥接端。网关不包含桥接端实现，也不假设其语言、框架、进程模型或安装方式；任何满足本页语义的实现都应可用。

接口主体分为连接记录、传输与认证、RPC 方法、事件流与交互；错误处理、版本边界和最小实现要求见后文。实现依据见文末[代码依据](#代码依据)。

## 连接记录

桥接端启动后写入一个 JSON 文件，网关配置 `agents.<id>.dshBridge` 指向该文件。记录字段：

| 字段 | 约束 |
|---|---|
| `version` | 固定为数字 `1`；其他值按无效配置拒绝 |
| `url` | 必须是 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>`；显式端口，路径为 `/`，不得含用户名、密码、查询串或片段，首尾不得有空白 |
| `token` | 至少 32 个十六进制字符的字符串（大小写不敏感）；作为 Bearer 凭据使用 |

连接记录的位置由桥接端与网关共同约定。Windows 默认数据目录为 `%LOCALAPPDATA%\AIBotLink`，记录默认为其中的 `dsh-bridge.json`；其他系统默认数据目录为 `~/.local/state/aibotlink`。可用 `BOTLINK_HOME` 覆盖数据目录，桥接端与网关必须指向同一记录。

网关对 `dshBridge` 的要求：

- 必须是绝对路径，且位于 Git 仓库之外；网关同时校验记录文件解析后的真实路径，避免用链接绕过仓库边界。
- 记录缺失、格式错误或字段不合规时按“DSH 桌面桥接配置无效”拒绝，不打印 Token 或记录内容。

Token 由桥接端生成并保存，生命周期由桥接端决定。网关每次建立连接时读取记录；桥接端重启并更换端口或 Token 后应重写记录，网关下一次连接会读取新值。网关不缓存旧 Token 跨重连使用。记录包含明文凭据，应限制为当前用户可读写（建议文件权限 `0600`、目录 `0700`），不得提交 Git、复制到日志或共享。桥接端正常退出时可删除仍属于自己的记录，避免留下失效凭据。

## 传输与认证

桥接端只监听回环地址，提供三个 HTTP 端点：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/events` | 事件流（SSE）；网关先建立此连接，之后才调用 RPC |
| POST | `/rpc` | 请求/响应 RPC |
| POST | `/respond` | 回答事件流中的请求事件（审批、提问） |

每次请求都携带：

| 请求头 | 值 |
|---|---|
| `Authorization` | `Bearer <token>` |
| `X-AIBotLink-Connection` | 网关为该客户端随机生成的 UUID；所有请求（含 `/events`）保持一致 |
| `Content-Type` | POST 请求为 `application/json` |

网关侧传输策略：

- 只接受连接记录中的回环 URL；所有请求禁止重定向。
- 建立事件流有 30 秒超时；响应必须成功且 `Content-Type` 为 `text/event-stream`，否则连接失败。
- 连接失败、请求超时或事件流断开都按失败处理，不自动重试。模型任务提交超时后按未知结果处理，由用户核验。
- 网关不发送浏览器 `Origin` 头；桥接端必须拒绝携带 `Origin` 的请求。

桥接端侧边界：

- 校验 Token 与连接标识；认证失败返回 401。缺少或格式错误的连接标识返回 400。
- `/events` 只允许一个活动订阅；已有订阅时返回 409。`/rpc` 与 `/respond` 必须来自当前已订阅的连接标识，否则返回 409。
- HTTP 方法或路径不匹配返回 404；请求体超过 1 MB 返回 413；JSON 无法解析返回 400。
- 事件流应发送注释心跳（例如每 15 秒一次），并限制未发送缓冲；未分帧事件超过 4 MB 时网关按连接失败处理。
- 连接关闭表示本次连接结束。桥接端可以继续原生任务，但不得再向已关闭的连接发送事件；网关会把未完成的提交标为未知结果。

### 请求与响应格式

`POST /rpc` 请求体：

```json
{ "id": 1, "method": "session/new", "params": { "cwd": "C:\\work\\project" } }
```

`id` 可选，网关发起的调用会携带递增数字并在响应中校验其一致性。桥接端必须原样返回 `id`。响应 HTTP 状态为 200，正文为以下之一：

```json
{ "id": 1, "result": { } }
```

```json
{ "id": 1, "error": { "code": -32601, "message": "不支持的方法", "data": { } } }
```

`data` 可选，用于附加原生诊断，网关不依赖其结构。只有同时缺少 `result` 且没有 `error` 的响应才视为协议失败。

`POST /respond` 请求体为 `{ "id": <请求事件 id>, "result": ... }` 或 `{ "id": <请求事件 id>, "error": { "code": -32601, "message": "..." } }`。`id` 必须对应仍待处理的事件请求；已消费、已过期或不属于当前连接的响应应返回错误对象，不得静默接受。

### 事件流格式

事件流使用 Server-Sent Events。每个事件为一个 JSON 对象：

```text
data: {"method":"session/update","params":{"sessionId":"...","update":{...}}}

```

解析规则：

- 以空行分隔事件；只读取 `data:` 行，注释行（以 `:` 开头）忽略。
- `method` 必须为非空字符串，`params` 必须为对象。
- 带 `id` 的事件是请求，接收方必须通过 `/respond` 回答；不带 `id` 的是通知。
- 未知通知可忽略；未知请求必须明确拒绝，不能默认允许。

## RPC 方法

以下方法是网关会调用的方法。参数均为对象；未列出的方法不应被网关调用。桥接端对不支持的方法或能力必须返回 `-32601`，对参数错误、状态冲突或资源不存在返回 `-32602`，内部错误返回 `-32603`；不得用空结果伪装成功。

| 方法 | 参数 | 结果与语义 |
|---|---|---|
| `initialize` | `protocolVersion: 1`、`clientInfo`、`clientCapabilities` | 返回 `protocolVersion: 1` 与 `agentCapabilities`。`agentCapabilities.sessionCapabilities.list` 为真时网关才提供会话列表；`resume`、`fork` 表示对应能力；`aibotlinkHost: true` 标识 Host 桥接。未知能力字段被忽略 |
| `session/new` | `cwd`（绝对路径） | 创建原生会话，返回会话选项对象（含 `sessionId`） |
| `session/resume` | `sessionId`、可选 `cwd` | 恢复/读取会话，返回会话选项对象；网关在读设置时会重复调用，应幂等，不重复创建会话 |
| `session/list` | 可选 `cwd`、`cursor` | 返回 `{ sessions: [{ sessionId, title? }], nextCursor? }`；网关映射为会话列表，`cursor` 可选 |
| `session/history` | `sessionId` | 返回 `{ text }`，为原生最近快照中的文本历史；不要求完整历史翻页 |
| `session/fork` | `sessionId` | 分支原生会话，返回子会话的会话选项对象；源会话不删除 |
| `session/set_config_option` | `sessionId`、`configId`（`model` 或 `reasoning`）、`value` | 选择原生模型或推理档位，返回更新后的会话选项对象。模型值为目录中对应选项的 `value`；推理值为目录中的档位值 |
| `session/permissions` | `sessionId` | 返回 `{ currentValue, options: [{ value, name }] }`，来自原生权限目录 |
| `session/set_permission` | `sessionId`、`mode` | 执行原生权限选择，返回 `{ session, currentValue, options }`；`mode` 必须属于权限目录 |
| `session/compact` | `sessionId` | 请求原生压缩；不支持时返回 `-32601` |
| `session/cancel` | `sessionId` | 中断该会话当前由网关提交的任务；没有活动任务时返回错误 |
| `session/steer` | `sessionId`、`text` | 向当前活动任务补充指令；没有活动任务或空文本时返回错误 |
| `session/prompt` | `sessionId`、`prompt: [{ type: "text", text }]` | 提交文本任务。响应在任务结束后返回 `{ stopReason, text? }`；`stopReason` 为 `end_turn` 或 `cancelled`。任务期间通过事件流发送进度与最终文本 |

### 会话选项对象

`session/new`、`session/resume`、`session/fork`、`session/set_config_option` 返回同一结构：

```json
{
  "sessionId": "native-session-id",
  "model": "model-id",
  "modelProvider": "provider-id",
  "reasoningEffort": "high",
  "configOptions": [
    {
      "id": "model",
      "name": "模型",
      "type": "select",
      "category": "model",
      "currentValue": "[\"provider-id\",\"model-id\"]",
      "options": [
        { "group": "provider-id", "name": "Provider", "options": [{ "value": "[\"provider-id\",\"model-id\"]", "name": "Model" }] }
      ]
    },
    {
      "id": "reasoning",
      "name": "推理",
      "type": "select",
      "category": "thought_level",
      "currentValue": "high",
      "options": [{ "value": "low", "name": "Low" }, { "value": "high", "name": "High" }]
    }
  ]
}
```

网关的读取方式：

- 模型目录取自 `category: "model"` 选项的 `options` 分组；组名作为提供方。模型值必须是 JSON 编码的 `[provider, model]` 字符串，与 `session/set_config_option` 的 `value` 保持一致。
- 推理目录取自 `category: "thought_level"` 选项；缺失时网关按“原生未暴露推理档位”处理。
- `session/set_config_option` 返回的新 `configOptions` 会替换网关缓存；桥接端应返回选择后的真实值。
- `session/resume` 可返回当前模型、提供方与推理值；网关不假设它们跨会话或跨 Host 持久化。

### 任务与超时

`session/prompt` 是长任务调用：请求可能持续到原生回合结束，网关对其不设置模型任务超时，并依赖 `/events` 推送进度。其他 RPC 的默认超时为 30 秒。提交超时、连接失败或响应丢失时，网关不能确认任务是否已进入原生 Host，会按未知结果处理并要求用户核验，不能自动重放。

## 事件流与交互

### 通知

网关消费以下通知；桥接端应保证事件归属于本次连接提交的会话与回合。

| 方法 | 参数 | 网关用途 |
|---|---|---|
| `session/update` | `{ sessionId, update }` | 任务进度、最终文本与会话选项更新 |
| `serverRequest/resolved` | `{ sessionId, requestId }` | 结束对应的审批/提问交互界面 |

`session/update` 的 `update.sessionUpdate`：

| 值 | 负载 | 语义 |
|---|---|---|
| `agent_message_chunk` | `{ content: { type: "text", text } }` | 增量文本；网关记录首字时间，不作为最终文本 |
| `agent_message_final` | `{ text }` | 本次任务的规范最终文本；网关优先采用，覆盖增量文本 |
| `tool_call` | `{ title }` | 工具调用进度；网关最多转发两次且有最小间隔 |
| `config_option_update` | `{ configOptions }` | 原生设置变化；网关更新该会话缓存的选项 |

`session/prompt` 的结果也可携带最终文本。最终事件与 RPC 结果可能以不同顺序到达，桥接端应保证两者一致；至少要有其中一种提供规范最终文本。任务失败或取消时，`session/prompt` 应返回错误或 `stopReason: "cancelled"`，不能只发送部分增量文本后静默结束。

### 请求（审批与提问）

桥接端使用以下方法发送交互请求；网关对无法映射的交互请求明确拒绝，绝不自动允许。请求事件需要 `id`，并绑定当前连接与当前任务。

| 方法 | 参数 | 网关响应 |
|---|---|---|
| `session/request_permission` | `{ sessionId, toolCall: { title, rawInput? }, options: [{ optionId, name, kind }] }` | `/approve <token> accept` 选择 `kind: "allow_once"` 的选项，`decline` 选择 `kind: "reject_once"` 的选项，回传 `{ outcome: { outcome: "selected", optionId } }`；无匹配选项时拒绝 |
| `item/tool/requestUserInput` | `{ sessionId, questions: [{ id, question, options?, multiSelect? }] }` | `/answer <token> <text>` 回传 `{ answers: { <questionId>: { answers: [string] } } }`；单问题快捷输入按文本匹配已有选项或作为自定义回答 |

交互规则：

- 网关为每次请求生成短期令牌（十五分钟）；令牌一次性使用，回答后失效。桥接端必须拒绝重复、过期或错误连接的 `/respond`。
- 网关不自动批准或默认回答。原生 Desktop 仍可回答同一请求；桥接端可让 IM 回答与原生回答竞争，但只能采用第一个有效结果，并发送 `serverRequest/resolved` 关闭界面。
- 客户端断开时，网关撤销 IM 交互路径；桥接端不应把断线视为原生任务取消，也不得把未确认的回答当作已提交。
- 网关对没有对应活动任务的请求直接拒绝；桥接端不应把 Desktop 无关的交互请求转发给网关。

### 归属、断线与未知结果

- 事件按 `sessionId` 归属到网关的任务与聊天。桥接端必须过滤与本次网关提交无关的 Desktop 回合，不能把其他会话或其他提交的文本混入当前任务。
- 网关允许同一会话串行提交；桥接端应拒绝同一会话的并发任务、分支或设置修改，并返回冲突错误。
- 事件流断开或 `/rpc` 失败后，网关清空该连接的会话缓存，并将未完成提交标为未知结果。桥接端可以继续原生任务；网关不自动取消、不重放，也不保证最终结果能补发。用户需在原生端核验后显式清除未知标记。
- 断线后网关重新连接时读取当前连接记录；旧连接上的未完成交互与任务不会恢复。

## 错误与版本边界

### HTTP 状态

| 状态 | 含义 |
|---|---|
| 401 | Token 错误，或请求携带浏览器 `Origin` |
| 400 | 连接标识缺失/格式错误，或 JSON 无法解析 |
| 404 | 路径或 HTTP 方法不支持 |
| 409 | 已有事件订阅，或请求来自非当前订阅连接 |
| 413 | 请求体超过 1 MB |
| 500 | 桥接端内部失败 |

### RPC 错误

错误对象为 `{ code, message, data? }`。`code` 使用 JSON-RPC 风格数值：`-32601` 不支持的方法/能力，`-32602` 参数或状态错误，`-32603` 内部错误。`message` 应为可读文本；网关将其展示给用户，不根据 `message` 文本做流程判断。`data` 可携带原生错误码等诊断信息，网关不解析其结构。

### 版本与兼容

- 连接记录 `version` 必须为 `1`，不符合时网关按无效配置拒绝。`initialize.protocolVersion` 当前为 `1`；网关读取响应的能力字段但不校验该版本号，桥接端应按 `1` 返回，协议升级时双方需同步契约。
- 能力通过 `initialize` 的 `agentCapabilities` 声明；网关只用 `sessionCapabilities.list` 决定是否允许会话列表，其他能力由具体命令按需调用并接受 `-32601`。缺少能力应报错，不能返回伪造数据。
- 网关不读取原生 Host 版本，也不针对某个 Host 版本做特殊分支；原生协议差异由桥接端在其内部处理。当前探测范围仅为 DSH Host 0.2.1-rc.2 上的桥接实现；其他 Host 版本、其他桥接实现和其他操作系统均未完成验收。
- 网关对 DSH ACP stdio 的 `COMPAT` 兼容规则只适用于该传输路径，不适用于本接口；桥接端不能依赖网关的 ACP 兼容分支。

## 最小实现要求

满足以下条件的桥接端即可被网关消费：

1. 生成并维护连接记录：`version: 1`、回环 URL、随机 Token；记录位于 Git 仓库外，权限受限，端口或 Token 变化时重写。
2. 只监听回环地址，提供 `/events`、`/rpc`、`/respond`；校验 Bearer Token 与连接标识，拒绝浏览器 `Origin`，限制单订阅与请求体大小，发送心跳。
3. 实现 `initialize`，返回协议版本与 `sessionCapabilities.list`；按需声明 `resume`、`fork`。
4. 至少实现 `session/new`、`session/resume`、`session/prompt`；需要会话列表、停止、分支、模型/推理、权限、历史、压缩或 Steer 命令时实现对应方法，无法支持的返回 `-32601`。
5. 为每个任务提供规范最终文本：`session/update` 的 `agent_message_final` 和/或 `session/prompt` 结果；事件必须归属正确会话，不混入无关 Desktop 回合。
6. 若支持审批或提问，发送带 `id` 的请求事件，仅在待处理期间接受 `/respond`，并发送 `serverRequest/resolved`；不得默认允许或伪造回答。
7. 断线时停止向旧连接发送事件；原生任务可继续，但网关会把未确认结果视为未知，不依赖自动补发。
8. 不监听非回环地址，不向浏览器暴露接口，不记录或回传 Token。

网关本地测试使用假 Host 与回环传输，验证的是网关侧的契约消费；桥接端实现、真实原生 Host 与其他系统需分别验收，不能把接口连通或本地测试写成完整任务 E2E 通过。

## 代码依据

- 连接记录校验、认证头、SSE 与 RPC 传输：[host-rpc.ts](../src/host-rpc.ts)
- DSH Host 分支的 RPC 方法调用与事件消费：[agent.ts](../src/agent.ts)
- `dshBridge` 配置校验与仓库外约束：[config.ts](../src/config.ts)
- 审批/提问的网关侧映射：[gateway.ts](../src/gateway.ts)
