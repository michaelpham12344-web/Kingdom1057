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

const SITE_HTML = `<!DOCTYPE html>
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
  <div style="max-width:860px;width:100%">

    <!-- Hero header -->
    <div style="text-align:center;margin-bottom:40px">
      <div style="font-family:var(--head);font-size:11px;font-weight:600;letter-spacing:.3em;color:var(--text3);margin-bottom:12px;text-transform:uppercase">⚔️ KvK Alliance Command</div>
      <div style="font-family:var(--head);font-size:18px;font-weight:400;color:var(--text3);letter-spacing:.15em;margin-bottom:4px">WELCOME TO</div>
      <div style="font-family:var(--head);font-size:58px;font-weight:700;color:var(--accent2);letter-spacing:.06em;line-height:1;margin-bottom:8px">KINGDOM <span style="color:var(--gold)">1057</span></div>
      <div style="font-family:var(--head);font-size:13px;color:var(--text3);letter-spacing:.2em;margin-bottom:28px">✦ &nbsp; THE GREATEST KINGDOM OF ALL TIME &nbsp; ✦</div>

      <!-- Story card -->
      <div class="card" style="text-align:left;max-width:640px;margin:0 auto 32px;border:1px solid rgba(61,142,240,.25);background:rgba(61,142,240,.04)">
        <div style="font-size:14px;color:var(--text);line-height:2;font-family:var(--body)">
          This site is your <strong style="color:var(--accent2)">KvK coordination hub</strong> — built to give Kingdom 1057 the edge it deserves.<br><br>
          Minister Spots are <strong style="color:var(--gold)">scarce and powerful</strong>. The wrong person in the wrong slot costs us dearly. That's why we need <em>your</em> speedup numbers — so we can put the right leaders in the right positions and crush it.<br><br>
          <strong style="color:var(--text)">What we need from you:</strong><br>
          📸 A screenshot of your speedup inventory<br>
          🕐 Your preferred timeslots so we can schedule you in<br><br>
          <strong style="color:var(--gold)">Bonus perk:</strong> Register your Player ID and you'll get <strong style="color:var(--accent2)">automatic gift code redemption</strong> throughout the KvK — free rewards, zero effort. 🎁<br><br>
          <span style="color:var(--text3);font-size:12px">Let's go. Kingdom 1057 doesn't lose.</span>
        </div>
      </div>
    </div>

    <!-- Two-column entry -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" class="landing-grid">

      <!-- LEFT: Member -->
      <div class="card" style="text-align:left;border:1px solid rgba(46,204,113,.2)">
        <div style="font-family:var(--head);font-size:16px;font-weight:700;color:var(--green);margin-bottom:4px">🎮 Enter as Member of 1057</div>
        <p style="color:var(--text2);font-size:12px;margin-bottom:14px;line-height:1.6">Verify your Player ID to submit your minister spot inventory.</p>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input type="text" id="landingPlayerId" placeholder="Your Player ID — e.g. 8767319" style="flex:1;min-width:0" onkeydown="if(event.key==='Enter')lookupPlayer()">
          <button class="btn btn-primary" id="lookupBtn" onclick="lookupPlayer()">🔍</button>
        </div>
        <div id="playerLookupResult" style="display:none;margin-bottom:10px"></div>
        <button id="enterMemberBtn" class="btn btn-primary" style="width:100%;display:none" onclick="landingEnterMember()">✅ Enter as Member of 1057</button>
        <p style="color:var(--text3);font-size:11px;margin-top:10px">📍 In-game: tap your avatar → your Player ID is shown below your name.</p>
      </div>

      <!-- RIGHT: R4/R5 -->
      <div class="card" style="text-align:left;border:1px solid rgba(61,142,240,.2)">
        <div style="font-family:var(--head);font-size:16px;font-weight:700;color:var(--accent2);margin-bottom:4px">🔑 R4 / R5 Access</div>
        <p style="color:var(--text2);font-size:12px;margin-bottom:14px;line-height:1.6">Alliance leadership access — unlocks all coordination and strategy tools.</p>
        <div style="margin-bottom:8px">
          <input type="text" id="r5PlayerId" placeholder="Player ID of 1057 (same as above)" style="width:100%;box-sizing:border-box" onkeydown="if(event.key==='Enter')document.getElementById('landingPwInput').focus()">
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input type="password" id="landingPwInput" placeholder="Password" style="flex:1;min-width:0" onkeydown="if(event.key==='Enter')landingCheckPassword()">
          <button class="btn btn-primary" onclick="landingCheckPassword()">Enter</button>
        </div>
        <div id="landingPwError" style="display:none;color:#ff7070;font-size:12px;margin-bottom:8px">Incorrect password.</div>
        <div style="position:relative;display:inline-block">
          <span style="font-size:11px;color:var(--text3);cursor:default"
            onmouseenter="document.getElementById('pwTooltip').style.display='block'"
            onmouseleave="document.getElementById('pwTooltip').style.display='none'">ℹ️ Password access is exclusive to R4 and R5 members</span>
          <div id="pwTooltip" style="display:none;position:absolute;bottom:130%;left:0;background:var(--bg3);border:1px solid var(--border2);border-radius:7px;padding:10px 14px;width:250px;font-size:12px;color:var(--text2);line-height:1.7;z-index:999;pointer-events:none">
            R4 and R5 rights are exclusive to alliance leadership. Contact your R5 to receive your access code.
          </div>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- USER BAR — shown after login -->
<div id="userBar" style="display:none;background:var(--bg3);border-bottom:1px solid var(--border);padding:6px 16px;display:none;align-items:center;gap:10px;font-size:13px">
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
    <div id="bsQuickCopy" style="display:none;margin-bottom:14px">
      <button class="btn btn-gold" onclick="bsCopySelectedTeam()">📋 Copy team for in-game chat</button>
    </div>
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
      <div id="msAdminGuard" style="display:none;background:rgba(61,142,240,.08);border:1px solid var(--border);border-radius:7px;padding:14px;margin-bottom:10px">
        <div style="font-size:13px;color:var(--text2);margin-bottom:10px">🔒 Admin password required to manage results.</div>
        <div style="display:flex;gap:8px">
          <input type="password" id="msAdminPwInput" placeholder="Admin password" style="width:160px" onkeydown="if(event.key==='Enter')msUnlockAdmin()">
          <button class="btn btn-primary btn-sm" onclick="msUnlockAdmin()">Unlock</button>
        </div>
        <div id="msAdminPwErr" style="display:none;color:#ff7070;font-size:12px;margin-top:6px">Incorrect password.</div>
      </div>
      <div id="msAdminActions" style="display:none">
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
    msLastAllocation: (typeof MS!=='undefined') ? MS._lastAllocation : null
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
  const qc=document.getElementById('bsQuickCopy');
  if(qc) qc.style.display='block';
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
<script id="newSystemsJS">

// ════════════════════════════════════════════════════════
// AUTH & PASSWORD SYSTEM
// ════════════════════════════════════════════════════════
const AUTH = { coordUnlocked: false, adminUnlocked: false };
const AUTH_DEFAULTS = { coord: 'kvk1057coord', admin: 'kvk1057admin' };
let loadedPasswords = { coord: null, admin: null };

async function loadPasswords() {
  try {
    const res = await fetch('/state', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.pw_coord) loadedPasswords.coord = data.pw_coord;
      if (data.pw_admin) loadedPasswords.admin = data.pw_admin;
    }
  } catch(e) {}
}

function getPassword(type) { return loadedPasswords[type] || AUTH_DEFAULTS[type]; }
function checkPassword(type, input) { return input === getPassword(type); }

function sessionSetAuth(type) { try { sessionStorage.setItem('auth_' + type, '1'); } catch(e) {} }
function sessionHasAuth(type) { try { return sessionStorage.getItem('auth_' + type) === '1'; } catch(e) { return false; } }

// ════════════════════════════════════════════════════════
// LANDING PAGE
// ════════════════════════════════════════════════════════
function toggleLandingPassword() {
  const f = document.getElementById('landingPasswordForm');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
}
// Verified player from KingShot API
let verifiedPlayer = null;

function showUserBar(player, role) {
  const bar = document.getElementById('userBar');
  if (!bar) return;
  bar.style.display = 'flex';
  if (player) {
    const av = document.getElementById('userBarAvatar');
    if (av && player.avatar) { av.src = player.avatar; av.style.display = 'block'; }
    const nm = document.getElementById('userBarName');
    if (nm) nm.textContent = player.name || '';
    const kg = document.getElementById('userBarKingdom');
    if (kg) kg.textContent = 'Kingdom ' + (player.kingdom || '1057');
  }
  const rl = document.getElementById('userBarRole');
  if (rl) {
    if (role === 'admin')  { rl.textContent = '⚙️ Admin';  rl.style.background = 'rgba(255,200,0,.15)'; rl.style.color = 'var(--gold)'; }
    else if (role === 'coord') { rl.textContent = '🛡 R4/R5'; rl.style.background = 'rgba(61,142,240,.15)'; rl.style.color = 'var(--accent2)'; }
    else { rl.textContent = '👤 Member'; rl.style.background = 'rgba(46,204,113,.1)'; rl.style.color = 'var(--green)'; }
  }
}

async function doPlayerLookup(playerId) {
  try {
    const res = await fetch('/kingshot-player?id=' + encodeURIComponent(playerId));
    const data = await res.json();
    if (data.status === 'success' && data.data) return data.data;
  } catch(e) {}
  return null;
}

async function lookupPlayer() {
  const id = document.getElementById('landingPlayerId').value.trim();
  if (!id) { toast('Enter your Player ID.'); return; }
  const btn = document.getElementById('lookupBtn');
  const resultEl = document.getElementById('playerLookupResult');
  const enterBtn = document.getElementById('enterMemberBtn');
  btn.disabled = true; btn.textContent = '⏳';
  resultEl.style.display = 'none'; if (enterBtn) enterBtn.style.display = 'none';
  const p = await doPlayerLookup(id);
  if (p) {
    const inKingdom = p.kingdom === 1057;
    const col = inKingdom ? 'var(--green)' : 'var(--enemy)';
    const msg = inKingdom ? '✅ Kingdom 1057' : '❌ Kingdom ' + p.kingdom + ' — not Kingdom 1057';
    resultEl.innerHTML = '<div style="display:flex;align-items:center;gap:10px;background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:10px 12px">' +
      (p.profilePhoto ? '<img src="' + p.profilePhoto + '" style="width:40px;height:40px;border-radius:50%;border:2px solid var(--border2)">' : '') +
      '<div><div style="font-weight:700">' + p.name + '</div><div style="font-size:11px;color:var(--text3)">Lvl ' + p.level + ' · ID: ' + p.playerId + '</div>' +
      '<div style="font-size:12px;font-weight:600;color:' + col + '">' + msg + '</div></div></div>';
    resultEl.style.display = 'block';
    if (inKingdom) {
      verifiedPlayer = { id: p.playerId, name: p.name, kingdom: p.kingdom, level: p.level, avatar: p.profilePhoto };
      if (enterBtn) enterBtn.style.display = 'block';
    }
  } else {
    resultEl.innerHTML = '<div style="color:var(--enemy);font-size:13px;padding:6px 0">⚠ Player not found or API unavailable. Try the password instead.</div>';
    resultEl.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = '🔍 Lookup';
}

function landingEnterMember() {
  if (verifiedPlayer) {
    try { sessionStorage.setItem('verifiedPlayer', JSON.stringify(verifiedPlayer)); } catch(e) {}
    fetch('/register-player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: verifiedPlayer.id, name: verifiedPlayer.name, kingdom: verifiedPlayer.kingdom }) }).catch(() => {});
  }
  enterApp('member');
}

async function landingCheckPassword() {
  const input = document.getElementById('landingPwInput').value;
  const errEl = document.getElementById('landingPwError');
  await loadPasswords();
  if (checkPassword('admin', input)) {
    AUTH.adminUnlocked = true; AUTH.coordUnlocked = true;
    sessionSetAuth('admin'); sessionSetAuth('coord');
    // Also try to look up R4/R5 Player ID if provided
    const r5id = document.getElementById('r5PlayerId') ? document.getElementById('r5PlayerId').value.trim() : '';
    if (r5id) { const p = await doPlayerLookup(r5id); if (p && p.kingdom === 1057) { verifiedPlayer = { id: p.playerId, name: p.name, kingdom: p.kingdom, level: p.level, avatar: p.profilePhoto }; } }
    enterApp('admin');
  } else if (checkPassword('coord', input)) {
    AUTH.coordUnlocked = true;
    sessionSetAuth('coord');
    const r5id = document.getElementById('r5PlayerId') ? document.getElementById('r5PlayerId').value.trim() : '';
    if (r5id) { const p = await doPlayerLookup(r5id); if (p && p.kingdom === 1057) { verifiedPlayer = { id: p.playerId, name: p.name, kingdom: p.kingdom, level: p.level, avatar: p.profilePhoto }; } }
    enterApp('coord');
  } else {
    errEl.style.display = 'block';
    setTimeout(() => errEl.style.display = 'none', 2000);
  }
}

function enterApp(role) {
  document.getElementById('page-landing').style.display = 'none';
  document.getElementById('mainNav').style.display = '';
  // Show user bar
  const storedPlayer = verifiedPlayer || (() => { try { const s = sessionStorage.getItem('verifiedPlayer'); return s ? JSON.parse(s) : null; } catch(e) { return null; } })();
  showUserBar(storedPlayer, role);

  const coordOnly = ['coordinator', 'strategy', 'setup'];
  coordOnly.forEach(id => {
    const tab = document.querySelector('.nav > .tab[onclick*="' + id + '"]');
    if (tab) tab.style.display = (AUTH.coordUnlocked || AUTH.adminUnlocked) ? '' : 'none';
  });
  ['tabSwordland', 'tabTrialliance'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (AUTH.coordUnlocked || AUTH.adminUnlocked) ? '' : 'none';
  });
  const adminTab = document.getElementById('tabAdmin');
  if (adminTab) adminTab.style.display = AUTH.adminUnlocked ? '' : 'none';

  if (role === 'member') showPageDirect('minister');
  else showPageDirect('coordinator');
}

function showPageDirect(p) {
  document.querySelectorAll('.page').forEach(e => e.classList.remove('active'));
  const pg = document.getElementById('page-' + p);
  if (pg) pg.classList.add('active');
  document.querySelectorAll('.nav > .tab').forEach(e => e.classList.remove('active'));
  const activeTab = document.querySelector('.nav > .tab[onclick*="' + p + '"]');
  if (activeTab) activeTab.classList.add('active');
  if (p === 'strategy') { if (typeof renderBattleStrategy === 'function') renderBattleStrategy(); bsTickClock(); }
  if (p === 'setup') { if (typeof renderSetup === 'function') renderSetup(); }
  if (p === 'coordinator') { if (typeof renderLeaderTable === 'function') renderLeaderTable(); }
  if (p === 'minister') { if (typeof msInit === 'function') { msInit(); msRenderStepTabs(); msInitResultsTab(); } }
  if (p === 'swordland') renderAttendance('sw');
  if (p === 'trialliance') renderAttendance('ta');
  if (p === 'admin') {
    const coordEl = document.getElementById('currentCoordPw');
    const adminEl = document.getElementById('currentAdminPw');
    if (coordEl) coordEl.textContent = getPassword('coord');
    if (adminEl) adminEl.textContent = getPassword('admin');
    adminLoadGiftLog();
  }
}

function showPage(p) { showPageDirect(p); }

async function initApp() {
  await loadPasswords();
  if (sessionHasAuth('admin')) { AUTH.adminUnlocked = true; AUTH.coordUnlocked = true; }
  else if (sessionHasAuth('coord')) { AUTH.coordUnlocked = true; }

  if (AUTH.adminUnlocked) enterApp('admin');
  else if (AUTH.coordUnlocked) enterApp('coord');
  else {
    const lp = document.getElementById('page-landing');
    const mn = document.getElementById('mainNav');
    if (lp) lp.style.display = 'flex';
    if (mn) mn.style.display = 'none';
  }
}

// ════════════════════════════════════════════════════════
// ADMIN PANEL
// ════════════════════════════════════════════════════════
async function adminChangePassword(type) {
  const inputId = type === 'coord' ? 'newCoordPw' : 'newAdminPw';
  const newPw = document.getElementById(inputId).value.trim();
  if (!newPw) { toast('Enter a password first.'); return; }
  const res = await fetch('/state', { cache: 'no-store' });
  const data = res.ok ? await res.json() : {};
  data['pw_' + type] = newPw;
  await fetch('/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  loadedPasswords[type] = newPw;
  document.getElementById(inputId).value = '';
  // Update displayed current password
  const displayId = type === 'coord' ? 'currentCoordPw' : 'currentAdminPw';
  const displayEl = document.getElementById(displayId);
  if (displayEl) displayEl.textContent = newPw;
  toast(type === 'coord' ? 'Coordinator password updated.' : 'Admin password updated.');
}

async function adminRedeemNow() {
  const statusEl = document.getElementById('giftRedeemStatus');
  const logEl = document.getElementById('giftRedeemLog');
  if (statusEl) statusEl.textContent = '⏳ Redeeming… this may take a minute.';
  try {
    const res = await fetch('/admin-redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminKey: getPassword('admin') }) });
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
    if (!data.log || !data.log.length) { logEl.innerHTML = '<div style="color:var(--text3)">No redemptions yet.</div>'; return; }
    logEl.innerHTML = data.log.slice().reverse().map(entry =>
      '<div style="border-bottom:1px solid var(--border);padding:6px 0">' +
      '<span style="color:var(--text3)">' + entry.time + '</span> ' +
      '<strong>' + (entry.code || '?') + '</strong> — ' +
      (entry.results || []).map(r => '<span style="color:' + (r.ok ? 'var(--green)' : 'var(--enemy)') + '">' + r.name + ' (' + (r.ok ? '✓' : r.err) + ')</span>').join(', ') +
      '</div>'
    ).join('');
  } catch(e) { logEl.innerHTML = '<div style="color:var(--enemy)">Could not load log.</div>'; }
}

async function adminReset(what) {
  if (!confirm('Are you sure? This cannot be undone.')) return;
  if (what === 'ministers' || what === 'all') { MS.submissions = []; MS._lastAllocation = null; }
  if (what === 'leaders' || what === 'all') { S.leaders = []; if (typeof renderLeaderTable === 'function') renderLeaderTable(); }
  if (what === 'teams' || what === 'all') { S.teams = []; if (typeof renderSetup === 'function') renderSetup(); if (typeof renderBattleStrategy === 'function') renderBattleStrategy(); }
  if (what === 'attendance' || what === 'all') { ATT.sw = { members: [], events: [] }; ATT.ta = { members: [], events: [] }; }
  syncQueuePush();
  toast('Reset complete.');
}

// ════════════════════════════════════════════════════════
// MINISTER SPOTS — access helpers
// ════════════════════════════════════════════════════════
function msCanAccessResults() { return typeof AUTH !== 'undefined' && AUTH.adminUnlocked; }


// ════════════ ATTENDANCE — REWRITTEN ════════════

// ════════════ ATTENDANCE DATA ════════════
const ATT = {
  sw: { members: [], events: [] },
  ta: { members: [], events: [] }
};

function attSwitchTab(prefix, tab) {
  ['register','summary'].forEach(t => {
    const panel = document.getElementById(prefix + 'Panel-' + t);
    const btn = document.getElementById(prefix + 'Tab-' + t);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
    if (btn) {
      btn.style.background = t === tab ? 'rgba(61,142,240,.2)' : '';
      btn.style.color = t === tab ? 'var(--accent2)' : '';
      btn.style.border = t === tab ? '1px solid var(--accent)' : '';
      btn.className = t === tab ? 'btn' : 'btn btn-ghost';
    }
  });
  if (tab === 'summary') renderAttSummary(prefix);
  if (tab === 'register') renderAttEventList(prefix);
}

function renderAttendance(prefix) {
  attSwitchTab(prefix, 'register');
}

// ── Add event ──
function attAddEvent(prefix) {
  const nameEl = document.getElementById(prefix + 'EventName');
  const dateEl = document.getElementById(prefix + 'EventDate');
  const name = nameEl.value.trim();
  const date = dateEl ? dateEl.value : '';
  if (!name) { toast('Enter an event name.'); return; }
  const store = ATT[prefix];
  store.events.push({ id: uid(), name, date: date || new Date().toLocaleDateString('en-GB'), members: [] });
  nameEl.value = '';
  if (dateEl) dateEl.value = '';
  renderAttEventList(prefix);
  syncQueuePush();
  toast('Event created.');
}

// ── Render event list with member management per event ──
function renderAttEventList(prefix) {
  const el = document.getElementById(prefix + 'EventList');
  if (!el) return;
  const store = ATT[prefix];
  const isAdmin = typeof AUTH !== 'undefined' && (AUTH.adminUnlocked || AUTH.coordUnlocked);

  if (!store.events.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:12px 0">No events yet. Create one above.</div>';
    return;
  }

  el.innerHTML = store.events.map(evt => {
    const memberRows = evt.members && evt.members.length
      ? evt.members.map(m => {
          const delBtn = isAdmin ? '<button class="btn btn-danger btn-sm" style="padding:2px 8px" onclick="attRemoveEventMember(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'' + m.id + '\\')">✕</button>' : '';
          return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--border)">' +
            '<span><strong>' + m.name + '</strong> <span style="color:var(--text3);font-size:12px">(' + (m.alliance||'') + ')</span></span>' +
            delBtn + '</div>';
        }).join('')
      : '<div style="color:var(--text3);font-size:12px;padding:8px 10px">No members added yet.</div>';

    const addForm = isAdmin ? '<div style="padding:10px;background:var(--bg4);border-top:1px solid var(--border)">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">' +
      '<div class="field"><label style="font-size:11px">IGN</label><input type="text" id="' + prefix + 'MemberIGN-' + evt.id + '" placeholder="e.g. Olaf" style="width:140px"></div>' +
      '<div class="field"><label style="font-size:11px">Alliance</label>' +
      '<select id="' + prefix + 'MemberAlliance-' + evt.id + '" style="width:100px">' +
      '<option value="">—</option><option>FIR</option><option>LOC</option><option>LYL</option><option>KNG</option><option>KOV</option><option>TLA</option>' +
      '</select></div>' +
      '<button class="btn btn-primary btn-sm" onclick="attAddEventMember(\\'' + prefix + '\\',\\'' + evt.id + '\\')">+ Add Member</button>' +
      '</div></div>' : '';

    const delEvtBtn = isAdmin ? '<button class="btn btn-danger btn-sm" onclick="attRemoveEvent(\\'' + prefix + '\\',\\'' + evt.id + '\\')">🗑 Delete event</button>' : '';

    return '<div class="card" style="margin-bottom:12px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">' +
      '<div><div class="card-title" style="margin:0">' + evt.name + '</div>' +
      '<div style="font-size:12px;color:var(--text3);margin-top:2px">' + (evt.date||'') + ' · ' + (evt.members ? evt.members.length : 0) + ' members</div></div>' +
      delEvtBtn + '</div>' +
      '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:6px;overflow:hidden">' +
      memberRows + addForm + '</div></div>';
  }).join('');
}

function attAddEventMember(prefix, eventId) {
  const ignEl = document.getElementById(prefix + 'MemberIGN-' + eventId);
  const allianceEl = document.getElementById(prefix + 'MemberAlliance-' + eventId);
  const ign = ignEl ? ignEl.value.trim() : '';
  const alliance = allianceEl ? allianceEl.value : '';
  if (!ign) { toast('Enter an IGN.'); return; }
  const store = ATT[prefix];
  const evt = store.events.find(e => e.id === eventId);
  if (!evt) return;
  if (!evt.members) evt.members = [];
  if (evt.members.find(m => m.name === ign)) { toast('Already added.'); return; }
  evt.members.push({ id: uid(), name: ign, alliance });
  if (ignEl) ignEl.value = '';
  renderAttEventList(prefix);
  syncQueuePush();
}

function attRemoveEventMember(prefix, eventId, memberId) {
  const evt = ATT[prefix].events.find(e => e.id === eventId);
  if (evt) {
    evt.members = (evt.members || []).filter(m => m.id !== memberId);
    renderAttEventList(prefix);
    syncQueuePush();
  }
}

function attRemoveEvent(prefix, eventId) {
  if (!confirm('Delete this event and all its members?')) return;
  ATT[prefix].events = ATT[prefix].events.filter(e => e.id !== eventId);
  renderAttEventList(prefix);
  renderAttSummary(prefix);
  syncQueuePush();
}

// ── Summary ──
function renderAttSummary(prefix) {
  const contentEl = document.getElementById(prefix + 'SummaryContent');
  if (!contentEl) return;
  const store = ATT[prefix];
  if (!store.events.length) {
    contentEl.innerHTML = '<div style="color:var(--text3);font-size:13px">No events yet.</div>';
    return;
  }

  // Build a combined member list across all events
  const memberMap = {}; // name+alliance -> {name, alliance, shown, total}
  store.events.forEach(evt => {
    (evt.members || []).forEach(m => {
      const key = m.name + '|' + (m.alliance || '');
      if (!memberMap[key]) memberMap[key] = { name: m.name, alliance: m.alliance || '', shown: 0, total: 0 };
      memberMap[key].shown++;
      memberMap[key].total++;
    });
  });

  // Total events = store.events.length
  const total = store.events.length;
  Object.values(memberMap).forEach(m => { m.total = total; });

  // Group by alliance
  const byAlliance = {};
  Object.values(memberMap).forEach(m => {
    const a = m.alliance || 'Unknown';
    if (!byAlliance[a]) byAlliance[a] = [];
    byAlliance[a].push(m);
  });

  const isAdmin = typeof AUTH !== 'undefined' && (AUTH.adminUnlocked || AUTH.coordUnlocked);
  let html = '';
  Object.keys(byAlliance).sort().forEach(alliance => {
    const members = byAlliance[alliance].sort((a,b) => b.shown - a.shown);
    html += '<div style="margin-bottom:18px">';
    html += '<div class="sec-title" style="margin-bottom:8px">' + alliance + '</div>';
    html += '<div style="overflow-x:auto"><table style="min-width:320px"><thead><tr><th>IGN</th><th>Events Attended</th><th>Score</th></tr></thead><tbody>';
    html += members.map(m => {
      const pct = total > 0 ? Math.round(m.shown / total * 100) : 0;
      const col = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--enemy)';
      return '<tr><td><strong>' + m.name + '</strong></td><td class="mono">' + m.shown + ' / ' + total + '</td>' +
        '<td><span class="mono" style="color:' + col + ';font-weight:600">' + pct + '%</span></td></tr>';
    }).join('');
    html += '</tbody></table></div></div>';
  });

  if (!Object.keys(byAlliance).length) {
    html = '<div style="color:var(--text3);font-size:13px">No members registered yet.</div>';
  }
  contentEl.innerHTML = html;
}

// Keep attGetScore for backward compat
function attGetScore(prefix, memberId) { return { pct: 0, shown: 0, total: 0 }; }
function attRemoveMember(prefix, memberId) {}

// EXTEND SYNC to include ATT data and passwords
// ════════════════════════════════════════════════════════
const _origSyncSerialize = syncSerialize;
syncSerialize = function() {
  const base = JSON.parse(_origSyncSerialize());
  if (typeof ATT !== 'undefined') {
    base.att_sw = ATT.sw;
    base.att_ta = ATT.ta;
  }
  if (typeof loadedPasswords !== 'undefined') {
    if (loadedPasswords.coord) base.pw_coord = loadedPasswords.coord;
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
    if (data.pw_coord) loadedPasswords.coord = data.pw_coord;
    if (data.pw_admin) loadedPasswords.admin = data.pw_admin;
  }
  const active = document.querySelector('.page.active');
  if (active && active.id === 'page-swordland') renderAttendance('sw');
  if (active && active.id === 'page-trialliance') renderAttendance('ta');
};


function msUnlockAdmin(){
  const input=document.getElementById('msAdminPwInput').value;
  if(checkPassword('admin',input)){
    AUTH.adminUnlocked=true;
    sessionSetAuth('admin');
    msShowAdminActions();
  } else {
    const err=document.getElementById('msAdminPwErr');
    if(err){err.style.display='block';setTimeout(()=>err.style.display='none',2000);}
  }
}

function msShowAdminActions(){
  const guard=document.getElementById('msAdminGuard');
  const actions=document.getElementById('msAdminActions');
  if(guard) guard.style.display='none';
  if(actions) actions.style.display='block';
}

function msInitResultsTab(){
  // Admin users (already authenticated) get direct access — no password prompt
  if(msCanAccessResults()){
    msShowAdminActions();
  } else {
    const guard=document.getElementById('msAdminGuard');
    const actions=document.getElementById('msAdminActions');
    if(guard) guard.style.display='block';
    if(actions) actions.style.display='none';
  }
}

// ════════════════════════════════════════════════════════
// INIT on DOM ready
// ════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', initApp);

</script>

<div id="page-admin" class="page">

  <div class="card" style="margin-bottom:14px">
    <div class="card-title">⚙️ Admin Panel</div>
    <p style="color:var(--text2);font-size:13px">Manage passwords and reset data. Changes are saved to the shared KV store.</p>
  </div>
  <div class="grid2">
    <div class="card">
      <div class="card-title">🔑 Change Coordinator Password</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:10px">Current password: <span class="mono" id="currentCoordPw" style="color:var(--gold)">loading…</span></div>
      <div class="row" style="margin-bottom:8px">
        <div class="field" style="flex:1"><label>New coordinator password</label><input type="password" id="newCoordPw" style="width:100%"></div>
      </div>
      <button class="btn btn-primary" onclick="adminChangePassword('coord')">Save Coordinator Password</button>
    </div>
    <div class="card">
      <div class="card-title">🔑 Change Admin Password</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:10px">Current password: <span class="mono" id="currentAdminPw" style="color:var(--gold)">loading…</span></div>
      <div class="row" style="margin-bottom:8px">
        <div class="field" style="flex:1"><label>New admin password</label><input type="password" id="newAdminPw" style="width:100%"></div>
      </div>
      <button class="btn btn-primary" onclick="adminChangePassword('admin')">Save Admin Password</button>
    </div>
  </div>
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">🎁 Gift Code Auto-Redemption</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:14px">Redeems all active gift codes daily at 08:00 UTC for every registered member. Members register by verifying their Player ID on the landing page.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <button class="btn btn-primary" onclick="adminRedeemNow()">🎁 Redeem Now for All Members</button>
      <button class="btn btn-ghost" onclick="adminLoadGiftLog()">📋 Refresh Log</button>
    </div>
    <div id="giftRedeemStatus" style="font-size:12px;color:var(--text3);margin-bottom:10px"></div>
    <div id="giftRedeemLog" style="font-size:12px;max-height:300px;overflow-y:auto"></div>
  </div>
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
        const {id,name,kingdom} = await request.json();
        if (!id || kingdom!==1057) return json({ok:false},400);
        const raw = await env.SVS_KV.get(PLAYERS_KEY);
        const players = raw ? JSON.parse(raw) : {};
        players[String(id)] = {id:String(id),name,kingdom};
        await env.SVS_KV.put(PLAYERS_KEY, JSON.stringify(players));
        return json({ok:true});
      } catch(e) { return json({ok:false,error:e.message},400); }
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
