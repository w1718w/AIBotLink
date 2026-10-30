# 文档入口

项目根目录 [README](../README.md) 说明当前可用入口、安装、配置与命令。本目录保存已经落地的系统契约和验证范围，不描述尚未实现的任务书方案。

- [架构与契约](architecture.md)：组件职责、DSH Host 桥、消息流、会话和权限边界、结果恢复、分页和计时，以及文案和版本兼容边界。
- [DSH Host 桥接接口](dsh-bridge-protocol.md)：网关与外部 DSH Host 桥接端之间的连接记录、认证传输、RPC 方法、事件流与交互、错误和版本边界。
- [兼容性与验证](compatibility.md)：依赖及原生后端版本、验证范围、未验收能力、当前缺项与发布验收边界。

## 历史背景材料

[background/](background/) 保存 2026-10-30 的任务书、开源实现调研、验证记录及当时的探测程序与原始结果，只用于追溯选型过程和当时的证据。它们是历史材料，不是当前架构、当前安装方式或当前验证状态的依据；部分设想已由现有实现取代。当前架构以 [架构与契约](architecture.md) 为准。

- [任务书](background/task-book.md)
- [开源实现调研](background/research-2026-10-30.md)
- [验证与选型判断](background/validation-2026-10-30.md)
- [原生接口探测程序](background/probe-native.mjs)
- [最后一轮原始探测结果](background/native-probe-results.json)

每项事实只在对应文档维护；命令完整列表以程序 `/help` 为准。新增或移动文档时更新本入口。
