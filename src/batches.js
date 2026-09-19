// 批次模块：批次建档、封存资格校验、封存/失效状态流转、快照与幂等台账
export const BATCH_STATUS = { OPEN: "开放", SEALED: "已封存", REVIEW: "待复核" };
export const SEAL_MIN_ITEMS = 3;
export const SEAL_MIN_SCORE = 85;

export function ensureBatch(db, name) {
  db.batches ||= [];
  let batch = db.batches.find(b => b.name === name);
  if (!batch) {
    batch = {
      name,
      status: BATCH_STATUS.OPEN,
      sealedBy: null,
      sealedAt: null,
      invalidatedAt: null,
      invalidateReason: null,
      snapshots: [],
      review: { retests: [] },
      requests: {},
      history: [{ at: new Date().toISOString(), event: "建批", by: "system", note: "批次建立" }],
    };
    db.batches.push(batch);
  }
  return batch;
}

export function findBatch(db, name) {
  return (db.batches || []).find(b => b.name === name) || null;
}

export function batchItems(db, name) {
  return (db.items || []).filter(item => item.batch === name);
}

export function latestTest(item) {
  const tests = item.tests || [];
  return tests.length ? tests[tests.length - 1] : null;
}

function qualifying(item) {
  const test = latestTest(item);
  return Boolean(test && Number(test.score) >= SEAL_MIN_SCORE);
}

export function sealEligibility(db, name) {
  const items = batchItems(db, name);
  const qualified = items.filter(qualifying).length;
  const missing = items.filter(item => !qualifying(item)).map(item => {
    const test = latestTest(item);
    return { code: item.code, reason: test ? `评分${test.score}低于${SEAL_MIN_SCORE}` : "未完成试磨" };
  });
  return { ok: qualified >= SEAL_MIN_ITEMS, total: items.length, qualified, missing };
}

export function takeSnapshot(db, name) {
  return {
    at: new Date().toISOString(),
    items: batchItems(db, name).map(item => ({
      code: item.code,
      status: item.status,
      latestScore: latestTest(item)?.score ?? null,
      tests: (item.tests || []).map(t => ({ ...t })),
    })),
  };
}

export function publicBatch(batch) {
  return {
    name: batch.name,
    status: batch.status,
    sealedBy: batch.sealedBy,
    sealedAt: batch.sealedAt,
    invalidatedAt: batch.invalidatedAt,
    invalidateReason: batch.invalidateReason,
    retests: (batch.review?.retests || []).map(r => ({ ...r })),
    snapshotCount: (batch.snapshots || []).length,
    history: (batch.history || []).map(h => ({ ...h })),
  };
}

// 申请封存：缺项返回409且不落库（changed=false 时调用方不得保存）；
// 重复或并发申请凭 requestId 沿用首次结果，已封存批次再次申请同样沿用首次结果。
export function applySeal(db, name, { operator, requestId } = {}) {
  const batch = ensureBatch(db, name);
  const key = requestId ? `seal:${requestId}` : null;
  if (key && batch.requests[key]) {
    return { http: 200, body: { ...batch.requests[key].body, replay: true }, changed: false };
  }
  if (batch.status === BATCH_STATUS.SEALED) {
    return { http: 200, body: { ok: true, replay: true, message: "批次已封存，沿用首次封存结果", batch: publicBatch(batch) }, changed: false };
  }
  if (batch.status === BATCH_STATUS.REVIEW) {
    return { http: 409, body: { error: "batch_pending_review", message: "批次已失效待复核，须复查通过后方可重新封存", batch: publicBatch(batch) }, changed: false };
  }
  const eligibility = sealEligibility(db, name);
  if (!eligibility.ok) {
    return { http: 409, body: { error: "seal_requirements_unmet", message: `同批至少${SEAL_MIN_ITEMS}锭完成试磨且评分不低于${SEAL_MIN_SCORE}`, ...eligibility }, changed: false };
  }
  const at = new Date().toISOString();
  batch.status = BATCH_STATUS.SEALED;
  batch.sealedBy = operator;
  batch.sealedAt = at;
  batch.invalidatedAt = null;
  batch.invalidateReason = null;
  batch.review = { retests: [] };
  batch.snapshots.push(takeSnapshot(db, name));
  batch.history.push({ at, event: "封存", by: operator, note: `合格${eligibility.qualified}/${eligibility.total}锭` });
  const body = { ok: true, batch: publicBatch(batch) };
  if (key) batch.requests[key] = { http: 201, body };
  return { http: 201, body, changed: true };
}

// 整批失效：封存后新增或更正试磨时由试磨修订模块调用，立即转待复核，旧快照保留可查
export function invalidateBatch(db, name, reason, operator) {
  if (!name) return null;
  const batch = findBatch(db, name);
  if (!batch || batch.status !== BATCH_STATUS.SEALED) return null;
  const at = new Date().toISOString();
  batch.status = BATCH_STATUS.REVIEW;
  batch.invalidatedAt = at;
  batch.invalidateReason = reason;
  batch.review = { retests: [] };
  batch.history.push({ at, event: "失效转待复核", by: operator || "system", note: reason });
  return batch;
}
