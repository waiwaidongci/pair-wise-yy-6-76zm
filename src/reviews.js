// 复查模块:批次封存失效后的换人复查与重新封存资格判定
// 规则:复查须换人(不得与封存人、触发失效的操作人、上一位复查人相同);
// 连续两次复测分差不超过 2 分,批次才允许重新封存。
export function reviewSatisfied(rec) {
  const r = (rec && rec.reviews) || [];
  if (r.length < 2) return false;
  const a = r[r.length - 2], b = r[r.length - 1];
  return Math.abs(Number(a.score) - Number(b.score)) <= 2;
}

export function forbiddenReviewers(rec) {
  const reviews = rec.reviews || [];
  const last = reviews[reviews.length - 1];
  return [rec.sealedBy, rec.invalidatedBy, last && last.reviewer].filter(Boolean);
}

export function addReview(db, batch, input) {
  const rec = (db.batches || {})[batch];
  if (!rec) return { ok: false, status: 404, body: { error: "batch_not_found" } };
  if (rec.status !== "待复核") return { ok: false, status: 409, body: { error: "batch_not_pending_review", message: "仅待复核批次可登记复查" } };
  const reviewer = String(input.reviewer || "").trim();
  if (!reviewer) return { ok: false, status: 400, body: { error: "reviewer_required" } };
  const score = Number(input.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return { ok: false, status: 400, body: { error: "score_invalid" } };
  rec.reviews ||= [];
  // 重复申请(同一 requestId)沿用首次结果,不重复登记
  if (input.requestId) {
    const dup = rec.reviews.find(r => r.requestId === input.requestId);
    if (dup) return { ok: true, status: 200, body: { batch, review: dup, reviewCount: rec.reviews.length, reviewPassed: reviewSatisfied(rec), deduped: true } };
  }
  const forbidden = forbiddenReviewers(rec);
  if (forbidden.includes(reviewer)) {
    return { ok: false, status: 409, body: { error: "reviewer_must_change", message: "复查须换人:不得与封存人、失效操作人或上一位复查人相同", forbidden } };
  }
  const review = { at: new Date().toISOString(), reviewer, score, note: input.note || "", requestId: input.requestId || null };
  rec.reviews.push(review);
  const passed = reviewSatisfied(rec);
  rec.history ||= [];
  rec.history.push({ at: review.at, event: "复查", detail: reviewer + " 复测 " + score + " 分" + (passed ? ",连续两次分差≤2,可重新封存" : "") });
  return { ok: true, status: 201, body: { batch, review, reviewCount: rec.reviews.length, reviewPassed: passed } };
}
