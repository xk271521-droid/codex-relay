# Codex Relay

Codex Relay 是 Windows 本地多模型 Router 与桌面管理器。它保留 Codex 的官方登录和官方模型，同时将兼容的第三方 Responses（包括 DeepSeek Responses）和 Chat Completions 模型发布到 Codex 的同一模型选择器中。

```text
Codex Desktop
  -> Codex Relay (127.0.0.1:15723)
     -> OpenAI official Responses
     -> Third-party Responses over HTTP/SSE
     -> Chat Completions
```

## 功能

- 在官方模型与第三方模型之间按请求切换，无需为普通切换重启 Router。
- 管理多个供应商、模型、网络出口和 API Key；Key 仅保存在当前 Windows 用户的本机加密存储中。
- 提供模型检测、请求记录、Token/缓存信息、使用量统计和本地主题管理。
- 在“安全与恢复”中显式启用 Relay、恢复启用前的 Codex 配置，或切回官方直连。
- 官方和第三方路由隔离。第三方普通聊天采用单次 HTTP/SSE 转发，不自动重发、不自动续接、不替第三方写入 `store`。
- DeepSeek Responses 通过供应商编辑框中的 `DeepSeek Responses（Codex）` 模式接入，仅支持 `deepseek-v4-flash`；它直接使用 HTTP/SSE，不运行 DeepSeek 的配置脚本，也不改写现有 Codex 配置。

## 要求

- Windows 10/11
- 已安装并登录 Codex Desktop
- Node.js `>=22.16.0`

## Windows 安装包

安装包不包含任何用户的 Codex 登录、第三方 API Key、聊天记录或 Relay 本地数据。安装后启动 `Codex Relay`，再在管理器中使用当前 Windows 用户自己的 Codex 登录和第三方配置。

安装包为未签名的本地桌面软件，Windows 可能显示 SmartScreen 提示；仅应从可信发布者处取得并核对发布的 SHA-256。

## 从源码运行

在项目目录执行：

```powershell
npm.cmd install
npm.cmd test
npm.cmd run desktop
```

`npm.cmd run desktop` 会打开桌面管理器并启动本地 Router。首次安装 Electron 等依赖可能需要几分钟。

如只需要本地管理页和 Router：

```powershell
npm.cmd start
```

然后打开 `http://127.0.0.1:15723`。

维护者构建 Windows 安装包：

```powershell
npm.cmd install
npm.cmd run package:win
```

产物位于 `release\`。构建过程仅打入桌面运行时和所需应用文件，排除本机配置、日志、测试输出和项目内部文档。

## 配置与使用

1. 启动桌面管理器，确认概览页显示 Router 正在运行，并确认官方登录状态。
2. 在“供应商”中填写第三方服务的接口地址、协议、网络设置和 API Key。
3. 在“模型”中添加需要发布的第三方模型；官方模型由已登录的 Codex 账号提供。
4. 在“安全与恢复”中确认并点击“启用 Relay”或“更新 Relay”。这一步才会将 Codex 指向本地 Router。
5. 回到 Codex Desktop，在模型选择器中选择相应模型开始使用。

需要停止通过 Relay 路由时，请先完全退出 Codex，再在“安全与恢复”中选择“退出并恢复”或“切回官方”。前者恢复启用 Relay 前的 Codex 配置与认证；后者恢复官方默认直连。Relay 的本地供应商设置、加密 Key 和请求记录不会因此删除。

## 数据与安全

- Router 仅监听 `127.0.0.1:15723`，不对局域网开放。
- 供应商 Key 和可选的跨模型上下文使用 Windows DPAPI 绑定到当前用户保存。
- 请求记录会脱敏；不要将本机数据目录、日志或 `CODEX_RELAY_HOME` 中的文件提交到 Git。
- 使用第三方供应商前，请自行确认其数据处理、价格、模型能力和服务条款。

## 开发

```powershell
npm.cmd test
```

本仓库包含从源码运行所需的应用代码、测试、启动入口和第三方版权声明。第三方归属与许可证信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
