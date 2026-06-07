# 校车临时改线审批 JSON API

本地可运行的校车临时改线审批系统，基于 Node.js + Express + SQLite。

## 功能特性

- 完整审批流程：申请人提交 → 调度复核 → 安全审批 → 发布改线
- 申请人本人或 admin 可在待调度复核、待安全审批、待发布阶段取消申请
- 状态机流转校验，非法流转直接拒绝（终态不可取消，返回 INVALID_TRANSITION）
- 权限控制：普通老师不能审批、不能取消他人申请，调度/安全/管理员各有分工
- 冲突检测：时间段冲突、车辆冲突检测，冲突时拒绝发布
- 幂等保护：重复发布不会改坏数据
- 统一错误响应结构，稳定可预测
- SQLite 持久化：申请、角色、冲突记录、审批日志、审计日志全落盘，重启不丢失
- 查询接口展示：当前状态、取消备注、影响站点（移除/新增）、操作人、完整历史（含 CANCEL 记录）
- 导出：admin/调度/安全员可按状态、线路、日期、申请人、是否有取消备注筛选；普通老师仅能导出本人申请，越权筛别人返回 403；CSV 17 列顺序稳定；JSON 带 filters/filter_summary 便于留档；每次导出写入审计日志（操作者、格式、筛选条件、导出条数），重启后日志与数据均可查
- 待处理提醒：调度/安全/admin 查询本人角色待处理申请，支持按即将超时/已超时、线路、状态筛选；普通老师仅看到本人未结束申请；超时阈值可通过环境变量 `APPROVAL_TIMEOUT_MINUTES` 配置（缺省 60 分钟）；每次查询写入审计日志（操作者、角色、筛选条件、命中数量、超时统计）

## 目录结构

```
.
├── data/                    # SQLite 数据库文件（自动生成）
├── src/
│   ├── db/index.js          # 数据库连接与 schema 初始化
│   ├── middleware/
│   │   ├── auth.js          # 认证与角色权限
│   │   └── audit.js         # 审计日志
│   ├── routes/
│   │   ├── applications.js  # 改线申请相关路由
│   │   └── users.js         # 用户查询路由
│   ├── scripts/init-db.js   # 初始化数据脚本
│   ├── services/
│   │   └── applicationService.js  # 核心业务逻辑
│   ├── utils/response.js    # 统一响应与错误类
│   └── server.js            # 服务入口
├── package.json
└── README.md
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 初始化数据库（首次运行）

```bash
npm run init-db
```

初始化后创建 5 个用户（请求头 `X-User-Id` 传 id）：

| id | username       | 姓名     | 角色         | 权限                                 |
|----|----------------|----------|--------------|--------------------------------------|
| 1  | teacher_zhang  | 张老师   | teacher      | 提交申请                             |
| 2  | teacher_li     | 李老师   | teacher      | 提交申请                             |
| 3  | dispatcher_wang| 王调度   | dispatcher   | 调度复核（通过/驳回）                |
| 4  | safety_zhao    | 赵安全员 | safety       | 安全审批（通过/驳回）                |
| 5  | admin_chen     | 陈主任   | admin        | 可执行任意操作、发布改线             |

如需重置数据，删除 `data/school-bus.db` 后重新执行 `npm run init-db`。

### 3. 启动服务

```bash
npm start
```

默认监听 `http://localhost:3000`，可通过环境变量 `PORT` 修改。

健康检查：`GET http://localhost:3000/health`

## API 总览

所有接口（除 `/health`、`/` 外）都需要请求头 `X-User-Id`（数字用户 id）。

### 统一响应结构

成功：
```json
{
  "success": true,
  "code": "OK",
  "message": "ok",
  "data": { ... },
  "timestamp": "2026-06-07T08:00:00.000Z"
}
```

失败：
```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "参数校验失败",
  "details": ["route_name 必填且为非空字符串"],
  "timestamp": "2026-06-07T08:00:00.000Z"
}
```

常见错误码：`AUTH_REQUIRED`、`PERMISSION_DENIED`、`VALIDATION_ERROR`、`NOT_FOUND`、`INVALID_TRANSITION`、`PUBLISH_CONFLICT`、`INTERNAL_ERROR`。

### 状态流转

```
PENDING_SUBMITTED (待调度复核)
       │
       ├─ 调度通过 → DISPATCH_REVIEWED (待安全审批)
       │                  │
       │                  ├─ 安全通过 → SAFETY_APPROVED (待发布)
       │                  │                  │
       │                  │                  ├─ 发布 → PUBLISHED (已发布)
       │                  │                  └─ 取消 → CANCELLED (已取消)
       │                  ├─ 安全驳回 → REJECTED (已驳回)
       │                  └─ 取消 → CANCELLED (已取消)
       ├─ 调度驳回 → REJECTED (已驳回)
       └─ 取消 → CANCELLED (已取消)
```

终态（`REJECTED`、`CANCELLED`、`PUBLISHED`）不可再流转。

**可取消状态**：`PENDING_SUBMITTED`（待调度复核）、`DISPATCH_REVIEWED`（待安全审批）、`SAFETY_APPROVED`（待发布）——即三个非终态均可取消。
**不可取消状态**：`PUBLISHED`、`REJECTED`、`CANCELLED` —— 取消返回 `INVALID_TRANSITION`。

## 接口详情与 curl 示例

### 1. 提交改线申请

`POST /api/applications`

请求体：
| 字段             | 类型     | 必填 | 说明                     |
|------------------|----------|------|--------------------------|
| route_name       | string   | 是   | 线路名称                 |
| original_stops   | string[] | 是   | 原站点列表               |
| new_stops        | string[] | 是   | 新站点列表               |
| effective_start  | string   | 是   | 生效开始 ISO 时间        |
| effective_end    | string   | 是   | 生效结束 ISO 时间        |
| vehicle_id       | string   | 否   | 车辆标识（用于冲突检测） |
| reason           | string   | 是   | 改线原因                 |

```bash
curl -s -X POST http://localhost:3000/api/applications \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{
    "route_name": "1号线",
    "original_stops": ["东门站","少年宫站","图书馆站","学校站"],
    "new_stops": ["东门站","人民广场站","体育馆站","学校站"],
    "effective_start": "2026-06-10T07:00:00.000Z",
    "effective_end": "2026-06-10T09:00:00.000Z",
    "vehicle_id": "BUS-A01",
    "reason": "少年宫路段道路施工，临时绕行"
  }' | jq
```

### 2. 查询申请列表

`GET /api/applications?status=&route_name=&start_date=&end_date=&page=1&page_size=20`

```bash
# 查询全部
curl -s http://localhost:3000/api/applications -H "X-User-Id: 1" | jq

# 按状态筛选
curl -s "http://localhost:3000/api/applications?status=PENDING_SUBMITTED" -H "X-User-Id: 1" | jq

# 按线路 + 日期筛选
curl -s "http://localhost:3000/api/applications?route_name=1号线&start_date=2026-06-01&end_date=2026-06-30" \
  -H "X-User-Id: 1" | jq
```

### 3. 查询申请详情（含完整历史、影响站点、操作人）

`GET /api/applications/:id`

```bash
curl -s http://localhost:3000/api/applications/1 -H "X-User-Id: 1" | jq
```

响应中关键字段：
- `status` / `status_label`：当前状态
- `affected_stops.removed`：被移除的站点
- `affected_stops.added`：新增的站点
- `applicant`：申请人信息
- `history[]`：完整操作历史，每条含 `action`、`operator`（操作人）、`from_status`、`to_status`、`comment`

### 4. 调度复核

`POST /api/applications/:id/dispatch-review`

权限：`dispatcher` 或 `admin`

请求体：`{ "approved": true|false, "comment": "..." }`

```bash
# 通过
curl -s -X POST http://localhost:3000/api/applications/1/dispatch-review \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 3" \
  -d '{"approved":true,"comment":"站点变更合理，同意复核"}' | jq

# 驳回
curl -s -X POST http://localhost:3000/api/applications/1/dispatch-review \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 3" \
  -d '{"approved":false,"comment":"绕行方案未覆盖早高峰，请补充说明"}' | jq
```

### 5. 安全审批

`POST /api/applications/:id/safety-approve`

权限：`safety` 或 `admin`

```bash
curl -s -X POST http://localhost:3000/api/applications/1/safety-approve \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 4" \
  -d '{"approved":true,"comment":"新线路安全，无风险点"}' | jq
```

### 6. 发布改线

`POST /api/applications/:id/publish`

权限：`admin`

- 必须先通过调度复核和安全审批（状态为 `SAFETY_APPROVED`）
- 自动检测时间段冲突和车辆冲突，冲突则拒绝并给出详情
- 重复发布幂等，不会改坏数据

```bash
curl -s -X POST http://localhost:3000/api/applications/1/publish \
  -H "X-User-Id: 5" | jq
```

### 7. 取消申请

`POST /api/applications/:id/cancel`

**权限**：申请人本人（`applicant_id === operator.id`）或 `admin`。其他老师、调度员、安全员均无权取消他人申请。

**请求体**：
| 字段     | 类型     | 必填 | 说明                                                                 |
|----------|----------|------|----------------------------------------------------------------------|
| comment  | string   | 否   | 取消备注。缺省时申请人本人取消默认为 "申请人取消"，admin 代取消默认为 "管理员代取消" |

**可取消状态**：
| 当前状态              | 状态文案     | 是否可取消 |
|-----------------------|--------------|------------|
| `PENDING_SUBMITTED`   | 待调度复核   | ✅ 可取消  |
| `DISPATCH_REVIEWED`   | 待安全审批   | ✅ 可取消  |
| `SAFETY_APPROVED`     | 待发布       | ✅ 可取消  |
| `PUBLISHED`           | 已发布       | ❌ 不可取消，返回 `INVALID_TRANSITION` |
| `REJECTED`            | 已驳回       | ❌ 不可取消，返回 `INVALID_TRANSITION` |
| `CANCELLED`           | 已取消       | ❌ 不可取消，返回 `INVALID_TRANSITION` |

**取消效果**：
1. 申请状态变更为 `CANCELLED`（已取消）
2. 写入 `cancel_remark` 字段（列表、详情、导出均可见）
3. `approval_logs` 新增一条 `action='CANCEL'` 记录（含操作人、from_status、to_status、comment）
4. `audit_logs` 记录接口调用（由审计中间件自动完成）
5. 详情页 `history[]` 中可看到 CANCEL 记录

**curl 示例**：

```bash
# 申请人本人取消（带备注，假设 id=1 状态为 PENDING_SUBMITTED）
curl -s -X POST http://localhost:3000/api/applications/1/cancel \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{"comment":"改线原因已消除，不需要改线了"}' | jq

# 申请人本人取消（缺省备注 → "申请人取消"）
curl -s -X POST http://localhost:3000/api/applications/1/cancel \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" | jq

# admin 代取消（带备注）
curl -s -X POST http://localhost:3000/api/applications/1/cancel \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 5" \
  -d '{"comment":"接教育局通知，该路段施工取消"}' | jq

# admin 代取消（缺省备注 → "管理员代取消"）
curl -s -X POST http://localhost:3000/api/applications/1/cancel \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 5" | jq
```

**成功响应示例**（HTTP 200）：

```json
{
  "success": true,
  "code": "OK",
  "message": "取消成功",
  "data": {
    "id": 1,
    "route_name": "1号线",
    "status": "CANCELLED",
    "status_label": "已取消",
    "cancel_remark": "改线原因已消除，不需要改线了",
    "applicant": { "id": 1, "name": "张老师", "role": "teacher" },
    "history": [
      {
        "action": "SUBMIT",
        "operator": { "id": 1, "name": "张老师" },
        "from_status": null,
        "to_status": "PENDING_SUBMITTED",
        "comment": "提交申请",
        "created_at": "2026-06-07T08:00:00.000Z"
      },
      {
        "action": "CANCEL",
        "operator": { "id": 1, "name": "张老师" },
        "from_status": "PENDING_SUBMITTED",
        "to_status": "CANCELLED",
        "comment": "改线原因已消除，不需要改线了",
        "created_at": "2026-06-07T08:30:00.000Z"
      }
    ]
  },
  "timestamp": "2026-06-07T08:30:00.000Z"
}
```

**失败响应示例**：

E1. 越权取消（非申请人非 admin，HTTP 403）：
```json
{
  "success": false,
  "code": "PERMISSION_DENIED",
  "message": "无权取消该申请，仅申请人本人或管理员可取消",
  "details": {
    "applicant_id": 1,
    "operator_id": 2,
    "operator_role": "teacher"
  },
  "timestamp": "2026-06-07T08:30:00.000Z"
}
```

E2. 终态不可取消（HTTP 409）：
```json
{
  "success": false,
  "code": "INVALID_TRANSITION",
  "message": "状态流转无效：PUBLISHED 无法流转到 CANCELLED",
  "details": {
    "from": "PUBLISHED",
    "to": "CANCELLED",
    "allowed": []
  },
  "timestamp": "2026-06-07T08:30:00.000Z"
}
```

E3. 申请不存在（HTTP 404）：
```json
{
  "success": false,
  "code": "NOT_FOUND",
  "message": "申请 99999 不存在",
  "details": null,
  "timestamp": "2026-06-07T08:30:00.000Z"
}
```

### 8. 导出数据

`GET /api/applications/export?format=json|csv&status=&route_name=&start_date=&end_date=&applicant_id=&has_cancel_remark=`

**权限规则**：
- `admin` / `dispatcher` / `safety`：可按任意条件筛选，包括 `applicant_id` 指定他人
- `teacher`（普通老师）：默认只能导出本人提交的申请；传 `applicant_id=自己id` 允许，传别人的 id 返回 `PERMISSION_DENIED`

**筛选参数**：

| 参数               | 类型    | 说明                                                           |
|--------------------|---------|----------------------------------------------------------------|
| `format`           | string  | `json`（默认）或 `csv`                                         |
| `status`           | string  | 按状态筛选，如 `PENDING_SUBMITTED`、`CANCELLED` 等             |
| `route_name`       | string  | 按线路名称模糊匹配                                             |
| `start_date`       | string  | 生效结束日期 >= 该日期（ISO 日期 YYYY-MM-DD）                  |
| `end_date`         | string  | 生效开始日期 <= 该日期（ISO 日期 YYYY-MM-DD）                  |
| `applicant_id`     | integer | 按申请人 id 筛选（仅 admin/dispatcher/safety 可跨人）          |
| `has_cancel_remark`| boolean | `true`/`1`/`yes` 仅导出有取消备注的；`false`/`0`/`no` 则相反   |

**响应说明**：
- JSON：返回 `{ count, items, filters, filter_summary }`，`filters` 记录实际使用的筛选条件，`filter_summary` 是便于归档的文字摘要
- CSV：17 列顺序稳定不变（ID、线路、原站点、新站点、移除站点、新增站点、生效开始、生效结束、车辆、原因、状态、状态描述、驳回原因、取消备注、申请人、创建时间、更新时间），带 UTF-8 BOM，Excel 可直接打开
- 每次导出都会写入 `audit_logs`（`action=APPLICATION_EXPORT_RESULT`），包含操作者、格式、筛选条件、导出条数

```bash
# admin 按状态 + 取消备注筛选导出 JSON
curl -s "http://localhost:3000/api/applications/export?format=json&status=CANCELLED&has_cancel_remark=true" \
  -H "X-User-Id: 5" | jq

# 调度员按申请人导出（李老师 id=2）
curl -s "http://localhost:3000/api/applications/export?format=json&applicant_id=2" \
  -H "X-User-Id: 3" | jq

# 普通老师默认导出（只能看到自己的）
curl -s "http://localhost:3000/api/applications/export?format=json" \
  -H "X-User-Id: 1" | jq

# 普通老师越权尝试筛别人（返回 403 PERMISSION_DENIED）
curl -s "http://localhost:3000/api/applications/export?format=json&applicant_id=2" \
  -H "X-User-Id: 1" | jq

# 导出 CSV（Excel 可直接打开，含 BOM），多条件组合
curl -s -o applications.csv "http://localhost:3000/api/applications/export?format=csv&route_name=1号线&start_date=2026-06-01&end_date=2026-06-30" \
  -H "X-User-Id: 5"
```

### 9. 用户相关

```bash
# 当前登录用户
curl -s http://localhost:3000/api/users/me -H "X-User-Id: 3" | jq

# 用户列表
curl -s http://localhost:3000/api/users -H "X-User-Id: 1" | jq
```

## 失败路径演示（复现场景）

### A. 普通老师尝试审批（权限不足）

```bash
curl -s -X POST http://localhost:3000/api/applications/1/dispatch-review \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{"approved":true}' | jq
```

返回：
```json
{
  "success": false,
  "code": "PERMISSION_DENIED",
  "message": "权限不足，需要角色: dispatcher/admin，当前角色: teacher",
  "details": { "allowedRoles": ["dispatcher","admin"], "currentRole": "teacher" }
}
```

### B. 缺少前置审批，直接发布

创建一个新申请后直接 `publish`：

```bash
# 新建（状态 PENDING_SUBMITTED），记住返回的 id
curl -s -X POST http://localhost:3000/api/applications \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 2" \
  -d '{
    "route_name":"2号线",
    "original_stops":["A","B","C"],
    "new_stops":["A","D","C"],
    "effective_start":"2026-07-01T07:00:00.000Z",
    "effective_end":"2026-07-01T09:00:00.000Z",
    "vehicle_id":"BUS-A02",
    "reason":"B站积水"
  }'

# 直接发布（id=2）
curl -s -X POST http://localhost:3000/api/applications/2/publish -H "X-User-Id: 5" | jq
```

返回 `INVALID_TRANSITION`，提示当前状态必须为 `SAFETY_APPROVED`，数据保持不变。

### C. 时间段/车辆冲突，无法发布

先发布一个正常的 1 号线 BUS-A01 改线（上面 1-6 步骤全部走完），然后创建另一个时间重叠且车辆相同的申请并走完审批，发布时返回 `PUBLISH_CONFLICT` 及冲突详情。

### D. 重复发布幂等

对已发布的申请再次执行 publish，返回同一份数据，不报错，数据库无新写入。

### E. 越权取消申请（非申请人非 admin）

李老师（id=2）试图取消张老师（id=1）的申请：

```bash
# 先用张老师提交一个申请（记住返回的 id，假设为 1）
curl -s -X POST http://localhost:3000/api/applications \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{
    "route_name":"3号线",
    "original_stops":["A","B","C"],
    "new_stops":["A","D","C"],
    "effective_start":"2026-08-01T07:00:00.000Z",
    "effective_end":"2026-08-01T09:00:00.000Z",
    "reason":"测试"
  }'

# 李老师尝试取消（id 用上面返回的值，例如 1）
curl -s -X POST http://localhost:3000/api/applications/1/cancel \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 2" \
  -d '{"comment":"恶意取消"}' | jq
```

返回 `PERMISSION_DENIED`（HTTP 403），申请状态不变，`history` 中不会出现 `CANCEL` 记录。

### F. 终态不可取消

已发布/已驳回/已取消的申请无法再取消：

```bash
# 已发布的申请（假设 id=1 已经走到 PUBLISHED），申请人本人也不能取消
curl -s -X POST http://localhost:3000/api/applications/1/cancel \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" | jq
```

返回 `INVALID_TRANSITION`（HTTP 409），`details.from` 为当前终态（`PUBLISHED` / `REJECTED` / `CANCELLED`），`details.allowed` 为空数组。

### G. 取消不存在的申请

```bash
curl -s -X POST http://localhost:3000/api/applications/99999/cancel \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" | jq
```

返回 `NOT_FOUND`（HTTP 404）。

## 数据存储

SQLite 文件位于 `data/school-bus.db`，核心表：

- `users`：用户与角色
- `applications`：改线申请（含状态、JSON 化站点、时间段、车辆等）
- `approval_logs`：审批流水，操作人、动作、前后状态、备注、时间
- `audit_logs`：全量接口审计日志
- `conflicts`：发布冲突记录

重启服务状态、历史均不丢失。
