# 墨锭批次封存复查台

运行：

```bash
npm start
```

访问`http://localhost:3037`。数据保存在`data/ink-stick-testing.json`。

## 业务规则

- 每锭按「批次 + 编号」唯一，重复建档返回 409。
- 申请封存：同批至少 3 锭完成试磨且评分不低于 85；缺项返回 409 且不落库。
- 批次封存后，新增或更正试磨会让整批立即失效并转「待复核」；封存时的旧快照仍可查询，但不计入统计。
- 复查须换人（复查人不能与封存人相同）；连续两次复测分差不超过 2 才自动重新封存。
- 重复或并发的封存/复查申请凭 `requestId` 沿用首次结果。

## 模块

- `src/batches.js`：批次建档、封存资格校验、封存/失效流转、快照与幂等台账。
- `src/grinding.js`：新增试磨、更正试磨，触发整批失效。
- `src/review.js`：换人复查、复测分差判定、重新封存。

## 接口

- `GET/POST /api/items`，`PATCH /api/items/:id`，`POST /api/items/:id/logs`
- `POST /api/items/:id/action`：新增试磨记录
- `PATCH /api/items/:id/tests/:testId`：更正试磨记录
- `GET /api/batches`，`GET /api/batches/:name`（含快照与沿革）
- `POST /api/batches/:name/seal`：`{ operator, requestId }`
- `POST /api/batches/:name/review`：`{ reviewer, score, itemCode?, requestId }`
- `GET /api/stats`：在账墨锭与批次现状统计（不含快照）
