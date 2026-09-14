# DSH Memory & Knowledge Bundle 设计

产品方向以[记忆与项目知识产品设计](product-model.md)为准，目标技术规则见[知识生命周期与实施设计](knowledge-lifecycle.md)：记忆与知识独立，完整分析后自动可用，人工修订无 LLM 保存，双视图使用同一生效版本。下文仅保留历史架构和实现基线；混合入口/召回、知识逐卡审核、Page 不可编辑、整 Run 快照写入及旧共享布局等不再约束后续设计。当前行为以[运行说明](runtime.md)和代码为准。

状态：设计草案；canonical、本地运行时、可视化审核、来源陈旧检测、确定性 Card 候选生成、Source records、有界 Source evidence、对话显式记忆提取、可查询 Evidence Pack、AST 代码符号、Git diff 增量 inventory、静态模块关系和分层架构摘要、有界关系查询与 Graph 可视化、跨文件符号定义/引用查询与可视化、有界 TypeScript 项目配置解析、语言无关的 LLM Wiki 运行与覆盖审计数据模型、无正文读取的 Git Project Catalog，以及有界文件级跨区间 Claim 综合与核验纵切已实现

日期：2026-09-03

仓库：`Nyc-Hy/dsh-plugin-memory-knowledge`

## 1. 产品定位

本 Bundle 为 DeepSeek Harness 提供本地优先、可审计、可通过 Git 共享的记忆与项目知识能力。它覆盖个人长期记忆、项目与团队共享记忆、项目知识库、LLM Wiki、超大代码库的分层理解，以及面向人的可视化查看。

面向用户时它是一个可安装 Bundle；内部按 Cordis capability seam 拆分为独立的 Service Definition、Provider 和 Consumer，避免将存储、检索、模型调用、Git 协作与 UI 绑成一个不可替换的实现。

## 2. 已冻结的产品决策

1. 第一阶段面向小团队，团队知识通过 Git 共享，不建设远程账号、组织和 ACL 服务。
2. 一个 DSH Workspace 可以对应单仓库、单体多模块仓库，或由多个仓库组成的工作区。
3. 第一阶段只读取本地代码、项目文档、Git 元数据和 DSH 会话；外部平台连接器只保留 Provider 扩展点。
4. 个人记忆可以自动生成候选；项目与团队共享记忆必须经过人工审核后才能进入 Git。
5. 经审核的 Memory 和 Knowledge 以结构化 JSON 为 canonical；LLM Wiki 生成过程先在本地保存结构化 Claim、Citation、Conflict、Page 和 Coverage，Markdown 与图形界面只投影这些记录，未经审核的生成结果不直接进入 Git canonical。
6. 文件解析、FTS、符号关系、Git 增量分析和索引默认在本地执行。
7. 第一阶段不依赖 embedding。远程 LLM 只用于显式允许的候选提炼、Wiki 生成和复杂总结。
8. 数据出域策略按 Workspace 配置，默认 `ask`；本地能力失败时不得静默切换远程 Provider。
9. 模型实际看到的记忆或知识必须作为完整、有来源的 `user/message` 写入 Session，保证恢复、重放和审计。
10. 个人记忆、候选箱、Session 日志、索引、向量、模型文件、缓存和凭据不得提交 Git。

## 3. 领域划分

### 3.1 Instructions

说明“在项目中应该怎样做”的约束，例如 `AGENTS.md`、测试命令、编码规范和安全规则。现有 DSH `agent-instructions` 继续拥有该职责；本 Bundle 不复制或替代它。

### 3.2 Memory

跨任务复用的简短经验，例如偏好、决策、已验证方案、踩坑和约束。Memory 必须支持候选、审核、冲突、废弃、删除、版本与来源。

### 3.3 Knowledge

项目当前状态的结构化知识，例如模块、职责、接口、数据流、业务术语、业务流程、技术栈和代码证据。Knowledge 的确定性证据与 LLM 推断必须分开保存。

### 3.4 Wiki

供人和 Agent 阅读的项目深度理解。Wiki 由 LLM 直接阅读项目材料后形成，但每个事实句必须落成有来源的 Claim；推断、未知和冲突使用不同状态，不得伪装成事实。页面只组织 Claim，不拥有脱离 Claim 的自由事实文本；删除 Markdown 后可以从结构化运行记录或已审核 canonical 知识重新生成。

## 4. 总体架构

```text
代码 / 文档 / 配置 / Git / Session / 其他项目材料
                       │
                       ▼
             完整 Project Catalog
       文件身份、版本、大小、分片、遗漏与排除原因
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
  Raw Source Reader          Optional Local Maps
  按需读取原始证据            FTS / symbol / graph
          │                         │
          └────────────┬────────────┘
                       ▼
              Durable DSH Agent
        分层阅读、追问、交叉验证、覆盖审计
                       │
                       ▼
          Claim / Citation / Conflict Ledger
          事实 / 推断 / 未知 / 冲突 / stale
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
   Memory / Knowledge Review     Wiki / UI
   审核后进入 Git canonical      阅读、盲区与来源追溯
```

canonical store、派生索引和 UI 投影必须独立：索引损坏只触发重建，UI 缓存丢失只触发重投影，二者都不能改写 canonical 数据。

## 5. 作用域与稳定身份

### 5.1 本机 Workspace 映射

DSH `WorkspaceId` 只在当前 Harness home 内稳定，不适合作为 Git 中的团队共享身份。每个团队知识根必须提交自己的稳定标识：

```ts
type KnowledgeSpaceId = Branded<'KnowledgeSpaceId'>
type KnowledgeSourceId = Branded<'KnowledgeSourceId'>
```

- `KnowledgeSpaceId` 标识一个可组合的项目知识空间。
- `KnowledgeSourceId` 标识空间中的一个仓库或文档源。
- 本地 Provider 保存 `WorkspaceId -> KnowledgeSpaceId[]` 映射，不把本机路径或 Workspace UUID 写入团队知识。

### 5.2 单仓库

仓库根目录的 `.dsh/knowledge/manifest.json` 拥有一个 `KnowledgeSpaceId` 和一个 `KnowledgeSourceId`。

### 5.3 多仓库 Workspace

每个 child 仓库拥有自己的 `KnowledgeSourceId` 与 canonical 条目。Workspace 只生成本地组合投影，不回写 child store。

需要跨仓库、由 Workspace 自身拥有的知识时，必须显式配置一个处于 Git 管理下的 `workspaceKnowledgeRoot`。该根拥有 `KnowledgeSpaceId`，并在 manifest 中引用 child source；没有该根时，只允许只读组合，不生成无法通过 Git 共享的“团队级”跨仓知识。

### 5.4 个人、项目与团队

- `user`：保存在 `$DSH_HOME`，只属于当前操作者，不进入 Git。
- `source`：属于一个仓库，由该仓库 Git 权限和 review 流程共享。
- `space`：属于多仓项目，由 `workspaceKnowledgeRoot` 所在仓库共享。
- `session`：仅用于来源和召回审计，不作为长期共享作用域。

第一阶段的“团队权限”就是 Git 仓库的读写权限和 review 流程。本 Bundle 不把本机 anonymous identity、Session id 或存储路径当作授权凭据。

## 6. Git 中的 canonical 布局

```text
.dsh/knowledge/
  manifest.json
  entries/
    <memory-id>.json
  cards/
    <knowledge-card-id>.json
  wiki/
    index.md
    memory/<memory-id>.md
    cards/<card-id>.md
  schema/
    manifest.schema.json
    memory-entry.schema.json
    knowledge-card.schema.json
```

规则：

- `entries/` 与 `cards/` 是 canonical JSON。
- `wiki/` 是确定性生成的 Markdown 投影，与 canonical 修改出现在同一个 Git diff 中。
- 一个条目一个文件，降低团队并发编辑的冲突范围。
- 条目删除使用 tombstone，不直接删除文件；Git history 提供物理变更历史，当前文件提供可查询的逻辑删除状态。
- manifest 记录 schema、生成器、过滤器和投影版本；不记录密钥、本机绝对路径或 Provider credential。
- 本地索引写入 `$DSH_HOME`，通过 `KnowledgeSpaceId` 和 source revision 分区，不写入仓库。

## 7. Canonical 数据模型

### 7.1 Manifest

```ts
interface KnowledgeManifestV1 {
  schemaVersion: 1
  spaceId: KnowledgeSpaceId
  sources: Array<{
    id: KnowledgeSourceId
    kind: 'git'
    relativeRoot: string
  }>
  projection: {
    generator: string
    version: string
  }
}
```

`relativeRoot` 只允许相对 manifest 的路径。跨仓 source 在本地组合配置中解析，canonical manifest 不存其他成员机器无法使用的绝对路径。

### 7.2 Memory Entry

```ts
interface MemoryEntryV1 {
  schemaVersion: 1
  id: MemoryId
  revision: number
  scope:
    | { kind: 'source'; sourceId: KnowledgeSourceId }
    | { kind: 'space'; spaceId: KnowledgeSpaceId }
  kind: 'fact' | 'decision' | 'lesson' | 'preference' | 'constraint'
  status: 'verified' | 'conflicted' | 'deprecated' | 'deleted'
  title: string
  content: string
  evidenceClass: 'deterministic' | 'human-verified' | 'ai-suggested'
  provenance: ProvenanceRef[]
  tags: string[]
  supersedes: MemoryId[]
  conflictsWith: MemoryId[]
  sensitivity: 'normal' | 'restricted'
  createdAt: string
  updatedAt: string
}
```

约束：

- 候选记忆不进入该 schema；候选只存在本地 Candidate Store。
- Git 中的新条目必须是 `verified`。`ai-suggested` 描述来源类别，不代表已经验证。
- `revision` 单调递增；同 revision 内容不一致属于冲突。
- `deleted` 条目正文替换为删除原因与审计元数据，不继续保留不应暴露的敏感正文。
- 项目偏好只记录项目相关约定；个人风格不得误提升为团队要求。

### 7.3 Knowledge Card

```ts
interface KnowledgeCardV1 {
  schemaVersion: 1
  id: KnowledgeCardId
  revision: number
  scope: { kind: 'source'; sourceId: KnowledgeSourceId }
    | { kind: 'space'; spaceId: KnowledgeSpaceId }
  kind: 'overview' | 'architecture' | 'module' | 'flow' | 'decision' | 'stack'
  title: string
  summary: string
  sections: KnowledgeSection[]
  provenance: ProvenanceRef[]
  sourceRevisions: SourceRevision[]
  status: 'verified' | 'needs-review' | 'stale' | 'deprecated'
  evidenceClass: 'deterministic' | 'human-verified' | 'ai-suggested'
  createdAt: string
  updatedAt: string
}
```

### 7.4 Provenance

```ts
type ProvenanceRef =
  | {
      kind: 'git-file'
      sourceId: KnowledgeSourceId
      commit: string
      path: string
      startLine?: number
      endLine?: number
      contentHash: string
    }
  | {
      kind: 'git-commit'
      sourceId: KnowledgeSourceId
      commit: string
    }
  | {
      kind: 'session'
      sessionId: SessionId
      eventSeqs: number[]
      portableEvidence?: string
    }
  | {
      kind: 'document'
      sourceId: KnowledgeSourceId
      path: string
      contentHash: string
    }
```

生成型 Knowledge Card 的 `sourceRevisions` 还记录排除 `.dsh/knowledge`、缓存、凭据和本地数据库后的 Source inventory hash。commit 用于追溯，inventory hash 用于内容 freshness；团队提交 canonical 知识文件导致的 HEAD 变化不能单独使 Card 陈旧。没有 inventory hash 的既有 Card 继续按文件 provenance 或 commit 判断。

Session 来源通常不能被其他成员直接读取。项目或团队条目如果只有 Session 来源，审核时必须补充可共享证据或明确的人工验证说明。

## 8. 插件与 capability seam

最终 Bundle 建议包含以下包：

| 包 | 角色 | 职责 |
|---|---|---|
| `dsh-memory` | Service Definition | Memory 条目、候选、版本、查询、审核接口 |
| `dsh-memory-local` | Provider | `$DSH_HOME` 个人记忆、候选与本地 ledger |
| `dsh-memory-git` | Provider | canonical JSON 读取、验证、变更计划和投影写入 |
| `dsh-memory-extraction` | Consumer | durable 回合读取、明确表达规则、敏感信息门与提取断点 |
| `dsh-memory-recall` | Consumer | scope 解析、召回、预算与 durable Session 注入 |
| `dsh-knowledge` | Service Definition | Source、Document、Card、Index、Search 类型 |
| `dsh-knowledge-project` | Provider | 文件、Git、Session 的本地增量采集 |
| `dsh-knowledge-index-local` | Provider | FTS、symbol、graph 和索引代际 |
| `dsh-knowledge-wiki-model` | Service Definition | Wiki Run、Coverage、Claim、Citation、Conflict 和 Page 接口 |
| `dsh-knowledge-wiki-agent` | Consumer | 通过 durable DSH Agent 分层阅读原始材料、生成声明并执行覆盖审计 |
| `dsh-knowledge-wiki` | Consumer | 结构化 Wiki 运行与已审核 Knowledge 到 Markdown 的确定性投影 |
| `dsh-memory-tools` | Consumer | 面向模型的搜索与候选工具 |
| `dsh-memory-ui` | Consumer | Web/Electron UI、RPC 和 client module |
| `dsh-memory-knowledge` | Bundle | 默认组合与配置层 |

当前独立 Bundle 将这些职责合并在一个包内；`memory-knowledge-wiki-agent` 映射到 `dsh-plugin-memory-knowledge/wiki-agent-provider`，仍通过 `WikiGeneration` Service 与其他插件解耦。

Embedding 后续新增完整 seam：

```text
dsh-knowledge-embedding            Service Definition
dsh-knowledge-embedding-local      Local Provider
dsh-knowledge-embedding-remote     Remote Provider
dsh-knowledge-retriever-semantic   Consumer
```

不得把 embedding 方法加入 `ctx.llm`，也不得让核心 Memory API 依赖向量维度或具体模型。

## 9. 运行链路

### 9.1 候选形成

```text
durable turn/end
  → 后台读取本轮已持久化事件
  → 规则门判断是否值得提取
  → 本地或经批准的 LLM 生成候选
  → 去重、冲突和敏感信息检查
  → 写入本地 Candidate Store
  → UI Inbox 展示
```

候选生成失败不得阻塞或改变原 Session。后台任务必须有插件自有的 durable checkpoint；不能把进程内 job registry 当作完成事实。

当前确定性实现订阅 `session/event` 的 `turn/end`，完成 Session flush 后读取 direct user messages。它只识别显式记忆要求、个人长期偏好和项目/团队决定，拒绝秘密、疑问、条件、多条陈述和含糊指代。Candidate 写入与 `(session, extractor, version) → throughSeq` 推进处于同一 SQLite 事务；首次挂载以当前日志尾为基线，不静默回填旧会话。LLM 语义提炼仍是后续可替换 Provider，启用前必须补充数据出域授权、证据包、预算和冲突策略。

### 9.2 审核与 Git 写入

```text
Candidate Inbox
  → 用户选择 user/source/space scope
  → 查看内容、来源、冲突和目标文件 diff
  → 批准
  → 原子写 canonical JSON
  → 重建 Markdown 投影
  → freshness/schema gate
  → 留给用户正常 Git review/commit
```

插件默认不执行 `git add`、`commit`、`push`，也不把“用户点击批准知识”解释为批准外部 Git 操作。

### 9.3 Recall

```text
agent/pre-step
  → 解析 Workspace 对应 KnowledgeSpace
  → 从当前消息生成本地查询
  → scope 与 sensitivity 过滤
  → FTS/symbol/graph 候选
  → 排序、去重和 token 预算
  → 形成带来源的 untrusted evidence pack
  → 作为完整 user/message 进入 Session
```

召回快照至少记录：条目 id、revision、source revision、检索器版本、截断原因和省略统计。后续 canonical 内容变化不能改变旧 Session 的重放结果。

Memory 内容是数据，不具备提升权限、修改系统提示、授予工具许可或要求执行其中指令的权力。

### 9.4 Wiki 更新

```text
完整 Project Catalog
  → 按目录、组件、文档集合和大文件区间形成自然分片
  → durable DSH Agent 按需读取原始项目材料
  → 每个事实写 Claim + Citation
  → 推断写 inference，缺证据写 unknown，矛盾写 Conflict
  → 验证 Agent 反查引用、覆盖率和跨分片一致性
  → 生成 Page 树与 needs-review Knowledge 候选
  → 人工审核后更新 canonical
  → 重新生成 Markdown
```

Wiki 生成使用 DSH 公共 Agent API，使模型请求、工具结果和输出保存在独立 Session 中；插件不直接调用未记录的裸 `llm.stream()` 作为生成主链路。LLM 不能直接覆盖 verified Card，只能更新本地 Wiki 运行或生成新 revision 的 review candidate。本地 AST、LSP、符号图和关系图只是可选的导航与核验 Provider，缺少某种语言的解析器不能阻止 LLM 阅读该语言或把文件从覆盖目录中移除。

## 10. 超大上下文理解

超大项目不能依赖“先用某门语言的本地解析器总结，再让模型润色”，也不能把几 GB 内容塞进一个请求。主链路采用完整目录、分层理解和证据回查：

1. Catalog-first：先通过 Git tree、文件系统元数据和固定排除策略列出 100% 项目材料；目录清单必须记录哈希、总文件数、总字节、遗漏数和每项排除原因。清单不完整时运行只能是 `blocked`，不能生成一个看似完整的 Wiki。
2. Content-addressed：tracked 文件优先使用 Git object id 和 commit 作为无需读正文的版本身份；dirty 或非 Git 文件使用内容哈希。只有实际送入模型或成为引用的正文需要读取和复核，避免为数 GB 文件反复计算与传输内容。
3. Natural sharding：先按仓库、顶层区域、组件、文档集合和生成物类别形成自然分片；超过单次读取目标的 Git 文本再按无缝核心字节区间建立任务。区间优先使用换行并保证 UTF-8 安全，附带有界上下文，但不根据编程语言是否有本地 Parser，也不把结构边界冒充为语义结论。
4. Raw-source access：模型可以按需读取任何语言、配置、文档和未知扩展名的原始内容。FTS、AST、LSP、符号图和关系图只帮助定位、批量核验和节省 token，不是理解能力的前置条件。
5. Claim-first synthesis：每个分片输出结构化 Claim、Citation、Conflict 和 Unknown，不输出无法逐句追溯的长篇自由总结。事实与推断 Claim 必须引用已经分析、且位于本次完整 Catalog 中的具体文件或文档；路径、Source id 与 Git commit/content hash 必须匹配。`git-commit` 或 Session 自述只能作为背景，不能单独构成项目事实的支持证据。
6. Cross-shard verification：第二阶段 Agent 从项目级问题出发反向抽查原始文件，检查同名概念、跨模块关系、配置与实现、测试与生产代码之间的冲突。发现矛盾时保留双方来源，不能自行选一个“更像真的”。
7. Hierarchical pages：页面从已保存 Claim 组装。项目总览引用模块级 Claim，模块页引用文件级证据；上层页面不把下层摘要再次概括成没有原始引用的“摘要的摘要”。
8. Incremental invalidation：下一次只重跑 revision 变化、依赖证据变化、冲突受影响或验证规则升级的覆盖项和页面；未变化 Claim 通过内容身份复用，但其引用仍必须属于当前目录版本。
9. Durable execution：每个生成运行绑定独立 DSH Agent Session。模型看到的原文、工具结果、预算截断和输出均可恢复与审计，超时或进程退出后从本地 checkpoint 继续。

质量指标同时包括目录覆盖率、已分析字节、Claim 引用覆盖率、verified/uncertain/conflicted 比例、引用回查成功率、增量复用率和每个 verified Claim 的 token 成本。最大 prompt 长度本身不是质量指标。

## 11. 数据出域与安全默认

### 11.1 配置语义

```yaml
knowledge:
  generation:
    mode: manual
    llmRoute: current
  embedding:
    mode: disabled
  dataEgress:
    mode: ask
  sources:
    include: []
    exclude: []
```

- `dataEgress.mode`: `deny | ask | allow`。
- `deny` 下任何知识后台任务不得调用远程 Provider。
- `ask` 在首次发送、Provider 变化或数据范围扩大时要求确认。
- `allow` 只允许配置解析出的 Provider，不允许任意 URL。
- 本地 Provider 不可用时明确失败，不自动 fallback。
- deployment-varying 的条数、字节、token、并发、超时和 retention 全部是经过校验的配置，不写死在插件中。

### 11.2 默认排除

至少排除：

```text
.git/**
.env*
**/*.pem
**/*.key
**/*.p12
**/.credentials*
node_modules/**
lib/**
dist/**
coverage/**
.cache/**
.sessions/**
.storages/**
数据库、向量索引、模型文件和用户附件
```

文件名过滤之后仍需内容级 secret 检测。命中凭据、私钥、token 或连接串时默认拒绝进入知识语料；不能只靠 `.gitignore`。

### 11.3 Git 禁止项

个人记忆、候选、Session、SQLite、FTS 索引、embedding、Provider 缓存、遥测导出、凭据、本机路径和未分类附件不得写入 `.dsh/knowledge/`。

## 12. UI 信息架构

第一版新增“知识”入口，包含：

- Overview：索引状态、source revision、stale 数量、候选与冲突数量。
- Memory Inbox：候选内容、来源、目标 scope、冲突、批准和拒绝。
- Memory：已验证、冲突、废弃和删除条目列表与详情。
- Wiki：树状页面、事实/推断/未知/冲突状态、逐句来源和审核入口。
- Sources：仓库、模块、文档、commit 与索引状态。
- Recall Trace：一次模型请求召回了哪些版本、为何入选、token 与截断信息。
- Graph：模块、Card、Memory 与来源关系；第一阶段只展示确定性边。

所有视图显示 source ownership、provenance、evidence class、revision 和 stale/degraded 状态。UI 是只读投影加显式命令入口，不在浏览器端自行折叠 Session 或直接修改索引数据库。

当前实现先落在“设置 → 记忆与知识”，覆盖范围选择、Candidate Inbox、独立的个人/项目记忆、Source inventory、Source records 状态、模块关系分类计数、Card freshness、显式确定性 Card 候选生成、结构化 Evidence Pack 查询、有界静态模块 Graph，以及 LLM Wiki Run 覆盖/盲区摘要、显式计划入口和有界活动 Page 树。项目 Wiki 与 Agent 知识两个主视图读取同一项目选择和 EffectiveVersion；生效页面支持直接保存正文替换或追加说明，Host 以请求幂等键、选择修订和生效版本 CAS 建立不可变 HumanRevision 与新生效版。未初始化 canonical store 的项目被视为尚无知识，不作为 UI 读取错误。Host 使用严格 Typert 描述符校验输入和输出，浏览器只持有 Workspace id；本机项目根、完整逐文件 records、完整关系图与原始 Session id 不跨越 RPC，Evidence Pack 只投影命中的 portable path、行号、哈希和 Source revision，关系查询固定返回最多 120 条当前 checkpoint 边。Wiki 事实任务可以在模型侧使用有界的字面路径目录和大文件区间导航；导航不读取正文，不改变材料预算，也不授予跨任务 Citation 权限。Wiki 视图固定返回最新 20 个 Run header 摘要和最多 20 条阻塞原因；Page 树仅在用户显式请求后返回最多 100 个 Page、200 条 Claim、400 条 portable 来源和 20 条人工说明，并分别报告省略数量。本机项目根、完整 Coverage、候选对正文和 Agent Session id 均不进入浏览器。候选审核、晋升和人工修订使用 revision CAS，`restricted` 正文保持 CLI-only。Agent 默认知识查询、完整知识对象模型、整版停用/回退、跨版本三方合并、知识实体 Graph 和请求级召回时间线仍属于后续纵切。

## 13. 第一阶段纵切

### 13.1 范围

```text
Session/代码/Markdown/Git
  → 候选提取
  → Memory Inbox
  → 审核为 source/space memory
  → canonical JSON + Markdown diff
  → 本地 FTS
  → 自动有界 recall
  → Recall Trace
```

### 13.2 第一阶段非目标

- embedding 和向量数据库；
- 远程团队服务、账号、组织和 ACL；
- 第三方数据源；
- 无审核的项目/团队写入；
- AI 自动声明业务语义已经验证；
- 自动 Git commit/push；
- 为大上下文修改 AgentLoop 或 Session surface 语义。

### 13.3 验收标准

1. Bundle 能在隔离 profile 中安装、启动、禁用、更新和卸载；禁用后核心 DSH 会话仍可运行。
2. 单仓与多仓 Workspace 都能解析稳定 `KnowledgeSpaceId/SourceId`，本机路径不会进入 Git 文件。
3. 候选生成失败不阻塞 Session；候选默认本地，不进入 Git。
4. 审核动作产生可读的 canonical JSON 与确定性 Markdown diff，不执行 Git 命令。
5. schema/freshness gate 能拒绝无效 id、revision 回退、未知必需版本、失效来源与手改投影。
6. 删除条目后 FTS、UI 和 recall 均不可返回旧正文；tombstone 保留审计事实。
7. Recall 按 scope、sensitivity 和预算过滤，完整快照可从 Session 日志重放。
8. 被召回的代码、文档或记忆不能提升权限或绕过 approval/sandbox。
9. 默认配置不调用 embedding，不发送后台数据到远程 Provider；`ask` 能展示 Provider、文件数和字节数。
10. UI 在真实 Web 与 Electron 组合中验证，显示 provenance、revision、stale 和 degraded 状态。
11. keyless assembled-app snapshot 覆盖模型可见 recall；包测试覆盖持久化重启、Git round-trip、冲突、删除和预算。
12. tarball 不包含本机路径、凭据、候选、Session、索引或缓存。

## 14. 后续阶段

### Phase 2：知识库与 Wiki

已完成语言无关 Project Catalog、可验证大文件区间任务、durable Wiki Agent、Claim 生成与验证、有界递归文件综合、有界 Wiki Page 树、盲区审计、事实任务的有界目录/区间导航，以及已验证单一 Git 来源 Wiki Page 到 Knowledge Card 候选的可追溯桥接；跨任务授权读取和综合 Claim/Page 的跨 Run 复用继续留在本阶段后续纵切，verified 叶级 assertion 的证据匹配复用已实现。

### Phase 3：超大上下文

在已有多 GB Git tree catalog、可验证大文件区间任务和有界文件级综合之上，在任务级累计原文字节预扣之外，增加分层问题回查、Run 级 token 费用控制、跨仓任务调度、Claim 级增量失效、项目级交叉验证、知识实体 Graph 和质量评测集。基础的静态模块图与跨文件 symbol definition/reference retrieval 继续作为可选核验 Provider。

### Phase 4：语义检索

实现 embedding Service Definition、本地 Provider、远程 Provider、索引代际和显式数据出域策略。

### Phase 5：远程团队服务

只有在 Git 协作不足时才引入认证用户、组织、成员、ACL、租户隔离、同步、撤销和远程审计。

## 15. 当前实施基线

当前分支已经建立十九条纵切。

Canonical 纵切包括：

1. branded ids；
2. manifest、Memory Entry、Knowledge Card 的 schema；
3. canonical JSON reader 与安全初始化；
4. deterministic Markdown/schema projector；
5. freshness/schema CLI gate；
6. fixture repository 与 Git round-trip 测试。

本地运行时纵切包括：

1. `MemoryKnowledge` Service Definition 与 SQLite Provider；
2. Candidate Store、去重、人工接受/拒绝和仅限已接受候选的 Git 晋升；
3. FTS5 trigram、短查询 fallback、scope/sensitivity 过滤和 canonical fingerprint 同步；
4. 候选保存、检索和 Trace 工具；
5. `agent/pre-step` 有界 recall 及 durable `user/message`；
6. CLI 初始化、审核、晋升、检索与追溯；
7. macOS realpath、跨项目同 ID 隔离、restricted 默认拒绝和召回预算的回归测试。

可视化审核纵切包括：

1. Web/Electron 共用的 `dsh.client` 模块和“记忆与知识”设置页；
2. 候选状态过滤、展开审核、revision CAS、全局候选目标 Workspace 选择和晋升入口；
3. recallable Memory/Knowledge Card 列表、FTS 搜索与精确 Trace；
4. 手写严格 Typert Host/Client contribution，适配树外包而不依赖 monorepo generator inventory；
5. Host 侧 Workspace id 解析、路径与原始 Session id 投影、受限正文隔离和有界返回；
6. 隔离 Web profile 与发布用无端口 Electron 安装包的实际 tarball 装载、Source records 页面交互、无 TCP 监听，以及 profile 更新、禁用/恢复和卸载验证；当前宿主 pnpm 卸载后的断链 `.bin` 入口仍是待宿主清理的已知残留。

来源陈旧检测纵切包括：

1. 通过 DSH `fs` 与 `subprocess` 公共能力读取 manifest sources，不依赖 Harness 仓库内部路径；
2. Git tracked/untracked 文件集合、固定敏感路径排除、相对路径校验和文件/总量预算；
3. commit、branch、dirty 状态、语言边界、文件 SHA-256 与确定性 inventory hash；
4. 基于 `git-file`/`document` 内容哈希的精确 Card stale 检测，以及缺少文件证据时的 source revision fallback；
5. stale/degraded Card 在写 canonical 之前即退出召回，`stale --write` 显式生成下一 canonical revision 和 Markdown diff；
6. Web/Electron“来源状态”视图只投影 source 汇总与 portable stale 原因，不发送本机根路径或完整文件 inventory。

确定性 Knowledge Card 候选纵切包括：

1. 显式 `generate` 命令和来源页操作，为 clean、ready 的 Git Source 生成 overview/architecture/module 候选，并为最新 Wiki Run 中符合证据门槛的 Page 生成可审核候选；
2. generator version、Source id、inventory hash 与 generation key 组成持久化幂等 checkpoint，并发重跑和 rejected 历史不产生重复候选；
3. inventory hash 排除 commit 与 `.dsh/knowledge`，使相关源码内容保持不变时的知识提交不会制造伪陈旧；
4. Candidate target 显式区分长期记忆和 Knowledge Card，accepted Card Candidate 不进入个人记忆索引；
5. 晋升前重新核对 inventory、commit 与目标 Card revision，变化后要求重新生成和审核；
6. 新 Card 或下一 revision 在 canonical writer 锁内写入 `cards/`，随后重建 Markdown/schema 投影并同步本地索引。

Source records 纵切包括：

1. clean、ready inventory 确定性映射为按 portable path 排序的 records，记录内容哈希、大小、顶层区域、语言和路径可证明的工件角色，不保存文件正文；
2. 输出 hash 与包含 generator version、Source revision、inventory hash 和配置的 checkpoint key 分离，支持判断相同输入与相同输出；
3. SQLite 按本机项目路径和稳定 Source id 隔离当前 checkpoint，并在 inventory 变化时通过外键级联和事务原子替换 records；
4. durable payload 读取时重建派生区域、计数和哈希，拒绝未知、不完整或自相矛盾的记录；
5. 基于 records 生成 `architecture` 结构地图候选，按顶层区域展示语言、工件角色和有界代表文件，并明确不推断模块职责；
6. Host 默认只向 Web/Electron 投影 missing/current/stale、记录数、证据数、区域数和输出 hash；只有显式 Evidence Pack 查询会发送命中的 portable path，不发送完整 records 或本机项目根。

有界 Source evidence 纵切包括：

1. `SourceAnalysis` Service Definition、默认本地 Provider 和 Source inventory Consumer 组成可替换 capability seam；独立 CLI 复用同一确定性分析器；
2. 默认 Provider 使用 TypeScript Compiler API 解析 JavaScript/TypeScript 语法树，并识别 fenced code 外的 Markdown ATX 标题；
3. 文件读取继续受 inventory 字节预算、root containment、symlink 拒绝与 fatal UTF-8/NUL 检查保护；不支持的语言和非文本文件不产生 evidence；
4. Source records 只持久化 evidence 名称、声明类型、导出状态、所属容器、1-based 闭区间行号、遗漏计数和既有文件哈希，不复制源码正文或 excerpt；
5. `module` 候选按区域形成有界符号/标题索引，每个 section 使用精确 `git-file` 行号 provenance，并明确不推断职责、依赖或业务语义；
6. module generation key、Source-record output hash、审核、晋升、freshness 与 Wiki 投影复用现有候选状态机。

对话显式记忆提取纵切包括：

1. Bundle Consumer 订阅公开的 durable `turn/end` 生命周期，不修改 AgentLoop；
2. 只从 `source.kind=user` 的直接用户文本提取一条明确、自包含的记忆候选，不读取 assistant、tool 或 plugin 消息；
3. 第一版中英文规则覆盖“请记住/remember”、个人长期偏好和项目/团队决定或约束，并对问题、条件、否定、引用、复合陈述、含糊指代和疑似凭据执行保守拒绝；
4. 自动候选保留 Session event seq provenance，使用 `suggestedBy=conversation` 进入同一人工审核 Inbox，不自动接受、不召回、不写 Git；
5. SQLite schema v5 以 Session id、提取器和规则版本保存 `throughSeq`，候选保存与断点推进处于同一事务，跳过回合也会落断点；
6. Session 启动时以当前日志尾初始化基线，不回填旧历史；后台失败不影响 Session，未推进断点的回合会在后续触发时重试；
7. System Prompt 明确告诉模型不要为已由规则覆盖的表达重复调用 `memory_candidate_save`，工具仍处理未显式表达的高价值信息；
8. Web/Electron Candidate Inbox 显示“对话自动提取”来源，RPC 不暴露原始 Session id。

可查询 Evidence Pack 纵切包括：

1. SQLite schema v8 将当前 Source checkpoint 的代码符号与 Markdown 标题投影到独立文档表和 FTS5 trigram 索引，checkpoint 替换时在同一事务内替换派生索引；
2. SQLite schema v19 的 v3-v10 升级只清除可重新生成的 Source records、understanding checkpoint、evidence 索引、关系边和符号图；v11 升级保留当前 Source checkpoint，v12→v13 为旧 Wiki runtime 补建 analysis Task，v13→v14 为 Task 补充 kind/Claim 范围并把 verifying Run 迁移为可恢复 verification Task，v14→v15 为 Task 补充候选对并让已审核 Run 重新执行全局一致性召回，v15→v16 保留旧 Page 为 stale legacy 数据、从活动根移除并安排有界 Page 重建，v16→v17 为既有 Task 补充空材料区间并升级 Wiki runtime v6，v17→v18 为既有 Claim 补充空来源链、升级 runtime v7 并将文件级综合标记为未评估，v18→v19 补充综合层级和唯一来源任务、升级 runtime v8，历史递归仍标为未评估；候选、审核、记忆搜索与对话断点始终保持不变；
3. `SourceEvidencePack` 返回检索器版本、查询、总命中、省略数、截断原因、Source revision 和带 portable path/行号/哈希的结构化命中，不保存或返回源码正文；
4. `knowledge_search` 只从绑定 Workspace 的 Session 解析项目根，不使用 Host cwd fallback；工具输出标记为不可信背景证据，并受条数和字符预算限制；
5. Web/Electron 来源页通过严格 Workspace-id RPC 查询相同 Service，显示命中项的名称、类型、路径、行号、语言、工件角色、revision 和内容哈希，不暴露本机项目根；
6. 不同项目根、当前 checkpoint、result limit、character budget、schema rebuild 和 Host/browser 脱敏均有回归测试。

AST 代码符号增强纵切包括：

1. JavaScript、JSX、TypeScript 和 TSX 共用 TypeScript Compiler API 的只读语法树，不依赖 Harness 仓库内部模块或常驻语言服务器；
2. 提取顶层 class、function、interface、type、enum、namespace、variable、default/re-export，以及 class/interface/type/enum 成员；函数体局部声明不进入项目符号索引；
3. 每个代码证据记录精确声明类型、export/internal 状态、可选容器名和完整声明行区间，解构变量与匿名 default export 也有稳定名称；
4. 分析结果、Source record map 和 Evidence Pack 检索器分别具有显式版本；旧持久化分析不会按新结构静默读取；
5. FTS 文档、`knowledge_search`、module Card 和 Web/Electron 来源页投影同一结构化证据，检索与展示仍不返回源码正文；
6. 当前语法树 Evidence Provider 不运行 TypeScript type checker，也不生成调用图或依赖图；跨文件 definition/reference 由独立 `SourceSymbols` Provider 提供，语法证据与符号关系保持可替换。

Git diff 增量 Source inventory 纵切包括：

1. Source analyzer 公开稳定 `cacheKey`，inventory 将算法版本、全部扫描配置和分析器身份哈希为复用身份；身份变化时禁止沿用旧文件分析；
2. clean Source understanding 保存 commit、复用身份和逐文件 size/hash/language/analysis，既可在同一进程复用，也可在重启后从 SQLite 恢复；
3. 新检查使用 `git diff --name-status -z --find-renames --find-copies <base>..<current>` 获得无路径歧义的 tree diff；新增、修改、重命名和复制目标重新读取，删除路径从新集合消失，其余文件直接复用；
4. dirty 工作树、旧 commit 不可用、diff 非零或超预算、输出无法严格解析、扫描配置或分析器身份变化时安全退回全量扫描；
5. 增量与全量路径都列举当前文件集合，并从完整 files 重算 inventory hash、records、区域、checkpoint、候选输入和 Evidence FTS；冷启动全量扫描与增量扫描必须产生相同内容结果；
6. Host 只向 Web/Electron 投影 full/incremental、复用文件数和实际读取数，不发送 baseline、完整 records、项目根或 Git diff 路径集合；新增/修改/删除/重命名、dirty fallback、身份失配、进程重启和旧 evidence 清理都有回归测试。

静态模块关系与分层架构摘要纵切包括：

1. `SourceAnalysis` 在同一 TypeScript 语法树中有界提取静态 `import`、`import type`、重导出、字面量动态 `import()`、字面量 `require()` 与 `import = require()` specifier，非字面量与超预算项计入遗漏数；
2. `SourceRelations` Service Definition、默认本地 Provider 和 Source-understanding Consumer 组成可替换 capability seam；默认 Provider 不读取文件正文，只对当前完整 portable file set 解析关系；
3. 相对 specifier 按显式扩展名、`.js` 到 TypeScript 源、无扩展名和 `index` 候选解析；当前文件命中为 internal，包名为 external，找不到、越根或绝对路径为 unresolved，不猜测目标；
4. 关系图保存来源文件哈希、specifier、引用类型、解析类别、可选目标路径和精确行号，并聚合顶层区域之间的 internal 边；全局边数、逐文件引用数和 specifier 长度均有可配置预算；
5. SQLite schema v9 将关系边作为当前 Source checkpoint 的可重建派生索引原子替换；durable 读取重建计数、区域聚合与哈希并拒绝未知或矛盾字段；
6. 增量 inventory 可以复用未变化 importer 的 AST 结果，但每次都在完整当前文件集合上重算目标解析；目标改名后的 incremental 与 cold full 输出必须一致；
7. `architecture` Card 增加版本化的静态模块关系概览、区域关系聚合和有界逐区域边，每条展示边携带来源文件与精确行号 provenance，并明确不证明调用、运行时加载或业务职责；
8. Host/Web overview 只投影关系总数、internal/external/unresolved 分类与遗漏数，不随页面初始快照发送完整边；解析、持久化篡改、预算、目标改名、候选生成和浏览器脱敏均有回归测试。

有界关系查询与 Graph 可视化纵切包括：

1. `MemoryKnowledge` read API 按项目根、可选文本、来源顶层区域、解析类别和引用类型查询 `source_relation_edges`，只读取当前 Source checkpoint；
2. SQLite 使用参数化组合筛选和 `from_path`、行号、specifier、edge id 的稳定排序，返回检索器版本、Source revision、总命中、展示边、查询截断原因和 Provider 生成图时的遗漏数；
3. 严格 Host RPC 只接受 Workspace id 与筛选字段，项目根由 Host 解析，返回上限固定为 120，浏览器不能扩大预算或提交任意本机路径；
4. 浏览器投影只保留 portable path、哈希、revision、specifier、引用类型、解析类别和行号，源码中的绝对 specifier 被固定占位符替换；
5. 来源页进入项目范围后自动加载有界结果，并提供文本、区域、解析类别和引用类型组合筛选；Workspace 切换会使旧异步响应失效；
6. 图形层最多布局 80 个确定性排序节点，超出的已查询边仍保留在语义表格中；SVG 包含标题、说明、可聚焦节点和 internal/external/unresolved 图例，窄屏允许横向滚动；
7. 项目隔离、当前 checkpoint 替换、稳定截断、组合筛选、严格请求/响应、绝对路径脱敏、异步竞态、空结果和图/表呈现都有回归测试。

跨文件符号定义/引用查询与可视化纵切包括：

1. `SourceSymbols` Service Definition、默认 TypeScript Program Provider 和 Source-understanding Consumer 组成独立 capability seam，不把符号解析塞入模块关系 Provider 或 AgentLoop；
2. 默认 Provider 只读取当前 inventory 中受支持的 JavaScript/TypeScript 文件，通过 DSH `fs` 短暂取得正文并复核字节数与 SHA-256；durable checkpoint 不保存源码正文或 excerpt；
3. TypeScript Program 使用当前完整文件集合、type checker 和相对模块解析生成跨文件 definition/reference，记录稳定 symbol id、名称、声明类型、定义/引用 portable path、文件哈希、引用类别和精确行号；
4. 文件数、总字节、单文件字节、全局引用数、逐符号引用数和名称长度都有 Provider 配置预算；输出稳定排序并报告文件与引用遗漏；
5. SQLite schema v10 首次将 definitions 与 references 作为当前 Source checkpoint 的可重建派生索引原子替换；严格 durable 读取重建计数与哈希，拒绝未知、重复或与当前 records 哈希不一致的图；
6. `MemoryKnowledge` read API 使用参数化组合筛选与稳定排序，严格 Host RPC 只接受 Workspace id、文本、定义路径、引用路径和引用类别，浏览器不能提交项目根或扩大 120 条上限；
7. 来源页独立加载符号图，Workspace 切换会使旧响应失效；最多 80 个确定性节点进入可聚焦 SVG，全部已查询边保留在可展开语义表格，并分别显示查询截断与 Provider 预算遗漏；
8. Program 解析、内容竞态、预算、持久化篡改、schema v9 升级、项目隔离、checkpoint 替换、筛选、严格 RPC、浏览器脱敏、异步竞态和图/表呈现都有回归测试。

有界 TypeScript 项目配置解析纵切包括：

1. `SourceSymbols` 只从当前 inventory 识别并读取 `tsconfig*.json`，配置文件继续经过 Source root containment、普通文件检查、独立字节预算和 inventory SHA-256 复核；
2. TypeScript 原生配置解析器处理 JSON 注释、trailing comma、相对 `extends`、`baseUrl`、`paths` 与 project references；源码文件使用目录层级最近的已解析配置进行模块解析，但当前 Program 的 root files 仍是受预算的 inventory 源码全集，不实现 `files`、`include`、`exclude`、`composite` 或 solution build 语义；
3. Referenced project 必须位于同一 Source root，其配置与源码必须已经进入 inventory；缺失、越界、未纳入 inventory 或无效配置只产生有界诊断，不触发目录遍历或外部文件读取；
4. 配置数量、配置总字节与单配置字节使用独立 Provider 配置；预算不足时优先保留层级更浅的根 `tsconfig.json`，并将省略数与源码/引用省略分别报告；
5. 符号图格式 v2 保存解析模式、portable config paths、project-reference/path-alias/诊断/省略计数；Source record map v7 验证每个 config path 属于当前 records，SQLite schema v11 清理并重建旧 v10 checkpoint；
6. 符号查询协议 v2 将配置摘要随 Source revision 投影，严格 RPC 只允许 portable paths；来源状态与符号图显示默认/tsconfig 模式、配置数量、alias、project reference、诊断和预算省略；
7. `baseUrl/paths`、最近 project config、root 内 project references、缺失 reference、未配置 alias、配置预算、内容竞态、durable 不变量、schema v10 升级、RPC 和 UI 展示都有回归测试。

语言无关 LLM Wiki 运行与覆盖审计纵切包括：

1. `WikiRun`、`WikiCoverageItem`、`WikiCitation`、`WikiClaim`、`WikiConflict` 和 `WikiPage` 使用独立版本与 branded id；Page 仍只引用 Claim，不保存自由摘要，进入候选时也只复制已验证 Claim statement 与原 Citation；
2. 覆盖计划只依赖 Source id、portable path、字节数和 Git object/content hash，实际分析后另存复核过的 SHA-256；语言与工件类别只是可选元数据，Go、Rust、C#、Python、SQL 和未知扩展名使用同一状态机；
3. 目录清单完整性、遗漏数、逐状态文件数和总字节是持久化不变量；清单有遗漏时运行固定 `blocked`，不会把预算截断伪装成全项目理解；
4. assertion 与 inference 必须引用已分析 Catalog 项中的具体文件或文档，Source id、path 与 revision 必须相符；`git-commit` 和 Session 不能单独支持事实，inference 不能标成 verified，unknown 只能保持 uncertain，conflicted Claim 必须关联开放冲突；
5. Wiki Page 不保存独立摘要正文，只引用 Claim；eligible Claim 必须在任务树中恰好出现一次，页面状态由 Host 从直接 Claim 与子页面聚合，页面树拒绝环、多父节点、缺失节点和孤儿；
6. SQLite schema v19 按 Run 分表保存 coverage、tasks、citations、claims、conflicts 和 pages，候选对与召回原因保存在 durable consistency Task 中，材料区间保存在 analysis Task 中；保存时事务原子替换，读取时重建跨表关系、Task、区间汇总、文件级综合来源链、候选指纹、Page 覆盖和页面树并复核 snapshot hash；Wiki runtime 格式独立为 schema v8；v17→v18 迁移为旧 Claim 补充空来源链，并把旧 Run 标记为文件级综合未评估，不伪造历史运行完成了新阶段；
7. 每个自然分片映射为确定性 durable Task，保存状态、尝试次数、Agent Session id 与失败原因；同 Catalog 的失败或取消 Task 可以恢复和重试；
8. 超过区间目标的 Git 文本在规划时顺序流式校验 Git object id、完整 SHA-256、fatal UTF-8 与 NUL，并写入用户私有的 content-addressed 派生缓存；核心区间严格覆盖完整对象，每侧上下文只用于理解边缘。每个区间拥有确定性 `rangeId` 和独立 Task，全部区间成功前文件 Coverage 不得标为 analyzed；
9. `WikiGeneration` Provider 使用 public `@deepseek-ai/dsh-agent` 创建或恢复 Session，屏蔽全局工具，只注册当前阶段的上下文、材料读取和结构化提交工具；只有完整读取并复核实际字节数、Git object、SHA-256 和持久化区间身份的材料才能支持 assertion/inference，模型未提交时 Task 进入可审计 failed；
10. 全部 analysis Task 完成后，Host 为同一 ranged Coverage 中具有至少两个不同支持 `rangeId` 的原始 Claim 规划有界 `file-synthesis` Task；Claim 按数量和 statement 字符预算分批，并按主区间轮转混排。综合 Agent 必须回读每条输出引用的全部原始证据；输出必须消费至少两条非 unknown 输入 Claim、覆盖至少两个区间，并保持 inference 强度。每条输入必须明确保留或恰好消费一次，Host 拒绝遗漏、重复消费、额外 Citation 或缺失来源区间；原始 Claim 保留审计记录，但已消费项不再进入活动事实集合。多批完成后，存活声明按前层批次轮转进入更小的一层；终点和证据继承规则见[递归文件综合](runtime.md#递归文件综合)，停止时保留具体原因与盲区；
11. 文件级综合结束后，活动非 unknown Claim 按多个原分片轮转混排成有界 verification Task；核验 Agent 必须重新读取匹配原 supports Citation 的 Catalog 材料，综合 Claim 必须回读全部 supports Citation，区间来源必须使用同一 `rangeId`，才能提交 verified/uncertain/rejected/conflicted 结论。只有 assertion 可 verified，Conflict 必须同时保留 supports 与新回查的 contradicts Citation；
12. 全部 verification Task 成功后，Host 以共享 Coverage 与 Unicode statement key 召回不同批次间的候选对，并在 Claim 不重叠和配置预算内组成 consistency Task。候选对指纹覆盖规则版本、Claim、Citation 与 Coverage revision；规则只决定复核对象，语义结论仍由 Agent 读取原始材料后提交并由 Host 验证。任何截断或超大候选组都会把召回完整性标为 false，遗漏数量保持 unknown；
13. 全局一致性完成后，Host 按 Coverage 区域、Claim 数和 statement 字符预算生成 durable Page Task；Page Agent 只接收任务内 Claim 状态、正文与有界路径，不读取材料，也不能提交自由事实。模型只给出任务局部 slug、标题、Claim 引用与子页面关系，Host 负责验证恰好一次覆盖、生成稳定 id、聚合状态和唯一合成根；
14. `MemoryKnowledgeEngine.planWikiRun()` 提供底层持久化入口，`MemoryKnowledge.planWikiProject()` 接入 Git tree Catalog，严格 Host RPC 与设置页可以建立计划并执行下一个 analysis、file-synthesis、verification、consistency 或 page Task，并可显式加载有界活动 Page 树；新 Run 只在证据 identity 未变且支持 Citation 仍匹配时复用 verified 叶级 assertion，综合 Claim、Page 和 ranged Citation 仍重新生成。
15. 最新 Run 完成 Page 阶段后，`generate` 只把已验证 assertion、单一 Git source/commit 且 Coverage 哈希匹配的 Page 变成 `suggestedBy=wiki` Knowledge Card candidate；候选继续走 review/revision CAS/promote，不绕过人工审核。Wiki Page 使用当前 Page id 派生稳定 Card id，保证同一快照重复生成幂等。

无正文读取的 Git Project Catalog 纵切包括：

1. `KnowledgeProject.catalog()` 使用既有 DSH `fs`/`subprocess` 能力定位 Source root，并通过 `git ls-tree -rlz <commit> -- .` 获得 tracked path、mode、Git object id 和 blob size；Catalog 阶段不调用文件正文读取；
2. Catalog 默认最多接收 500 万项和 512 MiB Git 元数据输出，路径长度、深度、条目数、Git 输出和进程退出宽限均可在 `wikiCatalog` Provider 配置中调整；项目正文总字节数不作为 Catalog 阻断预算；
3. 每个 tracked 项形成语言无关 entry，语言只按扩展名附加为可选标签；未知扩展名照常进入，Git symlink 保留为 Git object，submodule 明确 `blocked` 并要求注册独立 Knowledge Source；
4. `.dsh/knowledge`、依赖/生成物/缓存目录、凭据路径、私钥/证书和本地数据库仍进入覆盖清单，但固定标为 `excluded` 并保存排除原因，既不读取正文，也不从覆盖审计中消失；
5. dirty 或 untracked 的当前 Workspace 不使用旧 HEAD 内容冒充当前状态；Catalog 标记 `incomplete`、遗漏数为 unknown，随后持久化的 Wiki Run 为 `blocked`。当前纵切尚未对变更文件执行流式 worktree hashing；
6. 多 Source manifest 逐 Source 建立 commit、entry count、total bytes 和 completeness；无效 Git 输出、不可移植路径和条目预算均成为显式 Issue，Catalog hash 不包含本机绝对路径；
7. `MemoryKnowledge.planWikiProject()` 作为 Consumer 将 Catalog 原子转换为 SQLite v19 Wiki Coverage Run；干净多语言 Source 得到 `planned`，任何未知盲区或 blocked entry 得到 `blocked`。
8. 同一 Catalog hash 复用最新 Run，失败或取消的 Task 在原 Run 内重试；Catalog 变化时，新 Run 仅复用 Source id、portable path 与 Git object/content hash 一致的 analyzed Coverage，变化项重置为 pending。新 Run 进一步只复用支持 Citation 全部匹配当前 Coverage、没有 `sourceClaimIds`/`sourceTaskId` 的 verified 叶级 assertion，并把它们绑定到新 Run 的 verification Task；综合 Claim、Page 和 ranged Citation 不跨 Run 复用，避免在新 revision 上保留未重新校验的旧引用。
9. `KnowledgeProject.readWikiMaterial()` 根据 Coverage 的 Git object id 流式读取不可变 blob，按固定字节预算重组块并计算 Git blob object digest 与完整 SHA-256；只有对象身份和字节数复核成功后才发出完成标记，worktree 后续变化不会改变本次材料。
10. `KnowledgeProject.prepareWikiMaterial()` 将超过默认 384 KiB 目标且不超过默认 8 GiB 上限的 Git UTF-8 文本准备为无缝核心区间，每侧默认保留最多 32 KiB UTF-8 安全上下文；`readWikiMaterialRange()` 从私有、可重建缓存随机读取准确范围，并同时返回区间哈希与完整对象哈希。
11. 新 Coverage 按 Source/顶层区域自然分组，再按默认 80 项和 256 KiB 的可配置元数据预算确定性分片；普通文件沿用自然分片，准备后的大文件改为每个核心区间一个 durable Task。文件 Coverage 只有在全部区间成功后才变为 analyzed；区间 Citation 保留 `rangeId`，核验必须回读同一区间。

当前实现尚未完成第一阶段全部范围。各事实阶段已有[任务累计材料读取账本](wiki-material-budget.md)，下一条主线是在递归文件综合之上增加分层问题回查与 Run 级 token 费用控制，再处理综合 Claim/Page 的跨 Run 细粒度复用；换行/UTF-8 区间只证明完整覆盖，不声称边界本身具有语义，单批文件综合也不冒充多批整文件理解。新的 Catalog Run 只复用证据 identity 未变且 Citation 仍匹配的 verified 叶级 assertion，综合 Claim、Page 和 ranged Citation 仍安全失效；候选指纹参与快照校验。UI 已投影运行覆盖率、Task 进度、大文件区间完成数与已分析字节、文件级综合完整性、排除项、未知盲区、全局候选对数量、Page 计划、召回完整性和阻断原因，能触发下一个 durable analysis、file-synthesis、verification、consistency 或 page Task，并显式加载带行号或核心字节范围、有省略计数的活动 Page 树。现有 TypeScript AST、关系和符号 Provider 保留为可选导航与核验能力，不再作为 LLM Wiki 支持语言的边界。多仓 Workspace 只读组合继续复用稳定 Source id。对话的隐含语义提炼必须建立在现有 durable checkpoint 上，并先定义冲突检测、敏感信息分类、数据出域批准和可解释来源。
