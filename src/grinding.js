// 试磨修订模块：新增试磨、更正试磨；封存批次一经改动立即整批失效转待复核
import { invalidateBatch } from "./batches.js";

let seq = 0;
function nextTestId(item) {
  seq += 1;
  return `T-${item.code || item.id}-${Date.now()}-${seq}`;
}

export function recordGrinding(db, item, input, operator) {
  const at = new Date().toISOString();
  const score = Number(input.score || 0);
  const test = {
    id: nextTestId(item),
    at,
    by: operator,
    paper: input.paper || "",
    water: input.water || "",
    speed: input.speed || "",
    colorLayer: input.colorLayer || "",
    sediment: input.sediment || "",
    score,
  };
  item.tests ||= [];
  item.tests.push(test);
  item.status = score >= 85 ? "已试磨" : "重点观察";
  item.logs ||= [];
  item.logs.push({ at, step: "试磨", note: (input.paper || "试纸") + "，评分" + score, score, by: operator });
  const invalidated = invalidateBatch(db, item.batch, `新增试磨（${item.code}，评分${score}）`, operator);
  return { test, invalidated: invalidated ? invalidated.name : null };
}

export function reviseGrinding(db, item, testId, input, operator) {
  const test = (item.tests || []).find(t => t.id === testId);
  if (!test) return null;
  const at = new Date().toISOString();
  const before = test.score;
  for (const key of ["paper", "water", "speed", "colorLayer", "sediment"]) {
    if (input[key] !== undefined) test[key] = input[key];
  }
  if (input.score !== undefined) test.score = Number(input.score);
  test.revisedAt = at;
  test.revisedBy = operator;
  const latest = item.tests[item.tests.length - 1];
  item.status = Number(latest.score) >= 85 ? "已试磨" : "重点观察";
  item.logs ||= [];
  item.logs.push({ at, step: "更正试磨", note: `评分${before}→${test.score}`, score: test.score, by: operator });
  const invalidated = invalidateBatch(db, item.batch, `更正试磨（${item.code}/${test.id}）`, operator);
  return { test, invalidated: invalidated ? invalidated.name : null };
}
