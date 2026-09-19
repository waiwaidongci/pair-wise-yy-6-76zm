# 墨锭批次封存复查台

在墨锭试磨室基础上扩展批次封存与复查流程。

运行：

```bash
npm start
```

访问`http://localhost:3037`。数据保存在`data/ink-stick-testing.json`。

## 业务模块

- `src/batches.js` 批次与封存：批次台账、封存条件校验（同批≥3锭完成试磨且评分≥85，缺项返回409且不落库）、封存快照、失效转待复核、重复/并发申请沿用首次结果。
- `src/revisions.js` 试磨修订：新增试磨与更正试磨（旧记录留痕、新记录指回被更正记录），触发整批封存失效。
- `src/reviews.js` 复查：复查须换人（不得与封存人/失效操作人/上一位复查人相同），连续两次复测分差≤2 才允许重新封存。

## 接口

- `POST /api/items` 建档，批次+编号唯一，重复返回409。
- `POST /api/items/:id/action` 新增试磨；批次已封存时整批失效转待复核。
- `POST /api/items/:id/tests/:testId/revise` 更正试磨；同样使整批失效。
- `POST /api/batches/:batch/seal` 申请封存（`operator`、`requestId`），缺项409不落库，重复/并发沿用首次结果。
- `POST /api/batches/:batch/reviews` 登记复查（`reviewer`、`score`），强制换人。
- `GET /api/batches`、`GET /api/batches/:batch` 批次汇总与详情（含历史快照，失效快照仅备查不计入统计）。
- `GET /api/stats` 墨锭状态与批次状态统计。
