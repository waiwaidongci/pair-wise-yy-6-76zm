// 批次模块:批次台账、封存申请、封存失效与快照
// 规则:同批至少 3 锭完成试磨且评分≥85 才可封存;缺项申请返回 409 且不落库;
// 封存后新增或更正试磨,整批立即失效转待复核,旧快照保留备查但不计入统计;
// 重复或并发申请(同一 requestId / 同一申请周期)沿用首次结果。
import { batchOf, latestTest } from "./shared.js";
import { reviewSatisfied } from "./reviews.js";

export const BATCH_STAGES = ["未封存", "已封存", "待复核"];

export function ensureBatch(db, batch) {
  db.batches ||= {};
  if (!db.batches[batch]) {
    db.batches[batch] = { batch, status: "未封存", sealEpoch: 0, cycle: 0, sealedAt: null, sealedBy: null, invalidatedAt: null, invalidatedBy: null, invalidateReason: null, snapshots: [], reviews: [], pastReviews: [], history: [] };
  }
  return db.batches[batch];
}

export function sticksOf(db, batch) {
  return (db.items || []).filter(i => batchOf(i) === batch);
}

export function qualifiedSticks(db, batch) {
  return sticksOf(db, batch).filter(i => {
    const t = latestTest(i);
    return t && Number(t.score) >= 85;
  });
}

export function sealMissing(db, batch) {
  const missing = [];
  const sticks = sticksOf(db, batch);
  if (!sticks.length) missing.push("批次 " + batch + " 内没有墨锭");
  const untested = sticks.filter(i => !latestTest(i)).map(i => i.code || i.id);
  if (untested.length) missing.push("缺少试磨记录: " + untested.join("、"));
  const q = qualifiedSticks(db, batch).length;
  if (q < 3) missing.push("合格锭数不足: 需至少 3 锭完成试磨且评分≥85,当前 " + q + " 锭");
  return missing;
}

function buildSnapshot(db, batch, operator, epoch) {
  const sticks = sticksOf(db, batch).map(i => ({ code: i.code || i.id, status: i.status, score: (latestTest(i) || {}).score ?? null }));
  const scores = sticks.map(s => s.score).filter(s => typeof s === "number");
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null;
  return { epoch, at: new Date().toISOString(), by: operator, valid: true, stickCount: sticks.length, qualifiedCount: scores.filter(s => s >= 85).length, avgScore: avg, sticks };
}

// 申请封存。返回 { ok, status, body };ok 为 false 时调用方不得落库。
export function sealBatch(db, batch, input) {
  const operator = String(input.operator || "").trim();
  const rec = (db.batches || {})[batch];
  // 批次已封存:任何重复申请都沿用首次结果
  if (rec && rec.status === "已封存") {
    return { ok: true, status: 200, body: { batch, status: "已封存", epoch: rec.sealEpoch, snapshot: rec.snapshots[rec.snapshots.length - 1] || null, deduped: true, message: "批次已封存,沿用首次结果" } };
  }
  // 幂等键:客户端 requestId 优先;缺省时按申请周期(封存/失效会推进 cycle)去重
  const key = "seal:" + batch + ":" + (input.requestId || "auto-" + (rec ? rec.cycle || 0 : 0));
  db.sealRequests ||= {};
  const prev = db.sealRequests[key];
  if (prev) return { ok: true, status: 200, body: { ...prev.result, deduped: true, message: "重复申请,沿用首次结果" } };
  // 缺项校验:失败不落库
  const missing = sealMissing(db, batch);
  if (missing.length) return { ok: false, status: 409, body: { error: "seal_requirements_unmet", missing } };
  // 待复核批次须先完成换人复查
  if (rec && rec.status === "待复核" && !reviewSatisfied(rec)) {
    return { ok: false, status: 409, body: { error: "review_required", missing: ["复查未通过: 须换人连续两次复测且分差≤2"] } };
  }
  const record = ensureBatch(db, batch);
  record.sealEpoch += 1;
  record.cycle = (record.cycle || 0) + 1;
  record.status = "已封存";
  record.sealedAt = new Date().toISOString();
  record.sealedBy = operator;
  record.invalidatedAt = null;
  record.invalidatedBy = null;
  record.invalidateReason = null;
  const snapshot = buildSnapshot(db, batch, operator, record.sealEpoch);
  record.snapshots.push(snapshot);
  record.history.push({ at: record.sealedAt, event: "封存", detail: "第 " + record.sealEpoch + " 轮封存,操作人 " + operator });
  const result = { batch, status: "已封存", epoch: record.sealEpoch, snapshot };
  db.sealRequests[key] = { key, at: record.sealedAt, operator, result };
  return { ok: true, status: 201, body: result };
}

// 封存后新增/更正试磨时调用:整批立即失效转待复核,旧快照标记失效但保留可查
export function invalidateBatch(db, batch, reason, actor) {
  const rec = (db.batches || {})[batch];
  if (!rec || rec.status !== "已封存") return null;
  const at = new Date().toISOString();
  rec.status = "待复核";
  rec.cycle = (rec.cycle || 0) + 1;
  rec.invalidatedAt = at;
  rec.invalidatedBy = actor || "未知";
  rec.invalidateReason = reason;
  const snap = rec.snapshots[rec.snapshots.length - 1];
  if (snap) {
    snap.valid = false;
    snap.invalidatedAt = at;
    snap.invalidateReason = reason;
  }
  if (rec.reviews && rec.reviews.length) {
    rec.pastReviews ||= [];
    rec.pastReviews.push({ epoch: rec.sealEpoch, reviews: rec.reviews });
  }
  rec.reviews = [];
  rec.history.push({ at, event: "封存失效", detail: reason + ",整批转待复核(旧快照仅备查,不计入统计)" });
  return rec;
}

export function batchSummaries(db) {
  const names = new Set(Object.keys(db.batches || {}));
  for (const item of db.items || []) names.add(batchOf(item));
  return [...names].sort().map(name => {
    const rec = (db.batches || {})[name];
    const sticks = (db.items || []).filter(i => batchOf(i) === name);
    return {
      batch: name,
      status: rec ? rec.status : "未封存",
      sealEpoch: rec ? rec.sealEpoch : 0,
      sealedBy: rec ? rec.sealedBy : null,
      sealedAt: rec ? rec.sealedAt : null,
      stickCount: sticks.length,
      qualifiedCount: sticks.filter(i => { const t = latestTest(i); return t && Number(t.score) >= 85; }).length,
      reviewCount: rec && rec.reviews ? rec.reviews.length : 0,
      reviewPassed: rec ? reviewSatisfied(rec) : false
    };
  });
}

export function batchDetail(db, batch) {
  const rec = (db.batches || {})[batch];
  const sticks = sticksOf(db, batch);
  if (!rec && !sticks.length) return null;
  const summary = batchSummaries(db).find(b => b.batch === batch);
  return {
    ...summary,
    invalidatedAt: rec ? rec.invalidatedAt : null,
    invalidatedBy: rec ? rec.invalidatedBy : null,
    invalidateReason: rec ? rec.invalidateReason : null,
    snapshots: rec ? rec.snapshots : [],
    reviews: rec ? rec.reviews : [],
    pastReviews: rec ? rec.pastReviews : [],
    history: rec ? rec.history : [],
    sticks: sticks.map(i => ({ code: i.code || i.id, status: i.status, latestScore: (latestTest(i) || {}).score ?? null }))
  };
}
