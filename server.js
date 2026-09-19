import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BATCH_STATUS, ensureBatch, findBatch, batchItems, sealEligibility, applySeal, publicBatch } from "./src/batches.js";
import { recordGrinding, reviseGrinding } from "./src/grinding.js";
import { submitReview } from "./src/review.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const seed = {
  "items": [
    {
      "id": "IS-001",
      "code": "IS-001",
      "batch": "2026-春-01",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "logs": [
        { "at": "2026-06-11", "step": "试磨", "note": "宣纸20滴水，出墨快，评分86", "score": 86 }
      ],
      "tests": [
        { "id": "T-IS-001-0", "at": "2026-06-11", "paper": "宣纸", "water": "20滴", "speed": "快", "colorLayer": "清透", "sediment": "少", "score": 86 }
      ]
    },
    {
      "id": "IS-002",
      "code": "IS-002",
      "batch": "2026-春-01",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "status": "重点观察",
      "logs": [
        { "at": "2026-06-21T03:50:28.907Z", "step": "试磨", "note": "棉连纸，评分79", "score": 79 }
      ],
      "tests": [
        { "id": "T-IS-002-0", "at": "2026-06-21T03:50:28.907Z", "paper": "棉连纸", "water": "18滴", "speed": "中", "colorLayer": "偏暖", "sediment": "少", "score": 79 }
      ]
    },
    {
      "id": "IS-003",
      "code": "IS-003",
      "batch": "2026-春-01",
      "smokeSource": "漆烟",
      "glueRatio": "7%",
      "ageYears": 5,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "logs": [
        { "at": "2026-06-25", "step": "试磨", "note": "皮纸，评分88", "score": 88 }
      ],
      "tests": [
        { "id": "T-IS-003-0", "at": "2026-06-25", "paper": "皮纸", "water": "20滴", "speed": "中", "colorLayer": "沉稳", "sediment": "少", "score": 88 }
      ]
    }
  ],
  "batches": []
};
const fields = [["code","墨锭编号","text"],["batch","批次","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];
const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];

function migrate(db) {
  db.items = Array.isArray(db.items) ? db.items : [];
  db.batches = Array.isArray(db.batches) ? db.batches : [];
  for (const item of db.items) {
    item.id ||= item.code || ("IS-" + Date.now());
    item.batch ||= "未分批";
    item.logs ||= [];
    item.tests ||= [];
    if (!item.tests.length) {
      for (const log of item.logs) {
        if (log && typeof log.score === "number") {
          item.tests.push({ id: `T-${item.code}-${item.tests.length}`, at: log.at, note: log.note, score: log.score, migrated: true });
        }
      }
    }
    item.tests.forEach((t, i) => { t.id ||= `T-${item.code}-${i}`; });
  }
  return db;
}
async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return migrate(JSON.parse(await readFile(dbPath, "utf8")));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
// 变更请求串行化：并发申请按到达顺序逐一处理，后者读到前者落库的幂等台账，自然沿用首次结果
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "IS-" + Date.now(); }
// 统计只取在账墨锭与批次现状，历史快照不参与统计
function computeStats(db) {
  const items = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of db.items) {
    if (items[item.status] !== undefined) items[item.status] += 1;
  }
  const batches = Object.fromEntries(Object.values(BATCH_STATUS).map(s => [s, 0]));
  for (const batch of db.batches) {
    if (batches[batch.status] !== undefined) batches[batch.status] += 1;
  }
  return { items, batches };
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭批次封存复查台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .review { border-top:1px dashed var(--line); padding-top:8px; display:grid; gap:4px; } .review button { margin-top:6px; }
    pre { white-space:pre-wrap; word-break:break-all; font-size:12px; background:#f6f8f4; border:1px solid var(--line); border-radius:6px; padding:10px; max-height:260px; overflow:auto; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭批次封存复查台</h1><div class="meta">批次建档、试磨修订、封存与换人复查</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><label>经手人</label><input name="operator"><button>保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>创建试磨记录</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><label>经手人</label><input name="operator"><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" style="margin-bottom:14px"><h2>批次封存与复查</h2><div class="grid" id="batches"></div><div id="snapshotPanel" style="display:none;margin-top:12px"></div></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><select id="batchFilter"><option value="">全部批次</option></select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>墨锭按批次与编号唯一；封存后新增或更正试磨，整批立即失效转待复核。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","墨锭编号","text"],["batch","批次","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","已试磨","重点观察"];
    const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const batchesEl = document.querySelector('#batches');
    const snapshotPanel = document.querySelector('#snapshotPanel');
    let items = [], batches = [], stats = { items:{}, batches:{} };
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.message || data.error || '请求失败'); err.data = data; throw err; }
      return data;
    }
    function reqId() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(); }
    async function run(fn) {
      try { await fn(); } catch (e) {
        const missing = e.data && e.data.missing ? '\\n缺项：' + e.data.missing.map(m => m.code + '（' + m.reason + '）').join('、') : '';
        alert(e.message + missing);
      }
      await load();
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.batch || '')+'</option>').join('');
      statsEl.innerHTML = Object.entries(stats.items).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('')
        + Object.entries(stats.batches).map(([k,v]) => '<div class="stat"><span>批次·'+k+'</span><strong>'+v+'</strong></div>').join('');
      const batchFilter = document.querySelector('#batchFilter');
      const currentBatch = batchFilter.value;
      batchFilter.innerHTML = '<option value="">全部批次</option>' + batches.map(b => '<option '+(b.name===currentBatch?'selected':'')+'>'+b.name+'</option>').join('');
      batchesEl.innerHTML = batches.map(batchHtml).join('') || '<div class="meta">暂无批次</div>';
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!currentBatch || item.batch === currentBatch) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      bind();
    }
    function batchHtml(b) {
      const review = b.status === '待复核'
        ? '<div class="review"><label>复查人（须与封存人 '+(b.sealedBy||'—')+' 不同）</label><input data-reviewer placeholder="复查人"><label>复测评分</label><input data-score type="number" placeholder="0-100"><button data-review="'+b.name+'">提交复测</button><div class="meta">复测记录：'+(b.retests.map(r => r.by+' '+r.score).join('，')||'暂无')+'</div></div>'
        : '';
      return '<article class="card"><h3>'+b.name+'</h3><span class="pill">'+b.status+'</span>'
        + '<div class="meta">合格 '+b.qualified+'/'+b.total+' 锭 · 封存人 '+(b.sealedBy||'—')+'</div>'
        + (b.invalidateReason ? '<div class="warn">失效原因：'+b.invalidateReason+'</div>' : '')
        + '<button data-seal="'+b.name+'">申请封存</button>'
        + '<button class="secondary" data-snap="'+b.name+'">快照与沿革（'+b.snapshotCount+'）</button>'
        + review + '</article>';
    }
    function cardHtml(item) {
      const main = fields.slice(1,5).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tests = (item.tests || []).map(t => '<div class="meta">'+String(t.at||'').slice(0,10)+' 评分'+t.score+(t.revisedAt?'（已更正）':'')+' <button class="secondary" data-revise="'+(item.id || item.code)+'|'+t.id+'">更正</button></div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><div>'+(tests || '<span class="meta">暂无试磨</span>')+'</div><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function bind() {
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = () => run(() => api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) })));
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = () => run(async () => { const note = prompt('记录备注'); if (note) await api('/api/items/'+btn.dataset.note+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); }));
      document.querySelectorAll('[data-revise]').forEach(btn => btn.onclick = () => run(async () => {
        const [itemId, testId] = btn.dataset.revise.split('|');
        const score = prompt('更正后评分'); if (score === null) return;
        const operator = prompt('经手人') || '未署名';
        const data = await api('/api/items/'+itemId+'/tests/'+testId, { method:'PATCH', body: JSON.stringify({ score: Number(score), operator }) });
        if (data.invalidated) alert('批次 '+data.invalidated+' 已失效，转待复核');
      }));
      document.querySelectorAll('[data-seal]').forEach(btn => btn.onclick = () => run(async () => {
        const operator = prompt('经手人'); if (!operator) return;
        const data = await api('/api/batches/'+encodeURIComponent(btn.dataset.seal)+'/seal', { method:'POST', body: JSON.stringify({ operator, requestId: reqId() }) });
        alert(data.replay ? '沿用首次结果：批次' + data.batch.status : '封存成功');
      }));
      document.querySelectorAll('[data-review]').forEach(btn => btn.onclick = () => run(async () => {
        const card = btn.closest('article');
        const reviewer = card.querySelector('[data-reviewer]').value.trim();
        const score = card.querySelector('[data-score]').value;
        const data = await api('/api/batches/'+encodeURIComponent(btn.dataset.review)+'/review', { method:'POST', body: JSON.stringify({ reviewer, score: Number(score), requestId: reqId() }) });
        alert(data.resealed ? '连续两次复测分差不超过2，批次已重新封存' : (data.replay ? '沿用首次结果' : '复测已记录，待下一次复测比对'));
      }));
      document.querySelectorAll('[data-snap]').forEach(btn => btn.onclick = () => run(async () => {
        const detail = await api('/api/batches/'+encodeURIComponent(btn.dataset.snap));
        snapshotPanel.style.display = 'block';
        snapshotPanel.innerHTML = '<h2>'+detail.name+' · 快照与沿革（快照不计入统计）</h2><pre>'+JSON.stringify({ snapshots: detail.snapshots, history: detail.history }, null, 2)+'</pre>';
      }));
    }
    async function load() {
      [items, batches, stats] = await Promise.all([api('/api/items'), api('/api/batches'), api('/api/stats')]);
      render();
    }
    createForm.onsubmit = event => { event.preventDefault(); run(() => api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }).then(() => createForm.reset())); };
    actionForm.onsubmit = event => { event.preventDefault(); run(async () => { const data = await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); if (data.invalidated) alert('批次 '+data.invalidated+' 已失效，转待复核'); actionForm.reset(); }); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#batchFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, (await loadDb()).items.map(summarize));
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(await loadDb()));
    if (req.method === "GET" && url.pathname === "/api/batches") {
      const db = await loadDb();
      return send(res, 200, (db.batches || []).map(b => {
        const eligibility = sealEligibility(db, b.name);
        return { ...publicBatch(b), total: eligibility.total, qualified: eligibility.qualified };
      }));
    }
    const batchDetail = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
    if (batchDetail && req.method === "GET") {
      const db = await loadDb();
      const name = decodeURIComponent(batchDetail[1]);
      const batch = findBatch(db, name);
      if (!batch) return send(res, 404, { error: "batch_not_found" });
      return send(res, 200, { ...publicBatch(batch), snapshots: batch.snapshots, items: batchItems(db, name).map(summarize) });
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      return mutate(async () => {
        const db = await loadDb();
        const input = await body(req);
        if (!input.code) return send(res, 400, { error: "code_required", message: "墨锭编号必填" });
        const batch = input.batch || "未分批";
        const dup = db.items.find(x => x.batch === batch && x.code === input.code);
        if (dup) return send(res, 409, { error: "duplicate_item", message: `批次${batch}内编号${input.code}已存在` });
        const { operator, ...rest } = input;
        const item = { id: newId(), ...rest, batch, tests: [], logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭", by: operator || "未署名" }] };
        db.items.unshift(item);
        ensureBatch(db, batch);
        await saveDb(db);
        return send(res, 201, item);
      });
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      return mutate(async () => {
        const db = await loadDb();
        const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        Object.assign(item, await body(req));
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
        await saveDb(db);
        return send(res, 200, item);
      });
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      return mutate(async () => {
        const db = await loadDb();
        const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        await saveDb(db);
        return send(res, 201, item);
      });
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      return mutate(async () => {
        const db = await loadDb();
        const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        const result = recordGrinding(db, item, input, input.operator || "未署名");
        await saveDb(db);
        return send(res, 201, { item, ...result });
      });
    }
    const revise = url.pathname.match(/^\/api\/items\/([^/]+)\/tests\/([^/]+)$/);
    if (revise && req.method === "PATCH") {
      return mutate(async () => {
        const db = await loadDb();
        const item = db.items.find(x => x.id === revise[1] || x.code === revise[1]);
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        const result = reviseGrinding(db, item, revise[2], input, input.operator || "未署名");
        if (!result) return send(res, 404, { error: "test_not_found", message: "未找到该试磨记录" });
        await saveDb(db);
        return send(res, 200, { item, ...result });
      });
    }
    const seal = url.pathname.match(/^\/api\/batches\/([^/]+)\/seal$/);
    if (seal && req.method === "POST") {
      return mutate(async () => {
        const db = await loadDb();
        const input = await body(req);
        if (!input.operator) return send(res, 400, { error: "operator_required", message: "请填写经手人" });
        const result = applySeal(db, decodeURIComponent(seal[1]), input);
        if (result.changed) await saveDb(db);
        return send(res, result.http, result.body);
      });
    }
    const review = url.pathname.match(/^\/api\/batches\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      return mutate(async () => {
        const db = await loadDb();
        const result = submitReview(db, decodeURIComponent(review[1]), await body(req));
        if (result.changed) await saveDb(db);
        return send(res, result.http, result.body);
      });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("墨锭批次封存复查台 listening on http://localhost:" + port));
