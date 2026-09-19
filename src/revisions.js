// 试磨修订模块:新增试磨记录与更正试磨记录
// 更正在任一试磨都会使所在批次的封存立即失效(由批次模块处理),本模块只负责记录本身
import { refreshItemStatus } from "./shared.js";

let seq = 0;
function newTestId() { return "T-" + Date.now().toString(36) + "-" + (seq++); }
const TEST_FIELDS = ["paper", "water", "speed", "colorLayer", "sediment"];

export function recordTest(item, input) {
  item.tests ||= [];
  item.logs ||= [];
  const score = Number(input.score || 0);
  const test = { id: newTestId(), at: new Date().toISOString(), operator: input.operator || "未署名", score };
  for (const f of TEST_FIELDS) test[f] = input[f] || "";
  item.tests.push(test);
  refreshItemStatus(item);
  item.logs.push({ at: test.at, step: "试磨", note: (test.paper || "试纸") + ",评分" + score + "(" + test.operator + ")", score });
  return test;
}

// 更正不改动原记录:旧记录标记 superseded 留痕,新记录指回被更正的记录
export function reviseTest(item, testId, input) {
  item.tests ||= [];
  item.logs ||= [];
  const target = item.tests.find(t => t.id === testId && !t.superseded);
  if (!target) return { ok: false, status: 404, body: { error: "test_not_found" } };
  const score = input.score === undefined || input.score === "" ? Number(target.score) : Number(input.score);
  const revised = { id: newTestId(), at: new Date().toISOString(), operator: input.operator || "未署名", score, revises: target.id, reason: input.reason || "" };
  for (const f of TEST_FIELDS) revised[f] = input[f] ?? target[f] ?? "";
  target.superseded = true;
  target.supersededBy = revised.id;
  item.tests.push(revised);
  refreshItemStatus(item);
  item.logs.push({ at: revised.at, step: "试磨更正", note: "更正" + target.id + ":评分 " + target.score + " → " + score + (revised.reason ? "(" + revised.reason + ")" : ""), score });
  return { ok: true, test: revised };
}
