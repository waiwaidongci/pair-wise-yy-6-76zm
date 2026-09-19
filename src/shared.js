// 数据访问小助手,供三个业务模块共用
// 编号仅在批次内唯一:优先按唯一 id 匹配,其次按编号;传 batch 时在该批次内查找
export function findItem(db, key, batch) {
  const pool = batch ? db.items.filter(x => batchOf(x) === batch) : db.items;
  return pool.find(x => x.id === key) || pool.find(x => x.code === key);
}
export function activeTests(item) {
  return (item.tests || []).filter(t => !t.superseded);
}
export function latestTest(item) {
  const list = activeTests(item);
  return list.length ? list[list.length - 1] : null;
}
export function refreshItemStatus(item) {
  const t = latestTest(item);
  if (t) item.status = Number(t.score) >= 85 ? "已试磨" : "重点观察";
  return item;
}
export function batchOf(item) {
  return item.batch || "DEFAULT";
}
