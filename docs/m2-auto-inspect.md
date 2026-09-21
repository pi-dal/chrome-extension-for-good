# M2 设计:自动 Inspect 流水线(L1/L2/L3 + 完整性机制)

> 状态:已批准(Chairman 2026-09-21)。本文档是 M2 实现的唯一事实源,与本文冲突的实现以本文为准。
> 前置阅读:README.md(M1 架构)、packages/protocol/src/index.ts(现有 wire 契约)。

## 0. 目标与非目标

**目标**:对任意做题页面,不写平台适配代码即可完成:采集(PageCapture)→ 检查(inspect)→ 作答 → 配方沉淀(Recipe)。平台知识从"必需品"降级为"加速缓存"。

**非目标**:canvas/图片题的多模态枚举(只留 screenshotRef 扩展点);跨域 iframe 聚合(M3);强反爬平台对抗。

## 1. 分层与失败模式

| 层 | 机制 | 失败模式 | 对策 |
|---|---|---|---|
| L1 Recipe | 按 origin 加载已沉淀的 CSS 配方 | 页面改版 | 校验失败自动降 L2 |
| L2 结构启发式 | 同名 radio/checkbox 组、文本块题干、XHR 频率聚类 | 非常规布局漏检 | 与 L3 交叉验证 |
| L3 LLM 枚举 + Jev 仲裁 | LLM 开放世界枚举(仅输出元素索引),Jev 封闭世界裁决分歧 | LLM 幻觉 | 索引接地 + 守恒校验 |

分工铁律:**LLM=发现者(召回),Jev=裁决者(精度),代码=审计官(守恒)**。模型输出永远是索引/结构化 JSON/配方字符串,永远不是可执行 JS。

## 2. 完整性四道机械保证

1. **元素守恒律**:每个 quiz 候选元素(所有 radio/checkbox/题目区文本输入/nav 候选)必须归属:题干 ∪ 选项 ∪ 输入 ∪ nav ∪ 显式排除。有残留 → 把缺失索引回喂 LLM 重枚举(≤2 轮)→ 仍失败则 `conservation.status='fail'`,quiz-loop 拒绝作答(只出报告)。
2. **双通道交叉验证**:L2 与 L3 独立分组,一致通过,分歧组逐个交 Jev Noul/Choice 仲裁,置信度 <0.7 归入 unclassified(fail-safe)。
3. **进度守恒**:提取平台自报进度(progressClaim),与实际可见题数对账;不符 → 狩猎循环(滚动/展开/翻页)后重新快照枚举。
4. **动作后回读**:每次作答动作后 re-snapshot 验证 checked/value 生效(沿用 M1 actSafe + 新增回读断言)。

## 3. 协议增补(packages/protocol,破坏性变更禁止,只增不改)

```ts
interface PageCapture {
  captureId: string;            // sha1(origin|pathname|capturedAt) 前 16 位
  url: string; origin: string; capturedAt: number;
  table: ElementTable;
  pageText?: string;            // ≤32KB 截断;canvas/怪结构时给 LLM 兜底
  progressClaim?: { raw: string; current: number; total: number };
  screenshotRef?: string;       // M3 扩展点
  meta?: Record<string, unknown>;
}

interface QuizQuestionModel {
  stem: string; stemIndex: number;
  optionIndices: number[]; inputIndices: number[];
  answered: boolean; confidence: number;   // 0..1
  source: 'recipe' | 'hint' | 'heuristic' | 'llm' | 'arbitrated';
}

interface InspectionResult {
  captureId: string;
  questions: QuizQuestionModel[];
  navIndices: number[];                       // 检查/保存/下一题/交卷
  excluded: Array<{ index: number; reason: string }>;
  conservation: { status: 'pass' | 'fail'; rounds: number; unaccounted: number[] };
  diagnostics: string[];
}

interface QuizRecipe {
  origin: string;
  questionSelector?: string; optionSelector?: string;
  heartbeatUrlPattern?: string; videoSelector?: string;
  learnedVia: 'distill'; confidence: number; updatedAt: number;
}

interface InspectionSession {   // 跨页合并结果
  captures: PageCapture[];      // 按 capturedAt 升序
  questions: QuizQuestionModel[];   // 跨页去重后
  progress: { claimedDone: number; claimedTotal: number | null; seen: number };
  diagnostics: string[];
}
```

- `snapshot_request` 增加可选 `includePageText?: boolean`;对应 `snapshot` 增加可选 `pageText?: string`。
- `Action` 增加 `{ op: 'eval'; expression: string }`:host→扩展,隔离世界执行(DOM 查询)。**安全策略**:expression 只能来自 host 代码常量;模型衍生的选择器必须过语法白名单(禁 `;`、`//`、反引号,长度≤300)并 JSON 转义后内插进 `document.querySelectorAll(...)`;结果 JSON 序列化后 ≤64KB。
- `action_result` 增加可选 `value?: unknown`(仅 eval 动作;64KB JSON 上限,收发双侧强制)。扩展在隔离世界执行 expression,并绑定 `__c4gRef(i)` → 快照索引 i 的活元素。(review F5 补充)
- 其余协议零改动。守恒相关的候选判定沿用 role 字段(radio/checkbox/textbox),不新增。

## 4. 模块设计(packages/host)

### 4.1 capture.ts(在线采集)
- `captureFromWs(ws, tabId, opts)`:收敛快照循环(快照→滚到底→元素数稳定或≤4轮)→ 组装 PageCapture;`pageText` 经 op:'eval' 取 `document.body.innerText`(≤32KB);progressClaim 由 `regex.ts` 提取(第 x/y 题、Question x of y、共 N 题、x/y),失败留空交 LLM。
- `saveCapture/loadCapture`:落盘 `data/corpus/<origin>/<captureId>.json` + `data/corpus/index.json`(运行时语料,**gitignored**)。
- capture 质量门:守恒在入口预检(table 残缺→标记 defective,不进 inspect)。

### 4.2 inspect/(核心,纯函数编排)
```ts
interface InspectDeps { heuristic; llm; jev; log; }   // 全部可注入 mock
function inspectPage(capture: PageCapture, deps: InspectDeps): Promise<InspectionResult>
function inspectSession(captures: PageCapture[], deps: InspectDeps): Promise<InspectionSession>
```
- `heuristic.ts`(L2):同名 name 的 radio 连续组=单选组;checkbox 组=多选;组前最近文本元素(≥6字,或以 ？/?/：结尾)=题干;Moodle quizSlot 提示存在时直接采信(source:'hint')。
  - **已知偏差(review F8,待协议支持)**:当前启发式按"连续同角色"分组,未校验 DOM name 属性同各——ElementInfo 未携带该属性。相邻两题若选择器连续可能被并成一组;守恒/仲裁无法兜住双通道一致错误。后续给协议加 `htmlName?: string` 后收严。
- `llm.ts`(L3 枚举):输入编号元素表(+pageText 兜底),系统提示强制只回 JSON `{questions:[{stemIndex,optionIndices[],inputIndices[]}],navIndices[],excludedIndices[]}`;容错解析复用 solver 的 extractJson;**验证**:索引存在、组间不相交;失败→带差异回喂重枚举≤2轮;`enabled` 与 solver 同开关。
- `arbitrate.ts`:L2/L3 分歧组逐个交 Jev(`choice`/`noul`),dry-run 时分歧一律归 unclassified。
- `conservation.ts`:候选全集=role∈{radio,checkbox}∪quizSlot 存在∪题目区 textbox;归属校验、轮次控制、最终 unaccounted 列表。
- `session.ts`:按 capturedAt 排序;题干归一化哈希去重;progressClaim 跨页连续性对账,不符记 diagnostics + `needsHunt` 标志。

### 4.3 recipes.ts + distill.ts(沉淀)

**L1 读取方向语义(review F5c 补充)**:存储的配方只是**加速器**——必须现场实证确认启发式分组(题干计数相等 + 成员归属一致)才允许跳过 L2/L3,标记 `source:'recipe'`;计数偏大意味漏题,一律拒绝降级 L2。守恒审计照常运行,完整性从不下放给配方。
- distill 仅在**在线 inspect 全绿后**执行:对 stem 元素求 CSS 路径(tag+有限 class,剔除疑似随机 token `[a-f0-9]{6,}`),求 ≥80% 共享的最短祖先前缀;`querySelectorAll(sel).length === stems.length` 现场验证通过才写入(op:'eval' 探测,选择器按 §3 安全策略转义);confidence 0.9,验证不过即丢弃。
- `recipes.json` 按 origin 一文件;inspect L1 命中后同样现场验证,失败自动弃用降 L2。

### 4.4 timekeeper 通用心跳探测(observe.ts)
- 经 CDP(MAIN world)安装 XHR/fetch 环形缓冲 `window.__c4gXhrRing`(≤200 条),`detectHeartbeat()`:按 method+path 聚类,≥4 次、周期中位数∈[5,60]s、变异系数<0.35 判为心跳候选;**只读**,绝不伪造。moodle-video 适配器已知 pattern 走快路径,未知平台走探测。

### 4.5 quiz-loop / CLI 改造
- quiz-loop 改为消费 InspectionResult(原 quizSlot 直读降级为 hint 输入);新增狩猎循环(conservation fail 或 needsHunt → 滚动/展开 → 重新 capture+inspect,≤2轮);AUTO_SUBMIT 安全门不变。
- CLI 新增:`inspect [--url SUB | --from FILE] [--learn]`、`corpus list|show <id>`。

## 5. 测试与语料

- 单测:heuristic 分组、conservation 三态、LLM 验证器(幻觉索引被拒+回喂)、仲裁 mock、session 合并/去重、distill 选择器推导(需 DOM,host 加 devDep `linkedom`)、心跳聚类。
- 语料 fixture(提交入库):`packages/host/test/fixtures/corpus/<case>/capture.json + gold.json`。三例:①moodle-like(带 .que hint)②generic-radios(纯启发式)③tricky(多选+填空+nav 噪声+折叠区)。gold = QuizQuestionModel[](索引引用 capture.table)。
- 源码级守卫(沿用 M1 测试风格):无伪造心跳、无加速、eval 表达式白名单。

## 6. 实施泳道

P1 protocol+fixtures → P2a capture/recipes/distill ∥ P2b inspect 核心 → P3 集成(quiz-loop/timekeeper/CLI)→ P4 独立 review。每步独立 commit。
