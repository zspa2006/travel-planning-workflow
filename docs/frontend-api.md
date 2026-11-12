# A 与 C 及 E 的前端接入约定

此版用于联调评审，当前实现按下面的 JSON 形状读取。C 负责认证、持久化和权限，E 负责版本状态语义，A 负责界面与展示。

| 方法与路径 | 请求 JSON | 成功响应 JSON |
| --- | --- | --- |
| GET /session | — | `User` 或 `null` |
| POST /session | `{name,password}` | `User`，设置会话 Cookie |
| DELETE /session | — | 204，清理会话 |
| GET /rooms | — | `Room[]`，仅当前成员可见房间 |
| POST /rooms | `{name,destination,startDate,endDate}` | `Room`，创建者作为成员 |
| POST /rooms/join | `{code}` | `Room`，已加入时幂等返回 |
| GET /rooms/{id} | — | `Room` |
| GET /rooms/{id}/preferences/me | — | `Preference` 或 `null` |
| PUT /rooms/{id}/preferences/me | `Preference` | 保存后的 `Preference` |
| GET /rooms/{id}/plans | — | `Plan[]`，无方案时为 `[]` |

```text
User       { id: string, name: string }
Room       { id, code?, name, destination, startDate, endDate, members: User[] }
Preference { budgetFen: integer, pace: "relaxed"|"balanced"|"packed",
             mustVisit: string[], dietaryRestrictions: string[] }
Plan       { id: string, version: integer, status: "candidate"|"official"|"archived",
             title: string, days: Day[], expenses: Expense[] }
Day        { date: "YYYY-MM-DD", activities: Activity[] }
Activity   { start: "HH:mm", end: "HH:mm", place: string, transport: string }
Expense    { category: string, label: string, scope: "personal"|"shared",
             totalFen: integer|null }
```

- 房间日期使用当地日历日期，日程按当地时间展示。后端按行程实际顺序返回天与活动。多城可在目的地和地点文字中呈现，结构化城市与时区字段待联合评审。
- 金额以人民币分传输。个人预算是成员填写的偏好，团队预算由后端按团队规则另行存储及核验。每笔费用的 `totalFen` 是已折算至整个团队的该项总额，`null` 表示缺价，前端显示待确认并单独合计已知费用。
- `official` 指当前正式方案，每房间最多一条。被替代的版本为 `archived`。前端初次进入优先显示正式方案，用户可切换版本，刷新后保留仍存在的选择。
- 非成功响应使用 HTTP 状态和 `{code,message}`。建议 401 表示会话失效，403 表示没有房间访问权限，404 表示房间或邀请码不存在，409 表示版本冲突，422 表示字段校验失败。会话和房间权限在服务端校验。
- 同源部署可经反向代理提供 `/api`。跨源时约定可携带凭据的 CORS 来源、Cookie 策略和写操作 CSRF 防护。前端登录使用已有账号，注册与账号维护由 C 提供。
- 规划启动、门控、投票和发布的接口由 B、D、E 联合定义。A 通过 C 的方案查询读取版本结果。
