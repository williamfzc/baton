# SpecCraft 设计文档

> Spec Creator — 帮团队创建和管理 spec-driven 工作流的工具

---

## 1. 核心定位与原则

### 1.1 一句话定义

**SpecCraft**（简称 Craft）是一个 Spec Creator — 帮团队创建和管理 spec-driven 工作流的工具。

### 1.2 核心价值

| 价值 | 说明 |
|------|------|
| **创建工作流** | 通过引导式问答或从示例学习，帮团队定义自己的 spec 工作流 |
| **跨平台** | 产物是纯静态文件（SKILL.md + workflow.yaml），各 Agent 平台通用 |
| **静态与运行时分离** | 工作流定义是纯静态的，CLI 是独立的运行时 |

### 1.3 不是什么

- 不是所有工作流都需要 spec（bug-fix、hotfix 可能不需要）
- 不是工作流执行引擎，CLI 只是辅助工具
- 不强制 NPM 分发，Git URL 即可

### 1.4 核心原则

| 原则 | 说明 |
|------|------|
| **YAML + 模板拆分** | workflow.yaml 定义逻辑，大模板独立文件 |
| **通用命令驱动** | `craft run <workflow> <command>` 支持任意工作流 |
| **SKILL.md 是说明书** | SKILL.md 告诉 Agent 用哪些 CLI 命令 |

---

## 2. 整体架构

### 2.1 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                           SpecCraft                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────┐      ┌────────────────────────────┐    │
│  │   @speccraft/cli       │      │   @speccraft/templates     │    │
│  │   (脚手架 + 运行时)     │      │   (内置模板库)              │    │
│  │                        │      │                            │    │
│  │  - craft init          │      │  - brainstorm/             │    │
│  │  - craft copy          │      │  - feature-dev/            │    │
│  │  - craft create        │      │  - api-design/             │    │
│  │  - craft run           │      │                            │    │
│  └────────────────────────┘      └────────────────────────────┘    │
│                 │                          │                        │
│                 ▼                          ▼                        │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              团队 Marketplace (纯静态)                        │   │
│  │              myteam-spec-workflows/                          │   │
│  │                                                              │   │
│  │  ├── marketplace.json                                        │   │
│  │  ├── brainstorm/           # 从模板复制                      │   │
│  │  │   ├── SKILL.md                                           │   │
│  │  │   ├── workflow.yaml                                      │   │
│  │  │   └── templates/                                         │   │
│  │  └── bug-triage/            # 团队自定义                     │   │
│  │      ├── SKILL.md                                           │   │
│  │      ├── workflow.yaml                                      │   │
│  │      └── templates/                                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────┐
        │              使用者 (团队成员)                      │
        │                                                    │
        │  方式1: 作为 Marketplace 安装到 Agent               │
        │  /plugin marketplace add https://github.com/...    │
        │  /brainstorm ...                                   │
        │                                                    │
        │  方式2: CLI 直接运行                                │
        │  npx @speccraft/cli run brainstorm init <topic>    │
        └───────────────────────────────────────────────────┘
```

### 2.2 两个核心产物

| 产物 | 职责 | 使用者 |
|------|------|--------|
| `@speccraft/cli` | 脚手架工具 + 工作流运行时 | TL/技术负责人创建，团队成员使用 |
| `@speccraft/templates` | 内置模板库 | 作为 CLI 的依赖 |

### 2.3 分发模型

```
团队 Marketplace (Git Repo)
└── myteam-spec-workflows/     # 一个 marketplace
    ├── marketplace.json        # marketplace 配置
    ├── brainstorm/             # 多个 workflow/skill
    ├── feature-dev/
    └── bug-triage/
```

**使用方式**：
```bash
# 团队成员安装团队的 marketplace
/plugin marketplace add https://github.com/myteam/myteam-spec-workflows

# 然后就能用里面的所有工作流
/brainstorm ...
/feature-dev ...
```

---

## 3. 产物结构

### 3.1 CLI 结构

```
@speccraft/cli/
├── bin/
│   └── craft.js              # 入口脚本
├── src/
│   ├── index.ts              # 主入口
│   ├── commands/             # 子命令实现
│   │   ├── init.ts           # craft init - 创建 marketplace
│   │   ├── copy.ts           # craft copy - 从模板复制工作流
│   │   ├── create.ts         # craft create - 自定义创建工作流
│   │   └── run.ts            # craft run - 运行工作流命令
│   ├── core/                 # 核心引擎
│   │   ├── WorkflowLoader.ts    # 加载 workflow.yaml
│   │   ├── CommandExecutor.ts   # 执行命令
│   │   └── TemplateRenderer.ts  # 渲染模板
│   └── utils/
├── package.json
└── README.md
```

### 3.2 Templates 结构

```
@speccraft/templates/
├── brainstorm/
│   ├── SKILL.md
│   ├── workflow.yaml
│   └── templates/
│       └── brainstorm.md
├── feature-dev/
│   ├── SKILL.md
│   ├── workflow.yaml
│   └── templates/
│       ├── spec.md
│       ├── plan.md
│       └── tasks.md
└── api-design/
    ├── SKILL.md
    ├── workflow.yaml
    └── templates/
        └── api-spec.md
```

### 3.3 团队 Marketplace 结构

```
myteam-spec-workflows/
├── marketplace.json          # marketplace 配置
├── brainstorm/               # 工作流 (从模板复制)
│   ├── SKILL.md              # Agent 读取的技能说明
│   ├── workflow.yaml         # CLI 读取的工作流定义
│   └── templates/            # 模板文件
│       └── brainstorm.md
├── bug-triage/               # 工作流 (团队自定义)
│   ├── SKILL.md
│   ├── workflow.yaml
│   └── templates/
│       ├── init.md
│       └── triage.md
└── feature-dev/
    ├── SKILL.md
    ├── workflow.yaml
    └── templates/
        ├── spec.md
        ├── plan.md
        └── tasks.md
```

---

## 4. workflow.yaml 规范

### 4.1 基本结构

```yaml
# workflow.yaml
name: brainstorm
version: 1.0.0
description: 通过问答式交互，将模糊想法转化为清晰设计

# 变量定义
variables:
  topic:
    type: string
    required: true
    description: 要探索的主题
  outputDir:
    type: string
    default: "specs/{{topic}}"

# 命令定义
commands:
  init:
    description: 初始化 brainstorm
    template: templates/init.md
    output: "{{outputDir}}/brainstorm.md"
    
  next:
    description: 继续下一个问题
    # 无模板，交互式
    
  status:
    description: 查看当前状态
    
  validate:
    description: 验证 brainstorm 是否完整
    
  done:
    description: 完成 brainstorm
    template: templates/summary.md
    output: "{{outputDir}}/summary.md"
```

### 4.2 命令类型

| 类型 | 说明 | 示例 |
|------|------|------|
| **template** | 使用模板生成文件 | `init`, `done` |
| **interactive** | 交互式，无模板 | `next` |
| **query** | 查询状态，不修改文件 | `status`, `validate` |

### 4.3 变量系统

```yaml
variables:
  # 字符串类型
  topic:
    type: string
    required: true
    
  # 选择类型
  priority:
    type: select
    options: [P0, P1, P2, P3]
    default: P2
    
  # 带默认值
  outputDir:
    type: string
    default: "specs/{{topic}}"
    
  # 计算变量
  slug:
    type: computed
    formula: "{{topic | slugify}}"
```

---

## 5. SKILL.md 规范

### 5.1 作用

SKILL.md 是给 Agent 看的"说明书"，告诉 Agent：
- 这个工作流做什么
- 用哪些 CLI 命令
- 命令的顺序和逻辑

### 5.2 示例

```markdown
# Brainstorm 工作流

通过问答式交互，将模糊想法转化为清晰的设计文档。

## 何时使用

- 有一个模糊的想法，需要探索和细化
- 需要做技术决策，想系统性地分析
- 开始一个新功能前，想先理清思路

## 使用方式

使用 `craft run brainstorm <command>` 执行命令：

### 初始化

\`\`\`bash
craft run brainstorm init <topic>
\`\`\`

创建一个新的 brainstorm 文档，开始探索。

### 继续探索

\`\`\`bash
craft run brainstorm next
\`\`\`

Agent 会提出下一个问题来深化思考。

### 查看状态

\`\`\`bash
craft run brainstorm status
\`\`\`

查看当前探索的进度和已覆盖的维度。

### 验证

\`\`\`bash
craft run brainstorm validate
\`\`\`

检查 brainstorm 是否完整，是否可以进入下一阶段。

### 完成

\`\`\`bash
craft run brainstorm done
\`\`\`

生成最终的设计摘要。

## 流程建议

1. 先运行 `init` 开始
2. 多次运行 `next` 深入探索
3. 随时用 `status` 查看进度
4. 用 `validate` 检查完整性
5. 最后用 `done` 完成

## 产出

- `specs/<topic>/brainstorm.md` — 探索过程记录
- `specs/<topic>/summary.md` — 最终设计摘要
```

---

## 6. CLI 命令设计

### 6.1 命令总览

```bash
# Marketplace 管理
craft init <name>              # 创建新的 marketplace
craft init .                   # 在当前目录初始化

# 工作流管理
craft copy <template>          # 从模板库复制工作流
craft create <name>            # 交互式创建新工作流

# 工作流执行
craft run <workflow> <cmd>     # 运行工作流命令
craft <workflow> <cmd>         # 快捷方式（内置工作流）

# 查询
craft list                     # 列出所有工作流
craft show <workflow>          # 显示工作流详情
```

### 6.2 craft init

```bash
craft init myteam-spec-workflows

# 产出
myteam-spec-workflows/
├── marketplace.json
└── README.md
```

### 6.3 craft copy

```bash
# 从模板库复制
craft copy brainstorm
craft copy feature-dev

# 产出（在当前 marketplace 目录下）
brainstorm/
├── SKILL.md
├── workflow.yaml
└── templates/
```

### 6.4 craft create

```bash
craft create bug-triage

# 交互式问答
? 工作流名称: bug-triage
? 描述: Bug 分类和处理工作流
? 变量: bug-name (string, 必填)
? 命令: init, triage, validate, done
? 命令 init 的模板文件: templates/init.md
...
```

### 6.5 craft run

```bash
# 通用格式
craft run <workflow> <command> [options]

# 示例
craft run brainstorm init user-auth
craft run brainstorm next
craft run brainstorm status
craft run feature-dev init --name=login --priority=P0
craft run bug-triage init BUG-123
```

---

## 7. 使用流程

### 7.1 TL/技术负责人：创建 Marketplace

```bash
# 1. 创建 marketplace
npx @speccraft/cli init myteam-spec-workflows
cd myteam-spec-workflows

# 2. 从模板复制常用工作流
npx @speccraft/cli copy brainstorm
npx @speccraft/cli copy feature-dev

# 3. 自定义工作流
npx @speccraft/cli create bug-triage

# 4. 推送到 Git
git init && git add . && git commit -m "Initial commit"
git remote add origin https://github.com/myteam/myteam-spec-workflows
git push -u origin main
```

### 7.2 团队成员：使用工作流

**方式1：作为 Marketplace 安装**

```bash
# Claude Code
/plugin marketplace add https://github.com/myteam/myteam-spec-workflows

# 然后在对话中使用
/brainstorm init user-auth
```

**方式2：CLI 直接运行**

```bash
# 在项目目录下
npx @speccraft/cli run brainstorm init user-auth
npx @speccraft/cli run brainstorm next
npx @speccraft/cli run brainstorm status
```

---

## 8. 内置模板

### 8.1 brainstorm

将模糊想法转化为清晰设计。

**命令**：`init`, `next`, `status`, `validate`, `done`

**产出**：
- `specs/<topic>/brainstorm.md` — 探索记录
- `specs/<topic>/summary.md` — 设计摘要

### 8.2 feature-dev

标准功能开发流程。

**命令**：`init`, `spec`, `plan`, `tasks`, `status`, `validate`

**产出**：
- `specs/<feature>/spec.md` — 需求规格
- `specs/<feature>/plan.md` — 实现计划
- `specs/<feature>/tasks.md` — 任务列表

### 8.3 api-design

API 设计流程。

**命令**：`init`, `define`, `review`, `done`

**产出**：
- `specs/<api>/api-spec.md` — API 规格

---

## 9. 跨平台适配

### 9.1 统一格式

SpecCraft 产物是纯静态文件：
- `SKILL.md` — Markdown 格式，所有 Agent 平台通用
- `workflow.yaml` — YAML 格式，CLI 通用
- `templates/` — Markdown 模板

### 9.2 各平台适配

| 平台 | 适配方式 |
|------|----------|
| Claude Code | 直接作为 marketplace plugin 使用 |
| OpenCode | 转换为 `.opencode/` 格式 |
| Codex | 转换为 `.codex/` 格式 |
| Cursor | 转换为 `.cursor/` 格式 |

### 9.3 转换工具

```bash
# 可选：转换为其他平台格式
craft export --target opencode
craft export --target codex
```

---

## 10. 实现路线图

### Phase 1: 核心 CLI (MVP)

- [ ] `craft init` - 创建 marketplace
- [ ] `craft copy` - 从模板复制
- [ ] `craft run` - 运行工作流命令
- [ ] 内置模板：brainstorm

### Phase 2: 工作流创建

- [ ] `craft create` - 交互式创建工作流
- [ ] workflow.yaml 解析和执行
- [ ] 变量系统

### Phase 3: 完善

- [ ] 更多内置模板
- [ ] 跨平台导出
- [ ] 从示例学习功能
- [ ] 文档和示例

---

*设计完成，待实现*

---

## 11. 高级功能


### 11.1 文档分章节生成 + 状态追踪

支持将大文档分章节逐步生成，并通过状态追踪机制记录每个实例的进度。

#### workflow.yaml 配置

```yaml
commands:
  design:
    template: templates/design.md
    output: "{{outputDir}}/design.md"
    chapters:
      - id: background
        title: 背景与目标
        description: 说明功能背景和目标
      - id: user-stories
        title: 用户故事
        description: 以用户视角描述需求
      - id: requirements
        title: 功能需求
        description: 详细的功能点描述
      - id: acceptance-criteria
        title: 验收标准
        description: 如何验证功能完成
    # 预定义章节分组
    chapterGroups:
      - name: phase-1
        description: "第一阶段：需求理解"
        chapters: [background, user-stories]
      - name: phase-2
        description: "第二阶段：详细需求"
        chapters: [requirements, acceptance-criteria]
```

#### 状态追踪机制

状态文件存储在项目目录下：`.craft/state/<workflow>/<instance>.yaml`

```yaml
# .craft/state/feature-dev/user-auth.yaml
instance: user-auth
workflow: feature-dev
createdAt: 2026-02-16T10:00:00Z
updatedAt: 2026-02-16T11:30:00Z

variables:
  feature: user-auth
  priority: P0
  outputDir: specs/user-auth

# 各命令状态
commands:
  init:
    status: completed
    completedAt: 2026-02-16T10:05:00Z
    output: specs/user-auth/init.md
    
  spec:
    status: completed
    completedAt: 2026-02-16T10:30:00Z
    output: specs/user-auth/spec.md
    
  design:
    status: in_progress
    startedAt: 2026-02-16T10:35:00Z
    chapters:
      background: completed
      user-stories: completed
      requirements: pending
      acceptance-criteria: pending
    currentGroup: phase-2
    
  tasks:
    status: pending
```

#### 使用方式

```bash
# 初始化新实例
craft run feature-dev init --feature user-auth --priority P0
# ✅ 创建状态文件: .craft/state/feature-dev/user-auth.yaml

# 生成 spec（完整文档）
craft run feature-dev spec
# ✅ 更新状态: spec.status = completed

# 生成 design - 自动从 phase-1 开始
craft run feature-dev design
# 📝 生成章节: background, user-stories
# ✅ 更新状态: design.chapters.background = completed
# ✅ 更新状态: design.chapters.user-stories = completed
# ✅ 更新状态: design.currentGroup = phase-2

# 继续生成 - 自动进入 phase-2
craft run feature-dev design
# 📝 生成章节: requirements, acceptance-criteria
# ✅ 更新状态: design.status = completed

# 查看状态
craft run feature-dev status

# 输出：
# ┌─────────────────────────────────────────┐
# │ 📋 feature-dev: user-auth               │
# ├─────────────────────────────────────────┤
# │ ✅ init     已完成                       │
# │ ✅ spec     已完成                       │
# │ ✅ design   已完成 (4/4 章节)            │
# │ ⏳ tasks   待开始                        │
# ├─────────────────────────────────────────┤
# │ 下一步: craft run feature-dev tasks     │
# └─────────────────────────────────────────┘

# 指定特定章节（跳过分组）
craft run feature-dev design --chapters requirements

# 重新生成某个章节
craft run feature-dev design --chapters background --force
```

#### 命令状态值

| 状态 | 说明 |
|------|------|
| `pending` | 待开始 |
| `in_progress` | 进行中 |
| `completed` | 已完成 |
| `failed` | 失败 |
| `skipped` | 跳过 |

#### 章节状态值

| 状态 | 说明 |
|------|------|
| `pending` | 待生成 |
| `completed` | 已生成 |
| `failed` | 生成失败 |

---
### 11.2 知识注入（Knowledge Injection）

在特定步骤/章节执行前，强制注入知识内容，确保 Agent 完整阅读。生成完成后自动移除知识块，不污染最终产物。

**workflow.yaml 配置：**

```yaml
commands:
  design:
    template: templates/design.md
    output: "specs/{{feature}}/design.md"
    injectKnowledge:
      # 内置知识文件
      - id: ab-testing
        source: knowledge/ab-testing.md
        removeFromOutput: true
      # 外部知识文件（URL）
      - id: company-standards
        source: https://raw.githubusercontent.com/company/standards/main/coding.md
        removeFromOutput: true
      # 引用其他 skill
      - id: security-guidelines
        skill: company/security-guidelines
        removeFromOutput: true
```

**模板示例：**

```markdown
<!-- templates/design.md -->
# 设计文档

## AB 实验设计

<knowledge id="ab-testing">
{{knowledge.ab-testing}}
</knowledge>

请基于以上 AB 实验规范，设计你的实验方案：

## 代码规范

<knowledge id="company-standards">
{{knowledge.company-standards}}
</knowledge>

请确保你的设计符合以上代码规范：
```

**流程：**

```
1. CLI 渲染模板，注入知识内容到 <knowledge> 块
2. Agent 基于完整内容（含知识）生成章节
3. CLI 检测章节完成后，自动删除 <knowledge> 块
4. 最终产物干净，无知识内容
```

**产物变化示例：**

生成中（Agent 看到）：
```markdown
## AB 实验设计

<knowledge id="ab-testing">
## AB 实验规范
1. 实验周期不少于 7 天
2. 样本量需达到统计显著性
...
</knowledge>

请基于以上 AB 实验规范，设计你的实验方案：

[Agent 生成的实验方案...]
```

生成后（最终产物）：
```markdown
## AB 实验设计

[Agent 生成的实验方案...]
```

---

### 11.3 SubAgent 支持

支持在命令中启动 SubAgent 来并行处理任务，或处理需要隔离上下文的复杂任务。

**workflow.yaml 配置：**

```yaml
commands:
  security-review:
    description: 安全评审
    output: "specs/{{feature}}/security-review.md"
    subAgents:
      - id: owasp-check
        name: OWASP 漏洞扫描
        prompt: |
          作为安全专家，请审查以下代码/设计是否存在 OWASP Top 10 漏洞：
          {{context.codeOrDesign}}
          输出格式：
          - 问题行号: 问题描述
          
      - id: data-privacy-check
        name: 数据隐私合规检查
        prompt: |
          作为隐私合规专家，请审查以下设计是否符合 GDPR/个人信息保护法：
          {{context.dataHandling}}
          输出：
          1. 隐私风险点
          2. 合规建议
          
      - id: security-report
        name: 安全评审报告生成
        dependsOn: [owasp-check, data-privacy-check]
        prompt: |
          基于以下检查结果生成完整的安全评审报告：
          
          ## OWASP 漏洞扫描结果
          {{subAgents.owasp-check.output}}
          
          ## 数据隐私合规检查结果
          {{subAgents.data-privacy-check.output}}
          
          输出：
          1. 执行摘要
          2. 详细发现
          3. 优先级建议
```

**使用方式：**

```bash
craft run feature-dev security-review
# CLI 自动：
# 1. 并行启动 owasp-check 和 data-privacy-check 两个 SubAgent
# 2. 等待两者完成
# 3. 启动 security-report SubAgent 汇总结果
# 4. 生成最终报告
```

---

### 11.4 上下文压缩建议

当检测到上下文过长时，CLI 主动建议用户进行上下文压缩或启动 SubAgent。

**触发条件：**

- Token 数超过阈值（如 8000）
- 对话轮次过多（如 20 轮以上）
- 单次输出内容过长

**workflow.yaml 配置：**

```yaml
contextManagement:
  tokenThreshold: 8000
  roundThreshold: 20
  suggestions:
    - type: compress
      message: "当前上下文较长，建议压缩历史对话"
    - type: subagent
      message: "建议启动 SubAgent 处理当前任务"
```

**用户界面示例：**

```bash
$ craft run brainstorm next

⚠️  上下文提示

当前对话已进行 25 轮，上下文累积较多。
建议启动 SubAgent 来处理当前任务，以提高效率。

选项：
  1. 启动 SubAgent（推荐）
  2. 继续当前上下文
  3. 压缩上下文后继续

请选择: 1

🚀 启动 SubAgent 处理当前任务...
```

---

## 12. 完整 workflow.yaml 规范

### 12.1 完整示例

```yaml
# workflow.yaml
name: feature-dev
version: 1.0.0
description: 标准功能开发流程

# 变量定义
variables:
  feature:
    type: string
    required: true
    description: 功能名称
  priority:
    type: select
    options: [P0, P1, P2, P3]
    default: P2
  outputDir:
    type: string
    default: "specs/{{feature}}"

# 上下文管理
contextManagement:
  tokenThreshold: 8000
  roundThreshold: 20

# 命令定义
commands:
  init:
    description: 初始化功能开发
    template: templates/init.md
    output: "{{outputDir}}/init.md"
    
  spec:
    description: 生成需求规格
    template: templates/spec.md
    output: "{{outputDir}}/spec.md"
    chapters:
      - id: background
        title: 背景与目标
      - id: user-stories
        title: 用户故事
      - id: requirements
        title: 功能需求
      - id: acceptance-criteria
        title: 验收标准
    injectKnowledge:
      - id: product-principles
        source: knowledge/product-principles.md
        removeFromOutput: true
        
  design:
    description: 生成技术设计
    template: templates/design.md
    output: "{{outputDir}}/design.md"
    injectKnowledge:
      - id: tech-stack
        source: knowledge/tech-stack.md
        removeFromOutput: true
      - id: security-guidelines
        skill: company/security-guidelines
        removeFromOutput: true
        
  security-review:
    description: 安全评审
    output: "{{outputDir}}/security-review.md"
    subAgents:
      - id: owasp-check
        name: OWASP 漏洞扫描
        prompt: |
          审查以下设计是否存在 OWASP Top 10 漏洞：
          {{context.design}}
      - id: security-report
        dependsOn: [owasp-check]
        prompt: |
          基于扫描结果生成安全评审报告：
          {{subAgents.owasp-check.output}}
          
  tasks:
    description: 生成任务列表
    template: templates/tasks.md
    output: "{{outputDir}}/tasks.md"
    dependsOn: [spec, design]
    
  status:
    description: 查看当前状态
    
  validate:
    description: 验证所有文档完整性
```

### 12.2 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 工作流名称 |
| `version` | string | 版本号 |
| `description` | string | 描述 |
| `variables` | object | 变量定义 |
| `contextManagement` | object | 上下文管理配置 |
| `commands` | object | 命令定义 |
| `commands.<name>.description` | string | 命令描述 |
| `commands.<name>.template` | string | 模板文件路径 |
| `commands.<name>.output` | string | 输出文件路径 |
| `commands.<name>.chapters` | array | 章节定义（分章节生成） |
| `commands.<name>.injectKnowledge` | array | 知识注入配置 |
| `commands.<name>.subAgents` | array | SubAgent 配置 |
| `commands.<name>.dependsOn` | array | 依赖的其他命令 |

---

## 13. 更新后的实现路线图

### Phase 1: 核心 CLI (MVP)

- [ ] `craft init` - 创建 marketplace
- [ ] `craft copy` - 从模板复制
- [ ] `craft run` - 运行工作流命令
- [ ] 内置模板：brainstorm
- [ ] workflow.yaml 基础解析

### Phase 2: 高级功能

- [ ] 文档分章节生成
- [ ] 知识注入（Knowledge Injection）
- [ ] `craft create` - 交互式创建工作流
- [ ] 变量系统

### Phase 3: SubAgent 与上下文

- [ ] SubAgent 支持
- [ ] 上下文压缩建议
- [ ] 更多内置模板

### Phase 4: 跨平台与完善

- [ ] 跨平台导出
- [ ] 从示例学习功能
- [ ] 文档和示例

---

*设计完成，待实现*
