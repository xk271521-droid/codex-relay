# Codex Relay

Codex Relay 是一个 Windows 本地多模型 Router 和桌面管理器。它的目标是在保留用户真实 Codex 官方登录的同时，把最多五个用户配置的第三方模型加入同一个 Codex 模型选择入口。

> 当前版本是开发与实机验收阶段。路由、流式、配置快照和桌面壳已经实现，但两个官方候选模型、完整官方账号页和闭源 Codex Desktop 模型菜单仍需真实账号验证。请不要把本项目当作已经稳定发布的官方集成。

## 产品约定

- 两个官方容量位，只有检测并保存真实官方认证后才发布。
- 最多五个第三方槽位，每个槽位可自定义显示名、供应商和上游模型 ID。
- 一个供应商可被多个槽位复用，支持 OpenAI-compatible Responses 或 Chat Completions。
- 空槽位不写入 Codex；未登录时不伪造官方模型或账号状态。
- 普通模型切换由 Codex 模型栏完成，不需要反复改配置或重启 Router。
- 官方和第三方凭据严格隔离；第三方 Key 使用当前 Windows 用户的 DPAPI 加密。
- 上游未返回 usage 时，请求记录显示“未返回”，不会估算成真实 Token。

## 工作方式

```text
Codex Desktop
  -> Codex Relay（127.0.0.1:15723）
     -> 官方 Codex Responses（用户官方登录）
     -> 第三方 Responses
     -> 第三方 Chat Completions（转换为 Responses SSE）
```

官方 Responses 流按数据块透传。第三方 Chat Completions 流会实时转换为 Codex 需要的 Responses SSE，并保留工具调用、取消和可见上下文记录。

同一路线优先使用其原生响应链；跨官方与第三方、或跨第三方路线时，Relay 重放可见对话和工具结果，不传递其他供应商的响应 ID。便携上下文会增加输入 Token，也不能包含另一个模型的隐藏状态，因此不承诺无损继承。

## 配置与恢复边界

编辑模型或供应商只修改 Relay 自己的数据。只有用户显式点击“保存并应用到 Codex”后，Relay 才会：

1. 检查 Router、可用模型、第三方 Key、官方认证、配置可写性和会话保护清单；
2. 保存本次进入 Relay 前的 `config.toml` 与 `auth.json`；
3. 写入本地模型目录和 localhost Router 地址；
4. 验证失败时事务回滚。

重复应用不会覆盖本次使用前快照。打开管理页和读取状态不会修改 Codex。若 CC Switch、官方直连或手动配置已完整接管，Relay 只报告“外部接管”，不会自动抢回。

“恢复使用前状态”只恢复本次进入 Relay 前的 Codex 配置和认证。它不会删除：

- Relay 供应商、模型名称和槽位；
- 加密的第三方 Key；
- 可选的加密上下文缓存；
- Codex 聊天、任务和插件。

关闭窗口只隐藏到托盘。退出 Codex Relay 也不会自动恢复；如果 Codex 仍指向 Relay，退出会停止 Router，并在退出前给出警告。

## 本地数据

Relay 数据默认保存在 `%USERPROFILE%\.codex-relay`。应用只绑定 `127.0.0.1`，不会把管理器暴露到局域网。

Relay 不迁移或合并 Codex 会话数据库。应用与恢复时会对已有会话文件做有限的缺失、缩短和前缀变化检查，但这不是完整数据库一致性证明，也不能保证闭源 Codex Desktop 在所有身份状态下都显示相同任务列表。

## 开发

要求 Node.js `>=22.15.0`。

```powershell
npm.cmd install
npm.cmd test
npm.cmd run desktop
```

仅启动本地 Web 管理器和 Router：

```powershell
npm.cmd start
```

管理地址为 `http://127.0.0.1:15723`。

构建 Windows 安装版和便携版：

```powershell
npm.cmd run build:desktop
```

构建产物输出到工作区的 `releases` 目录。

## 发布前验收

稳定版至少需要通过：

- 完整自动化测试；
- 真实官方账号的完整账号页、额度、插件、两个官方模型和工具调用；
- 一个真实 Responses 第三方和一个真实 Chat Completions 第三方；
- 官方互切、官方/第三方互切、第三方互切和上下文/Token 对照；
- 未登录后登录、Windows 代理切换和 CC Switch 外部接管；
- 精确恢复 config/auth，且 Relay 设置、聊天和插件保留；
- 安装版、便携版、托盘、单实例、退出警告和多尺寸 UI。

产品目标与限制见 [PRODUCT.md](./PRODUCT.md)，界面和桌面验收要求见 [DESIGN.md](./DESIGN.md)。第三方代码归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
