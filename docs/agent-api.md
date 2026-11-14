# F 智能体与地图接口

从仓库根目录运行，需 Node.js 22+，无第三方依赖。

```sh
npm test
node agents/cli.mjs --offline examples/f-suzhou-request.json
node agents/cli.mjs --offline examples/f-multicity-request.json
node agents/cli.mjs --offline examples/f-invalid-request.json
node agents/cli.mjs --mock examples/f-requirements-request.json
node agents/cli.mjs --mock=route-unavailable examples/f-handoff-request.json
node agents/cli.mjs --mock=search-unavailable examples/f-provider-failure-request.json
```

CLI 在标准输出返回 `AgentResult` JSON。`--offline` 使用导入数据和本地规则。`--mock` 使用苏州固定数据与模拟接口，无需密钥。退出码 0 表示节点产出结果（包括需求确认草案），1 表示节点失败，2 表示命令或输入文件错误。

## D 调用方式

```js
import { createAgent, NODE_DEPS, validateAgentResult } from './agents/index.mjs';

const agent = createAgent();
const parsed = await agent.runNode({ runId, nodeId: 'parse', attempt: 1, input });
const result = await agent.runNode({
  runId, nodeId: 'preferences', attempt: 1, timeoutMs: 5000, dependencies: { parse: parsed }
}, { signal });
if (!validateAgentResult(result)) throw new Error('F 返回的节点产物结构无效');
```

`AgentRequest` 使用 `runId`、`nodeId`、`attempt`，并可提供 `timeoutMs`（默认 60000）。解析节点接收 `input` 或显式提交的 `requirementText`，其余节点接收 `dependencies` 中同一运行的上游成功产物。F 在输入依赖和输出两端做结构校验，结果包含 `schemaVersion: 1`、相同的三个标识和 `{status: 'ok', data}` 或 `{status: 'error', error: {code, message, retryable}}`。D 使用 `NODE_DEPS` 派发，保留当前有效尝试的结果，决定重试与返工上限并拒收过期产物。

超时返回 `AGENT_TIMEOUT`（可重试），取消返回 `AGENT_CANCELLED`（不可重试）。D 可通过第二参数传入 `AbortSignal`。默认地图和模型请求会随节点中止。外部适配器可经 `providerFactory({signal})` 取得节点信号。缺密钥、输入错误和未确认需求草案需要补充输入或配置。上游服务短时不可用和模型结构错误可按重试标记处理。部分路线失败且可保留候选时，结果仍为 `ok`，缺口记录于 `issues`。

只传 `requirementText` 时，成功返回 `parse.data.state: 'needs_confirmation'` 和结构化 `requirementDraft`。D 在此处暂停派发，待调用端确认后将正式字段放进 `input` 再执行。普通聊天没有自动触发入口，文本提取也不会改写已有成员偏好。

| 节点 | 依赖 | 输出 |
| --- | --- | --- |
| `parse` | — | 当地日期、城市、成员偏好、预算、导入地点与报价 |
| `retrieve` | `parse` | 导入候选、高德 POI 和查询异常 |
| `preferences` | `parse` | 必去和饮食约束、各成员预算、节奏协调建议 |
| `map` | `parse`、`retrieve`、`preferences` | 按协调结果编排行程站点，输出路线耗时、地点歧义和待确认状态 |
| `plan` | `parse`、`preferences`、`map` | 多日行程、费用、已列金额合计和待校验问题 |

`runWorkflow({ runId, input })` 可用于本地演示，返回 `{ result, nodes }`，并行运行检索和偏好协调，再等待两者完成后调度地图。模拟适配器从 `agents/mock.mjs` 导入 `createMockProviders({ scenario })`，可复现正常、检索失败和部分路线失败。

## 结构化输入

- `room` 必须有 `id` 和 `destination`。传 `room.startDate/endDate`、顶层 `durationDays`，或同时传入并核对一致性。日期为 `YYYY-MM-DD`，含首尾；只有时长时输出 `day` 和 `date: null`。多城传 `stops: [{city, days}]`，按顺序分配日序。课程演示覆盖单城一至三日，模块支持完整行程。单次输入最多 3660 天。
- `members` 采用 `[{id, preference}]`，`preference` 沿用 A 的 `budgetFen`、`pace`、`mustVisit` 和 `dietaryRestrictions`，也可传 `transportMode`、`interests`。顶层可提供 `origin`、`travelerCount`、团队 `budgetFen`、`mustVisit`、`interests` 和 `lodgingRequirements`。只有明确传入的约束才进入偏好协调。
- `transportMode` 默认 `transit`，可选 `walking`、`transit`、`driving`、`taxi`、`subway`、`bus`、`ferry`、`rail`、`flight`。跨城默认沿用此值，可指定 `intercityMode`。`routePreferences: [{id?, day 或 date, from, to, mode, vehicles?, seatsPerVehicle?}]` 覆盖匹配路段，`avoidModes` 为禁用方式。
- `journeys` 记录已知往返与跨城交通，字段为 `id, kind, mode, fromCity, fromPlace, toCity, toPlace, departDay/Date, arriveDay/Date, departTime?, arriveTime?, bufferMinutes?, source?`。`kind` 支持 `outbound`、`return`、`intercity`。每日最多一条到城约束和一条离城约束，换乘可以合为一条行程记录。已知时刻和缓冲进入行程约束，缺项交给后续确认。
- `stays: [{id, city, place?, checkInDay/Date, checkOutDay/Date, rooms}]` 显式提供入住、退房和房间数。`nights` 按入住和退房日序之差计算，`roomNight` 数量为房间数乘晚数。
- `guides: [{text?, screenshotRef?, url?, city?}]` 接收攻略正文、受控截图引用和原帖链接。`recognizeGuide(ref)` 可接入团队截图识别工具，返回文字。DeepSeek 或注入的 `extractGuide({text, cities})` 提取候选并保留来源；没有可用资料时产出明确问题。原帖链接用于引用。
- `places` 用于导入已整理的地点。提供 `name`、`city`、`kind`（`sight`、`food`、`hotel`、`station`）和 `source`。可附加 `address`、高德 `location: [经度, 纬度]`、`citycode`、`opening: [{date?, start, end}]` 和 `dietary` 标签。无日期的营业时段表示一般时段。遇到重名必去地时，问题中附候选 ID、城市和地址。
- `quotes` 采用团队覆盖口径，需传 `category`、`label`、`scope`（`personal` 或 `shared`）、`unit`、`unitFen`、`quantity`、`source`。可指定 `travelers`、`place`、`date`、`conditions` 和 `taxIncluded`。`serviceId` 关联住宿、交通或指定路段；不同分类重复填同一笔金额时使用相同 `chargeId`。区间价传 `unitFenRange: [下限, 上限]`，`unitFen` 设为 `null`。五个演示类别可以扩展，缺价的城际交通单独标记。

## E 校验与 C 入库

- `data.days[].activities[]` 包含当地 `start/end`、地点、坐标、活动类型和 `transport`。结构化 `inboundRoute` 带起终点、日序、方式、耗时、来源及可取得的换乘子段和地图坐标。缺路线时 `durationMinutes: null`，编排使用明确标注的 `reservedMinutes: 30`。`journeyIds` 关联覆盖当日的往返或跨城段。
- `data.expenses[].totalFen` 为单价乘数量后的团队金额，区间报价的金额仍为 `null`。`budget.categories` 汇总分类，`quotedRangeFen` 覆盖已列的确定值和区间，有完全缺价项时 `totalRangeFen` 为空。每笔费用均有明确金额后才计算余额和人均参考。区间上界超过团队预算时输出风险。
- 来源结构为 `{provider, reference, queriedAt, confidence}`。`confidence` 取 `verified`（供应方返回的 POI）、`estimated`（路线、时间建议或明确的费用估算）、`unverified`（外部导入资料待核实）、`missing`（数据缺失）。`queriedAt` 为 ISO 时间，未知时为 `null`。营业和饮食可随地点证据复核。
- `data.issues[]` 含问题码及可定位的字段。例如 `PRICE_MISSING`、`ROUTE_UNVERIFIED`、`OPENING_CONFLICT`、`DIET_UNVERIFIED`、`MUST_VISIT_MISSING`、`KNOWN_COST_OVER_BUDGET`。节点成功表示已产出结构化候选，由 E 给出校验与人工确认判定。
- C 可按 `roomId` 关联房间，保存 `plan.data` 全量行程及来源字段，另存结果信封的 `schemaVersion`、`runId`、`nodeId` 和 `attempt`。保存与重读需保留费用和路线的 `null`。对 A 返回时补上方案 `id`、`version` 和 `status`，沿用现有 [前端接口约定](frontend-api.md)。候选、正式版本及并发保护由 C、D、E 的存储和发布契约决定。

### 联调样例

| 场景 | 可读取的结果 | 联调观察点 |
| --- | --- | --- |
| 苏州两日 | [行程 JSON](../examples/f-suzhou-result.json) | 各日活动、交通、费用、来源。团队门票 16000 分，四类缺价 |
| 多城和未定日期 | [行程 JSON](../examples/f-multicity-result.json) | 四日日序、跨城交通、间夜、区间费用 |
| 六类校验证据和缺价 | [行程 JSON](../examples/f-handoff-result.json) | E 用下表逐项核查。C 可用同一结果验证序列化和空值 |
| 无效日期 | [节点错误](../examples/f-invalid-result.json) | D 接收不可重试的 `INVALID_INPUT` |
| 模拟高德检索失败 | [节点错误](../examples/f-provider-failure-result.json) | D 接收可重试的 `AMAP_UNAVAILABLE`，下游等待 |
| 多人需求文本 | [解析草案](../examples/f-requirements-result.json) | 先确认需求，再继续规划 |

| E 的校验项 | F 提供的字段 | 六类样例的信号 |
| --- | --- | --- |
| 预算 | `budget`、`expenses[].totalFen`、`unitFenRange`、数量 | `KNOWN_COST_OVER_BUDGET`、`PRICE_MISSING` |
| 时间 | `days[].activities[].start/end`、`inboundRoute`、`journeys` | `JOURNEY_TIME_CONFLICT` |
| 营业 | 活动 `opening`、`openingSource` 与安排时段 | `OPENING_CONFLICT` |
| 必去 | `preferences.mustVisit`、活动 `placeName/placeId` | `MUST_VISIT_MISSING` |
| 饮食 | `preferences.dietaryRestrictions`、餐饮 `dietary` | `DIET_UNVERIFIED` |
| 数据可信度 | 地点、时间、路线、费用各自的 `source` | `ROUTE_UNVERIFIED`、`PRICE_MISSING` |

F 的 `issues` 用于定位证据。E 根据证据计算阻塞、警告与人工确认结果。投票未过、正式版本冲突和运行取消后的发布守卫由 C、D、E 联合验收。

`reviseWorkflow({runId, input, previousPlan, instruction})` 支持文字修改默认市内交通、降低团队预算或保留已导入地点。程序重新运行规划，交通模式变更时将未绑定保留路段的旧市内报价置回待确认，附上修改字段和已知费用变化。替换指定餐厅、变更日期等可通过更新结构化输入重跑。D 可依据问题码发起定向返工；E 负责发布门控。

## 实际服务

通过进程环境变量注入 `AMAP_WEB_SERVICE_KEY` 和可选的 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`。Node.js 也支持用 `node --env-file=.env agents/cli.mjs examples/f-suzhou-request.json` 加载本机配置。

高德提供地点检索和路线。公共交通按行程日期 09:00 查询参考，指定地铁、公交或轮渡时，须返回对应子段才采用。打车时长用驾车路线估算，保留其依据。航班班次与报价可由成员补充。`providers.quote(request)` 是住宿与往返报价工具接入口，要求匹配服务日期、人数、住宿间夜及税费状态。真实截图识别与自动报价供应方待联调。DeepSeek 可提取攻略正文、解析支持的文字修改及建议景点停留分钟。高德失败时保留已有候选及问题，完全缺少候选时返回结构化错误。

参考 [高德 POI 搜索](https://developer.amap.com/api/webservice/guide/api/newpoisearch)、[高德路线规划](https://developer.amap.com/api/webservice/guide/api/newroute) 和 [DeepSeek JSON 输出](https://api-docs.deepseek.com/guides/json_mode/)。
