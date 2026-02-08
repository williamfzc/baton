# Baton

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)

连接 IM 与本地 ACP Agent 的智能代理桥梁。

## 功能特性

- ✅ **标准 ACP 协议** - 使用官方 `@agentclientprotocol/sdk`
- ✅ 内存会话管理（无持久化）
- ✅ FIFO 任务队列（单写者模型）
- ✅ 指令解析与路由（/help, /current, /stop, /reset 等）
- ✅ Mock Feishu 测试
- ✅ 完整响应模式（非流式）
- ✅ 文件系统访问控制（限制在项目目录内）
- ✅ 权限自动批准（预留交互确认接口）

## 快速开始

### 前置要求

- [Bun](https://bun.sh/) >= 1.0.0
- opencode CLI（用于 ACP agent）

### 安装

```bash
# 克隆仓库
git clone <repository-url>
cd baton

# 安装依赖
bun install
```

### 运行 CLI

```bash
# 开发模式（热重载）
bun run dev

# 运行
bun start
```

### 打包成独立可执行文件

```bash
bun build --compile src/cli.ts --outfile baton

# 运行打包后的文件
./baton
```

### 运行测试

```bash
bun test
```

## 使用示例

启动后进入交互模式：

```
> /help
显示所有可用指令

> /current
查看当前会话状态和队列

> 你好，请帮我检查一下代码
发送 prompt 给 agent

> /reset
重置会话（清除上下文）

> /stop
停止当前任务

> /stop all
清空队列并停止所有任务

> quit 或 exit
退出程序
```

## 支持的指令

| 指令 | 描述 |
|------|------|
| `/help` | 显示帮助信息 |
| `/current` | 查看当前会话状态 |
| `/stop [id/all]` | 停止当前任务或清空队列 |
| `/reset` | 重置会话（清除上下文） |
| `/mode [mode_name]` | 切换 Agent 模式 |
| `任意文本` | 作为 Prompt 发送给 Agent |

## 项目结构

```
baton/
├── src/
│   ├── cli.ts              # CLI 入口
│   ├── types.ts            # 类型定义
│   ├── core/
│   │   ├── session.ts      # 会话管理器（内存存储）
│   │   ├── queue.ts        # 任务队列引擎（FIFO）
│   │   └── dispatcher.ts   # 指令分发器
│   └── acp/
│       └── client.ts       # ACP 客户端封装
├── tests/
│   └── baton.test.ts       # 单元测试（含 Mock Feishu）
├── package.json
├── tsconfig.json
├── .gitignore
├── LICENSE
└── README.md
```

## 架构说明

Baton 实现了 PRD 中定义的三层架构：

1. **IM 接入层** - 当前为 CLI 模式，预留 Webhook 接口
2. **核心机制层** - 会话管理、任务队列、指令路由
3. **执行层** - ACP Runtime，通过 stdio 与 opencode agent 通信

### 会话隔离

- 每个用户（userId）拥有独立 session
- SessionKey = `userId:projectPath`
- 进程隔离：每个 session 一个 agent 子进程
- 项目隔离：文件操作限制在项目根目录

### 任务队列

- 严格串行化：同一会话同一时间只能执行一个任务
- FIFO 调度：先到先服务
- 非阻塞反馈：入队立即返回位置信息
- 异步处理：不阻塞 IM 响应

## MVP 限制

1. **单项目模式** - 仅支持当前工作目录
2. **内存存储** - 进程重启数据丢失
3. **权限自动批准** - 无交互式确认
4. **完整响应** - 非流式输出
5. **CLI 模式** - 飞书接入待实现

## 依赖

- `@agentclientprotocol/sdk` - ACP 协议官方 SDK
- `typescript` - 类型系统
- `bun` - JavaScript 运行时和包管理器

## 未来计划

- [ ] 飞书/Lark Webhook 接入
- [ ] Slack/Discord 支持
- [ ] 持久化存储（SQLite）
- [ ] 权限交互确认（卡片消息）
- [ ] 流式响应支持
- [ ] 多项目配置管理
- [ ] 配置热重载

## License

Apache 2.0 © 2024 Baton Contributors

See [LICENSE](LICENSE) for details.