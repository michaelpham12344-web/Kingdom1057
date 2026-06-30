/**
 * Kingdom 1057 Worker
 * Serves the planner website AND provides the shared sync API, all from
 * a single Cloudflare Worker (no separate Pages project needed).
 *
 * Routes:
 *   GET  /             -> serves the website (index.html content)
 *   GET  /state        -> returns the saved shared JSON blob (or {} if none saved yet)
 *   PUT  /state        -> body is JSON, saves it as the new shared state
 *
 * Bind a KV namespace called SVS_KV to this Worker (see wrangler.toml).
 */

const ALLOWED_ORIGIN = "*";
const STATE_KEY = "svs_state";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const SITE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kingdom 1057 — Whiteout Survival</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&family=Barlow:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#0a0d14;--bg2:#111520;--bg3:#161c2a;--bg4:#1c2436;
  --border:rgba(100,140,220,0.15);--border2:rgba(100,140,220,0.28);
  --accent:#3d8ef0;--accent2:#5ba3ff;
  --garrison:#2a7fff;--attack:#2ecc71;
  --enemy:#e03a3a;--gold:#f0a500;--green:#2ecc71;
  --text:#d0daf0;--text2:#7a8aaa;--text3:#4a5570;
  --mono:'Share Tech Mono',monospace;--head:'Rajdhani',sans-serif;--body:'Barlow',sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:var(--body);font-size:14px;min-height:100vh;}
.nav{display:flex;align-items:center;gap:0;border-bottom:1px solid var(--border);background:var(--bg2);padding:0 24px;position:sticky;top:0;z-index:100;}
.nav-logo{font-family:var(--head);font-size:20px;font-weight:700;color:var(--accent2);letter-spacing:.08em;margin-right:32px;padding:14px 0;white-space:nowrap;}
.nav-logo span{color:var(--gold);}
.tab{font-family:var(--head);font-size:15px;font-weight:600;letter-spacing:.06em;padding:16px 20px;cursor:pointer;color:var(--text2);border-bottom:2px solid transparent;transition:all .2s;white-space:nowrap;}
.tab:hover{color:var(--text);}
.tab.active{color:var(--accent2);border-bottom-color:var(--accent2);}
.utc-clock{margin-left:auto;font-family:var(--mono);font-size:16px;color:var(--gold);letter-spacing:.08em;}
.page{display:none;padding:28px;max-width:1300px;margin:0 auto;}
.page.active{display:block;}
.sec-title{font-family:var(--head);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--text3);margin-bottom:10px;border-left:3px solid var(--accent);padding-left:10px;}
.card{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:18px 20px;margin-bottom:18px;}
.card-title{font-family:var(--head);font-size:16px;font-weight:600;color:var(--accent2);margin-bottom:14px;letter-spacing:.04em;}
input[type=text],input[type=number],input[type=time],input[type=date],select{background:var(--bg4);border:1px solid var(--border2);border-radius:5px;color:var(--text);font-family:var(--body);font-size:13px;padding:7px 10px;outline:none;transition:border-color .2s;}
input:focus,select:focus{border-color:var(--accent);}
select{cursor:pointer;}select option{background:var(--bg4);}
label{font-size:12px;color:var(--text2);display:block;margin-bottom:4px;}
.field{display:flex;flex-direction:column;}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;}
.btn{font-family:var(--head);font-size:13px;font-weight:600;letter-spacing:.05em;padding:7px 16px;border-radius:5px;border:none;cursor:pointer;transition:all .15s;white-space:nowrap;}
.btn-primary{background:var(--accent);color:#fff;}.btn-primary:hover{background:var(--accent2);}
.btn-danger{background:rgba(220,50,50,.15);color:#e05555;border:1px solid rgba(220,50,50,.3);}.btn-danger:hover{background:rgba(220,50,50,.28);}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border2);}.btn-ghost:hover{border-color:var(--accent);color:var(--accent2);}
.btn-gold{background:rgba(240,165,0,.15);color:var(--gold);border:1px solid rgba(240,165,0,.3);}.btn-gold:hover{background:rgba(240,165,0,.28);}
.btn-garrison{background:rgba(42,127,255,.15);color:#6ab0ff;border:1px solid rgba(42,127,255,.35);}.btn-garrison:hover{background:rgba(42,127,255,.28);}
.btn-attack{background:rgba(46,204,113,.12);color:#5ddb8a;border:1px solid rgba(46,204,113,.3);}.btn-attack:hover{background:rgba(46,204,113,.22);}
.btn-sm{padding:5px 11px;font-size:12px;}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:3px;letter-spacing:.05em;}
.badge-tg5{background:rgba(240,165,0,.18);color:var(--gold);border:1px solid rgba(240,165,0,.35);}
.badge-tg4{background:rgba(61,142,240,.18);color:#6ab0ff;border:1px solid rgba(61,142,240,.35);}
.badge-tg3{background:rgba(100,200,100,.12);color:#7dc87d;border:1px solid rgba(100,200,100,.25);}
table{width:100%;border-collapse:collapse;}
th{font-family:var(--head);font-size:11px;letter-spacing:.08em;color:var(--text3);text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;}
td{padding:9px 10px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(255,255,255,.02);}
.mono{font-family:var(--mono);}
.launch-time{font-family:var(--mono);font-size:18px;color:var(--gold);letter-spacing:.08em;}
.copy-line{background:var(--bg4);border:1px solid var(--border);border-radius:5px;padding:10px 14px;font-family:var(--mono);font-size:13px;color:var(--accent2);margin:4px 0;cursor:pointer;transition:background .15s;display:flex;justify-content:space-between;align-items:center;}
.copy-line:hover{background:rgba(61,142,240,.12);}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px;}
.dot-free{background:var(--green);}
.dot-locked{background:var(--enemy);animation:blink 1.2s infinite;}
.dot-garrison{background:var(--gold);}
.dot-inflight{background:#a855f7;animation:blink 0.8s infinite;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.stat-box{background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:14px 16px;}
.stat-val{font-family:var(--mono);font-size:26px;color:var(--accent2);}
.stat-lbl{font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-top:4px;}
.pool-row{display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;}
.pool-row:last-child{border-bottom:none;}
.pool-bar-wrap{flex:1;height:6px;background:var(--bg4);border-radius:99px;overflow:hidden;min-width:80px;}
.pool-bar{height:100%;border-radius:99px;}

/* ── SIMULATOR ── */
.sim-layout{display:grid;grid-template-columns:260px 1fr;gap:18px;}
.alliance-panel{display:flex;flex-direction:column;gap:12px;}
.ap-card{background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:14px;}
.ap-title{font-family:var(--head);font-size:13px;font-weight:700;letter-spacing:.07em;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.ap-title.garrison-col{color:#6ab0ff;}
.ap-title.attack-col{color:#5ddb8a;}
.ap-title.enemy-col{color:#ff7070;}
.leader-chip{display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:5px;background:var(--bg3);border:1px solid var(--border);margin-bottom:5px;cursor:pointer;transition:all .15s;user-select:none;}
.leader-chip:hover{border-color:var(--accent);}
.leader-chip.can-launch{border-color:rgba(46,204,113,.4);}
.leader-chip.can-launch:hover{background:rgba(46,204,113,.1);border-color:var(--green);}
.leader-chip.garrisoned{opacity:.5;cursor:not-allowed;border-color:rgba(240,165,0,.3);}
.leader-chip.in-flight{border-color:rgba(168,85,247,.5);background:rgba(168,85,247,.08);}
.leader-chip.disabled{opacity:.35;cursor:not-allowed;}
.chip-name{font-weight:600;font-size:13px;flex:1;}
.chip-march{font-family:var(--mono);font-size:11px;color:var(--text3);}
.chip-status{font-size:10px;font-family:var(--head);letter-spacing:.05em;font-weight:600;}
.chip-status.free{color:var(--green);}
.chip-status.garrisoned{color:var(--gold);}
.chip-status.in-flight{color:#a855f7;}

/* TIMELINE */
.timeline-area{display:flex;flex-direction:column;gap:4px;}
.tl-header{display:flex;padding-left:0;margin-bottom:4px;}
.tl-tick{font-family:var(--mono);font-size:10px;color:var(--text3);flex:1;text-align:left;}
.tl-row{display:flex;align-items:center;gap:8px;margin-bottom:3px;}
.tl-label{font-family:var(--head);font-size:11px;font-weight:600;letter-spacing:.05em;color:var(--text2);width:56px;text-align:right;flex-shrink:0;}
.tl-track{flex:1;height:24px;background:var(--bg4);border-radius:4px;position:relative;overflow:visible;border:1px solid var(--border);}
.tl-seg{position:absolute;top:0;height:100%;display:flex;align-items:center;justify-content:center;font-size:10px;font-family:var(--head);font-weight:600;letter-spacing:.04em;border-radius:3px;overflow:hidden;white-space:nowrap;}
.tl-seg.garrison-seg{background:rgba(42,127,255,.4);border:1px solid rgba(42,127,255,.65);color:#9ec8ff;}
.tl-seg.attack-seg{background:rgba(46,204,113,.3);border:1px solid rgba(46,204,113,.6);color:#7de8a8;}
.tl-seg.enemy-seg{background:rgba(224,58,58,.38);border:1px solid rgba(224,58,58,.65);color:#ffaaaa;}
.tl-seg.inflight-seg{background:rgba(168,85,247,.25);border:1px dashed rgba(168,85,247,.6);color:#d8b4fe;}
.tl-marker{position:absolute;top:-6px;width:2px;height:36px;background:rgba(255,255,255,.15);pointer-events:none;}

.occ-row{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;}
.occ-box{background:var(--bg4);border-radius:6px;padding:10px 14px;min-width:110px;}
.occ-lbl{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px;}
.occ-val{font-family:var(--mono);font-size:18px;}
.occ-val.garrison-col{color:#6ab0ff;}
.occ-val.attack-col{color:#5ddb8a;}
.occ-val.enemy-col{color:#ff7070;}

.win-banner{display:none;font-family:var(--head);font-size:17px;font-weight:700;letter-spacing:.07em;padding:11px 18px;border-radius:7px;margin-top:12px;text-align:center;}
.win-banner.win{background:rgba(42,127,255,.18);color:var(--accent2);border:1px solid rgba(42,127,255,.4);}
.win-banner.lose{background:rgba(224,58,58,.18);color:#ff7070;border:1px solid rgba(224,58,58,.4);}

.sim-log{max-height:150px;overflow-y:auto;font-family:var(--mono);font-size:11px;color:var(--text2);line-height:2;}
.sim-info{font-size:13px;color:var(--text2);margin-bottom:12px;line-height:1.7;}

.enemy-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;}
.enemy-btn{font-family:var(--head);font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px;border:2px solid rgba(224,58,58,.5);color:#ff7070;background:rgba(224,58,58,.1);cursor:pointer;letter-spacing:.05em;transition:all .18s;}
.enemy-btn:hover{background:rgba(224,58,58,.22);}

.team-mgmt{margin-bottom:18px;}
.team-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);}
.team-row:last-child{border-bottom:none;}

#toast{position:fixed;bottom:24px;right:24px;background:var(--accent);color:#fff;font-family:var(--head);font-size:14px;font-weight:600;letter-spacing:.06em;padding:10px 20px;border-radius:6px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:9999;}
#toast.show{opacity:1;}
.drop-zone.drag-over{border-color:var(--accent)!important;background:rgba(61,142,240,.06);}
.team-mgmt:active{cursor:grabbing;}

/* TURRETS */
.turret-card{background:var(--bg4);border:1.5px solid var(--border);border-radius:8px;padding:12px 14px;text-align:center;transition:border-color .2s;}
.turret-card.ours{border-color:rgba(42,127,255,.6);background:rgba(42,127,255,.08);}
.turret-card.enemy{border-color:rgba(224,58,58,.5);background:rgba(224,58,58,.07);}
.turret-title{font-family:var(--head);font-size:13px;font-weight:700;letter-spacing:.06em;margin-bottom:8px;color:var(--text2);}
.turret-status{font-size:11px;font-family:var(--head);font-weight:600;letter-spacing:.06em;margin-bottom:8px;}
.turret-status.ours{color:#6ab0ff;}
.turret-status.enemy{color:#ff7070;}
.turret-status.empty{color:var(--text3);}
.turret-select{width:100%;font-size:12px;margin-bottom:8px;}
.turret-btns{display:flex;gap:5px;justify-content:center;}

/* PET BUFFS */
.pet-card{background:var(--bg4);border:1.5px solid var(--border);border-radius:8px;padding:12px 14px;min-width:140px;flex:1;max-width:180px;transition:border-color .2s;}
.pet-card.active{border-color:rgba(168,85,247,.5);background:rgba(168,85,247,.07);}
.pet-card.expiring{border-color:rgba(240,165,0,.6);background:rgba(240,165,0,.06);animation:pulse-gold .8s infinite;}
.pet-card.expired{border-color:rgba(224,58,58,.4);background:rgba(224,58,58,.05);}
@keyframes pulse-gold{0%,100%{border-color:rgba(240,165,0,.6)}50%{border-color:rgba(240,165,0,.2)}}
.pet-name{font-weight:600;font-size:13px;margin-bottom:3px;}
.pet-tier{font-size:11px;color:var(--text3);margin-bottom:8px;}
.pet-timer{font-family:var(--mono);font-size:18px;font-weight:600;margin-bottom:8px;min-height:24px;}
.pet-timer.active{color:#c084fc;}
.pet-timer.expiring{color:var(--gold);}
.pet-timer.expired{color:var(--enemy);}
.pet-timer.idle{color:var(--text3);}
.pet-toggle{width:100%;font-family:var(--head);font-size:12px;font-weight:600;letter-spacing:.05em;padding:6px;border-radius:4px;border:none;cursor:pointer;transition:all .15s;}
.pet-toggle.on{background:rgba(168,85,247,.25);color:#c084fc;}
.pet-toggle.off{background:var(--bg3);color:var(--text3);border:1px solid var(--border);}

/* BATTLE STRATEGY */
.bs-slot{background:var(--bg4);border:2px dashed var(--border);border-radius:8px;padding:10px;min-height:90px;transition:all .15s;}
.bs-slot.drag-over{border-color:var(--accent);background:rgba(61,142,240,.08);border-style:solid;}
.bs-slot-label{font-family:var(--head);font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--text2);margin-bottom:8px;text-align:center;}
.bs-team-zone{min-height:90px;border:2px dashed var(--border);border-radius:8px;padding:10px;display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;transition:all .15s;}
.bs-team-zone.drag-over{border-color:var(--accent);background:rgba(61,142,240,.06);border-style:solid;}
.bs-team-header{font-family:var(--head);font-size:13px;font-weight:700;letter-spacing:.05em;color:var(--text2);margin-bottom:6px;}
.bs-leader-card{background:var(--bg3);border:1.5px solid var(--border);border-radius:7px;padding:8px 10px;cursor:grab;width:140px;transition:border-color .15s,opacity .15s;user-select:none;}
.bs-leader-card:hover{border-color:var(--accent2);}
.bs-leader-card.dragging{opacity:.35;}
.bs-leader-name{font-weight:600;font-size:13px;margin-bottom:2px;}
.bs-leader-meta{font-size:11px;color:var(--text3);margin-bottom:6px;}
.bs-pet-bar{height:6px;border-radius:99px;overflow:hidden;background:var(--bg2);}
.bs-pet-bar-fill{height:100%;border-radius:99px;transition:background .2s;}
.bs-pet-bar-fill.on{background:var(--green);}
.bs-pet-bar-fill.off{background:var(--enemy);}
.bs-pet-label{font-size:10px;text-align:center;margin-top:3px;letter-spacing:.04em;font-family:var(--head);font-weight:600;}
.bs-pet-label.on{color:var(--green);}
.bs-pet-label.off{color:#ff7070;}

/* MINISTER SPOTS */
.ms-slot-btn{font-family:var(--mono);font-size:11px;padding:8px 4px;border-radius:5px;border:1px solid var(--border2);background:var(--bg4);color:var(--text2);cursor:pointer;transition:all .15s;text-align:center;}
.ms-slot-btn:hover{border-color:var(--accent);}
.ms-slot-btn.selected{background:rgba(61,142,240,.25);color:var(--accent2);border-color:var(--accent);font-weight:600;}
.ms-slot-btn.taken{background:rgba(224,58,58,.12);color:#ff8080;border-color:rgba(224,58,58,.3);cursor:not-allowed;opacity:.6;}
.ms-verify-field{background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:12px 14px;}
.ms-verify-field label{margin-bottom:6px;}
.ms-slider-row{margin-bottom:18px;}
.ms-slider-row input[type=range]{width:100%;margin:8px 0;accent-color:var(--accent);}
.ms-rank-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px;}
.ms-rank-row:last-child{border-bottom:none;}
.ms-rank-num{font-family:var(--mono);width:32px;color:var(--text3);}
.ms-rank-row.winner{background:rgba(46,204,113,.06);}
.ms-rank-row.rejected{background:rgba(224,58,58,.05);opacity:.7;}

@media(max-width:900px){.sim-layout{grid-template-columns:1fr;}.page{padding:14px 12px;}.grid2,.grid3{grid-template-columns:1fr;}#msSlotGrid{grid-template-columns:repeat(4,1fr)!important;}#msVerifyGrid{grid-template-columns:1fr!important;}}
</style>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js" onerror="this.onerror=null;var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js';document.head.appendChild(s);"></script>
</head>
<body>
<nav class="nav">
  <div class="nav-logo">KINGDOM<span>·</span>1057</div>
  <div class="tab active" onclick="showPage('coordinator')">Rally Leaders</div>
  <div class="tab" onclick="showPage('strategy')">Battle Strategy</div>
  <div class="tab" onclick="showPage('setup')">Team Setup</div>
  <div class="tab" onclick="showPage('minister')">Minister Spots</div>
  <div id="syncStatus" style="font-family:var(--head);font-size:11px;font-weight:600;letter-spacing:.04em;margin-right:14px;color:var(--text3)">Sync not configured</div>
  <div class="utc-clock" id="utcClock">00:00:00</div>
</nav>
<div id="toast">Copied!</div>

<!-- ══════════════════════ RALLY COORDINATOR ══════════════════════ -->
<div id="page-coordinator" class="page active">
  <div class="card">
    <div class="card-title">👥 Rally Leaders</div>
    <div class="row">
      <div class="field"><label>Name</label><input type="text" id="rlName" placeholder="e.g. Olaf" style="width:120px"></div>
      <div class="field"><label>March time (sec)</label><input type="number" id="rlMarch" placeholder="35" min="1" max="300" style="width:90px"></div>
      <div class="field"><label>TG Tier</label>
        <select id="rlTier" style="width:80px"><option value="TG5">TG5</option><option value="TG4">TG4</option><option value="TG3">TG3</option></select>
      </div>
      <div class="field"><label>Rally duration</label>
        <select id="rlDur" style="width:90px"><option value="300">5 min</option><option value="600">10 min</option></select>
      </div>
      <div class="field"><label>Team</label><select id="rlTeam" style="width:110px"><option value="">No team</option></select></div>
      <button class="btn btn-primary" onclick="addLeader()">+ Add Leader</button>
    </div>
    <table><thead><tr><th>Name</th><th>March</th><th>Tier</th><th>Team</th><th>Status</th><th>Duration</th><th>Launch Time</th><th>Timer</th><th>Cooldown</th><th></th></tr></thead>
    <tbody id="leaderBody"></tbody></table>
  </div>

  <div class="card">
    <div class="card-title">⏱ Active Rally Timers</div>
    <div id="activeTimers" style="color:var(--text3);font-size:13px">No active rallies.</div>
  </div>
</div>

<!-- BATTLE STRATEGY PAGE -->
<div id="page-strategy" class="page">
  <div class="card" style="margin-bottom:14px">
    <div class="sim-info" style="margin:0">
      <strong style="color:var(--text)">How to use:</strong> Drag rally leaders from the pool onto turret slots or team slots. A leader can only occupy one slot at a time. The green/red bar shows whether that leader currently has pets active.
    </div>
  </div>

  <div class="card">
    <div class="card-title">🗼 Turret Assignments</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px" id="bsTurretGrid"></div>
  </div>

  <div class="grid2" style="margin-bottom:18px">
    <div class="card" style="margin-bottom:0">
      <div class="card-title">🏰 <span id="bsGarrisonTitle">Garrison Alliance</span></div>
      <div id="bsGarrisonZone" class="bs-alliance-zone" ondragover="bsAllianceDragOver(event)" ondragleave="bsAllianceDragLeave(event)" ondrop="bsAllianceDrop(event,'garrison')"
        style="min-height:90px;border:2px dashed var(--border);border-radius:8px;padding:10px"></div>
    </div>
    <div class="card" style="margin-bottom:0">
      <div class="card-title">⚔️ <span id="bsAttackTitle">Attacking Alliance</span></div>
      <div id="bsAttackZone" class="bs-alliance-zone" ondragover="bsAllianceDragOver(event)" ondragleave="bsAllianceDragLeave(event)" ondrop="bsAllianceDrop(event,'attack')"
        style="min-height:90px;border:2px dashed var(--border);border-radius:8px;padding:10px"></div>
    </div>
  </div>

  <!-- UNASSIGNED TEAMS -->
  <div class="card">
    <div class="card-title">📦 Unassigned Teams</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:10px">Drag a team box into Garrison or Attacking Alliance above. Drag a team back here to unassign it.</p>
    <div id="bsUnassignedZone" ondragover="bsAllianceDragOver(event)" ondragleave="bsAllianceDragLeave(event)" ondrop="bsAllianceDrop(event,null)"
      style="display:flex;flex-wrap:wrap;gap:10px;min-height:90px;border:2px dashed var(--border);border-radius:8px;padding:10px"></div>
  </div>

  <!-- SHARED SETUP -->
  <div class="card">
    <div class="card-title">⚙️ Shared Setup</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;flex-wrap:wrap">
      <div>
        <label>Rally Arrival Time</label>
        <select id="bsDur" style="width:160px;margin-bottom:4px" onchange="bsRenderResults()">
          <option value="300">5 min</option>
          <option value="600">10 min</option>
        </select>
      </div>
      <div>
        <label>Rally Start Time (UTC) — live</label>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <div id="bsClockHH" class="mono" style="font-size:20px;color:var(--text);background:var(--bg4);border:1px solid var(--border2);border-radius:5px;padding:6px 12px;min-width:46px;text-align:center">00</div>
          <span style="color:var(--text2);font-size:18px">:</span>
          <div id="bsClockMM" class="mono" style="font-size:20px;color:var(--text);background:var(--bg4);border:1px solid var(--border2);border-radius:5px;padding:6px 12px;min-width:46px;text-align:center">00</div>
          <span style="color:var(--text2);font-size:18px">:</span>
          <div id="bsClockSS" class="mono" style="font-size:20px;color:var(--text);background:var(--bg4);border:1px solid var(--border2);border-radius:5px;padding:6px 12px;min-width:46px;text-align:center">00</div>
          <span style="font-size:11px;color:var(--text3);margin-left:6px">UTC now</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-gold btn-sm" onclick="bsSetOffset(15)">+15s</button>
          <button class="btn btn-gold btn-sm" onclick="bsSetOffset(30)">+30s</button>
          <button class="btn btn-gold btn-sm" onclick="bsSetOffset(45)">+45s</button>
          <button class="btn btn-gold btn-sm" onclick="bsSetOffset(60)">+1m</button>
          <button class="btn btn-gold btn-sm" onclick="bsSetOffset(120)">+2m</button>
          <button class="btn btn-gold btn-sm" onclick="bsSetOffset(180)">+3m</button>
          <button class="btn btn-gold btn-sm" onclick="bsSetOffset(240)">+4m</button>
        </div>
      </div>
    </div>
  </div>

  <!-- FINAL CALCULATION -->
  <div class="card">
    <div class="card-title">📋 Final Calculation</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:12px">Click a team below to calculate launch times for its leaders, based on the offset selected above.</p>
    <div id="bsTeamButtons" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px"></div>
    <div id="bsFinalResult">
      <div style="color:var(--text3);font-size:13px">Select an offset, then click a team to see the schedule.</div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">👥 Rally Leader Pool</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:12px">Drag a leader card into a turret or team slot above. Drag back here to unassign.</p>
    <div id="bsLeaderPool" ondragover="bsOnDragOver(event)" ondragleave="bsOnDragLeave(event)" ondrop="bsOnDrop(event,'pool',null)"
      style="display:flex;flex-wrap:wrap;gap:10px;min-height:70px;border:2px dashed var(--border);border-radius:8px;padding:12px">
    </div>
  </div>
</div>


<!-- ══════════════════════ TEAM SETUP ══════════════════════ -->
<div id="page-setup" class="page">
  <div class="grid2">
    <div class="card">
      <div class="card-title">🏰 Garrison Alliance</div>
      <div class="row" style="margin-bottom:10px">
        <div class="field"><label>Alliance name</label><input type="text" id="garrisonAllianceName" placeholder="e.g. [GRD]" style="width:140px" oninput="updateAllianceNames()"></div>
      </div>
      <div class="sec-title">Teams assigned to Garrison</div>
      <div id="garrisonTeamList"><div style="color:var(--text3);font-size:12px">No teams assigned.</div></div>
    </div>
    <div class="card">
      <div class="card-title">⚔️ Attacking Alliance</div>
      <div class="row" style="margin-bottom:10px">
        <div class="field"><label>Alliance name</label><input type="text" id="attackAllianceName" placeholder="e.g. [ATK]" style="width:140px" oninput="updateAllianceNames()"></div>
      </div>
      <div class="sec-title">Teams assigned to Attacking</div>
      <div id="attackTeamList"><div style="color:var(--text3);font-size:12px">No teams assigned.</div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">👥 Teams</div>
    <div class="row">
      <div class="field"><label>New team name</label><input type="text" id="newTeamName" placeholder="e.g. Team Alpha" style="width:150px"></div>
      <button class="btn btn-primary" onclick="addTeam()">+ Create Team</button>
    </div>
    <div id="teamsList"></div>
  </div>
</div>

<!-- MINISTER SPOTS PAGE -->
<div id="page-minister" class="page">

  <div class="card" style="margin-bottom:14px">
    <div class="card-title">👑 Noble Advisor — Day 4</div>
    <p style="color:var(--text2);font-size:13px;margin:0">48 timeslots (00:00–00:30 ... 23:30–00:00 UTC). Ranked by <strong style="color:var(--text)">Training (troop) speedup hours</strong> committed for this KvK. Top 48 submissions win a slot.</p>
  </div>

  <!-- STEP TABS -->
  <div class="phase-tabs" style="margin-bottom:18px">
    <button class="tab ms-step-tab active" id="msStepTab1" onclick="msGoStep(1)">1. Upload</button>
    <button class="tab ms-step-tab" id="msStepTab2" onclick="msGoStep(2)">2. Verify</button>
    <button class="tab ms-step-tab" id="msStepTab3" onclick="msGoStep(3)">3. Commitment</button>
    <button class="tab ms-step-tab" id="msStepTab4" onclick="msGoStep(4)">4. Timeslots</button>
    <button class="tab ms-step-tab" id="msStepTab5" onclick="msGoStep(5)">5. Results &amp; Schedule</button>
  </div>

  <!-- STEP 1: UPLOAD -->
  <div id="msStep1" class="ms-step">
    <div class="card">
      <div class="card-title">📸 Step 1 — Identify &amp; Upload</div>
      <div class="row">
        <div class="field"><label>Alliance name</label><input type="text" id="msAlliance" placeholder="e.g. HDS" style="width:140px"></div>
        <div class="field"><label>In-game name</label><input type="text" id="msIGN" placeholder="e.g. Olaf" style="width:160px"></div>
      </div>
      <div id="msIdentityError" style="display:none;color:#ff7070;font-size:12px;margin-bottom:10px;background:rgba(224,58,58,.1);border:1px solid rgba(224,58,58,.3);border-radius:5px;padding:8px 12px">⚠ Please enter both your Alliance name and in-game name before continuing.</div>
      <div class="sec-title">Upload your inventory screenshot</div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:10px">Take a screenshot of your speedup items in the in-game inventory (Construction, Research, Training, General). Works from phone or desktop.</p>
      <input type="file" id="msFileInput" accept="image/*" capture="environment" style="margin-bottom:10px">
      <div id="msImgPreviewWrap" style="display:none;margin:12px 0">
        <img id="msImgPreview" style="max-width:280px;border-radius:8px;border:1px solid var(--border)">
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="msScanBtn" onclick="msRunOCR()">🔍 Scan Screenshot</button>
        <button class="btn btn-ghost" onclick="msSkipToManual()">Skip — enter manually</button>
      </div>
      <div id="msOCRProgressWrap" style="display:none;margin-top:12px">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span id="msOCRStatus" style="font-size:12px;color:var(--text2)">Starting…</span>
          <span id="msOCRPct" class="mono" style="font-size:12px;color:var(--accent2)">0%</span>
        </div>
        <div style="height:6px;background:var(--bg4);border-radius:99px;overflow:hidden">
          <div id="msOCRBar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--accent),var(--gold));border-radius:99px;transition:width .3s"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- STEP 2: VERIFY -->
  <div id="msStep2" class="ms-step" style="display:none">
    <div class="card">
      <div class="card-title">✅ Step 2 — Verify &amp; Correct</div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:14px">Confirm the detected speedup amounts below. If a number looks wrong, correct it manually — OCR isn't perfect. Enter the raw amount and pick its unit; it converts to hours automatically.</p>
      <div id="msVerifyGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px"></div>
      <button class="btn btn-primary" style="margin-top:16px" onclick="msMarkStepComplete(2);msGoStep(3)">Continue to Commitment →</button>
    </div>
  </div>

  <!-- STEP 3: COMMITMENT SLIDERS -->
  <div id="msStep3" class="ms-step" style="display:none">
    <div class="card">
      <div class="card-title">🎯 Step 3 — Expected Usage This KvK</div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:14px">For each category, set how much of your speedups you plan to commit this KvK. This determines your ranking priority for minister spots.</p>
      <div id="msSliderGrid"></div>
      <button class="btn btn-primary" style="margin-top:10px" onclick="msMarkStepComplete(3);msGoStep(4)">Continue to Timeslots →</button>
    </div>
  </div>

  <!-- STEP 4: TIMESLOT PICKS -->
  <div id="msStep4" class="ms-step" style="display:none">
    <div class="card">
      <div class="card-title">🕐 Step 4 — Pick Your Preferred Timeslots</div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:6px">Select at least <strong style="color:var(--text)">4 timeslots</strong> that work best for you (UTC). Your committed Training hours: <span id="msYourTrainingHours" class="mono" style="color:var(--gold)">0h</span></p>
      <div id="msSlotPickCount" style="font-size:12px;color:var(--text3);margin-bottom:10px">0 slots selected</div>
      <div id="msSlotGrid" style="display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-bottom:16px"></div>
      <button class="btn btn-primary" onclick="msSubmitEntry()">✅ Submit My Entry</button>
    </div>
  </div>

  <!-- STEP 5: RESULTS / LEADER VIEW -->
  <div id="msStep5" class="ms-step" style="display:none">
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">📊 All Submissions</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">
        <div class="stat-box"><div class="stat-val" id="msTotalSubs">0</div><div class="stat-lbl">Total submissions</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--green)" id="msWinnerCount">0</div><div class="stat-lbl">Spots filled (of 48)</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--enemy)" id="msRejectedCount">0</div><div class="stat-lbl">Not selected</div></div>
      </div>
      <button class="btn btn-gold" onclick="msRunAllocation()">⚙️ Run Allocation (rank + assign slots)</button>
      <button class="btn btn-ghost btn-sm" onclick="msClearAllSubs()" style="margin-left:8px">🗑 Clear all submissions</button>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-title">🏆 Final Schedule (Top 48)</div>
      <div id="msFinalSchedule"><div style="color:var(--text3);font-size:13px">Run allocation to generate the schedule.</div></div>
      <button class="btn btn-gold btn-sm" style="margin-top:10px" onclick="msCopySchedule()">📋 Copy schedule for alliance chat</button>
    </div>

    <div class="card">
      <div class="card-title">❌ Not Selected</div>
      <div id="msRejectedList"><div style="color:var(--text3);font-size:13px">—</div></div>
    </div>
  </div>

</div>

<script>
// ════════════ STATE ════════════
const S = {
  leaders: [],   // {id, name, march, tier, dur, teamId, status, timerEnd, launchTimeStr}
  teams: []      // {id, name, alliance:'garrison'|'attack'|null}
};

// Minister Spots shared state (declared early so sync functions below can reference it safely)
const MS = {
  draft: { alliance:'', ign:'', verify:{}, commit:{}, picks:[] }, // in-progress entry
  submissions: [], // {id, alliance, ign, verify:{cat:{amount,unit,hours}}, commit:{cat:pct}, picks:[slotIdx...], committedHours:{cat:hours}}
  _lastAllocation: null,
  _currentStep: 1
};

// ════════════ SHARED SYNC (Cloudflare Worker + KV) ════════════
// Set this to your deployed Worker URL — see DEPLOY.md
const SYNC_API_URL = ""; // same-origin: the Worker now serves both the site and the API
const SYNC_POLL_MS = 20000; // check for updates from others every 20s
let syncPushTimer = null;
let syncLastPushedJSON = null;
let syncApplyingRemote = false; // guards against re-triggering a push while applying a pull

function syncEnabled() {
  // Empty string is a valid, intentional value meaning "same origin as this page"
  // (used when the Worker serves both the site and the API together).
  return SYNC_API_URL === "" || (SYNC_API_URL && !SYNC_API_URL.startsWith("REPLACE_"));
}

function syncSerialize() {
  // Only persist what should be shared. Leave out transient per-session timers
  // (rally countdown / cooldown) since those are tied to a live moment in time.
  return JSON.stringify({
    leaders: S.leaders.map(l => ({
      id: l.id, name: l.name, march: l.march, tier: l.tier, dur: l.dur,
      teamId: l.teamId, pet: l.pet ? { active: !!l.pet.active } : { active: false },
      bsSlot: l.bsSlot || { slotType: 'pool', slotId: null }
    })),
    teams: S.teams.map(t => ({ id: t.id, name: t.name, alliance: t.alliance })),
    garrisonAllianceName: document.getElementById('garrisonAllianceName') ? document.getElementById('garrisonAllianceName').value : '',
    attackAllianceName: document.getElementById('attackAllianceName') ? document.getElementById('attackAllianceName').value : '',
    msSubmissions: (typeof MS!=='undefined') ? MS.submissions : [],
    msLastAllocation: (typeof MS!=='undefined') ? MS._lastAllocation : null
  });
}

function syncApplyRemote(data) {
  syncApplyingRemote = true;
  try {
    S.leaders = (data.leaders || []).map(l => ({
      ...l,
      status: 'free', timerEnd: null, cooldownEnd: null, launchTimeStr: null, landTimeStr: null
    }));
    S.teams = data.teams || [];
    const gEl = document.getElementById('garrisonAllianceName');
    const aEl = document.getElementById('attackAllianceName');
    if (gEl && data.garrisonAllianceName !== undefined) gEl.value = data.garrisonAllianceName;
    if (aEl && data.attackAllianceName !== undefined) aEl.value = data.attackAllianceName;
    if (typeof updateAllianceNames === 'function') updateAllianceNames();
    if (typeof renderLeaderTable === 'function') renderLeaderTable();
    if (typeof renderSetup === 'function') renderSetup();
    if (typeof renderBattleStrategy === 'function') renderBattleStrategy();
    if (typeof MS!=='undefined') {
      MS.submissions = data.msSubmissions || [];
      MS._lastAllocation = data.msLastAllocation || null;
      if (typeof msRenderResultsSummary==='function') msRenderResultsSummary();
      if (typeof msRenderFinalSchedule==='function') msRenderFinalSchedule();
      if (typeof msRenderRejectedList==='function') msRenderRejectedList();
    }
  } finally {
    syncApplyingRemote = false;
  }
}

async function syncPull() {
  if (!syncEnabled()) return;
  try {
    const res = await fetch(SYNC_API_URL.replace(/\\/$/, '') + '/state', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const json = JSON.stringify(data);
    if (json !== syncLastPushedJSON && Object.keys(data).length) {
      syncApplyRemote(data);
      syncLastPushedJSON = json;
      updateSyncStatus('synced');
    }
  } catch (e) {
    updateSyncStatus('offline');
  }
}

async function syncPushNow() {
  if (!syncEnabled() || syncApplyingRemote) return;
  const json = syncSerialize();
  if (json === syncLastPushedJSON) return; // nothing changed
  try {
    const res = await fetch(SYNC_API_URL.replace(/\\/$/, '') + '/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: json
    });
    if (res.ok) { syncLastPushedJSON = json; updateSyncStatus('synced'); }
    else updateSyncStatus('error');
  } catch (e) {
    updateSyncStatus('offline');
  }
}

function syncQueuePush() {
  if (!syncEnabled() || syncApplyingRemote) return;
  updateSyncStatus('saving');
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(syncPushNow, 800); // debounce rapid edits
}

function updateSyncStatus(state) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const map = {
    synced: ['● Synced', 'var(--green)'],
    saving: ['● Saving…', 'var(--gold)'],
    offline: ['● Offline — changes saved locally only', '#ff7070'],
    error: ['● Sync error', '#ff7070'],
    off: ['Sync not configured', 'var(--text3)']
  };
  const [txt, color] = map[state] || map.off;
  el.textContent = txt;
  el.style.color = color;
}

if (syncEnabled()) {
  syncPull();
  setInterval(syncPull, SYNC_POLL_MS);
} else {
  setTimeout(() => updateSyncStatus('off'), 0);
}

// ════════════ NAV ════════════
function showPage(p) {
  document.querySelectorAll('.page').forEach(e=>e.classList.remove('active'));
  document.querySelectorAll('.nav > .tab').forEach(e=>e.classList.remove('active'));
  document.getElementById('page-'+p).classList.add('active');
  event.currentTarget.classList.add('active');
  if(p==='strategy') { renderBattleStrategy(); bsTickClock(); }
  if(p==='setup') renderSetup();
  if(p==='coordinator') renderLeaderTable();
  if(p==='minister') msInit();
}

// UTC clock
function updateClock(){
  const n=new Date();
  document.getElementById('utcClock').textContent=
    String(n.getUTCHours()).padStart(2,'0')+':'+String(n.getUTCMinutes()).padStart(2,'0')+':'+String(n.getUTCSeconds()).padStart(2,'0')+' UTC';
}
setInterval(updateClock,1000); updateClock();

// ════════════ HELPERS ════════════
function fmtSec(s){
  s=Math.max(0,Math.round(s));
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  if(h>0) return h+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0');
  return String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0');
}
function fmtHMS(s){
  s=Math.max(0,Math.round(s));
  return Math.floor(s/3600)+':'+String(Math.floor((s%3600)/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg||'Copied!'; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),1800);
}
function copyText(text){
  navigator.clipboard?.writeText(text).then(()=>toast('Copied!')).catch(()=>{
    const el=document.createElement('textarea'); el.value=text; document.body.appendChild(el); el.select();
    document.execCommand('copy'); document.body.removeChild(el); toast('Copied!');
  });
}
function uid(){return Math.random().toString(36).slice(2,8);}

// ════════════ COORDINATOR ════════════
function setLandNow(){
  const n=new Date(); n.setUTCMinutes(n.getUTCMinutes()+5);
  document.getElementById('landTime').value=String(n.getUTCHours()).padStart(2,'0')+':'+String(n.getUTCMinutes()).padStart(2,'0')+':'+String(n.getUTCSeconds()).padStart(2,'0');
  document.getElementById('landDate').value=n.toISOString().slice(0,10);
}
function calcLaunchTimes(){
  const tv=document.getElementById('landTime').value; if(!tv){alert('Enter land time.');return;}
  const [hh,mm,ss]=tv.split(':').map(Number);
  const dv=document.getElementById('landDate').value;
  const base=dv?new Date(dv+'T00:00:00Z'):(()=>{const d=new Date();d.setUTCHours(0,0,0,0);return d;})();
  const landMs=base.getTime()+hh*3600000+mm*60000+(ss||0)*1000;
  const lines=document.getElementById('launchLines'); lines.innerHTML='';
  if(S.leaders.length===0){lines.innerHTML='<div style="color:var(--text3);font-size:13px">No rally leaders added yet.</div>';document.getElementById('launchOutput').style.display='block';return;}
  S.leaders.forEach(l=>{
    const lMs=landMs-l.march*1000; const lt=new Date(lMs);
    l.launchTimeStr=String(lt.getUTCHours()).padStart(2,'0')+':'+String(lt.getUTCMinutes()).padStart(2,'0')+':'+String(lt.getUTCSeconds()).padStart(2,'0');
    l.landTimeStr=tv;
    const tb=\`<span class="badge badge-\${l.tier.toLowerCase()}">\${l.tier}</span>\`;
    const cs=\`\${l.name} → Launch at \${l.launchTimeStr} UTC (march \${l.march}s → land \${tv} UTC)\`;
    const div=document.createElement('div'); div.className='copy-line';
    div.innerHTML=\`<span><strong style="color:var(--text);font-size:14px">\${l.name}</strong> \${tb} &nbsp;→ launch at <span class="launch-time">\${l.launchTimeStr}</span> <span style="color:var(--text3);font-size:12px">(march \${l.march}s)</span></span><span style="font-size:10px;color:var(--text3)">click to copy</span>\`;
    div.onclick=()=>copyText(cs); lines.appendChild(div);
  });
  document.getElementById('launchOutput').style.display='block';
  renderLeaderTable();
}
function copyAllLaunch(){
  const tv=document.getElementById('landTime').value; if(!tv||!S.leaders.length) return;
  const lines=S.leaders.map(l=>\`\${l.name} (\${l.tier}) → Launch \${l.launchTimeStr||'??:??:??'} UTC | March \${l.march}s | Land \${tv} UTC\`);
  lines.unshift(\`=== SVS Launch Orders — Land: \${tv} UTC ===\`);
  copyText(lines.join('\\n'));
}
function addLeader(){
  const name=document.getElementById('rlName').value.trim();
  const march=parseInt(document.getElementById('rlMarch').value);
  const tier=document.getElementById('rlTier').value;
  const dur=parseInt(document.getElementById('rlDur').value);
  const teamId=document.getElementById('rlTeam').value||null;
  if(!name||isNaN(march)){alert('Enter name and march time.');return;}
  S.leaders.push({id:uid(),name,march,tier,dur,teamId,status:'free',timerEnd:null,launchTimeStr:null,landTimeStr:null});
  document.getElementById('rlName').value=''; document.getElementById('rlMarch').value='';
  renderLeaderTable(); renderSetup(); if(typeof renderBattleStrategy==='function') renderBattleStrategy();
  syncQueuePush();
}
function removeLeader(id){
  S.leaders=S.leaders.filter(l=>l.id!==id);
  renderLeaderTable(); renderSetup(); if(typeof renderBattleStrategy==='function') renderBattleStrategy();
  syncQueuePush();
}
function startRallyTimer(id){
  const l=S.leaders.find(x=>x.id===id); if(!l) return;
  l.status='locked';
  l.timerEnd=Date.now()+l.dur*1000;
  // cooldown = rally dur + 2x march
  l.cooldownEnd=Date.now()+l.dur*1000+l.march*2*1000;
  renderLeaderTable();
}
function stopTimer(id){
  const l=S.leaders.find(x=>x.id===id); if(!l) return;
  l.status='free'; l.timerEnd=null; l.cooldownEnd=null; renderLeaderTable();
}
function renderLeaderTable(){
  // update team dropdown
  const sel=document.getElementById('rlTeam');
  const cur=sel.value;
  sel.innerHTML='<option value="">No team</option>'+S.teams.map(t=>\`<option value="\${t.id}">\${t.name}</option>\`).join('');
  if(cur) sel.value=cur;

  const tbody=document.getElementById('leaderBody');
  if(!S.leaders.length){tbody.innerHTML='<tr><td colspan="9" style="color:var(--text3);text-align:center;padding:18px">No leaders added yet.</td></tr>';return;}
  tbody.innerHTML=S.leaders.map(l=>{
    const now=Date.now();
    const dot=l.status==='locked'?'dot-locked':'dot-free';
    const stxt=l.status==='locked'?'IN RALLY':'FREE';
    const tb=\`<span class="badge badge-\${l.tier.toLowerCase()}">\${l.tier}</span>\`;
    const team=S.teams.find(t=>t.id===l.teamId);
    const teamTxt=team?\`<span style="font-size:12px;color:var(--text3)">\${team.name}</span>\`:'<span style="color:var(--text3);font-size:11px">—</span>';
    const lt=l.launchTimeStr?\`<span class="mono" style="color:var(--gold)">\${l.launchTimeStr}</span>\`:'<span style="color:var(--text3)">—</span>';
    const ti=l.timerEnd?\`<span class="mono" id="ct\${l.id}" style="color:var(--accent2)">—</span>\`:'<span style="color:var(--text3)">—</span>';
    // cooldown display
    let cdTxt='<span style="color:var(--text3)">—</span>';
    if(l.cooldownEnd){
      const cdRem=(l.cooldownEnd-now)/1000;
      if(cdRem>0) cdTxt=\`<span class="mono" id="cd\${l.id}" style="color:#a855f7">—</span>\`;
      else cdTxt=\`<span style="color:var(--green);font-size:12px">✓ FREE</span>\`;
    }
    const startBtn=l.status==='free'
      ?\`<button class="btn btn-primary btn-sm" onclick="startRallyTimer('\${l.id}')">▶ \${l.dur===300?'5':'10'}m</button>\`
      :\`<button class="btn btn-danger btn-sm" onclick="stopTimer('\${l.id}')">■ Stop</button>\`;
    return \`<tr class="\${l.status==='locked'?'locked-row':''}">
      <td><strong>\${l.name}</strong></td><td class="mono">\${l.march}s</td><td>\${tb}</td><td>\${teamTxt}</td>
      <td><span class="dot \${dot}"></span>\${stxt}</td>
      <td class="mono" style="font-size:12px">\${l.dur===300?'5 min':'10 min'}</td>
      <td>\${lt}</td><td>\${ti}</td><td>\${cdTxt}</td>
      <td><div style="display:flex;gap:5px">\${startBtn} <button class="btn btn-ghost btn-sm" onclick="removeLeader('\${l.id}')">✕</button></div></td>
    </tr>\`;
  }).join('');
}
function tickTimers(){
  const now=Date.now();
  let needsRender=false;
  S.leaders.forEach(l=>{
    // rally timer
    if(l.timerEnd){
      const rem=(l.timerEnd-now)/1000;
      const el=document.getElementById('ct'+l.id);
      if(rem<=0){
        l.status='free'; l.timerEnd=null; needsRender=true;
      } else if(el){
        el.textContent=fmtSec(rem);
        el.style.color=rem<30?'#e05555':rem<60?'var(--gold)':'var(--accent2)';
      }
    }
    // cooldown timer
    if(l.cooldownEnd){
      const cdRem=(l.cooldownEnd-now)/1000;
      const cdEl=document.getElementById('cd'+l.id);
      if(cdRem<=0){
        l.cooldownEnd=null; needsRender=true;
      } else if(cdEl){
        cdEl.textContent=fmtSec(cdRem);
        cdEl.style.color=cdRem<30?'var(--green)':'#a855f7';
      }
    }
  });
  if(needsRender) renderLeaderTable();

  // active timers panel
  const panel=document.getElementById('activeTimers');
  const active=S.leaders.filter(l=>l.timerEnd);
  if(!active.length){panel.innerHTML='<div style="color:var(--text3);font-size:13px">No active rallies.</div>';return;}
  panel.innerHTML=active.map(l=>{
    const rem=Math.max(0,(l.timerEnd-now)/1000);
    const pct=Math.round((1-rem/l.dur)*100);
    const col=rem<30?'#e05555':rem<60?'var(--gold)':'var(--accent2)';
    const cdRem=l.cooldownEnd?Math.max(0,(l.cooldownEnd-now)/1000):0;
    return \`<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span><strong>\${l.name}</strong> <span class="badge badge-\${l.tier.toLowerCase()}">\${l.tier}</span></span>
        <span class="mono" style="color:\${col};font-size:18px">\${fmtSec(rem)}</span>
      </div>
      <div style="background:var(--bg4);height:5px;border-radius:99px;overflow:hidden;margin-bottom:4px">
        <div style="height:100%;width:\${pct}%;background:\${col};border-radius:99px;transition:width .5s"></div>
      </div>
      \${cdRem>0?\`<div style="font-size:11px;color:#a855f7">Cooldown (free in): <span class="mono">\${fmtSec(cdRem)}</span></div>\`:''}
    </div>\`;
  }).join('');
}
setInterval(tickTimers,500);
renderLeaderTable();

// ════════════ TEAM SETUP ════════════
function addTeam(){
  const name=document.getElementById('newTeamName').value.trim();
  if(!name) return;
  S.teams.push({id:uid(),name,alliance:null});
  document.getElementById('newTeamName').value='';
  renderSetup(); renderLeaderTable();
  if(typeof renderBattleStrategy==='function') renderBattleStrategy();
  syncQueuePush();
}
function removeTeam(id){
  S.teams=S.teams.filter(t=>t.id!==id);
  S.leaders.forEach(l=>{if(l.teamId===id)l.teamId=null;});
  renderSetup(); renderLeaderTable(); if(typeof renderBattleStrategy==='function') renderBattleStrategy();
  syncQueuePush();
}
function assignTeam(teamId,alliance){
  const t=S.teams.find(x=>x.id===teamId);
  if(t) t.alliance=(alliance===null||t.alliance===alliance)?null:alliance;
  renderSetup(); if(typeof renderBattleStrategy==='function') renderBattleStrategy();
  syncQueuePush();
}
function updateAllianceNames(){
  const gn=document.getElementById('garrisonAllianceName').value;
  const an=document.getElementById('attackAllianceName').value;
  ['garrisonName','attackName'].forEach((id,i)=>{
    const el=document.getElementById(id); if(el) el.textContent=(i===0?gn:an)?'('+(i===0?gn:an)+')':'';
  });
  const gTitle=document.getElementById('bsGarrisonTitle');
  const aTitle=document.getElementById('bsAttackTitle');
  if(gTitle) gTitle.textContent=gn||'Garrison Alliance';
  if(aTitle) aTitle.textContent=an||'Attacking Alliance';
  syncQueuePush();
}

let dragTeamId=null;
function onTeamDragStart(e,teamId){ dragTeamId=teamId; e.dataTransfer.effectAllowed='move'; e.currentTarget.style.opacity='0.5'; }
function onTeamDragEnd(e){ e.currentTarget.style.opacity='1'; dragTeamId=null; }
function onDropZone(e,alliance){
  e.preventDefault();
  document.querySelectorAll('.drop-zone').forEach(z=>z.classList.remove('drag-over'));
  if(!dragTeamId) return;
  const t=S.teams.find(x=>x.id===dragTeamId);
  if(t){ t.alliance=alliance; renderSetup(); if(typeof renderBattleStrategy==='function') renderBattleStrategy(); toast(\`Team moved to \${alliance==='garrison'?'Garrison':'Attacking'}\`); syncQueuePush(); }
}
function onDropZoneUnassign(e){
  e.preventDefault();
  document.querySelectorAll('.drop-zone').forEach(z=>z.classList.remove('drag-over'));
  if(!dragTeamId) return;
  const t=S.teams.find(x=>x.id===dragTeamId);
  if(t){ t.alliance=null; renderSetup(); if(typeof renderBattleStrategy==='function') renderBattleStrategy(); toast('Team unassigned'); syncQueuePush(); }
}
function onDragOver(e){ e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function onDragLeave(e){ e.currentTarget.classList.remove('drag-over'); }

function renderSetup(){
  const gList=document.getElementById('garrisonTeamList');
  const aList=document.getElementById('attackTeamList');
  const tList=document.getElementById('teamsList');
  if(!tList) return;

  // drop zones in the alliance cards
  function dropZoneHTML(alliance, teams){
    const inner=teams.length?teams.map(t=>draggableTeamCard(t)).join(''):'<div style="color:var(--text3);font-size:12px;padding:8px 0">Drop a team here or use buttons below.</div>';
    return \`<div class="drop-zone" 
      ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDropZone(event,'\${alliance}')"
      style="min-height:60px;border:2px dashed var(--border);border-radius:6px;padding:8px;transition:border-color .15s">
      \${inner}
    </div>\`;
  }
  const gTeams=S.teams.filter(t=>t.alliance==='garrison');
  const aTeams=S.teams.filter(t=>t.alliance==='attack');
  if(gList) gList.innerHTML=dropZoneHTML('garrison',gTeams);
  if(aList) aList.innerHTML=dropZoneHTML('attack',aTeams);

  if(!S.teams.length){tList.innerHTML='<div style="color:var(--text3);font-size:13px">No teams created yet.</div>';return;}

  // unassigned drop zone
  const unassigned=S.teams.filter(t=>!t.alliance);
  tList.innerHTML=\`
    <div style="font-size:11px;color:var(--text3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px">
      💡 Drag teams into the alliance boxes above, or use the buttons
    </div>
    \${S.teams.map(t=>{
      const leaders=S.leaders.filter(l=>l.teamId===t.id);
      const allianceTag=t.alliance
        ?\`<span class="badge" style="\${t.alliance==='garrison'?'background:rgba(42,127,255,.18);color:#6ab0ff;border:1px solid rgba(42,127,255,.35)':'background:rgba(46,204,113,.12);color:#5ddb8a;border:1px solid rgba(46,204,113,.3)'}">\${t.alliance==='garrison'?'🏰 Garrison':'⚔️ Attacking'}</span>\`
        :'<span style="color:var(--text3);font-size:12px">Unassigned</span>';
      return \`<div class="team-mgmt" draggable="true"
        ondragstart="onTeamDragStart(event,'\${t.id}')" ondragend="onTeamDragEnd(event)"
        style="cursor:grab;background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:12px 14px;margin-bottom:10px;transition:border-color .15s">
        <div class="team-row" style="border:none;padding:0 0 8px 0">
          <span style="font-size:16px;margin-right:8px;color:var(--text3)">⠿</span>
          <strong style="font-size:14px;flex:1">\${t.name}</strong>
          \${allianceTag}
          <button class="btn btn-garrison btn-sm" onclick="assignTeam('\${t.id}','garrison')">🏰 Garrison</button>
          <button class="btn btn-attack btn-sm" onclick="assignTeam('\${t.id}','attack')">⚔️ Attack</button>
          \${t.alliance?\`<button class="btn btn-ghost btn-sm" onclick="assignTeam('\${t.id}',null)">✕ Remove</button>\`:''}
          <button class="btn btn-danger btn-sm" onclick="removeTeam('\${t.id}')">🗑</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          \${leaders.length
            ?leaders.map(l=>\`<span style="background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:3px 9px;font-size:12px"><span class="badge badge-\${l.tier.toLowerCase()}" style="margin-right:4px">\${l.tier}</span>\${l.name} <span style="color:var(--text3);font-family:var(--mono);font-size:10px">\${l.march}s</span></span>\`).join('')
            :'<span style="color:var(--text3);font-size:12px">No leaders — assign in Rally Coordinator</span>'}
        </div>
      </div>\`;
    }).join('')}\`;
}
function draggableTeamCard(t){
  const leaders=S.leaders.filter(l=>l.teamId===t.id);
  return \`<div draggable="true" ondragstart="onTeamDragStart(event,'\${t.id}')" ondragend="onTeamDragEnd(event)"
    style="background:var(--bg3);border:1px solid var(--border);border-radius:5px;padding:7px 10px;margin-bottom:5px;cursor:grab;display:flex;align-items:center;gap:8px">
    <span style="color:var(--text3);font-size:14px">⠿</span>
    <div style="flex:1">
      <div style="font-weight:600;font-size:13px">\${t.name}</div>
      <div style="font-size:11px;color:var(--text3);margin-top:2px">\${leaders.map(l=>l.name).join(', ')||'No leaders'}</div>
    </div>
  </div>\`;
}
renderSetup();

// ════════════ PET BUFFS ════════════
const PET_DUR = 2.5 * 3600 * 1000; // 2.5h in ms
const WARN_MS = 15 * 60 * 1000;    // warn at 15 min left

function renderPetGrid(){
  const grid=document.getElementById('petGrid'); if(!grid) return;
  if(!S.leaders.length){
    grid.innerHTML='<div style="color:var(--text3);font-size:13px">No leaders added yet. Add leaders in Rally Coordinator.</div>';
    return;
  }
  // init pet state if missing
  S.leaders.forEach(l=>{ if(!l.pet) l.pet={active:false,startMs:null}; });
  grid.innerHTML=S.leaders.map(l=>{
    const p=l.pet;
    const now=Date.now();
    let cardCls='',timerTxt='—',timerCls='idle',btnTxt='▶ Activate',btnCls='off';
    if(p.active && p.startMs){
      const elapsed=now-p.startMs;
      const rem=PET_DUR-elapsed;
      if(rem<=0){
        p.active=false; p.startMs=null;
        cardCls='expired'; timerTxt='EXPIRED'; timerCls='expired'; btnTxt='▶ Activate'; btnCls='off';
      } else {
        const s=Math.ceil(rem/1000);
        timerTxt=fmtSec(s);
        if(rem<=WARN_MS){ cardCls='expiring'; timerCls='expiring'; }
        else { cardCls='active'; timerCls='active'; }
        btnTxt='■ Stop'; btnCls='on';
      }
    }
    return \`<div class="pet-card \${cardCls}" id="petcard-\${l.id}">
      <div class="pet-name">\${l.name}</div>
      <div class="pet-tier"><span class="badge badge-\${l.tier.toLowerCase()}">\${l.tier}</span></div>
      <div class="pet-timer \${timerCls}" id="pettimer-\${l.id}">\${timerTxt}</div>
      <button class="pet-toggle \${btnCls}" onclick="petToggle('\${l.id}')">\${btnTxt}</button>
    </div>\`;
  }).join('');
}

function petToggle(leaderId){
  const l=S.leaders.find(x=>x.id===leaderId); if(!l) return;
  if(!l.pet) l.pet={active:false,startMs:null};
  if(l.pet.active){ l.pet.active=false; l.pet.startMs=null; }
  else { l.pet.active=true; l.pet.startMs=Date.now(); }
  renderPetGrid();
  syncQueuePush();
}

function petActivateAll(){
  S.leaders.forEach(l=>{ if(!l.pet) l.pet={active:false,startMs:null}; l.pet.active=true; l.pet.startMs=Date.now(); });
  renderPetGrid();
  syncQueuePush();
}
function petResetAll(){
  S.leaders.forEach(l=>{ if(l.pet){ l.pet.active=false; l.pet.startMs=null; } });
  renderPetGrid();
  syncQueuePush();
}

function tickPets(){
  if(!S.leaders.length) return;
  const now=Date.now();
  S.leaders.forEach(l=>{
    if(!l.pet||!l.pet.active||!l.pet.startMs) return;
    const rem=PET_DUR-(now-l.pet.startMs);
    const timerEl=document.getElementById('pettimer-'+l.id);
    const cardEl=document.getElementById('petcard-'+l.id);
    const btnEl=cardEl?cardEl.querySelector('.pet-toggle'):null;
    if(!timerEl) return;
    if(rem<=0){
      l.pet.active=false; l.pet.startMs=null;
      timerEl.textContent='EXPIRED'; timerEl.className='pet-timer expired';
      if(cardEl){ cardEl.className='pet-card expired'; }
      if(btnEl){ btnEl.textContent='▶ Activate'; btnEl.className='pet-toggle off'; }
    } else {
      timerEl.textContent=fmtSec(Math.ceil(rem/1000));
      const expiring=rem<=WARN_MS;
      timerEl.className='pet-timer '+(expiring?'expiring':'active');
      if(cardEl) cardEl.className='pet-card '+(expiring?'expiring':'active');
    }
  });
}
setInterval(tickPets, 1000);
renderPetGrid();

// ════════════ BATTLE STRATEGY ════════════
const BS_TURRETS = [{name:'Turret 1'},{name:'Turret 2'},{name:'Turret 3'},{name:'Turret 4'}];
// assignment state per leader: {slotType:'pool'|'turret'|'team', slotId: turretIndex|teamId|null}
function bsGetAssignment(leaderId){
  const l=S.leaders.find(x=>x.id===leaderId);
  if(!l) return {slotType:'pool',slotId:null};
  if(!l.bsSlot) l.bsSlot={slotType:'pool',slotId:null};
  return l.bsSlot;
}

function bsLeaderCardHTML(l){
  const pet=l.pet&&l.pet.active;
  const team=S.teams.find(t=>t.id===l.teamId);
  return \`<div class="bs-leader-card" draggable="true" id="bsleader-\${l.id}"
    ondragstart="bsOnDragStart(event,'\${l.id}')" ondragend="bsOnDragEnd(event)">
    <div class="bs-leader-name">\${l.name} <span class="badge badge-\${l.tier.toLowerCase()}" style="margin-left:3px">\${l.tier}</span></div>
    <div class="bs-leader-meta">\${team?team.name:'No team'} · \${l.march}s march</div>
    <div class="bs-pet-bar" style="cursor:pointer" onclick="bsTogglePet(event,'\${l.id}')" title="Click to toggle pet buff"><div class="bs-pet-bar-fill \${pet?'on':'off'}" style="width:100%"></div></div>
    <div class="bs-pet-label \${pet?'on':'off'}" style="cursor:pointer" onclick="bsTogglePet(event,'\${l.id}')">\${pet?'PET ACTIVE':'NO PET — CLICK'}</div>
  </div>\`;
}

function bsTogglePet(e,leaderId){
  e.stopPropagation();
  petToggle(leaderId);
  renderBattleStrategy();
}

let bsDragLeaderId=null;
function bsOnDragStart(e,leaderId){
  bsDragLeaderId=leaderId;
  e.dataTransfer.effectAllowed='move';
  const el=document.getElementById('bsleader-'+leaderId);
  if(el) el.classList.add('dragging');
}
function bsOnDragEnd(e){
  const el=bsDragLeaderId?document.getElementById('bsleader-'+bsDragLeaderId):null;
  if(el) el.classList.remove('dragging');
  bsDragLeaderId=null;
  document.querySelectorAll('.bs-slot,.bs-team-zone,#bsLeaderPool').forEach(z=>z.classList.remove('drag-over'));
}
function bsOnDragOver(e){ e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function bsOnDragLeave(e){ e.currentTarget.classList.remove('drag-over'); }
function bsOnDrop(e,slotType,slotId){
  e.preventDefault();
  document.querySelectorAll('.bs-slot,.bs-team-zone,#bsLeaderPool').forEach(z=>z.classList.remove('drag-over'));
  if(!bsDragLeaderId) return;
  const l=S.leaders.find(x=>x.id===bsDragLeaderId); if(!l) return;

  // if dropping onto a turret slot that's already occupied by someone else, swap them to pool
  if(slotType==='turret'){
    const occupant=S.leaders.find(x=>x.bsSlot&&x.bsSlot.slotType==='turret'&&x.bsSlot.slotId===slotId&&x.id!==l.id);
    if(occupant) occupant.bsSlot={slotType:'pool',slotId:null};
  }

  l.bsSlot={slotType,slotId};
  renderBattleStrategy();
  syncQueuePush();
}

// ── TEAM BOX DRAG (move whole team between alliances) ──
let bsDragTeamId=null;
function bsTeamDragStart(e,teamId){
  e.stopPropagation();
  bsDragTeamId=teamId;
  e.dataTransfer.effectAllowed='move';
  const el=document.getElementById('bsteam-'+teamId);
  if(el) el.style.opacity='0.4';
}
function bsTeamDragEnd(e){
  const el=bsDragTeamId?document.getElementById('bsteam-'+bsDragTeamId):null;
  if(el) el.style.opacity='1';
  bsDragTeamId=null;
  document.querySelectorAll('.bs-alliance-zone,#bsUnassignedZone').forEach(z=>z.classList.remove('drag-over'));
}
function bsAllianceDragOver(e){
  e.preventDefault(); e.stopPropagation();
  if(bsDragTeamId) e.currentTarget.classList.add('drag-over');
}
function bsAllianceDragLeave(e){ e.currentTarget.classList.remove('drag-over'); }
function bsAllianceDrop(e,alliance){
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.bs-alliance-zone,#bsUnassignedZone').forEach(z=>z.classList.remove('drag-over'));
  if(!bsDragTeamId) return;
  const t=S.teams.find(x=>x.id===bsDragTeamId); if(!t) return;
  t.alliance=alliance;
  renderBattleStrategy(); renderSetup();
  toast(\`\${t.name} moved to \${alliance==='garrison'?'Garrison':alliance==='attack'?'Attacking':'Unassigned'}\`);
  syncQueuePush();
}

// ── AUTO-SCROLL WHILE DRAGGING ──
let bsAutoScrollRAF=null;
function bsAutoScroll(e){
  const margin=90, speed=14;
  const y=e.clientY;
  const h=window.innerHeight;
  if(y<margin) window.scrollBy(0,-speed);
  else if(y>h-margin) window.scrollBy(0,speed);
}
document.addEventListener('dragover',bsAutoScroll);

function renderBattleStrategy(){
  // init bsSlot
  S.leaders.forEach(l=>{ if(!l.bsSlot) l.bsSlot={slotType:'pool',slotId:null}; });

  // ── ALLIANCE NAMES (from Team Setup) ──
  const gNameInput=document.getElementById('garrisonAllianceName');
  const aNameInput=document.getElementById('attackAllianceName');
  const gTitle=document.getElementById('bsGarrisonTitle');
  const aTitle=document.getElementById('bsAttackTitle');
  if(gTitle) gTitle.textContent=(gNameInput&&gNameInput.value)?gNameInput.value:'Garrison Alliance';
  if(aTitle) aTitle.textContent=(aNameInput&&aNameInput.value)?aNameInput.value:'Attacking Alliance';

  // ── TURRETS ──
  const turretGrid=document.getElementById('bsTurretGrid');
  if(turretGrid){
    turretGrid.innerHTML=BS_TURRETS.map((t,i)=>{
      const occupant=S.leaders.find(l=>l.bsSlot.slotType==='turret'&&l.bsSlot.slotId===i);
      return \`<div>
        <div class="bs-slot-label">🗼 \${t.name}</div>
        <div class="bs-slot" ondragover="bsOnDragOver(event)" ondragleave="bsOnDragLeave(event)" ondrop="bsOnDrop(event,'turret',\${i})">
          \${occupant?bsLeaderCardHTML(occupant):'<div style="color:var(--text3);font-size:12px;text-align:center;padding:14px 0">Drop leader here</div>'}
        </div>
      </div>\`;
    }).join('');
  }

  // ── TEAMS (draggable boxes, grouped by alliance) ──
  const garZone=document.getElementById('bsGarrisonZone');
  const atkZone=document.getElementById('bsAttackZone');
  const unassignedZone=document.getElementById('bsUnassignedZone');

  function teamBoxHTML(t){
    const occupants=S.leaders.filter(l=>l.bsSlot.slotType==='team'&&l.bsSlot.slotId===t.id);
    return \`<div class="bs-team-box" draggable="true" id="bsteam-\${t.id}"
      ondragstart="bsTeamDragStart(event,'\${t.id}')" ondragend="bsTeamDragEnd(event)"
      style="background:var(--bg3);border:1.5px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px;cursor:grab">
      <div class="bs-team-header" style="display:flex;align-items:center;gap:6px"><span style="color:var(--text3);font-size:13px">⠿</span>\${t.name}</div>
      <div class="bs-team-zone" ondragover="bsOnDragOver(event)" ondragleave="bsOnDragLeave(event)" ondrop="bsOnDrop(event,'team','\${t.id}')">
        \${occupants.length?occupants.map(o=>bsLeaderCardHTML(o)).join(''):'<div style="color:var(--text3);font-size:12px;padding:8px">Drop leaders here</div>'}
      </div>
    </div>\`;
  }

  const garTeams=S.teams.filter(t=>t.alliance==='garrison');
  const atkTeams=S.teams.filter(t=>t.alliance==='attack');
  const unTeams=S.teams.filter(t=>!t.alliance);

  if(garZone) garZone.innerHTML=garTeams.length?garTeams.map(teamBoxHTML).join(''):'<div style="color:var(--text3);font-size:12px">Drag a team here.</div>';
  if(atkZone) atkZone.innerHTML=atkTeams.length?atkTeams.map(teamBoxHTML).join(''):'<div style="color:var(--text3);font-size:12px">Drag a team here.</div>';
  if(unassignedZone) unassignedZone.innerHTML=unTeams.length?unTeams.map(teamBoxHTML).join(''):'<div style="color:var(--text3);font-size:12px">No unassigned teams.</div>';

  // ── POOL (unassigned leaders) ──
  const poolEl=document.getElementById('bsLeaderPool');
  if(poolEl){
    const poolLeaders=S.leaders.filter(l=>l.bsSlot.slotType==='pool');
    poolEl.innerHTML=poolLeaders.length?poolLeaders.map(l=>bsLeaderCardHTML(l)).join(''):'<div style="color:var(--text3);font-size:12px">All leaders assigned. Drag a card here to unassign.</div>';
  }

  bsRenderTeamButtons();
}
renderBattleStrategy();

// ════════════ BATTLE STRATEGY — SHARED SETUP & FINAL CALCULATION ════════════
const BS_CALC = { offsetSec: null, selectedTeamId: null };

function bsTickClock(){
  const hh=document.getElementById('bsClockHH');
  if(!hh) return;
  const n=new Date();
  document.getElementById('bsClockHH').textContent=String(n.getUTCHours()).padStart(2,'0');
  document.getElementById('bsClockMM').textContent=String(n.getUTCMinutes()).padStart(2,'0');
  document.getElementById('bsClockSS').textContent=String(n.getUTCSeconds()).padStart(2,'0');
}
setInterval(bsTickClock,1000); bsTickClock();

function bsSetOffset(sec){
  BS_CALC.offsetSec=sec;
  // highlight selected offset button
  document.querySelectorAll('#page-strategy .btn-gold').forEach(b=>b.style.outline='');
  if(event&&event.currentTarget) event.currentTarget.style.outline='2px solid var(--gold)';
  if(BS_CALC.selectedTeamId!==null) bsCalcTeam(BS_CALC.selectedTeamId, sec, true);
  else toast(\`Offset set to +\${sec<60?sec+'s':Math.floor(sec/60)+'m'} — now click a team\`);
}

function bsRenderTeamButtons(){
  const el=document.getElementById('bsTeamButtons'); if(!el) return;
  if(!S.teams.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px">No teams created yet. Add teams in Team Setup.</div>';
    return;
  }
  el.innerHTML=S.teams.map(t=>{
    const allianceColor=t.alliance==='garrison'?'btn-garrison':t.alliance==='attack'?'btn-attack':'btn-ghost';
    const selected=BS_CALC.selectedTeamId===t.id?'outline:2px solid var(--accent2)':'';
    const leaderCount=S.leaders.filter(l=>l.bsSlot&&l.bsSlot.slotType==='team'&&l.bsSlot.slotId===t.id).length;
    return \`<button class="btn \${allianceColor}" style="\${selected}" onclick="bsSelectTeam('\${t.id}')">\${t.name} <span style="opacity:.6;font-size:11px">(\${leaderCount})</span></button>\`;
  }).join('');
}

function bsSelectTeam(teamId){
  BS_CALC.selectedTeamId=teamId;
  bsRenderTeamButtons();
  if(BS_CALC.offsetSec!==null) bsCalcTeam(teamId, BS_CALC.offsetSec, true);
  else {
    document.getElementById('bsFinalResult').innerHTML='<div style="color:var(--text3);font-size:13px">Now click an offset button above (+30s, +1m, etc).</div>';
  }
}

function bsCalcTeam(teamId, offsetSec, logToast){
  const t=S.teams.find(x=>x.id===teamId); if(!t) return;
  const dur=parseInt(document.getElementById('bsDur').value)||300;
  const leaders=S.leaders.filter(l=>l.bsSlot&&l.bsSlot.slotType==='team'&&l.bsSlot.slotId===teamId).sort((a,b)=>a.march-b.march);
  if(!leaders.length){
    document.getElementById('bsFinalResult').innerHTML='<div style="color:var(--text3);font-size:13px">This team has no leaders dropped into it yet — drag leaders into the team box above.</div>';
    return;
  }
  // The offset defines the shared LAND time. Each leader's launch time = land time - rally duration - march time.
  // Leaders with a longer march must launch earlier so everyone lands together.
  const landSec=nowUTCSec()+offsetSec;
  const results=leaders.map(l=>({name:l.name,march:l.march,launchSec:landSec-dur-l.march,landSec})).sort((a,b)=>a.launchSec-b.launchSec);

  const header=\`Rally Arrival Time: \${dur===300?'5 min':'10 min'} | Land Time (UTC): \${s2hms(landSec)}\`;
  const resultEl=document.getElementById('bsFinalResult');
  resultEl.innerHTML=\`<div style="background:var(--bg4);border:1px solid var(--border);border-radius:6px;padding:14px 16px">
    <div style="font-weight:600;font-size:13px;color:var(--text);margin-bottom:10px">\${header}</div>
    \${results.map((r,i)=>\`
      <div class="copy-line" style="margin-bottom:5px" onclick="copyText('\${r.name} | Time: \${s2hms(r.launchSec)}')">
        <span>
          <strong style="color:var(--text)">\${r.name}</strong>
          <span style="color:var(--text3);margin:0 8px">|</span>
          <span style="font-size:12px;color:var(--text2)">Time:</span>
          <span class="mono" style="color:var(--gold);font-size:16px;margin-left:6px">\${s2hms(r.launchSec)}</span>
          <span style="color:var(--text3);font-size:11px;margin-left:8px">(march \${r.march}s)</span>
        </span>
        <span style="font-size:10px;color:var(--text3)">click to copy</span>
      </div>\`).join('')}
  </div>
  <button class="btn btn-gold" style="margin-top:10px" onclick="bsCopyTeamResult('\${t.id}')">📋 Copy for in-game chat</button>\`;

  t._bsLastCalc={header,results,dur,landSec};
  if(logToast) toast(\`\${t.name} — rally times calculated!\`);
}

function bsCopyTeamResult(teamId){
  const t=S.teams.find(x=>x.id===teamId);
  if(!t||!t._bsLastCalc){ toast('Calculate a team first!'); return; }
  const {results}=t._bsLastCalc;
  const lines=[t.name, ...results.map(r=>\`\${r.name} | Time: \${s2hms(r.launchSec)}\`)];
  copyText(lines.join('\\n'));
  toast('Copied in-game format!');
}

// ════════════ MINISTER SPOTS ════════════
const MS_CATEGORIES = ['construction','research','training','general'];
const MS_CATEGORY_LABELS = {construction:'Construction',research:'Research',training:'Training (Troop)',general:'General'};
const MS_TOTAL_SLOTS = 48;
const MS_MIN_SLOTS_PICKED = 4;
const MS_POSITION_ID = 'noble_advisor_day4';
const MS_RANK_CATEGORY = 'training'; // Noble Advisor ranks by Training hours only

const MS_UNIT_TO_HOURS = { seconds:1/3600, minutes:1/60, hours:1, days:24 };

function msSlotLabel(i){
  const totalMin=i*30;
  const h=Math.floor(totalMin/60), m=totalMin%60;
  const h2=Math.floor((totalMin+30)/60)%24, m2=(totalMin+30)%60;
  return \`\${String(h).padStart(2,'0')}:\${String(m).padStart(2,'0')}-\${String(h2).padStart(2,'0')}:\${String(m2).padStart(2,'0')}\`;
}

function msInit(){
  if(MS._unlockedStep===undefined) MS._unlockedStep=1;
  msGoStep(MS._currentStep||1);
  msRenderVerifyGrid();
  msRenderSliderGrid();
  msRenderSlotGrid();
  msRenderResultsSummary();
  msRenderStepTabs();
}

function msMarkStepComplete(n){
  MS._unlockedStep=Math.max(MS._unlockedStep||1, n+1);
  msRenderStepTabs();
}

function msRenderStepTabs(){
  const unlocked=MS._unlockedStep||1;
  for(let i=1;i<=5;i++){
    const tab=document.getElementById('msStepTab'+i);
    if(!tab) continue;
    const isLocked=i>unlocked;
    tab.disabled=isLocked;
    tab.style.opacity=isLocked?'0.4':'1';
    tab.style.cursor=isLocked?'not-allowed':'pointer';
    tab.title=isLocked?'Complete the previous step first':'';
  }
}

function msGoStep(n){
  const unlocked=MS._unlockedStep||1;
  if(n>unlocked){
    toast('Please complete the previous step first.');
    n=unlocked;
  }
  MS._currentStep=n;
  for(let i=1;i<=5;i++){
    const el=document.getElementById('msStep'+i);
    const tab=document.getElementById('msStepTab'+i);
    if(el) el.style.display=(i===n)?'block':'none';
    if(tab) tab.classList.toggle('active', i===n);
  }
  if(n===2) msRenderVerifyGrid();
  if(n===3) msRenderSliderGrid();
  if(n===4) msRenderSlotGrid();
  if(n===5) msRenderResultsSummary();
  msRenderStepTabs();
}

// ── STEP 1: UPLOAD + OCR ──
let msUploadedImageData=null;
document.addEventListener('change',function(e){
  if(e.target && e.target.id==='msFileInput'){
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=function(ev){
      msUploadedImageData=ev.target.result;
      const img=document.getElementById('msImgPreview');
      const wrap=document.getElementById('msImgPreviewWrap');
      if(img&&wrap){ img.src=msUploadedImageData; wrap.style.display='block'; }
    };
    reader.readAsDataURL(file);
  }
});

function msValidateIdentity(){
  const alliance=document.getElementById('msAlliance').value.trim();
  const ign=document.getElementById('msIGN').value.trim();
  const errEl=document.getElementById('msIdentityError');
  const allianceInput=document.getElementById('msAlliance');
  const ignInput=document.getElementById('msIGN');
  if(!alliance||!ign){
    if(errEl) errEl.style.display='block';
    if(allianceInput) allianceInput.style.borderColor=alliance?'var(--border2)':'#ff7070';
    if(ignInput) ignInput.style.borderColor=ign?'var(--border2)':'#ff7070';
    return null;
  }
  if(errEl) errEl.style.display='none';
  if(allianceInput) allianceInput.style.borderColor='var(--border2)';
  if(ignInput) ignInput.style.borderColor='var(--border2)';
  return {alliance,ign};
}

async function msRunOCR(){
  const identity=msValidateIdentity();
  if(!identity) return;
  const {alliance,ign}=identity;
  if(!msUploadedImageData){ alert('Upload a screenshot first, or click "Skip — enter manually".'); return; }
  MS.draft.alliance=alliance; MS.draft.ign=ign;

  const statusEl=document.getElementById('msOCRStatus');
  const pctEl=document.getElementById('msOCRPct');
  const barEl=document.getElementById('msOCRBar');
  const wrapEl=document.getElementById('msOCRProgressWrap');
  const btnEl=document.getElementById('msScanBtn');

  wrapEl.style.display='block';
  statusEl.textContent='Starting…'; statusEl.style.color='var(--text2)';
  pctEl.textContent='0%'; barEl.style.width='0%';
  btnEl.disabled=true; btnEl.style.opacity='0.5'; btnEl.style.cursor='not-allowed';

  // If the OCR library failed to load from the CDN (blocked network, ad-blocker,
  // firewall, offline, etc.) tell the person clearly instead of a silent generic failure.
  if(typeof Tesseract==='undefined'){
    wrapEl.style.display='block';
    statusEl.textContent='⚠ OCR engine failed to load (network/CDN blocked) — please enter values manually below';
    statusEl.style.color='#ff7070';
    pctEl.textContent=''; barEl.style.width='100%'; barEl.style.background='var(--enemy)';
    MS_CATEGORIES.forEach(c=>{ if(!MS.draft.verify[c]) MS.draft.verify[c]={amount:0,unit:'hours',hours:0,ocrAmount:null,ocrRaw:null}; });
    msMarkStepComplete(1);
    msGoStep(2);
    return;
  }

  const stageLabels={
    'loading tesseract core':'Loading OCR engine…',
    'initializing tesseract':'Initializing…',
    'loading language traineddata':'Loading language data…',
    'initializing api':'Preparing scan…',
    'recognizing text':'Reading screenshot…'
  };

  try{
    // tesseract.js v4.1.1 API: createWorker takes a SINGLE options object
    // (the newer v5+ "createWorker(lang, oem, options)" 3-argument form is
    // NOT supported in v4.1.1 — passing it that way silently breaks worker
    // path resolution). After creating the worker, loadLanguage + initialize
    // must be called explicitly before recognize().
    const worker=await Tesseract.createWorker({
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/worker.min.js',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@4.0.4',
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      logger: m => {
        if(m.status){
          const label=stageLabels[m.status]||m.status;
          const pct=Math.round((m.progress||0)*100);
          statusEl.textContent=label;
          pctEl.textContent=pct+'%';
          barEl.style.width=pct+'%';
        }
      }
    });
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    // PSM 6 = "assume a single uniform block of text" — keeps each table row
    // (category name + duration) together on one line, which the default
    // auto-segmentation mode does NOT do for this in-game screen (it splits
    // the two columns into separate blocks read independently).
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const result=await worker.recognize(msUploadedImageData);
    await worker.terminate();
    const text=result.data.text||'';
    msParseOCRText(text);
    statusEl.textContent='✓ Scan complete — review the results on the next step';
    statusEl.style.color='var(--green)';
    pctEl.textContent='100%'; barEl.style.width='100%';
  }catch(err){
    console.error('OCR error:', err);
    statusEl.textContent='⚠ OCR failed: '+(err&&err.message?err.message:'unknown error')+' — please enter values manually on the next step';
    statusEl.style.color='#ff7070';
    barEl.style.background='var(--enemy)';
    MS_CATEGORIES.forEach(c=>{ if(!MS.draft.verify[c]) MS.draft.verify[c]={amount:0,unit:'hours',hours:0,ocrAmount:null,ocrRaw:null}; });
  }
  btnEl.disabled=false; btnEl.style.opacity='1'; btnEl.style.cursor='pointer';
  msMarkStepComplete(1);
  msGoStep(2);
}

function msSkipToManual(){
  const identity=msValidateIdentity();
  if(!identity) return;
  MS.draft.alliance=identity.alliance; MS.draft.ign=identity.ign;
  MS_CATEGORIES.forEach(c=>{ if(!MS.draft.verify[c]) MS.draft.verify[c]={amount:0,unit:'hours',hours:0,ocrAmount:null,ocrRaw:null}; });
  msMarkStepComplete(1);
  msGoStep(2);
}

function msParseOCRText(text){
  // The in-game "Overview: Resources & Speedups" screen is a 2-column table.
  // OCR (even with PSM 6) sometimes wraps a category name across 2-3 short lines
  // before the duration appears, e.g.:
  //   "Construction"
  //   "62 day(s) hr(s)58 min(s)"   <- note: "1" before hr(s) sometimes gets dropped by OCR
  //   "peedup"
  // So instead of only checking the same/next line, we scan a small window of
  // nearby lines for the first one that contains a parseable duration.
  const lines=text.split(/\\n+/).map(l=>l.trim()).filter(Boolean);
  const keywordMap={
    construction:['construction'],
    research:['research'],
    training:['training','soldier training','troop'],
    general:['general speedup','general']
  };
  const WINDOW=3; // how many lines forward (and the line itself) to search for a duration

  function parseDurationToHours(str){
    // Matches "<num> d(ay/s)", "<num> h(r/s)", "<num> m(in/s)", "<num> s(ec/s)" chunks.
    // The number is OPTIONAL before the unit word — OCR sometimes drops a single-digit
    // count (commonly "1") right before "hr(s)"/"min(s)". A bare unit with no number
    // is simply skipped (contributes 0), rather than killing the whole match.
    let totalHours=0, matchedAny=false;
    const re=/(\\d+(?:[.,]\\d+)?)?\\s*(day\\(s\\)|days|day|d\\b|hr\\(s\\)|hrs|hour|hours|h\\b|min\\(s\\)|mins|minute|minutes|m\\b|sec\\(s\\)|secs|second|seconds|s\\b)/gi;
    let m;
    while((m=re.exec(str))!==null){
      const hasNum=m[1]!==undefined && m[1]!=='';
      const num=hasNum?parseFloat(m[1].replace(',','.')):0;
      const unitRaw=m[2].toLowerCase();
      let hours=0;
      if(unitRaw.startsWith('d')) hours=num*24;
      else if(unitRaw.startsWith('h')) hours=num;
      else if(unitRaw.startsWith('m')) hours=num/60;
      else if(unitRaw.startsWith('s')) hours=num/3600;
      totalHours+=hours;
      if(hasNum) matchedAny=true; // only count as a real match if at least one chunk had a number
    }
    return matchedAny?totalHours:null;
  }

  MS_CATEGORIES.forEach(cat=>{
    let foundHours=null, foundRaw=null;
    for(let i=0;i<lines.length;i++){
      const lower=lines[i].toLowerCase();
      if(keywordMap[cat].some(k=>lower.includes(k))){
        for(let j=i;j<Math.min(i+1+WINDOW,lines.length);j++){
          const candidate=lines[j];
          const hours=parseDurationToHours(candidate);
          if(hours!==null && hours>0){ foundHours=hours; foundRaw=candidate; break; }
        }
        if(foundHours!==null) break;
      }
    }
    if(foundHours!==null){
      // Store the OCR result directly in hours (since the source string can mix days/hrs/min,
      // a single "amount+unit" pair doesn't represent it well — hours is the converted truth value).
      MS.draft.verify[cat]={amount:Math.round(foundHours*100)/100,unit:'hours',hours:foundHours,ocrAmount:Math.round(foundHours*100)/100,ocrRaw:foundRaw};
    } else {
      MS.draft.verify[cat]={amount:0,unit:'hours',hours:0,ocrAmount:null,ocrRaw:null};
    }
  });
}

// ── STEP 2: VERIFY ──
function msRenderVerifyGrid(){
  const grid=document.getElementById('msVerifyGrid'); if(!grid) return;
  MS_CATEGORIES.forEach(c=>{ if(!MS.draft.verify[c]) MS.draft.verify[c]={amount:0,unit:'hours',hours:0,ocrAmount:null,ocrRaw:null}; });
  grid.innerHTML=MS_CATEGORIES.map(cat=>{
    const v=MS.draft.verify[cat];
    const flagged=v.ocrAmount!==null && v.amount>0 && Math.abs(v.amount-v.ocrAmount)/Math.max(v.ocrAmount,1)>0.2;
    return \`<div class="ms-verify-field">
      <label>\${MS_CATEGORY_LABELS[cat]}</label>
      \${v.ocrRaw?\`<div style="font-size:11px;color:var(--text3);margin-bottom:6px">OCR read: "\${v.ocrRaw}" → \${v.ocrAmount}h</div>\`:v.ocrAmount===null&&v.hasOwnProperty('ocrRaw')?\`<div style="font-size:11px;color:#ff9d4d;margin-bottom:6px">⚠ Not detected — enter manually</div>\`:''}
      <div style="display:flex;gap:6px">
        <input type="number" min="0" step="0.1" value="\${v.amount}" style="width:90px" id="msVerifyAmt-\${cat}" oninput="msUpdateVerify('\${cat}')">
        <select id="msVerifyUnit-\${cat}" style="width:90px" onchange="msUpdateVerify('\${cat}')">
          <option value="seconds" \${v.unit==='seconds'?'selected':''}>Seconds</option>
          <option value="minutes" \${v.unit==='minutes'?'selected':''}>Minutes</option>
          <option value="hours" \${v.unit==='hours'?'selected':''}>Hours</option>
          <option value="days" \${v.unit==='days'?'selected':''}>Days</option>
        </select>
      </div>
      <div style="margin-top:6px;font-size:12px;color:var(--text2)">= <span class="mono" id="msVerifyHours-\${cat}" style="color:var(--gold)">\${v.hours.toFixed(1)}</span> hours</div>
      \${flagged?'<div style="color:#ff9d4d;font-size:11px;margin-top:4px">⚠ Differs from OCR by more than 20% — please double-check</div>':''}
    </div>\`;
  }).join('');
}
function msUpdateVerify(cat){
  const amt=parseFloat(document.getElementById('msVerifyAmt-'+cat).value)||0;
  const unit=document.getElementById('msVerifyUnit-'+cat).value;
  const hours=amt*MS_UNIT_TO_HOURS[unit];
  MS.draft.verify[cat]={...MS.draft.verify[cat],amount:amt,unit,hours};
  const hEl=document.getElementById('msVerifyHours-'+cat);
  if(hEl) hEl.textContent=hours.toFixed(1);
}

// ── STEP 3: COMMITMENT SLIDERS ──
function msRenderSliderGrid(){
  const grid=document.getElementById('msSliderGrid'); if(!grid) return;
  grid.innerHTML=MS_CATEGORIES.map(cat=>{
    const hours=MS.draft.verify[cat]?MS.draft.verify[cat].hours:0;
    const pct=MS.draft.commit[cat]!==undefined?MS.draft.commit[cat]:50;
    const committedHours=hours*pct/100;
    const committedDays=committedHours/24;
    return \`<div class="ms-slider-row">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <strong style="font-size:14px">\${MS_CATEGORY_LABELS[cat]}</strong>
        <span style="font-size:12px;color:var(--text3)">\${hours.toFixed(1)}h available</span>
      </div>
      <input type="range" min="0" max="100" value="\${pct}" id="msSlider-\${cat}" oninput="msUpdateSlider('\${cat}')">
      <div style="display:flex;justify-content:space-between;font-size:12px">
        <span class="mono" style="color:var(--accent2)" id="msSliderPct-\${cat}">\${pct}%</span>
        <span class="mono" style="color:var(--gold)" id="msSliderDays-\${cat}">\${committedDays.toFixed(1)} days (\${committedHours.toFixed(1)}h)</span>
      </div>
    </div>\`;
  }).join('');
}
function msUpdateSlider(cat){
  const pct=parseInt(document.getElementById('msSlider-'+cat).value);
  MS.draft.commit[cat]=pct;
  const hours=MS.draft.verify[cat]?MS.draft.verify[cat].hours:0;
  const committedHours=hours*pct/100;
  document.getElementById('msSliderPct-'+cat).textContent=pct+'%';
  document.getElementById('msSliderDays-'+cat).textContent=(committedHours/24).toFixed(1)+' days ('+committedHours.toFixed(1)+'h)';
}

// ── STEP 4: TIMESLOTS ──
function msRenderSlotGrid(){
  const grid=document.getElementById('msSlotGrid'); if(!grid) return;
  const takenSlots=new Set(MS._lastAllocation?MS._lastAllocation.assignments.map(a=>a.slot):[]);
  grid.innerHTML=Array.from({length:MS_TOTAL_SLOTS},(_,i)=>{
    const selected=MS.draft.picks.includes(i);
    const taken=takenSlots.has(i)&&!selected;
    return \`<button class="ms-slot-btn \${selected?'selected':''} \${taken?'taken':''}" onclick="\${taken?'':'msTogglePick('+i+')'}" title="\${taken?'Already allocated':''}">\${msSlotLabel(i)}</button>\`;
  }).join('');
  msUpdateSlotCount();
  const trainingHours=(MS.draft.verify.training?MS.draft.verify.training.hours:0)*((MS.draft.commit.training!==undefined?MS.draft.commit.training:50)/100);
  const elH=document.getElementById('msYourTrainingHours'); if(elH) elH.textContent=trainingHours.toFixed(1)+'h';
}
function msTogglePick(i){
  const idx=MS.draft.picks.indexOf(i);
  if(idx>=0) MS.draft.picks.splice(idx,1);
  else MS.draft.picks.push(i);
  msRenderSlotGrid();
}
function msUpdateSlotCount(){
  const el=document.getElementById('msSlotPickCount'); if(!el) return;
  const n=MS.draft.picks.length;
  el.textContent=\`\${n} slot\${n===1?'':'s'} selected \${n<MS_MIN_SLOTS_PICKED?\`(need at least \${MS_MIN_SLOTS_PICKED})\`:'✓'}\`;
  el.style.color=n<MS_MIN_SLOTS_PICKED?'#ff9d4d':'var(--green)';
}

function msSubmitEntry(){
  if(MS.draft.picks.length<MS_MIN_SLOTS_PICKED){ alert(\`Please select at least \${MS_MIN_SLOTS_PICKED} timeslots.\`); return; }
  const committedHours={};
  MS_CATEGORIES.forEach(cat=>{
    const hours=MS.draft.verify[cat]?MS.draft.verify[cat].hours:0;
    const pct=MS.draft.commit[cat]!==undefined?MS.draft.commit[cat]:50;
    committedHours[cat]=hours*pct/100;
  });
  const entry={
    id: uid(),
    alliance: MS.draft.alliance,
    ign: MS.draft.ign,
    verify: JSON.parse(JSON.stringify(MS.draft.verify)),
    commit: JSON.parse(JSON.stringify(MS.draft.commit)),
    picks: [...MS.draft.picks],
    committedHours
  };
  // replace existing entry for same person if resubmitting
  MS.submissions=MS.submissions.filter(s=>!(s.alliance===entry.alliance && s.ign===entry.ign));
  MS.submissions.push(entry);
  syncQueuePush();
  toast('Entry submitted!');

  // reset draft
  MS.draft={alliance:'',ign:'',verify:{},commit:{},picks:[]};
  document.getElementById('msAlliance').value='';
  document.getElementById('msIGN').value='';
  msUploadedImageData=null;
  const wrap=document.getElementById('msImgPreviewWrap'); if(wrap) wrap.style.display='none';
  const fileInput=document.getElementById('msFileInput'); if(fileInput) fileInput.value='';
  // also clear the OCR progress bar for the next person's entry
  const progWrap=document.getElementById('msOCRProgressWrap'); if(progWrap) progWrap.style.display='none';
  MS._unlockedStep=5; // allow viewing results
  msGoStep(5);
  // reset back to step 1 lock state for the NEXT person's submission, but keep step 5 (results) viewable
  MS._unlockedStep=1;
}

// ── STEP 5: ALLOCATION ──
function msRenderResultsSummary(){
  document.getElementById('msTotalSubs').textContent=MS.submissions.length;
  document.getElementById('msWinnerCount').textContent=(MS._lastAllocation?MS._lastAllocation.winners.length:0);
  document.getElementById('msRejectedCount').textContent=(MS._lastAllocation?MS._lastAllocation.rejected.length:0);
}

function msRunAllocation(){
  if(!MS.submissions.length){ toast('No submissions yet.'); return; }
  // Rank by committed Training hours, descending
  const ranked=[...MS.submissions].sort((a,b)=>b.committedHours[MS_RANK_CATEGORY]-a.committedHours[MS_RANK_CATEGORY]);
  const winners=ranked.slice(0,MS_TOTAL_SLOTS);
  const rejected=ranked.slice(MS_TOTAL_SLOTS);

  // Draft-style slot assignment: highest hours picks first from their preferred slots
  const takenSlots=new Set();
  const assignments=[]; // {entry, slot}
  const unassigned=[];
  winners.forEach(entry=>{
    const pick=entry.picks.find(s=>!takenSlots.has(s));
    if(pick!==undefined){
      takenSlots.add(pick);
      assignments.push({entry,slot:pick});
    } else {
      unassigned.push(entry); // all their preferred slots got taken by higher-priority people
    }
  });
  // For anyone who lost all their preferred slots, give them any remaining open slot (still ranked top-48 overall)
  unassigned.forEach(entry=>{
    for(let i=0;i<MS_TOTAL_SLOTS;i++){
      if(!takenSlots.has(i)){ takenSlots.add(i); assignments.push({entry,slot:i,fallback:true}); break; }
    }
  });
  assignments.sort((a,b)=>a.slot-b.slot);

  MS._lastAllocation={winners,rejected,assignments};
  msRenderResultsSummary();
  msRenderFinalSchedule();
  msRenderRejectedList();
  syncQueuePush();
  toast('Allocation complete!');
}

function msRenderFinalSchedule(){
  const el=document.getElementById('msFinalSchedule'); if(!el) return;
  if(!MS._lastAllocation || !MS._lastAllocation.assignments.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px">Run allocation to generate the schedule.</div>';
    return;
  }
  el.innerHTML=MS._lastAllocation.assignments.map(a=>\`
    <div class="ms-rank-row winner">
      <span class="ms-rank-num mono">\${msSlotLabel(a.slot)}</span>
      <strong>\${a.entry.ign}</strong>
      <span style="color:var(--text3);font-size:12px">\${a.entry.alliance}</span>
      <span style="margin-left:auto" class="mono" style="color:var(--gold)">\${a.entry.committedHours[MS_RANK_CATEGORY].toFixed(1)}h training</span>
      \${a.fallback?'<span style="font-size:10px;color:#ff9d4d;margin-left:8px">(backup slot)</span>':''}
    </div>\`).join('');
}
function msRenderRejectedList(){
  const el=document.getElementById('msRejectedList'); if(!el) return;
  if(!MS._lastAllocation || !MS._lastAllocation.rejected.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px">—</div>';
    return;
  }
  el.innerHTML=MS._lastAllocation.rejected.map((entry,i)=>\`
    <div class="ms-rank-row rejected">
      <span class="ms-rank-num mono">#\${MS_TOTAL_SLOTS+i+1}</span>
      <strong>\${entry.ign}</strong>
      <span style="color:var(--text3);font-size:12px">\${entry.alliance}</span>
      <span style="margin-left:auto" class="mono">\${entry.committedHours[MS_RANK_CATEGORY].toFixed(1)}h training</span>
    </div>\`).join('');
}
function msCopySchedule(){
  if(!MS._lastAllocation || !MS._lastAllocation.assignments.length){ toast('Run allocation first!'); return; }
  const lines=['=== Noble Advisor — Day 4 Schedule ===',
    ...MS._lastAllocation.assignments.map(a=>\`\${msSlotLabel(a.slot)} | \${a.entry.ign} (\${a.entry.alliance})\`)];
  copyText(lines.join('\\n'));
  toast('Schedule copied!');
}
function msClearAllSubs(){
  if(!confirm('Clear all Minister Spots submissions? This cannot be undone.')) return;
  MS.submissions=[];
  MS._lastAllocation=null;
  msRenderResultsSummary();
  msRenderFinalSchedule();
  msRenderRejectedList();
  syncQueuePush();
}
</script>
</body>
</html>
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/state" && request.method === "GET") {
      const raw = await env.SVS_KV.get(STATE_KEY);
      return new Response(raw || "{}", {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    if (url.pathname === "/state" && request.method === "PUT") {
      const body = await request.text();
      try {
        JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }
      await env.SVS_KV.put(STATE_KEY, body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    if (request.method === "GET") {
      return new Response(SITE_HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8", ...corsHeaders() },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
