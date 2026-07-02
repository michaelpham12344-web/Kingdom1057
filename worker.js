/**
 * Kingdom 1057 Worker
 * Routes:
 *   GET  /                    → serve website
 *   GET  /state               → read shared KV state
 *   PUT  /state               → write shared KV state
 *   GET  /kingshot-player?id= → proxy to kingshot.net/api/player-info
 *   POST /register-player     → store a verified player ID in KV
 *   POST /admin-redeem        → manually trigger gift code redemption (admin)
 *   GET  /gift-log            → return redemption log from KV
 *   Cron every 30 min         → batched auto-redeem (5 players per run)
 */

const KINGSHOT_API  = "https://kingshot.net/api";
const GIFTCODE_API  = "https://ks-giftcode.centurygame.com/api";
const SALT          = "tB87#kPtkxqOS2";
const BATCH_SIZE    = 5;   // players per cron run — keeps well under 30s CPU limit

const STATE_KEY     = "svs_state";
const PLAYERS_KEY   = "registered_players";  // { [id]: {id, name, kingdom} }
const REDEEMED_KEY  = "redeemed_codes";       // ["playerId:code", ...]
const GIFT_LOG_KEY  = "gift_log";             // last 30 run entries
const QUEUE_KEY     = "redeem_queue";         // { codes: [...], playerIds: [...], pos: N, date: "YYYY-MM-DD" }

// ── Pure-JS MD5 (no crypto API needed in CF Workers) ──
function md5(str) {
  function safeAdd(x,y){const l=(x&0xffff)+(y&0xffff);return(((x>>16)+(y>>16)+(l>>16))<<16)|(l&0xffff);}
  function rol(n,c){return(n<<c)|(n>>>(32-c));}
  function cmn(q,a,b,x,s,t){return safeAdd(rol(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}
  const enc=new TextEncoder(),bytes=enc.encode(str),len8=bytes.length;
  const len32=(((len8+8)>>6)+1)*16,x=new Int32Array(len32);
  for(let i=0;i<len8;i++)x[i>>2]|=bytes[i]<<((i%4)*8);
  x[len8>>2]|=0x80<<((len8%4)*8);x[len32-2]=len8*8;
  let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for(let i=0;i<len32;i+=16){
    const[oa,ob,oc,od]=[a,b,c,d];
    a=ff(a,b,c,d,x[i],7,-680876936);d=ff(d,a,b,c,x[i+1],12,-389564586);c=ff(c,d,a,b,x[i+2],17,606105819);b=ff(b,c,d,a,x[i+3],22,-1044525330);
    a=ff(a,b,c,d,x[i+4],7,-176418897);d=ff(d,a,b,c,x[i+5],12,1200080426);c=ff(c,d,a,b,x[i+6],17,-1473231341);b=ff(b,c,d,a,x[i+7],22,-45705983);
    a=ff(a,b,c,d,x[i+8],7,1770035416);d=ff(d,a,b,c,x[i+9],12,-1958414417);c=ff(c,d,a,b,x[i+10],17,-42063);b=ff(b,c,d,a,x[i+11],22,-1990404162);
    a=ff(a,b,c,d,x[i+12],7,1804603682);d=ff(d,a,b,c,x[i+13],12,-40341101);c=ff(c,d,a,b,x[i+14],17,-1502002290);b=ff(b,c,d,a,x[i+15],22,1236535329);
    a=gg(a,b,c,d,x[i+1],5,-165796510);d=gg(d,a,b,c,x[i+6],9,-1069501632);c=gg(c,d,a,b,x[i+11],14,643717713);b=gg(b,c,d,a,x[i],20,-373897302);
    a=gg(a,b,c,d,x[i+5],5,-701558691);d=gg(d,a,b,c,x[i+10],9,38016083);c=gg(c,d,a,b,x[i+15],14,-660478335);b=gg(b,c,d,a,x[i+4],20,-405537848);
    a=gg(a,b,c,d,x[i+9],5,568446438);d=gg(d,a,b,c,x[i+14],9,-1019803690);c=gg(c,d,a,b,x[i+3],14,-187363961);b=gg(b,c,d,a,x[i+8],20,1163531501);
    a=gg(a,b,c,d,x[i+13],5,-1444681467);d=gg(d,a,b,c,x[i+2],9,-51403784);c=gg(c,d,a,b,x[i+7],14,1735328473);b=gg(b,c,d,a,x[i+12],20,-1926607734);
    a=hh(a,b,c,d,x[i+5],4,-378558);d=hh(d,a,b,c,x[i+8],11,-2022574463);c=hh(c,d,a,b,x[i+11],16,1839030562);b=hh(b,c,d,a,x[i+14],23,-35309556);
    a=hh(a,b,c,d,x[i+1],4,-1530992060);d=hh(d,a,b,c,x[i+4],11,1272893353);c=hh(c,d,a,b,x[i+7],16,-155497632);b=hh(b,c,d,a,x[i+10],23,-1094730640);
    a=hh(a,b,c,d,x[i+13],4,681279174);d=hh(d,a,b,c,x[i],11,-358537222);c=hh(c,d,a,b,x[i+3],16,-722521979);b=hh(b,c,d,a,x[i+6],23,76029189);
    a=hh(a,b,c,d,x[i+9],4,-640364487);d=hh(d,a,b,c,x[i+12],11,-421815835);c=hh(c,d,a,b,x[i+15],16,530742520);b=hh(b,c,d,a,x[i+2],23,-995338651);
    a=ii(a,b,c,d,x[i],6,-198630844);d=ii(d,a,b,c,x[i+7],10,1126891415);c=ii(c,d,a,b,x[i+14],15,-1416354905);b=ii(b,c,d,a,x[i+5],21,-57434055);
    a=ii(a,b,c,d,x[i+12],6,1700485571);d=ii(d,a,b,c,x[i+3],10,-1894986606);c=ii(c,d,a,b,x[i+10],15,-1051523);b=ii(b,c,d,a,x[i+1],21,-2054922799);
    a=ii(a,b,c,d,x[i+8],6,1873313359);d=ii(d,a,b,c,x[i+15],10,-30611744);c=ii(c,d,a,b,x[i+6],15,-1560198380);b=ii(b,c,d,a,x[i+13],21,1309151649);
    a=ii(a,b,c,d,x[i+4],6,-145523070);d=ii(d,a,b,c,x[i+11],10,-1120210379);c=ii(c,d,a,b,x[i+2],15,718787259);b=ii(b,c,d,a,x[i+9],21,-343485551);
    a=safeAdd(a,oa);b=safeAdd(b,ob);c=safeAdd(c,oc);d=safeAdd(d,od);
  }
  return[a,b,c,d].map(n=>{let s='';for(let j=0;j<4;j++)s+=('0'+((n>>(j*8))&0xff).toString(16)).slice(-2);return s;}).join('');
}

function signRequest(fid, time) {
  return md5(`fid=${fid}&time=${time}${SALT}`);
}

async function redeemOne(fid, code, attempt=1) {
  const MAX_ATTEMPTS = 3;
  const time = Date.now();
  const sign = signRequest(fid, time);
  const body = new URLSearchParams({ fid: String(fid), code: code, time: String(time), sign });
  try {
    const res = await fetch(GIFTCODE_API + '/redeem_code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await res.json();
    if (data.err_code === 0)     return { ok: true };
    if (data.err_code === 40014) return { ok: false, err: 'already used' };
    if (data.err_code === 40008) return { ok: false, err: 'expired' };
    // Temporary server error — retry with backoff
    if ((data.msg || '').toUpperCase().includes('TIMEOUT') && attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      return redeemOne(fid, code, attempt + 1);
    }
    return { ok: false, err: data.msg || String(data.err_code) };
  } catch(e) {
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      return redeemOne(fid, code, attempt + 1);
    }
    return { ok: false, err: 'network error' };
  }
}

// ── BATCHED redemption — processes BATCH_SIZE players per call ──
// Queue stored in KV: { codes, playerIds, pos, date }
// Each cron run advances pos by BATCH_SIZE until all players done for current codes.
async function runBatch(env) {
  // 1. Fetch current active codes
  let codes = [];
  try {
    const res = await fetch(KINGSHOT_API + '/gift-codes');
    const data = await res.json();
    if (data.status === 'success' && data.data && data.data.giftCodes) {
      codes = data.data.giftCodes
        .filter(c => !c.expiresAt || new Date(c.expiresAt) > new Date())
        .map(c => c.code);
    }
  } catch(e) {
    return { ok: false, message: 'Failed to fetch gift codes: ' + e.message };
  }
  if (!codes.length) return { ok: true, message: 'No active codes.' };

  // 2. Load players
  const playersRaw = await env.SVS_KV.get(PLAYERS_KEY);
  const players = playersRaw ? Object.values(JSON.parse(playersRaw)) : [];
  if (!players.length) return { ok: true, message: 'No registered players.' };

  // 3. Load or reset queue
  // Reset queue if: codes changed since last queue, or new day, or queue exhausted
  const today = new Date().toISOString().slice(0, 10);
  const queueRaw = await env.SVS_KV.get(QUEUE_KEY);
  let queue = queueRaw ? JSON.parse(queueRaw) : null;
  const codesKey = codes.slice().sort().join(',');
  const needsReset = !queue
    || queue.date !== today
    || queue.codesKey !== codesKey
    || queue.pos >= queue.playerIds.length;

  if (needsReset) {
    // Fresh queue for today — only include players who haven't gotten all codes yet
    const redeemedRaw = await env.SVS_KV.get(REDEEMED_KEY);
    const redeemed = new Set(redeemedRaw ? JSON.parse(redeemedRaw) : []);
    // Find players that still need at least one code
    const pending = players.filter(p =>
      codes.some(c => !redeemed.has(`${p.id}:${c}`))
    );
    if (!pending.length) return { ok: true, message: 'All players already have all active codes.' };
    queue = { codesKey, codes, playerIds: pending.map(p => p.id), pos: 0, date: today };
  }

  // 4. Process this batch
  const redeemedRaw = await env.SVS_KV.get(REDEEMED_KEY);
  const redeemed = new Set(redeemedRaw ? JSON.parse(redeemedRaw) : []);

  const batchIds = queue.playerIds.slice(queue.pos, queue.pos + BATCH_SIZE);
  const batchPlayers = batchIds.map(id => players.find(p => p.id === id)).filter(Boolean);

  const results = [];
  for (const player of batchPlayers) {
    for (const code of queue.codes) {
      const key = `${player.id}:${code}`;
      if (redeemed.has(key)) continue;
      const result = await redeemOne(player.id, code);
      results.push({ name: player.name, id: player.id, code, ok: result.ok, err: result.err || null });
      if (result.ok || result.err === 'already used') redeemed.add(key);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // 5. Advance queue position
  queue.pos += BATCH_SIZE;
  await env.SVS_KV.put(QUEUE_KEY, JSON.stringify(queue));
  await env.SVS_KV.put(REDEEMED_KEY, JSON.stringify([...redeemed]));

  // 6. Append to log
  if (results.length) {
    const logRaw = await env.SVS_KV.get(GIFT_LOG_KEY);
    const log = logRaw ? JSON.parse(logRaw) : [];
    log.push({
      time: new Date().toISOString().slice(0,16).replace('T',' ') + ' UTC',
      codes: queue.codes,
      results
    });
    if (log.length > 30) log.splice(0, log.length - 30);
    await env.SVS_KV.put(GIFT_LOG_KEY, JSON.stringify(log));
  }

  const remaining = Math.max(0, queue.playerIds.length - queue.pos);
  const ok = results.filter(r => r.ok).length;
  const skip = results.filter(r => r.err === 'already used').length;
  const fail = results.filter(r => !r.ok && r.err !== 'already used').length;
  return {
    ok: true,
    message: `Batch done: ${ok} redeemed, ${skip} skip, ${fail} failed. ${remaining} players still queued.`
  };
}

// Manual "redeem all now" — runs batches sequentially until queue empty (admin only, no cron limit)
async function runFull(env) {
  let total = { ok: 0, skip: 0, fail: 0 };
  let runs = 0;
  const MAX_RUNS = 20; // safety cap: 20 × 5 = 100 players max per manual trigger
  while (runs++ < MAX_RUNS) {
    const result = await runBatch(env);
    if (!result.ok) return result;
    // Parse counts from message
    const m = result.message.match(/(\d+) redeemed, (\d+) skip, (\d+) failed/);
    if (m) { total.ok += +m[1]; total.skip += +m[2]; total.fail += +m[3]; }
    if (result.message.includes('0 players still queued') ||
        result.message.includes('already have all') ||
        result.message.includes('No active') ||
        result.message.includes('No registered')) break;
  }
  return { ok: true, message: `Full run complete: ${total.ok} redeemed, ${total.skip} already used, ${total.fail} failed.` };
}

function cors() {
  return { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,PUT,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type' };
}
function json(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers:{'Content-Type':'application/json',...cors()} });
}

const SITE_HTML=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kingdom 1057 — Kingshot</title>
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
.nav{display:flex;align-items:center;gap:0;border-bottom:1px solid var(--border);background:var(--bg2);padding:0 24px;position:sticky;top:0;z-index:100;overflow-x:auto;-webkit-overflow-scrolling:touch;}
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
.bs-team-zone{min-height:120px;border:2px dashed var(--border);border-radius:8px;padding:10px;display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;transition:all .15s;}
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
.phase-tabs{display:flex;flex-wrap:wrap;gap:6px;}
.phase-tabs .tab{border:1px solid var(--border);border-radius:6px;padding:8px 14px;}
.phase-tabs .tab.active{background:rgba(61,142,240,.12);}

@media(max-width:900px){.sim-layout{grid-template-columns:1fr;}.page{padding:14px 12px;}.grid2,.grid3{grid-template-columns:1fr;}#msSlotGrid{grid-template-columns:repeat(4,1fr)!important;}#msVerifyGrid{grid-template-columns:1fr!important;}.nav{padding:0 10px;}.nav-logo{margin-right:14px;font-size:16px;}.tab{padding:14px 12px;font-size:13px;}#syncStatus{margin-right:8px;font-size:10px!important;}.utc-clock{font-size:13px!important;}.phase-tabs .tab{padding:7px 10px;font-size:12px;}.landing-grid{grid-template-columns:1fr!important;}}
</style>
<script>
// DragDropTouch polyfill — enables HTML5 drag-and-drop on iOS and Android
// Adapted from Bernardo Castilho's drag-drop-touch (MIT licence)
(function(){if(typeof document==='undefined')return;var _dragSource=null,_lastTarget=null,_img=null,_ptDown=null,_lastDT=null,_isDragging=false;
function _reset(){_isDragging=false;_dragSource=null;_lastTarget=null;if(_img){_img.parentNode&&_img.parentNode.removeChild(_img);_img=null;}}
function _dispatchEvt(el,type,touch){var e=document.createEvent('Event');e.initEvent(type,true,true);if(touch){e.clientX=touch.clientX;e.clientY=touch.clientY;}e.dataTransfer={data:{},setData:function(k,v){this.data[k]=v;},getData:function(k){return this.data[k];},effectAllowed:'all',dropEffect:'move',setDragImage:function(img){if(_img&&_img.parentNode)_img.parentNode.removeChild(_img);_img=img.cloneNode(true);_img.style.cssText='position:fixed;left:-9999px;top:-9999px;pointer-events:none;opacity:0.7;z-index:99999;';document.body.appendChild(_img);}};el.dispatchEvent(e);return e;}
function _closestDrop(el){while(el){if(el.getAttribute&&el.getAttribute('ondragover'))return el;el=el.parentNode;}return null;}
document.addEventListener('touchstart',function(e){
  var el=e.target;while(el&&!el.draggable)el=el.parentNode;
  if(!el)return;
  _dragSource=el;_ptDown={x:e.touches[0].clientX,y:e.touches[0].clientY};_isDragging=false;
  _lastDT=new Date();
},true);
document.addEventListener('touchmove',function(e){
  if(!_dragSource)return;
  var t=e.touches[0];
  if(!_isDragging){var dx=t.clientX-_ptDown.x,dy=t.clientY-_ptDown.y;if(Math.sqrt(dx*dx+dy*dy)<10)return;_isDragging=true;_dispatchEvt(_dragSource,'dragstart',t);}
  e.preventDefault();
  var drop=_closestDrop(document.elementFromPoint(t.clientX,t.clientY));
  if(drop!==_lastTarget){if(_lastTarget)_dispatchEvt(_lastTarget,'dragleave',t);_lastTarget=drop;if(drop)_dispatchEvt(drop,'dragover',t);}
  if(_img){_img.style.left=(t.clientX+10)+'px';_img.style.top=(t.clientY+10)+'px';}
  // auto-scroll
  var m=80,sp=12,h=window.innerHeight;
  if(t.clientY<m)window.scrollBy(0,-sp);else if(t.clientY>h-m)window.scrollBy(0,sp);
},true);
document.addEventListener('touchend',function(e){
  if(!_isDragging){_reset();return;}
  var t=e.changedTouches[0];
  var drop=_closestDrop(document.elementFromPoint(t.clientX,t.clientY));
  if(drop)_dispatchEvt(drop,'drop',t);
  _dispatchEvt(_dragSource,'dragend',t);
  _reset();
},true);
})();
</script>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js" onerror="this.onerror=null;var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js';document.head.appendChild(s);"></script>
</head>
<body>
<!-- LANDING PAGE -->
<div id="page-landing" style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:24px 16px">
  <div style="max-width:520px;width:100%">

    <!-- Hero header -->
    <div style="text-align:center;margin-bottom:32px">
      <div style="font-family:var(--head);font-size:11px;font-weight:600;letter-spacing:.3em;color:var(--text3);margin-bottom:12px;text-transform:uppercase">⚔️ KvK Alliance Command</div>
      <div style="font-family:var(--head);font-size:18px;font-weight:400;color:var(--text3);letter-spacing:.15em;margin-bottom:4px">WELCOME TO</div>
      <div style="font-family:var(--head);font-size:58px;font-weight:700;color:var(--accent2);letter-spacing:.06em;line-height:1;margin-bottom:8px">KINGDOM <span style="color:var(--gold)">1057</span></div>
      <div style="font-family:var(--head);font-size:13px;color:var(--text3);letter-spacing:.2em;margin-bottom:28px">✦ &nbsp; THE GREATEST KINGDOM OF ALL TIME &nbsp; ✦</div>
      <!-- Story card -->
      <div class="card" style="text-align:left;border:1px solid rgba(61,142,240,.25);background:rgba(61,142,240,.04);margin-bottom:0">
        <div style="font-size:13px;color:var(--text);line-height:1.9;font-family:var(--body)">
          This site is your <strong style="color:var(--accent2)">KvK coordination hub</strong> — built to give Kingdom 1057 the edge it deserves.<br><br>
          Minister Spots are <strong style="color:var(--gold)">scarce and powerful</strong>. Submit your speedup inventory and pick timeslots to compete for a position.<br><br>
          <strong style="color:var(--gold)">Bonus perk:</strong> Register your Player ID and get <strong style="color:var(--accent2)">automatic gift code redemption</strong> throughout the KvK — free rewards, zero effort. 🎁<br><br>
          <span style="color:var(--text3);font-size:12px">Let's go. Kingdom 1057 doesn't lose.</span>
        </div>
      </div>
    </div>

    <!-- Login card — single column, step-based -->
    <div class="card" style="border:1px solid rgba(46,204,113,.2)">
      <div style="font-family:var(--head);font-size:16px;font-weight:700;color:var(--green);margin-bottom:4px">🎮 Enter Kingdom 1057</div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:16px;line-height:1.6">Verify your Player ID to enter. Members, R4/R5 and Rally Leaders all enter here.</p>

      <!-- Step 1: Player ID -->
      <div id="landingStepEntry">
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input type="text" id="landingPlayerId" placeholder="Your Player ID — e.g. 8767319" style="flex:1;min-width:0" onkeydown="if(event.key==='Enter')lookupPlayer()">
          <button class="btn btn-primary" id="lookupBtn" onclick="lookupPlayer()">🔍 Lookup</button>
        </div>
        <div id="playerLookupResult" style="display:none;margin-bottom:12px"></div>
        <div id="landingRoleButtons" style="display:none;flex-direction:column;gap:8px">
          <button class="btn btn-primary" onclick="landingEnterMember()">✅ Enter as Member of 1057</button>
          <button class="btn btn-ghost" onclick="landingStartWithPassword()">🛡 R4/R5</button>
        </div>
      </div>

      <!-- Step 2: Alliance picker -->
      <div id="landingStepAlliance" style="display:none">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <button class="btn btn-ghost btn-sm" onclick="landingBack('entry')">← Back</button>
          <div style="font-weight:600;font-size:14px">🏰 Select your Alliance</div>
        </div>
        <p style="color:var(--text2);font-size:12px;margin-bottom:12px">Your alliance is permanent — only an admin can change it later.</p>
        <select id="alliancePicker" style="width:100%;margin-bottom:12px">
          <option value="">Select your alliance…</option>
          <option>FIR</option><option>LOC</option><option>LYL</option>
          <option>KNG</option><option>KOV</option><option>TLA</option>
        </select>
        <button id="allianceNextStep" class="btn btn-primary" style="width:100%" data-next="" onclick="landingConfirmAlliance()">Continue →</button>
      </div>

      <!-- Step 3: Password -->
      <div id="landingStepPassword" style="display:none">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <button class="btn btn-ghost btn-sm" onclick="landingBack('alliance')">← Back</button>
          <div style="font-weight:600;font-size:14px" id="landingPwLabel">Enter your password</div>
        </div>
        <input type="password" id="landingPwInput" placeholder="Password" style="width:100%;margin-bottom:10px;box-sizing:border-box" onkeydown="if(event.key==='Enter')landingCheckPassword()">
        <div id="landingPwError" style="display:none;color:#ff7070;font-size:12px;margin-bottom:8px">Incorrect password.</div>
        <button class="btn btn-primary" style="width:100%" onclick="landingCheckPassword()">Enter →</button>
      </div>

      <!-- Player ID guide -->
      <div id="landingGuide" style="margin-top:16px;background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
        <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:8px">📍 Where to find your Player ID</div>
        <div style="font-size:12px;color:var(--text2);line-height:1.7;margin-bottom:10px">
          Tap your <strong>profile picture</strong> in the top-left corner of the game.<br>
          Your Player ID is the number shown next to <strong style="color:var(--gold)">ID:</strong> — as highlighted below.
        </div>
        <img src="data:image/jpeg;base64,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" alt="Player ID location" style="width:100%;border-radius:6px;border:1px solid var(--border)">
      </div>
    </div>

  </div>
</div>

<!-- USER BAR — shown after login -->
<div id="userBar" style="display:none;background:var(--bg3);border-bottom:1px solid var(--border);padding:6px 16px;align-items:center;gap:10px;font-size:13px">
  <img id="userBarAvatar" src="" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border2);display:none">
  <span id="userBarName" style="font-weight:600;color:var(--text)"></span>
  <span id="userBarKingdom" style="color:var(--text3);font-size:11px"></span>
  <span id="userBarRole" style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(61,142,240,.15);color:var(--accent2);margin-left:4px"></span>
  <span style="flex:1"></span>
  <span id="syncStatus" style="font-size:11px;color:var(--text3)"></span>
</div>

<nav class="nav" id="mainNav" style="display:none">
  <div class="nav-logo">KINGDOM<span>·</span>1057</div>
  <div class="tab active" onclick="showPage('coordinator')">Rally Leaders</div>
  <div class="tab" onclick="showPage('setup')">Team Setup</div>
  <div class="tab" onclick="showPage('strategy')">Battle Strategy</div>
  <div class="tab" onclick="showPage('minister')">Minister Spots</div>
  <div class="tab" id="tabSwordland" onclick="showPage('swordland')" style="display:none">Swordland</div>
  <div class="tab" id="tabTrialliance" onclick="showPage('trialliance')" style="display:none">Tri Alliance</div>
  <div class="tab" id="tabAdmin" onclick="showPage('admin')" style="display:none">⚙️ Admin</div>
  <div id="syncStatusNav" style="font-family:var(--head);font-size:11px;font-weight:600;letter-spacing:.04em;margin-right:14px;color:var(--text3);white-space:nowrap;flex-shrink:0"></div>
  <div class="utc-clock" id="utcClock" style="flex-shrink:0">00:00:00</div>
</nav>
<div id="toast">Copied!</div>

<!-- ══════════════════════ RALLY COORDINATOR ══════════════════════ -->
<div id="page-coordinator" class="page">
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
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
    <table style="min-width:680px"><thead><tr><th>Name</th><th>March</th><th>Tier</th><th>Team</th><th>Status</th><th>Duration</th><th>Launch Time</th><th>Timer</th><th>Cooldown</th><th></th></tr></thead>
    <tbody id="leaderBody"></tbody></table>
    </div>
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
        style="min-height:160px;border:2px dashed var(--border);border-radius:8px;padding:14px"></div>
    </div>
    <div class="card" style="margin-bottom:0">
      <div class="card-title">⚔️ <span id="bsAttackTitle">Attacking Alliance</span></div>
      <div id="bsAttackZone" class="bs-alliance-zone" ondragover="bsAllianceDragOver(event)" ondragleave="bsAllianceDragLeave(event)" ondrop="bsAllianceDrop(event,'attack')"
        style="min-height:160px;border:2px dashed var(--border);border-radius:8px;padding:14px"></div>
    </div>
  </div>

  <!-- UNASSIGNED TEAMS -->
  <div class="card">
    <div class="card-title">📦 Unassigned Teams</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:10px">Drag a team box into Garrison or Attacking Alliance above. Drag a team back here to unassign it.</p>
    <div id="bsUnassignedZone" ondragover="bsAllianceDragOver(event)" ondragleave="bsAllianceDragLeave(event)" ondrop="bsAllianceDrop(event,null)"
      style="display:flex;flex-wrap:wrap;gap:10px;min-height:140px;border:2px dashed var(--border);border-radius:8px;padding:14px"></div>
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
    <div id="bsTeamButtons" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"></div>
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
    <div class="card-title">👑 Minister Spots</div>
    <div style="color:var(--text2);font-size:13px;line-height:1.8">
      <strong style="color:var(--text)">How to use:</strong><br>
      1. Each player uploads a screenshot of their in-game speedup inventory and fills in their amounts.<br>
      2. Set how much of each speedup type you plan to use this KvK using the sliders.<br>
      3. Pick your preferred timeslots (minimum 4) — these are UTC 30-minute windows across a full day.<br>
      4. The leader runs the allocation to rank players and assign slots — highest committed hours gets priority.<br>
      <span style="color:var(--text3);font-size:12px">48 available slots • Top 48 by committed hours win • Admin password required to manage results</span>
    </div>
  </div>

  <!-- STEP TABS -->
  <div class="phase-tabs" style="margin-bottom:18px">
    <button class="tab ms-step-tab active" id="msStepTab1" onclick="msGoStep(1)">1. Upload</button>
    <button class="tab ms-step-tab" id="msStepTab2" onclick="msGoStep(2)">2. Verify</button>
    <button class="tab ms-step-tab" id="msStepTab3" onclick="msGoStep(3)">3. Commitment</button>
    <button class="tab ms-step-tab" id="msStepTab4" onclick="msGoStep(4)">4. Timeslots</button>
    <button class="tab ms-step-tab" id="msStepTab5" onclick="msGoStep(5)" style="margin-left:auto">5. Results &amp; Schedule</button>
  </div>

  <!-- STEP 1: UPLOAD -->
  <div id="msStep1" class="ms-step">
    <div class="card">
      <div class="card-title">📸 Step 1 — Identify &amp; Upload</div>
      <div class="row">
        <div id="msIdentityDisplay" style="background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:10px 14px;display:flex;align-items:center;gap:12px">
          <img id="msIdentityAvatar" src="" style="width:36px;height:36px;border-radius:50%;border:2px solid var(--border2);display:none">
          <div>
            <div style="font-weight:600" id="msIdentityName">—</div>
            <div style="font-size:12px;color:var(--text3)" id="msIdentityAlliance">—</div>
          </div>
          <input type="hidden" id="msAlliance" value="">
          <input type="hidden" id="msIGN" value="">
        </div>
      </div>
      <div id="msIdentityError" style="display:none;color:#ff7070;font-size:12px;margin-bottom:10px;background:rgba(224,58,58,.1);border:1px solid rgba(224,58,58,.3);border-radius:5px;padding:8px 12px">⚠ Please enter both your Alliance name and in-game name before continuing.</div>
      <div class="sec-title">Upload your inventory screenshot</div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:10px">Take a screenshot of your speedup items in the in-game inventory (Construction, Research, Training, General). Works from phone or desktop.</p>
      <!-- HOW-TO GUIDE -->
      <div style="background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        <img src="data:image/jpeg;base64,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" alt="How to screenshot speedups" style="width:140px;border-radius:6px;border:1px solid var(--border);flex-shrink:0">
        <div style="flex:1;min-width:200px">
          <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:8px">📸 How to take the screenshot</div>
          <ul style="color:var(--text2);font-size:12px;line-height:2;margin:0;padding-left:16px">
            <li>Open the game and tap your <strong>Backpack</strong></li>
            <li>Go to the <strong>top right upper corner</strong></li>
            <li>Tap the <strong>Speedups</strong> tab</li>
            <li>At the bottom, make sure <strong style="color:var(--gold)">Hrs ✓</strong> is selected — not Day(s) or Min</li>
            <li>Take a screenshot showing all 4 speedup types: General, Soldier Training, Construction and Research</li>
          </ul>
          <div style="margin-top:10px;font-size:12px;color:#ff9d4d">⚠ <strong>Important:</strong> Make sure <strong>Hrs</strong> is checked (green tick) at the bottom — exactly like in the example image. This gives the most accurate reading. If you use Day(s) or Min instead, the numbers may be slightly off.</div>
          <div style="margin-top:6px;font-size:12px;color:var(--text3)">💡 <strong>Tip:</strong> The screenshot doesn't need to be perfect — as long as the 4 speedup rows and their numbers are visible, the scanner will pick them up automatically.</div>
        </div>
      </div>
      <input type="file" id="msFileInput" accept="image/*" style="margin-bottom:10px">
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
      <div id="msSlotGrid" style="display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-bottom:8px"></div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:12px;display:flex;align-items:center;gap:10px">
        <span>Slot popularity:</span>
        <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:3px;background:rgba(46,204,113,.5);display:inline-block"></span>Few requests</span>
        <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:3px;background:rgba(224,140,58,.5);display:inline-block"></span>Moderate</span>
        <span style="display:inline-flex;align-items:center;gap:4px"><span style="width:12px;height:12px;border-radius:3px;background:rgba(224,58,58,.5);display:inline-block"></span>High demand</span>
        <span style="color:var(--text3);font-size:10px">· Number = request count</span>
      </div>
      <div id="msDeadlineBanner" style="display:none;margin-bottom:10px"></div>
      <button class="btn btn-primary" id="msSubmitBtn" onclick="msSubmitEntry()">✅ Submit My Entry</button>
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
      <div id="msAdminGuard" style="display:none;background:rgba(61,142,240,.08);border:1px solid var(--border);border-radius:7px;padding:14px;margin-bottom:10px">
        <div style="font-size:13px;color:var(--text2);margin-bottom:10px">🔒 Admin password required to manage results.</div>
        <div style="display:flex;gap:8px">
          <input type="password" id="msAdminPwInput" placeholder="Admin password" style="width:160px" onkeydown="if(event.key==='Enter')msUnlockAdmin()">
          <button class="btn btn-primary btn-sm" onclick="msUnlockAdmin()">Unlock</button>
        </div>
        <div id="msAdminPwErr" style="display:none;color:#ff7070;font-size:12px;margin-top:6px">Incorrect password.</div>
      </div>
      <div id="msAdminActions" style="display:none">
        <div id="msDeadlineAdminBanner" style="display:none;background:rgba(255,157,77,.1);border:1px solid rgba(255,157,77,.4);border-radius:7px;padding:10px 14px;margin-bottom:12px">
          <strong style="color:#ff9d4d">⏰ Deadline passed</strong> — submissions are locked. Ready to run allocation.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
          <div class="field"><label style="font-size:11px">Submission deadline (UTC)</label>
            <input type="datetime-local" id="msDeadlineInput" style="width:200px">
          </div>
          <button class="btn btn-primary btn-sm" onclick="msSetDeadline()">Set Deadline</button>
          <button class="btn btn-ghost btn-sm" onclick="msReopenSubmissions()">🔓 Reopen Submissions</button>
        </div>
        <button class="btn btn-gold" onclick="msRunAllocation()">⚙️ Run Allocation (rank + assign slots)</button>
        <button class="btn btn-ghost btn-sm" onclick="msClearAllSubs()" style="margin-left:8px">🗑 Clear all submissions</button>
      </div>
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
  deadline: null,
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

let syncSerialize = function() {
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
    msLastAllocation: (typeof MS!=='undefined') ? MS._lastAllocation : null,
    msDeadline: (typeof MS!=='undefined') ? MS.deadline : null
  });
}

let syncApplyRemote = function(data) {
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
      MS.deadline = data.msDeadline || null;
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
    if (!res.ok) { updateSyncStatus('error'); return; }
    const data = await res.json();
    const json = JSON.stringify(data);
    // A successful response means we ARE connected and synced, even if the
    // shared state is still empty (e.g. first-ever load, nobody has saved
    // anything yet). Only the "apply remote data" step should be skipped
    // when there's nothing to apply.
    updateSyncStatus('synced');
    if (json !== syncLastPushedJSON && Object.keys(data).length) {
      syncApplyRemote(data);
      syncLastPushedJSON = json;
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
  const map = {
    synced: ['● Synced', 'var(--green)'],
    saving: ['● Saving…', 'var(--gold)'],
    offline: ['● Offline — changes saved locally only', '#ff7070'],
    error: ['● Sync error', '#ff7070'],
    off: ['', 'var(--text3)']
  };
  const [txt, color] = map[state] || map.off;
  ['syncStatus', 'syncStatusNav'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = txt; el.style.color = color; }
  });
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
function updateLeaderMarch(id, value){
  const march=parseInt(value);
  if(isNaN(march)||march<1||march>300) return;
  const l=S.leaders.find(x=>x.id===id);
  if(l){ l.march=march; renderSetup(); if(typeof renderBattleStrategy==='function') renderBattleStrategy(); syncQueuePush(); }
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
      <td><strong>\${l.name}</strong></td>
      <td><input type="number" min="1" max="300" value="\${l.march}" style="width:58px;font-family:var(--mono);font-size:13px;background:var(--bg4);border:1px solid var(--border2);border-radius:4px;padding:4px 6px;color:var(--text);text-align:center" onchange="updateLeaderMarch('\${l.id}',this.value)">s</td>
      <td>\${tb}</td><td>\${teamTxt}</td>
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
  // Live-recalculate launch times every second so they never show a past time
  if(BS_CALC.offsetSec!==null && BS_CALC.selectedTeamId!==null){
    bsCalcTeam(BS_CALC.selectedTeamId, BS_CALC.offsetSec, false);
  }
}
setInterval(bsTickClock,1000); bsTickClock();

function nowUTCSec(){
  return Math.floor(Date.now()/1000);
}
function s2hms(totalSec){
  // Convert absolute UTC seconds to HH:MM:SS string
  const s=((totalSec%86400)+86400)%86400; // normalise to 0–86399
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0');
}

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
  // offsetSec = how far in the future the first (longest march) leader launches.
  // The leader with the LONGEST march launches at baseLaunch = now + offset.
  // Leaders with shorter marches launch LATER so they all arrive together.
  const baseLaunch=nowUTCSec()+offsetSec;
  const maxMarch=Math.max(...leaders.map(l=>l.march));
  const results=leaders.map(l=>({
    name:l.name,
    march:l.march,
    launchSec:baseLaunch+(maxMarch-l.march),
    landSec:baseLaunch+maxMarch
  })).sort((a,b)=>a.launchSec-b.launchSec);
  const landSec=baseLaunch+maxMarch;

  const header=\`\${t.name}\`;
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
  // Show the persistent quick-copy button above the result

  if(logToast) toast(\`\${t.name} — rally times calculated!\`);
}

function bsCopySelectedTeam(){
  if(!BS_CALC.selectedTeamId){ toast('Select a team first.'); return; }
  bsCopyTeamResult(BS_CALC.selectedTeamId);
}

function bsCopyTeamResult(teamId){
  const t=S.teams.find(x=>x.id===teamId);
  if(!t||!t._bsLastCalc){ toast('Calculate a team first!'); return; }
  const {results}=t._bsLastCalc;
  const lines=[t.name, ...results.map(r=>\`\${r.name} | Time: \${s2hms(r.launchSec)}\`)];
  copyText(lines.join('\\n'));
  toast('Copied!');
}

// ════════════ MINISTER SPOTS ════════════
const MS_CATEGORIES = ['general','training','construction','research'];
const MS_CATEGORY_LABELS = {general:'General Speedup',training:'Soldier Training Speedup',construction:'Construction Speedup',research:'Research Speedup'};
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
  // Auto-fill identity from verified player session
  const vp = verifiedPlayer || (() => { try { const s = sessionStorage.getItem('verifiedPlayer'); return s ? JSON.parse(s) : null; } catch(e) { return null; } })();
  const alliance = (typeof AUTH !== 'undefined' && AUTH.alliance) ? AUTH.alliance : (lsGet ? lsGet('alliance') : null);
  const nameEl = document.getElementById('msIdentityName');
  const allianceEl = document.getElementById('msIdentityAlliance');
  const avatarEl = document.getElementById('msIdentityAvatar');
  const msAllianceEl = document.getElementById('msAlliance');
  const msIGNEl = document.getElementById('msIGN');
  if (vp) {
    if (nameEl) nameEl.textContent = vp.name || '—';
    if (allianceEl) allianceEl.textContent = alliance ? alliance + ' · Level ' + (vp.level||'') : 'Level ' + (vp.level||'');
    if (avatarEl && vp.avatar) { avatarEl.src = vp.avatar; avatarEl.style.display = 'block'; }
    if (msAllianceEl) msAllianceEl.value = alliance || '';
    if (msIGNEl) msIGNEl.value = vp.name || '';
  }
  msGoStep(MS._currentStep||1);
  msRenderVerifyGrid();
  msRenderSliderGrid();
  msRenderSlotGrid();
  msRenderResultsSummary();
  msRenderStepTabs();
  msUpdateDeadlineBanners();
}

function msMarkStepComplete(n){
  MS._unlockedStep=Math.max(MS._unlockedStep||1, n+1);
  msRenderStepTabs();
}

function msRenderStepTabs(){
  const unlocked=msCanAccessResults() ? 5 : (MS._unlockedStep||1);
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
  // Admins can jump directly to any step including Results
  if(n>unlocked && !msCanAccessResults()){
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
  if(n===5){ msRenderResultsSummary(); msInitResultsTab(); }
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
  // POSITIONAL PARSER — language agnostic, no keyword matching.
  // The game ALWAYS shows speedups in the same order:
  //   1. General  2. Soldier Training  3. Construction  4. Research
  // We just extract all duration values top-to-bottom and assign by position.
  // This works regardless of language, OCR noise, or label corruption.

  const lines = text.split(/\\n+/).map(l => l.trim()).filter(Boolean);

  function normalizeOCR(s) {
    s = s.replace(/(\\d)[Il](?=\\d|\\b)/g, '$11'); // I/l → 1 near digits
    s = s.replace(/\\bI(\\d)/g, '1$1');
    s = s.replace(/(\\d),(\\d{3})/g, '$1$2');     // thousands comma: 1,369 → 1369
    s = s.replace(/(\\d),(\\d{3})/g, '$1$2');     // run twice for 1,000,000
    return s;
  }

  // Time unit keywords in all supported languages
  // English: hr(s), min(s), day(s) — game uses these regardless of UI language
  // We also accept common OCR corruptions of these words
  function parseDurationToHours(s) {
    s = normalizeOCR(s);
    let total = 0, matched = false;
    const re = /(\\d+(?:\\.\\d+)?)\\s*(day\\(s\\)|days?|d\\b|hr\\(s\\)|h(?:rs?|ours?)\\b|h\\b|min\\(s\\)|min(?:ute)?s?\\b|m\\b|sec\\(s\\)|sec(?:ond)?s?\\b|s\\b)/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = parseFloat(m[1]);
      const u = m[2].toLowerCase();
      if (u.startsWith('d'))      total += n * 24;
      else if (u.startsWith('h')) total += n;
      else if (u.startsWith('m')) total += n / 60;
      else if (u.startsWith('s')) total += n / 3600;
      matched = true;
    }
    return matched ? total : null;
  }

  // Boundary lines — values below these should be ignored (they're not the 4 speedup types)
  const BOUNDARY_RE = /learning\\s*speedup|soldier\\s*heal|healing\\s*speedup/i;

  // Collect all duration blocks in top-to-bottom order, stopping at boundaries
  const durationBlocks = [];
  let i = 0;
  while (i < lines.length) {
    if (BOUNDARY_RE.test(lines[i])) break; // stop at Learning/Healing section
    const h = parseDurationToHours(lines[i]);
    if (h !== null && h > 0) {
      // Merge with next line if it looks like a continuation (no digit of its own)
      let raw = lines[i], total = h, j = i + 1;
      while (j < lines.length && !BOUNDARY_RE.test(lines[j])) {
        const extra = parseDurationToHours(lines[j]);
        if (extra !== null && !/\\d/.test(lines[j].replace(/hr\\(s\\)|min\\(s\\)|day\\(s\\)/gi, ''))) {
          // continuation line (unit-only like "min(s)" with no leading digit)
          total += extra; raw += ' ' + lines[j]; j++;
        } else break;
      }
      durationBlocks.push({ hours: total, raw });
      i = j;
    } else {
      i++;
    }
  }

  // Assign first 4 blocks to categories in order: general, training, construction, research
  MS_CATEGORIES.forEach((cat, idx) => {
    if (idx < durationBlocks.length) {
      const { hours, raw } = durationBlocks[idx];
      MS.draft.verify[cat] = {
        amount: Math.round(hours * 100) / 100,
        unit: 'hours', hours,
        ocrAmount: Math.round(hours * 100) / 100,
        ocrRaw: raw
      };
    } else {
      MS.draft.verify[cat] = { amount: 0, unit: 'hours', hours: 0, ocrAmount: null, ocrRaw: null };
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

  // Build popularity map: count how many submissions picked each slot
  const popularity = new Array(MS_TOTAL_SLOTS).fill(0);
  MS.submissions.forEach(sub => { (sub.picks||[]).forEach(p => { popularity[p]++; }); });
  const maxPop = Math.max(1, ...popularity);

  grid.innerHTML=Array.from({length:MS_TOTAL_SLOTS},(_,i)=>{
    const selected=MS.draft.picks.includes(i);
    const taken=takenSlots.has(i)&&!selected;
    const pop = popularity[i];

    // Heatmap colour: green (low) → yellow → red (high)
    let heatStyle = '';
    if (pop > 0 && !selected && !taken) {
      const ratio = pop / maxPop;
      const r = Math.round(46 + (224-46)*ratio);
      const g = Math.round(204 - (204-58)*ratio);
      const b = Math.round(113 - 113*ratio);
      heatStyle = \`box-shadow:inset 0 0 0 2px rgba(\${r},\${g},\${b},0.5);\`;
    }

    // Badge showing request count
    const badge = pop > 0 ? \`<span style="position:absolute;top:-4px;right:-4px;background:rgba(0,0,0,.7);color:#fff;font-size:9px;border-radius:8px;padding:1px 4px;line-height:1.4">\${pop}</span>\` : '';

    return \`<button class="ms-slot-btn \${selected?'selected':''} \${taken?'taken':''}" onclick="\${taken?'':'msTogglePick('+i+')'}" title="\${taken?'Already allocated':pop>0?pop+' request(s) for this slot':''}" style="position:relative;\${heatStyle}">\${msSlotLabel(i)}\${badge}</button>\`;
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

// ── Deadline management ──
function msGetDeadline() {
  try { return MS.deadline ? new Date(MS.deadline) : null; } catch(e) { return null; }
}
function msIsDeadlinePassed() {
  const d = msGetDeadline();
  return d ? Date.now() > d.getTime() : false;
}
function msSetDeadline() {
  const input = document.getElementById('msDeadlineInput');
  if (!input || !input.value) { toast('Pick a date and time first.'); return; }
  // datetime-local gives local time — store as UTC ISO string
  MS.deadline = new Date(input.value).toISOString();
  syncQueuePush();
  msUpdateDeadlineBanners();
  toast('Deadline set: ' + new Date(MS.deadline).toUTCString());
}
function msReopenSubmissions() {
  MS.deadline = null;
  syncQueuePush();
  msUpdateDeadlineBanners();
  toast('Submissions reopened.');
}
function msUpdateDeadlineBanners() {
  const passed = msIsDeadlinePassed();
  const dl = msGetDeadline();
  // Member banner (Step 4)
  const memberBanner = document.getElementById('msDeadlineBanner');
  const submitBtn = document.getElementById('msSubmitBtn');
  if (memberBanner) {
    if (dl && passed) {
      memberBanner.style.display = 'block';
      memberBanner.innerHTML = '<div style="background:rgba(224,58,58,.1);border:1px solid rgba(224,58,58,.4);border-radius:7px;padding:10px 14px;color:var(--enemy)">🔒 Submissions are closed. The deadline has passed.</div>';
      if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; }
    } else if (dl) {
      memberBanner.style.display = 'block';
      memberBanner.innerHTML = '<div style="background:rgba(255,157,77,.08);border:1px solid rgba(255,157,77,.3);border-radius:7px;padding:10px 14px;font-size:12px;color:#ff9d4d">⏰ Submission deadline: <strong>' + new Date(dl).toUTCString() + '</strong></div>';
      if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = ''; }
    } else {
      memberBanner.style.display = 'none';
      if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = ''; }
    }
  }
  // Admin banner (Step 5)
  const adminBanner = document.getElementById('msDeadlineAdminBanner');
  if (adminBanner) adminBanner.style.display = (dl && passed) ? 'block' : 'none';
  // Pre-fill deadline input with current value
  const dlInput = document.getElementById('msDeadlineInput');
  if (dlInput && dl) {
    // Convert ISO to local datetime-local format
    const local = new Date(dl.getTime() - dl.getTimezoneOffset()*60000).toISOString().slice(0,16);
    dlInput.value = local;
  }
}

function msSubmitEntry(){
  // Check deadline
  if(msIsDeadlinePassed()){ toast('Submissions are closed — the deadline has passed.'); return; }
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
  const existing=MS.submissions.find(s=>s.alliance===entry.alliance && s.ign===entry.ign);
  if(existing){
    if(!confirm('An entry for ' + entry.ign + ' (' + entry.alliance + ') already exists. Overwrite it?')) return;
    MS.submissions=MS.submissions.filter(s=>!(s.alliance===entry.alliance && s.ign===entry.ign));
  }
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

  // Collect pinned slots from previous allocation — these are locked
  const pinned = new Map(); // slot → entry (preserved from previous run)
  if(MS._lastAllocation){
    MS._lastAllocation.assignments.forEach(a => {
      if(a.pinned) pinned.set(a.slot, a.entry);
    });
  }

  // Rank by committed Training hours, descending
  const ranked=[...MS.submissions].sort((a,b)=>b.committedHours[MS_RANK_CATEGORY]-a.committedHours[MS_RANK_CATEGORY]);

  // Remove from ranking anyone who is in a pinned slot (they're already placed)
  const pinnedIGNs = new Set([...pinned.values()].map(e => e.ign));
  const unranked = ranked.filter(e => !pinnedIGNs.has(e.ign));

  const winners = unranked.slice(0, MS_TOTAL_SLOTS - pinned.size);
  const rejected = unranked.slice(MS_TOTAL_SLOTS - pinned.size);

  // Build taken slots set from pinned
  const takenSlots = new Set(pinned.keys());
  const assignments = [];

  // Place pinned slots first
  pinned.forEach((entry, slot) => {
    assignments.push({entry, slot, pinned: true});
  });

  // Assign remaining winners to free slots
  const unassigned = [];
  winners.forEach(entry => {
    const pick = entry.picks.find(s => !takenSlots.has(s));
    if(pick !== undefined){ takenSlots.add(pick); assignments.push({entry, slot:pick}); }
    else { unassigned.push(entry); }
  });
  unassigned.forEach(entry => {
    for(let i=0;i<MS_TOTAL_SLOTS;i++){
      if(!takenSlots.has(i)){ takenSlots.add(i); assignments.push({entry,slot:i,fallback:true}); break; }
    }
  });
  assignments.sort((a,b) => a.slot - b.slot);

  MS._lastAllocation = {winners:[...ranked.filter(e=>!rejected.includes(e))], rejected, assignments};
  msRenderResultsSummary();
  msRenderFinalSchedule();
  msRenderRejectedList();
  syncQueuePush();
  toast(pinned.size ? \`Allocation complete! \${pinned.size} pinned slot(s) preserved.\` : 'Allocation complete!');
}

function msRenderFinalSchedule(){
  const el=document.getElementById('msFinalSchedule'); if(!el) return;
  if(!MS._lastAllocation || !MS._lastAllocation.assignments.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px">Run allocation to generate the schedule.</div>';
    return;
  }
  const canEdit = msCanAccessResults();
  el.innerHTML = (canEdit ? '<div style="font-size:11px;color:var(--text3);margin-bottom:10px">🔒 Pinned slots are preserved when re-running allocation. Drag slots to swap. Click 🔒 to toggle pin.</div>' : '') +
    MS._lastAllocation.assignments.map((a,i)=>{
      const pinned = a.pinned ? true : false;
      const dragAttrs = canEdit ? \`draggable="true" ondragstart="msDragStart(event,\${i})" ondragover="msDragOver(event)" ondrop="msDrop(event,\${i})" ondragleave="msDragLeave(event)"\` : '';
      return \`<div class="ms-rank-row winner" data-idx="\${i}" \${dragAttrs} style="cursor:\${canEdit?'grab':'default'};user-select:none;transition:opacity .15s">
        <span class="ms-rank-num mono">\${msSlotLabel(a.slot)}</span>
        <strong>\${a.entry.ign}</strong>
        <span style="color:var(--text3);font-size:12px">\${a.entry.alliance}</span>
        <span style="margin-left:auto" class="mono" style="color:var(--gold)">\${a.entry.committedHours[MS_RANK_CATEGORY].toFixed(1)}h</span>
        \${a.fallback?'<span style="font-size:10px;color:#ff9d4d;margin-left:6px">(backup)</span>':''}
        \${canEdit?\`<button onclick="msTogglePin(\${i})" title="\${pinned?'Unpin slot':'Pin slot'}" style="margin-left:8px;background:none;border:none;cursor:pointer;font-size:14px;padding:2px">\${pinned?'🔒':'🔓'}</button>\`:''}
      </div>\`;
    }).join('');
}

let _msDragSrcIdx = null;
function msDragStart(e, idx) {
  _msDragSrcIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.target.style.opacity = '0.4';
}
function msDragOver(e) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  e.currentTarget.style.background = 'rgba(61,142,240,.15)';
}
function msDragLeave(e) { e.currentTarget.style.background = ''; }
function msDrop(e, targetIdx) {
  e.preventDefault();
  e.currentTarget.style.background = '';
  if (_msDragSrcIdx === null || _msDragSrcIdx === targetIdx) return;
  const assignments = MS._lastAllocation.assignments;
  // Swap the entries (preserve slots, swap who fills them)
  const srcEntry = assignments[_msDragSrcIdx].entry;
  const tgtEntry = assignments[targetIdx].entry;
  assignments[_msDragSrcIdx].entry = tgtEntry;
  assignments[targetIdx].entry = srcEntry;
  // Pin both swapped slots
  assignments[_msDragSrcIdx].pinned = true;
  assignments[targetIdx].pinned = true;
  _msDragSrcIdx = null;
  msRenderFinalSchedule();
  syncQueuePush();
  toast('Slots swapped and pinned.');
}

function msTogglePin(idx) {
  const a = MS._lastAllocation.assignments[idx];
  a.pinned = !a.pinned;
  msRenderFinalSchedule();
  syncQueuePush();
  toast(a.pinned ? 'Slot pinned — protected from re-allocation.' : 'Slot unpinned.');
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
<script id="newSystemsJS">

// ════════════════════════════════════════════════════════
// AUTH & PASSWORD SYSTEM
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// AUTH SYSTEM v2 — 3 roles: member, rallyleader, r4r5, admin
// ════════════════════════════════════════════════════════

const AUTH = {
  role: null,        // 'member' | 'rallyleader' | 'r4r5' | 'admin'
  alliance: null,    // 'FIR'|'LOC'|'LYL'|'KNG'|'KOV'|'TLA' | null
  playerVerified: false
};

const AUTH_DEFAULTS = {
  rallyleader: 'kvk1057rally',
  r4r5: 'kvk1057r4r5',
  admin: 'kvk1057admin'
};

let loadedPasswords = { rallyleader: null, r4r5: null, admin: null };

const ALLIANCES = ['FIR','LOC','LYL','KNG','KOV','TLA'];

async function loadPasswords() {
  try {
    const res = await fetch('/state', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.pw_rallyleader) loadedPasswords.rallyleader = data.pw_rallyleader;
      if (data.pw_r4r5) loadedPasswords.r4r5 = data.pw_r4r5;
      if (data.pw_admin) loadedPasswords.admin = data.pw_admin;
    }
  } catch(e) {}
}

function getPassword(type) { return loadedPasswords[type] || AUTH_DEFAULTS[type]; }
function checkPassword(type, input) { return input === getPassword(type); }

function sessionSetAuth(role, alliance) {
  try {
    sessionStorage.setItem('auth_role', role);
    if (alliance) sessionStorage.setItem('auth_alliance', alliance);
  } catch(e) {}
}
function sessionGetAuth() {
  try {
    return {
      role: sessionStorage.getItem('auth_role'),
      alliance: sessionStorage.getItem('auth_alliance')
    };
  } catch(e) { return {}; }
}

// Role checks
function isAdmin()       { return AUTH.role === 'admin'; }
function isR4R5()        { return AUTH.role === 'r4r5' || isAdmin(); }
function isRallyLeader() { return AUTH.role === 'rallyleader' || isR4R5(); }
function isMember()      { return AUTH.role === 'member' || isRallyLeader(); }

function msCanAccessResults() {
  return typeof AUTH !== 'undefined' && isR4R5();
}

function msShowAdminActions() {
  const guard = document.getElementById('msAdminGuard');
  const actions = document.getElementById('msAdminActions');
  if (guard) guard.style.display = 'none';
  if (actions) actions.style.display = 'block';
  msUpdateDeadlineBanners();
}

function msInitResultsTab() {
  if (msCanAccessResults()) {
    msShowAdminActions();
  } else {
    const guard = document.getElementById('msAdminGuard');
    const actions = document.getElementById('msAdminActions');
    if (guard) guard.style.display = 'block';
    if (actions) actions.style.display = 'none';
  }
}

function msUnlockAdmin() {
  const input = document.getElementById('msAdminPwInput');
  const err = document.getElementById('msAdminPwErr');
  if (!input) return;
  if (checkPassword('admin', input.value)) {
    AUTH.adminUnlocked = true;
    sessionSetAuth('admin');
    msShowAdminActions();
  } else {
    if (err) { err.style.display = 'block'; setTimeout(() => err.style.display = 'none', 2000); }
  }
}

// ════════════════════════════════════════════════════════
// LANDING PAGE FLOW
// ════════════════════════════════════════════════════════

// Step state for landing
let _landingStep = 'entry'; // 'entry' | 'alliance' | 'password'
let _landingPwType = null;  // 'rallyleader' | 'r4r5'

function toggleLandingPassword() {}  // no longer needed, kept for compat

// Member: Player ID verified → show alliance picker → enter


// ── localStorage helpers — remember player across sessions ──
function lsSet(key, val) { try { localStorage.setItem('ks1057_' + key, JSON.stringify(val)); } catch(e) {} }
function lsGet(key) { try { const v = localStorage.getItem('ks1057_' + key); return v ? JSON.parse(v) : null; } catch(e) { return null; } }
function lsClear(key) { try { localStorage.removeItem('ks1057_' + key); } catch(e) {} }

// ── Check KV for stored alliance ──
function _checkStoredAlliance(playerId, cb) {
  fetch('/player-alliance?id=' + encodeURIComponent(playerId))
    .then(r => r.json())
    .then(d => cb(d.alliance || null))
    .catch(() => cb(null));
}

function _showAlliancePicker(nextStep) {
  document.getElementById('landingStepEntry').style.display = 'none';
  document.getElementById('landingStepAlliance').style.display = 'block';
  document.getElementById('landingStepPassword').style.display = 'none';
  document.getElementById('allianceNextStep').dataset.next = nextStep;
  const guide = document.getElementById('landingGuide');
  if (guide) guide.style.display = 'none';
}

function _showPasswordField() {
  document.getElementById('landingStepEntry').style.display = 'none';
  document.getElementById('landingStepAlliance').style.display = 'none';
  document.getElementById('landingStepPassword').style.display = 'block';
  document.getElementById('landingPwLabel').textContent = 'Enter your password';
  const guide = document.getElementById('landingGuide');
  if (guide) guide.style.display = 'none';
  setTimeout(() => { const i = document.getElementById('landingPwInput'); if(i) i.focus(); }, 100);
}

// ── Button 1: Enter as Member ──
function landingEnterMember() {
  if (!verifiedPlayer) return;
  _checkStoredAlliance(verifiedPlayer.id, (stored) => {
    if (stored) {
      AUTH.alliance = stored;
      _registerAndEnter('member', stored);
    } else {
      _showAlliancePicker('member');
    }
  });
}

// ── Button 2: I have a password ──
function landingStartWithPassword() {
  if (!verifiedPlayer) { toast('Verify your Player ID first.'); return; }
  // Check if alliance already stored — password users may still need it (for R4/R5)
  _checkStoredAlliance(verifiedPlayer.id, (stored) => {
    AUTH.alliance = stored || null;
    if (!stored) {
      _showAlliancePicker('password');
    } else {
      _showPasswordField();
    }
  });
}

// ── Legacy stubs (no longer used but kept for compat) ──
function landingStartR4R5() { landingStartWithPassword(); }
function landingStartRallyLeader() { landingStartWithPassword(); }

function landingConfirmAlliance() {
  const sel = document.getElementById('alliancePicker').value;
  if (!sel) { toast('Please select your alliance.'); return; }
  AUTH.alliance = sel;
  const next = document.getElementById('allianceNextStep').dataset.next;
  if (next === 'member') {
    _registerAndEnter('member', sel);
  } else if (next === 'password') {
    _showPasswordField();
  }
}

// ── Player lookup ──
let verifiedPlayer = null;

async function doPlayerLookup(playerId) {
  try {
    const res = await fetch('/kingshot-player?id=' + encodeURIComponent(playerId));
    const data = await res.json();
    if (data.status === 'success' && data.data) return data.data;
  } catch(e) {}
  return null;
}

async function lookupPlayer() {
  const idEl = document.getElementById('landingPlayerId');
  const resultEl = document.getElementById('playerLookupResult');
  const roleButtons = document.getElementById('landingRoleButtons');
  const btn = document.getElementById('lookupBtn');
  if (!idEl) return;
  const id = idEl.value.trim();
  if (!id) { if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<div style="color:var(--enemy);font-size:13px">Enter your Player ID first.</div>'; } return; }

  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  if (resultEl) resultEl.style.display = 'none';
  if (roleButtons) roleButtons.style.display = 'none';

  const p = await doPlayerLookup(id);

  if (btn) { btn.disabled = false; btn.textContent = '🔍 Lookup'; }

  if (p) {
    const inKingdom = p.kingdom === 1057;
    const col = inKingdom ? 'var(--green)' : 'var(--enemy)';
    const msg = inKingdom ? '✅ Kingdom 1057 — verified' : '❌ Kingdom ' + p.kingdom + ' — not Kingdom 1057';
    if (resultEl) {
      resultEl.innerHTML = '<div style="display:flex;align-items:center;gap:10px;background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:10px 12px">' +
        (p.profilePhoto ? '<img src="' + p.profilePhoto + '" style="width:40px;height:40px;border-radius:50%;border:2px solid var(--border2);flex-shrink:0">' : '') +
        '<div><div style="font-weight:700">' + p.name + '</div>' +
        '<div style="font-size:11px;color:var(--text3)">Level ' + p.level + ' · ID: ' + p.playerId + '</div>' +
        '<div style="font-size:12px;font-weight:600;color:' + col + ';margin-top:2px">' + msg + '</div></div></div>';
      resultEl.style.display = 'block';
    }
    if (inKingdom) {
      verifiedPlayer = { id: p.playerId, name: p.name, kingdom: p.kingdom, level: p.level, avatar: p.profilePhoto };
      if (roleButtons) roleButtons.style.display = 'flex';
    }
  } else {
    if (resultEl) {
      resultEl.innerHTML = '<div style="color:var(--enemy);font-size:13px;padding:8px 0">⚠ Player not found. Check your ID and try again.</div>';
      resultEl.style.display = 'block';
    }
  }
}

// ── Navigation between landing steps ──
const ADMIN_PLAYER_ID = '158134757';

function landingBack(to) {
  ['Entry','Alliance','Password'].forEach(s => {
    const el = document.getElementById('landingStep' + s);
    if (el) el.style.display = 'none';
  });
  const target = document.getElementById('landingStep' + to.charAt(0).toUpperCase() + to.slice(1));
  if (target) target.style.display = 'block';
  // Show guide only on entry step
  const guide = document.getElementById('landingGuide');
  if (guide) guide.style.display = to === 'entry' ? 'block' : 'none';
}

// ── Password check — role from which password matches ──
// Admin ONLY allowed if Player ID = 158134757
async function landingCheckPassword() {
  const input = document.getElementById('landingPwInput');
  const errEl = document.getElementById('landingPwError');
  if (!input) return;
  const pw = input.value;
  await loadPasswords();

  let role = null;
  const pid = verifiedPlayer ? String(verifiedPlayer.id) : '';

  if (pid === ADMIN_PLAYER_ID && checkPassword('admin', pw)) role = 'admin';
  else if (checkPassword('r4r5', pw))        role = 'r4r5';
  else if (checkPassword('rallyleader', pw)) role = 'rallyleader';

  if (role) {
    const alliance = (role === 'rallyleader' || role === 'admin') ? null : AUTH.alliance;
    _registerAndEnter(role, alliance);
  } else {
    if (errEl) { errEl.style.display = 'block'; errEl.textContent = role === null && pid !== ADMIN_PLAYER_ID && pw === getPassword('admin') ? 'Admin access requires the correct Player ID.' : 'Incorrect password.'; }
    input.value = '';
    input.focus();
    setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 3000);
  }
}

function _registerAndEnter(role, alliance) {
  if (verifiedPlayer) {
    try { sessionStorage.setItem('verifiedPlayer', JSON.stringify(verifiedPlayer)); } catch(e) {}
    // Persist to localStorage so next visit skips the form
    lsSet('player', { id: verifiedPlayer.id, name: verifiedPlayer.name, kingdom: verifiedPlayer.kingdom, avatar: verifiedPlayer.avatar });
    lsSet('alliance', alliance);
    lsSet('role', role);
    // Register in KV
    fetch('/register-player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: verifiedPlayer.id, name: verifiedPlayer.name, kingdom: verifiedPlayer.kingdom, alliance, role })
    }).catch(() => {});
  }
  AUTH.role = role;
  AUTH.alliance = alliance;
  sessionSetAuth(role, alliance);
  enterApp(role);
}

// ════════════════════════════════════════════════════════
// ENTER APP — show/hide tabs by role
// ════════════════════════════════════════════════════════
function enterApp(role) {
  AUTH.role = role;
  document.getElementById('page-landing').style.display = 'none';
  document.getElementById('mainNav').style.display = '';

  // Tab visibility by role
  const coordTabs = ['coordinator','strategy','setup'];
  coordTabs.forEach(id => {
    const tab = document.querySelector('.nav > .tab[onclick*="' + id + '"]');
    if (tab) tab.style.display = isRallyLeader() ? '' : 'none';
  });
  ['tabSwordland','tabTrialliance'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (isR4R5() || AUTH.role === 'rallyleader' || AUTH.role === 'member') ? '' : 'none';
  });
  const adminTab = document.getElementById('tabAdmin');
  if (adminTab) adminTab.style.display = isAdmin() ? '' : 'none';

  // Show user bar
  const stored = verifiedPlayer || (() => { try { const s = sessionStorage.getItem('verifiedPlayer'); return s ? JSON.parse(s) : null; } catch(e) { return null; } })();
  showUserBar(stored, role);

  // Default page
  if (role === 'member') showPageDirect('minister');
  else if (role === 'rallyleader') showPageDirect('coordinator');
  else if (role === 'r4r5') showPageDirect('coordinator');
  else showPageDirect('coordinator');
}

function showPage(p) { showPageDirect(p); }

function showPageDirect(p) {
  document.querySelectorAll('.page').forEach(e => e.classList.remove('active'));
  const pg = document.getElementById('page-' + p);
  if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav > .tab').forEach(e => e.classList.remove('active'));
  const activeTab = document.querySelector('.nav > .tab[onclick*="' + p + '"]');
  if (activeTab) activeTab.classList.add('active');
  if (p === 'strategy')    { if (typeof renderBattleStrategy==='function') renderBattleStrategy(); bsTickClock(); }
  if (p === 'setup')       { if (typeof renderSetup==='function') renderSetup(); }
  if (p === 'coordinator') { if (typeof renderLeaderTable==='function') renderLeaderTable(); }
  if (p === 'minister')    { if (typeof msInit==='function') { msInit(); msRenderStepTabs(); msInitResultsTab(); } }
  if (p === 'swordland')   { renderAttendance('sw'); }
  if (p === 'trialliance') { renderAttendance('ta'); }
  if (p === 'admin') {
    adminRefreshPasswordDisplay();
    adminLoadGiftLog();
    adminLoadMembers();
  }
}

// ════════════════════════════════════════════════════════
// SESSION RESTORE
// ════════════════════════════════════════════════════════
async function initApp() {
  await loadPasswords();

  // Try session first (same tab/window)
  const { role, alliance } = sessionGetAuth();
  if (role) {
    AUTH.role = role;
    AUTH.alliance = alliance || null;
    try { verifiedPlayer = JSON.parse(sessionStorage.getItem('verifiedPlayer')); } catch(e) {}
    enterApp(role);
    return;
  }

  // Try localStorage (returning visitor on new tab/session)
  const savedPlayer = lsGet('player');
  const savedAlliance = lsGet('alliance');
  const savedRole = lsGet('role');

  if (savedPlayer && savedPlayer.kingdom === 1057) {
    verifiedPlayer = { ...savedPlayer, avatar: savedPlayer.avatar || null };
    // Only auto-enter as member — password roles must re-enter password for security
    if (savedRole === 'member' && savedAlliance) {
      AUTH.role = 'member';
      AUTH.alliance = savedAlliance;
      sessionSetAuth('member', savedAlliance);
      enterApp('member');
      return;
    }
    // For password roles: pre-fill their Player ID and skip the lookup step
    const landingPwInput = document.getElementById('landingPlayerId');
    if (landingPwInput && savedPlayer.id) {
      landingPwInput.value = savedPlayer.id;
      // Auto-run the lookup to show their profile
      lookupPlayer();
    }
  }

  const lp = document.getElementById('page-landing');
  const mn = document.getElementById('mainNav');
  if (lp) lp.style.display = 'flex';
  if (mn) mn.style.display = 'none';
}

// ════════════════════════════════════════════════════════
// ADMIN PANEL
// ════════════════════════════════════════════════════════
function adminRefreshPasswordDisplay() {
  [
    ['currentRallyPw', 'rallyleader'],
    ['currentR4R5Pw', 'r4r5'],
    ['currentAdminPw', 'admin']
  ].forEach(([id, type]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = getPassword(type);
  });
}

// bsRenderResults — called when rally duration dropdown changes
function bsRenderResults() {
  if (typeof renderBattleStrategy === 'function') renderBattleStrategy();
  if (BS_CALC && BS_CALC.offsetSec !== null && BS_CALC.selectedTeamId !== null) {
    bsCalcTeam(BS_CALC.selectedTeamId, BS_CALC.offsetSec, false);
  }
}

async function adminRedeemNow() {
  const statusEl = document.getElementById('giftRedeemStatus');
  const logEl = document.getElementById('giftRedeemLog');
  if (statusEl) statusEl.textContent = '⏳ Redeeming… this may take a minute.';
  try {
    const res = await fetch('/admin-redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey: getPassword('admin') })
    });
    const data = await res.json();
    if (statusEl) statusEl.textContent = data.message || 'Done.';
    adminLoadGiftLog();
  } catch(e) {
    if (statusEl) statusEl.textContent = '⚠ Error: ' + e.message;
  }
}

async function adminLoadGiftLog() {
  const logEl = document.getElementById('giftRedeemLog');
  if (!logEl) return;
  try {
    const res = await fetch('/gift-log');
    const data = await res.json();
    if (!data.log || !data.log.length) {
      logEl.innerHTML = '<div style="color:var(--text3)">No redemptions yet.</div>';
      return;
    }
    logEl.innerHTML = data.log.slice().reverse().map(entry =>
      '<div style="border-bottom:1px solid var(--border);padding:6px 0;font-size:12px">' +
      '<span style="color:var(--text3)">' + entry.time + '</span> ' +
      '<strong>' + (entry.code || '—') + '</strong> — ' +
      (entry.results || []).map(r =>
        '<span style="color:' + (r.ok ? 'var(--green)' : 'var(--enemy)') + '">' +
        r.name + ' (' + (r.ok ? '✓' : r.err || 'fail') + ')</span>'
      ).join(', ') +
      '</div>'
    ).join('');
  } catch(e) {
    logEl.innerHTML = '<div style="color:var(--enemy)">Could not load log.</div>';
  }
}

async function adminChangePassword(type) {
  const inputId = { rallyleader:'newRallyPw', r4r5:'newR4R5Pw', admin:'newAdminPw' }[type];
  const displayId = { rallyleader:'currentRallyPw', r4r5:'currentR4R5Pw', admin:'currentAdminPw' }[type];
  const newPw = document.getElementById(inputId).value.trim();
  if (!newPw) { toast('Enter a password first.'); return; }
  const res = await fetch('/state', { cache: 'no-store' });
  const data = res.ok ? await res.json() : {};
  data['pw_' + type] = newPw;
  await fetch('/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  loadedPasswords[type] = newPw;
  document.getElementById(inputId).value = '';
  const el = document.getElementById(displayId);
  if (el) el.textContent = newPw;
  toast('Password updated.');
}

async function adminLoadMembers() {
  const el = document.getElementById('adminMemberList');
  if (!el) return;
  try {
    const res = await fetch('/player-list');
    const data = await res.json();
    const players = Object.values(data.players || {});
    if (!players.length) { el.innerHTML = '<div style="color:var(--text3)">No registered players yet.</div>'; return; }
    // Group by alliance
    const byAlliance = {};
    players.forEach(p => {
      const a = p.alliance || 'Unknown';
      if (!byAlliance[a]) byAlliance[a] = [];
      byAlliance[a].push(p);
    });
    let html = '';
    Object.keys(byAlliance).sort().forEach(alliance => {
      html += '<div style="margin-bottom:16px">';
      html += '<div class="sec-title" style="margin-bottom:8px">' + alliance + ' <span style="color:var(--text3);font-weight:400">(' + byAlliance[alliance].length + ')</span></div>';
      html += '<table style="min-width:500px"><thead><tr><th>IGN</th><th>Player ID</th><th>Role</th><th>Alliance</th><th></th></tr></thead><tbody>';
      html += byAlliance[alliance].map(p => {
        const roleLabel = { admin:'⚙️ Admin', r4r5:'🛡 R4/R5', rallyleader:'⚔️ Rally Leader', member:'👤 Member' }[p.role] || '👤 Member';
        const allianceOpts = ALLIANCES.map(a => '<option value="' + a + '"' + (a === p.alliance ? ' selected' : '') + '>' + a + '</option>').join('');
        return '<tr>' +
          '<td><strong>' + p.name + '</strong></td>' +
          '<td class="mono" style="color:var(--text3)">' + p.id + '</td>' +
          '<td>' + roleLabel + '</td>' +
          '<td><select onchange="adminChangeAlliance(\\'' + p.id + '\\',this.value)" style="width:80px">' + allianceOpts + '</select></td>' +
          '<td><button class="btn btn-danger btn-sm" onclick="adminRemovePlayer(\\'' + p.id + '\\')">✕</button></td>' +
          '</tr>';
      }).join('');
      html += '</tbody></table></div>';
    });
    el.innerHTML = '<div style="overflow-x:auto">' + html + '</div>';
  } catch(e) { el.innerHTML = '<div style="color:var(--enemy)">Error loading members.</div>'; }
}

async function adminChangeAlliance(playerId, newAlliance) {
  try {
    await fetch('/update-player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: playerId, alliance: newAlliance }) });
    toast('Alliance updated.');
  } catch(e) { toast('Error updating alliance.'); }
}

async function adminRemovePlayer(playerId) {
  if (!confirm('Remove this player? They will need to re-register.')) return;
  try {
    await fetch('/remove-player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: playerId }) });
    toast('Player removed.');
    adminLoadMembers();
  } catch(e) { toast('Error removing player.'); }
}

async function adminReset(what) {
  if (!confirm('Are you sure? This cannot be undone.')) return;
  if (what === 'ministers' || what === 'all') { MS.submissions = []; MS._lastAllocation = null; }
  if (what === 'leaders' || what === 'all') { S.leaders = []; if (typeof renderLeaderTable==='function') renderLeaderTable(); }
  if (what === 'teams' || what === 'all') { S.teams = []; if (typeof renderSetup==='function') renderSetup(); if (typeof renderBattleStrategy==='function') renderBattleStrategy(); }
  if (what === 'attendance' || what === 'all') { ATT.sw = { members:[], events:[] }; ATT.ta = { members:[], events:[] }; }
  syncQueuePush();
  toast('Reset complete.');
}

// ════════════════════════════════════════════════════════
// ════════════ ATTENDANCE DATA ════════════
const ATT = {
  sw: { events: [] },
  ta: { events: [] }
};
// Event structure:
// { id, name, date, alliance, signedUp: [{id,name}], showedUp: [{id,name}] }

// ════════════ SUB-TABS (register / summary) ════════════
function attSwitchTab(prefix, tab) {
  ['register','summary'].forEach(t => {
    const panel = document.getElementById(prefix + 'Panel-' + t);
    const btn = document.getElementById(prefix + 'Tab-' + t);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
    if (btn) {
      btn.className = t === tab ? 'btn' : 'btn btn-ghost';
      btn.style.background = t === tab ? 'rgba(61,142,240,.2)' : '';
      btn.style.color = t === tab ? 'var(--accent2)' : '';
      btn.style.border = t === tab ? '1px solid var(--accent)' : '';
    }
  });
  if (tab === 'summary') renderAttSummary(prefix);
  if (tab === 'register') renderAttEventList(prefix);
}

function renderAttendance(prefix) {
  attSwitchTab(prefix, 'register');
}

// ════════════ CREATE EVENT ════════════
function attAddEvent(prefix) {
  const nameEl = document.getElementById(prefix + 'EventName');
  const dateEl = document.getElementById(prefix + 'EventDate');
  const name = nameEl ? nameEl.value.trim() : '';
  const date = dateEl ? dateEl.value : '';
  if (!name) { toast('Enter an event name.'); return; }
  const alliance = (typeof AUTH !== 'undefined' && AUTH.alliance) ? AUTH.alliance : 'ALL';
  ATT[prefix].events.push({
    id: uid(), name, alliance,
    date: date || new Date().toLocaleDateString('en-GB'),
    signedUp: [], showedUp: []
  });
  nameEl.value = '';
  if (dateEl) dateEl.value = '';
  renderAttEventList(prefix);
  syncQueuePush();
  toast('Event created.');
}

function attRemoveEvent(prefix, eventId) {
  if (!confirm('Delete this event?')) return;
  ATT[prefix].events = ATT[prefix].events.filter(e => e.id !== eventId);
  renderAttEventList(prefix);
  syncQueuePush();
}

// ════════════ EVENT LIST ════════════
function renderAttEventList(prefix) {
  const el = document.getElementById(prefix + 'EventList');
  if (!el) return;
  const store = ATT[prefix];
  const userAlliance = (typeof AUTH !== 'undefined') ? AUTH.alliance : null;
  const isAdminOrR4 = typeof isR4R5 === 'function' ? isR4R5() : false;
  const isAdm = typeof isAdmin === 'function' ? isAdmin() : false;

  // Filter events by alliance (non-admins only see own alliance)
  const events = isAdm ? store.events :
    store.events.filter(e => !e.alliance || e.alliance === 'ALL' || e.alliance === userAlliance);

  if (!events.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:12px 0">No events yet. Create one above.</div>';
    return;
  }

  el.innerHTML = events.map(evt => {
    const signedCount = (evt.signedUp||[]).length;
    const showedCount = (evt.showedUp||[]).length;
    const canEdit = isAdm || isAdminOrR4;
    const delBtn = canEdit ? '<button class="btn btn-danger btn-sm" onclick="attRemoveEvent(\\'' + prefix + '\\',\\'' + evt.id + '\\')">🗑</button>' : '';

    return '<div class="card" style="margin-bottom:12px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
      '<div><div class="card-title" style="margin:0">' + evt.name + '</div>' +
      '<div style="font-size:12px;color:var(--text3);margin-top:2px">' + evt.date +
      (evt.alliance ? ' · ' + evt.alliance : '') +
      ' · <span style="color:var(--accent2)">' + signedCount + ' signed up</span>' +
      ' · <span style="color:var(--green)">' + showedCount + ' showed up</span></div></div>' +
      delBtn + '</div>' +
      attRenderEventTabs(prefix, evt, canEdit) +
      '</div>';
  }).join('');
}

function attRenderEventTabs(prefix, evt, canEdit) {
  const tabId = prefix + '_' + evt.id;
  return '<div>' +
    '<div style="display:flex;gap:6px;margin-bottom:10px">' +
    '<button class="btn btn-sm" id="etab-su-' + tabId + '" onclick="attShowEventTab(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'signedUp\\')" ' +
    'style="background:rgba(61,142,240,.2);color:var(--accent2);border:1px solid var(--accent)">📋 Signed Up (' + (evt.signedUp||[]).length + ')</button>' +
    '<button class="btn btn-ghost btn-sm" id="etab-sh-' + tabId + '" onclick="attShowEventTab(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'showedUp\\')">✅ Showed Up (' + (evt.showedUp||[]).length + ')</button>' +
    '</div>' +
    '<div id="epanel-su-' + tabId + '">' + attRenderEventPanel(prefix, evt, 'signedUp', canEdit) + '</div>' +
    '<div id="epanel-sh-' + tabId + '" style="display:none">' + attRenderEventPanel(prefix, evt, 'showedUp', canEdit) + '</div>' +
    '</div>';
}

function attShowEventTab(prefix, eventId, panel) {
  const tabId = prefix + '_' + eventId;
  ['signedUp','showedUp'].forEach(p => {
    const pEl = document.getElementById('epanel-' + (p==='signedUp'?'su':'sh') + '-' + tabId);
    const tEl = document.getElementById('etab-' + (p==='signedUp'?'su':'sh') + '-' + tabId);
    if (pEl) pEl.style.display = p === panel ? 'block' : 'none';
    if (tEl) {
      tEl.className = p === panel ? 'btn btn-sm' : 'btn btn-ghost btn-sm';
      tEl.style.background = p === panel ? 'rgba(61,142,240,.2)' : '';
      tEl.style.color = p === panel ? 'var(--accent2)' : '';
      tEl.style.border = p === panel ? '1px solid var(--accent)' : '';
    }
  });
}

function attRenderEventPanel(prefix, evt, field, canEdit) {
  const list = (evt[field]||[]);
  const label = field === 'signedUp' ? 'Legion Combatants (Join/Voted names)' : 'Battlefield Details (Ally tab names)';
  const hint = field === 'signedUp'
    ? 'Upload a screenshot of Legion Combatants — names with Join or Voted will be extracted.'
    : 'Upload a screenshot of Battlefield Details — switch to the Ally tab first, then screenshot.';

  let html = '';
  // Name list
  if (list.length) {
    html += '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:10px;max-height:180px;overflow-y:auto">';
    html += list.map((m,i) =>
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 6px;border-bottom:1px solid var(--border)">' +
      '<span>' + m.name + '</span>' +
      (canEdit ? '<button class="btn btn-danger btn-sm" style="padding:2px 6px" onclick="attRemoveName(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'' + field + '\\',' + i + ')">✕</button>' : '') +
      '</div>'
    ).join('');
    html += '</div>';
  } else {
    html += '<div style="color:var(--text3);font-size:12px;margin-bottom:10px">No names yet.</div>';
  }

  if (canEdit) {
    html += '<div style="font-size:11px;color:var(--text2);margin-bottom:8px">📸 ' + hint + '</div>';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">';
    html += '<input type="file" accept="image/*" multiple style="display:none" id="ocrFile-' + prefix + '-' + evt.id + '-' + field + '" onchange="attRunOCR(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'' + field + '\\',this)">';
    html += '<button class="btn btn-primary btn-sm" onclick="document.getElementById(\\'ocrFile-' + prefix + '-' + evt.id + '-' + field + '\\').click()">📸 Scan Screenshot</button>';
    html += '</div>';
    // Manual add
    html += '<div style="display:flex;gap:6px">' +
      '<input type="text" id="manualName-' + prefix + '-' + evt.id + '-' + field + '" placeholder="Add name manually" style="flex:1;min-width:0" ' +
      'onkeydown="if(event.key===\\'Enter\\')attAddManualName(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'' + field + '\\')">' +
      '<button class="btn btn-ghost btn-sm" onclick="attAddManualName(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'' + field + '\\')">+ Add</button>' +
      '</div>';
    // OCR preview
    html += '<div id="ocrPreview-' + prefix + '-' + evt.id + '-' + field + '" style="display:none;margin-top:10px"></div>';
  }

  return html;
}

// ════════════ NAME MANAGEMENT ════════════
function attRemoveName(prefix, eventId, field, idx) {
  const evt = ATT[prefix].events.find(e => e.id === eventId);
  if (evt) { evt[field].splice(idx, 1); renderAttEventList(prefix); syncQueuePush(); }
}

function attAddManualName(prefix, eventId, field) {
  const inputEl = document.getElementById('manualName-' + prefix + '-' + eventId + '-' + field);
  const name = inputEl ? inputEl.value.trim() : '';
  if (!name) return;
  const evt = ATT[prefix].events.find(e => e.id === eventId);
  if (!evt) return;
  if (evt[field].find(m => m.name.toLowerCase() === name.toLowerCase())) { toast('Already in list.'); return; }
  evt[field].push({ id: uid(), name });
  if (inputEl) inputEl.value = '';
  renderAttEventList(prefix);
  syncQueuePush();
}

// ════════════ OCR FOR NAMES ════════════
async function attRunOCR(prefix, eventId, field, fileInput) {
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;
  const previewEl = document.getElementById('ocrPreview-' + prefix + '-' + eventId + '-' + field);
  if (previewEl) { previewEl.style.display = 'block'; previewEl.innerHTML = '<div style="color:var(--text3);font-size:12px">🔍 Scanning ' + files.length + ' image(s)…</div>'; }
  try {
    if (typeof Tesseract === 'undefined') throw new Error('OCR not loaded');
    let allNames = [];
    if (field === 'signedUp') {
      // Use canvas crop approach for Legion Combatants screen
      for (const file of files) {
        const names = await parseSignedUpNamesFromCanvas(file);
        names.forEach(n => { if (!allNames.includes(n)) allNames.push(n); });
      }
    } else {
      // Standard OCR for Battlefield Details
      const worker = await Tesseract.createWorker({ logger: () => {} });
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      for (const file of files) {
        const { data: { text } } = await worker.recognize(file);
        const names = parseShowedUpNames(text);
        names.forEach(n => { if (!allNames.includes(n)) allNames.push(n); });
      }
      await worker.terminate();
    }
    if (!allNames.length) {
      if (previewEl) previewEl.innerHTML = '<div style="color:var(--enemy);font-size:12px">⚠ No names detected. Try adding manually.</div>';
      return;
    }
    const evt = ATT[prefix].events.find(e => e.id === eventId);
    const existing = (evt ? evt[field] : []).map(m => m.name.toLowerCase());
    const newNames = allNames.filter(n => !existing.includes(n.toLowerCase()));
    const dupNames = allNames.filter(n => existing.includes(n.toLowerCase()));
    if (previewEl) {
      let h = '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:12px">';
      h += '<div style="font-weight:600;margin-bottom:8px">Found ' + allNames.length + ' name(s) — ' + newNames.length + ' new:</div>';
      h += '<div style="max-height:160px;overflow-y:auto;margin-bottom:10px">';
      newNames.forEach(n => { h += '<div style="padding:2px 0;color:var(--green)">+ ' + n + '</div>'; });
      if (dupNames.length) dupNames.forEach(n => { h += '<div style="padding:2px 0;color:var(--text3)">↩ ' + n + ' (already added)</div>'; });
      h += '</div>';
      if (newNames.length) {
        const safeNames = encodeURIComponent(JSON.stringify(newNames));
        h += '<button class="btn btn-primary btn-sm" onclick="attConfirmOCR(\\''+prefix+'\\',\\''+eventId+'\\',\\''+field+'\\',\\''+safeNames+'\\')">✅ Add ' + newNames.length + ' name(s)</button> ';
      }
      h += '<button class="btn btn-ghost btn-sm" onclick="this.parentElement.style.display=\\'none\\'">Cancel</button></div>';
      previewEl.innerHTML = h;
    }
  } catch(e) {
    if (previewEl) previewEl.innerHTML = '<div style="color:var(--enemy);font-size:12px">⚠ OCR error: ' + e.message + '</div>';
  }
}

function attConfirmOCR(prefix, eventId, field, encodedNames) {
  try {
    const names = JSON.parse(decodeURIComponent(encodedNames));
    const evt = ATT[prefix].events.find(e => e.id === eventId);
    if (!evt) return;
    names.forEach(name => {
      if (!evt[field].find(m => m.name.toLowerCase() === name.toLowerCase())) {
        evt[field].push({ id: uid(), name });
      }
    });
    renderAttEventList(prefix);
    syncQueuePush();
    toast(names.length + ' name(s) added!');
  } catch(e) { toast('Error adding names.'); }
}

// ── Parse Legion Combatants screen (Signed Up) ──
// Uses PSM 11 (sparse text) which correctly reads "Join" and "No" as separate lines.
// Rule: find player name lines, then look ahead for "Join" or "No" within 6 lines.
// Canvas crops the left 18% (avatars) to reduce noise.
async function parseSignedUpNamesFromCanvas(imageFile) {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      const W = img.naturalWidth, H = img.naturalHeight;
      const cropX = Math.floor(W * 0.18);
      canvas.width = W - cropX;
      canvas.height = H;
      canvas.getContext('2d').drawImage(img, -cropX, 0);
      canvas.toBlob(async (blob) => {
        try {
          if (typeof Tesseract === 'undefined') { resolve([]); return; }
          const worker = await Tesseract.createWorker({ logger: () => {} });
          await worker.loadLanguage('eng');
          await worker.initialize('eng');
          await worker.setParameters({ tessedit_pageseg_mode: '11' });
          const { data: { text } } = await worker.recognize(blob);
          await worker.terminate();
          resolve(parseSignedUpNames(text));
        } catch(e) { resolve([]); }
      }, 'image/png');
    };
    img.src = URL.createObjectURL(imageFile);
  });
}

function parseSignedUpNames(text) {
  const lines = text.split(/\\n/).map(l => l.trim()).filter(Boolean);

  const HEADER  = /combatant|30\\/|2\\/10|squad|power|substitute|ph\\s*join/i;
  const JOIN_RE = /^join$/i;
  const NO_RE   = /^no$/i;
  const POWER   = /\\d{3,}/;
  const NOISE_W = /^(voted|join|no|substitute|squad|power|legion|engagements|dispatched|combatants?|oye|ones|siae|fa|sl|aa|y|f|r|w|pe|bg|ie|sy|sif|par|bn|rr|ic|fe|be|or|le|the)$/i;
  const WORD_RE = /^[A-Za-z][A-Za-z0-9_\\-]{2,}$/;

  function extractName(line) {
    const clean = line.replace(/^[^A-Za-z]+/, '');
    const words = clean.split(/\\s+/).filter(w => WORD_RE.test(w) && !NOISE_W.test(w));
    return words.length ? words.join(' ') : null;
  }

  function isPlayerLine(line) {
    const name = extractName(line);
    return name && !HEADER.test(line) && !JOIN_RE.test(line) && !NO_RE.test(line) && !POWER.test(line);
  }

  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isPlayerLine(line)) continue;
    const name = extractName(line);
    if (!name) continue;

    let status = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const ahead = lines[j].trim();
      if (JOIN_RE.test(ahead)) { status = 'join'; break; }
      if (NO_RE.test(ahead))   { status = 'no';   break; }
      if (isPlayerLine(ahead)) break;
    }
    if (status) results.push({ name, status });
  }

  const seen = new Set();
  return results
    .filter(r => r.status === 'join' && !seen.has(r.name) && seen.add(r.name))
    .map(r => r.name);
}


// ── Parse Battlefield Details screen (Showed Up) ──
// The ally tab shows: rank number | avatar | name | points
// We extract names by stripping leading numbers, trailing numbers, known UI text
function parseShowedUpNames(text) {
  const lines = text.split(/\\n/).map(l => l.trim()).filter(Boolean);
  const SKIP_RE = /^(ranking|governor|personal\\s*relic|ally|enemy|battlefield|leave|rules|vs|\\d+\\/\\d+|\\+\\d+\\/m|squad\\s*power)/i;
  const NUMBER_RE = /^[\\d,./]+$/;
  const names = [];

  lines.forEach(line => {
    if (SKIP_RE.test(line) || NUMBER_RE.test(line.replace(/,/g,''))) return;
    // Strip leading rank number and trailing points number
    let cleaned = line
      .replace(/^\\d+\\s*/, '')           // leading rank
      .replace(/[\\d,]+\\s*$/, '')        // trailing points
      .replace(/\\[.*?\\]/g, '')          // [ALLIANCE] tags
      .replace(/[⚔🛡👑✅🏆⚡💪🔥]/g, '') // game icons
      .trim();
    const clean = cleanName(cleaned);
    if (clean && clean.length >= 2 && !names.includes(clean)) names.push(clean);
  });
  return names;
}

function cleanName(s) {
  return s.replace(/[^\\w\\sÀ-ÿ\\-_.*~∾≺≻]/g, '').replace(/\\s+/g, ' ').trim();
}

// ════════════ SUMMARY ════════════
// ── Fuzzy name similarity (Levenshtein distance) ──
function nameSimilarity(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const dp = Array.from({length: la+1}, (_,i) => Array.from({length: lb+1}, (_,j) => i ? j ? 0 : i : j));
  for (let i=1;i<=la;i++) for (let j=1;j<=lb;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return 1 - dp[la][lb] / Math.max(la, lb);
}

// Find near-matches between signedUp and showedUp lists (similarity >= 0.75 but not exact)
function findMismatches(signedUp, showedUp) {
  const mismatches = [];
  signedUp.forEach(su => {
    const exactMatch = showedUp.find(sh => sh.name.toLowerCase() === su.name.toLowerCase());
    if (!exactMatch) {
      // Find closest match in showedUp
      let bestMatch = null, bestScore = 0;
      showedUp.forEach(sh => {
        const score = nameSimilarity(su.name, sh.name);
        if (score > bestScore && score >= 0.75) { bestScore = score; bestMatch = sh; }
      });
      if (bestMatch) mismatches.push({ suName: su.name, shName: bestMatch.name, score: bestScore });
    }
  });
  return mismatches;
}

function attMergeName(prefix, eventId, fromName, toName) {
  const evt = ATT[prefix].events.find(e => e.id === eventId);
  if (!evt) return;
  // Rename all occurrences of fromName in both lists to toName
  ['signedUp','showedUp'].forEach(field => {
    evt[field].forEach(m => { if (m.name === fromName) m.name = toName; });
  });
  renderAttSummary(prefix);
  syncQueuePush();
  toast('Names merged: "' + fromName + '" → "' + toName + '"');
}

function renderAttSummary(prefix) {
  const el = document.getElementById(prefix + 'SummaryContent');
  if (!el) return;
  const store = ATT[prefix];
  const userAlliance = (typeof AUTH !== 'undefined') ? AUTH.alliance : null;
  const isAdm = typeof isAdmin === 'function' ? isAdmin() : false;
  const events = isAdm ? store.events :
    store.events.filter(e => !e.alliance || e.alliance === 'ALL' || e.alliance === userAlliance);

  if (!events.length) { el.innerHTML = '<div style="color:var(--text3)">No events yet.</div>'; return; }

  // ── Mismatch warnings across all events ──
  let mismatchHTML = '';
  events.forEach(evt => {
    const mismatches = findMismatches(evt.signedUp||[], evt.showedUp||[]);
    if (mismatches.length) {
      mismatchHTML += '<div style="background:rgba(255,157,77,.08);border:1px solid rgba(255,157,77,.4);border-radius:7px;padding:12px 14px;margin-bottom:14px">';
      mismatchHTML += '<div style="font-weight:600;color:#ff9d4d;margin-bottom:8px">⚠ Possible name mismatches in <em>' + evt.name + '</em></div>';
      mismatchHTML += '<div style="font-size:12px;color:var(--text2)">These names look very similar but didn\\'t match exactly — likely OCR errors:</div>';
      mismatches.forEach(m => {
        const pct = Math.round(m.score * 100);
        mismatchHTML += '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">' +
          '<span class="mono" style="color:var(--enemy)">"' + m.suName + '"</span>' +
          '<span style="color:var(--text3)">vs</span>' +
          '<span class="mono" style="color:var(--green)">"' + m.shName + '"</span>' +
          '<span style="color:var(--text3);font-size:11px">(' + pct + '% similar)</span>' +
          '<button class="btn btn-gold btn-sm" onclick="attMergeName(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'' +
          m.suName.replace(/'/g,"\\\\'") + '\\',\\'' + m.shName.replace(/'/g,"\\\\'") + '\\')">' +
          'Merge → "' + m.shName + '"</button>' +
          '</div>';
      });
      mismatchHTML += '</div>';
    }
  });

  // ── Member attendance table ──
  const memberMap = {};
  events.forEach(evt => {
    (evt.signedUp||[]).forEach(m => {
      if (!memberMap[m.name]) memberMap[m.name] = { signedUp:0, showedUp:0 };
      memberMap[m.name].signedUp++;
    });
    (evt.showedUp||[]).forEach(m => {
      if (!memberMap[m.name]) memberMap[m.name] = { signedUp:0, showedUp:0 };
      memberMap[m.name].showedUp++;
    });
  });

  const members = Object.entries(memberMap).sort((a,b) => b[1].showedUp - a[1].showedUp);
  let html = mismatchHTML;
  html += '<div style="overflow-x:auto"><table style="min-width:400px"><thead><tr>' +
    '<th>Name</th><th>Signed Up</th><th>Showed Up</th><th>Attendance</th>' +
    '</tr></thead><tbody>';

  members.forEach(([name, s]) => {
    const pct = s.signedUp > 0 ? Math.round(s.showedUp / s.signedUp * 100) : 0;
    const col = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--enemy)';
    html += '<tr><td><strong>' + name + '</strong></td>' +
      '<td class="mono">' + s.signedUp + '</td>' +
      '<td class="mono">' + s.showedUp + '</td>' +
      '<td><span class="mono" style="color:' + col + ';font-weight:600">' + pct + '%</span></td></tr>';
  });
  html += '</tbody></table></div>';

  // ── Per-event breakdown ──
  html += '<div style="margin-top:16px"><div class="sec-title" style="margin-bottom:8px">Per Event</div>';
  events.forEach(evt => {
    const su = (evt.signedUp||[]).length;
    const sh = (evt.showedUp||[]).length;
    const absent = (evt.signedUp||[]).filter(m =>
      !(evt.showedUp||[]).find(s => s.name.toLowerCase() === m.name.toLowerCase()));
    html += '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:8px">' +
      '<div style="font-weight:600">' + evt.name + ' <span style="color:var(--text3);font-size:11px">' + evt.date + '</span></div>' +
      '<div style="font-size:12px;margin-top:6px;display:flex;flex-wrap:wrap;gap:10px">' +
      '<span>' + su + ' signed up</span>' +
      '<span style="color:var(--green)">✅ ' + sh + ' showed up</span>' +
      (absent.length ? '<span style="color:var(--enemy)">❌ ' + absent.length + ' absent: ' +
        absent.map(m => '<strong>' + m.name + '</strong>').join(', ') + '</span>' : '<span style="color:var(--green)">🎉 Full attendance!</span>') +
      '</div></div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

// EXTEND SYNC to include ATT data and passwords
// ════════════════════════════════════════════════════════
const _origSyncSerialize = syncSerialize;
syncSerialize = function() {
  const base = JSON.parse(_origSyncSerialize());
  if (typeof ATT !== 'undefined') { base.att_sw = ATT.sw; base.att_ta = ATT.ta; }
  if (typeof loadedPasswords !== 'undefined') {
    if (loadedPasswords.rallyleader) base.pw_rallyleader = loadedPasswords.rallyleader;
    if (loadedPasswords.r4r5) base.pw_r4r5 = loadedPasswords.r4r5;
    if (loadedPasswords.admin) base.pw_admin = loadedPasswords.admin;
  }
  return JSON.stringify(base);
};

const _origSyncApplyRemote = syncApplyRemote;
syncApplyRemote = function(data) {
  _origSyncApplyRemote(data);
  if (typeof ATT !== 'undefined') {
    if (data.att_sw) ATT.sw = data.att_sw;
    if (data.att_ta) ATT.ta = data.att_ta;
  }
  if (typeof loadedPasswords !== 'undefined') {
    if (data.pw_rallyleader) loadedPasswords.rallyleader = data.pw_rallyleader;
    if (data.pw_r4r5) loadedPasswords.r4r5 = data.pw_r4r5;
    if (data.pw_admin) loadedPasswords.admin = data.pw_admin;
  }
  const active = document.querySelector('.page.active');
  if (active && active.id === 'page-swordland') renderAttendance('sw');
  if (active && active.id === 'page-trialliance') renderAttendance('ta');
};

document.addEventListener('DOMContentLoaded', initApp);

</script>

<!-- ADMIN PAGE -->
<div id="page-admin" class="page">
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">⚙️ Admin Panel</div>
    <p style="color:var(--text2);font-size:13px">Full administrator access. Changes are saved to KV.</p>
  </div>
  <!-- Passwords -->
  <div class="grid2" style="margin-bottom:14px">
    <div class="card">
      <div class="card-title">⚔️ Rally Leader Password</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Current: <span class="mono" id="currentRallyPw" style="color:var(--gold)">loading…</span></div>
      <div class="row" style="margin-bottom:8px"><div class="field" style="flex:1"><label>New password</label><input type="password" id="newRallyPw" style="width:100%"></div></div>
      <button class="btn btn-primary btn-sm" onclick="adminChangePassword('rallyleader')">Save</button>
    </div>
    <div class="card">
      <div class="card-title">🛡 R4/R5 Password</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Current: <span class="mono" id="currentR4R5Pw" style="color:var(--gold)">loading…</span></div>
      <div class="row" style="margin-bottom:8px"><div class="field" style="flex:1"><label>New password</label><input type="password" id="newR4R5Pw" style="width:100%"></div></div>
      <button class="btn btn-primary btn-sm" onclick="adminChangePassword('r4r5')">Save</button>
    </div>
    <div class="card">
      <div class="card-title">⚙️ Admin Password</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Current: <span class="mono" id="currentAdminPw" style="color:var(--gold)">loading…</span></div>
      <div class="row" style="margin-bottom:8px"><div class="field" style="flex:1"><label>New password</label><input type="password" id="newAdminPw" style="width:100%"></div></div>
      <button class="btn btn-primary btn-sm" onclick="adminChangePassword('admin')">Save</button>
    </div>
  </div>
  <!-- Members by Alliance -->
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div class="card-title" style="margin:0">👥 Registered Members by Alliance</div>
      <button class="btn btn-ghost btn-sm" onclick="adminLoadMembers()">🔄 Refresh</button>
    </div>
    <div id="adminMemberList"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
  </div>
  <!-- Gift Code -->
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">🎁 Gift Code Auto-Redemption</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:14px">Redeems all active gift codes every 30 minutes for registered members.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <button class="btn btn-primary" onclick="adminRedeemNow()">🎁 Redeem Now for All Members</button>
      <button class="btn btn-ghost" onclick="adminLoadGiftLog()">📋 Refresh Log</button>
    </div>
    <div id="giftRedeemStatus" style="font-size:12px;color:var(--text3);margin-bottom:10px"></div>
    <div id="giftRedeemLog" style="font-size:12px;max-height:300px;overflow-y:auto"></div>
  </div>
  <!-- Reset -->
  <div class="card">
    <div class="card-title">🗑 Reset Data</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-danger" onclick="adminReset('ministers')">Reset All Minister Submissions</button>
      <button class="btn btn-danger" onclick="adminReset('leaders')">Reset All Rally Leaders</button>
      <button class="btn btn-danger" onclick="adminReset('teams')">Reset All Teams</button>
      <button class="btn btn-danger" onclick="adminReset('attendance')">Reset All Attendance</button>
      <button class="btn btn-danger" onclick="adminReset('all')">⚠️ Reset EVERYTHING</button>
    </div>
  </div>
</div>

<!-- SWORDLAND ATTENDANCE PAGE -->
<div id="page-swordland" class="page">
  <div class="card" style="margin-bottom:14px">
    <div class="card-title" style="font-size:20px">⚔️ Swordland Attendance</div>
    <p style="color:var(--text2);font-size:13px;margin-bottom:14px">Track attendance for Swordland events. R4/R5 manage events and mark attendance.</p>
    <div style="display:flex;gap:8px">
      <button class="btn" id="swTab-register" onclick="attSwitchTab('sw','register')" style="background:rgba(61,142,240,.2);color:var(--accent2);border:1px solid var(--accent)">📝 Register Attendance</button>
      <button class="btn btn-ghost" id="swTab-summary" onclick="attSwitchTab('sw','summary')">📊 Overall Summary</button>
    </div>
  </div>
  <!-- Register Attendance sub-tab -->
  <div id="swPanel-register">
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">📝 Register Attendance</div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:14px">Create an event, then add which members attended. R4/R5 only.</p>
      <div class="row">
        <div class="field"><label>Event name</label><input type="text" id="swEventName" placeholder="e.g. Swordland Week 3" style="width:200px"></div>
        <div class="field"><label>Date</label><input type="date" id="swEventDate" style="width:150px"></div>
        <button class="btn btn-primary" onclick="attAddEvent('sw')">+ Create Event</button>
      </div>
    </div>
    <div id="swEventList"></div>
  </div>
  <!-- Summary sub-tab -->
  <div id="swPanel-summary" style="display:none">
    <div class="card">
      <div class="card-title">📊 Overall Attendance Summary</div>
      <div id="swSummaryContent"><div style="color:var(--text3);font-size:13px">No events yet.</div></div>
    </div>
  </div>
</div>

<!-- TRI ALLIANCE ATTENDANCE PAGE -->
<div id="page-trialliance" class="page">
  <div class="card" style="margin-bottom:14px">
    <div class="card-title" style="font-size:20px">🤝 Tri Alliance Attendance</div>
    <p style="color:var(--text2);font-size:13px;margin-bottom:14px">Track attendance for Tri Alliance meetings. R4/R5 manage events and mark attendance.</p>
    <div style="display:flex;gap:8px">
      <button class="btn" id="taTab-register" onclick="attSwitchTab('ta','register')" style="background:rgba(61,142,240,.2);color:var(--accent2);border:1px solid var(--accent)">📝 Register Attendance</button>
      <button class="btn btn-ghost" id="taTab-summary" onclick="attSwitchTab('ta','summary')">📊 Overall Summary</button>
    </div>
  </div>
  <!-- Register Attendance sub-tab -->
  <div id="taPanel-register">
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">📝 Register Attendance</div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:14px">Create an event, then add which members attended. R4/R5 only.</p>
      <div class="row">
        <div class="field"><label>Event name</label><input type="text" id="taEventName" placeholder="e.g. Tri Alliance Meeting 5" style="width:200px"></div>
        <div class="field"><label>Date</label><input type="date" id="taEventDate" style="width:150px"></div>
        <button class="btn btn-primary" onclick="attAddEvent('ta')">+ Create Event</button>
      </div>
    </div>
    <div id="taEventList"></div>
  </div>
  <!-- Summary sub-tab -->
  <div id="taPanel-summary" style="display:none">
    <div class="card">
      <div class="card-title">📊 Overall Attendance Summary</div>
      <div id="taSummaryContent"><div style="color:var(--text3);font-size:13px">No events yet.</div></div>
    </div>
  </div>
</div>

</body>
</html>
`;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method==='OPTIONS') return new Response(null,{headers:cors()});

    // KingShot player lookup proxy
    if (url.pathname==='/kingshot-player' && request.method==='GET') {
      const playerId = url.searchParams.get('id');
      if (!playerId) return json({status:'fail',message:'Player ID required'},400);
      try {
        const res = await fetch(KINGSHOT_API+'/player-info?playerId='+encodeURIComponent(playerId),{headers:{Accept:'application/json'}});
        return json(await res.json(), res.status);
      } catch(e) { return json({status:'error',message:'API unreachable'},502); }
    }

    // Register verified player
    if (url.pathname==='/register-player' && request.method==='POST') {
      try {
        const {id,name,kingdom,alliance,role} = await request.json();
        if (!id || kingdom!==1057) return json({ok:false},400);
        const raw = await env.SVS_KV.get(PLAYERS_KEY);
        const players = raw ? JSON.parse(raw) : {};
        const existing = players[String(id)];
        players[String(id)] = {
          id:String(id), name, kingdom,
          alliance: (existing && existing.alliance) ? existing.alliance : (alliance||null),
          role: role||'member'
        };
        await env.SVS_KV.put(PLAYERS_KEY, JSON.stringify(players));
        return json({ok:true});
      } catch(e) { return json({ok:false,error:e.message},400); }
    }

    // Get stored alliance for a player
    if (url.pathname==='/player-alliance' && request.method==='GET') {
      const id = url.searchParams.get('id');
      if (!id) return json({alliance:null});
      const raw = await env.SVS_KV.get(PLAYERS_KEY);
      const players = raw ? JSON.parse(raw) : {};
      const p = players[String(id)];
      return json({alliance: p ? (p.alliance||null) : null});
    }

    // List all players (admin)
    if (url.pathname==='/player-list' && request.method==='GET') {
      const raw = await env.SVS_KV.get(PLAYERS_KEY);
      return json({players: raw ? JSON.parse(raw) : {}});
    }

    // Update player alliance (admin)
    if (url.pathname==='/update-player' && request.method==='POST') {
      try {
        const {id,alliance} = await request.json();
        const raw = await env.SVS_KV.get(PLAYERS_KEY);
        const players = raw ? JSON.parse(raw) : {};
        if (players[String(id)]) players[String(id)].alliance = alliance;
        await env.SVS_KV.put(PLAYERS_KEY, JSON.stringify(players));
        return json({ok:true});
      } catch(e) { return json({ok:false},400); }
    }

    // Remove player (admin)
    if (url.pathname==='/remove-player' && request.method==='POST') {
      try {
        const {id} = await request.json();
        const raw = await env.SVS_KV.get(PLAYERS_KEY);
        const players = raw ? JSON.parse(raw) : {};
        delete players[String(id)];
        await env.SVS_KV.put(PLAYERS_KEY, JSON.stringify(players));
        return json({ok:true});
      } catch(e) { return json({ok:false},400); }
    }

    // Manual admin redeem (runs full queue)
    if (url.pathname==='/admin-redeem' && request.method==='POST') {
      try {
        const {adminKey} = await request.json();
        const state = await env.SVS_KV.get(STATE_KEY);
        const stateData = state ? JSON.parse(state) : {};
        if (adminKey !== (stateData.pw_admin||'kvk1057admin')) return json({ok:false,message:'Unauthorized'},401);
        const result = await runFull(env);
        return json(result);
      } catch(e) { return json({ok:false,message:e.message},500); }
    }

    // Gift redemption log
    if (url.pathname==='/gift-log' && request.method==='GET') {
      const raw = await env.SVS_KV.get(GIFT_LOG_KEY);
      const log = raw ? JSON.parse(raw) : [];
      const display = log.map(e=>({
        time: e.time,
        code: (e.codes||[]).join(', '),
        results: (e.results||[]).map(r=>({name:r.name,ok:r.ok,err:r.err}))
      }));
      return json({log:display});
    }

    // Shared state
    if (url.pathname==='/state' && request.method==='GET') {
      const raw = await env.SVS_KV.get(STATE_KEY);
      return new Response(raw||'{}',{headers:{'Content-Type':'application/json',...cors()}});
    }
    if (url.pathname==='/state' && request.method==='PUT') {
      const body = await request.text();
      try { JSON.parse(body); } catch(e) { return json({error:'Invalid JSON'},400); }
      await env.SVS_KV.put(STATE_KEY, body);
      return json({ok:true});
    }

    if (request.method==='GET') return new Response(SITE_HTML,{headers:{'Content-Type':'text/html;charset=UTF-8',...cors()}});
    return new Response('Not found',{status:404,headers:cors()});
  },

  // Cron: every 30 min — process next batch of 5 players
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBatch(env));
  }
};
