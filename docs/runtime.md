# Memory & Knowledge 运行说明

本文记录现有运行时。记忆与知识已拆分为独立入口，本机长期记忆已具备独立条目、修订及生命周期；生效 Wiki 页面可以保存人工正文替换或追加说明，并形成新的生效版本。Agent 可以在显式项目与 Provider 授权下查询包含人工修订的当前生效版本；完整 Wiki 分析自动可用和正式结构化双视图仍按[产品设计](product-model.md)及[知识生命周期与实施设计](knowledge-lifecycle.md)继续实现。

当前运行时是一条本地优先纵切：系统在回合结束后从明确的用户表达生成长期记忆候选，模型也可以提交候选；候选被接受时原子创建独立、立即生效的本机 MemoryEntry，用户也可在设置页直接新建个人或项目记忆，编辑、停用、删除与恢复均生成不可变修订。Source inventory 可以显式构建本地 Source records 并生成确定性 Knowledge Card 候选。晋升到 Git canonical 的旧 Knowledge Card 只出现在知识兼容层的显式浏览与搜索中。`memory_search` 只查询记忆；`agent/pre-step` 独立查询生效记忆，并在项目根和最终 Provider 都被显式允许时查询当前 EffectiveVersion。实际注入正文、来源、对象版本和预算随 Session 持久化。

## 安装组成

Bundle 的 `cordis.patch.yml` 插入十个插件：

1. `memory-knowledge-source-analysis`：提供可替换的本地代码/文档解析 Service，默认使用 TypeScript Compiler API 提取 JavaScript/TypeScript AST 模块符号，并解析 Markdown ATX 标题。
2. `memory-knowledge-source-relations`：提供可替换的跨文件模块关系 Service，默认只根据当前完整文件集合解析语法层模块 specifier。
3. `memory-knowledge-source-symbols`：提供可替换的跨文件符号 Service，默认使用 TypeScript Program 和 type checker 解析当前项目内的有界 definition/reference。
4. `memory-knowledge-inventory`：通过 DSH `fs` 与 `subprocess` 公共能力读取 Git revision、文件边界、内容指纹和有界 Source evidence；clean revision 之间使用 Git tree diff 复用未变化文件。
5. `memory-knowledge-provider`：拥有本地 SQLite、Candidate Store、FTS 与 canonical 同步。
6. `memory-knowledge-wiki-agent`：使用 public DSH Agent 与 durable Session 执行或恢复一个有界分析、文件级综合、核验、一致性或 Page Task；事实阶段只暴露对应的 Wiki 上下文、不可变材料读取和结构化提交工具，Page 阶段只能读取有界 Claim 上下文并提交组织关系。
7. `memory-knowledge-conversation-extraction`：在 durable `turn/end` 后提取明确记忆表达，并原子推进本地回合断点。
8. `memory-knowledge-ui`：提供严格 Typert Host RPC，并使包根进入 DSH 客户端模块发现清单。
9. `memory-knowledge-recall`：根据当前用户消息分别执行记忆和生效项目知识的有界自动召回，并在模型请求前检查项目与 Provider 出域授权。
10. `memory-knowledge-tools`：注册候选保存、主动搜索和来源追溯工具。

Provider 默认将私有数据库写到 `$DSH_HOME/memory-knowledge/memory.sqlite`。可以在 Cordis 配置中为 Provider 指定 `path` 和 `journalMode`；自定义路径仍应位于非 Git 的用户私有目录。`wikiShardMaxItems` 和 `wikiShardMaxBytes` 分别控制自然分片的项目数和元数据字节预算，默认为 80 项和 262144 字节。Inventory Provider 的 `wikiMaterial.chunkBytes`、`maxMaterialBytes`、`rangeTargetBytes`、`rangeContextBytes`、`stderrMaxBytes` 和 `processGraceMs` 控制不可变 Git object 的流式读取与区间准备，默认依次为 65536 字节、8 GiB、393216 字节、32768 字节、65536 字节和 3000 毫秒。Wiki Agent 的 `maxMaterialBytes`、`maxOutputTokens`、`toolTimeoutMs` 和 `verificationBatchClaims` 默认分别为 524288 字节、16384 token、120000 毫秒和 16 条 Claim；单条 Claim statement 最多保存 20000 个字符。`rangeTargetBytes + 2 × rangeContextBytes` 必须不大于 Inventory 的 `maxMaterialBytes`，并应不大于 Wiki Agent 的 `maxMaterialBytes`；默认单区间最多 458752 字节。`fileSynthesisMaxClaimsPerTask`、`fileSynthesisMaxStatementCharactersPerTask` 和 `fileSynthesisMaxLevels` 默认分别为 16 条输入 Claim、64000 个 statement 字符和 8 层；规划时把预算写入 Run，恢复和递归不读取新配置覆盖既有预算。`consistencyMaxClaimsPerTask`、`consistencyMaxCandidatePairs`、`consistencyMaxClaimsPerRecallKey` 和 `consistencyMaxRecallKeysPerClaim` 默认分别为 12、256、32 和 32。`pageMaxClaimsPerTask` 和 `pageMaxStatementCharactersPerTask` 分别把 Page 任务限制为 16 条 Claim 和 64000 个 statement 字符。超过区间目标的有效 UTF-8 Git 文本进入可恢复区间任务；非 Git、非 UTF-8、包含 NUL 或超过流式准备上限的材料显式 deferred。区间大于 Agent 读取上限属于配置错误并直接失败，不会截断后生成事实；一致性候选超过任一召回预算时显式报告不完整，不把截断解释为无冲突。

本地 SQLite schema v26 使用独立的 MemoryEntry 与不可变修订表、Source evidence 文档表、FTS5 trigram 索引、Source relation edge 表、Source symbol definition/reference 表、Wiki run/coverage/task/citation/claim/conflict/page 表，以及项目知识 GeneratedVersion、EffectiveVersion、HumanRevision 和选择指针表，并在 Source understanding 中保存 inventory、分析器、关系 Provider、符号 Provider 与 TypeScript 项目配置摘要。v3-v10 数据库升级时删除可由 Source inventory 重建的旧 Source-understanding、record、evidence、relation 与 symbol checkpoint；v11 升级保留当前 Source checkpoint；v12→v13 为旧 Wiki runtime 补建 durable analysis Task；v13→v14 为 Task 补充 `analysis|verification` kind 和 Claim 范围，并为既有 verifying Run 生成可恢复的 verification Task；v14→v15 为 Task 补充候选对并让已审核 Run 重新执行全局一致性召回；v15→v16 将旧 runtime 升为 v5，保留既有 Page 为 stale legacy 数据并从活动根移除，为已审核 Run 安排有界 Page 重建；v16→v17 将旧 runtime 升为 v6，为既有 Task 补充空 `materialRanges` 并重算区间汇总；v17→v18 将 runtime 升为 v7，为 Claim 补充空来源链，并把历史运行标记为文件级综合“未评估”，不伪造旧运行已经完成的新阶段。迁移保留 Coverage、Citation、Claim、Conflict、Page、候选、审核状态、对话提取断点和记忆检索文档，并在同一事务内重算 snapshot hash。未知、更旧或更高的 schema 版本继续拒绝加载，不猜测迁移。v18→v19 把 runtime 升为 v8，为历史综合任务补充首层批次信息并为综合 Claim 绑定唯一来源任务；保留既有下游任务，递归完整性标记为 unassessed，不追认历史运行经过新规则。v19→v20 增加独立的任务材料读取账本，不改写既有 Wiki 快照；历史读取量保持未知。v20→v21 增加不可变知识版本与项目选择表；旧数据库升级后不创建虚假 GeneratedVersion 或 EffectiveVersion，也不把历史 Run 追认为正式知识。v21→v22 为已接受或已晋升的记忆候选建立独立 MemoryEntry 和初始修订，保留候选 id、审核历史与既有 canonical Memory id，并避免已晋升项目记忆重复。v22→v23 增加人工知识修订表，允许多个 EffectiveVersion 引用同一 GeneratedVersion，并为历史生效版补充空修订链。v23→v24 根据每个项目的选择指针重建当前 EffectiveVersion Wiki Page 的派生本地全文索引，不把未生效 Run 或旧 EffectiveVersion 混入检索。v24→v25 把 LLM Wiki runtime 升为 schema v9，为事实阶段任务增加最终 Provider 请求材料审计；SQLite v19-v24 都执行同一升级，历史任务一律标记为 `unsupported`，不从旧 Session 或成功状态反推请求证据。v25→v26 把 Wiki runtime 升为 schema v10，为新 analysis Task 增加固定九类项目问题；历史分析保留原状态但问题证据标记为 `unsupported`，不从旧 Claim 伪造答案。

每个新建 Wiki Run 都会成为该项目的当前分析选择；同一进程对同一项目的规划按请求开始顺序执行，数据库再按规划开始时读取的选择修订拒绝跨进程迟到更新。重复规划同一 Run 不增加代际，替代 Run 同时增加选择修订与分析代际，且不撤销已有生效版。只有状态为 `complete` 且十项 Host 完成检查全部通过的 Run 才能封存 GeneratedVersion。版本封存、EffectiveVersion 创建和唯一生效指针切换在一个 SQLite 事务中完成，按选择修订拒绝过时分析，重复提交同一版本幂等。版本封存后，对应 Wiki snapshot 不再允许改写。

设置页通过脱敏后的版本摘要选择知识来源：没有 EffectiveVersion 时，项目 Wiki 与 Agent 知识都显示当前分析草稿，Agent 默认查询仍不读取它；存在 EffectiveVersion 时，两个 Tab 都固定到同一个生效 Run，并显示生效版标识。分析进度始终跟随当前分析 Run，因此新一代草稿不会覆盖仍在使用的旧生效版。`material-exposure` 检查要求每个非 Page 事实任务都保存经过最终请求装配的原文身份；待确认任务使检查失败，历史 `unsupported` 任务保持不支持。`business-questions` 检查要求每个 analysis Task 完整提交固定九类问题，证据结论必须引用同一提交的非 unknown Claim，未知和不适用必须说明原因；已迁移的历史任务保持 `unsupported`。跨模块流程完成证据仍报告 `unsupported`，所以生产状态机尚不会自动生效任何 Run。

生效 Wiki 页允许操作者选择“替换页面正文”或“追加页面说明”。保存请求携带项目选择修订、生效版本 id 和幂等请求 id；Host 在一个事务中保存不可变 HumanRevision、建立包含累计修订 id 的新 EffectiveVersion，并把选择切换为 `fixed`。旧页面、旧生成版本和旧生效版保持不变；并发过期保存返回冲突。页面正文替换会把原 Claim 标为需要人工复核，追加说明保留原 Claim 状态。当前修订已在两个知识 Tab 的 Wiki 树中一致显示，并进入只包含当前 EffectiveVersion 的独立本地全文索引；页面正文替换不再沿用生成 Claim 的代码来源，追加说明仍保留生成 Claim 及其来源。自动召回只在显式允许的项目与 Provider 中查询该索引，界面可见或本地命中本身不代表 Agent 已使用。

## 初始化项目知识

在项目根执行：

```sh
dsh-memory-knowledge init .
```

该命令创建 `.dsh/knowledge/manifest.json`、空的 `entries/` 与 `cards/`，并生成 `wiki/` 和 `schema/` 投影。Space ID 和 Source ID 使用稳定 UUID。重复执行不会改写现有 manifest；现有目录包含未知内容时会拒绝初始化。

以下文件提交 Git：

```text
.dsh/knowledge/manifest.json
.dsh/knowledge/entries/*.json
.dsh/knowledge/cards/*.json
.dsh/knowledge/wiki/**
.dsh/knowledge/schema/manifest.schema.json
.dsh/knowledge/schema/memory-entry.schema.json
.dsh/knowledge/schema/knowledge-card.schema.json
```

以下数据不提交 Git：候选、SQLite、FTS 索引、Session、缓存、凭据和本机路径。

## 候选生命周期

明确的记忆表达由回合结束后的本地规则自动提取；模型只对没有使用明确表达、但确有长期价值的信息调用 `memory_candidate_save`。两种来源的结果都从 `pending` 开始，不会直接参与召回或写入 Git。Candidate Inbox 用“对话自动提取”“模型建议”“人工添加”或“Source inventory”标明来源。

```sh
# 查看当前项目待审核候选
dsh-memory-knowledge candidates . --status pending

# 接受后原子创建独立 MemoryEntry，并立即参与本地 recall
dsh-memory-knowledge accept cand_...

# 或明确拒绝
dsh-memory-knowledge reject cand_...

# 只有 accepted 且 sensitivity=normal 的候选可晋升
dsh-memory-knowledge promote cand_... .
```

接受事务同时保存候选与它创建的长期条目 id；后续召回、编辑和生命周期只读取 MemoryEntry，候选继续作为审核记录。项目记忆的晋升另行在跨进程文件锁内写入 Git canonical，重建 Markdown/schema 投影，再同步本地索引。命令不会执行任何 Git 操作，最终 diff 仍由团队正常 review、commit 和 push。

`restricted` 候选可以审核后保留在本机；默认搜索和自动召回都排除它。只有操作者显式在 CLI 搜索中加入 `--include-restricted` 才能读取，且它永远不能晋升到 Git。

### 对话自动提取

Consumer 只读取已经进入 Session 的 `source.kind=user` 消息，并在相应 `turn/end` 后先调用 Session durability flush。第一版只识别单条、明确、自包含的中英文表达：显式“请记住/remember”、个人长期偏好，以及项目、仓库或团队的决定和约束。它拒绝疑问句、条件句、否定记忆要求、转述或代码块、多条陈述、含糊指代、超出预算的正文，以及疑似密码、令牌、私钥或高熵凭据。每个用户消息至多生成一条 `sensitivity=normal` 候选；它不调用 LLM，不读取 assistant/plugin 注入消息，也不自动接受或写 Git。

断点键由 Session id、提取器名称和规则版本组成。首次挂载或恢复时以当前 Session 尾部为基线，不回填旧历史；插件恰好在回合中加载时只从当前回合开始。每个已处理 `turn/end` 都推进断点，包括没有候选的回合；候选插入、live fingerprint 去重和断点推进在同一 SQLite `BEGIN IMMEDIATE` 事务内。提取、持久化或项目根解析失败只记录后台告警，不改变原 Session，且因为断点未推进会在后续回合重试。

## 确定性 Knowledge Card 候选

```sh
dsh-memory-knowledge generate .
```

该命令显式读取 Source inventory，为每个工作树干净且扫描完整的 Git Source 构建本地 Source records checkpoint，再生成 `overview`、`architecture` 和 `module` 三类 Card 候选。每条 Source record 包含 portable path、内容哈希、字节数、顶层区域、语言、路径确定的工件角色，以及可选的有界 evidence 和模块 specifier；两者都带类型、1-based 行号与遗漏计数，不保存文件正文。`overview` 陈述 revision、文件规模、语言边界和顶层目录分布；`architecture` 将 records 聚合为区域、工件角色、有界代表文件和静态模块关系；`module` 按区域列出解析到的 AST 符号/标题及其 `git-file` 行号 provenance。三者都不调用 LLM；`architecture` 和 `module` 不推断模块职责、符号引用、调用关系、运行时加载顺序、业务流程或业务语义。若最新 Wiki Run 已完成 Page 阶段，命令还会为满足单一 Git 来源、已验证 assertion、Coverage 哈希和当前完整 Catalog 的 Wiki Page 创建 `suggestedBy=wiki` 候选；候选 section 只复制 Claim statement 与原 Citation，不生成额外事实。Source inventory 的 degraded 或正文总量预算只影响确定性 Source 候选，不阻断由 Catalog 和不可变 Git object 完成核验的 Wiki Page 候选。

Source records checkpoint 保存 generator version、Source id、commit、inventory hash、输出 hash 和影响输出的配置；同一项目的同一 Source 只保留当前 checkpoint，inventory 变化时在 SQLite 事务内原子替换。候选另外保存 generator version、Source id、inventory hash、Source-record output hash 和稳定 generation key。同一 inventory 并发或重复生成返回原 Candidate，包括已经拒绝的审核记录，不刷新时间或创建重复项。相关源码内容变化时才产生新的 generation key。inventory hash 不包含 Git commit，也不包含 `.dsh/knowledge`，因此提交 canonical Card 本身不会让它立刻陈旧；commit 仍保留为可追溯证据。

Candidate Inbox 显示候选目标是“长期记忆”还是“Knowledge Card”。Card 候选接受后仍不进入个人记忆召回；`promote` 会再次确认生成时使用的 Source inventory 或 Wiki Catalog 与当前 Git 状态一致，然后在 canonical writer 锁内创建或更新 `cards/*.json`，重建 Wiki/schema 投影并同步派生索引。Source inventory 候选仍按同 Source、同 kind、同标题保持单卡；Wiki Page 候选按稳定 Source id 与 slug 派生 Card id，首次创建即保留该目标，后续 Run 的同 slug 页面通过 base revision 更新同一卡。slug 变化被视为新页面，不按相似标题静默合并。来源已经变化、目标 Card revision 已前进或候选证据不再匹配时拒绝晋升，要求重新生成和审核。

## Web/Electron 可视化

Web 与 Electron renderer 使用同一个 `lib/client.js`，入口位于“设置 → 记忆与知识”。页面将“记忆”和“知识”设为两个一级领域。记忆域单独选择个人记忆或某个项目记忆，并提供“记忆条目”和“候选审核”；记忆条目可直接新建、编辑、停用、删除、恢复并查看修订历史，修改使用页面所见 revision 做 CAS 保护；候选状态过滤、目标类型、展开详情、接受/拒绝、项目晋升、全文搜索和 Recall Trace 都留在该域。知识域必须选择 Workspace，且主内容只使用“项目 Wiki”和“Agent 知识”两个 Tab；分析进度、Run 历史、材料预算、来源清单、关系图、符号图、Evidence Pack 和旧 Knowledge Card 新鲜度通过“分析进度”或“来源与诊断”辅助按钮访问，不形成第三个知识 Tab。尚无 Generated/Effective Version 时，两个主视图明确显示分析草稿或兼容层状态，Agent 默认查询不会读取草稿，也不把旧 Knowledge Card 标成正式项目知识。Agent 默认记忆召回仍使用适用范围，会组合个人与当前项目记忆。来源诊断可以显式构建 Source records 并生成确定性 Card 候选，显示模块关系、跨文件符号图及其 TypeScript 配置模式、配置数量、path alias、project reference、配置诊断和预算省略，也可以按符号、标题、路径、区域或语言查询结构化 Evidence Pack。页面会分别查询最多 120 条当前静态模块关系和跨文件符号引用；模块图支持来源路径或 specifier、顶层区域、解析类别和引用类型组合筛选，符号图支持文本、定义路径、引用路径和 import/export/type/value 类别筛选。两类结果都显示为带键盘可聚焦节点的 SVG 有向图和语义表格。Host 只发送汇总计数、显式查询命中的 portable Source evidence 和有界关系/符号边，不发送 source 根、完整文件清单、未命中的逐文件 records 或完整图；源码中的绝对 specifier 在浏览器投影中会被替换为固定占位符。

知识域的“分析进度”辅助面板可以显式调用 `planWikiProject()`，并显示最新 20 个 Run 的 Catalog 完整性、已知或未知遗漏、pending/analyzing/analyzed/deferred/excluded/blocked/stale 精确计数、Task 完成/运行/待处理/失败汇总、大文件区间完成数与已分析字节、文件级综合完整性、全局候选对数量、Page 计划、召回完整性、阻塞原因、总字节数和根页面数。“分析下一个分片”“综合下一批文件声明”“核验下一批声明”“核验下一组全局候选”和“生成下一组 Wiki 页面”复用同一严格 RPC，每次执行或恢复至多一个 durable Task。全部 analysis Task 成功后，Host 只为同一大文件中拥有至少两个不同区间支持证据的原始 Claim 规划文件级综合；任务按 Claim 数和 statement 字符预算有界分批，Agent 必须重读每条输出所引用的全部支持材料，输出必须消费至少两条输入 Claim、覆盖至少两个 `rangeId`，并将每条输入明确标为保留或消费。Host 拒绝遗漏、重复消费、额外证据、缺少来源区间或把 inference 升级为 assertion 的提交；原始 Claim 留作审计，但被综合 Claim 消费后不再进入下游事实集合。同文件多批完成后按[递归规则](#递归文件综合)继续；Run header 区分进行中、共同审视完成、停止但有盲区和历史未评估。文件级综合结束后，活动非 unknown Claim 按多个原分片轮转混排为有界 verification Task；普通 Claim 至少重读一个匹配 supports Citation，综合 Claim 必须重读全部 supports Citation，区间 Citation 必须使用同一 `rangeId` 回读。全部 verification Task 成功后，Host 通过共享 Coverage 和 Unicode statement key 召回不同批次间的候选对，以不超过配置上限且 Claim 互不重叠的 consistency Task 继续核验；召回规则只选择复核对象，Agent 仍必须重读 Citation 对应的不可变原始材料，Host 仍执行字节数、Git object、SHA-256、区间身份、Claim 范围和 Conflict 候选对校验。verified 只允许 assertion，inference 保持 uncertain 或被拒绝，冲突保留双方 Claim 与 supports/contradicts 证据。全局一致性完成后，eligible Claim 按 Coverage 区域、Claim 数与 statement 字符预算进入 Page Task；Page Agent 不读取项目材料，只提交任务内 slug、标题、Claim 引用和子页面关系，Host 验证每条 Claim 恰好出现一次并生成 Page id、聚合状态与唯一合成根。失败 Task 保留 Session、尝试次数和重试状态，后续阶段失败不会回滚已完成工作。覆盖条、Task 计数、区间汇总、文件级综合、Page 计划和一致性摘要是 Run header 的有界投影；RPC 不发送项目根、完整 Coverage、Claim/Citation 正文、候选对正文或 Agent Session id。

每个 Run header 还带有 Host 计算的知识激活完成报告，分别检查来源目录、纳入材料覆盖、分片分析、文件级综合、声明核验、全局一致性和页面准备，并明确列出当前运行时尚未建立的实际模型输入审计、项目问题清单及跨模块业务流程检查。`deferred`、blocked、stale、Catalog 遗漏、全局候选召回不完整和历史 `unassessed` 综合都会阻止激活；`unsupported` 必需检查同样不能通过。现有旧 Run 因缺少新完成标准的持久记录只作为草稿或历史资料，不会被追认为正式项目知识。

`dataEgressMode` 默认为 `ask`。设置页在每次 Wiki Task 前显示与当前 Workspace 绑定的一次性确认，严格 RPC 必须携带确认位，Provider 在确认缺失时不会创建模型 Agent；`deny` 始终拒绝，`allow` 允许受控的非 UI 调用方直接执行。确认只覆盖这一项有界任务，不扩大 Catalog、材料字节或 token 预算。

Wiki 树只在用户点击“查看 Wiki 树”后加载，不随 Run header 自动传输。一次响应最多投影 100 个活动 Page、200 条 Claim 和 400 条 portable 来源；每条 Claim 最多 8 个来源，statement 最多 1000 字符，Page、Claim 与来源的省略数量分别显示。树中不存在自由摘要正文：合成根只组织任务根，普通 Page 只引用 Claim，unknown 与 conflict 保留独立状态，来源只包含 Git 文件或文档的 portable path、可选行号，以及区间 Citation 的核心字节范围。

浏览器只发送 Workspace id；Host 将它解析为当前 `workspaceRegistry` 中的本机路径。RPC 不返回 SQLite 路径、项目绝对路径或原始 Session id，来源只投影为可携带的证据标签。`restricted` 正文不会进入浏览器响应，页面只显示需要改用本机 CLI 的数量提示。

审核和晋升请求携带页面所见的 `revision`。候选已经在别处变化时，Host 返回冲突结果，页面刷新当前状态，不用旧页面覆盖新决定。单条正文最多返回 20000 字符；被截断的候选不能在页面中审核或晋升。

每个 Wiki Run 可以按需展开任务材料预算，分页查看累计预扣、总额度、拒绝原因和记账起点，并通过两步人工确认提高额度。确认期间账本变化时拒绝旧请求并重新查询；扩额不自动运行模型。字节口径、查询范围和恢复步骤由[材料读取预算](wiki-material-budget.md)说明。

事实任务还可以调用 `wiki_catalog_search` 按字面路径子串分页定位当前 Run 的 Coverage，并调用 `wiki_catalog_ranges` 查看指定大文件的稳定区间、字节范围和分配状态。两个工具只返回有界元数据：`assignedToTask=false` 的命中仍不能被当前任务读取或引用，目录结果也不能证明项目中不存在某个逻辑。游标绑定项目、Run、Task、Agent Session、筛选条件和本次 `limit/maxCharacters` 预算；查询不会建立材料读取账本，也不会加载完整 Wiki 快照或源码。

### v25 最终 Provider 请求材料审计发布物验收

当前 v25 tarball 已安装到实际 Web profile，profile 依赖指向持久本机发布物，安装目录导出 Wiki runtime schema v9 和材料审计规则 v1。Web Host 在 `127.0.0.1:3080` 返回 HTTP 200，实际 Provider 打开私有数据库后将 SQLite `user_version` 从 24 升级到 25。迁移后的数据库仍有 0 个 Wiki Run、0 个 Page 和 0 个 EffectiveVersion，因此没有发起 Wiki 模型请求，也没有向 MiniMax 发送项目知识。本次验收只证明发布物打包、profile 更新、Host 装载、数据库迁移及空状态保持；最终请求装配、单一提交调用绑定、失败/中止拒绝、跨任务区间拒绝和历史 `unsupported` 迁移由 349 条 keyless 回归覆盖，不证明真实模型理解质量。

### v24 生效知识召回发布物验收

当前 v24 tarball 已安装到实际 Web profile；原有 `dsh-plugin-chat` 从已消失的临时 tarball 迁移为对已安装内容原样重打包的持久本机来源，两个 Bundle 同时保留。组合配置只允许 `/Users/lanxin/Documents/Code/deepseek-harness` 的当前 EffectiveVersion 通过 `minimax-cn` 进入模型请求，项目知识限 5 页、8000 字符，记忆与知识合并消息限 16000 字符，并禁止缺少 Session cwd 时猜测项目。包内 recall 入口在安装目录导出格式版本 1 和相同预算；Web Host 在 `127.0.0.1:58047` 返回 HTTP 200，真实设置页显示独立“记忆/知识”领域及“项目 Wiki/Agent 知识”双视图，新建浏览器连接没有 warning/error。当前私有数据库有 0 个 Wiki Run、0 个 Page 和 0 个 EffectiveVersion，因此本次验收只证明发布物安装、组合授权、Host/UI 装载与无正式知识时的空状态；没有向 MiniMax 发送项目知识，也不证明真实生效知识召回或回答质量。请求末端 Provider 改写、Session 恢复、旧格式回放、多项目根、跨项目错误结果和配置拒绝由 keyless 回归覆盖。

### v22 独立记忆发布物验收

v22 tarball 在隔离临时 Web profile 中完成安装和同版本不同路径更新，真实设置页与包内运行时读取同一份 SQLite schema v22。页面直接创建一条无外部来源、由操作者确认的个人“方法与流程”记忆后，依次保存编辑修订、停用并恢复；列表状态、详情正文和修订历史分别显示 v1 创建、v2 编辑、v3 停用、v4 恢复。数据库保持 `current_revision=4`、`status=active`，并重新建立一条 active 检索文档。实际操作期间没有新增浏览器 warning/error；删除和 revision 冲突由 keyless 回归覆盖，本次界面验收没有执行删除。该流程不配置模型凭据，只证明当前发布物的独立长期记忆持久化、严格 RPC、客户端编辑和检索生命周期，不证明自动提取或 Wiki 模型分析质量。

### v20 发布物验收

v20/runtime v8 基础账本 tarball 在全新临时 Web profile 完成安装、同版本不同路径更新、十个插件入口启动、显式禁用后的启动和卸载后的核心启动。无凭据 public API fixture 在 100 字节任务额度中预扣 60 字节，第二次 60 字节读取被拒绝，完成提交也被数据库拒绝；已安装 CLI 拒绝扩额到 110，允许扩额到 120，重启并重试后保留两次预扣和 120 字节总量。该批验收覆盖发布物、独立账本、CLI 和任务提交门禁，不验证真实模型的语义准确率。

预算面板发布物于 2026-09-03 在隔离 Web profile 和临时 Git/knowledge 项目中验收：实际设置页显示 60/100 字节，取消确认不写账本，确认扩到 120 后保留 60 字节与一次预扣，任务 snapshot hash、状态和尝试次数不变。另一连接扩到 200 后，页面的旧 240 字节确认返回冲突，账本保持 200；重载仍显示 200，“仅看预算不足”筛选为空。实际 RPC 使用另一 Workspace 查询和扩额同一 Run 均被拒绝。界面截图检查通过，控制台未记录 warning/error；测试不配置凭据、不执行模型。相关 8 个测试文件的 73 项回归、类型检查、Schema 一致性检查及构建/打包检查通过。

宿主 `session-log-export` 等待 `connection` 的启动问题仍存在；完整插件启动仅在临时 profile 禁用 `session-log-download` 后通过，正式配置未修改。卸载清除了测试插件依赖与安装目录，测试数据库保留；宿主仍留下不可执行的 CLI 断链符号链接。

### v19 发布物验收

历史 v19 tarball 安装到全新临时 `DSH_HOME` 的 Web profile，并完成同版本不同 tarball 路径更新。只使用包内 public API 写入并重新读取 SQLite schema v19/runtime v8 的四个确定性 Run：每个 Run 含一个 400 字节、四区间的状态机材料，分别停在第二层待处理、二层共同审视完成、批次数未减少和达到层数上限。真实设置页区分四种结果，显示层数、批次数及具体停止原因；完成例的四条原始 Claim 经两条中间 Claim 形成一个活动 Claim，七条记录全部保留。长摘要和操作区在实际设置面板中完成布局复核，四个卡片均没有水平溢出；更新后重新连接的控制台没有 warning/error。该无凭据 fixture 验证发布物、持久状态、严格 RPC 和 UI，不证明真实模型的语义准确率。

更新后启动曾因宿主 `session-log-export` 等待 `connection` 失败；验收仅在临时 profile 禁用 `session-log-download`，本插件十个入口保持启用完成页面复核。随后显式禁用本插件十个入口，核心 Web 启动成功；卸载后 manifest 依赖、Bundle 列表和安装目录均已清理，纯 Web 再次启动成功。SQLite 测试数据仍保留；宿主 pnpm 仍留下不可执行的 `.bin/dsh-memory-knowledge` 断链链接，零残留卸载问题尚未修复。

历史 v18 tarball 已安装到全新临时 `DSH_HOME` 的隔离 Web profile；真实 Host 完成十个插件入口激活，包内 CLI 可以初始化临时 Git canonical、规划 Catalog，并与真实设置页读取同一份 SQLite schema v18/runtime v7 数据。随后仅通过 tarball public API 写入一个确定性状态机 fixture：同一 100 字节文件的两个区间分别生成一条带支持证据的原始 Claim，文件级综合消费两条来源并产生一条 inference，下游 verification Task 只接收该活动综合 Claim。页面显示“任务 3/4 完成”“大文件区间 2/2，已理解 100 B”“文件级综合 1 个文件、2 条输入、1 批，跨批完整”，操作切换为“核验下一批声明”；页面没有投影临时项目根或 Agent Session id，连接后控制台没有 warning/error。该无凭据 fixture 证明当时 tarball 的安装、Host 激活、public 状态机、v18 持久化、严格 RPC 和客户端投影，不证明真实模型已经正确理解材料。

前一版 v17 tarball 已安装到全新临时 `DSH_HOME` 的隔离 Web profile，并通过包内 CLI 与真实设置页读取同一份 SQLite。七项 Git fixture 含一个 556829 字节 UTF-8 文件；规划器建立 SQLite schema v17、Wiki runtime v6、一个 Run 和三个 analysis Task，其中两个区间 Task 的核心范围分别为 `[0, 393183)` 与 `[393183, 556829)`，`0600` 私有缓存保存经过完整 Git object 与 SHA-256 校验的正文。CLI 规划后从 UI 再次刷新仍复用同一个 Run。页面显示“任务 0/3 完成”和“大文件区间 0/2，已理解 0 B”，没有投影临时项目路径或 Session id；本次连接建立后没有新增浏览器 warning/error。当前 DSH 产品分支自身的 Session 导出入口无法激活，验收 profile 只禁用了与本插件无关的 `session-log-download`，十个记忆与知识插件入口均保持启用。该无凭据 fixture 只证明当时发布物的安装、v17 持久化、语言无关区间规划、Host 脱敏投影和客户端展示，不证明当前发布物，也不证明模型已经理解区间内容。

较早的 Source records tarball 已在全新临时 `DSH_HOME` 的隔离 Web profile 中完成安装、同版本不同 tarball 路径更新、真实启动、9 插件显式禁用后的核心启动、恢复和卸载；卸载后 profile manifest、Bundle 列表和插件安装目录均不再包含本 Bundle，并写入 reload token，纯 DSH Web profile 可以重新启动。之后从 profile 执行已安装 CLI，为含根/子项目 TypeScript 配置的独立七文件 Git fixture 生成 SQLite schema v11、Source record map v7 与 symbol graph v2 checkpoint、3 条 Knowledge Card 候选、3 条 `source_relation_edges`、3 条 `source_symbol_definitions` 和 7 条 `source_symbol_references`；配置摘要为 3 个 `tsconfig`、1 个去重后的 path alias、1 个 project reference、0 个诊断。关系 Provider 按既有边界把三个 alias specifier 归为 external，符号 Provider 则通过 `paths` 解析其 Source 内 definition/reference。真实设置页同时加载模块关系图与符号定义/引用图，来源汇总显示相同配置摘要和符号计数；按 `greeting` 与“值引用”组合筛选后显示 `1/1`、查询上限省略 0，浏览器控制台没有错误或警告。当前宿主的 pnpm 卸载仍会留下一个指向已移除插件目录的 `.bin/dsh-memory-knowledge` 断链符号链接；它不可执行且不影响纯 DSH 启动，但完整零残留卸载仍需宿主侧清理。此前发布物还在发布用 Electron 安装包中验证候选读取、敏感隔离、接受、搜索、Trace 和 Source records；Electron 直接装载同一客户端图与 Host 协议，运行期间没有创建 TCP 监听端口。

前一版十插件 tarball 另在第二个全新临时 `DSH_HOME` 的隔离 Web profile 中完成安装、最终配置合成和真实 Host/client 装载。干净 Git fixture 同时包含未知扩展名与 Go 文件；设置页建立的 Catalog 覆盖 7 个 tracked 项，其中 2 个 pending、5 个 canonical/schema 投影显式 excluded，并形成 1 个可执行 Task。SQLite 实例为 schema v13，存在 `wiki_tasks`；未配置模型凭据时，点击“分析下一个分片”会把 Task 持久化为 failed，保存 `attemptCount=1`、Agent Session id 和 `MISSING_CREDENTIAL` 原因。Host 重启后页面仍恢复相同 failed Task 且允许重试。该证据只证明安装、装载、Catalog、UI、失败持久化与恢复；真实模型 Claim 生成仍需配置受控凭据后单独验证。

历史 v15 发布物曾安装到全新隔离 Web profile，并从 schema v15 SQLite 恢复一个含 2 个 succeeded analysis Task、2 个 succeeded verification Task 与 1 个 planned consistency Task 的 `verifying` Run。真实设置页显示“任务 4/5 完成”“全局候选 1 对，召回有遗漏且数量未知”和已启用的“核验下一组全局候选”；页面正文未出现项目绝对路径、Claim marker、Agent Session id 或完整候选指纹，成功读取后没有新增 warning/error。该 fixture 的 Claim 与任务由本地确定性状态机预置，只验证当时 tarball、Host 投影、v15 持久化、召回不完整语义和 UI 阶段切换；真实模型全局核验成功仍需配置受控凭据后单独验证。

上一版 v16 发布物已在全新临时 `DSH_HOME` 的隔离 Web profile 中完成安装、显式禁用全部十个插件后的核心启动、恢复、同版本不同 tarball 路径更新、更新后启动、卸载和卸载后的纯 Web 启动；profile manifest、Bundle 列表、插件目录和 reload token 按生命周期变化，卸载后仍存在宿主 pnpm 产生的不可执行 `.bin/dsh-memory-knowledge` 断链符号链接。发布物公开状态机写入的 schema v16/runtime v5 fixture 含 1 个 `needs-review` Run、2 个 succeeded Page Task、3 个活动 Page、2 条 conflicted Claim 和 1 条 uncertain unknown Claim。真实设置页先显示“任务 4/4 完成”“Wiki 页面任务 2 个，组织 3 条 Claim”，用户点击“查看 Wiki 树”后才加载 3 个页面；合成根无自由摘要，冲突、未知和 `README.md:1-8` portable 来源可见，页面正文不含临时项目绝对路径或 Agent Session id，加载后没有新增 warning/error。该 fixture 只证明当时 tarball、v16 持久化、Host 脱敏投影和 UI 组织语义，不证明当前发布物，也不冒充真实模型 Page 组织质量。

## Source inventory、Source records 与陈旧检测

```sh
dsh-memory-knowledge inventory .
dsh-memory-knowledge stale .
dsh-memory-knowledge stale . --write
```

Inventory 默认读取 Git 已跟踪文件和未被 ignore 的未跟踪文件，稳定排序后记录 source id、完整 commit、branch、相关工作树状态、相对路径、大小、扩展名语言和 SHA-256。`.git`、`.dsh/knowledge`、凭据文件名、SQLite 数据库、`node_modules`、`lib`、`dist`、缓存、Session 与覆盖率目录不参与扫描，也不影响 source dirty 状态。文件数、单文件字节数、总字节数、路径长度、目录深度、Git 输出和进程终止宽限均由 Provider 配置限制；达到限制时返回 degraded，而不是静默截断。

LLM Wiki Project Catalog 与 Source Inventory 是两条不同链路。Catalog 对每个干净 Git Source 运行 `git ls-tree -rlz <commit> -- .`，只收集 tracked path、mode、Git object id 和 blob size，不读取文件正文，也不受项目正文总字节预算限制。默认 `wikiCatalog.maxEntries=5000000`、`maxPathChars=4096`、`maxDepth=256`、`gitOutputMaxBytes=536870912` 和 `processGraceMs=3000`，都可以在 inventory Provider 配置中覆盖。Catalog 把 `.dsh/knowledge`、依赖/生成物/缓存、疑似凭据、私钥/证书和本地数据库保留为带原因的 `excluded` Coverage；未知扩展名仍是普通 pending Coverage，Git submodule 是要求独立 Source 的 blocked Coverage。dirty 或 untracked Source 固定产生 incomplete Catalog 和遗漏数 unknown，持久化的 Wiki Run 因而 blocked；当前版本不会以 HEAD blob 冒充当前 worktree，也尚未流式哈希变更文件。Catalog 使用有界内存接收 Git 元数据，正文数 GB不是问题，但路径元数据超过配置上限时会明确 incomplete；流式 Git record decoder 属于后续优化。

`KnowledgeProject.readWikiMaterial()` 只接受可分析且使用 `git-object` 身份的 Coverage。它根据 canonical Source 映射定位仓库，通过 DSH `subprocess` 执行 `git cat-file blob <objectId>`，因此即使规划后 worktree 文件变化，读到的仍是 Catalog 对应的不可变内容。读取器把原始 stdout 重组为固定上限的连续块，并跨全部块计算 Git blob object digest 与 SHA-256；只有对象身份和实际字节数都与 Catalog 声明相等时才发出 `complete`。Consumer 在 `complete` 之前不得保存 Claim。超出 `maxMaterialBytes`、对象不存在、进程失败、对象身份或字节数不符、取消都会失败，不把部分内容当作已分析材料。

`KnowledgeProject.prepareWikiMaterial()` 只处理超过区间目标的 Catalog Git blob，并按 Catalog 顺序逐项执行，普通条目不进入异步准备。它把不可变对象顺序流式读取一次，校验 Git object id、完整 SHA-256、fatal UTF-8 和 NUL 后，以 `0600` 文件写入 `$DSH_HOME/memory-knowledge/wiki-material-cache`；缓存是可重建的本地派生数据，不进入 Git、SQLite、Session 或发布包。并发写入使用唯一临时文件和短提交锁。进程内保存已经完整验证的私有文件身份；文件身份变化或进程重启后的首次读取会重新校验大小、Git object id、SHA-256 与文本有效性，每个区间读取还会复核自身哈希和读取前后的文件身份。损坏缓存从 Git object 重建。当前缓存没有自动清理策略，容量规划和手工清理属于运维责任。

准备器按默认 384 KiB 核心目标切分，优先选择目标后半段的换行，否则退回 UTF-8 字符边界；相邻核心区间严格无缝覆盖 `[0, objectByteSize)`，每侧上下文也调整到 UTF-8 边界。每个核心区间持久化 ordinal、核心/上下文字节范围、1-based 行号、上下文 SHA-256 和确定性 `rangeId`，并成为独立 analysis Task。`KnowledgeProject.readWikiMaterialRange()` 从已复核缓存随机读取准确上下文范围，返回绝对字节偏移、区间哈希和完整对象哈希；Agent Citation 必须保留任务分配的 `rangeId`。上下文只用于理解边缘，Claim 仍属于该核心区间；所有区间成功前文件 Coverage 保持 analyzing，最后一个区间成功后才写入完整对象哈希并变为 analyzed。

同一 Catalog hash 的重复请求会复用最新的未失败 Run，避免按钮重试制造重复历史。Catalog 变化时创建新 Run；如果上一个 Run 的 Coverage 已 analyzed，且新项目仍是同一 Source id、portable path 和 Git object id/content hash，新 Run 复用其 analyzed content hash、时间和尝试次数。内容变化或新增项目从 pending 开始。新 Run 只复用内容 identity 未变、所有支持 Citation 仍匹配当前 Coverage 且没有综合来源链的 verified 叶级 assertion；Git blob 未变但 commit 前进时，复用 Citation 会重绑定到当前 commit，再重新规划核验任务。综合 Claim、Page 和带 `rangeId` 的 Citation 不跨 Run 复用。

新 Run 的 pending Coverage 先按 Source 和 portable path 顶层区域分组，再按可配置项目数/字节预算稳定分片。输入顺序不影响 `shardKey`；超过材料区间目标的 Git 文本改为每个核心区间一个带 ordinal 的确定性 Task，不因语言或扩展名改变规则。自然分片与文件区间都是语言无关的调度单元；内容读取和模型请求仍使用独立 token/字节预算，不能把 256 KiB 元数据预算当作一次模型输入。区间边界只证明完整字节覆盖，不声称具有语义；文件级综合从各区间已经带证据的 Claim 出发，在单个有界任务中回读原始材料并保留来源链。多个综合批次可继续递归，但共同审视不等于语义无误差。

## 递归文件综合

第一层按主区间轮转混排原始 Claim；后续层按上一层批次轮转混排存活声明。存活声明包括显式保留的输入与本批新产出的综合 Claim，每层必须恰好覆盖上一层的全部存活声明。消费来源综合 Claim 时，全部底层 supports Citation 必须继承并重新读取；来源任务必须位于更低层，来源链拒绝循环、跳层、重复消费和证据遗漏。

同文件一层全部成功后，Host 判断终点：当前层只有一批时，全部存活声明已共同审视，允许独立事实继续并存；否则，仅在下一层批次数减少且未达到持久化层数上限时追加任务。批次数未减少记为 no-reduction，达到上限记为 level-limit；这两种结果都保留跨批盲区，再核验已有活动声明，不强迫模型归并事实或反复消耗预算。后续阶段不重新核验已被消费的历史声明，但审计记录保持完整。

每个 Task 保存 level、batchIndex、batchCount，最终层末批保存 outcome；Run 汇总层数、任务数、已完成和各停止原因的文件数。中断恢复复用原 Task 和 Session，失败重试复用 Task 并分配新 Session；下一层创建、结果提交和汇总更新一起经过快照 CAS。输入声明数、statement 字符与递归层数使用独立预算；原文回读另受[任务累计字节预扣](wiki-material-budget.md)限制。按问题选择证据与整个 Run 的 token 费用控制仍未实现。

Source records 是 inventory 的本地派生 checkpoint，不属于 Git canonical，也不会整体进入浏览器。输出按 portable path 稳定排序，路径分类只识别代码、测试、文档、配置、资源和其他六种工件角色；顶层区域只取相对路径的第一段。每个 clean checkpoint 保存由 inventory 版本、全部扫描配置、`SourceAnalysis.cacheKey`、`SourceRelations.cacheKey` 和 `SourceSymbols.providerKey` 组成的复用身份；身份一致时，下一次扫描通过 NUL 分隔的 Git `name-status` tree diff 找到新增、修改、删除、重命名和复制路径，只读取当前集合中的变化目标，并复用其余文件的大小、内容哈希、语言和 AST 分析。dirty 工作树、缺失旧 commit、异常或超预算 diff、配置/Provider 身份变化都退回全量读取。两条路径最后都会从当前完整文件集合重算 inventory hash、records、区域、关系、符号、候选输入和 Evidence FTS，因此增量结果必须与冷启动全量结果一致；目标文件改名时，未变化 importer 的缓存引用也会重新解析。Source analysis 在完整读取仍受 `maxFileBytes` 约束的文件后执行 fatal UTF-8 与 NUL 检查；默认 Provider 通过 TypeScript AST 提取模块级 class/function/interface/type/enum/namespace/variable、class/interface/type 成员、枚举成员、默认导出与重导出，并保留模块导出状态和容器名。它从同一语法树提取静态 `import`、`import type`、重导出、字面量动态 `import()`、字面量 `require()` 和 `import = require()` specifier，不进入函数体收集其他局部声明。Markdown 仍只提取 fenced code 外的 ATX 标题。逐文件 evidence 数量、名称及容器长度、模块引用数量与 specifier 长度、全局关系边、区域展示数量和代表文件数量都由 Provider 配置限制；非字面量调用与超预算项计入遗漏数，正文与 excerpt 不进入 checkpoint。持久化解析会重建并核对全部派生字段、计数、区域关系、符号引用和哈希，拒绝未知、重复或不一致的记录。

默认 `SourceRelations` Provider 只将相对 specifier 映射到当前 portable file set，并支持 TypeScript 常见的 `.js` 到 `.ts`/`.tsx`、同扩展名、无扩展名和 `index` 候选；解析到当前文件的是 internal，包名等非相对 specifier 是 external，找不到目标、越出项目根或使用绝对路径的是 unresolved。`source_relation_edges` 保存来源文件哈希、specifier、引用类型、解析类别、可选目标 portable path 和行号，并随 Source checkpoint 原子替换。该图描述的是源码语法关系，不读取 `tsconfig` aliases、package exports、类型信息或运行时模块加载结果，也不证明 symbol definition/reference、调用或业务职责。

默认 `SourceSymbols` Provider 通过 DSH `fs` 短暂读取当前 inventory 中受支持的 JavaScript/TypeScript 文件和 `tsconfig*.json`，逐一复核字节数和 SHA-256，然后在无标准库的 TypeScript Program 中使用 type checker 解析跨文件定义与引用。源码与配置分别拥有文件数、总字节和单文件字节预算；达到配置预算时优先保留层级更浅的根 `tsconfig.json`，其余配置计入省略数。Provider 使用 TypeScript 自己的配置解析器处理 JSON 注释、trailing comma、相对 `extends`、`baseUrl`、`paths` 和 project references；每个源码文件使用目录层级最近的已解析配置。Program 的 root files 仍是受预算的 inventory 源码全集，不实现 `files`、`include`、`exclude`、`composite` 或 solution build 语义。Referenced project 必须位于同一 Source root，其配置与源码都必须已经进入当前 inventory；缺失、越界、未纳入 inventory、无效配置或 TypeScript 配置错误进入诊断计数，不静默读取外部文件。`source_symbol_definitions` 与 `source_symbol_references` 只保存稳定符号 id、名称、声明类型、portable path、文件哈希、引用类别和 1-based 行号，不保存正文，并随当前 Source checkpoint 原子替换。符号图另外保存使用的 portable config paths、alias/reference/诊断/省略计数；这些路径必须属于当前 records。当前不解析 package exports 或外部包定义；输出只证明当前 Source 内的静态 definition/reference，不证明调用、运行时分派或业务语义。

## 项目 Evidence Pack

`generate` 保存 Source records 时，会在同一 SQLite 事务中替换当前 Source 的 `source_evidence_documents`、`source_evidence_fts`、`source_relation_edges`、`source_symbol_definitions` 与 `source_symbol_references`。Evidence 索引只包含 Source id、revision、inventory/record/file hash、portable path、区域、语言、工件角色、evidence 类型、名称、声明类别、模块导出状态、可选容器名和 1-based 行号；关系索引保存来源 portable path 和哈希、可选目标 portable path、specifier、引用类型、解析类别和 1-based 行号；符号索引保存定义与引用的 portable path、哈希、类型和行号。三类派生索引都不包含源码正文，查询都固定在当前项目的最新 checkpoint，旧 checkpoint 通过外键和显式 FTS 清理一起移除。关系与符号查询使用参数化 SQL、稳定排序和 Host 固定上限，并把查询上限导致的省略与 Source Provider 生成图时的预算省略分别报告。

模型使用 `knowledge_search` 主动查询。该工具只接受具有 Session Workspace cwd 的调用，不使用 `process.cwd()` fallback；结果标记为不可信背景证据，并报告检索器版本、总命中、展示数、省略数、`result-limit`/`character-budget` 截断原因和 Source revision。设置页“来源状态”使用严格 Workspace-id RPC 调用相同 Service，浏览器不能提交任意 `projectRoot`。

陈旧检测优先比较 Card 及其 sections 中 `git-file`/`document` provenance 的相对路径和内容哈希。生成型 overview Card 使用 `sourceRevisions.inventoryHash` 比较相关源码清单；Wiki Card 使用 Catalog checkpoint，当前 Source 仍位于同一干净 Git commit 时，即使旧 inventory 因正文预算降级也保持 fresh。commit 或工作树变化会先标记 stale，要求通过新 Wiki Run 重建证据。其他扫描失败或达到预算的 Card 为 degraded，不冒充 stale。

有效状态为 stale 或 degraded 的 Card 不进入 FTS 和自动召回，即使 canonical 文件还保持 `verified`。普通 `stale` 命令只预览且以非零状态提示问题；只有 `stale --write` 会在 canonical writer 锁内将已验证 Card 写成下一 revision 的 `stale`，然后重建 Markdown 投影。Inventory 只执行只读 Git 命令；canonical 写入也不执行 `git add`、`commit` 或 `push`。

## 检索与 Trace

```sh
dsh-memory-knowledge search "为什么使用 FTS5" . --limit 8 --max-chars 12000
dsh-memory-knowledge trace mem_... .
```

检索使用 SQLite FTS5 trigram tokenizer，并为过短查询使用字面匹配。搜索范围包括全局 accepted 候选、当前项目 accepted 候选，以及当前 canonical store 中状态为 `verified` 的 Memory 和 Knowledge Card。每次项目搜索前都会按 canonical fingerprint 同步派生索引；索引可以删除后重建，不拥有事实。

Trace 返回精确正文、当前状态、作用域、更新时间和 provenance。工具输出不暴露本地数据库路径；项目绝对路径只存在本机候选和索引中，不写入 canonical JSON。

## 自动召回

Recall Consumer 只从当前 step 中 `source.kind=user` 的直接用户文本生成查询，不使用之前注入的插件消息，因此不会递归召回。记忆与项目知识分别查询、分别降级，并受同一最终消息上限约束：

```text
用户消息
  → 从 Session cwd 向上寻找最近的 .dsh/knowledge/manifest.json 或 .git
  ├→ 记忆 FTS scope/sensitivity 过滤（始终本地）
  └→ 当前 EffectiveVersion FTS（仅显式允许的项目根）
  → 两域独立条数/字符预算 + 总字符预算
  → 带精确对象 id、版本、来源、项目根和预算的 recall 消息
  → agent/pre-step 决策
  → Session user/message
  → agent/request 检查最终 Provider 与所有持久化项目根
```

记忆默认限制为 5 条、6000 字符，项目知识默认限制为 5 页、8000 字符，合并消息默认最多 16000 字符，查询最多 2000 字符。项目知识的 `knowledgeEgressMode` 默认为 `ask`，当前实现把它作为不出域的安全状态；只有配置为 `allow` 且 `knowledgeAllowedProjectRoots` 与 `knowledgeAllowedProviders` 均非空时才查询并注入。项目根按真实规范路径精确匹配，不接受相对路径；缺少 Session cwd 时不从进程 cwd 猜项目，但个人记忆仍可查询。请求检查在下游选定最终 Provider 后执行，历史 Session 中只要存在项目知识正文，后续步骤、会话恢复和 Provider 改写都必须继续满足原项目与当前 Provider 允许列表。

Recall 内容明确标记为背景资料而不是指令；记忆要求与项目知识现状分段呈现，当前 workspace 证据与召回内容冲突时以当前证据为准。项目知识只来自所选生效版本；人工替换正文不继承旧 Claim 来源，人工说明与生成来源分别标明。任一域检索失败不会阻塞另一域或 Agent，同一 Agent 对同一错误只注入一次对应降级通知；返回其他项目的数据会被丢弃并作为项目知识失败记录。

## 当前限制

- 当前只解析一个 Session cwd 对应的最近项目根；多仓 Workspace 组合映射尚未实现。
- 对话自动提取目前只覆盖明确表达，不做跨回合指代、隐含偏好、冲突理解、多候选拆分或 LLM 语义提炼。
- 独立记忆已支持修订和生命周期；替代/冲突关系的用户编辑、冲突成组召回、完全擦除和召回时间线尚未实现。逻辑删除保留可恢复历史，不等于清除已写入的 Session 或 Git 副本。
- Source inventory 仍会执行有界 `git ls-files` 并从完整文件元数据重算聚合与 FTS；Git diff 增量目前优化的是文件正文读取和 AST 分析，不是局部更新 SQLite 表或候选内容。
- 当前 `module` 候选使用 TypeScript Compiler API 的语法树声明和 Markdown 标题；`architecture` 额外使用静态模块 specifier 关系和顶层区域聚合。Card 生成器不消费独立符号图，也不证明模块职责、调用关系、流程或业务知识；这些语义仍需要后续确定性 Provider 或经过数据出域确认的 LLM 提炼。
- 检索目前包括记忆/Knowledge Card FTS、Source evidence FTS、当前 checkpoint 的静态模块关系查询和 tsconfig-aware 跨文件 symbol definition/reference 查询；调用图、LSP、package exports、外部包定义、跨 Source root project references 和 embedding 属于后续阶段。
- 当前页面聚焦候选、记忆列表、搜索、精确 Trace、source/card 状态汇总、Evidence Pack 命中详情、有界静态模块 Graph 和显式加载的有界 Wiki 树；逐文件树状导航、知识实体 Graph 和一次请求的召回时间线尚未实现。
