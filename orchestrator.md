# D 模块 · 编排器接口契约（执行层）

> 主责：成员 D。作用：把五个智能体与程序校验串成一条可控的执行链。
> 代码位置：`orchestrator/`，纯 ESM、零依赖；测试：`test/orchestrator.test.mjs`。
> 状态：C 的 `POST /teams/{id}/tasks` 已是入口，本文件只补"执行过程"缺的三处字段。

## 1. 三个变更（对 C 的 schema 都是纯新增）

| # | 变更 | 位置 | 为什么 |
|---|---|---|---|
| 1 | `TaskProgress` 增加 `nodes[]` | `TaskDetail.progress` | 现在只有 7 个串行 stage，看不到节点、依赖、并行、返工、门控 |
| 2 | `EventRecord` 增加 26 类 `task.*` 执行事件 | `TaskDetail.events` / `GET /events` | 现有 3 类都是业务变化，B 画不出执行过程 |
| 3 | 新增 `GET /teams/{id}/tasks/{task_id}/nodes` | 新路径 | 大任务只拉节点列表，不必传整份 TaskDetail（可选，也可直接塞进 TaskDetail） |

### 1.1 `nodes[]` 的字段

```json
{
  "id": "retrieve_candidates",
  "title": "内容检索 · 候选与报价",
  "kind": "agent",
  "status": "succeeded",
  "deps": ["parse_intent"],
  "round": 0,
  "attempts": [{ "attempt": 1, "state": "succeeded", "startedAt": 400, "endedAt": 1300, "error": null }],
  "startedAt": 400,
  "endedAt": 1300,
  "error": null
}
```

- `kind`：`agent`（F 的智能体）/ `program`（E 的校验、C 的存储）/ `gate`（人工确认）
- `status`：`pending | ready | running | succeeded | failed | blocked | skipped | cancelled`
- `startedAt` / `endedAt`：任务内的相对毫秒（与 `TaskProgress` 同一时间轴）

### 1.2 新增的执行事件（26 种，全部为新加）

| 组 | type |
|---|---|
| 运行 | `task.started` `task.paused` `task.resumed` `task.cancel_requested` `task.finished` `task.budget_exceeded` |
| 节点 | `task.node_ready` `task.node_started` `task.node_succeeded` `task.node_failed` `task.node_retrying` `task.node_blocked` `task.node_skipped` `task.node_cancelled` `task.node_added` |
| 校验与返工 | `task.validation_completed` `task.repair_planned` `task.repair_blocked` |
| 人工 | `task.human_requested` `task.human_resolved` |
| 候选与表决 | `task.candidate_proposed` `task.vote_opened` `task.vote_cast` `task.vote_closed` |
| 发布 | `task.published` `task.version_conflict` |

事件结构：`{ seq, taskId, at, type, level, nodeId, message, data }`；`seq` 从 1 连续递增，断线用 `event_cursor` 补齐。
未登记的类型降级为 `level: "warning"` 并带 `data.unknownEventType = true`，不静默丢弃。

> 与 C 现有的 `resource_changed` / `message_created` / `planning_context_changed` 并列，三者不动。

### 1.3 字段命名与视图映射

内部用驼峰，**对外一律蛇形**（与 `openapi.json` 一致）。C 的路由只需要：

```js
import { toTaskDetail } from '../orchestrator/index.mjs';
return toTaskDetail(run.snapshot());   // 直接返回合规的 TaskDetail
```

`toTaskDetail()` 已补齐 `TaskDetail` 的必填项：`execution_state`、`progress.{stage,completed_units,total_units}`、
`attempt_count`、`attempt_limit`、`retry_allowed`、`next_retry_at`、`available_actions`、`created_at`、
`finished_at`、`request_snapshot_id`、`result_snapshot_id`、`basis_token`、`nodes[]`。

> `context`、`request`、`requested_by` 由 C 的存储填充，调用时可传第二个参数覆盖。

## 2. 集成方式（C 的路由里三行）

```js
// POST /teams/:id/tasks
import { Orchestrator } from '../orchestrator/index.mjs';

const run = new Orchestrator({ input: snapshot, autoConfirm: false, autoVote: false });
runs.set(run.taskId, run);
run.start();                       // 不 await，立刻返回 202
return { task_id: run.taskId, status: 'accepted' };
```

```js
// GET /teams/:id/tasks/:taskId  → progress / nodes / status
runs.get(taskId).snapshot();

// GET /teams/:id/events?cursor=42 → 断线补齐
runs.get(taskId).eventsSince(Number(cursor));

// POST /teams/:id/rounds/:rid/my-vote → 本人投票
runs.get(taskId).castVote(memberId, choice);
```

## 3. 快照样例（`snapshot()` 实返）

```json
{
  "taskId": "task-9f3c1a2b",
  "status": "awaiting_human",
  "progress": { "stage": "checking", "message": "存在未确认报价，需人工确认口径。", "completedUnits": 5, "totalUnits": 10 },
  "nodes": [
    { "id": "parse_intent", "status": "succeeded", "deps": [], "attempts": [{ "attempt": 1, "state": "succeeded" }] },
    { "id": "retrieve_candidates", "status": "succeeded", "deps": ["parse_intent"] },
    { "id": "validate_plan", "status": "succeeded", "deps": ["plan_itinerary"] },
    { "id": "confirm_unverified", "kind": "gate", "status": "running", "deps": ["validate_plan"] },
    { "id": "propose_candidate", "status": "pending", "deps": ["confirm_unverified"] }
  ],
  "edges": [["parse_intent", "retrieve_candidates"], ["validate_plan", "confirm_unverified"]],
  "counters": { "steps": 6, "repairRounds": 0, "peakParallel": 2, "parallelLimit": 3 },
  "gate": { "nodeId": "confirm_unverified", "state": "open", "options": [{ "id": "accept", "label": "确认按估算区间处理" }] },
  "cursor": 18
}
```

## 4. 事件序列样例（B 直接照着渲染）

```
 1 task.started             开始执行：杭州
 2 task.node_ready          parse_intent 就绪
 3 task.node_started        解析需求 开始（第 1 次）
 4 task.node_succeeded      解析需求 完成
 5 task.node_ready          内容检索 就绪
 6 task.node_ready          偏好协调 就绪
 7 task.node_started        内容检索 开始（第 1 次）
 8 task.node_started        偏好协调 开始（第 1 次）
 9 task.node_succeeded      偏好协调 完成
10 task.node_succeeded      内容检索 完成
11 task.validation_completed 校验完成：1 项阻塞、0 项警告
12 task.repair_planned      第 1 轮定向返工（budget）
13 task.node_added          返工节点：内容检索 · 替代项（第 1 轮）
...
20 task.candidate_proposed  候选版本 v2 生成
21 task.vote_opened         开始对 v2 表决：3 人，门槛 2 票
22 task.vote_cast            m1 投出 赞成
23 task.vote_closed         表决结束：赞成 2 / 门槛 2，通过
24 task.published           v2 已发布为正式行程
```

## 5. 与 E 的规则对接

`orchestrator/adapters/rules.mjs` 在 `rules/index.mjs` 存在时自动改用 E 的实现，否则用同签名兜底：

```js
rules.validatePlan(plan, { budgetFen, mustVisit, dietaryRestrictions })  // → issues / blocking / requiresConfirmation
rules.decideGate(validation)                                             // → block | confirm | publish
rules.createVote(version, eligible) / castVote / tally                   // 门槛 floor(N/2)+1
rules.publishCandidate(plans, candidateId, baseOfficialVersion)          // 版本守卫
```

问题码映射（D 侧）：

| 问题码 | 返工分支 |
|---|---|
| `V-BUDGET` | 内容检索 · 替代项（economy） |
| `V-TIME` / `V-TIME-CONFLICT` / `V-HOURS` | 地图对接 · 重算路线 |
| `V-DIET` | 内容检索 · 替代菜 |
| `V-MUST-VISIT` | 不返工，直接停：必去与预算/时间冲突须由人取舍 |
| `V-PRICE-MISSING` | 不返工，插人工确认门控 |
| 未登记的码 | 不猜，直接停并报"编排器不认识该问题码" |

## 6. 边界

| 归 D | 不归 D |
|---|---|
| 节点依赖、并行度、重试、返工轮次、终止判定 | 六类校验规则、表决门槛、版本语义（E） |
| 暂停 / 继续 / 取消 / 节点超时 | 建表、认证、权限、幂等键、持久化（C） |
| 执行事件与节点快照 | 页面渲染（A / B） |
| 提示词与智能体调用节奏 | 智能体与地图实现（F） |

## 7. 验收（`npm test`）

1. 一次运行从 `accepted` 到 `finished`，产出 v2；
2. 内容检索与偏好协调时间区间重叠（真并行）；
3. 预算超支 → 定向返工 1 轮 → 通过；
4. 同一组阻塞码连续两轮 → 立即 `blocked`，不空转；
5. 节点超时 → 可重试失败 → 受 `maxAttempts` 封顶；
6. 取消后 0 个 `running` 节点，0 条 `task.published`；
7. 事件 `seq` 连续，且全部登记在白名单内。
