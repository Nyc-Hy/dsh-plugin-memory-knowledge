# dsh-memory-knowledge

DeepSeek Harness 的本地优先记忆与项目知识 Bundle。

本仓库的 `main` 分支已完成 canonical 数据层、具有修订生命周期的独立本机长期记忆、本地运行时、可视化审核、来源陈旧检测、确定性 Knowledge Card 候选生成、Source records、有界 Source evidence、对话显式记忆提取、可查询 Evidence Pack、AST 代码符号、Git diff 增量 inventory、静态模块关系与分层架构摘要、有界关系查询与 Graph 可视化、跨文件符号定义/引用查询与可视化、TypeScript 项目配置解析、语言无关的 LLM Wiki 运行与覆盖审计数据模型、无正文读取的 Git Project Catalog、有界 Wiki 覆盖/盲区 RPC 与可视化、不可变 Git object 流式材料读取、超大 Git 文本的可验证区间任务、基于多区间证据的有界文件级 Claim 综合、durable DSH Wiki Agent、有界跨分片 Claim 核验、跨核验批次的全局一致性候选召回，以及只组织 Claim 的 durable Wiki Page 生成与有界树形查看。长期目标是提供个人长期记忆、通过 Git 共享的项目与团队记忆、项目知识库、LLM Wiki、超大代码库的分层理解，以及带来源、版本和陈旧状态的可视化查看。

新的[记忆与项目知识产品设计](docs/product-model.md)定义独立入口、个人/项目记忆及其可视化、知识双视图、完整分析后自动可用与直接修改保存；[知识生命周期与实施设计](docs/knowledge-lifecycle.md)落实阅读证据、版本选择与停用/回退、人工修订及过期状态、关联查询、Git 共享规模、Run 预算和验收矩阵。当前页面已经将“记忆”和“知识”设为两个一级领域：记忆内部选择个人或项目范围，可直接新建、编辑、停用、删除、恢复长期条目并查看修订历史，同时保留独立候选审核；知识必须选择项目且只提供“项目 Wiki”和“Agent 知识”两个主 Tab；分析进度、来源、预算和历史通过知识域内的辅助面板访问。Wiki Run 同时投影保守的知识激活完成报告，缺少实际送模审计、项目问题清单或跨模块业务流程记录的旧 Run 不会被误自动发布。项目现在为每次分析保存显式选择代际，并已具备不可变 GeneratedVersion、EffectiveVersion 与原子生效指针；两个知识 Tab 按同一生效版读取，未生效时明确显示同一分析草稿。记忆条目纵切已经生效；生效 Wiki 页面支持无模型的人工正文替换和追加说明，每次保存形成不可变 HumanRevision，并通过 CAS 切换到包含该修订的 fixed EffectiveVersion。Wiki 完成证据、自动触发、正式结构化双视图对象、人工修订进入 Agent 默认查询以及完整版本治理仍按设计继续实现。既有架构与实现基线见 [docs/design.md](docs/design.md)，当前运行方式见 [docs/runtime.md](docs/runtime.md)。Wiki 各事实阶段的累计原文预扣、预算面板、停止与人工确认扩额见[材料读取预算](docs/wiki-material-budget.md)。

## 既有实现方向

以下描述已有实现与早期范围；后续产品行为以[新产品设计](docs/product-model.md)为准，知识可用不再以逐卡人工审核为前提。

- 对用户交付一个 Bundle，内部按 Service Definition、Provider、Consumer 拆分插件。
- 经审核的 Memory/Knowledge 使用结构化 JSON canonical；LLM Wiki 先保存本地 Claim、Citation、Conflict、Page 和 Coverage，Markdown/Wiki 与图形界面是可重建投影。
- 个人记忆只保存在 `$DSH_HOME`；项目与团队知识审核后进入 Git。
- Workspace 同时支持单仓和多仓；Git 中使用独立稳定的 Knowledge Space/Source id，不写入本机 Workspace id 或绝对路径。
- 文件解析、FTS、符号关系、Git 增量和索引默认本地运行。
- 第一阶段不依赖 embedding；远程 LLM 只用于显式允许的候选提炼、Wiki 生成和复杂总结。
- 数据出域确认绑定当前 Workspace 与单个 Wiki Task，默认 `ask`，禁止本地失败后静默远程 fallback。
- Wiki Task 的默认 `ask` 由设置页一次性确认、严格 RPC 确认位和 Provider fail-closed 共同执行；`deny` 不创建模型 Agent，`allow` 只跳过调用方确认。
- Wiki Claim 在 Git blob 未变时跨 commit 复用并重绑定引用；Wiki Page 按 Source id 与 slug 更新稳定 Knowledge Card，生成和晋升使用完整 Catalog，不受旧 Source inventory 正文总量预算阻断。
- 对模型实际注入的记忆必须作为完整、有来源的 Session 消息持久化。

## 第一阶段

第一阶段沿一条可验证纵切逐步交付：

```text
Session/代码/Markdown/Git
  → 记忆候选
  → 人工审核
  → canonical JSON + Markdown diff
  → 本地 FTS
  → 有界 recall
  → Recall Trace
```

embedding、远程团队服务、第三方数据源、无审核的团队写入和自动 Git commit/push 均不在第一阶段范围内。

## 仓库状态

已完成：

- 可独立安装、构建、测试和打包的 DSH Bundle；
- `KnowledgeSpaceId`、`KnowledgeSourceId`、`MemoryId` 与 `KnowledgeCardId`；
- manifest、Memory Entry 与 Knowledge Card 的 v1 JSON Schema；
- 带 schema 与跨文件不变量校验的 canonical reader；
- 确定性 Markdown/schema 投影和 freshness 检查；
- CLI、fixture repository、Git round-trip 与发布 tarball 冒烟测试；
- 本地 SQLite Candidate Store、候选去重、人工接受/拒绝与 Git 晋升状态机；
- FTS5 trigram 检索、项目作用域隔离、敏感内容默认过滤与 canonical 增量同步；
- `memory_candidate_save`、`memory_search`、`knowledge_search`、`memory_trace` 四个模型工具；
- `turn/end` 后从 direct user message 确定性提取“请记住”、长期偏好和项目决定，生成带 Session provenance 的本地待审核候选；
- SQLite schema v24 保存独立 MemoryEntry、不可变修订和对话提取断点、Source evidence FTS、可复用的 Source 扫描身份、当前 checkpoint 的静态模块关系边、跨文件符号定义/引用、TypeScript 配置摘要、本地 Wiki Run/Coverage/Task/Citation/Claim/Conflict/Page，以及独立的 GeneratedVersion、EffectiveVersion、HumanRevision 和项目选择指针；v3-v10 升级只清理旧 Provider 产生的可重建 Source records、FTS、关系边和符号图，v11 升级保留 Source checkpoint，v12→v13 在原 Run 上为可分析 Coverage 补建 analysis Task，v13→v14 为既有 Task 补充 kind/Claim 范围并补建 verification Task，v14→v15 为 Task 补充候选对并让已审核 Run 重新进入全局一致性召回，v15→v16 保留旧 Page 为 stale legacy 数据、从活动根移除并为已审核 Run 安排有界 Page 重建，v16→v17 为既有 Task 补充空材料区间并升级 Wiki runtime v6，v17→v18 为既有 Claim 补充空来源链并把文件综合完整性明确标为未评估，v18→v19 补充综合层级和唯一来源任务，历史递归完整性保持未评估，v19→v20 增加独立任务材料账本，v20→v21 增加版本和选择表且不追认任何旧 Run 已生效，v21→v22 把已接受或已晋升的记忆候选迁移为独立长期条目并保留审核关联，v22→v23 增加不可变人工知识修订链并把历史生效版迁移为空修订链，v23→v24 根据项目选择指针重建仅包含当前 EffectiveVersion Wiki Page 的派生本地全文索引；blocked Run 保持零 Task，候选、审核、记忆检索、对话断点和既有 Wiki 数据始终保留；
- `agent/pre-step` 自动有界召回，实际召回正文及来源作为 durable `user/message` 写入 Session；
- 候选、canonical Memory 与 Knowledge Card 的精确 Trace；
- 新项目安全初始化，以及候选列表、审核、晋升、搜索和追溯 CLI。
- Web/Electron 共用的设置页客户端模块，包含候选审核、长期记忆新建/编辑/停用/删除/恢复、修订历史、搜索和 Recall Trace；
- 严格 Typert Host RPC、Workspace id 到本机路径的 Host 侧解析、受限正文隔离和 revision CAS；
- 当前 v22 tarball 已在隔离 Web profile 完成安装、同版本不同路径更新和真实设置页验收；人工创建的独立个人记忆完成创建、编辑、停用、恢复和四版历史核对，SQLite 保持 active 检索文档。该无模型验收的边界见[v22 独立记忆发布物验收](docs/runtime.md#v22-独立记忆发布物验收)。
- 历史 v19/runtime v8 发布物完成隔离安装、更新、禁用和卸载启动验收；真实设置页验证递归进行中、共同审视完成和两种停止原因。宿主会话导出启动问题、卸载残留与无模型凭据的验证边界见[v19 发布物验收](docs/runtime.md#v19-发布物验收)。
- 历史 v18 tarball 已安装到全新临时 `DSH_HOME` 的隔离 Web profile；真实 Host 完成十个插件入口激活，包内 CLI 可以初始化临时 Git canonical、规划 Catalog，并与真实设置页读取同一份 SQLite schema v18/runtime v7 数据。随后仅通过 tarball public API 写入一个确定性状态机 fixture：同一 100 字节文件的两个区间分别生成一条带支持证据的原始 Claim，文件级综合消费两条来源并产生一条 inference，下游 verification Task 只接收该活动综合 Claim。页面显示“任务 3/4 完成”“大文件区间 2/2，已理解 100 B”“文件级综合 1 个文件、2 条输入、1 批，跨批完整”，操作切换为“核验下一批声明”；页面没有投影临时项目根或 Agent Session id，连接后控制台没有 warning/error。该无凭据 fixture 证明当时 tarball 的安装、Host 激活、public 状态机、v18 持久化、严格 RPC 和客户端投影，不证明真实模型已经正确理解材料。
- 前一版 v17 tarball 已安装到全新 `DSH_HOME` 的隔离 Web profile，并通过包内 CLI 与真实设置页读取同一份 SQLite。七项 Git fixture 含一个 556829 字节 UTF-8 文件；规划器建立 SQLite schema v17、Wiki runtime v6、一个 Run 和三个 analysis Task，其中两个区间 Task 的核心范围无缝覆盖 `[0, 556829)`，`0600` 私有缓存保存经过完整 Git object 与 SHA-256 校验的正文。CLI 规划后从 UI 再次刷新仍复用同一个 Run。页面显示“任务 0/3 完成”和“大文件区间 0/2，已理解 0 B”，没有投影临时项目路径或 Session id；本次连接建立后没有新增浏览器 warning/error。当前 DSH 产品分支自身的 Session 导出入口无法激活，验收 profile 只禁用了与本插件无关的 `session-log-download`，十个记忆与知识插件入口均保持启用。该无凭据 fixture 只证明当时发布物的安装、v17 持久化、语言无关区间规划、Host 脱敏投影和客户端展示，不证明当前发布物，也不证明模型已经理解区间内容。
- 较早的 Source records tarball 已在全新 `DSH_HOME` 的隔离 Web profile 中完成安装、同版本不同 tarball 路径更新、真实启动、9 插件显式禁用后的核心启动、恢复和卸载；profile manifest、Bundle 列表与插件安装目录在卸载后一致清理，卸载后的纯 DSH Web profile 可以重新启动。已安装 CLI 为含根/子项目配置的七文件 Git fixture 生成 SQLite schema v11、Source record map v7 与 symbol graph v2 checkpoint、3 条 Knowledge Card 候选、3 条模块关系边、3 个跨文件符号定义和 7 条引用；配置摘要为 3 个 `tsconfig`、1 个去重后的 path alias、1 个 project reference、0 个诊断。真实设置页加载两类有向图；符号图按 `greeting` 与“值引用”组合筛选后显示精确的 `1/1` 结果，浏览器控制台没有错误或警告。当前宿主的 pnpm 卸载仍会留下一个指向已移除插件目录的 `.bin/dsh-memory-knowledge` 断链符号链接；它不可执行且不影响纯 DSH 启动，但完整零残留卸载仍需宿主侧清理。此前发布物还通过发布用无端口 Electron 安装包装载、候选审核、全文搜索、Recall Trace 和 Source records 验证。
- 前一版十插件 tarball 另在第二个全新 `DSH_HOME` 的隔离 Web profile 中完成安装、最终配置合成和真实 Host/client 装载。干净 Git fixture 同时包含未知扩展名与 Go 文件；设置页建立的 Catalog 覆盖 7 个 tracked 项，其中 2 个 pending、5 个 canonical/schema 投影显式 excluded，并形成 1 个可执行 Task。SQLite 实例为 schema v13，存在 `wiki_tasks`；未配置模型凭据时，点击“分析下一个分片”会把 Task 持久化为 failed，保存 `attemptCount=1`、Agent Session id 和 `MISSING_CREDENTIAL` 原因。Host 重启后页面仍恢复相同 failed Task 且允许重试。该证据验证安装、装载、Catalog、UI、失败持久化与恢复，不冒充真实模型 Claim 生成成功。
- 历史 v15 发布物曾安装到全新隔离 Web profile，并从 schema v15 SQLite 恢复一个含 2 个 succeeded analysis Task、2 个 succeeded verification Task 与 1 个 planned consistency Task 的 `verifying` Run。真实设置页显示“任务 4/5 完成”“全局候选 1 对，召回有遗漏且数量未知”和已启用的“核验下一组全局候选”；页面正文未出现项目绝对路径、Claim marker、Agent Session id 或完整候选指纹，成功读取后没有新增 warning/error。该 fixture 的 Claim 与任务由本地确定性状态机预置，只验证当时 tarball、Host 投影、v15 持久化、召回不完整语义和 UI 阶段切换；真实模型全局核验成功仍需受控凭据后单独验证。
- 上一版 v16 发布物已在全新临时 `DSH_HOME` 的隔离 Web profile 中完成安装、显式禁用全部十个插件后的核心启动、恢复、同版本不同 tarball 路径更新、更新后启动、卸载和卸载后的纯 Web 启动；profile manifest、Bundle 列表、插件目录和 reload token 按生命周期变化，卸载后仍存在宿主 pnpm 产生的不可执行 `.bin/dsh-memory-knowledge` 断链符号链接。发布物公开状态机写入的 schema v16/runtime v5 fixture 含 1 个 `needs-review` Run、2 个 succeeded Page Task、3 个活动 Page、2 条 conflicted Claim 和 1 条 uncertain unknown Claim。真实设置页先显示“任务 4/4 完成”“Wiki 页面任务 2 个，组织 3 条 Claim”，用户点击“查看 Wiki 树”后才加载 3 个页面；合成根无自由摘要，冲突、未知和 `README.md:1-8` portable 来源可见，页面正文不含临时项目绝对路径或 Agent Session id，加载后没有新增 warning/error。该 fixture 只证明当时 tarball、v16 持久化、Host 脱敏投影和 UI 组织语义，不证明当前发布物，也不冒充真实模型 Page 组织质量。
- 通过 DSH `fs`/`subprocess` 公共能力执行的受预算 Source inventory，记录 Git revision、工作树状态、文件边界、语言和 SHA-256 内容指纹；
- 基于具体证据文件哈希的 Knowledge Card 陈旧检测、显式 canonical `stale` 写入和陈旧 Card 召回隔离；
- “来源状态”页面，显示 source revision、文件规模、扫描完整性及 Knowledge Card 的 fresh/stale/degraded 状态。
- 从干净、完整的 Source inventory 显式生成项目源码概览 Card 候选；generation key、inventory hash 与 Source revision 使重跑幂等且可追溯；
- 候选目标显式区分长期记忆与 Knowledge Card，后者审核后写入 `cards/` 和 Wiki 投影，不会误落为 Memory Entry；
- 来源在审核后发生变化时拒绝晋升；只改动 `.dsh/knowledge` 不会让来源内容锚点失效；
- 来源页面可触发生成，Candidate Inbox 显示目标类型与 `Source inventory` 生成来源。
- clean Source inventory 会确定性映射为带内容哈希、顶层区域、语言和工件角色的本地 Source records；SQLite checkpoint 按项目与 Source 隔离，并在 inventory 变化时原子替换；
- 可替换的 `SourceAnalysis` Service 由默认本地 Provider 使用 TypeScript Compiler API 提取 JavaScript/TypeScript 模块级声明、成员、导出状态、容器名和完整行范围，同时解析 Markdown ATX 标题；
- 同一语法树还提取静态 `import`、`import type`、重导出、字面量动态 `import()`、`require()` 和 `import = require()` 的模块 specifier；逐文件引用数量与 specifier 长度受 Provider 配置限制；
- 可替换的 `SourceRelations` Service 在完整当前文件集合上解析相对 specifier，区分内部、外部和未解析边，聚合顶层区域关系；不读取文件正文，也不运行 TypeScript type checker；
- 可替换的 `SourceSymbols` Service 使用 TypeScript Program 和 type checker 在当前 JavaScript/TypeScript 文件集合中解析有界跨文件 definition/reference；它从 inventory 中有界读取 `tsconfig*.json`，支持 `baseUrl`、`paths`、相对 `extends` 和 Source root 内的 project references，并向设置页投影配置模式、数量、alias/reference、诊断与预算省略摘要；分析期间通过 DSH `fs` 短暂读取正文并复核 inventory 哈希，checkpoint 只保存符号、配置摘要、portable path、行号和文件哈希；
- clean Git Source 会持久化分析器与 inventory 配置身份；后续检查通过 `git diff --name-status -z` 只重新读取新增、修改和重命名目标，未变化文件直接复用旧哈希与 AST 结果，进程重启后仍可从 SQLite checkpoint 恢复；
- dirty 工作树、旧 commit 不可用、diff 不完整或分析器/预算配置变化时自动退回全量扫描；最终 inventory hash、Source records、区域聚合、候选 generation key 和 Evidence FTS 始终从完整的新文件集合重算；
- Source records 只保存 evidence、模块 specifier、1-based 行号、遗漏计数和文件哈希，不复制文件正文；同一次生成会形成 `overview`、`architecture` 和 `module` 三类候选；
- `architecture` 按 portable path 聚合区域、代表文件和有来源的静态模块关系概览，并为区域列出有界关系边；`module` 只索引 AST 声明/标题所在文件与行号。两者都不把语法边或声明名称推断为模块职责、调用关系、运行时加载顺序或业务语义；
- 来源页面显示 Source records 的 missing/current/stale 状态、记录数、证据数、区域数、模块关系分类及遗漏数，以及本次扫描是全量还是增量、复用和实际读取的文件数；Host 不把完整逐文件 records、完整关系图或项目绝对路径发送到浏览器，只按 Workspace 和筛选条件返回最多 120 条当前关系边。
- SQLite 将当前 checkpoint 中的 AST 代码符号和 Markdown 标题投影到独立 `source_evidence_fts` 索引；checkpoint 原子替换时同步替换索引，代码符号保留 declaration、模块导出状态和可选容器名；
- `knowledge_search` 只从绑定 Workspace 的 Session 解析项目根，返回带 portable path、精确行号、文件哈希、Source revision、遗漏数和截断原因的不可信 Evidence Pack；不会从 Host cwd 猜测项目；
- “来源状态”页可以按符号、标题、路径、区域或语言查询结构化 Evidence Pack，浏览器只收到命中项，不收到项目根或完整文件清单。
- 同一页面会自动加载当前项目的有界静态模块关系，可以继续按来源路径/specifier、顶层区域、internal/external/unresolved 和引用类型筛选；SVG 有向图与可展开的关系表使用同一结果，查询上限省略数与 Source 分析预算省略数分开显示。
- 同一页面还会独立加载当前项目的跨文件符号定义/引用图，支持按名称、声明类型、定义路径、引用路径和 import/export/type/value 类别筛选；可聚焦 SVG 与语义表格共享同一有界结果，Workspace 切换会丢弃旧异步响应。
- LLM Wiki 覆盖计划不依赖语言 Parser，只按稳定 Source id、portable path、字节数和 Git object/content hash 跟踪项目材料；语言与工件类别只是可选元数据，未知扩展名也进入覆盖清单。事实任务可以用有界的 `wiki_catalog_search` 按字面路径分页定位文件，再用 `wiki_catalog_ranges` 查看大文件区间元数据；目录结果不读取正文，也不授予任务外材料的读取或引用权限。
- Wiki assertion 与 inference 必须引用已分析 Catalog 项中的具体文件或文档，并匹配 Source id、path 与 revision；`git-commit` 或 Session 不能单独支持项目事实。unknown 和 conflict 具有独立状态，Page 只组织 Claim，不能保存脱离引用的自由事实摘要。
- 目录清单承认任何遗漏时，Wiki Run 固定为 `blocked`；SQLite 按 Run 原子保存并严格重建覆盖项、分片任务、引用、声明、冲突和页面，读取时复核跨表关系、Task 汇总与 snapshot hash。
- `KnowledgeProject.catalog()` 通过 Git tree 元数据取得 tracked path、object id 和 blob size，不读取 tracked 文件正文；默认 500 万项/512 MiB Git 元数据上限均可配置，项目正文总字节数不阻断 Catalog。
- `KnowledgeProject.readWikiMaterial()` 按 Catalog 保存的 Git object id 流式读取不可变 blob，不读取可能已经变化的 worktree 路径；默认重组为 64 KiB 有界块，单个对象上限 8 GiB，并且只在字节数、Git blob object id 与完整 SHA-256 都复核后发出完成标记。
- 超过默认 384 KiB 区间目标的 Git 文本在规划阶段顺序流式校验一次，写入用户私有的 content-addressed 派生缓存，并按换行优先、UTF-8 安全的核心字节区间切分；每侧默认附带最多 32 KiB 上下文。核心区间无缝覆盖整个文件，上下文只帮助理解边缘，不能支持“整文件不存在其他定义或例外”的结论。
- 排除目录、凭据路径和插件 canonical 文件仍显示为带原因的 `excluded` Coverage；unknown extension 正常进入，Git submodule 变为显式 `blocked`。dirty/untracked Workspace 不读取旧 HEAD 冒充当前项目，而生成 omission count unknown 的 blocked Run。
- 设置页新增 `LLM Wiki` 视图；它可通过 Workspace id 创建 Catalog/Run、触发或恢复下一个 durable 分析、文件综合、核验、一致性或 Page 任务，并按阶段显示对应操作。分段覆盖条、Task 汇总、大文件区间完成数与已分析字节、文件综合文件数/输入数/批次数及跨批盲区、Page 计划和一致性摘要显示 pending/analyzed/excluded/blocked/stale、目录遗漏、候选对数量、召回完整性和阻断原因。Wiki 树对区间来源同时投影 portable path、行号和核心字节范围。Host 固定只投影最新 20 个 Run 摘要，不发送项目根、完整 Coverage、Claim 来源链、候选对正文或 Agent Session id。
- 重复规划相同 Catalog 会返回已有 Run，包括失败或取消后可重试的 Task；Catalog 变化时，新 Run 按 Source id、portable path 和 Git object/content hash 复用已分析 Coverage，只把内容变化的项目重置为 pending。新 Run 只复用证据仍匹配的 verified 叶级 assertion 及其 Citation，并为它们重新规划核验；综合 Claim、Page 和带 `rangeId` 的 Citation 不跨 Run 复用。
- Coverage 默认先按 Source 与顶层区域分组，再按最多 80 项/256 KiB 元数据预算确定性分片；`wikiShardMaxItems` 和 `wikiShardMaxBytes` 可配置。超过材料区间目标的 Git 文本改为每个核心区间一个确定性、可恢复的 analysis Task；只有全部区间成功，文件 Coverage 才变为 analyzed。切分不根据编程语言或是否存在 Parser；换行/UTF-8 边界只证明完整字节覆盖，文件级语义由后续证据综合任务单独形成。
- 每个自然分片拥有确定性 analysis Task id、状态、尝试次数和 durable Agent Session id。全部 analysis Task 完成后，Host 只为拥有至少两个有 supports Claim 的材料区间的大文件规划 file-synthesis Task；每条输入 Claim 必须显式保留或只被一条新 Claim 消费，新 Claim 必须复用每条来源 Claim 的 supports Citation、覆盖至少两个不同 `rangeId`，并记录 `sourceClaimIds` 与 `sourceTaskId`。综合 Agent 必须重新读取全部采用的区间；如果任一来源是 inference，结果不能升级为 assertion。单任务默认最多 16 条 Claim 和 64000 个 statement 字符；多个批次完成后，Host 把存活声明交错编入更小的一层，默认最多 8 层；单批共同审视后结束，批次数未减少或达到层数上限时明确保留盲区。递归输入、预算、停止原因和来源链均持久化，详见[递归文件综合](docs/runtime.md#递归文件综合)。文件综合完成后，活动的非 unknown Claim 才按多个原分片轮转混排成可配置大小的 verification Task；被综合消费的原始 Claim 留在账本供审计，不重复进入验证或 Page。批次核验全部成功后，Host 以共享 Coverage 和 Unicode statement key 召回不同批次间的候选对，按确定性预算组成互不重叠的 consistency Task；这些规则只决定复核对象，绝不决定相关性、冲突或真伪。每个候选对保存 Claim、Citation、Coverage identity 和规则版本的指纹，预算截断或超大候选组会把召回完整性标为 false，遗漏数量保持 unknown，不能被解释为“项目中没有其他冲突”。分析、文件综合与两级核验 Agent 都使用当前默认模型、屏蔽全局工具，只暴露阶段专用的上下文、不可变材料读取和结构化提交工具。普通 Claim 核验至少重新读取一项与原 supports Citation 匹配的 Catalog 材料；综合 Claim 核验必须回读它保留的全部 supports 区间。只有 assertion 可以 verified，冲突必须同时保留 Claim 与 supports/contradicts Citation。全局一致性完成后，Host 按 Coverage 区域与 Claim statement 字符预算生成 durable Page Task；Page Agent 只能读取有界 Claim 上下文并提交 slug、标题、Claim 引用和子页面关系，不能读取材料或生成自由事实。Host 验证每条 eligible Claim 恰好被组织一次，生成稳定 id、聚合状态和唯一合成根。完成、失败和重试都通过 snapshot CAS 持久化，后续阶段失败不会回滚已完成工作。

尚未实现 dirty/untracked 文件的流式 worktree hashing、非 Git 文档 Catalog Provider、跨文件的分层问题回查、派生材料缓存清理、对隐含对话信息的语义提炼、LSP Provider、调用图、package exports/外部依赖定义解析、跨 Source root 的 project references、跨仓 Workspace 组合器、知识实体 Graph 和 embedding。当前 Catalog 以有界内存收集 Git 元数据，适合正文数 GB但路径元数据仍在配置上限内的项目；超大文件数项目后续需要流式 Git record decoder。递归综合已支持多批归并和明确停止原因；共同审视不代表语义无误差，任务级累计原文字节预算已持久化，重复读取、失败、恢复和重试不清零；它不限制整个 Run 的模型输入、输出或实际 token 费用。活动 Wiki 树已经支持显式、有界查看：最多投影 100 个 Page、200 条 Claim 和 400 条来源，每条 Claim 最多 8 个来源，正文最多 1000 字符；任何省略都单独计数，不伪装成完整召回。新的 Catalog Run 只复用内容 identity 未变且 Git/document Citation 仍与当前 Coverage 匹配的 verified 叶级 assertion；综合 Claim、Page 和带 `rangeId` 的 Citation 会在新 Run 重新生成和核验。既有 TypeScript AST、模块关系图与符号引用图只是可选导航和核验索引，不是支持语言边界，也不能冒充调用关系、运行时依赖、模块职责或业务语义。目录导航支持按字面路径分页和大文件区间元数据查看；已验证、单一 Git 来源的 Wiki Page 可进入 Knowledge Card 候选审核和晋升，但任务外材料授权读取仍未提供。当前对话提取器只接受单条、明确、自包含且未命中敏感信息门的直接用户表达；这些能力不修改 AgentLoop。

## CLI

```sh
dsh-memory-knowledge init <project-root>
dsh-memory-knowledge validate <project-root>
dsh-memory-knowledge project <project-root> --write
dsh-memory-knowledge check <project-root>
dsh-memory-knowledge inventory <project-root>
dsh-memory-knowledge generate <project-root>
dsh-memory-knowledge wiki-plan <project-root> [--db <path>]
dsh-memory-knowledge stale <project-root> [--write]

dsh-memory-knowledge candidates <project-root> --status pending
dsh-memory-knowledge accept <candidate-id>
dsh-memory-knowledge reject <candidate-id>
dsh-memory-knowledge promote <candidate-id> <project-root>
dsh-memory-knowledge search "查询内容" <project-root>
dsh-memory-knowledge trace <candidate-or-memory-id> <project-root>
```

`wiki-plan` 只构建 Git Project Catalog 并持久化初始 Coverage Run，不读取文件正文，也不调用模型。工作树有变更、Catalog 超预算或存在必须拆成独立 Source 的 Git submodule 时，命令保存可审计的 blocked Run 并返回非零状态。

`generate` 只处理工作树干净、扫描完整的 Git Source。它先保存或恢复确定性 Source records checkpoint，再生成或恢复 `overview`、`architecture` 与 `module` 三类幂等 Knowledge Card review candidate；如果最新 Wiki Run 已完成 Page 阶段，还会把满足“已验证 assertion、单一 Git source/commit、可匹配 Coverage 哈希”的 Page 生成 `suggestedBy=wiki` 候选，逐条保留 Claim 的 Git 文件行号 provenance；不满足证据条件的 Page 会明确跳过。长期记忆候选在 `accept` 后原子创建独立本机 MemoryEntry，由该条目参与本地召回；Knowledge Card 候选必须继续 `promote`，才会进入 canonical Card 和知识兼容层。`memory_search` 与自动召回只读取记忆，不把兼容 Card 注入模型。`promote` 只接受已审核候选，并只写 canonical JSON 与确定性投影，不执行 `git add`、`commit` 或 `push`。`restricted` 候选只保存在本地，不进入默认召回，也不能晋升到 Git。

项目数据位于 `<project-root>/.dsh/knowledge/`。`manifest.json`、`entries/*.json` 和 `cards/*.json` 是 canonical；`wiki/` 与 `schema/` 是可重建投影。个人候选、SQLite 和 FTS 索引默认位于 `$DSH_HOME/memory-knowledge/`，不得提交 Git。`project --write` 不会删除意外文件，`check` 会把它们报告为 drift。

本仓库是该插件的独立源码仓库。当前以私有 GitHub 仓库协作，npm、GitHub Release 或其他分发方式将在发布策略确定后单独设计。
