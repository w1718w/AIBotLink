# IM Agent Gateway 本机验证与选型判断

日期：2026-10-30（北京时间）。关联：[任务书](task-book.md)、[开源调研](research-2026-10-30.md)。本报告只记录本轮实际验证范围及据此形成的选型建议，不代表已实现网关。

## 当前判断

**建议以薄 TypeScript 网关作为后续实施方向，不将 cc-connect Fork 作为默认起点。** QQ 侧使用直接 SDK 还是 Zhin IM 核心，仍需真实机器人验证后决定。DSH 优先接 ACP，Desktop Host 的差异能力再由薄 Companion 补齐。

判断依据：本机 Codex App Server 与 DSH ACP 的基础控制接口均可直接运行；而 cc-connect 至少需要修改启动失败隔离和 Codex 私有历史改写两个核心行为。它仍是有价值的命令、IM 和 Agent Adapter 参考，不等于可以无改造替代本项目。

这不是运行验收结论。QQ 收发、原生按钮/面板、真实模型任务、审批和桌面活动会话控制尚未验证。

## 环境与隔离

| 项目 | 本次实际结果 |
|---|---|
| Windows | Codex 握手报告 Windows 10.0.26200 x86_64 |
| Codex CLI | 0.153.2，来自本机 Codex Desktop 安装 |
| DSH | 0.2.1-rc.2，来自本机 DeepSeek Harness 安装 |
| Node | v25.4.0 |
| Go | 本次 PATH 未发现；未构建或运行 cc-connect |
| 工作区 | AIBotLink 目录只有 .git，未开始产品实现 |

探测程序分别使用工作区 `.research/codex-home` 和 `.research/dsh-home` 作为原生配置与会话目录，并移除继承环境中名称包含 TOKEN、SECRET、API_KEY、PASSWORD 的变量。没有读取或复制用户的登录凭据、真实历史或 QQ 配置。DSH 初始化会在隔离目录生成 ACP profile；Codex 只创建 ephemeral、read-only 线程。

没有调用 `turn/start` 或 `session/prompt`，因此本轮没有启动模型推理。模型目录返回不能证明账号对这些模型有使用资格。

## Codex：真实原生接口通过的范围

| 检查 | 结果 | 证据含义 |
|---|---|---|
| CLI 帮助与版本 | 通过 | 本机支持 app-server、stdio、WebSocket 和 --stdio 别名 |
| 本机协议 schema 导出 | 通过 | 获得与 0.153.2 对应的 JSON Schema |
| initialize / initialized | 通过 | 能连接本机原生 stdio App Server |
| model/list | 通过 | 返回模型及各自 reasoning effort 元数据；只取前两项 |
| thread/list | 通过 | 隔离目录返回空列表，未访问用户会话 |
| thread/start | 通过 | 创建 ephemeral 线程；原生返回 readOnly、networkAccess=false、on-request |

导出的 schema 具有 `ThreadTurnsListParams`、`ThreadItemsListParams`、`PermissionProfileListParams`。`TurnSteerParams` 要求 `expectedTurnId`、`input`、`threadId`。这证明安装版本具有相关协议结构，不等于本次运行了分页历史、Steer 或权限变更。

HAPI 的共享会话文档声明需要 Codex >=0.154.0，而本机是 0.153.2。因此不能把 HAPI 当前共享方案直接认定为本机可用，也没有为了探测擅自升级本机软件。

前一轮对 AgentBridge `--stdio` 参数的疑问，在本机已由 CLI 帮助澄清：本机支持。跨版本仍需核验，但该参数本身不是本机淘汰理由。

## DSH：ACP 已通过基础控制验证

使用本机 DSH CLI 的实际启动方式，在独立 DSH_HOME 中启动 `--profile acp`。

| 检查 | 结果 | 证据含义 |
|---|---|---|
| shipped ACP profile | 通过 | dump-default-config 包含 dsh-acp-app 与 dsh-acp |
| initialize | 通过 | 协议版本 1，agentInfo 为 deepseek-harness-acp |
| session/new | 通过 | 原生创建隔离会话，返回模型与推理选项 |
| session/set_config_option | 通过 | reasoning_effort 从 high 改成 low，返回值确认 low |
| 对活动会话再次 resume | 按预期拒绝 | 原生返回 -32602 / session is already active |
| session/close | 通过 | 原生接受关闭会话 |
| close 后 session/resume | 通过 | 能恢复刚关闭的空白会话 |
| session/list | 通过 | 能查询隔离目录中的会话 |

握手声明的 `sessionCapabilities` 包含 close、list、resume。`promptCapabilities` 的 image、audio、embeddedContext 全为 false。新会话提供 `configOptions`，包含 model 和 reasoning_effort；本轮未得到权限 modes 目录，不能据此承诺 ACP 提供完整 Host 权限控制。

**设置作用域存在重要限制**：同一空白会话在设置 low 后，close 再 resume 返回 high。本轮只确认当前运行会话接受设置，没有确认其跨恢复持久化，也没有通过实际模型任务验证推理档位。网关必须区分“已设置当前会话”“恢复后仍生效”和“模型实际采用”，不能只修改显示值。

本轮 session/list 在活动空白会话存在时，列出了此前探测会话而未列出当前新建会话；因此不能把列表当作所有活动会话的唯一事实来源。活动执行状态需要结合已知会话和原生事件维护，空白会话持久化时机仍待验证。

早期超时已定位为探测脚本遗漏 ACP 要求的 `jsonrpc: "2.0"`，修正后普通受限执行环境中约两秒内完成整套探测。不能把早期超时归咎于 DSH 或系统权限。Codex 的线协议与 ACP 不同，不应强行使用完全相同的消息封装。

## cc-connect：进一步确认的改造成本

使用固定提交 `7f671b15ed02250d4e356b46a760a7a5ce86c427` 的源码，而非本机运行结果：

1. `main.go` 在创建每个配置 Agent 时，一旦 `core.CreateAgent()` 返回错误就执行 `os.Exit(1)`。结合 Codex Adapter 在初始化时查找可执行文件，**配置中缺失一个 Agent 会阻断程序启动**的控制路径已经确认，不再只是风险推测。[启动源码](https://github.com/chenhg5/cc-connect/blob/7f671b15ed02250d4e356b46a760a7a5ce86c427/cmd/cc-connect/main.go#L374)
2. Codex 列会话会调用改写原生 JSONL 来源字段的函数，仍与任务书不修改私有会话文件的硬约束冲突。[实现](https://github.com/chenhg5/cc-connect/blob/7f671b15ed02250d4e356b46a760a7a5ce86c427/agent/codex/list.go)
3. App Server 实现当前会启动自己的进程并通过 stdio 读写；`app_server_url` 会被用于传入监听参数，不能凭配置名称认定它实现了 Attach First 到现有 WebSocket 后端。[连接实现](https://github.com/chenhg5/cc-connect/blob/7f671b15ed02250d4e356b46a760a7a5ce86c427/agent/codex/appserver_session.go)
4. 通用 ACP Adapter 是可借鉴入口，但未使用 cc-connect 本体验证其与本机 DSH 的组合。DSH 原生 ACP 探测成功不能替代这一步。

为满足本项目，需要触及启动编排、会话/历史访问、连接与进程所有权，并补充原生 QQ 命令面板及可能的 DSH Host 差异。是否复用部分代码，还需先补核其 README 声明 MIT 但当前树缺独立 LICENSE 的许可材料。

## 后续实现边界

当前建议的组件关系是实施提案：

```text
QQ SDK 或 Zhin IM 核心（待真实账号选择）
                 │
薄网关：身份、确定性命令、绑定、交付、进程所有权
                 ├── Codex App Server Adapter
                 └── DSH ACP Adapter
                       └── 按实际差距增加 Desktop Host Companion
```

先验证 QQ 的真实命令闭环，再接已有原生协议。不要先重写多 Agent 运行平台，也不要为了接入 DSH ACP 放弃用户要求的 Desktop Host 会话能力。

待验收：QQ 官方服务收发、菜单/面板与按钮行为、真实模型 Turn、审批/提问、跨进程恢复、用户真实历史、附件、Steer/Interrupt、桌面会话所有权、进程崩溃隔离以及两台机器部署。

## 可复现材料

- [原生接口探测程序](probe-native.mjs)：Node 标准库，不安装额外包；只做元数据与隔离会话控制。
- [最后一轮原始结果](native-probe-results.json)：记录每项接口结果；测试会话 ID 仅属于隔离目录。
- 历史工作区的 `.research/codex-schema/`：本机 Codex 导出的版本对应 schema，属于研究产物，未随仓库保留。

在工作区根目录运行：

```powershell
$env:BOTLINK_DSH_INSTALL = '%USERPROFILE%/AppData/Local/Programs/DeepSeek Harness'
node probe-native.mjs
```

路径按实际安装位置调整。每次运行会创建新的隔离测试会话；脚本结束时关闭它自己启动的进程，不操控已运行的桌面实例。
