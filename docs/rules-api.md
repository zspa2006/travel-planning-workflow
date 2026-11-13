# E 模块 · 规则与版本（校验 / 投票 / 发布）接口契约

> 主责：成员 E。作用：确保 AI 行程符合硬约束，且正式方案经成员同意。
> 代码位置：`rules/`，纯函数实现，无第三方依赖；测试：`test/rules.test.mjs`（`npm test`）。

## 1. 模块划分

| 文件 | 职责 | 供谁调用 |
| --- | --- | --- |
| `rules/validate.mjs` | 六类校验，返回结构化问题码与阻塞/警告级别 | D（调度）校验候选、B（工作台）展示 |
| `rules/vote.mjs` | 一人一票、赞成门槛 floor(N/2)+1、弃权不计 | C（存储）执行投票、B 展示票型 |
| `rules/publish.mjs` | 候选/正式版本管理、发布前版本守卫、人工确认缺价 | C（存储）发布、D 记录发布结果 |
| `rules/index.mjs` | 统一导出 + `decideGate` 门控判定 | 各模块统一入口 |

## 2. 数据结构（与 `frontend-api.md` 对齐）

```js
Plan     { id, version, status: "candidate"|"official"|"archived", title, days: Day[], expenses: Expense[] }
Day      { date: "YYYY-MM-DD", activities: Activity[] }
Activity { start: "HH:mm", end: "HH:mm", place: string, transport: string,
           // 以下为 F/E 联调可选字段：
           kind?: "attraction"|"meal"|"transit"|"rest",   // 活动类型
           contains?: string[],                            // 菜品/食材/过敏原
           source?: string,                                // 数据来源
           confidence?: "high"|"medium"|"low" }            // 可信度
Expense  { category, label, scope: "personal"|"shared", totalFen: integer|null }
```

- 金额单位为**分**（整数）；`totalFen: null` 表示缺价。
- 校验上下文 `context`：`{ budgetFen, mustVisit, dietaryRestrictions, evidence }`，其中
  `evidence.places = { [地点]: { open:"HH:mm", close:"HH:mm" } }` 用于营业时间核验（可选，无证据则不臆断）。

## 3. 六类校验与问题码

`validatePlan(plan, context)` 返回：

```js
{
  issues: Issue[],
  knownTotalFen,        // 已知费用合计（缺价不计入，不按 0 元处理）
  unknownCount,         // 缺价项数量
  blocking,             // 阻塞级问题
  warnings,             // 警告级问题
  requiresConfirmation, // 需人工确认的问题（缺价）
  hasBlocking, hasUnknownPrice
}
```

问题结构 `Issue = { code, severity: "blocking"|"warning", location, message, suggestion, requiresConfirmation? }`。

| code | severity | 含义 | 处理 |
| --- | --- | --- | --- |
| `V-BUDGET` | blocking | 已知费用合计超出预算 | 压缩可选费用或提高预算 |
| `V-TIME` | blocking | 时间格式无法解析 / 结束不晚于开始 | 修正起止时间 |
| `V-TIME-CONFLICT` | blocking | 同日相邻活动时间重叠 | 错开时间 |
| `V-HOURS` | blocking | 活动超出营业时段 | 调整到营业时段内 |
| `V-MUST-VISIT` | blocking | 必去地点未出现在行程 | 补充安排或移除必去要求 |
| `V-DIET` | blocking | 菜品含禁忌食材 | 替换菜品 |
| `V-SOURCE` | warning | 数据来源可信度低 | 换高可信来源或人工复核 |
| `V-PRICE-MISSING` | warning | 缺价，未计入已知合计 | 人工确认口径（`requiresConfirmation`） |

## 4. 门控判定

`decideGate(validateResult)`：

| 返回值 | 条件 |
| --- | --- |
| `{ action: "block" }` | 存在阻塞级问题（如超预算）→ 不能发布 |
| `{ action: "confirm" }` | 无阻塞，但存在缺价 → 需人工确认口径 |
| `{ action: "publish" }` | 校验通过 → 可进入投票与发布 |

人工确认缺价用 `resolveExpense(plan, index, { totalFen, confirmedBy, at? })` 补成明确金额后重新校验。

## 5. 投票规则

- `createVote(version, eligible)`：建立资格名单快照与门槛。
- 门槛 `thresholdOf(N) = floor(N/2)+1`；5 人时门槛为 3。
- `castVote(vote, memberId, choice)`：一人一票；资格名单外成员、重复投票、非法选择均返回 `{ ok:false, message }`。
- `tally(vote)`：返回 `{ approve, reject, abstain, threshold, remaining, status }`；
  `status` = `passed`（赞成达门槛）/ `failed`（剩余全赞成也无法达标）/ `open`。弃权不计赞成、不降低门槛。

## 6. 版本管理与发布守卫

- `proposeCandidate(plans, draft)`：基于当前最大版本号 +1 生成候选。
- `publishCandidate(plans, candidateId, baseOfficialVersion)`：
  - 发布守卫：当前正式版本必须仍等于 `baseOfficialVersion`（任务发起时记录），否则返回
    `{ ok:false, code:"VERSION_CONFLICT" }` —— **旧任务不能覆盖新正式版本**。
  - 成功：候选 → `official`，原正式版本 → `archived`，返回 `{ ok:true, plans, publishedVersion }`。
  - 不修改入参，返回新数组，便于 C 的持久化事务一次性写入。

## 7. 完成标准对照

| 标准 | 实现 | 测试 |
| --- | --- | --- |
| 超预算不能发布 | `V-BUDGET`(blocking) → `decideGate` 返回 `block` | ✅ |
| 未知费用不按 0 元处理 | 缺价不计入 `knownTotalFen`，标记 `V-PRICE-MISSING`(confirm) | ✅ |
| 5 人投票至少 3 人赞成 | 门槛 `floor(5/2)+1 = 3` | ✅ |
| 旧任务不能覆盖新正式版本 | `publishCandidate` 版本守卫返回 `VERSION_CONFLICT` | ✅ |
