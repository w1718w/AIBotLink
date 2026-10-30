# AIBotLink

运行在本机的 QQ → Codex / DeepSeek Harness 控制网关。管理命令由程序解析，普通文本任务交给所选 Agent 的原生后端；网关不代理模型 API。

当前是早期可运行实现：QQ → Codex → QQ 固定文本、无工具闭环，以及 DSH Host 元数据接口已有真实验证；DSH 模型任务完整终态、新版菜单、分支、停止和审批仍待验收。具体范围见 [兼容性与验证](docs/compatibility.md)，组件边界见 [文档入口](docs/README.md)。

## 环境与启动

需要 Node.js >=22.19、npm，以及本机已安装并完成原生登录的 Codex、DSH。QQ 使用官方机器人 App ID、Secret 和用户 OpenID 白名单。

### 构建网关

在网关仓库执行：

```powershell
npm ci
npm run build
```

本机配置及状态必须放在 Git 仓库外。Windows 默认目录为 `%USERPROFILE%\AppData\Local\AIBotLink`；可用 `BOTLINK_HOME` 指定其他仓库外目录。不要将配置、状态、凭据、原生会话或本地验证输出加入 Git。

已有 dsh-im 且只有一个 QQ 机器人时，可导入本机配置：

```powershell
npm start -- import-dsh "$env:USERPROFILE\.dsh" "C:\path\to\your-project"
```

导入会拒绝覆盖已有配置，引用 DSH `.credentials.yaml` 的密钥条目，不复制 Secret。生成的启动路径针对 Windows 标准安装位置；运行前检查仓库外 `config.json` 中的 Agent 路径、工作目录、HOME 和白名单。DSH 凭据文件移动或引用改变后，需同步修改本机配置。

### DSH Host 桥接

需要复用现有 DSH Host 会话时，把配置中的 `agents.<id>.dshBridge` 指向符合 [DSH Host 桥接接口](docs/dsh-bridge-protocol.md) 的连接记录。网关只依赖该接口，不依赖具体桥接实现；桥接端的安装、连接记录生成与 Host 重启由桥接端自身负责。

连接记录包含回环地址与随机 Token，默认位于 `%LOCALAPPDATA%\AIBotLink\dsh-bridge.json`；不要复制、提交或共享该文件。自定义数据目录时，桥接端与网关必须使用同一记录。桥接模式连接已运行的 Host，网关不另起 ACP 进程，也不启停 Desktop。

网关仓库另提供可选的便捷脚本 `npm run install:dsh`，用于把已安装的桥接端注册到 DSH Profile 并更新网关的 `dshBridge` 配置；它依赖 Windows 标准 DSH 安装位置及已有 Profile，不是通用安装器，也不属于桥接接口的一部分。安装成功、接口连通和模型任务完成是不同验证层级，安装或握手通过不代表任务 E2E 通过。

### 检查与启动

```powershell
npm start -- doctor
npm start -- console
```

`doctor` 按配置启动 stdio 后端或连接 DSH Host 桥，完成握手后关闭自己的后端/连接；不发送模型任务、不启停桥接的 Desktop，也不读写网关运行状态。`console` 提供本地管理终端，使用配置中的首个授权用户；它不是 QQ 验收。QQ 模式与 `console` 对同一本机数据目录互斥，不能同时运行。

连接真实 QQ 前，同一机器人 App ID 只保留一个消息接收端：停用旧 dsh-im QQ 连接或其他旧桥接实例，避免重复回复；无需停止整个 DSH。机器人显示名称不能代表实际 Agent 后端，以 `/status` 和配置中的 Agent ID 为准。随后执行：

```powershell
npm start
```

Agent 后端或桥接连接按需启动。可先在 QQ 输入 `/help`、`/status`、`/agents`。用 Ctrl+C 退出网关；它关闭自己的 QQ 连接、自建后端和桥接客户端，不停止桥接的 DSH Desktop。

需要回到桌面继续同一 Codex 会话时，先结束任务，再用 `/release` 或完整发送“交接”停止当前 Agent 的网关自有后端，让出其已加载会话。“交接”是默认精确别名，去除首尾空白后必须整条匹配，不经模型解析；“交接给谁”等较长文本仍按普通任务处理。它会影响该 Agent 实例下所有聊天，不只是当前聊天；有活动任务、待审批或未知提交时拒绝释放。已有历史、可恢复绑定和后续 Turn 请求设置保留；本进程已知从未提交输入、未落盘的 Codex 空白绑定会被清除，下次创建新会话。

释放后普通文本或需要原生接口的命令会按需重启并恢复绑定；若 Desktop 已持有会话，仍须服从原生冲突检查，不会抢锁。当前只验证了空闲后端释放/重启，QQ 点击释放后由 Desktop 接管的完整流程尚未验收。

DSH 桥接模式的 `/release` 只断开网关客户端，不停止 DSH Host、不保证 Host 卸载会话。桥接断开不会自动取消原生任务；其未确认结果仍需在原生端核验。

恢复会话时若提示桌面或其他 Codex 客户端占用，本次 QQ 任务没有提交。可点“新会话”或发送 `/new` 另建会话，原会话及历史保留；要继续原会话，先由占用方释放，再重新发送任务。本网关 `/release` 只能解除自己的占用，不能解开 Desktop 或其他客户端的写锁。

异常退出可能留下仓库外 `gateway.lock`。确认旧网关已经停止后，可执行 `npm start -- unlock` 再启动。该命令只在记录的 PID 不存在时删除锁；PID 仍存活或无法确认时拒绝处理，绝不终止锁中记录的进程。不要靠手动删除锁运行第二个实例。

## 部署与自启

网关代码与运行数据分离：配置、状态和日志放在仓库外，Windows 默认数据目录为 `%LOCALAPPDATA%\AIBotLink`，可用 `BOTLINK_HOME` 覆盖。数据目录保存 `config.json`、`state.json`、`dsh-bridge.json`、`setup.json`、网关锁和日志；不要放进仓库。

构建网关并完成配置后，可在网关目录运行 [Install-WindowsStartup.ps1](scripts/Install-WindowsStartup.ps1)，为当前用户注册登录计划任务并在网关目录的父目录创建配置页快捷方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-WindowsStartup.ps1
```

脚本注册的计划任务名为 `AILinkBridge`，在用户登录时运行 [Start-Gateway.ps1](scripts/Start-Gateway.ps1)，只启动本网关，不启停 DSH Host。该脚本要求 `dist/main.js` 已构建，把标准输出和错误分别写入数据目录的 `gateway-<yyyyMMdd-HHmmss-fff>.out.log` 与 `.err.log`；启动失败时先检查这对日志。计划任务包含失败重启和忽略重复实例设置，启动脚本只管理自己创建的子进程。

脚本在网关目录的父目录创建 `AILinkBridge Settings.lnk`，它指向 [Open-Settings.ps1](scripts/Open-Settings.ps1)。该脚本先检查 `setup.json` 中登记且进程仍存活的配置页地址，没有可用地址时启动网关并等待配置页就绪，再打开浏览器；启动失败时提示查看数据目录日志。

自启边界：脚本注册成功不等于登录自启已验收；须在下次登录或重启时确认任务实际触发、网关启动、配置页可打开。未使用计划任务时，按上一节的检查与启动流程手动运行。

## 本机配置

`config.json` 的核心字段：

| 字段 | 用途 |
|---|---|
| `qq.appid` | 官方机器人 App ID |
| `qq.secretSource.file` / `ref` | YAML 凭据文件及 `refs` 条目；也支持本机 `qq.secret` |
| `qq.allowedUsers` | 可访问的用户 OpenID；为空时拒绝启动 |
| `qq.allowedGroups` | 允许的群；群消息还必须满足用户白名单，空数组禁用群访问 |
| `agents.<id>.type` | `codex` 或 `dsh` |
| `command` / `args` | stdio 模式的可信可执行文件和参数；不是聊天中的任意 Shell 入口 |
| `agents.<id>.dshBridge` | DSH 桥接记录的仓库外绝对路径；此模式不生成 Agent 子进程 |
| `cwd` | Agent 工作目录，必须是绝对路径 |
| `home` / `env` | 原生 HOME 及启动环境；不要提交敏感值 |
| `agents.<id>.model` | 可选的新建 Codex 线程模型；不修改 Codex 全局配置 |
| `messages` | 可选的文案键值覆盖，保存在本机配置中；键须存在于默认文案资源 |

导入不是安装器，不会迁移或删除 DSH 原配置，也不会自动关闭 dsh-im QQ 连接。

## 命令与使用范围

以 `/help` 返回的注册表为准。

| 命令 | 当前行为 |
|---|---|
| `/m [page\|command]`、`/agents`、`/agent [id]`、`/status` | 完整命令菜单、状态及 Agent 选择；切换保留各 Agent 会话绑定 |
| `/runtime start\|stop\|restart <id>` | 控制自建后端或桥接客户端；桥接模式不启停 Desktop |
| `/sessions [cursor]`、`/session [id]`、`/new` | 原生列表、恢复/绑定和创建；受原生会话所有权限制 |
| `/fork` | 原生历史分支并绑定新会话；Codex/DSH Host 桥已实现，DSH ACP 不支持，真实分支待验收 |
| `/history` | Codex 最近五个 Turn，或 DSH Host 桥最近快照中的文本；DSH ACP 不支持 |
| `/providers`、`/provider [id]` | 从原生配置/模型目录查询和切换提供方；查询与选择当前提供方已探测，跨提供方切换未验收 |
| `/models [offset]`、`/model [value]`、`/reasoning [value]` | 原生模型/选项；模型四项分页，Codex 保存后续 Turn 请求值，DSH 使用当前接入路径的原生设置 |
| `/reasonings` | 查询原生推理档位 |
| `/permissionlist [offset]`、`/permission [mode]` | Codex 提供两种沙箱模式；DSH Host 桥从原生权限目录取值，显式选择后执行原生命令并回读，不支持时明确报错 |
| `/stop` | 中断当前聊天提交的活动任务；不停止进程 |
| `/release`、精确消息“交接” | 空闲时停止自建后端或断开桥接客户端；保留已保存历史及绑定 |
| `/steer <text>`、`/compact` | Codex 与 DSH Host 桥有原生实现；DSH ACP 不支持，真实控制待验收 |
| `/approve <token> accept\|decline`、`/answer <token> <text>` | 回答支持的原生审批/提问；真实闭环待验收 |
| `/ackunknown` | 用户自行核验后清除未知结果标记；不会重放旧任务 |
| `/result` | 取回当前聊天待交付的最终回复；不重跑任务，回复发送成功后清除待交付标记 |

普通非命令文本提交给所选 Agent；没有绑定时创建会话。当前仅支持文本，不转交附件，也不回传本地文件。设置可能不跨原生会话恢复持久化，不能将“已保存后续 Turn 请求值”当成模型已执行确认。

默认沿用原生提供方，不为了绕过认证错误强制切换其他提供方。原生目录中出现模型也不证明当前账号可调用；任务失败时先核验原生认证和模型权限。DSH 提供方切换通过选择对应模型组的首个模型实现，之后可再用 `/model` 明确选择。

DSH Host 桥的模型/推理设置经 [DSH Host 桥接接口](docs/dsh-bridge-protocol.md) 的会话选项完成；Host 可能同时保存原生默认选择，不能保证只影响当前会话。更改前请确认原生目录中的目标值。

Codex 权限更改只在空闲时执行。尚未提交过任何输入的本进程空白线程，可能通过新建线程应用设置，返回并重新绑定新的 Session ID；已有历史走原生恢复接口，不替换已有历史来伪装成功。模型输入只要尝试提交过，即使超时也不再视为空白线程。

最终回复发送前先保存在仓库外状态中。如果任务已完成但回复发送失败，使用 `/result` 取回已保存结果；重启仍保留该结果，不需要重跑任务。已成功交付的结果不会一直保存在此入口。

仍在提交或已接受但未确认结束的任务，在重启、原生后端断开或提交超时后可能变为未知结果。先在原生 Agent 核验任务和文件状态，再用 `/ackunknown` 解除该聊天的提交限制；不要直接重复发送旧任务。`completed` 的待交付结果应使用 `/result`，不能按未知任务处理。

QQ 指令面板和全局菜单用于插入命令，消息内按钮执行同一命令注册表。固定常用面板最多二十项，`/m` 和 `/help` 提供完整命令；Codex/DSH 共用同名入口，能力不同会明确提示。`/m` 每页三个命令，加前后翻页按钮最多五行；需要必填参数的菜单入口先显示用法。默认短标签不超过三字，备注不超过十字。会话与模型目录使用四项选择和下一页；DSH 较大的原生会话页由短期缓存继续分页，真实多页交互尚未验收。同步失败时保留文字命令；新版菜单显示和点击仍待 QQ 验收。

`/status` 显示当前绑定在本网关后端中是否已加载，已加载时提供交接按钮；这不是 Desktop 控制权或全系统锁状态。它还可显示最近一次有记录的准备、后端、首字、发送与合计耗时，以及记录的模型/推理档位。首字是后端区间内的观测时间，不与后端耗时相加；新计时显示尚待新 QQ 回合验证。

## 文案与验证入口

产品文案集中在 [zh-CN.json](src/locales/zh-CN.json)，由 [messages.ts](src/messages.ts) 替换模板参数。可在仓库外 `config.json` 的 `messages` 覆盖已有键；当前只有中文资源，还没有语言选择或完整多语言支持。

`npm test` 运行网关本地边界、假协议和假 Host 测试，不连接真实 QQ、不调用模型；桥接端由外部实现，其测试与验收不在本仓库，网关按 [DSH Host 桥接接口](docs/dsh-bridge-protocol.md) 消费它。`scripts/smoke-native.mjs` 标为 `TEST_ONLY`，只在显式运行时调用原生模型测试；其模型选择只用于测试，不修改全局设置。`scripts/probe-controls.mjs` 显式探测原生目录、当前提供方及 Codex 沙箱控制，不启动推理。这些脚本不能替代 QQ 对应操作的真实验收。
