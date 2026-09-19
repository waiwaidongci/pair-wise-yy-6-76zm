// 复查模块：待复核批次换人复测，连续两次复测分差不超过2方可重新封存；重复/并发申请沿用首次结果
import { BATCH_STATUS, ensureBatch, publicBatch, takeSnapshot } from "./batches.js";

export const RESEAL_MAX_DIFF = 2;

export function submitReview(db, name, { reviewer, itemCode, score, requestId } = {}) {
  const batch = ensureBatch(db, name);
  const key = requestId ? `review:${requestId}` : null;
  if (key && batch.requests[key]) {
    return { http: 200, body: { ...batch.requests[key].body, replay: true }, changed: false };
  }
  if (batch.status !== BATCH_STATUS.REVIEW) {
    return { http: 409, body: { error: "batch_not_pending_review", message: "批次不在待复核状态" }, changed: false };
  }
  if (!reviewer) {
    return { http: 400, body: { error: "reviewer_required", message: "请填写复查人" }, changed: false };
  }
  if (reviewer === batch.sealedBy) {
    return { http: 409, body: { error: "reviewer_must_differ", message: "复查须换人，复查人不能与封存人相同" }, changed: false };
  }
  const value = Number(score);
  if (!Number.isFinite(value)) {
    return { http: 400, body: { error: "score_invalid", message: "复测评分须为数字" }, changed: false };
  }
  if (itemCode) {
    const item = (db.items || []).find(x => x.batch === name && (x.code === itemCode || x.id === itemCode));
    if (!item) {
      return { http: 404, body: { error: "item_not_found", message: "该批次下未找到此墨锭" }, changed: false };
    }
  }
  const at = new Date().toISOString();
  const retest = { at, by: reviewer, itemCode: itemCode || null, score: value };
  batch.review.retests.push(retest);
  batch.history.push({ at, event: "复测", by: reviewer, note: (itemCode ? itemCode + " " : "") + "评分" + value });
  let resealed = false;
  const retests = batch.review.retests;
  const n = retests.length;
  if (n >= 2 && Math.abs(retests[n - 1].score - retests[n - 2].score) <= RESEAL_MAX_DIFF) {
    resealed = true;
    batch.status = BATCH_STATUS.SEALED;
    batch.sealedBy = reviewer;
    batch.sealedAt = at;
    batch.invalidatedAt = null;
    batch.invalidateReason = null;
    batch.snapshots.push(takeSnapshot(db, name));
    batch.history.push({ at, event: "重新封存", by: reviewer, note: `连续两次复测分差≤${RESEAL_MAX_DIFF}` });
    batch.review = { retests: [] };
  }
  const body = { ok: true, resealed, retests, batch: publicBatch(batch) };
  if (key) batch.requests[key] = { http: 201, body };
  return { http: 201, body, changed: true };
}
