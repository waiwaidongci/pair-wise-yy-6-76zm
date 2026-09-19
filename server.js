import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findItem, latestTest, batchOf } from "./src/shared.js";
import { recordTest, reviseTest } from "./src/revisions.js";
import { addReview } from "./src/reviews.js";
import { BATCH_STAGES, batchDetail, batchSummaries, invalidateBatch, sealBatch } from "./src/batches.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const seed = {
  "items": [
    {
      "id": "SID-001",
      "code": "IS-001",
      "batch": "B-2026-06",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "tests": [
        { "id": "T-1", "at": "2026-06-11", "paper": "宣纸", "water": "20滴", "speed": "快", "colorLayer": "清透", "sediment": "少", "score": 86, "operator": "程师傅" }
      ],
      "logs": [
        { "at": "2026-06-11", "step": "试磨", "note": "宣纸20滴水,出墨快,评分86", "score": 86 }
      ]
    },
    {
      "id": "SID-002",
      "code": "IS-002",
      "batch": "B-2026-06",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "status": "重点观察",
      "tests": [
        { "id": "T-2", "at": "2026-06-21T03:50:28.907Z", "paper": "棉连纸", "water": "18滴", "speed": "中", "colorLayer": "偏暖", "sediment": "少", "score": 79, "operator": "程师傅" }
      ],
      "logs": [
        { "at": "2026-06-21T03:50:28.907Z", "step": "试磨", "note": "棉连纸,评分79", "score": 79 }
      ]
    },
    {
      "id": "SID-003",
      "code": "IS-003",
      "batch": "B-2026-06",
      "smokeSource": "歙县油烟",
      "glueRatio": "8.5%",
      "ageYears": 5,
      "storage": "恒湿柜A",
      "status": "已试磨",
      "tests": [
        { "id": "T-3", "at": "2026-06-15", "paper": "宣纸", "water": "22滴", "speed": "中", "colorLayer": "层次稳", "sediment": "极少", "score": 88, "operator": "林师傅" }
      ],
      "logs": [
        { "at": "2026-06-15", "step": "试磨", "note": "宣纸22滴水,层次稳,评分88", "score": 88 }
      ]
    },
    {
      "id": "SID-004",
      "code": "IS-004",
      "batch": "B-2026-06",
      "smokeSource": "黄山松烟",
      "glueRatio": "7%",
      "ageYears": 10,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "tests": [
        { "id": "T-4", "at": "2026-06-18", "paper": "皮纸", "water": "20滴", "speed": "快", "colorLayer": "厚重", "sediment": "少", "score": 90, "operator": "林师傅" }
      ],
      "logs": [
        { "at": "2026-06-18", "step": "试磨", "note": "皮纸,评分90", "score": 90 }
      ]
    }
  ],
  "batches": {},
  "sealRequests": {}
};
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];

function migrate(db) {
  db.items ||= [];
  db.batches ||= {};
  db.sealRequests ||= {};
  db.items.forEach((item, i) => {
    item.id = item.id || "IS-M-" + (i + 1);
    item.batch = item.batch || "DEFAULT";
    item.tests = item.tests || [];
    item.tests.forEach((t, j) => { if (!t.id) t.id = "T-" + (i + 1) + "-" + (j + 1); });
  });
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

// 串行化所有写操作,避免并发请求互相覆盖;同一申请的并发/重复提交共享首次执行结果
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}
const inflight = new Map();
function dedupe(key, fn) {
  const running = inflight.get(key);
  if (running) return running.then(out => ({ ...out, body: { ...out.body, deduped: true } }));
  const run = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, run);
  return run;
}

function computeStats(db) {
  const items = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of db.items) {
    if (items[item.status] !== undefined) items[item.status] += 1;
  }
  const batches = Object.fromEntries(BATCH_STAGES.map(label => [label, 0]));
  for (const b of batchSummaries(db)) batches[b.status] += 1;
  return { items, batches, note: "失效快照仅留存备查,不计入统计" };
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  const t = latestTest(item);
  return { ...item, logCount, latestScore: t ? t.score : null };
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
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    details summary { cursor:pointer; color:var(--accent); font-weight:700; } details div { padding-top:6px; display:grid; gap:4px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭批次封存复查台</h1><div class="meta">墨锭建档、试磨记录、批次封存与换人复查</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>创建试磨记录</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>选择墨锭后录入试磨记录,系统会保留多次试磨结果并更新评分状态。</h2><div class="grid" id="cards"></div></div>
      <div class="panel" style="margin-top:14px"><h2>批次封存复查台</h2>
        <div class="meta" style="margin-bottom:10px">同批至少 3 锭完成试磨且评分≥85 方可申请封存,缺项申请返回 409 且不落库;封存后新增或更正试磨,整批立即失效转待复核,旧快照仅备查不计入统计;复查须换人,连续两次复测分差≤2 才可重新封存;重复或并发申请沿用首次结果。</div>
        <label>封存操作人</label><input id="sealOperator" placeholder="申请封存时署名">
        <div class="grid" id="batchCards" style="margin-top:10px"></div>
      </div>
    </section>
  </main>
  <script>
    const fields = [["batch","批次","text"],["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","已试磨","重点观察"];
    const batchStages = ["未封存","已封存","待复核"];
    const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"],["operator","操作人"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const batchCards = document.querySelector('#batchCards');
    let items = [], batches = [];
    let sealRequestId = newReqId();
    const reviewReqIds = {};
    function newReqId() { return 'REQ-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) {
        const err = new Error((data.error || '请求失败') + (data.missing ? '：' + data.missing.join('；') : '') + (data.message ? '：' + data.message : ''));
        err.data = data;
        throw err;
      }
      return data;
    }
    function guard(fn) { return async event => { try { await fn(event); } catch (e) { alert(e.message); } }; }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+(key==='batch'?' placeholder="留空归入 DEFAULT"':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.batch || 'DEFAULT')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      const bstats = Object.fromEntries(batchStages.map(s => [s, batches.filter(b => b.status === s).length]));
      statsEl.innerHTML = Object.entries({ ...stats, ...bstats }).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      batchCards.innerHTML = batches.map(b => batchHtml(b)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = guard(async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); }));
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = guard(async () => { const note = prompt('记录备注'); if (note) { await api('/api/items/'+btn.dataset.note+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } }));
      document.querySelectorAll('[data-revise]').forEach(btn => btn.onclick = guard(async () => {
        const item = items.find(i => (i.id || i.code) === btn.dataset.revise);
        const t = ((item && item.tests) || []).filter(x => !x.superseded).pop();
        if (!t) return alert('该锭暂无试磨记录可更正');
        const score = prompt('更正后评分(当前 '+t.score+' 分)', t.score);
        if (score === null) return;
        const operator = prompt('操作人', '') || '未署名';
        const reason = prompt('更正原因', '') || '';
        const out = await api('/api/items/'+btn.dataset.revise+'/tests/'+t.id+'/revise', { method:'POST', body: JSON.stringify({ score: Number(score), operator, reason }) });
        if (out.batchEvent) alert('批次 '+out.batchEvent.batch+' 封存已失效,整批转待复核');
        await load();
      }));
      document.querySelectorAll('[data-seal]').forEach(btn => btn.onclick = guard(async () => {
        const operator = document.querySelector('#sealOperator').value.trim();
        if (!operator) return alert('请先填写封存操作人');
        const out = await api('/api/batches/'+encodeURIComponent(btn.dataset.seal)+'/seal', { method:'POST', body: JSON.stringify({ operator, requestId: sealRequestId }) });
        sealRequestId = newReqId();
        alert((out.deduped ? '沿用首次结果:' : '封存成功:') + '批次 ' + out.batch + ' 第 ' + out.epoch + ' 轮封存');
        await load();
      }));
      document.querySelectorAll('[data-review]').forEach(btn => btn.onclick = guard(async () => {
        const b = btn.dataset.review;
        const reviewer = document.querySelector('[data-reviewer="'+b+'"]').value.trim();
        const score = document.querySelector('[data-rscore="'+b+'"]').value;
        reviewReqIds[b] = reviewReqIds[b] || newReqId();
        const out = await api('/api/batches/'+encodeURIComponent(b)+'/reviews', { method:'POST', body: JSON.stringify({ reviewer, score: Number(score), requestId: reviewReqIds[b] }) });
        delete reviewReqIds[b];
        alert('复查已记录,' + (out.reviewPassed ? '连续两次复测分差≤2,可重新封存' : '还需继续复查'));
        await load();
      }));
      document.querySelectorAll('[data-detail]').forEach(d => d.ontoggle = guard(async () => {
        if (!d.open || d.dataset.loaded) return;
        const detail = await api('/api/batches/'+encodeURIComponent(d.dataset.detail));
        d.dataset.loaded = '1';
        d.querySelector('div').innerHTML = detailHtml(detail);
      }));
    }
    function cardHtml(item) {
      const main = [['批次', item.batch || 'DEFAULT'], ['烟料来源', item.smokeSource], ['胶料比例', item.glueRatio], ['存放年限', item.ageYears], ['最新评分', item.latestScore == null ? '未试磨' : item.latestScore]].map(([k,v]) => '<div><b>'+k+'</b> '+(v ?? '')+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><button class="secondary" data-revise="'+(item.id || item.code)+'">更正最近试磨</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function batchHtml(b) {
      let out = '<article class="card"><h3>批次 '+b.batch+'</h3><span class="pill">'+b.status+'</span><div class="meta">锭数 '+b.stickCount+' · 合格(≥85) '+b.qualifiedCount+' · 已封存 '+b.sealEpoch+' 轮</div>';
      if (b.sealedBy) out += '<div class="meta">封存人 '+b.sealedBy+' · '+String(b.sealedAt || '').slice(0, 10)+'</div>';
      out += '<button data-seal="'+b.batch+'">申请封存</button>';
      if (b.status === '待复核') {
        out += '<div class="warn">封存已失效,须换人复查:连续两次复测分差≤2 才可重新封存(当前 '+b.reviewCount+' 次'+(b.reviewPassed ? ',已满足重新封存条件' : '')+')</div>'
          + '<label>复查人(须换人)</label><input data-reviewer="'+b.batch+'">'
          + '<label>复测评分</label><input data-rscore="'+b.batch+'" type="number" min="0" max="100">'
          + '<button class="secondary" data-review="'+b.batch+'">提交复查</button>';
      }
      out += '<details data-detail="'+b.batch+'"><summary>快照与复查记录</summary><div class="meta">展开后加载…</div></details></article>';
      return out;
    }
    function detailHtml(d) {
      const snaps = (d.snapshots || []).map(s => '<div>第 '+s.epoch+' 轮 · '+s.by+' · '+String(s.at).slice(0, 10)+' · 锭数 '+s.stickCount+' · 合格 '+s.qualifiedCount+' · 均分 '+(s.avgScore == null ? '-' : s.avgScore)+' · '+(s.valid ? '有效' : '<span class="warn">已失效(仅备查,不计入统计)</span>')+'</div>').join('') || '暂无快照';
      const reviews = (d.reviews || []).map(r => '<div>'+r.reviewer+' 复测 '+r.score+' 分 · '+String(r.at).slice(0, 10)+(r.note ? ' · '+r.note : '')+'</div>').join('') || '暂无复查记录';
      const sticks = (d.sticks || []).map(s => '<div>'+s.code+' · '+s.status+' · 最新评分 '+(s.latestScore == null ? '未试磨' : s.latestScore)+'</div>').join('');
      return '<div class="meta"><b>封存快照</b>'+snaps+'<b>本轮复查</b>'+reviews+'<b>批次墨锭</b>'+sticks+'</div>';
    }
    async function load() {
      [items, batches] = await Promise.all([api('/api/items'), api('/api/batches')]);
      render();
    }
    createForm.onsubmit = guard(async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); });
    actionForm.onsubmit = guard(async event => {
      event.preventDefault();
      const out = await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) });
      if (out.batchEvent) alert('批次 '+out.batchEvent.batch+' 封存已失效,整批转待复核');
      actionForm.reset();
      await load();
    });
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    if (req.method === "GET" && path === "/") return html(res, page());
    if (req.method === "GET" && path === "/api/items") { const db = await loadDb(); return send(res, 200, db.items.map(summarize)); }
    if (req.method === "GET" && path === "/api/stats") { const db = await loadDb(); return send(res, 200, computeStats(db)); }
    if (req.method === "GET" && path === "/api/batches") { const db = await loadDb(); return send(res, 200, batchSummaries(db)); }
    const batchGet = path.match(/^\/api\/batches\/([^/]+)$/);
    if (req.method === "GET" && batchGet) {
      const db = await loadDb();
      const detail = batchDetail(db, decodeURIComponent(batchGet[1]));
      return detail ? send(res, 200, detail) : send(res, 404, { error: "batch_not_found" });
    }
    if (req.method === "POST" && path === "/api/items") {
      return await withLock(async () => {
        const db = await loadDb();
        const input = await body(req);
        const code = String(input.code || "").trim();
        const batch = String(input.batch || "").trim() || "DEFAULT";
        if (!code) return send(res, 400, { error: "code_required" });
        // 每锭按批次与编号唯一
        if (db.items.some(x => batchOf(x) === batch && x.code === code)) {
          return send(res, 409, { error: "duplicate_item", message: "同批次内编号必须唯一: " + batch + " / " + code });
        }
        const item = { id: newId(), ...input, code, batch, tests: [], logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭(批次 " + batch + ")" }] };
        db.items.unshift(item);
        await saveDb(db);
        return send(res, 201, item);
      });
    }
    const patch = path.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, patch[1], url.searchParams.get("batch"));
        if (!item) return send(res, 404, { error: "item_not_found" });
        Object.assign(item, await body(req));
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
        await saveDb(db);
        return send(res, 200, item);
      });
    }
    const log = path.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, log[1], url.searchParams.get("batch"));
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        await saveDb(db);
        return send(res, 201, item);
      });
    }
    const action = path.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, action[1], url.searchParams.get("batch"));
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        recordTest(item, input);
        // 封存后新增试磨:整批立即失效转待复核
        const rec = invalidateBatch(db, batchOf(item), "新增试磨: " + (item.code || item.id), input.operator);
        await saveDb(db);
        return send(res, 201, { ...item, batchEvent: rec ? { batch: rec.batch, status: rec.status, reason: rec.invalidateReason } : null });
      });
    }
    const revise = path.match(/^\/api\/items\/([^/]+)\/tests\/([^/]+)\/revise$/);
    if (revise && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const item = findItem(db, revise[1], url.searchParams.get("batch"));
        if (!item) return send(res, 404, { error: "item_not_found" });
        const input = await body(req);
        const out = reviseTest(item, revise[2], input);
        if (!out.ok) return send(res, out.status, out.body);
        // 封存后更正试磨:整批立即失效转待复核
        const rec = invalidateBatch(db, batchOf(item), "更正试磨: " + (item.code || item.id), input.operator);
        await saveDb(db);
        return send(res, 201, { ...item, batchEvent: rec ? { batch: rec.batch, status: rec.status, reason: rec.invalidateReason } : null });
      });
    }
    const seal = path.match(/^\/api\/batches\/([^/]+)\/seal$/);
    if (seal && req.method === "POST") {
      const batch = decodeURIComponent(seal[1]);
      const input = await body(req);
      if (!String(input.operator || "").trim()) return send(res, 400, { error: "operator_required" });
      const key = "seal:" + batch + ":" + (input.requestId || "auto");
      const out = await dedupe(key, () => withLock(async () => {
        const db = await loadDb();
        const result = sealBatch(db, batch, input);
        if (result.ok) await saveDb(db); // 缺项申请返回 409 且不落库
        return result;
      }));
      return send(res, out.status, out.body);
    }
    const review = path.match(/^\/api\/batches\/([^/]+)\/reviews$/);
    if (review && req.method === "POST") {
      const batch = decodeURIComponent(review[1]);
      const input = await body(req);
      const key = "review:" + batch + ":" + (input.requestId || "auto:" + (input.reviewer || "") + ":" + input.score);
      const out = await dedupe(key, () => withLock(async () => {
        const db = await loadDb();
        const result = addReview(db, batch, input);
        if (result.ok) await saveDb(db);
        return result;
      }));
      return send(res, out.status, out.body);
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("墨锭批次封存复查台 listening on http://localhost:" + port));
