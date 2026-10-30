# 文档入口

项目根目录 [README](../README.md) 说明可用入口、安装、配置与命令。本目录保存已经落地的系统契约与边界，不描述任务书方案。

- [架构与契约](architecture.md)：组件职责、DSH Host 桥、消息流、会话和权限边界、结果恢复、分页和计时，以及文案和版本兼容边界。
- [DSH Host 桥接接口](dsh-bridge-protocol.md)：网关与外部 DSH Host 桥接端之间的连接记录、认证传输、RPC 方法、事件流与交互、错误和版本边界。
- [兼容性与边界](compatibility.md)：运行依赖、接口版本、能力边界与配置约束。

## 历史背景材料

[background/](background/) 保存 2026-10-30 的任务书、开源实现调研、当时的测试记录及接口采样程序与原始结果，是历史快照，不是当前架构、安装方式或能力边界。部分设想已由现有实现取代；当前契约以 [架构与契约](architecture.md) 和 [兼容性与边界](compatibility.md) 为准。

- [任务书](background/task-book.md)
- [开源实现调研](background/research-2026-10-30.md)
- [选型判断记录](background/validation-2026-10-30.md)
- [原生接口采样程序](background/probe-native.mjs)
- [原始采样结果](background/native-probe-results.json)

每项事实只在对应文档维护；命令完整列表以程序 `/help` 为准。新增或移动文档时更新本入口。
