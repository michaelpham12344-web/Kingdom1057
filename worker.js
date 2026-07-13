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
 *   GET  /gift-players        → [runner] player list for the external redeemer (shared secret)
 *   POST /gift-report         → [runner] external redeemer reports results back (shared secret)
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

// ════════════ MINISTER SPOTS SERVER-SIDE AUTOMATION (Phase 3) ════════════
// Self-contained port of the client's schedule + allocation logic, with no DOM
// dependency, so the cron can clear/allocate without a browser open. Suffixed
// "Srv" throughout to keep this fully independent of the identically-named
// client functions living inside the SITE_HTML string.
const KVK_ANCHOR_UTC_SRV = Date.UTC(2026,6,13,0,0,0);
const KVK_CYCLE_MS_SRV   = 28*24*60*60*1000;
const MS_BOARD_DAY_OFFSET_SRV = { buildings:0, research:1, troops:3 };
const MS_BOARDS_SRV = ['buildings','research','troops'];
const MS_BOARD_LABEL_SRV = { buildings:'Construction', research:'Research', troops:'Troops' };
const MS_PTS_SRV = { perMin: 30, truegold: 2000, dust: 1000 };
const MS_TOTAL_SLOTS_SRV = 48;
const MS_MIN_SLOTS_PICKED_SRV = 4;
const _DAY_SRV = 86400000, _H_SRV = 3600000;

function nextKvKStartSrv(now){ let t=KVK_ANCHOR_UTC_SRV; if(now>=t){ t += Math.ceil((now-t+1)/KVK_CYCLE_MS_SRV)*KVK_CYCLE_MS_SRV; } return t; }
function currentKvKDay1Srv(now, override){
  if(override) return override;
  var k = Math.floor((now - KVK_ANCHOR_UTC_SRV) / KVK_CYCLE_MS_SRV);
  for(var i=k; i<=k+1; i++){
    var day1 = KVK_ANCHOR_UTC_SRV + i*KVK_CYCLE_MS_SRV;
    if(now >= day1 - 8*_DAY_SRV && now < day1 + 6*_DAY_SRV) return day1;
  }
  return nextKvKStartSrv(now);
}
function msScheduleSrv(now, override){
  var day1 = currentKvKDay1Srv(now, override);
  var sched = { day1:day1, openAt: day1 - 7*_DAY_SRV, boards:{} };
  Object.keys(MS_BOARD_DAY_OFFSET_SRV).forEach(function(b){
    var dStart = day1 + MS_BOARD_DAY_OFFSET_SRV[b]*_DAY_SRV;
    sched.boards[b] = { dayStart: dStart, deadline: dStart - (36*_H_SRV + 60000), allocAt: dStart - 36*_H_SRV };
  });
  return sched;
}
function msBoardScoreSrv(board, c){
  c = c || {};
  if(board==='buildings') return (c.construction||0)*MS_PTS_SRV.perMin + (c.general||0)*MS_PTS_SRV.perMin + (c.truegold||0)*MS_PTS_SRV.truegold;
  if(board==='research')  return (c.research||0)*MS_PTS_SRV.perMin + (c.general||0)*MS_PTS_SRV.perMin + (c.dust||0)*MS_PTS_SRV.dust;
  if(board==='troops')    return (c.training||0) + (c.general||0);
  return 0;
}
// Faithful port of the client's msRunAllocationForBoard — same two-pass logic,
// operating on a plain submissions array instead of the global MS object.
function msRunAllocationForBoardSrv(board, submissions, prev){
  const pinned = new Map();
  if(prev){ (prev.assignments||[]).forEach(a => { if(a.pinned) pinned.set(a.slot, a.entry); }); }
  const pinnedIGNs = new Set([...pinned.values()].map(e => e.ign));
  const takenSlots = new Set(pinned.keys());
  const assignments = [];
  pinned.forEach((entry, slot) => { assignments.push({entry, slot, pinned:true}); });

  const applied = submissions.filter(e => !e.boards || !e.boards.length || e.boards.indexOf(board)>=0);
  const candidates = applied.filter(e => !pinnedIGNs.has(e.ign));

  const scoreOf = (board==='troops')
    ? (e => (e.committedHours && e.committedHours.training) || 0)
    : (e => (e.scores && e.scores[board]) || 0);
  const timeOf  = e => e.submittedAt ? new Date(e.submittedAt).getTime() : 0;
  const picksOf = e => (e.picksByBoard && e.picksByBoard[board]) || e.picks || [];
  const favsOf  = e => (e.favByBoard && e.favByBoard[board]) || e.favourites || [];

  const byConstraint = [...candidates].sort((a,b) => {
    const pa=picksOf(a).length, pb=picksOf(b).length;
    if(pa!==pb) return pa-pb;
    if(scoreOf(a)!==scoreOf(b)) return scoreOf(b)-scoreOf(a);
    return timeOf(a)-timeOf(b);
  });
  const placed = new Set();
  const CONSTRAINED_MAX_PICKS = MS_MIN_SLOTS_PICKED_SRV;
  byConstraint.forEach(entry => {
    if(picksOf(entry).length > CONSTRAINED_MAX_PICKS) return;
    if(takenSlots.size >= MS_TOTAL_SLOTS_SRV) return;
    const favs = favsOf(entry).filter(s => !takenSlots.has(s));
    const pick = favs.length ? favs[0] : picksOf(entry).find(s => !takenSlots.has(s));
    if(pick !== undefined){ takenSlots.add(pick); assignments.push({entry, slot:pick}); placed.add(entry.ign); }
  });

  const remaining = candidates.filter(e => !placed.has(e.ign)).sort((a,b) => {
    if(scoreOf(a)!==scoreOf(b)) return scoreOf(b)-scoreOf(a);
    return timeOf(a)-timeOf(b);
  });
  const rejected = [], unassigned = [], rejectReasons = {};
  remaining.forEach(entry => {
    if(takenSlots.size >= MS_TOTAL_SLOTS_SRV){ rejectReasons[entry.ign]='all-full'; rejected.push(entry); return; }
    const favs = favsOf(entry).filter(s => !takenSlots.has(s));
    const pick = favs.length ? favs[0] : picksOf(entry).find(s => !takenSlots.has(s));
    if(pick !== undefined){ takenSlots.add(pick); assignments.push({entry, slot:pick}); placed.add(entry.ign); }
    else unassigned.push(entry);
  });
  unassigned.forEach(entry => { rejectReasons[entry.ign]='picks-taken'; rejected.push(entry); });

  assignments.sort((a,b) => a.slot - b.slot);
  const winners = assignments.map(a => a.entry);
  return {winners, rejected, assignments, rejectReasons, board};
}

function msAuditPushSrv(state, who, action){
  state.msAuditLog = state.msAuditLog || [];
  state.msAuditLog.unshift({ who: who, action: action, when: Date.now() });
  if(state.msAuditLog.length > 30) state.msAuditLog = state.msAuditLog.slice(0, 30);
}

// Runs on every cron tick. Clears old submissions once per KvK cycle at Day1-7d,
// and runs each board's allocation once at its own Day1-36h mark. Idempotent via
// state.msAuto, keyed to the cycle's Day-1 timestamp so a 30-min tick cadence
// can never double-fire either action.
function msAutomationTick(state){
  const now = Date.now();
  const override = state.kvkDay1Override ? new Date(state.kvkDay1Override).getTime() : null;
  const sched = msScheduleSrv(now, (override && !isNaN(override)) ? override : null);
  const cycleId = sched.day1;

  let auto = state.msAuto;
  let changed = false;

  // Bootstrap: first time this code has ever run, adopt the current cycle WITHOUT
  // retroactively clearing or allocating anything that's already in the past for it
  // (e.g. deploying mid-cycle shouldn't wipe a KvK that's already underway).
  // Automation takes full effect starting with the next detected cycle.
  if(!auto){
    auto = { cycleId: cycleId, clearedAt: (now >= sched.openAt) ? now : null, allocDone: {} };
    MS_BOARDS_SRV.forEach(function(b){ if(now >= sched.boards[b].allocAt) auto.allocDone[b] = true; });
    state.msAuto = auto;
    msAuditPushSrv(state, 'system(cron)', 'Automation initialised for current cycle (no retroactive clear/allocate).');
    changed = true;
  }
  // New cycle detected — reset the per-cycle markers.
  if(auto.cycleId !== cycleId){
    auto = { cycleId: cycleId, clearedAt: null, allocDone: {} };
    state.msAuto = auto;
    changed = true;
  }

  // Auto-clear old submissions once, at Day1-7d.
  if(now >= sched.openAt && !auto.clearedAt){
    state.msSubmissionsByPlayer = {};
    state.msSubmissions = [];
    state.msLastAllocation = null;
    state.msAllocByBoard = {};
    auto.clearedAt = now;
    msAuditPushSrv(state, 'system(cron)', 'Auto-cleared old Minister Spots submissions for new KvK cycle.');
    changed = true;
  }

  // Auto-run allocation per board, once each, at that board's own Day1-36h mark.
  const submissions = state.msSubmissionsByPlayer ? Object.values(state.msSubmissionsByPlayer) : (state.msSubmissions||[]);
  state.msAllocByBoard = state.msAllocByBoard || {};
  let lastRunBoard = null;
  MS_BOARDS_SRV.forEach(function(b){
    if(now >= sched.boards[b].allocAt && !auto.allocDone[b]){
      const prev = state.msAllocByBoard[b] || null;
      state.msAllocByBoard[b] = msRunAllocationForBoardSrv(b, submissions, prev);
      state.msAllocByBoard[b].runAt = now;
      state.msAllocByBoard[b].day1 = sched.day1;
      auto.allocDone[b] = true;
      lastRunBoard = b;
      msAuditPushSrv(state, 'system(cron)', 'Auto-ran allocation: '+(MS_BOARD_LABEL_SRV[b]||b)+' ('+state.msAllocByBoard[b].winners.length+'/'+MS_TOTAL_SLOTS_SRV+' placed).');
      changed = true;
    }
  });
  if(lastRunBoard) state.msLastAllocation = state.msAllocByBoard[lastRunBoard];

  if(changed) state.msAuto = auto;
  return changed;
}

const SITE_HTML=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kingdom 1057 — Kingshot</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&family=Barlow:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg:#171210;--bg2:#1e1712;--bg3:#251c15;--bg4:#2f241a;
  --border:rgba(201,165,92,0.16);--border2:rgba(201,165,92,0.34);
  --accent:#a8322c;--accent2:#e08d5e;
  --garrison:#4a7fd4;--attack:#2ecc71;
  --enemy:#e04545;--gold:#d9a648;--green:#2ecc71;
  --text:#eadfc9;--text2:#a5947a;--text3:#6e5f4c;
  --mono:'Share Tech Mono',monospace;--head:'Cinzel',serif;--body:'Barlow',sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:radial-gradient(1100px 480px at 50% -8%,rgba(168,50,44,.12),transparent 62%),radial-gradient(900px 520px at 50% 112%,rgba(217,166,72,.05),transparent 60%),var(--bg);background-attachment:fixed;color:var(--text);font-family:var(--body);font-size:14px;min-height:100vh;}
.nav{display:flex;align-items:center;gap:0;border-bottom:1px solid var(--border2);background:linear-gradient(180deg,#241a12,#1c1510);padding:0 24px;overflow-x:auto;-webkit-overflow-scrolling:touch;}
.nav-logo{display:flex;align-items:center;gap:9px;font-family:var(--head);font-size:16px;font-weight:700;color:var(--text);letter-spacing:.05em;margin-right:28px;padding:11px 0;white-space:nowrap;}
.nav-logo span{color:var(--gold);}
.tab{position:relative;font-family:var(--head);font-size:12.5px;font-weight:600;letter-spacing:.03em;padding:17px 18px;cursor:pointer;color:var(--text2);border-top:2px solid transparent;transition:all .2s;white-space:nowrap;}
.tab:hover{color:var(--text);}
.tab.active{color:var(--gold);border-top-color:var(--gold);background:linear-gradient(180deg,rgba(168,50,44,.32),rgba(168,50,44,0) 88%);}
.tab.active::after{content:"";position:absolute;left:50%;transform:translateX(-50%);bottom:-1px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:6px solid var(--gold);}
.utc-clock{margin-left:auto;font-family:var(--mono);font-size:16px;color:var(--gold);letter-spacing:.08em;}
.page{display:none;padding:28px;max-width:1300px;margin:0 auto;}
.page.active{display:block;}
.sec-title{font-family:var(--head);font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text2);margin-bottom:10px;border-left:3px solid var(--gold);padding-left:10px;}
.card{background:linear-gradient(180deg,var(--bg4) 0%,var(--bg3) 100%);border:1px solid var(--border);border-radius:10px;padding:18px 20px;margin-bottom:18px;box-shadow:0 2px 12px rgba(0,0,0,.35);}
.card-title{font-family:var(--head);font-size:14px;font-weight:600;color:var(--gold);margin-bottom:14px;letter-spacing:.03em;}
input[type=text],input[type=number],input[type=time],input[type=date],select{background:var(--bg4);border:1px solid var(--border2);border-radius:5px;color:var(--text);font-family:var(--body);font-size:13px;padding:7px 10px;outline:none;transition:border-color .2s;}
input:focus,select:focus{border-color:var(--gold);}
button:focus-visible,.tab:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;}}
select{cursor:pointer;}select option{background:var(--bg4);}
label{font-size:12px;color:var(--text2);display:block;margin-bottom:4px;}
.field{display:flex;flex-direction:column;}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;}
.btn{font-family:var(--body);font-size:13px;font-weight:600;letter-spacing:.03em;padding:7px 16px;border-radius:6px;border:none;cursor:pointer;transition:all .15s;white-space:nowrap;}
.btn:active{transform:translateY(1px);}
.btn-primary{background:linear-gradient(180deg,#b8423a,#962b25);color:#fff;box-shadow:0 1px 6px rgba(150,43,37,.4);}.btn-primary:hover{background:linear-gradient(180deg,#c94e45,#a8322c);}
.btn-danger{background:rgba(220,50,50,.15);color:#e05555;border:1px solid rgba(220,50,50,.3);}.btn-danger:hover{background:rgba(220,50,50,.28);}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border2);}.btn-ghost:hover{border-color:var(--accent);color:var(--accent2);}
.btn-gold{background:rgba(217,166,72,.15);color:var(--gold);border:1px solid rgba(217,166,72,.35);}.btn-gold:hover{background:rgba(217,166,72,.28);}
.btn-garrison{background:rgba(42,127,255,.15);color:#6ab0ff;border:1px solid rgba(42,127,255,.35);}.btn-garrison:hover{background:rgba(42,127,255,.28);}
.btn-attack{background:rgba(46,204,113,.12);color:#5ddb8a;border:1px solid rgba(46,204,113,.3);}.btn-attack:hover{background:rgba(46,204,113,.22);}
.btn-sm{padding:5px 11px;font-size:12px;}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:3px;letter-spacing:.05em;}
.badge-tg5{background:rgba(217,166,72,.18);color:var(--gold);border:1px solid rgba(217,166,72,.35);}
.badge-tg4{background:rgba(201,165,92,.18);color:#6ab0ff;border:1px solid rgba(201,165,92,.35);}
.badge-tg3{background:rgba(100,200,100,.12);color:#7dc87d;border:1px solid rgba(100,200,100,.25);}
table{width:100%;border-collapse:collapse;}
th{font-family:var(--head);font-size:11px;letter-spacing:.08em;color:var(--text3);text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;}
td{padding:9px 10px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(255,255,255,.02);}
.mono{font-family:var(--mono);}
.launch-time{font-family:var(--mono);font-size:18px;color:var(--gold);letter-spacing:.08em;}
.copy-line{background:var(--bg4);border:1px solid var(--border);border-radius:5px;padding:10px 14px;font-family:var(--mono);font-size:13px;color:var(--accent2);margin:4px 0;cursor:pointer;transition:background .15s;display:flex;justify-content:space-between;align-items:center;}
.copy-line:hover{background:rgba(217,166,72,.10);}
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
.leader-chip.garrisoned{opacity:.5;cursor:not-allowed;border-color:rgba(217,166,72,.3);}
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
.drop-zone.drag-over{border-color:var(--accent)!important;background:rgba(201,165,92,.06);}
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
.pet-card.expiring{border-color:rgba(217,166,72,.6);background:rgba(217,166,72,.06);animation:pulse-gold .8s infinite;}
.pet-card.expired{border-color:rgba(224,58,58,.4);background:rgba(224,58,58,.05);}
@keyframes pulse-gold{0%,100%{border-color:rgba(217,166,72,.6)}50%{border-color:rgba(217,166,72,.2)}}
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
.bs-slot.drag-over{border-color:var(--accent);background:rgba(201,165,92,.08);border-style:solid;}
.bs-slot-label{font-family:var(--head);font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--text2);margin-bottom:8px;text-align:center;}
.bs-team-zone{min-height:120px;border:2px dashed var(--border);border-radius:8px;padding:10px;display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;transition:all .15s;}
.bs-team-zone.drag-over{border-color:var(--accent);background:rgba(201,165,92,.06);border-style:solid;}
.bs-team-header{font-family:var(--head);font-size:13px;font-weight:700;letter-spacing:.05em;color:var(--text2);margin-bottom:6px;}
.bs-leader-card{background:var(--bg3);border:1.5px solid var(--border);border-radius:7px;padding:8px 10px;cursor:grab;width:140px;transition:border-color .15s,opacity .15s;user-select:none;}
.bs-leader-card:hover{border-color:var(--accent2);}
.bs-leader-card.dragging{opacity:.35;}
.bs-leader-name{font-weight:600;font-size:13px;margin-bottom:2px;}
.bs-leader-meta{font-size:11px;color:var(--text3);margin-bottom:6px;}
.bs-pet-bar{height:6px;border-radius:99px;overflow:hidden;background:var(--bg2);}
.bs-pet-bar-fill{height:100%;border-radius:99px;transition:background .2s;}
.bs-pet-bar-fill.on{background:#a855f7;}
.bs-pet-bar-fill.warn{background:var(--gold);}
.bs-pet-bar-fill.off{background:var(--enemy);}
.bs-pet-label{font-size:10px;text-align:center;margin-top:3px;letter-spacing:.04em;font-family:var(--head);font-weight:600;}
.bs-pet-label.on{color:#c084fc;}
.bs-pet-label.warn{color:var(--gold);}
.bs-pet-label.off{color:#ff7070;}
.team-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;}
.team-dot.free{background:var(--green);}
.team-dot.rallying{background:#ff5555;box-shadow:0 0 6px rgba(255,85,85,.7);}
.bs-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px;}
.bs-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:12px;max-width:380px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;}
.bs-modal-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border);}
.bs-modal-list{overflow-y:auto;padding:8px;}
.bs-add-row{display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:7px;border:1px solid var(--border);background:var(--bg3);margin-bottom:6px;cursor:pointer;}
.bs-add-row:hover{border-color:var(--accent);}
.bs-add-row.here{opacity:.55;cursor:default;}
.bs-add-row.here:hover{border-color:var(--border);}
.ally-pill{font-size:10px;padding:2px 9px;border-radius:10px;cursor:pointer;border:1px solid var(--border);color:var(--text3);background:var(--bg2);user-select:none;}
.ally-pill.garrison.active{background:rgba(42,127,255,.2);color:#6ab0ff;border-color:rgba(42,127,255,.5);}
.ally-pill.attack.active{background:rgba(46,204,113,.2);color:#5ddb8a;border-color:rgba(46,204,113,.5);}
.bs-layout{display:flex;align-items:flex-start;}
.bs-sidebar{width:290px;flex-shrink:0;background:var(--bg2);border:1px solid var(--border);border-radius:12px;position:sticky;top:90px;max-height:calc(100vh - 110px);overflow-y:auto;margin-right:16px;}
.bs-sidebar .side-brand{padding:14px 16px;border-bottom:1px solid var(--border);}
.bs-main{flex:1;min-width:0;}
@media(max-width:900px){.bs-layout{flex-direction:column;}.bs-sidebar{width:100%;position:static;max-height:none;margin-right:0;margin-bottom:16px;}}
.bs-sidebar .side-sec{padding:14px 16px;border-bottom:1px solid var(--border);}
.bs-sidebar .side-sec h3{font-family:var(--head);font-weight:700;letter-spacing:.05em;text-transform:uppercase;font-size:15px;color:var(--accent2);margin:0 0 10px;display:flex;align-items:center;gap:7px;}

/* MINISTER SPOTS */
.ms-slot-btn{font-family:var(--mono);font-size:11px;padding:8px 4px;border-radius:5px;border:1px solid var(--border2);background:var(--bg4);color:var(--text2);cursor:pointer;transition:all .15s;text-align:center;}
.ms-slot-btn:hover{border-color:var(--accent);}
.ms-slot-btn.selected{background:rgba(201,165,92,.25);color:var(--accent2);border-color:var(--accent);font-weight:600;}
.ms-slot-btn.taken{background:rgba(224,58,58,.12);color:#ff8080;border-color:rgba(224,58,58,.3);cursor:not-allowed;opacity:.6;}
.ms-verify-field{background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:12px 14px;}
.ms-verify-field label{margin-bottom:6px;font-size:15px;font-weight:700;color:var(--gold);letter-spacing:.01em;}
.ms-slider-row{margin-bottom:18px;}
.ms-slider-row input[type=range]{width:100%;margin:8px 0;accent-color:var(--accent);}
.ms-rank-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px;}
.ms-rank-row:last-child{border-bottom:none;}
.ms-rank-num{font-family:var(--mono);width:32px;color:var(--text3);}
.ms-rank-row.winner{background:rgba(46,204,113,.06);}
.ms-rank-row.rejected{background:rgba(224,58,58,.05);opacity:.7;}
.phase-tabs{display:flex;flex-wrap:wrap;gap:6px;}
.phase-tabs .tab{border:1px solid var(--border);border-radius:6px;padding:8px 14px;}
.phase-tabs .tab.active{background:rgba(201,165,92,.12);}

@media(max-width:900px){.sim-layout{grid-template-columns:1fr;}.page{padding:14px 12px;}.grid2,.grid3{grid-template-columns:1fr;}#msSlotGrid{grid-template-columns:repeat(4,1fr)!important;}#msVerifyGrid{grid-template-columns:1fr!important;}.nav{padding:0 10px;}.nav-logo{margin-right:14px;font-size:16px;}.tab{padding:14px 12px;font-size:13px;}#syncStatus{margin-right:8px;font-size:10px!important;}.utc-clock{font-size:13px!important;}.phase-tabs .tab{padding:7px 10px;font-size:12px;}.landing-grid{grid-template-columns:1fr!important;}#bsTurretGrid{grid-template-columns:repeat(2,1fr)!important;}#page-strategy{padding-bottom:74px!important;}}
@media(max-width:480px){#bsTurretGrid{grid-template-columns:1fr!important;}}
#bsStickyBar{position:fixed;left:0;right:0;bottom:0;z-index:60;background:var(--bg4);border-top:1px solid var(--border2);padding:10px 14px;align-items:center;gap:10px;box-shadow:0 -4px 14px rgba(0,0,0,.35)}
.bs-launch-soon{animation:bsPulse 1s infinite}
@keyframes bsPulse{0%,100%{background:transparent}50%{background:rgba(255,80,80,.16)}}
.bs-launch-go{background:rgba(60,200,120,.12);border-radius:4px}
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
</head>
<body>
<!-- LANDING PAGE -->
<div id="page-landing" style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:24px 16px">
  <div style="max-width:520px;width:100%">

    <!-- Hero header -->
    <div style="text-align:center;margin-bottom:32px">
      <svg width="84" height="96" viewBox="0 0 60 68" xmlns="http://www.w3.org/2000/svg" style="margin-bottom:14px;filter:drop-shadow(0 4px 14px rgba(217,166,72,.25))" aria-hidden="true"><path d="M14 12 L20 4 L30 10 L40 4 L46 12 Z" fill="#d9a648"/><path d="M8 16 H52 V38 C52 52 42 60 30 66 C18 60 8 52 8 38 Z" fill="#7e1f26" stroke="#d9a648" stroke-width="2.5"/><path d="M14 32 L30 22 L46 32 V39 L30 29 L14 39 Z" fill="#d9a648" opacity="0.92"/><text x="30" y="56" text-anchor="middle" font-family="Cinzel,serif" font-size="13" font-weight="700" fill="#d9a648">1057</text></svg>
      <div style="font-family:var(--head);font-size:11px;font-weight:600;letter-spacing:.3em;color:var(--text2);margin-bottom:10px;text-transform:uppercase">KvK Alliance Command</div>
      <div style="font-family:var(--head);font-size:15px;font-weight:500;color:var(--text3);letter-spacing:.2em;margin-bottom:6px">WELCOME TO</div>
      <div style="font-family:var(--head);font-size:clamp(32px,8.5vw,50px);font-weight:700;color:var(--text);letter-spacing:.04em;line-height:1.05;margin-bottom:10px;text-shadow:0 2px 18px rgba(217,166,72,.18)">KINGDOM <span style="color:var(--gold)">1057</span></div>
      <div style="font-family:var(--head);font-size:11.5px;color:var(--text2);letter-spacing:.18em">✦ &nbsp; THE GREATEST KINGDOM OF ALL TIME &nbsp; ✦</div>
      <div style="width:180px;height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent);margin:18px auto 26px"></div>
      <!-- Story card -->
      <div class="card" style="text-align:left;border:1px solid rgba(201,165,92,.25);background:rgba(201,165,92,.04);margin-bottom:0">
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
      <!-- OUTAGE BYPASS — hidden unless kingshot.net is down -->
        <div id="bypassBox" style="display:none;margin-top:16px;background:rgba(255,157,77,.08);border:1px solid rgba(255,157,77,.4);border-radius:8px;padding:14px">
          <div style="font-weight:600;color:#ff9d4d;margin-bottom:4px">⚠ Player ID verification is temporarily unavailable</div>
          <p style="color:var(--text2);font-size:12px;margin-bottom:12px">Please use our backup method to enter the site.</p>
          <div style="margin-bottom:14px">
            <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px">👤 Members — enter manually</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <input type="text" id="bypassName" placeholder="Your in-game name" style="flex:1;min-width:120px">
              <select id="bypassAlliance" style="width:110px">
                <option value="">Alliance…</option>
                <option>FIR</option><option>LOC</option><option>LYL</option>
                <option>KNG</option><option>KOV</option><option>TLA</option>
              </select>
              <button class="btn btn-primary btn-sm" onclick="bypassEnterMember()">Enter</button>
            </div>
          </div>
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px">🛡 R4/R5 — enter your name, alliance & password</div>
            <div style="display:flex;gap:6px">
              <input type="password" id="bypassPwInput" placeholder="Password" style="flex:1" onkeydown="if(event.key==='Enter')bypassCheckPassword()">
              <button class="btn btn-primary btn-sm" onclick="bypassCheckPassword()">Enter</button>
            </div>
            <div id="bypassPwError" style="display:none;color:#ff7070;font-size:12px;margin-top:6px">Incorrect password.</div>
          </div>
        </div>
    </div>

  </div>
</div>

<div id="stickyTop" style="position:sticky;top:0;z-index:100">
<!-- USER BAR — shown after login -->
<div id="userBar" style="display:none;background:var(--bg3);border-bottom:1px solid var(--border);padding:6px 16px;align-items:center;gap:10px;font-size:13px">
  <img id="userBarAvatar" src="" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border2);display:none">
  <div style="display:flex;flex-direction:column;gap:1px">
    <span id="userBarName" style="font-weight:600;color:var(--text);line-height:1.2"></span>
    <span id="userBarPlayerId" style="font-size:10px;color:var(--text3);font-family:monospace"></span>
  </div>
  <span id="userBarKingdom" style="color:var(--text3);font-size:11px"></span>
  <span id="userBarRole" style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(201,165,92,.15);color:var(--accent2);margin-left:4px"></span>
  <span style="flex:1"></span>
  <span id="syncStatus" style="font-size:11px;color:var(--text3);margin-right:8px"></span>
  <button class="btn btn-ghost btn-sm" onclick="logOut()" style="font-size:11px;padding:3px 10px;opacity:.8">Sign Out</button>
</div>

<nav class="nav" id="mainNav" style="display:none">
  <div class="nav-logo"><svg width="26" height="30" viewBox="0 0 60 68" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0" aria-hidden="true"><path d="M14 12 L20 4 L30 10 L40 4 L46 12 Z" fill="#d9a648"/><path d="M8 16 H52 V38 C52 52 42 60 30 66 C18 60 8 52 8 38 Z" fill="#7e1f26" stroke="#d9a648" stroke-width="3"/><path d="M14 34 L30 24 L46 34 V42 L30 32 L14 42 Z" fill="#d9a648" opacity="0.92"/></svg>KINGDOM<span>1057</span></div>
  <div class="tab active" onclick="showPage('strategy')">Battle Strategy</div>
  <div class="tab" onclick="showPage('minister')">Minister Spots</div>
  <div class="tab" id="tabSwordland" onclick="showPage('swordland')" style="display:none">Swordland</div>
  <div class="tab" id="tabTrialliance" onclick="showPage('trialliance')" style="display:none">Tri Alliance</div>
  <div class="tab" id="tabAdmin" onclick="showPage('admin')" style="display:none">⚙️ Admin</div>
  <div id="syncStatusNav" style="font-family:var(--head);font-size:11px;font-weight:600;letter-spacing:.04em;margin-right:14px;color:var(--text3);white-space:nowrap;flex-shrink:0"></div>
  <div id="kvkTimer" style="flex-shrink:0;display:flex;align-items:center;gap:6px;margin-left:auto;font-family:var(--head);font-size:12px;font-weight:600;letter-spacing:.04em;background:var(--bg3);border:1px solid var(--border);border-radius:16px;padding:4px 12px;margin-right:12px;white-space:nowrap"><span style="color:var(--text3)">⚔️ Next KvK</span><span id="kvkCountdown" style="color:#6ab0ff;font-family:var(--mono)">—</span></div>
  <div class="utc-clock" id="utcClock" style="flex-shrink:0;margin-left:0">00:00:00</div>
</nav>
</div>
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
  <div class="bs-layout">
  <aside class="bs-sidebar" id="bsSidebar"><div class="side-brand"><div style="font-family:var(--head);font-weight:700;letter-spacing:.06em;font-size:16px;color:var(--accent2)">KINGDOM·1057</div><div style="font-size:11px;color:var(--text3)">Battle Strategy</div></div></aside>
  <div class="bs-main">
  <div class="card" style="margin-bottom:14px">
    <div onclick="bsToggleHowTo()" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;user-select:none">
      <strong style="color:var(--text);font-size:13px">ℹ️ How to use</strong>
      <span id="bsHowToChevron" style="color:var(--text3);font-size:12px">▼</span>
    </div>
    <div class="sim-info" id="bsHowToBody" style="margin:10px 0 0 0">
      Add leaders by Player ID in the sidebar, then tap <b>+ Add leader</b> on a turret or team — or the ⇄ button on any leader card — to place them. (On desktop you can also drag cards.) A leader can only occupy one slot at a time. The purple bar is the 2.5h pet buff — tap it to start or stop.
    </div>
  </div>

  <div class="card">
    <div class="card-title">🗼 Turret Assignments</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px" id="bsTurretGrid"></div>
  </div>

  <div id="bsAllianceZones" style="margin-bottom:18px"></div>

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
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-gold btn-sm" id="bsOffsetBtn-15" onclick="bsSetOffset(15)">+15s</button>
          <button class="btn btn-gold btn-sm" id="bsOffsetBtn-30" onclick="bsSetOffset(30)">+30s</button>
          <button class="btn btn-gold btn-sm" id="bsOffsetBtn-45" onclick="bsSetOffset(45)">+45s</button>
          <button class="btn btn-gold btn-sm" id="bsOffsetBtn-60" onclick="bsSetOffset(60)">+1m</button>
          <button class="btn btn-gold btn-sm" id="bsOffsetBtn-120" onclick="bsSetOffset(120)">+2m</button>
          <button class="btn btn-gold btn-sm" id="bsOffsetBtn-180" onclick="bsSetOffset(180)">+3m</button>
          <button class="btn btn-gold btn-sm" id="bsOffsetBtn-240" onclick="bsSetOffset(240)">+4m</button>
          <div id="bsCustomOffsetWrap" style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;border:2px solid var(--border2);background:var(--bg3)">
            <input type="number" id="bsOffsetManual" min="0" placeholder="Custom seconds" style="width:140px;font-size:14px;font-weight:600" onkeydown="if(event.key==='Enter')bsSetOffsetManual()">
            <button class="btn btn-primary btn-sm" onclick="bsSetOffsetManual()">Set</button>
          </div>
        </div>
        <div id="bsOffsetPreview" class="mono" style="font-size:12px;color:var(--gold);margin-top:8px"></div>
      </div>
    </div>
  </div>

  <!-- FINAL CALCULATION -->
  <div class="card">
    <div class="card-title">📋 Final Calculation</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:12px">Click a team below to calculate launch times for its leaders, based on the offset selected above.</p>
    <div id="bsTeamButtons" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"></div>
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:10px;font-size:11px;color:var(--text3)">
      <span><span class="team-dot free"></span>Free</span>
      <span><span class="team-dot rallying"></span>Rallying</span>
    </div>
    <div id="bsFinalResult">
      <div style="color:var(--text3);font-size:13px">Select an offset, then click a team to see the schedule.</div>
    </div>
  </div>

<!-- PET ACTIVATION PLAN -->
  <div class="card">
    <div class="card-title">🐾 Pet Activation Plan</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:10px">Select leaders, pick a UTC time, and add a plan. At that time their 2.5h pet buff auto-activates for everyone in the plan.</p>
    <div id="bsPetSelChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px"></div>
    <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <div class="field" style="margin:0"><label>Activation time (UTC)</label><input type="time" id="bsPetPlanTime" step="60" style="width:130px"></div>
      <button class="btn btn-primary" onclick="bsAddPetPlan()">+ Add Plan</button>
    </div>
    <div id="bsPetPlanList"></div>
  </div>

  <div class="card">
    <div class="card-title">👥 Rally Leader Pool</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:12px">Unassigned leaders. Use the ⇄ button on a card to place it, or a + Add leader button on a turret or team.</p>
 <div id="bsLeaderPool"
      style="display:flex;flex-wrap:wrap;gap:10px;min-height:70px;border:2px dashed var(--border);border-radius:8px;padding:12px">
    </div>
  </div>
  <div id="bsStickyBar" style="display:none">
    <span id="bsStickyInfo" style="flex:1;font-size:12px;color:var(--text2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
    <button class="btn btn-gold btn-sm" onclick="bsCopySelectedTeam()">📋 Copy</button>
  </div>
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
    </div>
    <!-- KvK schedule (embedded, same design as the Manage Spots board timers) -->
    <div id="msScheduleStrip" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)"></div>
  </div>

  <!-- STEP TABS -->
  <div class="phase-tabs" style="margin-bottom:18px;align-items:center">
    <button class="tab ms-step-tab" id="msStepTab0" onclick="msGoStep(0)" style="display:none">📋 My Submission</button>
    <button class="tab ms-step-tab" id="msStepTabA" onclick="msGoApply()">1. Apply</button>
    <button class="tab ms-step-tab active" id="msStepTab1" onclick="msGoStep(1)">2. Upload</button>
    <button class="tab ms-step-tab" id="msStepTab2" onclick="msGoStep(2)">3. Verify</button>
    <button class="tab ms-step-tab" id="msStepTab3" onclick="msGoStep(3)">4. Commitment</button>
    <button class="tab ms-step-tab" id="msStepTab4" onclick="msGoStep(4)">5. Timeslots &amp; Submit</button>
    <button class="tab ms-step-tab" id="msStepTab5" onclick="msOpenManage()" style="display:none;color:var(--gold);border-color:var(--gold);margin-left:auto">👑 Manage Spots <span title="Leader controls for Minister Spots. Lock players into specific slots, manually assign or move anyone (even non-submitters), and review who wasn't selected and why." style="cursor:help;opacity:.7;font-size:11px">ⓘ</span></button>
  </div>

  <!-- STEP 1: APPLY / BOARD PICK (rendered below the step tabs, like every other step) -->
  <div id="msBoardPick" class="card" style="display:none;margin-bottom:18px">
    <div class="card-title">👑 Step 1 — Apply: which minister spots are you applying for?</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:14px">Pick one or more. The rest of the signup only asks for what each one needs.</p>
    <div id="msBoardPickGrid" style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px"></div>
    <button class="btn btn-primary" onclick="msBoardPickContinue()">Continue →</button>
  </div>

  <!-- STEP 0: MY SUBMISSION OVERVIEW -->
  <div id="msStep0" class="ms-step" style="display:none">
    <div class="card" style="margin-bottom:14px;border:1px solid rgba(46,204,113,.2)">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <div>
          <div class="card-title" style="margin:0">✅ Submission Received</div>
          <div style="font-size:12px;color:var(--text3);margin-top:3px">Your entry has been saved. You're all set!</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="msEditSubmission()">✏️ Edit my submission</button>
      </div>
      <div id="msOverviewContent"></div>
    </div>
    <div style="background:rgba(201,165,92,.06);border:1px solid rgba(201,165,92,.2);border-radius:7px;padding:12px 14px;font-size:12px;color:var(--text2)">
    💡 <strong>Want to change your entry?</strong> Click "Edit my submission" above. You'll start from "Which minister spots are you applying for?" and need to complete all steps again. Your current submission will be kept until you submit a new one.
    </div>
  </div>

  <!-- STEP 1: UPLOAD -->
  <div id="msStep1" class="ms-step">
    <div class="card">
    <div class="card-title" style="display:flex;align-items:center;gap:10px">📸 Step 2 — Identify &amp; Upload <span onclick="msChangeBoards()" style="margin-left:auto;font-size:11px;font-weight:400;color:var(--accent2);cursor:pointer;letter-spacing:0;text-transform:none">← Back to Apply</span></div>
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
        <img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAcFBQYFBAcGBgYIBwcICxILCwoKCxYPEA0SGhYbGhkWGRgcICgiHB4mHhgZIzAkJiorLS4tGyIyNTEsNSgsLSz/2wBDAQcICAsJCxULCxUsHRkdLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCz/wAARCAIFAUADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyK1JEoNdVYXhRBWPpmnlyGYV0kOngIOK5FdHVox/9p5oOo0v2AelH2AelPmYuVDP7QzTDf1N/Z49KP7PHpRzMLIhW/wAHNObUAyU/+zx6UhsB6UczCyJdOkMkvtXSRWweMcViWFuIT0rehuFVRzWiZDQ37AvpTvsKgdKk+1rnrSfa19arQmwz7CvpQbFSOlP+1r60v2pfWi47EI09SelOe2CR4qT7UvXNMluFZetF0KxyWtKVkJx0qrZ3zR9a2dQhE7dKzxYAdqxd73RqrWsyQ6puFM/tIDij7APSlOnj0p8zDlQo1ICnf2kBUf2Cj7APSjmYcqGz3/mKaxrh2kk6Vt/YR6Uf2evXFRK8io2Rz2w+lOjDI4OK3v7PX0pf7OX0qOQvnIbS/Mairf8Aag61H/Z4HQUfYBWqk0ZNJjpNSDLWTd3JkJwK0/sA9KT+zlJ6UpNscbI5/Y3oaNh9K6P+zl9KP7OX0rNQNHM50Iw7VoWdwyDHpWj/AGevpQLBR0FNRcXdCck0A1MhaUapmg2A9KT7APStOZmfKgk1LKYrKurhpOAK1fsA9KQ6cpPSlK7KVkc8VbHSs67U12DacCMYrK1HTcIcCoULFOdy7pMIwOK3RgDpWXpK5QVs7OKszIs+1APtSuyoOartcqD1ppMLosZ9qKq/a1Hel+2L60WYrosZ9qTPtUH2pfWj7UvrRZjuiwGI6CneawquLhT3qwhVxRZhdB5zUGZqfsFNZQBzSDQb5zetL57VWknVT1qI3SjvRqRzxRe89qTz2qgb1fWj7YvrT1D2kS6XJ603PtVX7YvrSi6X1pB7RFv8KMn0qOO4Vu9WVAYUFKSZFz6UfhU2yo5GVByaEmxt2G/hSE+1QNdopxmm/a1rT2ciPaIs/hRn2qr9sX1o+2L60ezkHtEW8+1H4VV+2L605LxCetHs5B7RFj8KOnaljZXHFS7BUNNblp3Is+1GT6VKwCjmq0k6p3pxg5bA2PJPpRn2qD7Up7003SjvV+xkLmRZz7UZ9qrfbF9aBdr60eykHMizn2pPwqD7UvqKljmVu9DpSQ+ZEg5HSqOoRgxnitJQCKpX4xGaz2AraT9wVsNwlY+kfdFbEn3KAMjULkxg81km8Zm4NXtTXdmsqGP95XTCN0c0pWLQd2GeaeC2OtXLe1Dx9KV7XaeBV+zZHtEU8vjvSM7hetaKW25elVbq3Kg8UnBoFUTKIvHR8E1tWFwXArnmQmT8a2tMXbioktDWL1N1TlaqXcm1TVpfu1Q1D7hrnLqO0bmJPeEy7QaYJHbvVGZit3WlaKHA963jTbPHpVlNtMhBfd3p+H9a0DZ8ZxSJbfNgir9kzqVij8470ySRlHBrUktflyBWRd5jzmolCxMpxSH2l83mgE10tpJvUVxdqS10D2rrtPzsFZSVhYStztl9jhaxNUu/KU81tSfcrmNaGVNdOFgpS1OrEzcI3Mk6m7zYBNXoJpHHOaybWDfPmumtLMFOleliIKOiR5+Hm5K7ZTyxzSDzM98Vfe0KnpUsdpuXkVxWkdd0Ys8rp0NUxqbpMASa1dQtGUEgVzjRnzjkV3YenzLU4sRV5NjstNujIqnNbacrXMaKDsWuni+7XmYqCjI9PDT54pkF0+1DXM3+oFCQDXQ3/wBw1yN6m6U/Wu/A001dms2WLe5kcZyasM77aZp8AKgVpPZkrwKVa6loYe0RnFnI4NIHkA5Jq8lsQ2MVJLZfJwKxvIPaIxJruRD1qxYX7O4BNVL6FkcgiksEIlBr0qdNSp6lpnY2sm5BUeoD92aSx+4KW/5iNeBXXLOx0R2Kej/dFbMn3KxtI+6K2JPuVihsxr5c5rMA2SZrXulyaovFmuym7HLJXNLT3UgCtJrdWGcViWO6Nua20mHlYJrqV2ckrISOFQ3So7q0DoTinCXB61I848vrTcWyOZI5ue12SdKu2IwRTbp1ZzipLQciuSqrHZSlc1U+7VC/+6avL92qN7yprjNq3wHJ3i/vjV3TpgCFNQ3SZlNNto2E2R0rspSsfJwquNVnYW4WWMClNuqt0qpp8pVRmrkswNdiuz2VJWHeQrJ0rH1LTxtPFa8c4HGarX0yletRODZM1FrU5aC3MVziunseFFYZIa64rctOgrzqisycvSUmkXJfuVzerLlWro5PuVz+pjINduB+M7cdpBmDbt5U2T0rqtMnR1Arl2jzWtpO9CM17OIgrXPEwlXXlOoeBWUHApqRKOMURz/uuaYJcP1rzkmendDbyyEkROK5XUdP8uTIFdi04MZzXP6lKjMa2ouUZHPXUXEZpK7QBXRxfcrn9O65Fb8X3a4Md8R6OC+BFa95Q1y92n7wmuovPuGueuUy5r0Mv+E6Zhp84RwDXT2wWaOuRjiYSAiul0+UogBq8RBXujjqJItm2VTnFP8AIV1xiklmBHFEc4FctmY8yMfU9PGScVkwQ+XLj3rpb6ZSp5rDyDNxXXRk7WZvTnfQ2bIfIKS//wBUaWz+6KS//wBUa8PE/Gz0I7FPSPuith/uVjaT0FdBDYXd4pNtazThevloWxXMMx51yaqsADzW/JoOrN00u8/78mqc3hnW2+5pV5/36NdUJw6s5pxl0RQjkQd6c12AcBqcfCniLJ/4lV3/AN+zTT4T8RH/AJhV3/37NejCtRiviR5s6NaT2HLcBu9Qz3JPANXIfCuvKPm0q7/79GpR4W1nGTpV3/36NTLFU1sxxwtR7mMu52rRtVxVxPDOrr/zCrz/AL8mrCaBq6H/AJBV5/35NcFSrGXU9CnTcCNfu1TvB8prXXR9Vxg6Xe/9+TUE+hatIMDS7zn/AKYmuW6NKybhZHIXCZepYAigZrZl8J645+XSbv8A79Gq58H+Iy3y6TdYHrGa6qMoX95nzUcLVU2+V/cNWdI04NKLnd3pf+ER8S550m6x/uGpU8KeIFIzpV3/AN+zXpfWKKVk0daoVW9mRNcBV4NZtxcu2a3h4W1vjdpV5/36NNPhPWNwzpV3/wB+jWM8VC3usc8LVktDnbVWMu9q6K0HyinDwtq6kY0q7/79Gr1voWrIPm0u8H/bE15k58zubYLDzpP3kQSfcrC1EZzXVvo+qFTjS7z/AL8ms268M61KDt0q8Of+mRrrwdSEJXk7HXjYSnBqKucnGgL81qWxRAKsN4N8Q/w6Tdf9+zSDwh4mUcaTc/8AfBr16mJoy+2vvPDoYarBawf3Cm7CjANKlyG5zUZ8H+KCf+QTc/8AfBqaLwn4iTAbSbr8IzWLr0V9pHTGlVb+Fla4uyFIBrInd5HxzXTnwprbcHSbv/v0aQeEdZyf+JTd/wDfo0QxdJPdCq4OrJGbpilVGa34vu1FB4Z1mIjOlXn/AH6NaKaPqqrg6Xe/9+TXm4urCcrxZ6uDpyhG0kZN3yDWLKvzGupm0PVpB8ulXn/fk1Sl8La22caTef8Afo12YTEU4R1kjomn0MSEKp5q6syqODT38JeIt2V0m7/79mkPhPxJj/kE3X/fs10PEUW/iR5lanVk9EAuwT96ke6CrkGk/wCEQ8S5z/ZN1/37NOHhPxET82k3f/fs1Lr0f5kYLD1exn3Fy796ZbqWkBNbKeE9az82lXf/AH6NTp4Y1hOmlXn/AH5NEcXSWl0ehRouC1I7XoKbf/6s1ox6LqdvCZJtOu41UZJaJuKzr7/VH6V49eSlO6O6OxT0f7or2HQWMGgWaxMUUxhiAcZJ6mvHtH5Ar1/Rv+QHZf8AXFf5Vw19kbU9zS+0Tf8APV/++qPtE3/PV/zqKlrkNiT7RN/z1f8A76pBcTf89X/76plFAFkahOI9uQT/AHj1qvcal9nQNPdeWCcAs2Mn0FNzUdpPLaTa5qFsive2VlH9n3Jv2bmbcwH4D8qunDnlYmb5Vckt9SF0G8i78zbwwV+R9R2qRriYf8tn/wC+qFUa0fD09/evb6hem4thcxRKhuFXLKSpBGPlz+PHWorTRrt7+2s7/VWguRZvd3kaogCANtXaSPlzzknPStnhpfZM1Wj1JTcTAZMr/wDfVH2mYDJlf/vqq8qafFBqM7a3d3dtZmAD7IkUjfvOMcD5jn07U1dOGoaampxapdjRjZzyXDSxoksbocbcbeP4sg88Uvq0x+1iWINRW4QtBeCXHXa+cZ6VIbiYD/Wvz/tULo32pra9l1aS2soNJtgRtiRuSTksRgcY/wDrVCulS3823Sdba+8m9S3uGCRlUiZd24YH3gCPbrxTeGlfQSrR6k32iYDBlf8AOopr1reMyS3JRcgZZqp+IbW40bTL/U21WR7OMQ/YnWJGMpc/NuGBkAc8YqLT75L66t3hnaeKDVYo45miMRcB16qenJI/CodCUWkylUTV0Xk1eOeXyor4O+M7Q/J/Cp/tE2M+a/51N4gW+/sq8N/e2t282qxQ6a0cWTbZkA2uR3Azn8s81FfabZQanb2J8ULFMZfKmjk8ov8AdLZUAfL0754rSWGlf3SFWXUaLib/AJ6v+dL582cea/51Fqdh/Y6Xt3e3moLp1mkTApDG0sjO2OCOCo47Z5qtr9nfaPbXc0d/JO0V1bwxDyl5SXAJYY+8MnkccDip+rTRXtYl4XE2cea/50C4mJ/1r8f7VVruC10k6lLe6nqbR2d4lqBBDG7HdGrA4289T/hWfq15DpMFjA+o3r6lqEKT25FoptyHYKqtjkdck5/oKTw8w9rE2RcTdfNf86PtExP+tf8AOnX+l2lncw2beJ1inMyxSrIIixBBOVUcqeP4sjFUr9ZdG1CaIme4jFuk0RmCAuxcrgMvBH3eccZolQnFXBVYvQe2sQo7RtfAOrBCC/Q+n1qaS9aCFpJrkxovVmfAFWY9LmvLOPwvbanDG1sCNViSD7wk+cOjMOSDxnnOT0OKwP7QSC8sb2VH1CC01F0ZYo8vIF3qGCDqRw2PbNVOhyta7ijUvfQ0rfU1nDLFeb2AyVDHOPXFTefMB/rX596S7t7zxJqmj3UWti40qeaZY5UtRFPE2wkIdw5X5SOgOfXrSWOmnV47C6sdVuBp86ymVriFFlBjOPl4wATnrnAFN4aV/dEqy6j/ALRN/wA9X/76pkl60K75bhkTpktxT49NtZ5Lq4j8Ro+mwRI7OjRF1YkjDPjbgY9O9MtbK1iu7C7utWlvoG1NILP7Ii7WYcgyH6gg4x0pLDTvqN1o9BUvGkjDxXBdD0IbinfaZ8cTP/31WTPFcvqELQ3cype+IJ7GRVRSETcx3A465HfIq3Z2sPnQRXWq6j5l1qM+nxeXDEVBQtgt8vAwv50vq0r6B7aJa+0zE/65/wDvql+0Tf8APV/++qrz2Mtt4bu9RTUZby6tt++KCOPy12uVwyn5scckH1p+aznTlTtc0jNS2JvtE/8Az1f/AL6ppuJv+er/APfVMorMoJLyWILmWQljtVVJJY+gHemNqZIXbLMxYlQigl8jqMdeO9NaSSC7gmtl8y8XIjjxneD1B9B79q3J4FtI7rUbSxSXUWjGUDYLH0z/AJzirjG6IlKzsZIu3mjVknZkIyCG615R4mRY9XvUQBVWRsAdq9MtG3xNNv3tKxdjt2/Meox2+leaeKf+Qzff9dTWtDdk1NkYujn5RXr+jf8AIEs/+uK/yrx/SPuV7RocCN4fsCc5MCHr7VpVTklYmDs9SairP2ZPf86X7Onv+dc/s2a86KtFWvs6e/50n2ZPf86PZsOdFaq8kVxHdreWF7LY3aqY/MQBg65ztZTwRnmtH7Mn+1+dH2ZPf86ahJO6E5RejMa6s77UJo7q91a4nv4CGt5wiqICCDlUAxzjnPUcU+Ozv01Q6sNZuP7UZfLa48tMNHjiMpjbtzz9a1vsye/50v2dPf8AOq/edyfc7GM9pqM91LJc6xLNHO8byxiCNA/lnKjgZAHtSXGn3MsF1aJqU8en3cvmzWiou1icbhuxkAkDIHv61tfZk9/zpPsye/50fvN7j9zsZNtDq9rMJYdenDLAtuFaCNk8tc7QVxyRnr1pLa11G1nu7mDWriK5vv8Aj5kEMf70gYBxjC4HHFa/2ZPf86X7NH7/AJ0Xq9xe52OfGj3EthBp9xqtxLZWY/0aIog8pv4WzjLEds1YksrmVJGk1CVrySdbk3PlrkOpGPlxjHygYrZ+zJ7/AJ0htkPrQ/aPdjvDsYL6dqIhvIotdukS/k865xFH88nHzLx8h4HT0Bq2W1ySeKSXxBKWhO5GFpCCTgj5uPm4J9K0vsye9Btk9/zp3q9xe52Mxv7b+3tep4huPtLoI33QRmIqOQPLxgYJPPXmmRR6xb3Nxc2/iC6Se7Ia4doo33EcAqCMJgccVrfZk9/zo+zJjv8AnRer3D3OxjtaX816ZrzV5rpJJknkiaGNQ7ou1TkDI4/Ole01JtOOlrrt0mnbdgiEab1T+6JMbsfrWx9lT3/OlFtH6n86X7ze4e52MuVtdl8rd4hnJhYMjfZotxIBHzHb83BNMubS41AztqV/LePNEIc7ViEag5+UL0Oec+wrXFtH6n86PssfqfzoftHo2C5F0MuaXxDNGkT+J7wJHgqY4Y0ckdNzAfN9O9RraXOWnbUZhetcfaftKIisH27fu424xx0rX+yx+p/Ol+yx4xz+dD9o92C5F0MldQ1W113T9U1XUb3U4bWR/wBzBbqNu6NgG2r1OSBk9M1DbnW72W21O71u6ivo0PlBYkVIg33lKYw2eM59K3fs0arwT+dIbWPHU/nVc1W1ritC97GQsWtJeyXa6/MJ5IxE3+jReUUBJA8vGOpPPXmnWyazZC4Nv4iuVa5kMsmYIiC/qox8vQcCtUWyep/Oj7MnqfzpXqdx+52Mexi1qxFx5HiG5Q3MxuJSYIjlz1I4+UHA4FEGs6tFappttc3cF2buea4vDaJsdW5BUkbQSSOg7VsG2j9T+dKbWMjGT+dNSqLqJqD6GILbUzpR0067dNYtlWjMab2UnJUyYzg5PvzV8cVb+yx+p/Oj7LH6n86iUZy3ZSlFbFXNGatfZo/U/nR9lj9T+dT7ORXOik3mLNHNBJ5c0fRsZBHcEdwajH2qG4NzDc/6U+fMdxlXHoR6Dt6VofZY/U/nR9mj9/zp8kkLmiykibEwWLsSWZ26sT1Jry/xSP8Aic33/XU166baP3/OvJPFq7Nf1FR0Ex/kK1pRabuRNprQwtIHyV7doP8AyLun/wDXun8q8S0f7le2aD/yLun/APXun8q1kZovSOsSFnOAKzn1lFYhY8j61Jq5ItBj+9WHWTZoka41of8APL9aP7aH/PL9ayRRSuVZGt/bQ/55frR/bI/55frWTQAWZVVSzMQqqBySTgCi7CyNb+2h/wA8v1o/tof88v1qldade2IVru0lgVjhS44J9Miq4Gee1N3W4kk9jW/tkf8APL9aP7aH/PL9aye9KV4zSuOyNX+2h/zy/Wl/toZ/1X61kYwuaUCi4WRq/wBtD/nl+tH9sj/nl+tZNFFwsjW/tof88v1pP7aH/PL9ayaDRcVka660hYAxED61oRSpNGHQ5Brl62dGJMDjsDTTE0dDpdmt1Kzycxp2Hc+lbaxRKAFhiAHbYKzdE/1M3+8P5Vq4rqgtDF7jdif88ov++BRtT/nlF/3wKdijFWSN2p/zxi/74FJtT/nlF/3wKfijFAxu1P8AnlF/3wKNsf8Azyi/74Fcw3jq1bxLJo9vpt9c+RMLea4iQFI3Pr3x710i3MDybEnidupCuCcVKaew3Gw/Yn/PKL/vgUbU/wCeUX/fAqNbu1aJ5BcwmNDhm8wYH1Oaoa94hs/D+iTanORKkab1jR13ScgfLnr1p3S1FY09kf8Azxi/74FGxP8AnlF/3wKigu4LiBJRLGofHBcZBIzj6+1Ed5ayMypcQsVGSFkBwPXrQFiXZH/zyi/74FG2P/nlF/3wKbFLFOm+KRJF/vIwYfpUlADdsf8Azyi/74FGxP8AnlF/3wKdRTAbsj/54xf98CoZ7OC5jKtEqN2ZBgirGKMUAcrKhikaNuqkg1474v8A+Rj1L/rsf5CvZb7/AI/p/wDfNeM+Lv8AkY9S/wCux/kK547lmJpH3K9r0L/kXtP/AOvdP5V4ppB+QV7XoXHh7T/+vdP5USGg1f8A49F/3qxM1tax/wAei/71YlYs0jsOFGaSjmkUGadEyJcQvIdqLKjMfQBgSaZS0wZ0d3qmjXkgjE/+jNqXm3CSszeYuMBk9FzjI9jUy3fhxbuRXj01EMYG8HcOp6LtxnGOnNctk+9Ick55rX2r7GPsl3N60k0CKwhaY2rwrEu5fLb7QZd/JP8As7e1EbaJa30ebjT54zc3EnCZCoyHy1PHY1hbjjHNKCcd6XtPIfs/M0vtdpdaQzeXpVteFm85ZImBZdvymPHQ/TvWtJdeGxPaCOKwMQPV2IYDb/EMdc/3q5ftSZOKFUa6B7PzLWpG2OrXRsnR7YvmMxrtXGBkAfXNVs0g6UVm3d3NErKwuaSijpSGFbGi/wCpk+orGrY0TmKX2IpoUtjrdC/1U3+8P5VrgVkaD/qZj/tD+VbArshsc0twxRinUnFWSNxSEU6igZ5lrXhPXr3xyNQ0/TrewK3Kv/aEN0VMkQxkPH3Y1z3hvwpquuI95YW0FnEpvYzeCbDTFiVVCo5AFe29Kihghto/LgiSGPJO1FCjJ6nArJ003c09o0rHjK/DfxCmk+WliUYTRNLCbqMiYKpBIGMDr3zT7/4c69JbCGPTIroPZCCLzrtS1o4cscHAByPT1r2ek70vYxH7VnlsnhTxLFeGBdNt2tn1OHUGl+0rkBVAK49ua53w94Q1PXNOF1ZadFHbql1C86XAR7osxAQj+HHvxXunU0yCCG2i8uCJIo8khUUKMnrwKPZK4e0djlPh3oeo6DodxbahbRW5afdGqlS23AGWK8Z4rraWitErKxDd3cMUuKKUUyQAoxSg0vFMDk7/AIvp/wDfNeNeLf8AkYtS/wCux/kK9mvx/wATCf8A3zXjPi//AJGLUv8Arsf5CuZbs06GHpA+SvoXwhpMUnhfTZ7gbi1uhC9sYr570n7or6X8LceEdJ/69Y//AEEVoknuS3YsSaPp8y7ZLSNh6HNRf8I7pH/PhF+v+NadFXyrsK7Mz/hHdI/6B8P6/wCNH/CO6R/z4Q/r/jWnSUcq7Bdmb/wjukf9A+H9f8aP+Ed0j/nwi/X/ABrTpKOVdguzN/4RzSP+gfD+v+NH/CO6R/z4Q/r/AI1p0Ucq7BdmZ/wjmkf8+EX6/wCNH/CO6R/z4Rfr/jWlRRyrsF2Zv/CO6R/z4Rfr/jR/wjukf8+EX6/41pUUcq7Bdmb/AMI7pH/PhF+v+NH/AAjukf8APhF+v+NaVFHKuwXZm/8ACO6R/wA+EP6/40f8I7pH/PhD+v8AjWlRRyrsF2Zv/COaQf8AmHw/r/jUsWi6dApEVnGgPXGau0tHKuwXZDFaw24IijCA8nFS4FFFMQYoxRRQAYowKKKADApNopaKAE2j0o2j0paKAE2ilwPSiigBNoo2j0paKAE2j0owKWigAxRiiigCndaXbXCu2zZI3O8etfPnjONofFGqRuPmWcg/kK+jzXzx8QRnxrrH/Xwf/QRUSS3KT6HN6T9yvpbwt/yKWk/9esf/AKCK+aNJ+5X0x4W/5FLSf+vWP/0EURCRq0UUVZIUlFFABRRXOeJPEN1od/GYoRPCLKe4aPABLJtxz2HJzSbsB0dFc6vjG1Gpw6fLaXKXDhN4wpEbOpYA4PoOo4GRmoF8e2bQiX+zdQCG3F1uKp/qt20v97se3WjmQHU0Vlaf4ht9R1i706OGVJLX7zPgBunQZzjnrjFatNO4BRRRQAUUUUAFFFFABRRRQAtFJRQAUUUUAFFFFABRRRQAUVX1CZ7fTbqeMgPFC7rkZ5CkiuZsvGzLYyzahZSBYLe2kMseP3jyqCABnjJPH45pNpbgddRXMnxxaC288WF6wEUkzqqrlFRtrE88+vHUUsvjeyghmeWyvEeKVIjGyqD867lYnOACPU9eKXMgOlopsbiSNXHRgGH406qAKKKKAClpKWgBD0r56+II/wCK01j/AK7n/wBBFfQp6V89fEH/AJHTWP8Ar4P8hUy2GtzmNJ+7X0x4X/5FLSv+vWP/ANBFfNGkY2V9L+F/+RT0r/r1j/8AQRSiORqUtVru6+zqAoy7dM9qprJezZMZkYew4puXQVjUorN26h6S0u3UPSWjm8gsaVUr7SbLUX3XcAlPlPBySPkfG4fjgVWklvIiPMaRc+tM+1z/APPVqTkuocpJF4d06C5S4jSYSqoUt57/ADgDA3c/NgHHNMHhjSRbLALb5BbG0A3n/VE7tvX170n2uf8A56tR9rn/AOerUuZdh2Zah0axg1M6hHExuShQO0jNtU4yACcAcDpV6sf7XP8A89Wo+1z/APPVqfOhcpsUVj/a5/8Anq1H2uf/AJ6tRzoOU2KKx/tc/wDz1aj7XP8A89Wo50PlNiisf7Xcf89Wo+13H/PVqOdC5TYorH+1z/8APVqPtc//AD1ajnQ+U2KKx/tdx/z1aj7XP/z1ajnQcpsUVj/a7j/nq1H2uf8A56tRzoXKbFLWP9rn/wCerUfa5/8Anq1HOg5TXorH+1z/APPVqPtc/wDz1ajnQ+U1ZokngkikG5JFKMPUEYNZcnhbSJEZDbMFaKOEqJGAKp9w9eoxwetJ9rn/AOerUfa5/wDnq1HMmHKSP4d054zHJHJKDA9uTJKzMUY5YEk55IpLjw1pdys6yQuBcBBLslZd4VdoBwem3imfa5/+erUv2uf/AJ6tS5l2DlZqxRJBCkUShI41Cqo6AAYAp1ZH2uf/AJ6tSfa5/wDnq1PnQcpsUVj/AGu4/wCerUv2qf8A56tRzoXKbFFY/wBrn/56tVi1vXMgSU5B4BpqSCxfPSvnr4hf8jprH/Xc/wAhX0KelfPXxC/5HPWP+u5/kKJbAtzmNJ+5X0x4X/5FPSv+vWP/ANBFfM+kn5M19L+F/wDkUtK/69Y//QRSiOQ7Uf8Aj5X/AHan1bWLXQbS1My/8fEy28S7goLkEgZPA6GoNR/4+l/3R/OrWt6LZeINFm02/iEkEy8+qnswPYg8g1rRtze9sZVb8uhmX3jCLTIw99YzQK8iwxtvQqXY4AJzhfxq7b67vukiubSS1WQhVdnVhu7KcHjPauR0iOZ9F1HQ/E7xXP2WU2n2luVvI8ZBIHIcAgN70/w7cwtb3+lXtx9otLRhDBdyA/v1IzsPcsnALD275r03houLcX/X9f1oeb9YlGXLKx3V8oaykzzgZrBo0XWk1C01KwE/2p7Dapm/vBgSAf8AaGOfwNc/4l1C8h1DSNMsrr7E2ozSK1wEDsqohbaoPG5ugzXlV4uMuVnp0JKceaOx0NJXEW/jhLG0itnW/wBXu98+/fbrBKqxkbgVHVhuA46+1aH/AAm0K6qYJdOuI7YXT2huCykCRY/M+71wV/WsLG9jp6K5GLx8lxaQ3EWjXZFzJDHAC6gSeaDtO48D7vI7ZFTzeMkj1NNPlsnhllHlblmRzFKYy4VgPTHX9KLBY6ftS1xz6hr178PNIvbCR3vbhIXuGjVPNZCMv5Yb5S3Tj61FbeO47bSFfyrrVPJtjcz3BVIXVRKY2DJ/eU9QOtFgsdrRXIt8RLELfTCwuza2gk/fgAh2RgpX/ZyTxnrg1HqHjacaXKttpdzHfNBcyBWZQIliUZkyfvDLDGBzzRYLM7LtRXL2vjGP7PFHNbyyTI9nBI4IAZ50DBvYDvVjQ/F0WuXkNv8AYJ7X7Rbtcws7qwdVfY3ToQfXrRYLHQUUUUhBS0lFABRS0lAC0UUUAJRS0lABS0lLTAKKWigBMUYpaKAEooooAKcn31+optOT76/UUAbZ6Gvnv4hf8jlrB/6bn+Qr6EPQ189/EE58Z6wP+m5/kK1lsQtzl9J5jFfTHhf/AJFLSv8Ar1j/APQRXzRo/wByvpfwv/yKelf9esf/AKCKURyF1H/j6X/dH86p+PPFCeE/C5v3Zk8yRYBIF3eWWz82O/Tj3xVzUv8Aj6X/AHafJdWl7afZ762WdOMqyhlOO+DWlKcYzvLYzqRco2ieMaj8RdGexiW1nuFi3COSURktEp5z9Sc8nuc1as/FcXiFLbSfCsTy3hxEisu1YE7uT7dSfU+pr1VLTQI45Y49Kt0SXHmAQKA+OmfWpLCLRNMleSx02G1eQYdooVUt9SK9Z5jBK0Y27a/8A8j+zG3eUnruR6H4atfDHhuS0gJklkBknnb700h6sf6DsKztS0qx1e2+z6hax3MQYMFcdCOhB6g+4rcu9SWWAxxK3zdSfSs2vGqz55XuezShyR5UrGPH4S0KKCKFNNiRIWZ02lgQW+8dwOTnAzzzVptF01nDmzi3ef8Aac4P+t27d31xxV+isjUy4fDekW0McUNiipFIsyLuYhGXO0gE8YyeBxzSv4d0iS+e8ksImuXcSmTJ5cDG7GcZxxn0rTooAzp9A0u50mHTJrKN7OAKI4uQEx0wc5GKzD4H0g6tDObSH7HDbCCO1CkKD5m/ceeeexzXSUUBcyl8NaOJbtjp8RF4GE65O1933srnGTgcgU2bwroc9tDby6dHLHDu2B2ZiNwwwyTkg4HB44rXpKAMn/hFtEa+S7bToTNEIwj88bPud+o7GofDfhWy8O2yCNUlu9hSS4wQXG4tjBJwOegrdo7UBcKKKKQgooooAWikopgFFFFIAooooAKWkooAWlptLTAU0lFFABRRRQAU5Pvr9RTKen31+ooA2z0r57+II/4rPV/+u5/kK+hD3r58+IP/ACOer/8AXc/yFay2IW5y2kfcFfS/hf8A5FLSv+vWP/0EV80aT9z8K+mPC/8AyKelf9esf/oIpRHIkv1DTjI/hqusG4/KjH6Vavf9eP8AdqXUtUtNCsIpbgsqPIkKBQMl2OAOSByfWqjDndkRKfKrspC2fP8Aq3/I0G2cH/Vv+RpLzxdZ6bCJb63uraNpFiRnVcMzHAGQ3HPrgVYh8QwyXiQTW1xbCRtiSShdpbsvBOCe2a09g7XsZ+3jtcrNDtPzKR9aTy19K2rxQ1o+RkgZFcP4p8Tnw4bBEtoZXvpWiV7icQQxkLn5nIOCeg96xlGzNovmN7y1pfLX0rNTxBpy3dvY3V3b29/MisLfzAxBYZAyODnnHr2rHuvH9jbeEY9VlES3k0TSx2XmfM+H2HBx096VitTqvLX0o8tc9KxYvFWnwpePqNzbWi29y1up83eWwoY5AGQcHkdhzVyLX9JuNTGnw6hBJdkZ8pWy3QN/Ig/SkGpe8tc9KPLX0rmzr+uDxSdIOj2gURi4Mv2w58kvszjb97jOP1q6PF3h9rdrhNWt3iQgMy5OCc47ex/KiwamsY19KPLX0rHTxTp32qXzby0SzWKGSO484HeZCQoxjgHHB70h8V6YbiBo7y0aykhlme4M2NgjIB+XHIyefSiwam15a+lJsX0rN/4SjQzay3A1S3MMUghZt3Rz0XHXJHIq7Y39rqVml3ZTpcW8mdsiHKnBwf1FFg1JvLX0o8tfSnUUWEN8tfSjy19KdRRYBvlr6UeWvpTqKLAN8tfSjy19KdRQA3y19KPLX0p1FFgG+WvpR5a+lOoosA3y19KNi+lPoosAzy19KBGvpTqKLAN8tfSjy19KdRRYBvlr6U5UXcOO9FOX7w+tFgNQ96+e/iD/AMjprH/Xc/yFfQhr57+IH/I56x/18H+Qq5bCW5y+k/c/Cvpfwv8A8inpX/XrH/6CK+Z9J+4PpX0z4X/5FLSv+vWP/wBBFKI5E95/x8L9Kk1zRrLxBok+l38fmQXC4OOCp6hgexB5B9qivf8AXj6VwPjjxXrVt46j0rTLG51C3htVkkjt7tbbY5zyzHqcYwOla02020ZTV0ammJM2maj4d8S+XcGzxAbqQfu7uJhlSfRwOo+h70zw9NA0V9ol3crdQWIVY7tycSIwJWNj18xQOo7bT1rhLvxjHY3tzaX1xJA29ShmzI0W/lyxH3iD/TtirsfiqxvY7bSvDJa9vpG8uKPYRgnrIxI/EmvoacHUpczej1fZef8AX+R89VquFVxUdvx/r+up6bo2tpfpf6cbhbmewVd0inO5Wztz/tfKc/ge9ZniLRrrWrRYLfUfsa/MJFa3SdJARjBVvTsa0vDnha38LaFPGH8+8uf3l1cHrK/+A6AVz3jVtRSCyeyuZUhSR2uYbe5S3nlQLxsZuDg8kd6+fr8vP7mx9Bh+fkXPuVbb4e29pHbxQalP9lRrZ5ImRS0jwfcO/qo9QPTioT8Ol+yfZotXmiSS0NpOfJVvMTzTIMZ+6QT26iorb4hKHh8m0e6sE+yI1zLMFmcTjAbZjBII55+lSL8RJZNJbUBokqwzPGlo+87ZC8hQBjt4IxnjPp1rA6dSfUvAUN5fy3i3xWWS6kuCJIQ6YkjVGQrkZGFBzmtzRtFi0mS9eN932qRHC7Aoj2xqgAx2wtcj4g8Z6lJ4fuYILFtOvVtPtMzyTbGiHneWNgx82cE844PrWtL42W3umt/sitIl9NZY83BPlwmTfjHfGKBam5/ZIPiV9XM7FjaC1EW0YADlt2fxrLbwdjw1p+kQ6nNELKRpC4T/AFoJY7WAI6buOeop/hrxRLrl7Lbz2SWzi1gvEKTeYCkoOAeBhhjpXRUC1Rx+n/D6CxsreH+0ZZPs4tlBMYGRDI0g/Pdg/SpLrwFb3X2o/bpUNwLwHCDj7QVJ/Lbx65rraSgLs43VPDEltfPq9q15PdfabeZFgjRzGY4jHnaxAYEH1yK1/Bum3WkeE7OzvV2XCb2dcg4LOzYOOM89q28ZFFAXFooooEFFFFABRS0UAJRRRQAUUUtABRRRQAUUUUAFFFFABRSUUAFOX7w+tJSr94fWgDUPSvnv4gH/AIrPWP8Aruf5CvoQ189/EEf8VprH/Xc/yFVLYS3OW0gYjAJ7V9MeF/8AkUtK/wCvWP8A9BFfNGk/cFfTHhf/AJFLSv8Ar0j/APQRSiORNe/68f7tcjqvgxdS8US63b6rJZS3MaxzRmPerEDGQQQRwBxXV6g5W4GP7tVd7egqo1ZU23EidNVFaRS0jwjolhBMl6ItTkmARmnt1wFBztC49eT3JrU0/R/DmlXj3Wn6bZ2lw42tJDAFYj0yBUHmsB0pPMb0puvJ6sUaMYqyNW6vY3hMceWLcE46ViajpOn6vCkeoWNvdpGdyiaMOFPtmpvNbPal81vQVm5XNFG2xkweE9Mi8QXGrtbwyTSLCsKtEuLfy1KjZ6dfwq2vh/RlhniGlWYS55mXyRiTnPP48/WrfmH2o80+gpXHqUX8OaNIsKSaVZukClI1aFSEBOSB7ZpLrw5pVxNcXH2C2S6mRl+0CIbwSpXOfUA1f8w+gpPMPtRcNSnoehWOgabDa2cESMsaJJKqBWlKjG5sd60qh8xvQUvmt6Ci4WJaSo/MPoKPMOegouFiSlqLzD7UeY3oKLhYloqHzG9qPMPoKLhYmoqLzD7UeYfai4WJaKi80+1HmH2ouFiWiovMPtR5h9BRcLEtFReafQUeafai4WJaWofMPtR5h9qLhYmoqLzD7UeYfQUXCxJRUXmN6CjzD7UXCxLRUXmN6CjzT7UXCxLTk+8PrUHmH2pySHevTqKLhY2TXz38Qf8AkdNY/wCu5/kK+hDXz38Qv+R01f8A67n/ANBFXLYlbnLaV9yvpjwv/wAilpP/AF6x/wDoIr5o0j7lfS/hf/kUtK/69Y//AEEUojkP1Hm6X/dFW7u8stHso5JzsV3WJcLuLO3AAA7mqmo/8fS/7o/nUniPQbXxLoM2mXTPGsgDJJGcPE4OVce4ODWtJLm97YzqX5dCK48U6XaBftTS2+9ljTzIGG9icBV45JJ6VYg1uynukt9ssUknCebEUDHrgE98dq5DSoptcsNR0DxLbp9tsdsU7n5Y51IzHMjdmOM+oIp+hO15JeaLf3Cz3WnhG+0hgBKhz5b7hwsgxyPbI4Nek8NHlbUtv6/r/hzzvrE1JJo7W/hR7N2KjcoyDiuN1zXo9GFtGtrPe3d5IYre2gxukIGTyeAAOSTW9Zaqby1vLCeWOS8tEBkaMgh1bO1uOhODkeo9K53XtCn1WewvLG8WzvtOkaSJ5I/MRgy7WVlyOCPQ15VaNpWZ6dKSlG6LMOtwCxgm1FP7JmmYoILuRFfcDjjnB9iKnTU7B7o2q31sbgZzEJV38deM54rmNW8HapraPNd6nZPczWkllKxtDtVGYNmMbuGGMZPWpI/AyrKZBcQs/wDaD3mXiySrQ+XsJzk+prI1NmbxNosVxawHU7VnunaOLZKrAsBkjIPH/wBcVZj1XTp2CQ6hayuTjakysc4z0B9BmuU0jwNe6dLYOb+1f7FctJHE0LMiRtHsKAk7vcEk4qyPBkttpWixWVzaxXmlO7GVoMrMGVlOQCDkBuOaQaHRrqunl4U+32oecbo1My5ceo55FUbXxPp2o3NsLGZLiCdZGMyyKBHsxnIJz+lY/h/wZc6DcW0y3dncqsEMEvnWxLDyy2DGc/Lnd+dVovh9M+nx2U2oQrHDFdQo8UJVis3IJ55IP5ijQNDrDrOli3+0f2laGEkqJPPXaSBkjOeuKtRSxzwpLE6yRuAyspyGHqCK5O38Fyf2rb393cWsjpdrcPFFb7YyFhMQABJ55yTW9oGlnRdAtNNMiy/Z1KblXaCNxI4/GgDRooooEFFFFIAooooAKKKKACiiigAooooAKKKKAFooopgFJS0lABRRRSAKcn31+optOT76/UUwNyvnz4gjPjPVz/03P/oIr6DPevnv4gH/AIrPWP8Aruf5CtZbELc5jSfuV9LeFv8AkUtK/wCvWP8A9BFfNOkfdr6X8L/8ilpX/XrH/wCgilEchdR/4+l/3R/OuJ8b+Lxaaxc2F5mO3t9qpCCQZtwB3EfxdwB04Pfp22p8XIP+zVTWND8OeKLNU1ixgmkKhA7LiRMHPysORz6VpSmoydyJxukeUaX41ifRXe4u40me4dI1mfLRjOAZT6gD8gBWh/wkdhBp0Nro8y6leyvtSKP5nmlb+Jv88AY6Cui0L4Z6HZzamdZa01IXexFBQjCqcgn/AGjxkj0rodE8IeEPD2om+0uwt7e5Kld4LMQD1xk8fhXq0swiqSUo2l66XPHq5dKVWUlPR+WthvhjwufDuhXU11J5+p3wEl3LnjI6IP8AZXJH51heMbvWrO3s5NK+0CDzG+1vaxJLOiBeCqtwRnr3xXc3t9CbZo42DluOO1cxq+hadrsUceo23niIkp87KVz15UjrXk1puc+Zu7PYoQVOKilZIwo/HtoohCw3F5bL9mWW+UKi5mHytsznr1A6UH4h2TWj3S6deeWSggJAxOXcoMHopyM4PbmrVr4K0yHW7i+kt4nixALaAAhYTEpAOM4PXIyOKtp4U0VbSS1+wjyJGDGPzH2qQ24FRn5eeeMVhob6HPa947nHh+V9LsLuG+W2FzI0gUfZ183ZyD97JBxjtzWxP4xtYJmQ2s7FbuWzOCPvJEZCfoQMVbuPCuiXiotzYLMEjMQLyOSVJ3YJzlhnnnNQ3XhHSZ7ie7W0RLuTeyy7m+V2QpuxnGcHn1p6C0DQfEya3dy2/wBintHW3iukErK2+OQEqRtPHQ8VuVk+H/Dtn4fsIo4Y1NwYY45pssTIUXA6k4HXA7ZrXpAwooopCEopaSgBaKKKACiiigAooooAKKKKACiiigAooopgFFFFABRRRQAUUUUgCnJ99fqKbTk++v1FMDcPevnr4hf8jpq//Xc/yFfQpr57+IP/ACOur/8AXc/yFay2IW5y+k/cr6X8L/8AIp6V/wBesf8A6CK+adJ+7X0v4Y/5FPSv+vWP/wBBFKI5D9Qj33CnP8NVTF79KvXv+vH+7U9zLY6XZiW6dI0JC7mGck9AB1NNQ5mS5cqMoRD+9R5fvVg+JdBVGLXcMYUD76MuckDAyOTkjgVPZaxpN/cCC3mjaVgWClCpIHXGQM1XsWT7VFHyuetHle9a93bxGBnChWUZyBWZUSjYtSuR+V70eV71JRU2KuR+V70eV71JRRYLkfle9Hle9SUUWC5H5XvR5XvUlFFguR+UPWjyvepKKLBcj8v3o8r3qSiiwXI/L96PK96koosFyPyvejyvepKKLBcj8r3pfK96fRRYLjPK96TyvepKKLBcj8r3o8r3qSiiwrkfle9L5XvUlFFh3IvK96PKHrUlFFguR+V70eV71JR2osFyPyvelSPDrz3FPpVHzD60WFc1T0NfPXxBH/Faax/13P8AIV9Cmvnv4gf8jprH/Xc/yFXLYS3OX0n7tfTHhf8A5FPSv+vWP/0EV8z6T9yvpjwv/wAilpP/AF6R/wDoIpRHInvP+PhfpTPE2gp4i0GSx+0SWswZZYLiM4aKRTlW98Ht6U+8/wBePpXOap42aNtUjjkjs/7PkEZ8yIuzdsnnCjPGfoe9a058srrcyqJNalC1STxZpF7o2uwNb6vYOqz+W23a/WOeJvfGR+Iq5pL3WoRTaTqL/wDE207YzTRkDepzsnTsCcEEeoI6Gua1jXEtblLlLqWY3jhpDNIAmSoCkngKAeOOMZqGbWbHTtLf7NcJe3M0g+WFgz3Ep4HA7dgOwr3aNq9Jv+k+vy/roeDXmqFS1v6/r+tT06z1Jrq0urW42re2yjzVXoQc7XHscHjsQRXO6/rlzpFzpltaWcV1NfzNEoln8pV2oWyTg+lXfCXhy40TRLq71F9+qagBJcYPyxgfdQfTJ59Saq694ZsfEclj/aC+ZBaSPIYSMiTchXB9MZzx3FeHXUVO0XdHu4dycE5qzK2n+NtKu9IsL27mSwe93bYpH3EEPsPI4xu43dORV8+JdFVLpzqUGLRtsxyflOcY6cnPGBnmsAfD2LZYbtQM32OA2mJrdWV4d+5QRkDIxjPf0pbj4ew3Ut7I2pSRieVZ0ijiCxo6vvDFc4Y9ieMj3rA6NDb/AOEp0MC2ZtTgC3QBibJw2TtHOMDnjnHNMk8X6An2kHVbcG1JEvJ+UhtpHTru4wOaxbr4epdxRRDU3giSIRmOOEBNwk8zeq5wCT165q9L4PRtKe0jvpI5f7QOoxz+WDskL7wNp4IzxQLQe3jbSU1VLaS5hjtpbZJ4rlmOHLSFNuMccjqaPEXih9D1DT7SO1hke9D4kuLgQRArj5dxBG454FM1Dwj/AGml59r1F3lu7NbR5FhVR8shk3BR9cYqz4i0G412xFpHqRtYXRo5YzbpMsgPfDdGHYigNCwniTSDqQ0+S/t473dsMBflX27tuemcc+9NHirQmtJrpdUt2hicRswJPzHoAMZOe2M5rmrPwG8mpXsF3cTJpcdzFLBHhS0+y3EYYv1GOeO5FTJ8OoI9Pgt1vh5lvLFJFKLYA4RSoDjPzcMfT2oHoaeqeNdK0+G28i4hu57lofLiR+WSRwofOOnOeeuKvyeI9HijaV9RgWNfN+Ytx+7OJP8AvnvWJL4Ci8xTBqLW8RW282JLdArtA25CP7o9QKoa14Cn/svUGs76a5Zorw21oY1HzT8kbup56ZoDQ7HT9WsNXikk0+7juVibY5Q/dbGcH8OauVieHdDk0hbue5umuru8ZGlYoEC7UCqoA9AOvetqgkWikpaACiiigAooooAKKKKACiiigBaKM0UAJRRRQAUUUUAFOX7w+tNpV+8PrQBqmvnv4gf8jnrH/Xwf5CvoQ189/ED/AJHLWP8Ar4P8hVS2EtzmNK+5X0t4X/5FPSv+vWP/ANBFfNOkfdr6X8Mf8ippX/XrH/6CKURyJr3/AF4/3a5DxP4VvtV8TJf6Rcw2q3luYLxpCDjpztPXIx+VdbqD7Zxx/DVQS5PI6Um7MVrnJaT8IdMhgu7XWtTl1K3kCrCBKYyi9SDg889Pat3w78NvCXhjVRqOn27faFBCtLOZAue4B6H3rQ83P8NKZfatY13FNLZkSpKTTfQ17q4iFuyBgxYYAFZdM832o832rOUrlqNiSio/N9qPN9qm5ViSio/N9qPN9qLhYfRTPN/2aPN9qLhYkpKZ5vtR5vtRcLD6UVH5vtR5vtRcLEh60VH5vtR5vtRcLD6Wo/N/2aPN9qLhYkoqPzfajzv9mi4WJKKj83/Zo832ouFh9FM832o832ouFh9FM83/AGaPN9qLhYkoqPzfajzfai4WJKKj83/Zo83/AGaLhYkoqPzf9mjzfai4WJKVfvD61F5vtTkk+ZeO9FwsbBr57+IP/I6ax/13P8hX0Ie9fPnxB/5HPWP+u5/kKuWxK3OW0k/IK+mPDH/Ip6V/16x/+givmjSR8tfS/hj/AJFPSv8Ar1j/APQRSiOQuo/8fK/7tXfs9nZW3mXBjUcbnkIA/M1S1H/j6X/dH86PFehza/oDWtrdG0u43Se3lxkLIhyu4d1PQ+xrSlFOXvGdRtR0LaXOjuGKXFmwQZbbIp2j35pbefSruUpbzWkzgZ2xurHHrgGuHiVPGOgT2U9u+m6vZSBbiOMfPbTKcq6/3kOAR2I4q1o8s2pRPZzRiz1vT2BmEa4IP8MqDvGwzx9Qa9B4S0W7rT+r+n9dTg+tPmtY669s4RbPIiBGUZ471kVowaiL7TriORRFdQjbNF/dPYj1U9Qf6iufv9Wi0/UdNtHid21CVoUZSMIQhbJ/AV5lWNmejTd1cv0uKhlvbSCeKGe6hilmOI0eQKzn2B61D/bGm5mUahalrf8A1o85f3fOPm54545rI0LdFUhrmk7Fb+1LLDnC/v1+Y5xxz68VEmu2SfaDeTw2awTNCGmnQb9oBJHPHXoeaANKiqkmradDJGkl9bI0qhkDSqCwPQjnkVn6p4nTTddg0iKwnvLmaLzyEdE2pu25G4jcc9hQM26KrrqentO0C31s0qglkEqlhjrkZ4x3qI6xpi2ouTqNoLctsEvnLtLemc4zQIu0Vmah4hsNPvrOzaVJbi7mWERpIu5MqSGI644q2NSsPIEpvbcIy71YyrgrnGc56Z4zQMsUVTTWNNZInGoWu2ZtsZ85cOemBzyauUCCiiikAUUUUAFFFFABRRRQAUUUtACUUtFMBKKKKQBRRRQAU5Pvr9RTacn31+opgbhr57+IP/I6ax/13P8AIV9CV8+fEH/kdNX/AOu5/wDQRWstiFucxpPSvpbwx/yKelf9esf/AKCK+aNK+7X0v4X/AORT0r/r1j/9BFKI5DtR/wCPpf8AdH86wPHnxR0jwRC8Df6XqIQMLdTgJnoXbsPbqa3tSP8ApK/7orkfiZ4Ibxbp9rf6NZWUuqwyqzNO2zegBwpPcA44NdGH5PaWnsZVb8t0cZpvxUg1V5rh1C306iSRoMruA4VDnlQufUjknvXQzahHoVlLqElwXup8ec6Md0rD7sa99ozgD3JPJrNX4ceKvE+opL4jtNI05PINtK1nJ95CVIIAH3ht4J4rr/Dfwk0Dw5rEeoJc3d5JEcxpcupRW7NgAZI7V6dPFwjFxlHbtr+P/APJrYSdSXPB2v3/AELPg/Q9SsNM1DVtYkb7dqSqTBnIgjXO1fr8xJqn4g0e91O50y5sLuC2nsJ2mHnRGRWyhXGAR6121/NGlm6FhuYYAzzWJXkYibnPmZ6+HgqcFGPQ5O98I3eoapbaje3VpcTrEkM6GJ1QhJN6lAGyD9c9M1n3Pw8u7y4uZLjVopGuLee3LGE5IeQOCRnHGMYHFd5RXPc3ucrr3gqLVp754ZLe3F1YCzUeQDsbzN+/ih/BYk1QXclzFIgup7kxtFnPmQrHj8MZzXVUlFwueY6h4UvNPFrptrHJeySw2UDyfZCUAhkzuWTOEGM5B9sV1Pizwvc+J5FiF1aQ26gYaS23zRNuzvjcEbTjiumoouFzze38D3mtS6iLuYWUAvL3yiIf3z+aoQMWzyuOcd605vh80tpbZmsxPE7mQCOTy5g0QjO758g4HY47V2veii4XZxsPgaW31mOeO8t1tlu4rvZ5BMgKReXsD5+7jkZrH1TwTqljoQjiuor77Pbx2cMUduQSn2lZNzcnOADnFelUdDRcdziJPAFz9tS6jv7WG6a7e5kligYBQzKSiLnG0hR94Hnmu37miigQUUUUhBRRRQAUUUUAFFFFACiigUUwCiiigBKKKKQBS0lFAC0qffX6ikpyffX6imBtmvnz4gDPjTWP+u5/kK+gzXz38QP+R11j/ruf/QRWstiFuczpR+X8K+lvDH/Ip6V/16x/+givmnSfu19L+GP+RT0r/r1j/wDQRSiOQ7UELXAI/u1V8s+1Xb3/AF4/3atR2MKxAyjJxzzgCjl5mLmsjI8sn0o8s+orYFraNnaFOOuG6UotrViQoBx1w2afsmLnRi+Wc5yKURn1Fal3ZRpAZIwVK84z1rD1PV9O0W2WfUr2GzjZtqtK2Mn0HrUuNtylK+xZ8s+opPLPtSwzxXMSTQyLJFIoZXU5DA8gg1D/AGpYf2X/AGl9sh+xbd3n7vkxnGc/XilYdyXyz6ijyj7UlveW148y288crQSGKQIc7GAztPocEVMOuKLBci8s+oo8o+oqBdW09reWf7ZD5UU3kO+7hZMhdp98kCrh+9jvRYLkXln2o8s+oqG+1Wx059t3dwwN5bzYdsfIv3m+gyM1ajZZY1kQhlYAgjoQaLBcj8s+1HlH1FS98UUWC5F5R9RR5R9RUtFFguReUfajyj7VLRRYLkXlH2o8o+oqWiiwXIvLPqKPLPtUtFFguReWfUUeWfapaKLBci8s+1L5Z9RUlFFguR+Wfajyj6ipaKLBch8o+1Hln1FTUlFguReWfUUeWfUVLRRYLkXlt7U5IzvXkdRT6Vfvj60WC5qmvnz4gD/itNX/AOu5/kK+gzXz54//AOR01j/ruf5CrlsStzl9JPy19L+F+fCelf8AXrH/AOgivmfSvuV9MeF/+RS0r/r1j/8AQRSiORNef8fC/Sq/jDSr7VfDckWmzJHewuk8IcZSRkOdjezdPxqxe/8AHwv+6KXUNbhs5TbopmmRA7jO1I19Xbt9OSfStqTaldGNRJqzOHtorfxb4VknsUOlahDIBLHtwYJ0OTHIv8SEjoeo5q/ocxvrb7XbwR2Gp2j+XcQgcI+OVbHVGHIPpgjkVnXusnSb+91URJbyaiVJuIBvSRVBCIDj7/XORkk+gFRQ6pLo63Gs3k5jvLiNVnkyD5aLnbGPUjJye5PoK9yNP2tN2S1/pr+vI8KdaNKpZt6HocGoR6npckiAoy5SSNvvIw6g/wCeRzXE+NbGS6jsp7a01CW7tmcwzWQjZomK4+ZH4ZW6Gr3geLVruy1HXdVLRrqCoLaFhhliXOGb3bd+QFR+J/Ev/CPCyRbaOaW9laNDNOIIlIXPzOQQCegHc14deKjPlTue7h5ucFJq1znLeHxkNUsDcRXMUym1OLdlFokYH78Ov970/DFZd5o/iY+GY9May1ExGxZY4IHUKJvPLHzRnkbMYr0GDxFpv2iG1u7y3tr+UIDbNKCyswyFyODnt61I3iDRmWdxqdqVtuJj5gwnOOfx4471gdFzj9StPFMclyLc30dpJqEz7rfBlCGJfLIAIJUPnjP14rc0LT9VGr3t1qd5fFY3jECM4EUimFd52D/bz9DTtf8AGWlaTo322O6gumZPMhiWUAzDcFOPpn9MVq/21poLBr2BSsjQkF+jqu5l+oHP0oC7OGk8La3Lp+pSJcXiiTWvtCWAWPY8fnI2/ON3QE9e1EUfjGK01S4uBqVxdMWXyVbahzNw8Tg9o/4QBn613OnaxpuqNKthfQXRiALiJ87QRkE/Wr2OMUBc8xXSvFV3btLPb3r3FvDqMVvJIQX2uqeSMk85II59Oa1BaeKIdTFys18FXUYQImkHlfZjCPMJX0D/AIjtXdDjpSYBPIoFc4HwVf6pL4jS11C6vJJf7NM1ws0qyIZTNjcm0nC46V39VrXTbGwaQ2dlb2xkOX8qMJu+uBVmgGwooooEFFFFABRRRQAUUUUAFJS0lAC0UUUAFLSUtABiiijNACUUUUAFOX7w+tNpy/fH1oA1D0r598fn/itNY/67n+Qr6CPSvn3x/wD8jpq//Xc/yFVLYS3OV0ofLX0v4X/5FPSv+vWP/wBBFfNOlfdr6X8Mf8inpX/XrH/6CKURyJr3/Xj/AHa53xD4d1rUNQvZbFLG4s71EJSeVkZWVQvYEdga6G+YLOMkD5e5qFblkXCTbR6BquE+SV0ZzgpqzOFn+H3ifUNMTTln0/So0kWVZoZGkYMDnpgdfWpNC+E2ox6tFL4j17+1rGFvMS22sAzjpuyent3ruftkuP8AXn/vqk+2S/8APc/99V0LGTScU9Gc7wdNtNrY07whbNx04wK5PxFpN1rFktvb3sdshyJEltlnSQEY5VuhHY1rvOZSN8u7Hq1M3rn7y/nXLKV2dcVY4Cx8BXC6xcWr3Usek262JVmjBe5MIJ4bPy4OM8fSrlt8OoYtMezN8CUdGt5vI+dAknmBWO75hk9sevWu03Lj7w/Ojev95fzqSrs4y6+Hyzh1h1BbUXFqbWcR2w2uPMMmVBPynceeTmn3nguUXl1dxag7oZ5r1LYQjJleExkbs9PSuv3r/eX86NyEfeX86AuzmvCHh240qGK+v5y95LY29qYvLCCJY1+7wTk5Jya6em71/vL+dLuXpuH50ALRXPSePPDUUrxvqsYZGKsPLfgg4Pam/wDCf+GP+gtH/wB+3/wqOePc6/qGKf8Ay6l/4C/8joqWuc/4T/wx/wBBaP8A79v/APE0f8J/4Y/6C0f/AH7f/Cjnj3D6hiv+fUv/AAF/5HR0Vzn/AAn/AIY/6Cyf9+3/AMKP+E/8Mf8AQWj/AO/b/wDxNHPHuH1DFf8APqX/AIC/8jo6K5z/AIT/AMMf9BaP/v2//wATR/wn/hj/AKC0f/ft/wDCj2ke4fUMV/z6l/4C/wDI6Ois3SvEOla2ZRp14lx5ON+AVxnp1A9K0N6/3h+dUmnsc06c6cuWaafZjqKbvX+8Pzo3L/eH50EC0Um5f7w/Ojev95fzoAdRTd6/3h+dG9f7y/nQA6im71/vL+dLvX+8v50ALRSb0/vL+dG9f7y/nQAtFN3r/eH50b1/vL+dADqVfvD60zev95fzpVddw+YdfWmBrmvn34gf8jprH/Xc/wDoIr6CNfPvj/8A5HTV/wDruf5CqlsJbnL6V92vpbwx/wAinpX/AF6x/wDoIr5q0r7lfSvhj/kU9K/69Y//AEEUojkVdd/4/k/3B/M1mfhWnrn/AB/J/uD+ZrNrCfxM1jsVdR1O10m3jkuQ7tKSEjjxkgdSSegrMPi+w/58rn/vtf8ACoPGY+bTz/0zf/0KuY60bCO90vV7PVfNWFZYpkXdskwdy9yCPT0q6MCuR8Jj/iekdvIk/kKu+I3nbWNEtI9QnsYbiWVZWhcISBHkckHuKTQ0dERzQRxXFQeL59P0t/MePUnjubiOKV32NPFGAdw2qQTzjPA4qe58bM0j21vYt9okjEkILj/VmAy7+nbGMetLlZR12OOlGK5mw1o28+l6LcQs8N1bR/6ZLKcyO6kkDg89epHXjpWh4YnmuPDdnJM5kfay72OSwDEAn8AKGgNbHtSqBuH1pKVfvD60hHPeDUVtDlJRSftk/Uf7Zrf8qLBLBERQWZiowABkmsHwZ/yApf8Ar8uP/QzW1dkjTb3Ayfs0n/oJpQV0jtx7axNT1ZjnxTpYyVsp3XOA3yDP4YpF8WaR5mJbSeNcgFvkbbnpniuEtLqG8ggaN2gkU4lZssd38QZf5YqLU9Qd4jpVgmXcHcGPY9Xc+voPyrVJHxcuIYzmqNCDc72s9NF1/r5nrpiiwGVY2VgGVgowQeQaTyoz/wAs0/75FV4SY9CtMMdy2ac++wc1xVp4p1eLS/D9xc21wqvFNJLK8qEXW2FmHA5HIzU8up9Qm7He+Un9xP8AvkUeUn/PNP8AvkVzX/CWXUEOnS3emRwQ3+1hKbjKIrbduSF4Y7uh44611BGMj0pWC7Of0kAeMteAAA2wcAf7JrfxWDpX/I569/uwf+gmt+ojsdmN/iL/AAx/9JQmBS0UVRxidqoalrNnpUiRTJLLMy7iseBtB6ZJ71fNch4s/wCRilHby4//AEAVSJZpf8JdY/8APnc/99r/AIVp6fqFtqlo01sHUxsFeN8ZXPQ5HUcV5/XT+Dvu3/oRH/NqYHRYFLjjNch4h1q+0fxjaSK7vpkdo0t1Coz8u8LvA65GR+FUNP8AEOqRSu2pSSl2v5NsKuFVE+z+YsZ45A/nS5SjvsUYrF0PxBJq9wYprMWzG1iu02y7wUkzgHgYIxW1StYAxRRS0gEp8Q/ep/vD+dMp8f8ArU/3h/OmI6096+ffH/8AyOmr/wDXc/yFfQR718+fEDjxpq//AF3P8hXVLYwjucxpf3K+lvDH/Ip6V/16x/8AoIr5p0w/LX0t4X/5FPSv+vWP/wBBFKI5FbXVIvI27FMD86zK6q7tI7yLZJxjkEdRWYdBbPE6491rOcG3dFxkrWZyfiHSLnVYbZ7QK8kG5WjLAEgnIIz1rBHhfWf+fFv++1/xr0n+wX/57p/3yaP7Af8A57p/3zS5X2C67nHeH9Du9Oupbq8QQ/umjRNwLMT346AVpXWn2V+EF5aQXKocqJUDAH2zW/8A2A//AD3T/vk0f2A//Pwv/fJpOEuw1JI52bStPniijlsrd0hP7tTGMJ9B2qnb+G7aDXxqpk8xo4Tb28QiVVgjPVRgc+nPQV139gv/AM91/wC+TS/2C/8Az3X/AL5NHJIOdHNf2Lpm+JhYwBok8tH2/Mq88A9R1P0q1BDHbQJBCgjijUKir0UDoK2v7Bf/AJ7r/wB8mj+wX/57r/3yaOSQcyMmlX7w+tav9gv/AM91/wC+TThoT5H79ev900uSXYOZHEeDP+QFL/1+T/8AoZreeMTQSws2wTRtHu9MjGa5zRV1nRbOazk8M6rOftM0gkiRdrBnJGMn0q//AGnqv/Qp61/3wn/xVZw0SPXxmGqVa85xs02/tR/zOTvvAmtS3IntIRHOvys4ZSki+/P5GpNN8DapakobX55DmSaR1G4+pOeldR/aWqf9ClrX/ftP/iqP7S1T/oUta/79p/8AFVfMux5scqcarrKMeZ9bx/zNMRLFBFbhg6xRrFnH3sDGagOnWTRxRNaQGKEFY0KDCAjBAHbIOKqf2pqv/Qpa1/3wn/xVH9p6r/0KWtf98J/8VU3On6lV8v8AwKP+ZZk0uwmMHm2UEn2cAQ7owfLx0x6dKt1l/wBp6r/0KWtf98J/8VR/aeq/9ClrX/fCf/FUXD6nW8v/AAKP+ZV0n/kc9e/3YP8A0E1v1m+F9H1G91/WL66sLnTI5xCI1uUALYBB6Guo/sJ/+e6/98mnCEmtgx0kqtr7KPn9lGRS1rf2E/8Az3X/AL5NJ/YL/wDPdf8Avk1XJLscPMjJNYGvaHe6hf8A2u1jEyuiqyhgCpAx0Pbiu1/sF/8An4X/AL5NB0ByP9en/fJpqEuwOSPNj4X1j/nyb/vtf8a3/D2lT6XZ3P2sKkszLiMMCQBnk4+tdT/wj7f890/75pRoL/8APdf++TT5X2FddzFNvC1wLgxJ5wXYHx823OcZ9M1E+n2cspke0hZyxckoMliu0n644+lb/wDYL/8APwv/AHyaP7Bf/nuv/fJqeSQ+ZGHFZ21vJvhgjjYIIgVUAhB0X6D0qbFa39gv/wA91/75NL/YT/8APdf++TRySDmRk0Vrf2E//Pdf++TR/YT/APPdf++TRyS7BzIyakgUtOigZJYfzrS/sJ/+e6/98mrdnpkdq/mM3mOOhxgCmqbvqDki8a+e/iB/yOusf9dz/IV9Cdq+e/iB/wAjprH/AF8H+QreWxktzmdN6V9K+GOPCelD/p1j/wDQRXzTpv3RXtHgjx3YR6NBp2qTC2lt12JIw+V17c9iKURyPQ6KyP8AhLNA/wCgxZ/9/BR/wlegH/mMWf8A38FWSa9L3rI/4SvQP+gxZ/8Af0Uf8JXoH/QYs/8Av4KANekrI/4SvQP+gxZ/9/BR/wAJZoH/AEGLP/v4KANiisf/AISvQP8AoMWf/f0Uf8JXoH/QYs/+/goA16KyP+Er0D/oMWf/AH8FH/CV6B/0GLP/AL+CgDXorJ/4SvQf+gxZ/wDfwUn/AAlegf8AQYs/+/goA18UYrI/4SvQP+gxZ/8AfwUv/CV6D/0GLP8A7+CgDWorI/4SzQP+gxZ/9/RR/wAJXoH/AEGLP/v6KANeisn/AISvQP8AoMWf/fwUn/CV6B/0GLP/AL+CgDXorI/4SvQP+gxZ/wDfwUf8JXoH/QYs/wDv4KANeisj/hK9A/6DFn/38FH/AAlegf8AQYs/+/goA16KyP8AhK9A/wCgxZ/9/BS/8JVoP/QYs/8Av6KANalrH/4SvQP+gxZ/9/RR/wAJXoH/AEGLP/v4KANikrI/4SvQP+gxZ/8Af0Uf8JXoH/QYs/8Av4KANeisj/hLNA/6DFn/AN/BR/wlegf9Biz/AO/goA16KyP+Er0D/oMWf/fwUf8ACV6B/wBBiz/7+CgDXorI/wCEr0D/AKDFn/38FL/wlWg/9Bez/wC/ooA1qKyP+Er0DP8AyGLP/v4KP+Er0D/oMWf/AH8FAjX7V8+/EAf8VnrHGP35/kK9h1DxzoFjatIt/HdPj5Y4TuLH+leH6/fyapqFzfTACSdy5A6DPapkyomNpg+UVsL0rI0z7orXXoKgofTgKQClFMQYopaSkAlGKWigBKXFJS0DExRS0UAJRS0lAgoNFFACYoFLRQAUUUUAFFLSUwCilpKQAKWkpaAExSUtFAxKKWigQUtFFMBKUUUUhhRRRQIQ0lLSUwCqV79w1eqneD5DQMoaX0FbKjisfSj8oraHSkACnU0dadmmIKKSjNAC0lFFIBKM0UlAxaKSloAKKKWgApKWigQlFFFACUtJRQAtFFFAwopaSgBaKTNGaYBS0lLSAKKKWgBKKDSUwDNGaSloAKKKKACiikoAWqd7/qzVuqd4fkNIChpXQVtL92iigB1GaKKACiiimAoooopAFIaKKACloooEFLRRQAlFFFMApKKKQCUUUUAFKKKKYBRRRSAKSiigYtFFFAgpe1FFAwpKKKYBRRRQIKKKKBhSUUUCCqd5/qzRRQM//9k=" alt="How to screenshot speedups" style="width:140px;border-radius:6px;border:1px solid var(--border);flex-shrink:0">
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
      <label for="msFileInput" id="msUploadZone" style="display:block;border:2px dashed var(--border2);border-radius:10px;padding:22px 14px;text-align:center;cursor:pointer;margin-bottom:10px;background:var(--bg3)">
        <div style="font-size:22px">📸</div>
        <div style="font-size:13px;color:var(--text);font-weight:600;margin-top:4px">Upload your Speedups screenshot</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Tap to take a photo or choose from your gallery</div>
      </label>
      <input type="file" id="msFileInput" accept="image/*" style="display:none">
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
      <div class="card-title" style="display:flex;align-items:center;gap:10px">✅ Step 3 — Verify &amp; Correct <span onclick="msGoStep(1)" style="margin-left:auto;font-size:11px;font-weight:400;color:var(--accent2);cursor:pointer;letter-spacing:0;text-transform:none">← Back</span></div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:14px">Confirm the detected speedup amounts below. If a number looks wrong, correct it manually — OCR isn't perfect. Enter the raw amount and pick its unit; it converts to hours automatically.</p>
      <div id="msVerifyGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px"></div>
      <button class="btn btn-primary" style="margin-top:16px" onclick="msMarkStepComplete(2);msGoStep(3)">Continue to Commitment →</button>
    </div>
  </div>

  <!-- STEP 3: COMMITMENT SLIDERS -->
  <div id="msStep3" class="ms-step" style="display:none">
    <div class="card">
      <div class="card-title" style="display:flex;align-items:center;gap:10px">🎯 Step 4 — Expected Usage This KvK <span onclick="msGoStep(2)" style="margin-left:auto;font-size:11px;font-weight:400;color:var(--accent2);cursor:pointer;letter-spacing:0;text-transform:none">← Back</span></div>
      <p style="color:var(--text2);font-size:12px;margin-bottom:14px">For each category, set how much of your speedups you plan to commit this KvK. This determines your ranking priority for minister spots.</p>
      <div id="msSliderGrid"></div>
      <button class="btn btn-primary" style="margin-top:10px" onclick="msMarkStepComplete(3);msGoStep(4)">Continue to Timeslots →</button>
    </div>
  </div>

<!-- STEP 4: TIMESLOT PICKS -->
  <div id="msStep4" class="ms-step" style="display:none">
    <div class="card">
      <div class="card-title" style="display:flex;align-items:center;gap:10px">🕐 Step 5 — Signup <span onclick="msGoStep(3)" style="margin-left:auto;font-size:11px;font-weight:400;color:var(--accent2);cursor:pointer;letter-spacing:0;text-transform:none">← Back</span></div>
      <div id="msSignupSummary" style="background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:14px"></div>
      <div id="msBoardSwitcher" style="display:none;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
      <p id="msPerBoardHint" style="display:none;color:var(--text2);font-size:12px;margin-bottom:10px">Each minister spot has its <strong style="color:var(--text)">own timeslot board</strong> — use the tabs above to fill in every board you applied for.</p>
      <p style="color:var(--text2);font-size:12px;margin-bottom:6px">Select at least <strong style="color:var(--text)">4 timeslots</strong> that work best for you (UTC).</p>
      <div style="background:rgba(201,165,92,.08);border:1px solid var(--border);border-radius:7px;padding:8px 12px;font-size:12px;color:var(--text2);margin-bottom:10px">⭐ <strong style="color:var(--gold)">What the star means:</strong> after selecting a slot, tap its ☆ to mark it as a <strong style="color:var(--text)">priority favourite</strong> (max 2 per board). When spots are assigned, the system tries to give you one of your starred slots first — before falling back to your other picks.</div>
      <div id="msSlotPickCount" style="font-size:12px;color:var(--text3);margin-bottom:10px">0 slots selected</div>

      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px">
        <div><div style="font-size:11px;color:var(--text3);margin-bottom:4px">From</div>
        <select id="msRangeFrom" class="ms-range-sel"></select></div>
        <div><div style="font-size:11px;color:var(--text3);margin-bottom:4px">To</div>
        <select id="msRangeTo" class="ms-range-sel"></select></div>
        <button class="btn btn-sm" onclick="msSelectRange()">Select range</button>
        <button class="btn btn-sm btn-ghost" onclick="msClearPicks()">Clear all</button>
      </div>

        <div id="msSlotLegend" style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--text2);margin-bottom:12px">
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--bg4);border:1px solid var(--border);vertical-align:-1px"></span> free</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#97C459;vertical-align:-1px"></span> wide open</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#EF9F27;vertical-align:-1px"></span> some interest</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#E24B4A;vertical-align:-1px"></span> high demand</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--accent);vertical-align:-1px"></span> your pick</span>
      </div>

      <div id="msSlotGrid"></div>

      <div id="msDeadlineBanner" style="display:none;margin:12px 0"></div>
      <button class="btn btn-primary" id="msSubmitBtn" onclick="msSubmitEntry()" style="margin-top:4px">✅ Submit My Entry</button>
    <div id="msSubmitHint" style="font-size:12px;margin-top:8px"></div>
    </div>
  </div>

  <!-- STEP 5: RESULTS / LEADER VIEW -->
  <div id="msStep5" class="ms-step" style="display:none">
    <div class="card" style="margin-bottom:14px">
<div class="card-title">📊 All Submissions</div>
      <div style="display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px">
        <div style="display:flex;gap:14px;flex-wrap:wrap">
          <div class="stat-box"><div class="stat-val" id="msTotalSubs">0</div><div class="stat-lbl">Total submissions</div></div>
          <div class="stat-box"><div class="stat-val" style="color:var(--green)" id="msWinnerCount">0</div><div class="stat-lbl">Spots filled (of 48)</div></div>
          <div class="stat-box"><div class="stat-val" style="color:var(--enemy)" id="msRejectedCount">0</div><div class="stat-lbl">Not selected</div></div>
        </div>
        <div id="msBoardTimersPanel" style="display:flex;flex-direction:column;gap:8px;min-width:260px"></div>
      </div>
      <div id="msAdminGuard" style="display:none;background:rgba(201,165,92,.08);border:1px solid var(--border);border-radius:7px;padding:14px;margin-bottom:10px">
        <div style="font-size:13px;color:var(--text2);margin-bottom:10px">🔒 Admin password required to manage results.</div>
        <div style="display:flex;gap:8px">
          <input type="password" id="msAdminPwInput" placeholder="Admin password" style="width:160px" onkeydown="if(event.key==='Enter')msUnlockAdmin()">
          <button class="btn btn-primary btn-sm" onclick="msUnlockAdmin()">Unlock</button>
        </div>
        <div id="msAdminPwErr" style="display:none;color:#ff7070;font-size:12px;margin-top:6px">Incorrect password.</div>
      </div>
<div id="msR4NoticeBanner" style="display:none;background:rgba(201,165,92,.08);border:1px solid var(--border);border-radius:7px;padding:10px 14px;margin-bottom:12px;font-size:12.5px;color:var(--text2)">
        ℹ️ Running allocation, clearing submissions, and overriding the deadline or KvK schedule are <strong>Admin-only</strong>. You can still assign, swap, lock and search players in Manage Spots below.
      </div>
      <div id="msAdminActions" style="display:none">
        <div id="msDeadlineAdminBanner" style="display:none;background:rgba(255,157,77,.1);border:1px solid rgba(255,157,77,.4);border-radius:7px;padding:10px 14px;margin-bottom:12px"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
          <div class="field"><label style="font-size:11px">Manual deadline override (UTC) — closes ALL boards at once</label>
            <input type="datetime-local" id="msDeadlineInput" style="width:200px">
          </div>
          <button class="btn btn-primary btn-sm" onclick="msSetDeadline()">Set Deadline</button>
          <button class="btn btn-ghost btn-sm" onclick="msReopenSubmissions()">🔓 Reopen Submissions</button>
        </div>
        <button class="btn btn-gold" onclick="msRunAllocation()">⚙️ Run Allocation (rank + assign slots)</button>
        <button class="btn btn-ghost btn-sm" onclick="msClearAllSubs()" style="margin-left:8px">🗑 Clear all submissions</button>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px">🗓️ Force KvK Day 1 (overrides the computed schedule)</div>
          <div id="msDay1OverrideCurrent" style="font-size:11.5px;color:var(--text3);margin-bottom:8px"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label style="font-size:11px">New Day 1 (00:00 UTC recommended)</label>
              <input type="datetime-local" id="msDay1OverrideInput" style="width:200px">
            </div>
            <button class="btn btn-primary btn-sm" onclick="msSetDay1Override()">Force Override</button>
            <button class="btn btn-ghost btn-sm" onclick="msClearDay1Override()">Clear Override</button>
          </div>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div><div style="font-size:11px;color:var(--text3);margin-bottom:4px">My alliance (to submit as a player)</div>
          <select id="msMyAllianceSelect" style="width:130px">
            <option value="">Select…</option>
            <option>FIR</option><option>LOC</option><option>LYL</option>
            <option>KNG</option><option>KOV</option><option>TLA</option>
          </select></div>
          <button class="btn btn-sm" onclick="msSetMyAlliance()">Set my alliance</button>
        </div>
      </div>
    </div>

    <div class="card" id="msManagePanel" style="margin-bottom:14px;display:none">
      <div id="msManageBoardTabs" style="display:none;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:4px">
        <div class="card-title" style="margin:0">👑 Manage Spots — Assign & Move</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span id="msPanelCounter" style="font-size:12px;color:var(--text3)"></span>
          <select id="msCopyFilter" style="font-size:12px;padding:3px 6px">
            <option value="">Copy: All</option>
            <option>FIR</option><option>LOC</option><option>LYL</option><option>KNG</option><option>KOV</option><option>TLA</option>
          </select>
          <button class="btn btn-sm" onclick="msCopyByAlliance()">📋 Copy</button>
          <span id="msCopiedMsg" style="font-size:12px;color:var(--green);opacity:0;transition:opacity .2s">Copied ✓</span>
          <button class="btn btn-ghost btn-sm" onclick="msUndoLast()">↩ Undo</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:12px">Tap a bench player, then tap a slot to place them. Their own picked slots show a blue dot.</div>
      <div style="display:grid;grid-template-columns:320px 1fr;gap:14px" id="msPanelGrid">
        <div style="background:var(--bg4);border-radius:10px;padding:12px">
          <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">Bench</div>
          <input id="msBenchSearch" placeholder="Search players" style="width:100%;margin-bottom:8px;font-size:13px" oninput="msRenderBench()">
          <div style="display:flex;gap:6px;margin-bottom:10px">
            <input id="msAddPlayerId" placeholder="Add by Player ID" style="flex:1;font-size:12px;min-width:0">
            <button class="btn btn-sm" onclick="msAddPlayerById()">+</button>
          </div>
          <div id="msBenchList" style="display:grid;grid-template-columns:1fr 1fr;gap:4px"></div>
        </div>
        <div style="background:var(--bg4);border-radius:10px;padding:12px">
          <div id="msBoardHint" style="font-size:12px;color:var(--text3);margin-bottom:10px">Select a bench player to begin.</div>
          <div id="msBoard" style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px"></div>
        </div>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">📋 Recent changes</div>
        <div id="msAuditFeed" style="font-size:11px;color:var(--text3)"></div>
      </div>
    </div>
  </div>

</div>

<script>
// ════════════ STATE ════════════
const S = {
  leaders: [],   // {id, name, march, tier, dur, teamId, status, timerEnd, launchTimeStr}
  teams: [],     // {id, name, alliance: allianceId|null}
  alliances: []  // {id, name, color}
};
const BS_ALLIANCE_PALETTE = ['#c084fc','#f5b833','#ff8fa3','#4dd0e1','#ffb74d','#a5d6a7','#9575cd','#4db6ac'];
const BS_TEAM_PALETTE = ['#6ab0ff','#5ddb8a','#ff8fa3','#f5b833','#c084fc','#4dd0e1','#ffb74d','#9575cd'];
function bsEnsureTeamColors(){
  (S.teams||[]).forEach(function(t,i){ if(!t.color) t.color=BS_TEAM_PALETTE[i % BS_TEAM_PALETTE.length]; });
}
function bsEnsureAlliances(){
  if(!S.alliances) S.alliances=[];
  if(S.alliances.length===0){
    var gEl=document.getElementById('garrisonAllianceName');
    var aEl=document.getElementById('attackAllianceName');
    S.alliances=[
      {id:'garrison',name:(gEl&&gEl.value)||'Garrison',color:'#6ab0ff'},
      {id:'attack',name:(aEl&&aEl.value)||'Attacking',color:'#5ddb8a'}
    ];
  }
}

// Minister Spots shared state (declared early so sync functions below can reference it safely)
const MS = {
  deadline: null,
  draft: { alliance:'', ign:'', verify:{}, commit:{}, picks:[], favourites:[] }, // in-progress entry
  submissions: [], // {id, alliance, ign, verify:{cat:{amount,unit,hours}}, commit:{cat:pct}, picks:[slotIdx...], committedHours:{cat:hours}}
  _lastAllocation: null,
  _allocByBoard: {},
  _manageBoard: null,
  auditLog: [], // {who, action, when} — last ~25 manual leader changes, shared across leaders
  _currentStep: 1
};

// Record a leader action to the shared audit log
function msLogAction(action){
  var who = (typeof verifiedPlayer!=='undefined' && verifiedPlayer && verifiedPlayer.name) ? verifiedPlayer.name : (AUTH.role||'leader');
  MS.auditLog = MS.auditLog || [];
  MS.auditLog.unshift({ who: who, action: action, when: Date.now() });
  if(MS.auditLog.length > 30) MS.auditLog = MS.auditLog.slice(0, 30);
}

// ════════════ SHARED SYNC (Cloudflare Worker + KV) ════════════
// Set this to your deployed Worker URL — see DEPLOY.md
const SYNC_API_URL = ""; // same-origin: the Worker now serves both the site and the API
const SYNC_POLL_MS = 20000; // check for updates from others every 20s
let syncPushTimer = null;
let syncLastPushedJSON = null;
let syncApplyingRemote = false; // guards against re-triggering a push while applying a pull
let syncRev = null;   // server revision this client last saw
let syncBase = {};    // last known shared state — we diff against this to build a patch
let syncPollTimer = null;

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
      teamId: l.teamId, pet: l.pet ? { active: !!l.pet.active, startMs: l.pet.startMs || null } : { active: false, startMs: null },
      bsSlot: l.bsSlot || { slotType: 'pool', slotId: null }
    })),
    teams: S.teams.map(t => ({ id: t.id, name: t.name, alliance: t.alliance, color: t.color })),
    alliances: S.alliances || [],
    garrisonAllianceName: document.getElementById('garrisonAllianceName') ? document.getElementById('garrisonAllianceName').value : '',
    attackAllianceName: document.getElementById('attackAllianceName') ? document.getElementById('attackAllianceName').value : '',
    msSubmissions: (typeof MS!=='undefined') ? MS.submissions : [],
    msLastAllocation: (typeof MS!=='undefined') ? MS._lastAllocation : null,
    msAllocByBoard: (typeof MS!=='undefined') ? MS._allocByBoard : null,
    msDeadline: (typeof MS!=='undefined') ? MS.deadline : null,
    kvkDay1Override: (typeof MS!=='undefined') ? (MS.kvkDay1Override||null) : null,
    msActionHint: (typeof MS!=='undefined') ? (MS._pendingAction||null) : null,
    msSubmissionsByPlayer: (typeof MS!=='undefined') ? (MS.submissionsByPlayer||{}) : {},
    msAuditLog: (typeof MS!=='undefined') ? (MS.auditLog||[]) : []
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
    S.alliances = (data.alliances && data.alliances.length) ? data.alliances : (S.alliances || []);
    bsEnsureAlliances();
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
      MS._allocByBoard = data.msAllocByBoard || MS._allocByBoard || {};
      MS.deadline = data.msDeadline || null;
      MS.kvkDay1Override = data.kvkDay1Override || null;
      if(data.msSubmissionsByPlayer) { MS.submissionsByPlayer = data.msSubmissionsByPlayer; MS.submissions = Object.values(MS.submissionsByPlayer); }
      if(data.msAuditLog) { MS.auditLog = data.msAuditLog; }
      if (typeof msRenderResultsSummary==='function') msRenderResultsSummary();
      if (typeof msRenderFinalSchedule==='function') msRenderFinalSchedule();
      if (typeof msRenderRejectedList==='function') msRenderRejectedList();
    }
  } finally {
    syncApplyingRemote = false;
  }
}

async function syncPull() {
if (!syncEnabled()) return false;
  try {
    const res = await fetch(SYNC_API_URL.replace(/\\/$/, '') + '/state', { cache: 'no-store', headers: stateHeaders() });
  if (!res.ok) { updateSyncStatus('error'); return false; }
    const data = await res.json();
    // _rev is transport metadata, not shared state — pull it out before comparing.
    const rev = (typeof data._rev === 'number') ? data._rev : null;
    delete data._rev;
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
    if (Object.keys(data).length) syncBase = JSON.parse(json);
    if (rev !== null) syncRev = rev;
    return true;
  } catch (e) {
    updateSyncStatus('offline');
    return false;
  }
}

// ── First-sync loading state: shown right after login until the shared state has been
// pulled successfully (retries a few times — covers KV edge-propagation delays on relog).
let _syncFirstDone=false;
function syncShowLoading(show){
  let ov=document.getElementById('syncLoadingOverlay');
  if(!show){ if(ov) ov.style.display='none'; return; }
  if(!ov){
    ov=document.createElement('div'); ov.id='syncLoadingOverlay';
    ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,12,8,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9998;gap:14px';
    ov.innerHTML='<div style="width:34px;height:34px;border:3px solid var(--border);border-top-color:var(--accent2);border-radius:50%;animation:syncspin 0.9s linear infinite"></div>'+
      '<div style="font-family:var(--head);letter-spacing:.05em;color:var(--accent2);font-size:14px;font-weight:600">Synchronizing data…</div>'+
      '<div style="font-size:11px;color:var(--text3)">Pulling the latest shared state for Kingdom 1057</div>';
    var st=document.createElement('style'); st.textContent='@keyframes syncspin{to{transform:rotate(360deg)}}'; document.head.appendChild(st);
    document.body.appendChild(ov);
  }
  ov.style.display='flex';
}
async function syncFirstPull(){
  if(!syncEnabled() || _syncFirstDone) return;
  syncShowLoading(true);
  var ok=false;
  for(var i=0;i<4 && !ok;i++){
    ok = await syncPull();
    if(!ok) await new Promise(function(r){ setTimeout(r,1200); });
  }
  _syncFirstDone=true;
  syncShowLoading(false);
  if(!ok) toast('Could not reach the sync server — showing local data. It keeps retrying in the background.');
}

async function syncPushNow() {
  if (!syncEnabled() || syncApplyingRemote) return;
  const json = syncSerialize();
  const cur = JSON.parse(json);

  // Build a patch of ONLY the top-level keys this client actually changed since
  // it last saw the server. Keys we don't send are left untouched server-side —
  // so renaming a team can no longer wipe a Minister Spots submission that
  // arrived in the meantime.
  const patch = {};
  Object.keys(cur).forEach(function(k){
    if (k === 'msActionHint') return; // one-shot signal, handled below
    if (JSON.stringify(cur[k]) !== JSON.stringify(syncBase[k])) patch[k] = cur[k];
  });
  if (cur.msActionHint) patch.msActionHint = cur.msActionHint;
  if (!Object.keys(patch).length) return; // nothing changed

  try {
    const res = await fetch(SYNC_API_URL.replace(/\\/$/, '') + '/state', {
      method: 'PUT',
      headers: stateHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ _baseRev: syncRev, patch: patch })
    });
    if (!res.ok) { updateSyncStatus('error'); return; }
    const out = await res.json();
    if (out && out.ok === false) { updateSyncStatus('error'); return; }

    if (typeof out.rev === 'number') syncRev = out.rev;
    delete patch.msActionHint;
    Object.keys(patch).forEach(function(k){ syncBase[k] = JSON.parse(JSON.stringify(patch[k])); });
    syncLastPushedJSON = JSON.stringify(syncBase);

    // Someone else wrote while we were editing. The server merged both, and handed
    // back the result — apply it now rather than waiting for the next poll.
    if (out.conflict && out.state) {
      const s = out.state;
      if (typeof s._rev === 'number') syncRev = s._rev;
      delete s._rev;
      syncApplyRemote(s);
      syncBase = JSON.parse(JSON.stringify(s));
      syncLastPushedJSON = JSON.stringify(syncBase);
    }
    updateSyncStatus('synced');
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

// Poll only while the tab is actually visible. Most of the 50 tabs open during a
// battle are backgrounded — this roughly halves our daily request usage for free.
function syncStartPolling(){
  if (syncPollTimer) return;
  syncPollTimer = setInterval(syncPull, SYNC_POLL_MS);
}
function syncStopPolling(){
  if (!syncPollTimer) return;
  clearInterval(syncPollTimer);
  syncPollTimer = null;
}
if (syncEnabled()) {
  syncPull();
  syncStartPolling();
  document.addEventListener('visibilitychange', function(){
    if (document.hidden) { syncStopPolling(); }
    else { syncPull(); syncStartPolling(); }
  });
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
  updateKvK();
}
// KvK countdown — next KvK begins at 00:00 UTC on the anchor date, then repeats every 28 days.
// To change it: set KVK_ANCHOR_UTC to any known KvK start (00:00 UTC). Month is 0-based: 6 = July.
const KVK_ANCHOR_UTC = Date.UTC(2026,6,13,0,0,0);
const KVK_CYCLE_MS = 28*24*60*60*1000;
function nextKvKStart(now){ let t=KVK_ANCHOR_UTC; if(now>=t){ t += Math.ceil((now-t+1)/KVK_CYCLE_MS)*KVK_CYCLE_MS; } return t; }
function updateKvK(){
  const el=document.getElementById('kvkCountdown'); if(!el) return;
  let diff=Math.max(0,nextKvKStart(Date.now())-Date.now());
  const d=Math.floor(diff/86400000); diff%=86400000;
  const h=Math.floor(diff/3600000); diff%=3600000;
  const m=Math.floor(diff/60000); diff%=60000;
  const s=Math.floor(diff/1000);
  el.textContent=d+'d '+String(h).padStart(2,'0')+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s';
}
// ════════════ KvK SCHEDULE (Minister Spots automation timing) ════════════
// Board → day offset from KvK Day 1.  Day 1 Construction=buildings, Day 2 Research, Day 4 Troops.
const MS_BOARD_DAY_OFFSET = { buildings:0, research:1, troops:3 };
const _MS_DAY = 86400000, _MS_H = 3600000;
// Admin override for the next KvK Day-1 start (setter arrives in a later phase). Read-only here.
function msDay1Override(){
  try { return (typeof MS!=='undefined' && MS.kvkDay1Override) ? new Date(MS.kvkDay1Override).getTime() : null; } catch(e){ return null; }
}
// Day-1 start (00:00 UTC) of the currently-active or next KvK. Unlike nextKvKStart, this stays
// anchored to the CURRENT KvK during the event window, so mid-event allocation (e.g. Troops on
// Day 4) computes against the right cycle instead of rolling forward to the next one.
function currentKvKDay1(now){
  var o = msDay1Override(); if(o) return o;
  var k = Math.floor((now - KVK_ANCHOR_UTC) / KVK_CYCLE_MS);
  for(var i=k; i<=k+1; i++){
    var day1 = KVK_ANCHOR_UTC + i*KVK_CYCLE_MS;
    if(now >= day1 - 8*_MS_DAY && now < day1 + 6*_MS_DAY) return day1;
  }
  return nextKvKStart(now);
}
// Full computed schedule for the active/next KvK. All values are epoch ms (UTC).
function msSchedule(now){
  if(now===undefined) now = Date.now();
  var day1 = currentKvKDay1(now);
  var sched = { day1:day1, clearAt: day1 - 7*_MS_DAY, openAt: day1 - 7*_MS_DAY, boards:{} };
  Object.keys(MS_BOARD_DAY_OFFSET).forEach(function(b){
    var dStart = day1 + MS_BOARD_DAY_OFFSET[b]*_MS_DAY;
    sched.boards[b] = {
      dayStart: dStart,
      deadline: dStart - (36*_MS_H + 60000), // submissions close 36h01m before the day
      allocAt:  dStart - 36*_MS_H            // allocation runs 36h before the day (1 min after close)
    };
  });
  return sched;
}
var _MS_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtUTCDate(ms){
  var d = new Date(ms);
  return d.getUTCDate()+' '+_MS_MON[d.getUTCMonth()]+' '+d.getUTCFullYear();
}
function fmtUTCDateTime(ms){
  var d = new Date(ms);
  return fmtUTCDate(ms)+', '+String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0')+' UTC';
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
function copyText(text, silent){
  const done=()=>{ if(!silent) toast('Copied!'); };
  const fallback=()=>{
    try{
      const el=document.createElement('textarea'); el.value=text;
      el.setAttribute('readonly','');
      el.style.position='fixed'; el.style.top='0'; el.style.left='0'; el.style.opacity='0';
      document.body.appendChild(el);
      if(/ipad|iphone|ipod/i.test(navigator.userAgent)){
        // iOS Safari: plain select() does not work — need a real Range + setSelectionRange
        el.contentEditable=true;
        const range=document.createRange(); range.selectNodeContents(el);
        const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        el.setSelectionRange(0,999999);
      } else { el.select(); }
      const ok=document.execCommand('copy'); document.body.removeChild(el);
      if(ok){ done(); return Promise.resolve(); }
      copyShowManual(text);
      return Promise.reject(new Error('copy failed'));
    }catch(e){ copyShowManual(text); return Promise.reject(e); }
  };
  // Clipboard API silently fails when the page is not focused (e.g. user just
  // came back from the game app) — skip straight to the fallback in that case.
  if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext&&document.hasFocus()){
    return navigator.clipboard.writeText(text).then(()=>{ done(); }).catch(()=>fallback());
  }
  return fallback();
}
// Last-resort manual copy: show the text in a modal so nothing is ever lost mid-battle.
function copyShowManual(text){
  let ov=document.getElementById('copyManualOverlay');
  if(!ov){
    ov=document.createElement('div'); ov.id='copyManualOverlay';
    ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
    ov.onclick=function(e){ if(e.target===ov) ov.style.display='none'; };
    document.body.appendChild(ov);
  }
  ov.innerHTML='<div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:16px;max-width:420px;width:100%">'+
    '<div style="font-weight:700;color:var(--accent2);margin-bottom:8px;font-family:var(--head)">Automatic copy failed</div>'+
    '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">Tap and hold (or Ctrl+C) the text below, then choose Copy.</div>'+
    '<textarea id="copyManualText" readonly style="width:100%;height:120px;font-family:var(--mono);font-size:12px;background:var(--bg4);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px"></textarea>'+
    '<button class="btn btn-ghost btn-sm" style="margin-top:8px;width:100%" onclick="document.getElementById(&quot;copyManualOverlay&quot;).style.display=&quot;none&quot;">Close</button></div>';
  const ta=document.getElementById('copyManualText'); if(ta){ ta.focus(); ta.select(); }
  ov.style.display='flex';
  const _ta=document.getElementById('copyManualText'); if(_ta) _ta.value=text;
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
  if(!sel) return;
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
  if(!panel) return;
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
  const gIn=document.getElementById('garrisonAllianceName');
  const aIn=document.getElementById('attackAllianceName');
  if(!gIn||!aIn) return;
  const gn=gIn.value;
  const an=aIn.value;
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
  if(!gList) return;
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
  let healed=false;
  S.leaders.forEach(function(l){ if(l.pet&&l.pet.active&&!l.pet.startMs){ l.pet.active=false; healed=true; } });
  if(healed){ if(typeof renderBattleStrategy==='function') renderBattleStrategy(); if(typeof syncQueuePush==='function') syncQueuePush(); }
  S.leaders.forEach(l=>{
    if(!l.pet||!l.pet.active||!l.pet.startMs) return;
    const rem=PET_DUR-(now-l.pet.startMs);
    const expired=rem<=0;
    if(expired){ l.pet.active=false; l.pet.startMs=null; }
    const expiring=!expired&&rem<=WARN_MS;
    const txt=expired?'EXPIRED':fmtSec(Math.ceil(rem/1000));
    // Pet Planner card
    const timerEl=document.getElementById('pettimer-'+l.id);
    if(timerEl){
      const cardEl=document.getElementById('petcard-'+l.id);
      const btnEl=cardEl?cardEl.querySelector('.pet-toggle'):null;
      if(expired){ timerEl.textContent='EXPIRED'; timerEl.className='pet-timer expired'; if(cardEl)cardEl.className='pet-card expired'; if(btnEl){ btnEl.textContent='▶ Activate'; btnEl.className='pet-toggle off'; } }
      else { timerEl.textContent=txt; timerEl.className='pet-timer '+(expiring?'expiring':'active'); if(cardEl)cardEl.className='pet-card '+(expiring?'expiring':'active'); }
    }
    // Battle Strategy card
    const bsFill=document.getElementById('bspetfill-'+l.id);
    const bsLabel=document.getElementById('bspetlabel-'+l.id);
    if(bsFill&&bsLabel){
      if(expired){ bsFill.className='bs-pet-bar-fill off'; bsFill.style.width='0%'; bsLabel.className='bs-pet-label off'; bsLabel.textContent='No pet — tap to start'; }
      else { const cls=expiring?'warn':'on'; bsFill.className='bs-pet-bar-fill '+cls; bsFill.style.width=Math.max(0,Math.min(100,rem/PET_DUR*100))+'%'; bsLabel.className='bs-pet-label '+cls; bsLabel.textContent=txt; }
    }
  });
}
setInterval(tickPets, 1000);

// ── Pet Activation Plan (Battle Strategy) — arm a batch of leaders to auto-activate at a UTC time ──
let bsPetPlans=[]; let bsPetSel=[];
function bsPetSelToggle(id){ const i=bsPetSel.indexOf(id); if(i>=0)bsPetSel.splice(i,1); else bsPetSel.push(id); renderPetPlanChips(); }
function bsAddPetPlan(){
  const inp=document.getElementById('bsPetPlanTime'); if(!inp) return;
  const v=inp.value; if(!v){ toast('Pick a UTC time'); return; }
  if(!bsPetSel.length){ toast('Select at least one leader'); return; }
  const parts=v.split(':'); const hh=parseInt(parts[0],10), mm=parseInt(parts[1],10);
  const now=new Date();
  let t=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),hh,mm,0);
  if(t<=Date.now()) t+=86400000;
  bsPetPlans.push({id:'pp'+Date.now(),targetMs:t,hh:hh,mm:mm,leaderIds:bsPetSel.slice(),fired:false});
  bsPetSel=[]; renderPetPlans(); toast('Plan added');
}
function bsRemovePetPlan(id){ bsPetPlans=bsPetPlans.filter(p=>p.id!==id); renderPetPlans(); }

function bsFirePetPlans(){
  const now=Date.now(); let changed=false;
  bsPetPlans.forEach(function(p){
    if(p.fired||now<p.targetMs) return;
    p.leaderIds.forEach(function(id){ const l=S.leaders.find(function(x){return x.id===id;}); if(l){ if(!l.pet)l.pet={active:false,startMs:null}; l.pet.active=true; l.pet.startMs=now; } });
    p.fired=true; changed=true;
  });
  if(changed){ if(typeof renderBattleStrategy==='function') renderBattleStrategy(); if(typeof syncQueuePush==='function') syncQueuePush(); toast('Pets activated by plan'); }
}
function renderPetPlanChips(){
  const el=document.getElementById('bsPetSelChips'); if(!el) return;
  const planned={};
  bsPetPlans.forEach(function(p){ if(!p.fired) p.leaderIds.forEach(function(id){ planned[id]=true; }); });
  el.innerHTML = S.leaders.length ? S.leaders.map(function(l){
    const on=bsPetSel.indexOf(l.id)>=0;
    const has=!!planned[l.id];
    const bd=on?'var(--accent)':(has?'var(--green)':'var(--border)');
    const bg=on?'rgba(201,165,92,.15)':(has?'rgba(124,200,121,.12)':'var(--bg3)');
    const cl=on?'var(--accent2)':(has?'var(--green)':'var(--text2)');
    return '<span onclick="bsPetSelToggle('+"'"+l.id+"'"+')" title="'+(has?'Already in a pet activation plan':'')+'" style="cursor:pointer;user-select:none;font-size:12px;padding:4px 10px;border-radius:14px;border:1px solid '+bd+';background:'+bg+';color:'+cl+'">'+(has?'🐾 ':'')+l.name+'</span>';
  }).join('') : '<span style="color:var(--text3);font-size:12px">No leaders yet.</span>';
}
function renderPetPlanList(){
  const el=document.getElementById('bsPetPlanList'); if(!el) return;
  if(!bsPetPlans.length){ el.innerHTML='<div style="color:var(--text3);font-size:12px">No plans yet. Select leaders, pick a UTC time, and add a plan.</div>'; return; }
  const now=Date.now();
  el.innerHTML=bsPetPlans.map(function(p){
    const hhmm=String(p.hh).padStart(2,'0')+':'+String(p.mm).padStart(2,'0');
    let status;
    if(p.fired) status='<span style="color:#c084fc">✓ Activated</span>';
    else status='<span style="color:var(--gold)">in '+fmtSec(Math.ceil(Math.max(0,p.targetMs-now)/1000))+'</span>';
    const names=p.leaderIds.map(function(id){ const l=S.leaders.find(function(x){return x.id===id;}); return l?l.name:'?'; }).join(', ');
    return '<div style="padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;margin-bottom:6px">'+
      '<div style="display:flex;align-items:center;gap:10px">'+
        '<span style="font-family:var(--mono);color:var(--text);font-size:14px">'+hhmm+' UTC</span>'+
        '<span style="color:var(--text2);font-size:12px">'+p.leaderIds.length+' leader'+(p.leaderIds.length===1?'':'s')+'</span>'+
        '<span style="font-size:12px">'+status+'</span>'+
        '<span style="flex:1"></span>'+
        '<span onclick="bsRemovePetPlan('+"'"+p.id+"'"+')" style="cursor:pointer;color:var(--text3);font-size:14px;padding:6px 8px" title="Remove">✕</span>'+
      '</div>'+
      '<div style="color:var(--text3);font-size:11px;margin-top:4px;line-height:1.5">'+names+'</div>'+
    '</div>';
  }).join('');
}
function renderPetPlans(){ renderPetPlanChips(); renderPetPlanList(); }
setInterval(function(){ bsFirePetPlans(); renderPetPlanList(); },1000);
renderPetGrid();

// ════════════ BATTLE STRATEGY ════════════
const BS_TURRETS = [{name:'North'},{name:'East'},{name:'South'},{name:'West'}];
// assignment state per leader: {slotType:'pool'|'turret'|'team', slotId: turretIndex|teamId|null}
function bsGetAssignment(leaderId){
  const l=S.leaders.find(x=>x.id===leaderId);
  if(!l) return {slotType:'pool',slotId:null};
  if(!l.bsSlot) l.bsSlot={slotType:'pool',slotId:null};
  return l.bsSlot;
}
function bsRemoveFromSlot(leaderId){
  const l=S.leaders.find(x=>x.id===leaderId); if(!l) return;
  l.bsSlot={slotType:'pool',slotId:null};
  renderBattleStrategy(); syncQueuePush();
}

function bsLeaderCardHTML(l){
  const p=l.pet||{active:false,startMs:null};
  let petCls='off',petTxt='No pet — tap to start',petPct=0;
  if(p.active&&p.startMs){
    const rem=PET_DUR-(Date.now()-p.startMs);
    if(rem>0){ petCls=(rem<=WARN_MS)?'warn':'on'; petTxt=fmtSec(Math.ceil(rem/1000)); petPct=Math.max(0,Math.min(100,rem/PET_DUR*100)); }
  }
  // Team color accent reflects the leader's ACTUAL current placement (bsSlot), not the
  // unused legacy l.teamId field — that's what was producing the always-wrong "No team" label.
  const inPool = !l.bsSlot || l.bsSlot.slotType==='pool';
  let placedTeam=null;
  if(l.bsSlot && l.bsSlot.slotType==='team'){ bsEnsureTeamColors(); placedTeam=S.teams.find(t=>t.id===l.bsSlot.slotId); }
  const accent = placedTeam ? ('border-left:4px solid '+placedTeam.color+';') : '';
  const removeBtn = inPool ? '' : '<span onclick="event.stopPropagation();bsRemoveFromSlot(\\''+l.id+'\\')" title="Remove — back to pool" style="cursor:pointer;color:#ff8080;font-size:14px;padding:6px 8px">✕</span>';
  return \`<div class="bs-leader-card" id="bsleader-\${l.id}" style="\${accent}">
    <div class="bs-leader-name" style="display:flex;align-items:center;gap:4px"><span style="flex:1">\${l.name} <span class="badge badge-\${l.tier.toLowerCase()}" style="margin-left:3px">\${l.tier}</span></span>\${removeBtn}<span onclick="event.stopPropagation();bsOpenMoveModal('\${l.id}')" title="Move" style="cursor:pointer;color:var(--text3);font-size:14px;padding:6px 8px">⇄</span></div>
    <div class="bs-leader-meta">\${placedTeam?placedTeam.name+' · ':''}\${l.march}s march</div>
    <div class="bs-pet-bar" style="cursor:pointer" onclick="bsTogglePet(event,'\${l.id}')" title="Click to toggle 2.5h pet buff"><div class="bs-pet-bar-fill \${petCls}" id="bspetfill-\${l.id}" style="width:\${petPct}%"></div></div>
    <div class="bs-pet-label \${petCls}" id="bspetlabel-\${l.id}" style="cursor:pointer" onclick="bsTogglePet(event,'\${l.id}')">\${petTxt}</div>
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
let bsAddModalTarget=null;  // {slotType:'team'|'turret', slotId}
function bsOpenAddModal(slotType, slotId){
  bsAddModalTarget={slotType:slotType, slotId:slotId};
  let ov=document.getElementById('bsAddOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='bsAddOverlay'; ov.className='bs-modal-overlay'; ov.onclick=function(e){ if(e.target===ov) bsCloseAddModal(); }; document.body.appendChild(ov); }
  ov.style.display='flex';
  bsRenderAddModal();
}
function bsCloseAddModal(){ const ov=document.getElementById('bsAddOverlay'); if(ov) ov.style.display='none'; bsAddModalTarget=null; }
function bsAddTargetLabel(){
  if(!bsAddModalTarget) return '';
  if(bsAddModalTarget.slotType==='turret'){ var tr=BS_TURRETS[bsAddModalTarget.slotId]; return tr?('🗼 '+tr.name):'turret'; }
  var tm=S.teams.find(function(x){return x.id===bsAddModalTarget.slotId;}); return tm?tm.name:'team';
}
function bsAddIsHere(l){
  if(!bsAddModalTarget||!l.bsSlot) return false;
  return l.bsSlot.slotType===bsAddModalTarget.slotType && l.bsSlot.slotId===bsAddModalTarget.slotId;
}
function bsRenderAddModal(){
  const ov=document.getElementById('bsAddOverlay'); if(!ov||!bsAddModalTarget) return;
  const rows=S.leaders.map(function(l){
    const onThis=bsAddIsHere(l);
    let where='';
    if(l.bsSlot&&l.bsSlot.slotType==='team'){ const ot=S.teams.find(function(x){return x.id===l.bsSlot.slotId;}); where=(onThis?'here':('on '+(ot?ot.name:'a team'))); }
    else if(l.bsSlot&&l.bsSlot.slotType==='turret'){ const tr=BS_TURRETS[l.bsSlot.slotId]; where=(onThis?'here':('on '+(tr?tr.name:'a turret'))); }
    const placed=l.bsSlot&&l.bsSlot.slotType!=='pool';
    const badge = placed ? '<span style="font-size:10px;color:'+(onThis?'var(--green)':'var(--gold)')+';border:1px solid '+(onThis?'var(--green)':'var(--gold)')+';border-radius:4px;padding:1px 5px">'+where+'</span>' : '';
    const action = onThis ? '<span style="color:var(--green);font-size:14px">✓</span>' : '<span style="color:var(--accent2);font-size:12px">+ add</span>';
    const click = onThis ? '' : ' onclick="bsAddToSlot('+"'"+l.id+"'"+')"';
    return '<div class="bs-add-row'+(onThis?' here':'')+'"'+click+'><span style="flex:1;font-size:13px;color:var(--text)">'+l.name+' <span style="color:var(--text3);font-size:11px">'+l.tier+'</span></span>'+badge+action+'</div>';
  }).join('');
  ov.innerHTML='<div class="bs-modal"><div class="bs-modal-head"><span style="font-family:var(--head);font-weight:600;letter-spacing:.04em;color:var(--accent2);flex:1">Add to '+bsAddTargetLabel()+'</span><span onclick="bsCloseAddModal()" style="cursor:pointer;color:var(--text3);font-size:18px">✕</span></div><div class="bs-modal-list">'+(S.leaders.length?rows:'<div style="color:var(--text3);font-size:12px;padding:10px">No leaders yet.</div>')+'</div></div>';
}
function bsAddToSlot(leaderId){
  const l=S.leaders.find(function(x){return x.id===leaderId;}); if(!l||!bsAddModalTarget) return;
  const tgt=bsAddModalTarget;
  l.bsSlot={slotType:tgt.slotType, slotId:tgt.slotId};
  renderBattleStrategy(); syncQueuePush(); bsRenderAddModal();
}
function bsHexA(hex,a){
  hex=(hex||'').replace('#','');
  if(hex.length!==6) return 'rgba(120,130,150,'+a+')';
  var r=parseInt(hex.substr(0,2),16),g=parseInt(hex.substr(2,2),16),b=parseInt(hex.substr(4,2),16);
  return 'rgba('+r+','+g+','+b+','+a+')';
}
function teamBoxHTML(t){
  const occupants=S.leaders.filter(l=>l.bsSlot&&l.bsSlot.slotType==='team'&&l.bsSlot.slotId===t.id);
  bsEnsureAlliances();
  const pills=S.alliances.map(function(a){
    const active=t.alliance===a.id;
    const st=active
      ? ('background:'+bsHexA(a.color,.28)+';color:'+a.color+';border-color:'+bsHexA(a.color,.65)+';font-weight:700;')
      : ('background:var(--bg4);color:var(--text2);border-color:var(--border2);');
    return '<span class="ally-pill" style="'+st+'" onclick="bsSetTeamAlliance('+"'"+t.id+"'"+','+"'"+a.id+"'"+')">'+a.name+'</span>';
  }).join('');
  return \`<div class="bs-team-box" id="bsteam-\${t.id}" style="background:var(--bg3);border:1.5px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px">
      <div class="bs-team-header" style="display:flex;align-items:center;gap:6px"><span style="flex:1;font-weight:600">\${t.name}</span><span onclick="bsRenameTeam('\${t.id}')" title="Rename" style="cursor:pointer;color:var(--text3);font-size:12px">✎</span><span onclick="bsDeleteTeam('\${t.id}')" title="Delete team" style="cursor:pointer;color:#e0685f;font-size:13px">✕</span></div>
      <div class="bs-alliance-toggle" style="display:flex;gap:5px;flex-wrap:wrap;margin:7px 0 8px">\${pills}</div>
      <button style="width:100%;margin-bottom:8px;background:rgba(201,165,92,.15);border:1.5px solid var(--accent);color:var(--accent2);font-weight:700;font-size:12px;padding:7px;border-radius:6px;cursor:pointer;font-family:var(--head);letter-spacing:.03em" onclick="bsOpenAddModal('team','\${t.id}')">➕ Add Leader</button>
      <div class="bs-team-zone">
        \${occupants.length?occupants.map(o=>bsLeaderCardHTML(o)).join(''):'<div style="color:var(--text3);font-size:12px;padding:8px">No leaders yet.</div>'}
      </div>
    </div>\`;
}
function renderBsAllianceZones(){
  bsEnsureAlliances();
  var el=document.getElementById('bsAllianceZones'); if(!el) return;
  var known={}; S.alliances.forEach(function(a){ known[a.id]=true; });
  var cards='';
  S.alliances.forEach(function(a){
    var teams=S.teams.filter(function(t){return t.alliance===a.id;});
    cards+='<div class="card" style="width:320px;flex:0 0 320px;margin-bottom:0"><div class="card-title" style="color:'+a.color+'">🛡️ '+a.name+'</div>'+
      (teams.length?teams.map(teamBoxHTML).join(''):'<div style="color:var(--text3);font-size:12px">No teams yet. Add a team, then use its alliance buttons to place it here.</div>')+
      '</div>';
  });
  var un=S.teams.filter(function(t){return !t.alliance || !known[t.alliance];});
  if(un.length){
    cards+='<div class="card" style="width:320px;flex:0 0 320px;margin-bottom:0"><div class="card-title" style="color:var(--text3)">📦 Unassigned</div>'+un.map(teamBoxHTML).join('')+'</div>';
  }
  el.innerHTML='<div style="display:flex;flex-wrap:wrap;gap:14px">'+cards+'</div>';
}
function bsRenameTeam(teamId){
  var t=S.teams.find(function(x){return x.id===teamId;}); if(!t) return;
  var n=prompt('Rename team', t.name); if(n===null) return;
  n=n.trim(); if(!n) return;
  t.name=n; t.customName=true; renderBattleStrategy(); if(typeof renderSetup==='function') renderSetup(); syncQueuePush();
}
function bsDeleteTeam(teamId){
  var t=S.teams.find(function(x){return x.id===teamId;}); if(!t) return;
  if(!confirm('Delete team "'+t.name+'"? Its leaders go back to the pool.')) return;
  S.leaders.forEach(function(l){ if(l.bsSlot&&l.bsSlot.slotType==='team'&&l.bsSlot.slotId===teamId) l.bsSlot={slotType:'pool',slotId:null}; });
  S.teams=S.teams.filter(function(x){return x.id!==teamId;});
  renderBattleStrategy(); if(typeof renderSetup==='function') renderSetup(); syncQueuePush();
}
function bsAddAlliance(){
  bsEnsureAlliances();
  var el=document.getElementById('bsNewAllianceName'); if(!el) return;
  var name=(el.value||'').trim(); if(!name){ toast('Enter an alliance name'); return; }
  var color=BS_ALLIANCE_PALETTE[S.alliances.length % BS_ALLIANCE_PALETTE.length];
  S.alliances.push({id:'ally_'+Date.now(), name:name, color:color});
  el.value='';
  renderBattleStrategy(); syncQueuePush(); toast('Alliance added');
}
function bsRenameAlliance(id,val){
  bsEnsureAlliances();
  var a=S.alliances.find(function(x){return x.id===id;}); if(!a) return;
  var name=(val||'').trim(); if(!name) return;
  a.name=name; renderBattleStrategy(); syncQueuePush();
}
function bsRemoveAlliance(id){
  bsEnsureAlliances();
  if(S.alliances.length<=1){ toast('Keep at least one alliance'); return; }
  var a=S.alliances.find(function(x){return x.id===id;}); if(!a) return;
  if(!confirm('Remove alliance "'+a.name+'"? Its teams become unassigned.')) return;
  S.alliances=S.alliances.filter(function(x){return x.id!==id;});
  S.teams.forEach(function(t){ if(t.alliance===id) t.alliance=null; });
  renderBattleStrategy(); syncQueuePush();
}
function renderBsAllianceList(){
  bsEnsureAlliances();
  var el=document.getElementById('bsAllianceList'); if(!el) return;
  el.innerHTML=S.alliances.map(function(a){
    return '<div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">'+
      '<span style="width:10px;height:10px;border-radius:50%;background:'+a.color+';flex-shrink:0"></span>'+
      '<input value="'+(a.name||'').replace(/"/g,'&quot;')+'" onchange="bsRenameAlliance('+"'"+a.id+"'"+',this.value)" style="flex:1;font-size:12px;padding:4px 7px">'+
      '<span onclick="bsRemoveAlliance('+"'"+a.id+"'"+')" style="cursor:pointer;color:var(--text3);font-size:13px" title="Remove alliance">✕</span>'+
    '</div>';
  }).join('');
}
let bsMoveLeaderId=null;
function bsOpenMoveModal(leaderId){
  bsMoveLeaderId=leaderId;
  let ov=document.getElementById('bsMoveOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='bsMoveOverlay'; ov.className='bs-modal-overlay'; ov.onclick=function(e){ if(e.target===ov) bsCloseMoveModal(); }; document.body.appendChild(ov); }
  ov.style.display='flex'; bsRenderMoveModal();
}
function bsCloseMoveModal(){ const ov=document.getElementById('bsMoveOverlay'); if(ov) ov.style.display='none'; bsMoveLeaderId=null; }
function bsMoveTo(slotType,slotId){
  const l=S.leaders.find(function(x){return x.id===bsMoveLeaderId;}); if(!l) return;
  l.bsSlot={slotType:slotType,slotId:slotId};
  renderBattleStrategy(); syncQueuePush(); bsCloseMoveModal();
}
function bsRenderMoveModal(){
  const ov=document.getElementById('bsMoveOverlay'); if(!ov||!bsMoveLeaderId) return;
  const l=S.leaders.find(function(x){return x.id===bsMoveLeaderId;}); if(!l){ bsCloseMoveModal(); return; }
  const cur=l.bsSlot||{slotType:'pool',slotId:null};
  function row(label,type,id,active){
    let arg;
    if(id===null) arg='null'; else if(typeof id==='number') arg=String(id); else arg="'"+id+"'";
    const click=active?'':' onclick="bsMoveTo('+"'"+type+"'"+','+arg+')"';
    return '<div class="bs-add-row'+(active?' here':'')+'"'+click+'><span style="flex:1;font-size:13px;color:var(--text)">'+label+'</span>'+(active?'<span style="color:var(--green);font-size:14px">✓ here</span>':'<span style="color:var(--accent2);font-size:12px">move</span>')+'</div>';
  }
  let rows=row('Rally Leader Pool','pool',null,cur.slotType==='pool');
  BS_TURRETS.forEach(function(t,i){ rows+=row('🗼 '+t.name,'turret',i,cur.slotType==='turret'&&cur.slotId===i); });
  S.teams.forEach(function(t){ const an=t.alliance?(' · '+bsAllianceName(t.alliance)):''; rows+=row(t.name+an,'team',t.id,cur.slotType==='team'&&cur.slotId===t.id); });
  ov.innerHTML='<div class="bs-modal"><div class="bs-modal-head"><span style="font-family:var(--head);font-weight:600;letter-spacing:.04em;color:var(--accent2);flex:1">Move '+l.name+'</span><span onclick="bsCloseMoveModal()" style="cursor:pointer;color:var(--text3);font-size:18px">✕</span></div><div class="bs-modal-list">'+rows+'</div></div>';
}
function bsAllianceName(which){
  bsEnsureAlliances();
  var a=(S.alliances||[]).find(function(x){return x.id===which;});
  return a?a.name:(which==='garrison'?'Garrison':which==='attack'?'Attacking':'Alliance');
}
function bsAllianceColor(which){
  bsEnsureAlliances();
  var a=(S.alliances||[]).find(function(x){return x.id===which;});
  return a?a.color:'var(--text3)';
}
function bsSetTeamAlliance(teamId, alliance){
  const t=S.teams.find(function(x){return x.id===teamId;}); if(!t) return;
  if(t.alliance===alliance) return;
  t.alliance=alliance;
  renderBattleStrategy();
  syncQueuePush();
}
let bsPendingPlayer=null;
async function bsLookupPlayer(){
  const idEl=document.getElementById('bsAddPlayerId'); const pid=(idEl&&idEl.value||'').trim();
  const prev=document.getElementById('bsAddPreview'); if(!prev) return;
  if(!pid){ toast('Enter a Player ID'); return; }
  prev.innerHTML='<span style="color:var(--text3);font-size:12px">Looking up…</span>';
  const p=await doPlayerLookup(pid);
  if(!p){ bsPendingPlayer=null; prev.innerHTML='<span style="color:var(--enemy);font-size:12px">⚠ Player not found. Check the ID.</span>'; return; }
  bsPendingPlayer={ playerId:p.playerId, name:p.name, avatar:p.profilePhoto||null };
  prev.innerHTML='<div style="display:flex;align-items:center;gap:10px;background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:8px 10px">'+(p.profilePhoto?'<img src="'+p.profilePhoto+'" style="width:36px;height:36px;border-radius:50%;flex-shrink:0">':'')+'<div><div style="font-weight:700">'+p.name+'</div><div style="font-size:11px;color:var(--text3)">ID: '+p.playerId+'</div></div></div>';
}
function bsAddLeaderById(){
  const march=parseInt((document.getElementById('bsAddMarch')||{}).value,10);
  if(!bsPendingPlayer){ toast('Look up a Player ID first'); return; }
  if(isNaN(march)||march<0){ toast('Enter a march time'); return; }
  S.leaders.push({id:uid(),name:bsPendingPlayer.name,march:march,tier:'TG5',dur:300,teamId:null,status:'free',timerEnd:null,launchTimeStr:null,landTimeStr:null,avatar:bsPendingPlayer.avatar,playerId:bsPendingPlayer.playerId,bsSlot:{slotType:'pool',slotId:null},pet:{active:false,startMs:null}});
  bsPendingPlayer=null;
  const a=document.getElementById('bsAddPlayerId'); if(a)a.value='';
  const b=document.getElementById('bsAddMarch'); if(b)b.value='';
  const c=document.getElementById('bsAddPreview'); if(c)c.innerHTML='';
  if(typeof renderLeaderTable==='function') renderLeaderTable();
  renderBattleStrategy();
  syncQueuePush();
  toast('Leader added');
}
function bsEditMarch(leaderId,val){
  const l=S.leaders.find(function(x){return x.id===leaderId;}); if(!l) return;
  const m=parseInt(val,10); if(isNaN(m)||m<0) return;
  l.march=m; syncQueuePush(); if(typeof renderLeaderTable==='function') renderLeaderTable();
}
function bsRemoveLeaderOverview(leaderId){
  S.leaders=S.leaders.filter(function(x){return x.id!==leaderId;});
  renderBattleStrategy(); if(typeof renderLeaderTable==='function') renderLeaderTable(); syncQueuePush();
}
function renderBsLeaderOverview(){
  const el=document.getElementById('bsLeaderOverview'); if(!el) return;
  if(!S.leaders.length){ el.innerHTML='<div style="color:var(--text3);font-size:12px">No rally leaders yet.</div>'; return; }
  el.innerHTML='<div style="font-size:11px;color:var(--text3);margin-bottom:5px">'+S.leaders.length+' rally leader'+(S.leaders.length===1?'':'s')+'</div>'+S.leaders.map(function(l){
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;margin-bottom:5px">'+
      (l.avatar?'<img src="'+l.avatar+'" style="width:26px;height:26px;border-radius:50%;flex-shrink:0">':'<span style="width:26px;height:26px;border-radius:50%;background:var(--bg4);display:inline-block;flex-shrink:0"></span>')+
      '<span style="flex:1;font-size:13px;color:var(--text)">'+l.name+'</span>'+
      '<span style="font-size:11px;color:var(--text3)">march</span>'+
      '<input type="number" min="0" value="'+l.march+'" onchange="bsEditMarch('+"'"+l.id+"'"+',this.value)" style="width:60px;font-size:12px">'+
      '<span onclick="bsRemoveLeaderOverview('+"'"+l.id+"'"+')" style="cursor:pointer;color:var(--text3);font-size:14px" title="Remove leader">✕</span>'+
    '</div>';
  }).join('');
}
function bsAddTeam(){
  const el=document.getElementById('bsNewTeamName'); if(!el) return;
  const name=(el.value||'').trim(); if(!name){ toast('Enter a team name'); return; }
  bsEnsureAlliances();
  bsEnsureTeamColors();
  S.teams.push({id:uid(),name:name,alliance:(S.alliances[0]?S.alliances[0].id:null),color:BS_TEAM_PALETTE[S.teams.length % BS_TEAM_PALETTE.length]});
  el.value='';
  if(typeof renderSetup==='function') renderSetup();
  renderBattleStrategy();
  syncQueuePush();
  toast('Team added');
}
function renderBsSidebar(){
  const el=document.getElementById('bsSidebar'); if(!el) return;
  if(document.getElementById('bsAddPlayerId')) return;
  el.innerHTML=
    '<div class="side-brand"><div style="font-family:var(--head);font-weight:700;letter-spacing:.06em;font-size:16px;color:var(--accent2)">KINGDOM·1057</div><div style="font-size:11px;color:var(--text3)">Battle Strategy</div></div>'+
    '<div class="side-sec"><h3>➕ Add Rally Leader</h3>'+
      '<div style="margin-bottom:8px"><label style="display:block;font-size:10px;color:var(--text2);margin-bottom:3px">Player ID</label><div style="display:flex;gap:6px"><input id="bsAddPlayerId" placeholder="158134757" style="flex:1"><button class="btn btn-ghost btn-sm" onclick="bsLookupPlayer()">Look up</button></div></div>'+
      '<div id="bsAddPreview" style="margin-bottom:8px"></div>'+
      '<div style="display:flex;gap:6px;align-items:flex-end"><div style="width:80px"><label style="display:block;font-size:10px;color:var(--text2);margin-bottom:3px">March (s)</label><input type="number" id="bsAddMarch" min="0" placeholder="35" style="width:100%"></div><button class="btn btn-primary btn-sm" style="flex:1" onclick="bsAddLeaderById()">+ Add Leader</button></div>'+
    '</div>'+
    '<div class="side-sec"><h3>⚔️ Alliance</h3>'+
      '<div style="background:rgba(201,165,92,.1);border:2px solid var(--accent);border-radius:8px;padding:10px;margin-bottom:10px">'+
        '<label style="display:block;font-size:11px;font-weight:700;color:var(--accent2);margin-bottom:5px">＋ Add New Alliance</label>'+
        '<div style="display:flex;gap:6px"><input id="bsNewAllianceName" placeholder="e.g. Attack 2" style="flex:1"><button class="btn btn-primary" onclick="bsAddAlliance()">+ Add</button></div>'+
      '</div>'+
      '<div id="bsAllianceList"></div>'+
    '</div>'+
    '<div class="side-sec"><h3>🛡️ Team</h3>'+
      '<div style="background:rgba(201,165,92,.06);border:2px solid var(--border2);border-radius:8px;padding:10px;margin-bottom:10px">'+
        '<label style="display:block;font-size:11px;font-weight:700;color:var(--text);margin-bottom:5px">＋ Add New Team</label>'+
        '<div style="display:flex;gap:6px"><input id="bsNewTeamName" placeholder="e.g. Team 5" style="flex:1"><button class="btn btn-primary" onclick="bsAddTeam()">+ Add</button></div>'+
      '</div>'+
      '<div id="bsTeamList"></div>'+
    '</div>'+
    '<div class="side-sec"><h3>👥 Rally Leaders</h3><div id="bsLeaderOverview"></div></div>';
}
function renderBsTeamList(){
  var el=document.getElementById('bsTeamList'); if(!el) return;
  bsEnsureTeamColors();
  if(!S.teams.length){ el.innerHTML='<div style="color:var(--text3);font-size:12px">No teams yet.</div>'; return; }
  el.innerHTML=S.teams.map(function(t){
    return '<div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">'+
      '<span style="width:10px;height:10px;border-radius:50%;background:'+t.color+';flex-shrink:0"></span>'+
      '<input value="'+(t.name||'').replace(/"/g,'&quot;')+'" onchange="bsRenameTeamInput(\\''+t.id+'\\',this.value)" style="flex:1;font-size:12px;padding:4px 7px">'+
      '<span onclick="bsDeleteTeam(\\''+t.id+'\\')" style="cursor:pointer;color:var(--text3);font-size:14px;padding:6px 8px" title="Remove team">✕</span>'+
    '</div>';
  }).join('');
}
function bsRenameTeamInput(teamId, val){
  var t=S.teams.find(function(x){return x.id===teamId;}); if(!t) return;
  var name=(val||'').trim(); if(!name) return;
  t.name=name; t.customName=true; renderBattleStrategy(); if(typeof renderSetup==='function') renderSetup(); syncQueuePush();
  toast('Team renamed');
}
function bsOnDrop(e,slotType,slotId){
  e.preventDefault();
  document.querySelectorAll('.bs-slot,.bs-team-zone,#bsLeaderPool').forEach(z=>z.classList.remove('drag-over'));
  if(!bsDragLeaderId) return;
  const l=S.leaders.find(x=>x.id===bsDragLeaderId); if(!l) return;

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

// ── Auto team names: "Leader1 & Leader2 & Leader3", unless manually renamed (customName) ──
function bsAutoNameTeams(){
  let changed=false;
  S.teams.forEach(function(t){
    if(t.customName) return;
    const members=S.leaders.filter(function(l){return l.bsSlot&&l.bsSlot.slotType==='team'&&l.bsSlot.slotId===t.id;});
    if(!members.length) return;
    const auto=members.map(function(l){return l.name;}).join(' & ');
    if(t.name!==auto){ t.name=auto; changed=true; }
  });
  if(changed && typeof syncQueuePush==='function') syncQueuePush();
}

function renderBattleStrategy(){
  // init bsSlot
  S.leaders.forEach(l=>{ if(!l.bsSlot) l.bsSlot={slotType:'pool',slotId:null}; });
  bsAutoNameTeams();

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
      const occupants=S.leaders.filter(l=>l.bsSlot&&l.bsSlot.slotType==='turret'&&l.bsSlot.slotId===i);
      return \`<div>
        <div class="bs-slot-label">🗼 \${t.name}</div>
        <div class="bs-slot" style="display:flex;flex-direction:column;gap:8px">
          \${occupants.length?occupants.map(o=>bsLeaderCardHTML(o)).join(''):'<div style="color:var(--text3);font-size:11px;text-align:center;padding:6px 0">No leaders yet.</div>'}
          <button class="btn btn-ghost btn-sm" style="width:100%;font-size:11px" onclick="bsOpenAddModal('turret',\${i})">+ Add leader</button>
        </div>
      </div>\`;
    }).join('');
  }

  renderBsAllianceZones();

  // ── POOL (unassigned leaders) ──
  const poolEl=document.getElementById('bsLeaderPool');
  if(poolEl){
    const poolLeaders=S.leaders.filter(l=>l.bsSlot&&l.bsSlot.slotType==='pool');
    poolEl.innerHTML=poolLeaders.length?poolLeaders.map(l=>bsLeaderCardHTML(l)).join(''):'<div style="color:var(--text3);font-size:12px">No unassigned leaders. Add new ones with a Player ID in the "Add Rally Leader" panel.</div>';
  }

bsRenderTeamButtons();
if(typeof renderPetPlans==='function') renderPetPlans();
  if(typeof renderBsSidebar==='function') renderBsSidebar();
  if(typeof renderBsAllianceList==='function') renderBsAllianceList();
  if(typeof renderBsTeamList==='function') renderBsTeamList();
  if(typeof renderBsLeaderOverview==='function') renderBsLeaderOverview();
}
renderBattleStrategy();

// ════════════ BATTLE STRATEGY — SHARED SETUP & FINAL CALCULATION ════════════
const BS_CALC = { offsetSec: null, selectedTeamId: null, frozen: null };

function bsTickClock(){
  const hh=document.getElementById('bsClockHH');
  if(!hh) return;
  const n=new Date();
  document.getElementById('bsClockHH').textContent=String(n.getUTCHours()).padStart(2,'0');
  document.getElementById('bsClockMM').textContent=String(n.getUTCMinutes()).padStart(2,'0');
  document.getElementById('bsClockSS').textContent=String(n.getUTCSeconds()).padStart(2,'0');
  // Live-recalculate launch times every second so they never show a past time.
  // If a copied schedule is frozen, show countdowns against it instead of re-sliding the times.
  if(BS_CALC.offsetSec!==null && BS_CALC.selectedTeamId!==null){
    if(BS_CALC.frozen && BS_CALC.frozen.teamId===BS_CALC.selectedTeamId) bsRenderFrozen();
    else bsCalcTeam(BS_CALC.selectedTeamId, BS_CALC.offsetSec, false);
  }
  var prev=document.getElementById('bsOffsetPreview');
  if(prev){
    if(BS_CALC.offsetSec!==null){
      var lbl=BS_CALC.offsetSec<60?BS_CALC.offsetSec+'s':Math.floor(BS_CALC.offsetSec/60)+'m';
      prev.textContent='Marker +'+lbl+' → first launch at '+s2hms(nowUTCSec()+BS_CALC.offsetSec)+' UTC';
    } else prev.textContent='';
  }
  if(typeof bsRenderStickyBar==='function') bsRenderStickyBar();
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

function bsClearOffsetHighlight(){
  document.querySelectorAll('#page-strategy [id^="bsOffsetBtn-"]').forEach(function(b){
    b.style.background=''; b.style.color=''; b.style.boxShadow=''; b.style.transform='';
  });
  var wrap=document.getElementById('bsCustomOffsetWrap');
  if(wrap){ wrap.style.borderColor='var(--border2)'; wrap.style.background='var(--bg3)'; }
}
function bsSetOffsetManual(){
  const el=document.getElementById('bsOffsetManual'); if(!el) return;
  const v=parseInt(el.value,10);
  if(isNaN(v)||v<0){ toast('Enter seconds (0 or more)'); return; }
  BS_CALC.offsetSec=v;
  bsClearOffsetHighlight();
  var wrap=document.getElementById('bsCustomOffsetWrap');
  if(wrap){ wrap.style.borderColor='var(--gold)'; wrap.style.background='rgba(217,166,72,.15)'; }
  if(BS_CALC.selectedTeamId!==null) bsCalcTeam(BS_CALC.selectedTeamId, v, true);
  else toast('Offset set to '+(v<60?v+'s':Math.floor(v/60)+'m'+(v%60?' '+(v%60)+'s':''))+' — now click a team');
}
function bsSetOffset(sec){
  BS_CALC.offsetSec=sec;
  BS_CALC.frozen=null;
  bsClearOffsetHighlight();
  var btn=document.getElementById('bsOffsetBtn-'+sec);
  if(btn){ btn.style.background='var(--gold)'; btn.style.color='#1a1206'; btn.style.boxShadow='0 0 0 3px rgba(217,166,72,.35)'; }
  if(BS_CALC.selectedTeamId!==null) bsCalcTeam(BS_CALC.selectedTeamId, sec, true);
  else toast(\`Offset set to +\${sec<60?sec+'s':Math.floor(sec/60)+'m'} — now click a team\`);
}

// Per-team rally state (transient, not synced — driven by the land timer in the rally flow)
let bsTeamRally = {};
function bsTeamRallying(id){ return !!(bsTeamRally[id] && bsTeamRally[id].landEnd && bsTeamRally[id].landEnd>Date.now()); }
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
    const rallying=bsTeamRallying(t.id);
    const dot='<span class="team-dot '+(rallying?'rallying':'free')+'"></span>';
    let meta='<span style="opacity:.6;font-size:11px">('+leaderCount+')</span>';
    if(rallying){ const rem=(bsTeamRally[t.id].landEnd-Date.now())/1000; meta='<span class="mono" style="color:#ff7070;font-size:12px;margin-left:2px">lands '+bsFmtLand(rem)+'</span>'; }
    return \`<button class="btn \${allianceColor}" style="\${selected}" onclick="bsSelectTeam('\${t.id}')">\${dot}\${t.name} \${meta}</button>\`;
  }).join('');
}
function bsSelectTeam(teamId){
  if(BS_CALC.frozen && BS_CALC.frozen.teamId!==teamId) BS_CALC.frozen=null;
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
    <div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;color:var(--text);margin-bottom:10px">\${header}</div>
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
  <button class="btn btn-gold" style="margin-top:10px" onclick="bsCopyTeamResult('\${t.id}')">📋 Copy for in-game chat</button><span id="bsCopyMsg" style="margin-left:10px;font-size:12px;font-weight:600"></span>\`;

  t._bsLastCalc={header,results,dur,landSec,maxMarch};
  // Show the persistent quick-copy button above the result

  if(logToast) toast(\`\${t.name} — rally times calculated!\`);
  if(logToast && window.innerWidth<=900){
    var _r=document.getElementById('bsFinalResult');
    if(_r && _r.scrollIntoView) _r.scrollIntoView({behavior:'smooth',block:'nearest'});
  }
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
  copyText(lines.join('\\n'), true).then(function(){ bsCopyFeedback(true); }).catch(function(){ bsCopyFeedback(false); });
  
  // Start (or reset) this team's land timer: rally duration + longest march + marker (= selected offset)
  const dur=t._bsLastCalc.dur||300, mm=t._bsLastCalc.maxMarch||0, mk=(BS_CALC.offsetSec!=null?BS_CALC.offsetSec:0);
  bsTeamRally[teamId]={landEnd:Date.now()+(dur+mm+mk)*1000};
  // Freeze the copied schedule so the screen matches what was pasted in chat,
  // and switch the result panel to live per-leader launch countdowns.
  BS_CALC.frozen={teamId:teamId, results:results.map(function(r){ return {name:r.name, march:r.march, launchSec:r.launchSec, _fired:false}; })};
  bsRenderFrozen();
  if(typeof bsRenderTeamButtons==='function') bsRenderTeamButtons();
}
// ── Team color dot (matches the leader-card accent) ──
function bsTeamColorDot(teamId){
  if(typeof bsEnsureTeamColors==='function') bsEnsureTeamColors();
  var t=S.teams.find(function(x){return x.id===teamId;});
  if(!t||!t.color) return '';
  return '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:'+t.color+';flex-shrink:0;margin-right:2px"></span>';
}

// ── Frozen (copied) schedule with live per-leader launch countdowns ──
function bsRenderFrozen(){
  var f=BS_CALC.frozen; if(!f) return;
  var el=document.getElementById('bsFinalResult'); if(!el) return;
  var t=S.teams.find(function(x){return x.id===f.teamId;});
  var now=nowUTCSec();
  var rows=f.results.map(function(r){
    var rem=r.launchSec-now;
    var st, cls='';
    if(rem>10){ st='<span class="mono" style="color:var(--text2);font-size:13px">in '+rem+'s</span>'; }
    else if(rem>0){ cls=' bs-launch-soon'; st='<span class="mono" style="color:#ff7070;font-size:14px;font-weight:700">in '+rem+'s</span>'; }
    else {
      cls=' bs-launch-go'; st='<span style="color:var(--green);font-size:13px;font-weight:700">GO!</span>';
      if(!r._fired){ r._fired=true; if(navigator.vibrate){ try{ navigator.vibrate([200,100,200]); }catch(e){} } }
    }
    return '<div class="copy-line'+cls+'" style="margin-bottom:5px;display:flex;justify-content:space-between;align-items:center">'+
      '<span><strong style="color:var(--text)">'+r.name+'</strong>'+
      '<span style="color:var(--text3);margin:0 8px">|</span>'+
      '<span class="mono" style="color:var(--gold);font-size:16px">'+s2hms(r.launchSec)+'</span>'+
      '<span style="color:var(--text3);font-size:11px;margin-left:8px">(march '+r.march+'s)</span></span>'+st+'</div>';
  }).join('');
  el.innerHTML='<div style="background:var(--bg4);border:1px solid var(--border);border-radius:6px;padding:14px 16px">'+
    '<div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;color:var(--text);margin-bottom:10px">'+(t?t.name:'')+
    '<span style="color:var(--gold);font-size:11px;font-weight:600">● LOCKED — copied schedule</span></div>'+rows+
    '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'+
    '<button class="btn btn-gold btn-sm" onclick="bsCopyTeamResult(&quot;'+f.teamId+'&quot;)">📋 Copy again</button>'+
    '<span id="bsCopyMsg" style="font-size:12px;font-weight:600"></span></div></div>';
}
function bsUnfreezeSchedule(){
  BS_CALC.frozen=null;
  if(BS_CALC.selectedTeamId!==null && BS_CALC.offsetSec!==null) bsCalcTeam(BS_CALC.selectedTeamId, BS_CALC.offsetSec, false);
}

// ── Collapsible "How to use" card (state remembered) ──
function bsToggleHowTo(){
  var body=document.getElementById('bsHowToBody');
  var chev=document.getElementById('bsHowToChevron');
  if(!body) return;
  var collapsed = body.style.display==='none';
  body.style.display = collapsed ? '' : 'none';
  if(chev) chev.textContent = collapsed ? String.fromCharCode(9660) : String.fromCharCode(9654);
  try{ localStorage.setItem('bsHowToCollapsed', collapsed ? '0' : '1'); }catch(e){}
}
(function(){
  try{
    if(localStorage.getItem('bsHowToCollapsed')==='1'){
      var body=document.getElementById('bsHowToBody');
      var chev=document.getElementById('bsHowToChevron');
      if(body) body.style.display='none';
      if(chev) chev.textContent=String.fromCharCode(9654);
    }
  }catch(e){}
})();

// ── Mobile sticky quick bar: current team + offset + copy, pinned at the bottom ──
function bsRenderStickyBar(){
  var bar=document.getElementById('bsStickyBar'); if(!bar) return;
  var pg=document.getElementById('page-strategy');
  var show = pg && pg.classList.contains('active') && window.innerWidth<=900 && BS_CALC.selectedTeamId!==null && BS_CALC.offsetSec!==null;
  bar.style.display = show ? 'flex' : 'none';
  if(!show) return;
  var t=S.teams.find(function(x){return x.id===BS_CALC.selectedTeamId;});
  var info=document.getElementById('bsStickyInfo'); if(!info) return;
  var lbl=BS_CALC.offsetSec<60?BS_CALC.offsetSec+'s':Math.floor(BS_CALC.offsetSec/60)+'m';
  var txt=(t?t.name:'')+' +'+lbl;
  if(BS_CALC.frozen && BS_CALC.frozen.teamId===BS_CALC.selectedTeamId){
    var now=nowUTCSec(); var next=null;
    BS_CALC.frozen.results.forEach(function(r){ var rem=r.launchSec-now; if(rem>0 && (next===null||rem<next)) next=rem; });
    txt += next!==null ? ' — next launch in '+next+'s' : ' — all launched';
  }
  info.textContent=txt;
}

function bsCopyFeedback(ok){
  const el=document.getElementById('bsCopyMsg'); if(!el) return;
  el.textContent=ok?'Copied ✓':'Copy failed ✗';
  el.style.color=ok?'var(--green)':'#ff7070';
  clearTimeout(el._t); el._t=setTimeout(function(){ el.textContent=''; },2000);
}
function bsFmtLand(sec){ sec=Math.max(0,Math.ceil(sec)); if(sec>=60){ const m=Math.floor(sec/60), s=sec%60; return m+':'+String(s).padStart(2,'0'); } return sec+'s'; }
function bsTickRally(){
  const now=Date.now(); let changed=false;
  Object.keys(bsTeamRally).forEach(function(id){ if(bsTeamRally[id]&&bsTeamRally[id].landEnd&&bsTeamRally[id].landEnd<=now){ delete bsTeamRally[id]; changed=true; } });
  if(changed || Object.keys(bsTeamRally).length){ if(typeof bsRenderTeamButtons==='function') bsRenderTeamButtons(); }
}
setInterval(bsTickRally,1000);

// ════════════ MINISTER SPOTS ════════════
const MS_CATEGORIES = ['general','training','construction','research'];
const MS_CATEGORY_LABELS = {general:'General Speedup',training:'Soldier Training Speedup',construction:'Construction Speedup',research:'Research Speedup'};
const MS_CATEGORY_ICONS = {general:'⏱️',training:'⚔️',construction:'🏗️',research:'🔬'};
const MS_TOTAL_SLOTS = 48;
const MS_MIN_SLOTS_PICKED = 4;
const MS_POSITION_ID = 'noble_advisor_day4';
const MS_RANK_CATEGORY = 'training'; // Noble Advisor ranks by Training hours only

// ── 3-BOARD MINISTER SPOTS ──
const MS_BOARDS = ['buildings','research','troops'];
const MS_BOARD_META = {
  buildings: { label:'Construction', icon:'🏛️', color:'#6ab0ff', unit:'pts', blurb:'Construction speedups + TrueGold', cats:['construction','general'], hasTG:true },
  research:  { label:'Research',  icon:'🔬', color:'#c084fc', unit:'pts', blurb:'Research speedups + TrueGold Dust', cats:['research','general'], hasDust:true },
  troops:    { label:'Troops',    icon:'⚔️', color:'#f5b833', unit:'h',   blurb:'Training speedups', cats:['training','general'] }
};
const MS_PTS = { perMin: 30, truegold: 2000, dust: 1000 }; // 1 min speedup = 30pts; 1 TG = 2000; 1 Dust = 1000
// commit c = { construction, research, training, general (all in MINUTES), truegold, dust (counts) }
// returns the board's ranking score: points for buildings/research, minutes for troops (hours = /60)
function msBoardScore(board, c){
  c = c || {};
  if(board==='buildings') return (c.construction||0)*MS_PTS.perMin + (c.general||0)*MS_PTS.perMin + (c.truegold||0)*MS_PTS.truegold;
  if(board==='research')  return (c.research||0)*MS_PTS.perMin + (c.general||0)*MS_PTS.perMin + (c.dust||0)*MS_PTS.dust;
  if(board==='troops')    return (c.training||0) + (c.general||0); // minutes
  return 0;
}
function msBoardScoreLabel(board, score){
  if(board==='troops') return (score/60).toFixed(1)+'h';
  return score.toLocaleString()+' pts';
}


const MS_UNIT_TO_HOURS = { seconds:1/3600, minutes:1/60, hours:1, days:24 };

function msSlotLabel(i){
  const totalMin=i*30;
  const h=Math.floor(totalMin/60), m=totalMin%60;
  const h2=Math.floor((totalMin+30)/60)%24, m2=(totalMin+30)%60;
  return \`\${String(h).padStart(2,'0')}:\${String(m).padStart(2,'0')}-\${String(h2).padStart(2,'0')}:\${String(m2).padStart(2,'0')}\`;
}

// Slot label carrying the board's real calendar date, e.g. "13 Jul 2026, 14:00-14:30 UTC".
function msSlotDateTimeLabel(board, slotIdx){
  var s = msSchedule(Date.now());
  var dStart = (s.boards[board] ? s.boards[board].dayStart : s.day1);
  return fmtUTCDate(dStart)+', '+msSlotLabel(slotIdx)+' UTC';
}

// One row of the KvK schedule strip.  tone: 'done' | 'open' | 'closed'
function msSchedChip(icon, label, val, tone){
  var col = tone==='done' ? 'var(--green)' : (tone==='closed' ? '#ff8080' : '#ff9d4d');
  var bg  = tone==='done' ? 'rgba(46,204,113,.08)' : (tone==='closed' ? 'rgba(224,58,58,.08)' : 'rgba(255,157,77,.08)');
  var bd  = tone==='done' ? 'rgba(46,204,113,.3)' : (tone==='closed' ? 'rgba(224,58,58,.3)' : 'rgba(255,157,77,.3)');
  return '<div style="display:flex;align-items:center;gap:10px;background:'+bg+';border:1px solid '+bd+';border-radius:7px;padding:8px 12px">'+
    '<span style="font-size:15px;width:20px;text-align:center">'+icon+'</span>'+
    '<span style="flex:1;font-size:12px;color:var(--text2)">'+label+'</span>'+
    '<span class="mono" style="font-size:12px;font-weight:600;color:'+col+'">'+val+'</span>'+
  '</div>';
}
// Read-only KvK schedule on the Minister page — same per-board design as Manage Spots,
// embedded subtly in the intro card. All times UTC.
function msRenderScheduleStrip(){
  var el = document.getElementById('msScheduleStrip'); if(!el) return;
  var blocks = (typeof msBoardTimerBlocksHTML==='function') ? msBoardTimerBlocksHTML() : '';
  if(!blocks){ el.style.display='none'; return; }
  var now = Date.now(), openMsg = '';
  try{
    var s = msSchedule(now);
    if(now >= s.openAt && now < s.boards.buildings.deadline) openMsg = '<span style="color:var(--green);font-weight:600">✅ Submissions are open</span> · ';
  }catch(e){}
  el.style.display = 'block';
  el.innerHTML =
    '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">'+openMsg+'🗓️ KvK Schedule — all times UTC</div>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap">'+blocks+'</div>';
}

function msInit(){
  if(typeof msRenderScheduleStrip==='function') msRenderScheduleStrip();
  if(MS._unlockedStep===undefined) MS._unlockedStep=1;
  const pid = verifiedPlayer ? String(verifiedPlayer.id) : null;
  // Restore the member's OWN submission for display only.
  // A local copy must NEVER re-add itself to the shared submissions —
  // otherwise an admin "Clear all" gets undone when members sign back in.
  // The shared backend (synced state) is the single source of truth.
  if(pid && !MS._submittedEntry) {
    const fromState = MS.submissions.find(s => String(s.playerId) === pid);
    if(fromState) {
      MS._submittedEntry = fromState;
      lsSet('ms_submitted_' + pid, fromState);
    } else {
      const staleLocal = lsGet('ms_submitted_' + pid);
      if(staleLocal) { lsClear('ms_submitted_' + pid); }
      MS._submittedEntry = null;
    }
  }
  
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
  // If member has existing submission, show overview directly (same for R4/R5 — their
  // only extra capability is the separate Manage Spots tab, not a different landing flow)
  if(MS._submittedEntry && !MS._editing) {
    const tab0 = document.getElementById('msStepTab0');
    if(tab0) tab0.style.display = '';
    msGoStep(0);
    msRenderOverview(MS._submittedEntry);
    msRenderStepTabs();
    msUpdateDeadlineBanners();
    return;
  }
  // Restore an unfinished draft (survives refresh/navigation; expires after 7 days)
  if(!MS._submittedEntry && !MS._editing && !(MS.draft && MS.draft.boards && MS.draft.boards.length) && !MS._draftRestoreTried){
    MS._draftRestoreTried = true;
    const _saved = pid ? lsGet('ms_draft_' + pid) : null;
    if(_saved && _saved.draft && _saved.draft.boards && _saved.draft.boards.length && (Date.now() - (_saved.ts||0)) < 7*86400000){
      MS.draft = _saved.draft;
      MS._unlockedStep = _saved.unlocked || 1;
      MS._currentStep = _saved.step || 1;
      MS._completedSteps = _saved.completed || [];
      toast('Draft restored — continuing where you left off ✓');
    }
  }
  // Board-pick gate: applying fresh must choose boards first — identical for R4/R5
  if(!MS._editing && !(MS.draft && MS.draft.boards && MS.draft.boards.length)){
    msShowBoardPick();
    msRenderStepTabs();
    msUpdateDeadlineBanners();
    return;
  }
  msGoStep(MS._currentStep||1);
  msRenderVerifyGrid();
  msRenderSliderGrid();
  msRenderSlotGrid();
  msRenderResultsSummary();
  msRenderStepTabs();
  msUpdateDeadlineBanners();
}

function msSaveDraft(){
  try {
    const pid = verifiedPlayer ? String(verifiedPlayer.id) : 'anon';
    lsSet('ms_draft_' + pid, { draft: MS.draft, unlocked: MS._unlockedStep||1, step: MS._currentStep||1, completed: MS._completedSteps||[], ts: Date.now() });
  } catch(e) {}
}
function msMarkStepComplete(n){
  MS._unlockedStep=Math.max(MS._unlockedStep||1, n+1);
  MS._completedSteps=MS._completedSteps||[];
  if(MS._completedSteps.indexOf(n)<0) MS._completedSteps.push(n);
  msRenderStepTabs();
  msSaveDraft();
}

function msRenderStepTabs(){
  const isR4 = msCanAccessResults();
  const hasSubmission = !!MS._submittedEntry;
  const hasBoards = !!(MS.draft && MS.draft.boards && MS.draft.boards.length);
  // Until minister spots are picked (Step 1), the later steps stay locked.
  const unlocked = hasSubmission ? 0 : (hasBoards ? (MS._unlockedStep||1) : 0);
  const tabA = document.getElementById('msStepTabA');
  if(tabA){
    const doneA = hasBoards || hasSubmission;
    tabA.textContent = (doneA?'✓ ':'')+'1. Apply';
    if(doneA && !tabA.classList.contains('active')) tabA.style.color='var(--green)';
    else tabA.style.color='';
  }

  // Step 0 (overview) - shown whenever the person has submitted, same for everyone
  const tab0 = document.getElementById('msStepTab0');
  if(tab0) tab0.style.display = hasSubmission ? '' : 'none';

  // Step 5 (Manage Spots) - the one extra capability R4/R5 has over regular members
  const tab5 = document.getElementById('msStepTab5');
  if(tab5) tab5.style.display = isR4 ? '' : 'none';

  const baseLabels={1:'2. Upload',2:'3. Verify',3:'4. Commitment',4:'5. Timeslots & Submit'};
  for(let i=1;i<=4;i++){
    const tab=document.getElementById('msStepTab'+i);
    if(!tab) continue;
    const isLocked=i>unlocked;
    tab.disabled=isLocked;
    tab.style.opacity=isLocked?'0.4':'1';
    tab.style.cursor=isLocked?'not-allowed':'pointer';
    tab.title=isLocked?'Complete the previous step first':'';
    const done=(MS._completedSteps||[]).indexOf(i)>=0;
    tab.textContent=(done?'✓ ':'')+baseLabels[i];
    if(done && !tab.classList.contains('active')) tab.style.color='var(--green)';
    else if(!isLocked) tab.style.color='';
  }
}

function msGoStep(n){
  const isR4 = msCanAccessResults();
  const hasSubmission = !!MS._submittedEntry;
const unlocked = (hasSubmission && !MS._editing) ? 0 : (MS._unlockedStep||1);

  // Block step 5 for non-R4/R5 — the one extra capability R4/R5 has over regular members
  if(n===5 && !isR4){ toast('Results are only visible to R4/R5.'); return; }
  // If they've submitted, steps 1-4 are locked (must click Edit) — same for everyone
if(hasSubmission && !MS._editing && n>=1 && n<=4){ toast('Click "Edit my submission" to make changes.'); n=0; }
  // Step 1 (Apply) comes first: no wizard steps until minister spots are picked
  if(n>=1 && n<=4 && !hasSubmission && !(MS.draft && MS.draft.boards && MS.draft.boards.length)){
    toast('Step 1 first — pick which minister spots you are applying for.');
    msShowBoardPick();
    return;
  }
  // Normal step lock — same for everyone
  if(n>1 && n>unlocked && !hasSubmission){ toast('Please complete the previous step first.'); n=unlocked; }

  MS._currentStep=n;
  var _bpEl=document.getElementById('msBoardPick'); if(_bpEl) _bpEl.style.display='none';
  var _taEl=document.getElementById('msStepTabA'); if(_taEl) _taEl.classList.remove('active');
  // Show/hide step panels (0-5)
  for(let i=0;i<=5;i++){
    const el=document.getElementById('msStep'+i);
    const tab=document.getElementById('msStepTab'+i);
    if(el) el.style.display=(i===n)?'block':'none';
    if(tab) tab.classList.toggle('active', i===n);
  }
  if(n===2) msRenderVerifyGrid();
  if(n===3) msRenderSliderGrid();
  if(n===4) msRenderSlotGrid();
  if(n===5){
    var _bp=document.getElementById('msBoardPick'); if(_bp) _bp.style.display='none';
    var _s5=document.getElementById('msStep5'); if(_s5) _s5.style.display='block';
    msRenderResultsSummary(); msInitResultsTab(); if(typeof msShowManagePanel==='function') msShowManagePanel();
  }
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
      var z=document.getElementById('msUploadZone');
      if(z){
        var fn=String(file.name||'screenshot').replace(/[<>&"]/g,'');
        z.innerHTML='<div style="font-size:20px">✅</div><div style="font-size:13px;color:var(--green);font-weight:600;margin-top:4px">'+fn+'</div><div style="font-size:11px;color:var(--text3);margin-top:2px">Tap to choose a different screenshot</div>';
        z.style.borderColor='var(--green)';
      }
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
  if(!msUploadedImageData){ toast('Upload a screenshot first, or tap "Skip — enter manually".'); return; }
  MS.draft.alliance=alliance; MS.draft.ign=ign;

  const statusEl=document.getElementById('msOCRStatus');
  const pctEl=document.getElementById('msOCRPct');
  const barEl=document.getElementById('msOCRBar');
  const wrapEl=document.getElementById('msOCRProgressWrap');
  const btnEl=document.getElementById('msScanBtn');

  wrapEl.style.display='block';
  statusEl.textContent='🤖 Reading screenshot with AI…'; statusEl.style.color='var(--text2)';
  pctEl.textContent=''; barEl.style.width='60%';
  btnEl.disabled=true; btnEl.style.opacity='0.5'; btnEl.style.cursor='not-allowed';

  try {
    // ── PRIMARY: Cloudflare Workers AI Vision ──
    // Convert image file to base64
const base64 = msUploadedImageData.split(',')[1];

    const res = await fetch('/ocr-speedups', {
      method: 'POST',
      headers: (typeof stateHeaders==='function' ? stateHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ image: base64 })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.values) {
        // AI returned clean values — fill them directly
        const { general, training, construction, research } = data.values;
        const vals = [general, training, construction, research];
        MS_CATEGORIES.forEach((cat, idx) => {
          const h = vals[idx] || 0;
          MS.draft.verify[cat] = {
            amount: Math.round(h * 100) / 100,
            unit: 'hours', hours: h,
            ocrAmount: Math.round(h * 100) / 100,
            ocrRaw: 'AI Vision'
          };
        });
        statusEl.textContent = '✅ AI scan complete — review the results below';
        statusEl.style.color = 'var(--green)';
        pctEl.textContent = '100%'; barEl.style.width = '100%';
        btnEl.disabled=false; btnEl.style.opacity='1'; btnEl.style.cursor='pointer';
        msMarkStepComplete(1);
        msGoStep(2);
        return;
      }
    }

    // ── FALLBACK: Tesseract.js ──
    statusEl.textContent = 'AI unavailable — falling back to local OCR…';
    await msRunOCRTesseract(statusEl, pctEl, barEl);

  } catch(err) {
    // ── FALLBACK on network error ──
    console.warn('AI OCR failed, falling back to Tesseract:', err.message);
    statusEl.textContent = 'Falling back to local OCR…';
    try {
      await msRunOCRTesseract(statusEl, pctEl, barEl);
    } catch(err2) {
      statusEl.textContent = '⚠ OCR failed — please enter values manually on the next step';
      statusEl.style.color = '#ff7070';
      barEl.style.background = 'var(--enemy)';
      MS_CATEGORIES.forEach(c => { if(!MS.draft.verify[c]) MS.draft.verify[c]={amount:0,unit:'hours',hours:0,ocrAmount:null,ocrRaw:null}; });
    }
  }

  btnEl.disabled=false; btnEl.style.opacity='1'; btnEl.style.cursor='pointer';
  msMarkStepComplete(1);
  msGoStep(2);
}

// Lazy-load Tesseract.js only when OCR fallback is actually needed (saves ~2MB on every page load)
function ensureTesseract(){
  if (typeof Tesseract !== 'undefined') return Promise.resolve();
  if (window._tessLoading) return window._tessLoading;
  window._tessLoading = new Promise(function(resolve){
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js';
    s.onload = function(){ resolve(); };
    s.onerror = function(){
      var s2 = document.createElement('script');
      s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js';
      s2.onload = function(){ resolve(); };
      s2.onerror = function(){ resolve(); };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
  return window._tessLoading;
}

async function msRunOCRTesseract(statusEl, pctEl, barEl) {
  await ensureTesseract();
  if(typeof Tesseract==='undefined'){
    statusEl.textContent='⚠ OCR engine not available — please enter values manually';
    statusEl.style.color='#ff7070';
    MS_CATEGORIES.forEach(c=>{ if(!MS.draft.verify[c]) MS.draft.verify[c]={amount:0,unit:'hours',hours:0,ocrAmount:null,ocrRaw:null}; });
    return;
  }
  const stageLabels={
    'loading tesseract core':'Loading OCR engine…',
    'initializing tesseract':'Initializing…',
    'loading language traineddata':'Loading language data…',
    'initializing api':'Preparing scan…',
    'recognizing text':'Reading screenshot…'
  };
  const worker=await Tesseract.createWorker({
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@4.0.4',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    logger: m => {
      if(m.status){
        const label=stageLabels[m.status]||m.status;
        const pct=Math.round((m.progress||0)*100);
        statusEl.textContent=label;
        if(pctEl) pctEl.textContent=pct+'%';
        if(barEl) barEl.style.width=pct+'%';
      }
    }
  });
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  statusEl.textContent = 'Pre-processing image…';
  const processedBlob = await msPreprocessImage(msUploadedImageData);
  const result=await worker.recognize(processedBlob || msUploadedImageData);
  await worker.terminate();
  msParseOCRText(result.data.text||'');
  statusEl.textContent='✓ Scan complete — review the results below';
  statusEl.style.color='var(--green)';
  if(pctEl) pctEl.textContent='100%';
  if(barEl) barEl.style.width='100%';
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
  // Smart merge: join continuation lines that are just time units (possibly with noise)
  // e.g. "min(s)" or "eacip min(s)" or ")peedup min(s)" → join to previous line
  const UNIT_ONLY = /^[^0-9]{0,20}(?:min|hr|day|sec)[^0-9]{0,10}$/i;
  const rawLines = text.split(/\\n/);
  const lines = [];
  rawLines.forEach(line => {
    line = line.trim();
    if (!line) return;
    if (lines.length && UNIT_ONLY.test(line)) {
      lines[lines.length-1] = lines[lines.length-1] + ' ' + line;
    } else { lines.push(line); }
  });

  function normalizeOCR(s) {
    s = s.replace(/(\\d),(\\d{3})/g, '$1$2');
    s = s.replace(/(\\d),(\\d{3})/g, '$1$2');
    // Fix I/l/! → 1 when used as a digit
    s = s.replace(/\\bI\\b(?=\\s*[a-zA-Z\\(])/g, '1');
    s = s.replace(/(\\d)I(?=\\s)/g, '$11');
    s = s.replace(/(\\d)!(?=\\s)/g, '$11');
    s = s.replace(/\\)!/g, ')1');              // "day(s)! hr" → "day(s)1 hr"
    s = s.replace(/!(?=\\s*(?:hr|min|day))/gi, '1'); // "! hr(s)" → "1 hr(s)"
    return s;
  }

  function parseDurationToHours(s) {
    s = normalizeOCR(s);
    let total = 0, matched = false;
    // Match: number followed by optional noise (up to 15 chars) then a time unit word
    // This handles "49 eacip min(s)" → 49 minutes, and "26 day(s)20 hr(s)49 min(s)"
    const re = /(\\d+(?:\\.\\d+)?)\\s*[^0-9]{0,15}?(day\\(?s?\\)?|hr\\(?s?\\)?|hour|min\\(?s?\\)?|minute|sec\\(?s?\\)?)/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = parseFloat(m[1]);
      const u = m[2].toLowerCase();
      if (/^d/.test(u))      { total += n*24; matched = true; }
      else if (/^h/.test(u)) { total += n;    matched = true; }
      else if (/^m/.test(u)) { total += n/60; matched = true; }
      else if (/^s/.test(u)) { total += n/3600; matched = true; }
    }
    return matched ? total : null;
  }

  const BOUNDARY = /learning|soldier\\s*heal|healing/i;
  const blocks = [];
  for (const line of lines) {
    if (BOUNDARY.test(line)) break;
    const h = parseDurationToHours(line);
    if (h !== null && h > 0 && h < 100000) blocks.push(h);
  }

  MS_CATEGORIES.forEach((cat, idx) => {
    if (idx < blocks.length) {
      const hours = blocks[idx];
      MS.draft.verify[cat] = { amount: Math.round(hours*100)/100, unit:'hours', hours, ocrAmount: Math.round(hours*100)/100, ocrRaw:'' };
    } else {
      MS.draft.verify[cat] = { amount:0, unit:'hours', hours:0, ocrAmount:null, ocrRaw:null };
    }
  });
}

// Pre-process image with Canvas: crop right 65% and middle 50% vertically
// This strips phone UI chrome, social overlays (Snapchat etc), and category label column
async function msPreprocessImage(file) {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const x1 = Math.floor(W * 0.35);
      const y1 = Math.floor(H * 0.33);
      const y2 = Math.floor(H * 0.82);
      const canvas = document.createElement('canvas');
      canvas.width = W - x1; canvas.height = y2 - y1;
      const ctx = canvas.getContext('2d');
      ctx.filter = 'contrast(180%) saturate(0%)';
      ctx.drawImage(img, -x1, -y1);
      canvas.toBlob(blob => resolve(blob), 'image/png');
    };
    img.src = URL.createObjectURL(file);
  });
}

// ── STEP 2: VERIFY ──
function msActiveCats(){
  var boards=(MS.draft&&MS.draft.boards&&MS.draft.boards.length)?MS.draft.boards:MS_BOARDS;
  var set={};
  boards.forEach(function(b){ (MS_BOARD_META[b]&&MS_BOARD_META[b].cats||[]).forEach(function(c){ set[c]=1; }); });
  return MS_CATEGORIES.filter(function(c){ return set[c]; });
}
function msShowBoardPick(){
  MS.draft = MS.draft || {alliance:'',ign:'',verify:{},commit:{},picks:[],boards:[]};
  MS.draft.boards = MS.draft.boards || [];
  // The Apply step lives INSIDE the wizard now — keep the step tabs visible so
  // R4/R5/Admin can always reach 👑 Manage Spots without filling out the form.
  var pt=document.querySelector('#page-minister .phase-tabs'); if(pt) pt.style.display='';
  document.querySelectorAll('#page-minister .ms-step').forEach(function(el){ el.style.display='none'; });
  var bp=document.getElementById('msBoardPick'); if(bp) bp.style.display='block';
  document.querySelectorAll('#page-minister .ms-step-tab').forEach(function(t){ t.classList.remove('active'); });
  var ta=document.getElementById('msStepTabA'); if(ta) ta.classList.add('active');
  msRenderBoardPick();
  if(typeof msRenderStepTabs==='function') msRenderStepTabs();
}
function msRenderBoardPick(){
  var el=document.getElementById('msBoardPickGrid'); if(!el) return;
  MS.draft.boards = MS.draft.boards || [];
  // Can't apply fresh to a board whose deadline already passed — drop any that slipped in.
  MS.draft.boards = MS.draft.boards.filter(function(b){ return !msBoardClosed(b); });
  el.innerHTML=MS_BOARDS.map(function(b){
    var m=MS_BOARD_META[b]; var on=MS.draft.boards.indexOf(b)>=0;
    if(msBoardClosed(b)){
      var dd=msBoardDeadline(b);
      return '<div style="opacity:.55;cursor:not-allowed;border:2px solid var(--border);background:var(--bg3);border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:12px">'+
        '<div style="font-size:26px;filter:grayscale(1)">'+m.icon+'</div>'+
        '<div style="flex:1"><div style="font-family:var(--head);font-weight:600;font-size:16px;color:var(--text3)">'+m.label+'</div><div style="font-size:12px;color:var(--text3)">🔒 Closed'+(dd?' — deadline '+fmtUTCDateTime(dd):'')+'</div></div>'+
        '<div style="font-size:13px;color:#ff8080">closed</div>'+
      '</div>';
    }
    return '<div onclick="msToggleBoardPick('+"'"+b+"'"+')" style="cursor:pointer;border:2px solid '+(on?m.color:'var(--border)')+';background:'+(on?'rgba(201,165,92,.06)':'var(--bg3)')+';border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:12px">'+
      '<div style="font-size:26px">'+m.icon+'</div>'+
      '<div style="flex:1"><div style="font-family:var(--head);font-weight:600;font-size:16px;color:'+(on?m.color:'var(--text)')+'">'+m.label+'</div><div style="font-size:12px;color:var(--text3)">'+m.blurb+'</div></div>'+
      '<div style="font-size:18px;color:'+(on?m.color:'var(--text3)')+'">'+(on?'✓':'○')+'</div>'+
    '</div>';
  }).join('');
}
function msToggleBoardPick(b){
  if(msBoardClosed(b)){ toast('That minister spot is closed.'); return; }
  MS.draft = MS.draft || {}; MS.draft.boards = MS.draft.boards || [];
  var i=MS.draft.boards.indexOf(b);
  if(i>=0) MS.draft.boards.splice(i,1); else MS.draft.boards.push(b);
  msRenderBoardPick();
}
function msBoardPickContinue(){
  var picked=((MS.draft&&MS.draft.boards)?MS.draft.boards:[]).filter(function(b){ return !msBoardClosed(b); });
  if(!picked.length){ toast('Pick at least one open minister spot'); return; }
  MS.draft.boards = picked;
  var bp=document.getElementById('msBoardPick'); if(bp) bp.style.display='none';
  var pt=document.querySelector('#page-minister .phase-tabs'); if(pt) pt.style.display='';
  msGoStep(1);
}
function msGoApply(){
  if(MS._submittedEntry && !MS._editing){ toast('Click "Edit my submission" to make changes.'); msGoStep(0); return; }
  msShowBoardPick();
}
// Manage Spots opens directly for R4/R5/Admin — it must NEVER be gated behind picking
// boards or completing the signup, since leaders use it without applying themselves.
function msOpenManage(){
  if(!msCanAccessResults()){ toast('Manage Spots is for R4/R5 and Admin.'); return; }
  var bp=document.getElementById('msBoardPick'); if(bp) bp.style.display='none';
  var pt=document.querySelector('#page-minister .phase-tabs'); if(pt) pt.style.display='';
  MS._currentStep=5;
  for(var i=0;i<=5;i++){
    var el=document.getElementById('msStep'+i);
    if(el) el.style.display=(i===5)?'block':'none';
  }
  document.querySelectorAll('#page-minister .ms-step-tab').forEach(function(t){ t.classList.remove('active'); });
  var t5=document.getElementById('msStepTab5'); if(t5) t5.classList.add('active');
  msRenderResultsSummary(); msInitResultsTab();
  if(typeof msShowManagePanel==='function') msShowManagePanel();
  msRenderStepTabs();
}
function msChangeBoards(){ msGoApply(); }
function msRenderVerifyGrid(){
  const grid=document.getElementById('msVerifyGrid'); if(!grid) return;
  const CATS=msActiveCats();
  CATS.forEach(c=>{ if(!MS.draft.verify[c]) MS.draft.verify[c]={amount:0,unit:'hours',hours:0,ocrAmount:null,ocrRaw:null}; });
  grid.innerHTML=CATS.map(cat=>{
    const v=MS.draft.verify[cat];
    const flagged=v.ocrAmount!==null && v.amount>0 && Math.abs(v.amount-v.ocrAmount)/Math.max(v.ocrAmount,1)>0.2;
    return \`<div class="ms-verify-field">
    <label>\${MS_CATEGORY_ICONS[cat]} \${MS_CATEGORY_LABELS[cat]}</label>
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
  // ── TrueGold / TrueGold Dust inventory (only for boards that use them) ──
  var _vb=(MS.draft&&MS.draft.boards)?MS.draft.boards:[];
  var _vx='';
  if(_vb.indexOf('buildings')>=0) _vx+='<div class="ms-verify-field"><label>🟨 TrueGold (you own)</label>'+
    '<div style="display:flex;gap:6px;align-items:center"><input type="number" min="0" value="'+(MS.draft.tgOwned||0)+'" style="width:90px" id="msVerifyTG" oninput="msUpdateTGOwned(this.value)"><span style="font-size:12px;color:var(--text3)">pieces</span></div>'+
    '<div style="margin-top:6px;font-size:11px;color:var(--text3)">Worth <span class="mono" style="color:var(--gold)">2,000 pts</span> each on the Construction board.</div></div>';
  if(_vb.indexOf('research')>=0) _vx+='<div class="ms-verify-field"><label>🔺 TrueGold Dust (you own)</label>'+
    '<div style="display:flex;gap:6px;align-items:center"><input type="number" min="0" value="'+(MS.draft.dustOwned||0)+'" style="width:90px" id="msVerifyDust" oninput="msUpdateDustOwned(this.value)"><span style="font-size:12px;color:var(--text3)">pieces</span></div>'+
    '<div style="margin-top:6px;font-size:11px;color:var(--text3)">Worth <span class="mono" style="color:var(--gold)">1,000 pts</span> each on the Research board.</div></div>';
  if(_vx) grid.innerHTML += _vx;
}
function msUpdateVerify(cat){
  clearTimeout(window._msDraftT); window._msDraftT = setTimeout(msSaveDraft, 400);
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
  grid.innerHTML=msActiveCats().map(cat=>{
    const hours=MS.draft.verify[cat]?MS.draft.verify[cat].hours:0;
    const pct=MS.draft.commit[cat]!==undefined?MS.draft.commit[cat]:50;
    const committedHours=hours*pct/100;
    const committedDays=committedHours/24;
    return \`<div class="ms-slider-row">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <strong style="font-size:14px">\${MS_CATEGORY_ICONS[cat]} \${MS_CATEGORY_LABELS[cat]}</strong>
        <span style="font-size:12px;color:\${hours>0?'var(--text3)':'#ff9d4d'}">\${hours>0?hours.toFixed(1)+'h available':'0h — set this in Step 3 (Verify) first'}</span>
      </div>
      <input type="range" min="0" max="100" value="\${pct}" id="msSlider-\${cat}" oninput="msUpdateSlider('\${cat}')">
      <div style="display:flex;justify-content:space-between;font-size:12px">
        <span class="mono" style="color:var(--accent2)" id="msSliderPct-\${cat}">\${pct}%</span>
        <span class="mono" style="color:var(--gold)" id="msSliderDays-\${cat}">\${committedDays.toFixed(1)} days (\${committedHours.toFixed(1)}h)</span>
      </div>
    </div>\`;
  }).join('');
var _b=(MS.draft&&MS.draft.boards)?MS.draft.boards:[];
  var _extra='';
  if(_b.indexOf('buildings')>=0){
    var _tgOwn=(MS.draft.tgOwned||0);
    if(_tgOwn>0){
      var _tgPct=(MS.draft.tgPct!==undefined?MS.draft.tgPct:50);
      MS.draft.truegold=Math.round(_tgOwn*_tgPct/100);
      _extra+='<div class="ms-slider-row">'+
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><strong style="font-size:14px">🟨 TrueGold</strong><span style="font-size:12px;color:var(--text3)">'+_tgOwn+' available</span></div>'+
        '<input type="range" min="0" max="100" value="'+_tgPct+'" id="msSlider-tg" oninput="msUpdateTGPct(this.value)">'+
        '<div style="display:flex;justify-content:space-between;font-size:12px"><span class="mono" style="color:var(--accent2)" id="msSliderPct-tg">'+_tgPct+'%</span><span class="mono" style="color:var(--gold)" id="msSliderCnt-tg">'+MS.draft.truegold+' pieces ('+(MS.draft.truegold*2000).toLocaleString()+' pts)</span></div>'+
      '</div>';
    } else {
      _extra+='<div class="ms-slider-row" style="display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap"><strong style="font-size:14px">🟨 TrueGold to use</strong><span style="display:flex;align-items:center;gap:8px"><input type="number" min="0" value="'+(MS.draft.truegold||0)+'" style="width:100px" oninput="msUpdateTG(this.value)"><span style="font-size:11px;color:var(--text3)">tip: enter what you own in Step 3 (Verify) to get a slider</span></span></div>';
    }
  }
  if(_b.indexOf('research')>=0){
    var _dOwn=(MS.draft.dustOwned||0);
    if(_dOwn>0){
      var _dPct=(MS.draft.dustPct!==undefined?MS.draft.dustPct:50);
      MS.draft.dust=Math.round(_dOwn*_dPct/100);
      _extra+='<div class="ms-slider-row">'+
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><strong style="font-size:14px">🔺 TrueGold Dust</strong><span style="font-size:12px;color:var(--text3)">'+_dOwn+' available</span></div>'+
        '<input type="range" min="0" max="100" value="'+_dPct+'" id="msSlider-dust" oninput="msUpdateDustPct(this.value)">'+
        '<div style="display:flex;justify-content:space-between;font-size:12px"><span class="mono" style="color:var(--accent2)" id="msSliderPct-dust">'+_dPct+'%</span><span class="mono" style="color:var(--gold)" id="msSliderCnt-dust">'+MS.draft.dust+' pieces ('+(MS.draft.dust*1000).toLocaleString()+' pts)</span></div>'+
      '</div>';
    } else {
      _extra+='<div class="ms-slider-row" style="display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap"><strong style="font-size:14px">🔺 TrueGold Dust to use</strong><span style="display:flex;align-items:center;gap:8px"><input type="number" min="0" value="'+(MS.draft.dust||0)+'" style="width:100px" oninput="msUpdateDust(this.value)"><span style="font-size:11px;color:var(--text3)">tip: enter what you own in Step 3 (Verify) to get a slider</span></span></div>';
    }
  }
  if(_extra) grid.innerHTML += _extra;
  grid.innerHTML += '<div id="msGeneralSplitWrap" class="ms-slider-row" style="display:none;border-top:1px solid var(--border);padding-top:14px;margin-top:4px"></div>';
  if(typeof msRenderGeneralSplit==='function') msRenderGeneralSplit();
}
// ── General Speedup split (fixes double-counting when 2+ applied boards share "General Speedup") ──
function msGeneralSplitBoards(){
  return ((MS.draft&&MS.draft.boards)||[]).filter(function(b){ var m=MS_BOARD_META[b]; return m && m.cats && m.cats.indexOf('general')>=0; });
}
function msGeneralCommittedHours(){
  var hours = (MS.draft.verify && MS.draft.verify.general) ? MS.draft.verify.general.hours : 0;
  var pct = (MS.draft.commit && MS.draft.commit.general!==undefined) ? MS.draft.commit.general : 50;
  return hours*pct/100;
}
// Normalize the split so it ALWAYS sums exactly to the committed General hours — the same
// hour can never be counted toward two boards. Pass a boards array to normalize over a
// specific set (msSubmitEntry uses the open/frozen board list), otherwise the draft's.
function msNormalizeGeneralSplit(boardsOpt){
  var genBoards = boardsOpt || msGeneralSplitBoards();
  var committedH = msGeneralCommittedHours();
  MS.draft.generalSplit = MS.draft.generalSplit || {};
  var gs = {}, sum = 0;
  genBoards.forEach(function(b){ var v=parseFloat(MS.draft.generalSplit[b]); if(isNaN(v)||v<0)v=0; gs[b]=v; sum+=v; });
  if(genBoards.length){
    if(sum<=0){ var each=committedH/genBoards.length; genBoards.forEach(function(b){ gs[b]=each; }); }
    else if(Math.abs(sum-committedH)>0.001){ var f=committedH/sum; genBoards.forEach(function(b){ gs[b]=gs[b]*f; }); }
  }
  // Round to 0.1h and push the rounding remainder onto the largest share so the total stays exact.
  var rounded={}, rSum=0, maxB=null;
  genBoards.forEach(function(b){ rounded[b]=Math.round(gs[b]*10)/10; rSum+=rounded[b]; if(maxB===null||gs[b]>gs[maxB]) maxB=b; });
  if(maxB!==null){ rounded[maxB]=Math.round((rounded[maxB]+(committedH-rSum))*10)/10; if(rounded[maxB]<0) rounded[maxB]=0; }
  MS.draft.generalSplit = rounded;
  return rounded;
}
function msRenderGeneralSplit(){
  var host = document.getElementById('msGeneralSplitWrap'); if(!host) return;
  var genBoards = msGeneralSplitBoards();
  var committedH = msGeneralCommittedHours();
  if(genBoards.length<2 || committedH<=0){ host.style.display='none'; host.innerHTML=''; return; }
  msNormalizeGeneralSplit();
  host.style.display='block';
  var max = Math.round(committedH*10);
  var rows = genBoards.map(function(b){
    var m=MS_BOARD_META[b];
    return '<div style="margin-bottom:2px;display:flex;justify-content:space-between;font-size:12px"><span style="color:'+m.color+';font-weight:600">'+m.icon+' '+m.label+'</span><span class="mono" style="color:var(--gold)" id="msGenSplitVal-'+b+'"></span></div>'+
      '<input type="range" min="0" max="'+max+'" step="1" value="'+Math.round((MS.draft.generalSplit[b]||0)*10)+'" id="msGenSplitSlider-'+b+'" oninput="msSetGeneralSplit('+"'"+b+"'"+',this.value/10)" style="margin-bottom:10px">';
  }).join('');
  host.innerHTML =
    '<div style="display:flex;justify-content:space-between;margin-bottom:4px"><strong style="font-size:14px">⏱️ Where does your General Speedup go?</strong><span class="mono" style="font-size:12px;color:var(--gold)" id="msGenSplitTotal"></span></div>'+
    '<div style="font-size:11.5px;color:var(--text3);margin-bottom:10px">You applied for '+genBoards.length+' boards that can use General Speedup. Slide to divide your committed hours between them — the split always adds up automatically, so the same hours are never counted toward two boards.</div>'+
    rows+
    '<button class="btn btn-ghost btn-sm" onclick="msSplitGeneralEvenly()">⚖️ Split evenly</button>';
  msUpdateGeneralSplitLabels();
}
function msUpdateGeneralSplitLabels(){
  var genBoards = msGeneralSplitBoards();
  var committedH = msGeneralCommittedHours();
  genBoards.forEach(function(b){
    var h=(MS.draft.generalSplit||{})[b]||0;
    var pct=committedH>0?Math.round(h/committedH*100):0;
    var vEl=document.getElementById('msGenSplitVal-'+b); if(vEl) vEl.textContent=h.toFixed(1)+'h ('+pct+'%)';
    var sEl=document.getElementById('msGenSplitSlider-'+b); if(sEl && document.activeElement!==sEl) sEl.value=Math.round(h*10);
  });
  var tEl=document.getElementById('msGenSplitTotal'); if(tEl) tEl.textContent=committedH.toFixed(1)+'h committed';
}
// Move one board's share; the other boards automatically absorb the difference so the
// total always equals the committed hours — over-budget or unassigned states cannot exist.
function msSetGeneralSplit(board, val){
  clearTimeout(window._msDraftT); window._msDraftT = setTimeout(msSaveDraft, 400);
  var genBoards = msGeneralSplitBoards();
  var committedH = msGeneralCommittedHours();
  var v = Math.round((parseFloat(val)||0)*10)/10; if(v<0) v=0; if(v>committedH) v=Math.round(committedH*10)/10;
  MS.draft.generalSplit = MS.draft.generalSplit || {};
  MS.draft.generalSplit[board]=v;
  var others = genBoards.filter(function(b){ return b!==board; });
  var rest = Math.max(0, committedH - v);
  var oSum = others.reduce(function(a,b){ return a+(parseFloat(MS.draft.generalSplit[b])||0); },0);
  var acc = 0;
  others.forEach(function(b, idx){
    var share;
    if(idx===others.length-1) share = rest-acc;
    else if(oSum>0) share = Math.round((parseFloat(MS.draft.generalSplit[b])||0)/oSum*rest*10)/10;
    else share = Math.round(rest/others.length*10)/10;
    if(share<0) share=0;
    MS.draft.generalSplit[b]=Math.round(share*10)/10;
    acc+=MS.draft.generalSplit[b];
  });
  msUpdateGeneralSplitLabels();
}
function msSplitGeneralEvenly(){
  clearTimeout(window._msDraftT); window._msDraftT = setTimeout(msSaveDraft, 400);
  MS.draft.generalSplit = {};
  msNormalizeGeneralSplit();
  msRenderGeneralSplit();
}
function msUpdateTG(v){ clearTimeout(window._msDraftT); window._msDraftT=setTimeout(msSaveDraft,400); MS.draft=MS.draft||{}; var n=parseInt(v,10); if(isNaN(n)||n<0)n=0; var mx=MS.draft.tgOwned||0; if(mx>0&&n>mx)n=mx; MS.draft.truegold=n; }
function msUpdateDust(v){ clearTimeout(window._msDraftT); window._msDraftT=setTimeout(msSaveDraft,400); MS.draft=MS.draft||{}; var n=parseInt(v,10); MS.draft.dust=(isNaN(n)||n<0)?0:n; }
function msUpdateDustPct(v){
  clearTimeout(window._msDraftT); window._msDraftT=setTimeout(msSaveDraft,400);
  MS.draft=MS.draft||{}; var p=parseInt(v,10); if(isNaN(p)||p<0)p=0; if(p>100)p=100;
  MS.draft.dustPct=p;
  MS.draft.dust=Math.round((MS.draft.dustOwned||0)*p/100);
  var a=document.getElementById('msSliderPct-dust'); if(a)a.textContent=p+'%';
  var b=document.getElementById('msSliderCnt-dust'); if(b)b.textContent=MS.draft.dust+' pieces ('+(MS.draft.dust*1000).toLocaleString()+' pts)';
}
function msUpdateTGPct(v){
  clearTimeout(window._msDraftT); window._msDraftT=setTimeout(msSaveDraft,400);
  MS.draft=MS.draft||{}; var p=parseInt(v,10); if(isNaN(p)||p<0)p=0; if(p>100)p=100;
  MS.draft.tgPct=p;
  MS.draft.truegold=Math.round((MS.draft.tgOwned||0)*p/100);
  var a=document.getElementById('msSliderPct-tg'); if(a)a.textContent=p+'%';
  var b=document.getElementById('msSliderCnt-tg'); if(b)b.textContent=MS.draft.truegold+' pieces ('+(MS.draft.truegold*2000).toLocaleString()+' pts)';
}
function msUpdateTGOwned(v){ clearTimeout(window._msDraftT); window._msDraftT=setTimeout(msSaveDraft,400); MS.draft=MS.draft||{}; var n=parseInt(v,10); MS.draft.tgOwned=(isNaN(n)||n<0)?0:n; if(MS.draft.tgOwned>0) MS.draft.truegold=Math.round(MS.draft.tgOwned*((MS.draft.tgPct!==undefined?MS.draft.tgPct:50))/100); }
function msUpdateDustOwned(v){ clearTimeout(window._msDraftT); window._msDraftT=setTimeout(msSaveDraft,400); MS.draft=MS.draft||{}; var n=parseInt(v,10); MS.draft.dustOwned=(isNaN(n)||n<0)?0:n; if(MS.draft.dustOwned>0) MS.draft.dust=Math.round(MS.draft.dustOwned*((MS.draft.dustPct!==undefined?MS.draft.dustPct:50))/100); }
function msUpdateSlider(cat){
  clearTimeout(window._msDraftT); window._msDraftT = setTimeout(msSaveDraft, 400);
  const pct=parseInt(document.getElementById('msSlider-'+cat).value);
  MS.draft.commit[cat]=pct;
  const hours=MS.draft.verify[cat]?MS.draft.verify[cat].hours:0;
  const committedHours=hours*pct/100;
  document.getElementById('msSliderPct-'+cat).textContent=pct+'%';
  document.getElementById('msSliderDays-'+cat).textContent=(committedHours/24).toFixed(1)+' days ('+committedHours.toFixed(1)+'h)';
  if(cat==='general' && typeof msRenderGeneralSplit==='function') msRenderGeneralSplit();
}

// ── STEP 4: TIMESLOTS ──
function msAppliedBoardsList(){ var b=(MS.draft&&MS.draft.boards&&MS.draft.boards.length)?MS.draft.boards:MS_BOARDS; return b.slice(); }
function msActiveBoard(){ MS.draft=MS.draft||{}; var b=msAppliedBoardsList(); if(!MS.draft._activeBoard||b.indexOf(MS.draft._activeBoard)<0) MS.draft._activeBoard=b[0]; return MS.draft._activeBoard; }
function msPicks(){ MS.draft.picksByBoard=MS.draft.picksByBoard||{}; var ab=msActiveBoard(); if(!MS.draft.picksByBoard[ab]) MS.draft.picksByBoard[ab]=[]; return MS.draft.picksByBoard[ab]; }
function msFavs(){ MS.draft.favByBoard=MS.draft.favByBoard||{}; var ab=msActiveBoard(); if(!MS.draft.favByBoard[ab]) MS.draft.favByBoard[ab]=[]; return MS.draft.favByBoard[ab]; }
// Every board has its own timeslot selection — "apply to all" was removed so slots are
// always chosen per board. The empty sync keeps old call sites harmless and force-clears
// the flag on drafts saved before this change.
function msApplyAllSync(){ if(MS.draft) MS.draft.applyAll=false; }
function msSwitchBoard(b){ MS.draft._activeBoard=b; msRenderSlotGrid(); }
function msToggleApplyAll(){ msApplyAllSync(); msRenderSlotGrid(); }
function msRenderBoardSwitcher(){
  if(MS.draft) MS.draft.applyAll=false;
  var el=document.getElementById('msBoardSwitcher'); if(!el) return;
  var boards=msAppliedBoardsList(), ab=msActiveBoard();
  var hint=document.getElementById('msPerBoardHint'); if(hint) hint.style.display=(boards.length<2?'none':'block');
  if(boards.length<2){ el.style.display='none'; return; }
  el.style.display='flex';
  el.innerHTML=boards.map(function(b){ var m=MS_BOARD_META[b]; var on=b===ab;
    var picked=((MS.draft.picksByBoard||{})[b]||[]).length;
    var badge=msBoardClosed(b)?' 🔒':(picked>=MS_MIN_SLOTS_PICKED?' ✓':(' ('+picked+'/'+MS_MIN_SLOTS_PICKED+')'));
    return '<button class="btn btn-sm'+(on?'':' btn-ghost')+'" onclick="msSwitchBoard('+"'"+b+"'"+')" style="'+(on?'border-color:'+m.color+';color:'+m.color:'')+'">'+m.icon+' '+m.label+badge+'</button>';
  }).join('');
}
function msRenderSignupSummary(){
  var el=document.getElementById('msSignupSummary'); if(!el) return;
  var rows=msActiveCats().map(function(c){
    var v=MS.draft.verify[c]?MS.draft.verify[c].hours:0;
    var pct=MS.draft.commit[c]!==undefined?MS.draft.commit[c]:50;
    var committed=v*pct/100, left=v-committed;
    return '<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span style="color:var(--text2)">'+MS_CATEGORY_ICONS[c]+' '+MS_CATEGORY_LABELS[c]+'</span><span class="mono"><span style="color:var(--gold)">'+committed.toFixed(1)+'h</span> committed · <span style="color:var(--text3)">'+left.toFixed(1)+'h left</span></span></div>';
  }).join('');
  var b=msAppliedBoardsList();
  if(b.indexOf('buildings')>=0) rows+='<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span style="color:var(--text2)">🟨 TrueGold</span><span class="mono" style="color:var(--gold)">'+(MS.draft.truegold||0)+'</span></div>';
  if(b.indexOf('research')>=0) rows+='<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span style="color:var(--text2)">🔺 TrueGold Dust</span><span class="mono" style="color:var(--gold)">'+(MS.draft.dust||0)+'</span></div>';
  el.innerHTML='<div style="font-size:11px;color:var(--text3);margin-bottom:6px;font-weight:600">Your commitment</div>'+rows;
}
function msRenderSlotGrid(){
  const grid=document.getElementById('msSlotGrid'); if(!grid) return;
  // Locked board (deadline passed): show frozen picks read-only, no interaction.
  var _ab = msActiveBoard();
  if(msBoardClosed(_ab)){
    var _m = MS_BOARD_META[_ab] || {label:_ab, icon:''};
    var _dd = msBoardDeadline(_ab);
    var _src = (MS._submittedEntry && MS._submittedEntry.picksByBoard && MS._submittedEntry.picksByBoard[_ab]) || (MS.draft.picksByBoard && MS.draft.picksByBoard[_ab]) || [];
    var _frozen = _src.slice().sort(function(a,b){ return a-b; });
    var _chips = _frozen.length
      ? _frozen.map(function(i){ return '<span class="mono" style="display:inline-block;background:var(--bg4);border:1px solid var(--border2);border-radius:5px;padding:4px 8px;margin:3px;font-size:11px;color:var(--text2)">'+msSlotLabel(i)+'</span>'; }).join('')
      : '<span style="color:var(--text3);font-size:12px">No timeslots on record for this board.</span>';
    grid.innerHTML =
      '<div style="background:rgba(224,58,58,.08);border:1px solid rgba(224,58,58,.35);border-radius:8px;padding:12px 14px;margin-bottom:12px">'+
        '<div style="font-weight:600;color:#ff8080">🔒 '+_m.icon+' '+_m.label+' is closed'+(_dd?' — deadline '+fmtUTCDateTime(_dd):'')+'</div>'+
        '<div style="font-size:12px;color:var(--text2);margin-top:4px">This board is locked and can no longer be changed. Use the switcher above to edit any boards that are still open.</div>'+
      '</div>'+
      '<div style="font-size:11px;color:var(--text3);margin-bottom:4px">Your locked timeslots for '+_m.label+':</div>'+
      '<div>'+_chips+'</div>';
    if(typeof msRenderBoardSwitcher==='function') msRenderBoardSwitcher();
    if(typeof msRenderSignupSummary==='function') msRenderSignupSummary();
    return;
  }
  const takenSlots=new Set();

// Flexibility-weighted demand: each player contributes 1 / (slots they picked).
  // Someone who picked only 4 slots pushes hard (0.25 each); someone who picked
  // 24 barely registers (0.04 each). So a slot only "heats up" when constrained
  // players cluster on it — not just when many flexible people list it.
  const weighted = new Array(MS_TOTAL_SLOTS).fill(0);
  MS.submissions.forEach(sub => {
    const picks = sub.picks || [];
    const w = picks.length > 0 ? (1 / picks.length) : 0;
    picks.forEach(p => { weighted[p] += w; });
  });

  // Map a weighted score to a colour band + honest label.
  // Thresholds are tuned for a kingdom with contested slots; easy to adjust.
  function band(score){
    if(score <= 0)    return {bg:'var(--bg4)', fg:'var(--text2)', bd:'1px solid var(--border)', label:'free'};
    if(score < 0.75)  return {bg:'#97C459', fg:'#173404', bd:'1px solid #639922', label:'wide open'};
    if(score < 1.75)  return {bg:'#EF9F27', fg:'#412402', bd:'1px solid #BA7517', label:'some interest'};
    return {bg:'#E24B4A', fg:'#fff', bd:'1px solid #A32D2D', label:'high demand'};
  }

  const groups=[
    {label:'· 00:00–06:00 UTC', start:0, end:12},
    {label:'· 06:00–12:00 UTC', start:12, end:24},
    {label:'· 12:00–18:00 UTC', start:24, end:36},
    {label:'· 18:00–24:00 UTC', start:36, end:48}
  ];

grid.innerHTML = groups.map(g=>{
    const cells = Array.from({length:g.end-g.start},(_,k)=>{
      const i=g.start+k;
      const selected=msPicks().includes(i);
      const taken=takenSlots.has(i)&&!selected;
      const score=weighted[i];
      let bg,fg,bd,sub;
      if(selected){ const c=band(score); bg='var(--accent)'; fg='#fff'; bd='1px solid var(--accent2)'; sub='you · '+c.label; }
      else if(taken){ bg='rgba(120,120,120,.25)'; fg='var(--text3)'; bd='1px solid var(--border)'; sub='taken'; }
      else { const c=band(score); bg=c.bg; fg=c.fg; bd=c.bd; sub=c.label; }
      const click = taken ? '' : 'onclick="msTogglePick('+i+')"';
      const isFav = msFavs().includes(i);
      const starBtn = selected ? '<span onclick="msToggleFav('+i+',event)" style="position:absolute;top:2px;right:4px;font-size:13px;cursor:pointer;line-height:1" title="Star as favourite">'+(isFav?'⭐':'☆')+'</span>' : '';
      return '<button class="ms-slot-btn" '+click+' style="position:relative;padding:10px 3px;border-radius:6px;font-family:var(--mono);font-size:13px;line-height:1.35;cursor:'+(taken?'not-allowed':'pointer')+';background:'+bg+';color:'+fg+';border:'+bd+';text-align:center">'+starBtn+msSlotLabel(i)+'<br><span style="font-size:11px;opacity:.85">'+sub+'</span></button>';
    }).join('');
    return '<div style="font-size:14px;font-weight:700;color:var(--gold);margin:16px 0 8px;letter-spacing:.05em;border-bottom:1px solid var(--border);padding-bottom:5px">'+g.label+'</div>'+
           '<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px">'+cells+'</div>';
  }).join('');
  msUpdateSlotCount();
  msRenderBoardSwitcher();
  msRenderSignupSummary();
  const trainingHours=(MS.draft.verify.training?MS.draft.verify.training.hours:0)*((MS.draft.commit.training!==undefined?MS.draft.commit.training:50)/100);
  const elH=document.getElementById('msYourTrainingHours'); if(elH) elH.textContent=trainingHours.toFixed(1)+'h';

msFillRangeDropdowns();
}

function msSelectRange(){
  const fromSel=document.getElementById('msRangeFrom'), toSel=document.getElementById('msRangeTo');
  let a=parseInt(fromSel.value,10), b=parseInt(toSel.value,10);
  if(isNaN(a)||isNaN(b)) return;
  if(b<a){ const t=a; a=b; b=t; }
  const P=msPicks();
  for(let i=a;i<=b;i++){ if(!P.includes(i)) P.push(i); }
  msApplyAllSync();
  msRenderSlotGrid();
}

function msClearPicks(){
  const P=msPicks(); P.length=0;
  const F=msFavs(); F.length=0;
  msApplyAllSync();
  msRenderSlotGrid();
}

function msTogglePick(i){
  clearTimeout(window._msDraftT); window._msDraftT = setTimeout(msSaveDraft, 400);
  const P=msPicks();
  const idx=P.indexOf(i);
  if(idx>=0){
    P.splice(idx,1);
    const F=msFavs(); const fi=F.indexOf(i); if(fi>=0) F.splice(fi,1);
  } else {
    P.push(i);
  }
  msApplyAllSync();
  msRenderSlotGrid();
}

function msToggleFav(i, ev){
  if(ev){ ev.stopPropagation(); }
  if(!msPicks().includes(i)) return;
  const F=msFavs();
  const f=F.indexOf(i);
  if(f>=0){ F.splice(f,1); }
  else {
    if(F.length>=2){ toast('You can star up to 2 favourites. Un-star one first.'); return; }
    F.push(i);
  }
  msApplyAllSync();
  msRenderSlotGrid();
}

function msUpdateSlotCount(){
  const el=document.getElementById('msSlotPickCount'); if(!el) return;
  const n=msPicks().length;
  el.textContent=n+' slot'+(n===1?'':'s')+' selected '+(n<MS_MIN_SLOTS_PICKED?'(need at least '+MS_MIN_SLOTS_PICKED+')':'✓');
  el.style.color=n<MS_MIN_SLOTS_PICKED?'#ff9d4d':'var(--green)';
  msUpdateSubmitState();
}
function msUpdateSubmitState(){
  var btn=document.getElementById('msSubmitBtn');
  var hint=document.getElementById('msSubmitHint');
  if(!btn) return;
  var boards=(typeof msAppliedBoardsList==='function')?msAppliedBoardsList():[];
  if(!boards.length){ btn.disabled=false; btn.style.opacity='1'; if(hint) hint.textContent=''; return; }
  var open=boards.filter(function(b){ return !msBoardClosed(b); });
  if(!open.length){
    btn.disabled=true; btn.style.opacity='0.5';
    if(hint){ hint.style.color='#ff7070'; hint.textContent='🔒 All boards you applied for are closed — submissions are locked.'; }
    return;
  }
  btn.disabled=false; btn.style.opacity='1';
  var pbb=MS.draft.picksByBoard||{}; var short=[];
  open.forEach(function(b){
    var nn=(pbb[b]||[]).length;
    if(nn<MS_MIN_SLOTS_PICKED){ var m=MS_BOARD_META[b]; short.push((m?m.label:b)+': pick '+(MS_MIN_SLOTS_PICKED-nn)+' more'); }
  });
  if(hint){
    if(short.length){ hint.style.color='#ff9d4d'; hint.textContent='⏳ '+short.join(' · '); }
    else { hint.style.color='var(--green)'; hint.textContent='✓ Ready to submit'; }
  }
}

function msFillRangeDropdowns(){
  try {
    const fromSel=document.getElementById('msRangeFrom'), toSel=document.getElementById('msRangeTo');
    if(!fromSel || !toSel) return;
    if(fromSel.options.length) return;
    for(let i=0;i<MS_TOTAL_SLOTS;i++){
      const h=Math.floor((i*30)/60), m=(i*30)%60;
      const t=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
      fromSel.add(new Option(t,i));
      toSel.add(new Option(t,i));
    }
    fromSel.value=14; toSel.value=44;
  } catch(e){ console.error('msFillRangeDropdowns failed:', e); }
}

// ── Deadline management ──
function msGetDeadline() {
  try { return MS.deadline ? new Date(MS.deadline) : null; } catch(e) { return null; }
}
function msIsDeadlinePassed() {
  const d = msGetDeadline();
  return d ? Date.now() > d.getTime() : false;
}
// ── Per-board deadlines (Phase 2) ──
// Effective deadline (epoch ms) for a board: an admin's manual global override wins if set,
// otherwise the computed schedule deadline (36h01m before that board's KvK day).
function msBoardDeadline(board){
  var man = null;
  try { man = MS.deadline ? new Date(MS.deadline).getTime() : null; } catch(e){ man = null; }
  if(man!=null && !isNaN(man)) return man;
  try { var bs = msSchedule(Date.now()).boards[board]; return bs ? bs.deadline : null; } catch(e){ return null; }
}
function msBoardClosed(board){
  var d = msBoardDeadline(board);
  return (d!=null) ? Date.now() >= d : false;
}
function msOpenBoardsList(list){ return (list||MS_BOARDS).filter(function(b){ return !msBoardClosed(b); }); }
function msClosedBoardsList(list){ return (list||MS_BOARDS).filter(function(b){ return msBoardClosed(b); }); }
function msAnyBoardOpen(list){ return msOpenBoardsList(list).length>0; }
function msSetDeadline() {
  const input = document.getElementById('msDeadlineInput');
  if (!input || !input.value) { toast('Pick a date and time first.'); return; }
  const iso = new Date(input.value).toISOString();
  if (!confirm('⚠️ This overrides the computed per-board schedule and closes ALL 3 boards (Construction, Research, Troops) at once, at '+new Date(iso).toUTCString()+'.\\n\\nMembers will immediately see their open boards as locked once this time passes. Continue?')) return;
  // datetime-local gives local time — store as UTC ISO string
  MS.deadline = iso;
  syncQueuePush();
  msUpdateDeadlineBanners();
  toast('Deadline set: ' + new Date(MS.deadline).toUTCString());
}
function msReopenSubmissions() {
  if (!confirm('⚠️ Reopen submissions for ALL boards? This clears the manual deadline override and returns each board to its normal computed deadline (or fully open if that has also passed). Continue?')) return;
  MS.deadline = null;
  syncQueuePush();
  msUpdateDeadlineBanners();
  toast('Submissions reopened.');
}
function msUpdateDeadlineBanners() {
  if(typeof msUpdateSubmitState==='function') msUpdateSubmitState();
  var applied = msAppliedBoardsList();
  var openB = msOpenBoardsList(applied);
  var closedB = msClosedBoardsList(applied);
  var lbl = function(b){ var mm=MS_BOARD_META[b]; return (mm?mm.icon+' '+mm.label:b); };
  // Member banner (Step 4) — status of the board currently being edited
  var memberBanner = document.getElementById('msDeadlineBanner');
  var submitBtn = document.getElementById('msSubmitBtn');
  if (memberBanner) {
    var ab = msActiveBoard();
    var m = MS_BOARD_META[ab] || {label:ab, icon:''};
    var dd = msBoardDeadline(ab);
    if (msBoardClosed(ab)) {
      memberBanner.style.display = 'block';
      memberBanner.innerHTML = '<div style="background:rgba(224,58,58,.1);border:1px solid rgba(224,58,58,.4);border-radius:7px;padding:10px 14px;color:var(--enemy)">🔒 '+m.icon+' '+m.label+' submissions are closed'+(dd?' (deadline '+fmtUTCDateTime(dd)+')':'')+'. This board is locked — your other open boards can still be edited.</div>';
    } else if (dd) {
      memberBanner.style.display = 'block';
      memberBanner.innerHTML = '<div style="background:rgba(255,157,77,.08);border:1px solid rgba(255,157,77,.3);border-radius:7px;padding:10px 14px;font-size:12px;color:#ff9d4d">⏰ '+m.icon+' '+m.label+' closes: <strong>'+fmtUTCDateTime(dd)+'</strong></div>';
    } else {
      memberBanner.style.display = 'none';
    }
    if (submitBtn) {
      var allClosed = openB.length===0;
      submitBtn.disabled = allClosed;
      submitBtn.style.opacity = allClosed ? '0.4' : '';
    }
  }
  // Admin banner (Step 5) — which boards are open vs closed
  var adminBanner = document.getElementById('msDeadlineAdminBanner');
  if (adminBanner) {
    if (closedB.length) {
      adminBanner.style.display = 'block';
      adminBanner.innerHTML = '<strong style="color:#ff9d4d">⏰ Board status</strong> — Closed: '+(closedB.map(lbl).join(', ')||'none')+' · Open: '+(openB.map(lbl).join(', ')||'none');
    } else {
      adminBanner.style.display = 'none';
    }
  }
  // Pre-fill the manual (global override) deadline input if one is set
  var dlInput = document.getElementById('msDeadlineInput');
  var man = null; try { man = MS.deadline ? new Date(MS.deadline) : null; } catch(e){ man = null; }
  if (dlInput && man) {
    var local = new Date(man.getTime() - man.getTimezoneOffset()*60000).toISOString().slice(0,16);
    dlInput.value = local;
  }
}

function msSubmitEntry(){
  var _prev = MS._submittedEntry || null;
  var _applied = msAppliedBoardsList();
  // A board counts for this entry if it's still open, OR it's already closed but has a frozen
  // result from a previous submission (which we preserve). Closed boards with no history are dropped.
  var _boards = _applied.filter(function(b){ return !msBoardClosed(b) || (_prev && _prev.scores && _prev.scores[b]!==undefined); });
  if(!_boards.length){ toast('All the minister spots you applied for are closed.'); return; }
  var _pbb=MS.draft.picksByBoard||{};
  // Only open boards need fresh valid picks; closed boards reuse their frozen picks.
  var _openForCheck = _boards.filter(function(b){ return !msBoardClosed(b); });
for(var _bi=0;_bi<_openForCheck.length;_bi++){
    var _bp=_pbb[_openForCheck[_bi]]||[];
    if(_bp.length<MS_MIN_SLOTS_PICKED){
      toast('Pick at least '+MS_MIN_SLOTS_PICKED+' timeslots for '+(MS_BOARD_META[_openForCheck[_bi]]?MS_BOARD_META[_openForCheck[_bi]].label:_openForCheck[_bi])+'.');
      if(typeof msSwitchBoard==='function') msSwitchBoard(_openForCheck[_bi]);
      msUpdateSubmitState();
      return;
    }
  }
// Automatic double-count prevention: normalize the split so it sums EXACTLY to the
  // committed General hours — the same hour can never score points on two boards.
  var _genBoards = _boards.filter(function(b){ var m=MS_BOARD_META[b]; return m && m.cats && m.cats.indexOf('general')>=0; });
  if(_genBoards.length>=2 && typeof msNormalizeGeneralSplit==='function') msNormalizeGeneralSplit(_genBoards);

  const committedHours={};
  MS_CATEGORIES.forEach(cat=>{
    const hours=MS.draft.verify[cat]?MS.draft.verify[cat].hours:0;
    const pct=MS.draft.commit[cat]!==undefined?MS.draft.commit[cat]:50;
    committedHours[cat]=hours*pct/100;
  });

  const pid = verifiedPlayer ? String(verifiedPlayer.id) : null;
  const entry={
    id: uid(),
    playerId: pid,
    alliance: MS.draft.alliance,
    ign: MS.draft.ign,
    verify: JSON.parse(JSON.stringify(MS.draft.verify)),
    commit: JSON.parse(JSON.stringify(MS.draft.commit)),
    picks: (function(){ var u={}; _boards.forEach(function(b){ (_pbb[b]||[]).forEach(function(s){ u[s]=1; }); }); return Object.keys(u).map(Number).sort(function(a,b){return a-b;}); })(),
    picksByBoard: JSON.parse(JSON.stringify(_pbb)),
    favByBoard: JSON.parse(JSON.stringify(MS.draft.favByBoard||{})),
    favourites: [...(MS.draft.favourites||[])],
    committedHours,
    boards: _boards.slice(),
    truegold: MS.draft.truegold||0,
    dust: MS.draft.dust||0,
    tgOwned: MS.draft.tgOwned||0,
    dustOwned: MS.draft.dustOwned||0,
    dustPct: (MS.draft.dustPct!==undefined?MS.draft.dustPct:50),
    tgPct: (MS.draft.tgPct!==undefined?MS.draft.tgPct:50),
    generalSplit: (_genBoards.length>=2) ? JSON.parse(JSON.stringify(MS.draft.generalSplit||{})) : null,
    scores: (function(){
      var splitMode = _genBoards.length>=2;
      var gSplit = MS.draft.generalSplit||{};
      var s={};
      _boards.forEach(function(b){
        var gHours = splitMode ? (parseFloat(gSplit[b])||0) : (committedHours.general||0);
        var cm={construction:(committedHours.construction||0)*60,research:(committedHours.research||0)*60,training:(committedHours.training||0)*60,general:gHours*60,truegold:MS.draft.truegold||0,dust:MS.draft.dust||0};
        s[b]=msBoardScore(b,cm);
      });
      return s;
    })(),
submittedAt: new Date().toISOString()
  };

  // ── Freeze: any closed board keeps its previous frozen contribution unchanged ──
  if(_prev){
    _boards.forEach(function(b){
      if(!msBoardClosed(b)) return;
      if(_prev.scores && _prev.scores[b]!==undefined) entry.scores[b] = _prev.scores[b];
      if(_prev.picksByBoard && _prev.picksByBoard[b]) entry.picksByBoard[b] = _prev.picksByBoard[b].slice();
      if(_prev.favByBoard && _prev.favByBoard[b]) entry.favByBoard[b] = _prev.favByBoard[b].slice();
      // Troops allocation ranks on committedHours.training, so freeze that too.
      if(b==='troops' && _prev.committedHours && _prev.committedHours.training!==undefined) entry.committedHours.training = _prev.committedHours.training;
    });
    // Rebuild the flat picks union after restoring frozen boards
    entry.picks = (function(){ var u={}; _boards.forEach(function(b){ (entry.picksByBoard[b]||[]).forEach(function(s){ u[s]=1; }); }); return Object.keys(u).map(Number).sort(function(a,b){return a-b;}); })();
  }
  entry.frozenBoards = _boards.filter(function(b){ return msBoardClosed(b); });

  // Store keyed by Player ID if available, otherwise by IGN
  if(pid) {
    MS.submissionsByPlayer = MS.submissionsByPlayer || {};
    MS.submissionsByPlayer[pid] = entry;
    // Keep submissions array in sync (for allocation)
    MS.submissions = Object.values(MS.submissionsByPlayer);
  } else {
    MS.submissions = MS.submissions.filter(s => !(s.alliance===entry.alliance && s.ign===entry.ign));
    MS.submissions.push(entry);
  }

  // Save to localStorage so it survives navigation
  if(pid) {
    lsSet('ms_submitted_' + pid, entry);
    lsClear('ms_draft_' + pid);
  }

  syncQueuePush();
  toast('Entry submitted! ✅');

  // Show overview tab
  msShowOverview(entry);
}

function msShowOverview(entry) {
  // Show overview tab, hide steps 1-4
  const tab0 = document.getElementById('msStepTab0');
  if(tab0) tab0.style.display = '';
  MS._submittedEntry = entry;
  MS._editing = false;
  MS._unlockedStep = 0; // lock steps 1-4
  msGoStep(0);
  msRenderOverview(entry);
}

function msRenderOverview(entry) {
  const el = document.getElementById('msOverviewContent');
  if(!el || !entry) return;
  const totalH = MS_CATEGORIES.reduce((s,c) => s + (entry.committedHours[c]||0), 0);

  // Allocation status box (member's own result, per board applied to)
  let statusHtml = '';
  const myBoards = (entry.boards && entry.boards.length) ? entry.boards : MS_BOARDS;
  const byBoard = MS._allocByBoard || {};
  const anyRun = myBoards.some(function(b){ return !!byBoard[b]; });
  if(anyRun){
    statusHtml = '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">';
    myBoards.forEach(function(b){
      const alloc = byBoard[b]; const m = MS_BOARD_META[b];
      if(!alloc){
        var _sb = (function(){ try { return msSchedule(Date.now()).boards[b]; } catch(e){ return null; } })();
        var _runInfo = _sb ? '<div style="font-size:12px;color:var(--text3);margin-top:3px">Allocation runs: <strong class="mono" style="color:#ff9d4d">'+fmtUTCDateTime(_sb.allocAt)+'</strong></div>' : '';
        statusHtml += '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:12px 14px">'+
      '<div style="font-size:13px;color:var(--text2)">⏳ '+m.icon+' '+m.label+' — Allocation pending.</div>'+_runInfo+'</div>';
        return;
      }
      const mine = alloc.assignments.find(function(a){ return a.entry.ign===entry.ign && a.entry.alliance===entry.alliance; });
      if(mine){
        statusHtml += '<div style="background:rgba(46,204,113,.1);border:1px solid rgba(46,204,113,.4);border-radius:8px;padding:12px 14px">'+
          '<div style="font-weight:600;color:var(--green)">✅ '+m.icon+' '+m.label+' — you got a slot!</div>'+
          '<div style="font-size:13px;color:var(--text);margin-top:4px">Time: <strong class="mono" style="color:var(--gold)">'+msSlotDateTimeLabel(b, mine.slot)+'</strong></div>'+
        '</div>';
      } else {
        const wasRejected = alloc.rejected.some(function(r){ return r.ign===entry.ign && r.alliance===entry.alliance; });
        statusHtml += '<div style="background:rgba(255,157,77,.08);border:1px solid rgba(255,157,77,.35);border-radius:8px;padding:12px 14px">'+
          '<div style="font-weight:600;color:#ff9d4d">'+m.icon+' '+m.label+' — '+(wasRejected?'No slot this round':'Result pending for this board')+'</div>'+  
        '</div>';
      }
    });
    statusHtml += '</div>';
  } else {
    statusHtml = '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px">'+
      '<div style="font-size:13px;color:var(--text2)">✅ Your submission has been received. Allocation results will appear here once each board you applied for has been processed.</div>'+
    '</div>';
  }

  let html = statusHtml + '<div class="grid2" style="margin-bottom:14px">';
  html += '<div><div style="font-size:11px;color:var(--text3);margin-bottom:4px">IGN</div><div style="font-weight:600">' + (entry.ign||'—') + '</div></div>';
  html += '<div><div style="font-size:11px;color:var(--text3);margin-bottom:4px">Alliance</div><div style="font-weight:600">' + (entry.alliance||'—') + '</div></div>';
  html += '<div><div style="font-size:11px;color:var(--text3);margin-bottom:4px">Total committed hours</div><div style="font-weight:600;color:var(--gold)">' + totalH.toFixed(1) + 'h</div></div>';
  html += '<div><div style="font-size:11px;color:var(--text3);margin-bottom:4px">Submitted</div><div style="font-size:12px">' + (entry.submittedAt ? new Date(entry.submittedAt).toLocaleString() : '—') + '</div></div>';
  html += '</div>';
  // Minister spots applied for + computed score
  if(entry.boards && entry.boards.length){
    html += '<div style="margin-bottom:14px"><div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text)">Minister Spots Applied For</div><div style="display:flex;flex-direction:column;gap:8px">';
    entry.boards.forEach(function(b){
      var m=MS_BOARD_META[b]; if(!m) return;
      var sc=(entry.scores&&entry.scores[b]!==undefined)?entry.scores[b]:0;
      var _lk=((entry.frozenBoards&&entry.frozenBoards.indexOf(b)>=0)||msBoardClosed(b));
      html += '<div style="display:flex;align-items:center;gap:10px;background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:9px 12px">'+
        '<span style="font-size:18px">'+m.icon+'</span>'+
        '<span style="flex:1;font-weight:600;color:'+m.color+'">'+m.label+(_lk?' <span style="font-size:11px;color:#ff8080;font-weight:500">🔒 locked</span>':'')+'</span>'+
        '<span class="mono" style="color:var(--gold)">'+msBoardScoreLabel(b,sc)+'</span>'+
      '</div>';
    });
    html += '</div></div>';
  }
  // Speedup breakdown
  html += '<div style="margin-bottom:14px"><div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text)">Speedup Commitment</div>';
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
  MS_CATEGORIES.forEach(cat => {
    const v = entry.verify[cat];
    const h = entry.committedHours[cat]||0;
    const pct = entry.commit[cat]||50;
    html += '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:6px;padding:8px 12px;min-width:140px">' +
      '<div style="font-size:11px;color:var(--text3)">' + MS_CATEGORY_ICONS[cat] + ' ' + MS_CATEGORY_LABELS[cat] + '</div>' +
      '<div style="font-weight:600;color:var(--accent2)">' + h.toFixed(1) + 'h</div>' +
      '<div style="font-size:11px;color:var(--text3)">' + pct + '% of ' + (v?v.hours.toFixed(1):0) + 'h total</div>' +
      '</div>';
  });
  html += '</div></div>';
  // Slot picks
  html += '<div><div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text)">Preferred Timeslots (' + (entry.picks||[]).length + ')</div>';
  html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
  (entry.picks||[]).sort((a,b)=>a-b).forEach(s => {
    html += '<span style="background:rgba(201,165,92,.15);color:var(--accent2);border:1px solid var(--accent);border-radius:5px;padding:3px 8px;font-size:12px;font-family:monospace">' + msSlotLabel(s) + '</span>';
  });
  html += '</div></div>';
  // What happens next
  var _nextClose = null;
  (entry.boards || []).forEach(function(b){
    var d = (typeof msBoardDeadline==='function') ? msBoardDeadline(b) : null;
    if (d && d > Date.now() && (_nextClose === null || d < _nextClose)) _nextClose = d;
  });
  html += '<div style="margin-top:14px;background:rgba(201,165,92,.08);border:1px solid var(--border);border-radius:7px;padding:10px 14px;font-size:12px;color:var(--text2)">📅 <strong style="color:var(--text)">What happens next:</strong> ' +
    (_nextClose ? 'You can still edit this submission until <span class="mono" style="color:var(--gold)">' + new Date(_nextClose).toUTCString().replace('GMT','UTC') + '</span>. ' : '') +
    'After each board closes, the leaders run the allocation — your result will appear right here, so check back after the deadline.</div>';
  el.innerHTML = html;
}

function msEditSubmission() {
  if(!confirm("This will let you edit your submission. Your current submission stays saved and visible until you submit a new one. Continue?")) return;
  MS._editing = true;
  // Pre-fill the draft from the existing submission so nothing is lost
  const cur = MS._submittedEntry;
  if(cur){
    MS.draft = {
      alliance: cur.alliance||'', ign: cur.ign||'',
      verify: JSON.parse(JSON.stringify(cur.verify||{})),
      commit: JSON.parse(JSON.stringify(cur.commit||{})),
      picks: (cur.picks||[]).slice(),
      boards: (cur.boards||[]).slice(),
      truegold: cur.truegold||0, dust: cur.dust||0,
      tgOwned: cur.tgOwned||0, dustOwned: cur.dustOwned||0, dustPct: (cur.dustPct!==undefined?cur.dustPct:50), tgPct: (cur.tgPct!==undefined?cur.tgPct:50),
      picksByBoard: JSON.parse(JSON.stringify(cur.picksByBoard||{})),
      favByBoard: JSON.parse(JSON.stringify(cur.favByBoard||{})),
      generalSplit: JSON.parse(JSON.stringify(cur.generalSplit||{})),
      applyAll: false
    };
  } else {
    MS.draft = {alliance:'', ign:'', verify:{}, commit:{}, picks:[], boards:[], truegold:0, dust:0, picksByBoard:{}, favByBoard:{}, applyAll:false};
  }
  MS._unlockedStep = 4; // all steps unlocked since they already completed them
  // Keep the overview tab visible so they can still see their current submission
  const tab0 = document.getElementById('msStepTab0');
  if(tab0) tab0.style.display = '';
  msRenderStepTabs();
  msShowBoardPick(); // land on "Which minister spots are you applying for?" with current picks pre-checked
}

// ── STEP 5: ALLOCATION ──
function msFmtCountdown(ms){
  var totalMin = Math.max(0, Math.floor(ms/60000));
  var days = Math.floor(totalMin/1440);
  var hours = Math.floor((totalMin%1440)/60);
  return days+'d '+hours+'h';
}
// A board's allocation only counts as "Already run" if the stored result belongs to the
// CURRENT KvK cycle. Stamped results (runAt) are checked against the cycle window; legacy
// results without a stamp are only trusted once the scheduled allocation time has passed.
// This fixes "Already run" showing while the allocation date is still in the future.
function msAllocIsCurrent(b, sched){
  var a = MS._allocByBoard && MS._allocByBoard[b];
  if(!a) return false;
  try{ sched = sched || msSchedule(Date.now()); }catch(e){ return true; }
  if(a.runAt !== undefined) return a.runAt >= sched.clearAt;
  return Date.now() >= (sched.boards[b] ? sched.boards[b].allocAt : 0);
}
function msBoardTimerBlocksHTML(){
  var now = Date.now();
  var sched;
  try { sched = msSchedule(now); } catch(e){ return ''; }
  return MS_BOARDS.map(function(b){
    var m = MS_BOARD_META[b]; var bs = sched.boards[b];
    var allocMs = bs.allocAt - now, dlMs = bs.deadline - now;
    var allocDone = msAllocIsCurrent(b, sched);
    var allocStr = allocDone ? 'Already run' : (allocMs>0 ? 'Happens in '+msFmtCountdown(allocMs) : 'Overdue — pending next check');
    var dlStr = dlMs>0 ? 'Closes in '+msFmtCountdown(dlMs) : 'Closed';
    return '<div style="flex:1;min-width:220px;background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:10px 12px">'+
      '<div style="font-weight:700;color:'+m.color+';font-size:13px;margin-bottom:4px">'+m.icon+' '+m.label+' Minister Spot</div>'+
      '<div style="font-size:12px;color:var(--text2)">⚙️ Automatic assignment: <strong style="color:'+(allocDone?'var(--green)':(allocMs>0?'#ff9d4d':'#ff7070'))+'">'+allocStr+'</strong></div>'+
      '<div style="font-size:12px;color:var(--text2)">⏰ Submission deadline: <strong style="color:'+(dlMs>0?'#ff9d4d':'#ff7070')+'">'+dlStr+'</strong></div>'+
    '</div>';
  }).join('');
}
function msRenderBoardTimers(){
  var host = document.getElementById('msBoardTimersPanel'); if(!host) return;
  host.innerHTML = msBoardTimerBlocksHTML();
}
function msRenderResultsSummary(){
  document.getElementById('msTotalSubs').textContent=MS.submissions.length;
  document.getElementById('msWinnerCount').textContent=(MS._lastAllocation?MS._lastAllocation.winners.length:0);
  document.getElementById('msRejectedCount').textContent=(MS._lastAllocation?MS._lastAllocation.rejected.length:0);
  msRenderBoardTimers();
}

function msRunAllocationForBoard(board, prev){
  const pinned = new Map();
  if(prev){ prev.assignments.forEach(a => { if(a.pinned) pinned.set(a.slot, a.entry); }); }
  const pinnedIGNs = new Set([...pinned.values()].map(e => e.ign));
  const takenSlots = new Set(pinned.keys());
  const assignments = [];
  pinned.forEach((entry, slot) => { assignments.push({entry, slot, pinned:true}); });

  // only players who applied for this board (board-less legacy entries count everywhere)
  const applied = MS.submissions.filter(e => !e.boards || !e.boards.length || e.boards.indexOf(board)>=0);
  const candidates = applied.filter(e => !pinnedIGNs.has(e.ign));

  // Troops = current structure (Training hours). Buildings/Research = points score.
  const scoreOf = (board==='troops')
    ? (e => (e.committedHours && e.committedHours.training) || 0)
    : (e => (e.scores && e.scores[board]) || 0);
  const timeOf  = e => e.submittedAt ? new Date(e.submittedAt).getTime() : 0;
  const picksOf = e => (e.picksByBoard && e.picksByBoard[board]) || e.picks || [];
  const favsOf  = e => (e.favByBoard && e.favByBoard[board]) || e.favourites || [];

  // PASS 1 — protect the constrained (fewest picks first)
  const byConstraint = [...candidates].sort((a,b) => {
    const pa=picksOf(a).length, pb=picksOf(b).length;
    if(pa!==pb) return pa-pb;
    if(scoreOf(a)!==scoreOf(b)) return scoreOf(b)-scoreOf(a);
    return timeOf(a)-timeOf(b);
  });
  const placed = new Set();
  const CONSTRAINED_MAX_PICKS = MS_MIN_SLOTS_PICKED;
  byConstraint.forEach(entry => {
    if(picksOf(entry).length > CONSTRAINED_MAX_PICKS) return;
    if(takenSlots.size >= MS_TOTAL_SLOTS) return;
    const favs = favsOf(entry).filter(s => !takenSlots.has(s));
    const pick = favs.length ? favs[0] : picksOf(entry).find(s => !takenSlots.has(s));
    if(pick !== undefined){ takenSlots.add(pick); assignments.push({entry, slot:pick}); placed.add(entry.ign); }
  });

  // PASS 2 — place the flexible by score
  const remaining = candidates.filter(e => !placed.has(e.ign)).sort((a,b) => {
    if(scoreOf(a)!==scoreOf(b)) return scoreOf(b)-scoreOf(a);
    return timeOf(a)-timeOf(b);
  });
  const rejected = [], unassigned = [], rejectReasons = {};
  remaining.forEach(entry => {
    if(takenSlots.size >= MS_TOTAL_SLOTS){ rejectReasons[entry.ign]='all-full'; rejected.push(entry); return; }
    const favs = favsOf(entry).filter(s => !takenSlots.has(s));
    const pick = favs.length ? favs[0] : picksOf(entry).find(s => !takenSlots.has(s));
    if(pick !== undefined){ takenSlots.add(pick); assignments.push({entry, slot:pick}); placed.add(entry.ign); }
    else unassigned.push(entry);
  });
  // Philosophy B: you ONLY get a slot you actually picked.
  unassigned.forEach(entry => { rejectReasons[entry.ign]='picks-taken'; rejected.push(entry); });

  assignments.sort((a,b) => a.slot - b.slot);
  const winners = assignments.map(a => a.entry);
  return {winners, rejected, assignments, rejectReasons, board};
}

function msBoardsInPlay(){
  // Each minister type runs on its own KvK day, so R4/R5 need access to all three
  // regardless of whether anyone has submitted for a given board yet.
  return MS_BOARDS.slice();
}

function msRunAllocation(){
  if(!MS.submissions.length){ toast('No submissions yet.'); return; }
  var boardsPreview = msBoardsInPlay();
  var already = boardsPreview.filter(function(b){ return MS._allocByBoard && MS._allocByBoard[b]; });
  var warnMsg = '⚙️ Run allocation now for: '+boardsPreview.map(function(b){var m=MS_BOARD_META[b];return m?m.icon+' '+m.label:b;}).join(', ')+'?\\n\\n'+
    'Unpinned players may be reassigned. Pinned/locked slots are kept.'+
    (already.length ? '\\n\\nThis will OVERWRITE the existing result for: '+already.map(function(b){var m=MS_BOARD_META[b];return m?m.label:b;}).join(', ')+' (including any already run automatically).' : '')+
    '\\n\\nContinue?';
  if(!confirm(warnMsg)) return;
  MS._allocByBoard = MS._allocByBoard || {};
  var boards = msBoardsInPlay();
  var _runNow = Date.now(), _d1 = null; try{ _d1 = msSchedule(_runNow).day1; }catch(e){}
  boards.forEach(function(b){ var _r = msRunAllocationForBoard(b, MS._allocByBoard[b]); _r.runAt = _runNow; if(_d1) _r.day1 = _d1; MS._allocByBoard[b] = _r; });
  if(boards.indexOf(MS._manageBoard)<0) MS._manageBoard = boards[0];
  msSetManageBoard(MS._manageBoard);
  // Flag this push as a bulk reallocation (server requires Admin for this specific
  // action) as distinct from a single manage-board assign/swap/pin, which R4/R5
  // may still do and save normally. Push immediately (not debounced) so the hint
  // is read by the server while it's still set, then clear it right after.
  MS._pendingAction = 'runAllocation';
  if(typeof syncPushNow==='function'){ syncPushNow().then(function(){ MS._pendingAction = null; }); }
  else { syncQueuePush(); MS._pendingAction = null; }
  var total = boards.reduce(function(s,b){ return s + MS._allocByBoard[b].winners.length; }, 0);
  toast('Allocation complete — '+total+' placed across '+boards.length+' board'+(boards.length===1?'':'s')+'.');
}

function msSetManageBoard(board){
  MS._allocByBoard = MS._allocByBoard || {};
  MS._manageBoard = board;
  var res = MS._allocByBoard[board] || {winners:[],rejected:[],assignments:[],rejectReasons:{}};
  if(res.rejectReasons){ res.rejected.forEach(function(e){ e._rejectReason = res.rejectReasons[e.ign]; }); }
  MS._lastAllocation = res;
  _msSelected = null;   // drop any half-finished assign when switching boards
  msRenderManageBoardTabs();
  msRenderResultsSummary();
  msRenderFinalSchedule();
  msRenderRejectedList();
  if(typeof msRenderBench==='function') msRenderBench();
  if(typeof msRenderBoard==='function') msRenderBoard();   // ← redraw the 48 slots for THIS board
}

function msRenderManageBoardTabs(){
  var el=document.getElementById('msManageBoardTabs'); if(!el) return;
  var boards=msBoardsInPlay();
  el.style.display='flex';
  el.innerHTML=boards.map(function(b){ var m=MS_BOARD_META[b]; var on=b===MS._manageBoard;
    var n=(MS._allocByBoard&&MS._allocByBoard[b])?MS._allocByBoard[b].winners.length:0;
    var style = on
      ? 'background:'+m.color+'29;border:1.5px solid '+m.color+';color:'+m.color+';font-weight:700;'
      : 'background:rgba(255,255,255,.05);border:1.5px solid rgba(255,255,255,.14);color:var(--text2);font-weight:600;';
    return '<button onclick="msSetManageBoard('+"'"+b+"'"+')" style="'+style+'font-family:var(--head);font-size:13px;padding:7px 14px;border-radius:6px;cursor:pointer;transition:all .15s;letter-spacing:.03em">'+m.icon+' '+m.label+' <span style="opacity:.75">('+n+'/48)</span></button>';
  }).join('');
}

function msRenderFinalSchedule(){
  const el=document.getElementById('msFinalSchedule'); if(!el) return;
  if(!MS._lastAllocation || !MS._lastAllocation.assignments.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px">Run allocation to generate the schedule.</div>';
    return;
  }
  const canEdit = msCanAccessResults();
  const bySlot = {};
  MS._lastAllocation.assignments.forEach((a,i)=>{ bySlot[a.slot] = {a, i}; });

  let emptyCount = 0;
  const rows = [];
  for(let slot=0; slot<MS_TOTAL_SLOTS; slot++){
    const hit = bySlot[slot];
    if(hit){
      const a = hit.a, i = hit.i;
      const pinned = a.pinned ? true : false;
      const dragAttrs = canEdit ? 'draggable="true" ondragstart="msDragStart(event,'+i+')" ondragover="msDragOver(event)" ondrop="msDrop(event,'+i+')" ondragleave="msDragLeave(event)"' : '';
      rows.push('<div class="ms-rank-row winner" data-idx="'+i+'" '+dragAttrs+' style="cursor:'+(canEdit?'grab':'default')+';user-select:none;transition:opacity .15s">'+
        '<span class="ms-rank-num mono">'+msSlotLabel(a.slot)+'</span>'+
        '<strong>'+a.entry.ign+'</strong>'+
        '<span style="color:var(--text3);font-size:12px">'+a.entry.alliance+'</span>'+
        '<span style="margin-left:auto" class="mono" style="color:var(--gold)">'+a.entry.committedHours[MS_RANK_CATEGORY].toFixed(1)+'h</span>'+
        (canEdit?'<button onclick="msTogglePin('+i+')" title="'+(pinned?'Unpin slot':'Pin slot')+'" style="margin-left:8px;background:none;border:none;cursor:pointer;font-size:14px;padding:2px">'+(pinned?'🔒':'🔓')+'</button>':'')+
      '</div>');
    } else {
      emptyCount++;
      rows.push('<div class="ms-rank-row" style="opacity:.55">'+
        '<span class="ms-rank-num mono">'+msSlotLabel(slot)+'</span>'+
        '<span style="color:var(--text3);font-style:italic">— empty (nobody picked this slot) —</span>'+
        (canEdit?'<span style="margin-left:auto;font-size:11px;color:#ff9d4d">assign manually if needed</span>':'')+
      '</div>');
    }
  }

  const header = (canEdit ? '<div style="font-size:11px;color:var(--text3);margin-bottom:10px">🔒 Pinned slots are preserved when re-running allocation. Drag slots to swap. Click 🔒 to toggle pin.</div>' : '') +
    (emptyCount>0 ? '<div style="font-size:12px;color:#ff9d4d;margin-bottom:10px">⚠ '+emptyCount+' slot'+(emptyCount>1?'s are':' is')+' empty — nobody picked '+(emptyCount>1?'them':'it')+'. Left open on purpose.</div>' : '');

  el.innerHTML = header + rows.join('');
}

async function msAddPlayerById(){
  var input = document.getElementById('msAddPlayerId');
  var hint = document.getElementById('msBoardHint');
  if(!input) return;
  var pid = (input.value||'').trim();
  if(!pid){ if(hint) hint.textContent='Enter a Player ID first.'; return; }

  // Already on the bench or placed?
  var st = msPanelState();
  var exists = (MS.submissions||[]).some(function(s){ return String(s.playerId)===pid || String(s.id)===pid; });
  if(exists){ if(hint) hint.innerHTML='<span style="color:#ff9d4d">That player is already in the system.</span>'; return; }

  if(hint) hint.textContent='Looking up player '+pid+'…';
  var p = await doPlayerLookup(pid);

  var name, alliance;
  if(p && p.name){
    // kingshot.net gave us the player
    name = p.name;
    alliance = (p.alliance || prompt('Alliance for '+name+' (FIR/LOC/LYL/KNG/KOV/TLA):','') || '').toUpperCase().trim();
  } else {
    // kingshot.net down or player not found → manual fallback
    name = (prompt('Kingshot.net could not verify this ID. Enter the player IGN manually:','') || '').trim();
    if(!name){ if(hint) hint.textContent='Cancelled.'; return; }
    alliance = (prompt('Alliance for '+name+' (FIR/LOC/LYL/KNG/KOV/TLA):','') || '').toUpperCase().trim();
  }
  if(!alliance){ if(hint) hint.textContent='Alliance required — cancelled.'; return; }

  // Build a submission-shaped entry with zero picks (leader places manually)
  var entry = {
    id: 'manual_'+pid+'_'+Date.now(),
    playerId: String(pid),
    alliance: alliance,
    ign: name,
    verify: { training:{amount:0,unit:'hours',hours:0} },
    commit: { training:100 },
    picks: [],
    favourites: [],
    committedHours: { general:0, training:0, construction:0, research:0 },
    submittedAt: new Date().toISOString(),
    _addedManually: true
  };

  MS.submissionsByPlayer = MS.submissionsByPlayer || {};
  MS.submissionsByPlayer[entry.playerId] = entry;
  MS.submissions = Object.values(MS.submissionsByPlayer);
  // Make sure they show as unplaced (on the bench)
  if(MS._lastAllocation){ MS._lastAllocation.rejected = MS._lastAllocation.rejected || []; MS._lastAllocation.rejected.push(entry); }

  msLogAction('added player '+name+' ('+alliance+') to bench');
  input.value='';
  syncQueuePush();
  msRefreshManagePanel();
  if(hint) hint.innerHTML='<span style="color:var(--green)">✓ Added '+name+' ('+alliance+') to the bench. Now assign them to a slot.</span>';
}

// ═══════════ MANAGE SPOTS — interactive leader panel ═══════════
var _msSelected = null;        // {src:'bench'|'slot', player, slot?}
var _msUndoStack = [];

function msPanelState(){
  // Returns {assignments:[{slot,entry,pinned}], bench:[entries]} derived from allocation + submissions
  var alloc = MS._lastAllocation || {assignments:[], rejected:[]};
  var placedIgns = {};
  alloc.assignments.forEach(function(a){ placedIgns[a.entry.ign+'|'+a.entry.alliance]=true; });
  // Bench = everyone not currently placed (rejected + any submission not assigned + manually added)
  var bench = [];
  (MS.submissions||[]).forEach(function(s){
    if(!placedIgns[s.ign+'|'+s.alliance]) bench.push(s);
  });
  return { assignments: alloc.assignments, bench: bench };
}

function msSnapshot(){
  _msUndoStack.push(JSON.stringify(MS._lastAllocation||{assignments:[],rejected:[]}));
  if(_msUndoStack.length>30) _msUndoStack.shift();
}

function msSelectedPicks(){
  return (_msSelected && _msSelected.player && _msSelected.player.picks) ? _msSelected.player.picks : [];
}

function msRenderBench(){
  var el = document.getElementById('msBenchList'); if(!el) return;
  var st = msPanelState();
  var q = (document.getElementById('msBenchSearch')||{value:''}).value.toLowerCase();
  var list = st.bench.filter(function(p){ return p.ign.toLowerCase().indexOf(q)>=0; });
  var html = '';
  if(!list.length){ html = '<div style="font-size:12px;color:var(--text3);padding:6px 0">No unplaced players.</div>'; }
  list.forEach(function(p){
    var sel = _msSelected && _msSelected.src==='bench' && _msSelected.player.ign===p.ign && _msSelected.player.alliance===p.alliance;
    var reason = '', reasonFull = '';
    if(p._addedManually){ reason='added'; reasonFull='Added manually by a leader — no picks, place anywhere.'; }
    else if(MS._lastAllocation && MS._lastAllocation.rejected){
      var r = MS._lastAllocation.rejected.find(function(x){ return x.ign===p.ign && x.alliance===p.alliance; });
      if(r){
        if((p.picks||[]).length < MS_MIN_SLOTS_PICKED){ reason='too few'; reasonFull='Picked fewer than the minimum '+MS_MIN_SLOTS_PICKED+' slots.'; }
        else if(r._rejectReason==='all-full'){ reason='all full'; reasonFull='All 48 slots were filled before this player could be placed.'; }
        else { reason='picks taken'; reasonFull='Every slot this player picked was taken by higher-priority players.'; }
      }
    }
    var hrs = (p.committedHours && p.committedHours[MS_RANK_CATEGORY]) ? p.committedHours[MS_RANK_CATEGORY].toFixed(0) : '0';
    var reasonTag = reason ? '<span title="'+reasonFull.replace(/"/g,'&quot;')+'" style="cursor:help">'+reason+' ⓘ</span>' : '';
    html += '<div onclick="msBenchClick('+"'"+encodeURIComponent(p.ign)+"','"+encodeURIComponent(p.alliance)+"'"+')" style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;min-width:0;border:1px solid '+(sel?'var(--accent)':'var(--border)')+';background:'+(sel?'rgba(201,165,92,.12)':'var(--bg3)')+'">'+
      '<div style="min-width:0;flex:1"><div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+p.ign+'</div>'+
      '<div style="font-size:10px;color:var(--text3)">'+hrs+'h'+(reasonTag?' · '+reasonTag:'')+'</div></div>'+
      msAllianceChip(p.alliance)+
    '</div>';
  });
  el.innerHTML = html;
}

var MS_ALLIANCE_COLORS = {FIR:'#e0663a', LOC:'#3d8ef0', LYL:'#9b6ef0', KNG:'#e0a53a', KOV:'#2ecc71', TLA:'#e04b6a'};
function msAllianceChip(a){
  var c = MS_ALLIANCE_COLORS[a] || '#888';
  return '<span style="font-size:10px;font-weight:600;color:'+c+';background:'+c+'22;border:1px solid '+c+'55;padding:1px 5px;border-radius:4px;flex-shrink:0">'+(a||'—')+'</span>';
}

function msRenderBoard(){
  var el = document.getElementById('msBoard'); if(!el) return;
  var st = msPanelState();
  var bySlot = {};
  st.assignments.forEach(function(a){ bySlot[a.slot]=a; });
  var picks = msSelectedPicks();
  var html = '';
  for(var slot=0; slot<MS_TOTAL_SLOTS; slot++){
    var a = bySlot[slot];
    var empty = !a;
    var isPick = picks.indexOf(slot)>=0;
    var selecting = !!_msSelected;
    var locked = a && a.pinned;
    var border = locked ? 'var(--gold)' : (isPick ? 'var(--accent)' : 'var(--border)');
    var mid, chip='';
    if(empty){
      mid = '<span style="font-size:12px;color:var(--text3);font-style:italic;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+(selecting?(isPick?'their pick — tap':'tap to place'):'empty')+'</span>';
    } else {
      mid = '<span style="font-size:13px;font-weight:600;color:var(--text);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+a.entry.ign+'</span>';
      chip = msAllianceChip(a.entry.alliance);
    }
    var dot = isPick ? '<span style="width:5px;height:5px;border-radius:50%;background:var(--accent);flex-shrink:0"></span>' : '<span style="width:5px;flex-shrink:0"></span>';
    var lockIcon = locked ? '🔒' : '🔓';
    var lockBtn = '<span onclick="event.stopPropagation();msPanelToggleLock('+slot+')" title="lock" style="cursor:pointer;font-size:12px;flex-shrink:0;color:'+(locked?'var(--gold)':'var(--text3)')+';opacity:'+(locked?'1':'.3')+'">'+lockIcon+'</span>';
    html += '<div onclick="msBoardClick('+slot+')" style="border-radius:6px;padding:5px 9px;border:1px solid '+border+';background:'+(empty?'var(--bg2)':'var(--bg3)')+';display:flex;align-items:center;gap:7px;cursor:'+(selecting?'copy':'default')+'">'+
      dot+'<span style="font-family:var(--mono);font-size:10px;color:var(--text3);flex-shrink:0;min-width:34px">'+msSlotLabel(slot)+'</span>'+mid+chip+lockBtn+
    '</div>';
  }
  el.innerHTML = html;
  msRenderPanelCounter();
}
function msRenderPanelCounter(){
  var el = document.getElementById('msPanelCounter'); if(!el) return;
  var st = msPanelState();
  el.textContent = st.bench.length+' on bench · '+st.assignments.length+'/'+MS_TOTAL_SLOTS+' filled';
}

function msCopyByAlliance(){
  if(!MS._lastAllocation || !MS._lastAllocation.assignments.length){ toast('Run allocation first.'); return; }
  var filter = (document.getElementById('msCopyFilter')||{value:''}).value;
  var rows = MS._lastAllocation.assignments
    .filter(function(a){ return !filter || a.entry.alliance===filter; })
    .sort(function(x,y){ return x.slot - y.slot; });
  if(!rows.length){ toast('No players in '+filter+'.'); return; }
  var board = MS._manageBoard || 'troops';
  var m = MS_BOARD_META[board] || {label:board};
  var dayNum = {buildings:1, research:2, troops:4}[board] || '?';
  var sched = (function(){ try { return msSchedule(Date.now()).boards[board]; } catch(e){ return null; } })();
  var FULL_MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var dateStr = sched ? (function(){ var dt=new Date(sched.dayStart); return dt.getUTCDate()+' '+FULL_MON[dt.getUTCMonth()]+' '+dt.getUTCFullYear(); })() : '—';
  var lines = ['Day '+dayNum+' – '+m.label+' Minister Spot', 'Date: '+dateStr, ''];
  rows.forEach(function(a){
    var range = msSlotLabel(a.slot).replace('-','–');
    lines.push(range+' — '+a.entry.ign);
  });
  copyText(lines.join('\\n'));
  var msg = document.getElementById('msCopiedMsg');
  if(msg){ msg.style.opacity='1'; setTimeout(function(){ msg.style.opacity='0'; }, 1500); }
}

function msRenderAuditFeed(){
  var el = document.getElementById('msAuditFeed'); if(!el) return;
  var log = MS.auditLog || [];
  if(!log.length){ el.innerHTML='<div style="color:var(--text3)">No changes yet.</div>'; return; }
  var now = Date.now();
  function ago(t){
    var s = Math.floor((now-t)/1000);
    if(s<60) return s+'s ago';
    if(s<3600) return Math.floor(s/60)+'m ago';
    if(s<86400) return Math.floor(s/3600)+'h ago';
    return Math.floor(s/86400)+'d ago';
  }
  el.innerHTML = log.slice(0,25).map(function(e){
    return '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)">'+
      '<strong style="color:var(--text2)">'+(e.who||'leader')+'</strong> '+
      '<span style="color:var(--text3)">'+(e.action||'')+'</span> '+
      '<span style="color:var(--text3);opacity:.7;font-size:10px">· '+ago(e.when||now)+'</span>'+
    '</div>';
  }).join('');
}

function msBenchClick(ignEnc, allEnc){
  var ign = decodeURIComponent(ignEnc), alliance = decodeURIComponent(allEnc);
  var st = msPanelState();
  var p = st.bench.find(function(x){ return x.ign===ign && x.alliance===alliance; });
  if(!p) return;
  if(_msSelected && _msSelected.src==='bench' && _msSelected.player.ign===ign && _msSelected.player.alliance===alliance){ _msSelected=null; }
  else { _msSelected = {src:'bench', player:p}; }
  msRenderBench(); msRenderBoard();
}

function msBoardClick(slot){
  var st = msPanelState();
  var bySlot = {}; st.assignments.forEach(function(a){ bySlot[a.slot]=a; });

  // Nothing selected yet: if this slot has a player, pick them up (select them)
  if(!_msSelected){
    if(bySlot[slot]){
      _msSelected = { src:'slot', player: bySlot[slot].entry, fromSlot: slot };
      msRenderBench(); msRenderBoard();
      var h0 = document.getElementById('msBoardHint');
      if(h0) h0.innerHTML = '<span style="color:var(--accent)">Selected '+bySlot[slot].entry.ign+' from '+msSlotLabel(slot)+' — tap another slot to move or swap.</span>';
    }
    return;
  }

  var moving = _msSelected.player;
  var fromSlot = _msSelected.src==='slot' ? _msSelected.fromSlot : null;

  // Tapping the same slot again = deselect
  if(fromSlot===slot){ _msSelected=null; msRenderBench(); msRenderBoard(); return; }

  var mismatch = moving.picks && moving.picks.length>0 && moving.picks.indexOf(slot)<0;
  if(mismatch){
    if(!confirm(moving.ign+' did NOT pick '+msSlotLabel(slot)+' — they may be unavailable then. Place anyway?')) return;
  }

  msSnapshot();
  if(!MS._lastAllocation) MS._lastAllocation = {assignments:[], rejected:[]};
  var A = MS._lastAllocation;
  var occ = bySlot[slot];

  // Remove moving from its current assignment + from rejected
  A.assignments = A.assignments.filter(function(a){ return !(a.entry.ign===moving.ign && a.entry.alliance===moving.alliance); });
  A.rejected = (A.rejected||[]).filter(function(r){ return !(r.ign===moving.ign && r.alliance===moving.alliance); });

  if(occ){
    // Remove the occupant from the target slot
    A.assignments = A.assignments.filter(function(a){ return a.slot!==slot; });
    if(fromSlot!==null){
      // SLOT → SLOT: swap — put the occupant into the slot 'moving' came from
      A.assignments.push({ entry: occ.entry, slot: fromSlot, pinned: true });
      msLogAction('swapped '+moving.ign+' ('+msSlotLabel(slot)+') with '+occ.entry.ign+' ('+msSlotLabel(fromSlot)+')');
    } else {
      // BENCH → occupied slot: bump occupant to bench
      A.rejected.push(occ.entry);
      msLogAction('assigned '+moving.ign+' → '+msSlotLabel(slot)+' (bumped '+occ.entry.ign+')');
    }
  } else {
    msLogAction((fromSlot!==null?'moved ':'assigned ')+moving.ign+' → '+msSlotLabel(slot)+(mismatch?' (not their pick)':''));
  }

  A.assignments.push({ entry: moving, slot: slot, pinned: true });
  _msSelected = null;
  syncQueuePush();
  msRefreshManagePanel();
  var hint = document.getElementById('msBoardHint');
  if(hint) hint.innerHTML = (mismatch?'<span style="color:#ff9d4d">⚠ ':'<span style="color:var(--green)">✓ ')+'Done: '+moving.ign+' → '+msSlotLabel(slot)+'.</span>';
}

function msPanelToggleLock(slot){
  if(!MS._lastAllocation) return;
  var a = MS._lastAllocation.assignments.find(function(x){ return x.slot===slot; });
  if(!a) return;
  msSnapshot();
  a.pinned = !a.pinned;
  msLogAction((a.pinned?'locked ':'unlocked ')+msSlotLabel(slot)+' ('+a.entry.ign+')');
  syncQueuePush();
  msRefreshManagePanel();
}

function msUndoLast(){
  if(!_msUndoStack.length){ var h=document.getElementById('msBoardHint'); if(h) h.textContent='Nothing to undo.'; return; }
  MS._lastAllocation = JSON.parse(_msUndoStack.pop());
  msLogAction('undid last change');
  syncQueuePush();
  msRefreshManagePanel();
}

function msRefreshManagePanel(){
  msRenderBench();
  msRenderBoard();
  msRenderAuditFeed();
  if(typeof msRenderFinalSchedule==='function') msRenderFinalSchedule();
  if(typeof msRenderRejectedList==='function') msRenderRejectedList();
  if(typeof msRenderResultsSummary==='function') msRenderResultsSummary();
}

function msShowManagePanel(){
  var panel = document.getElementById('msManagePanel');
  if(!panel) return;
  if(msCanAccessResults()){
    panel.style.display = 'block';
    msRenderBench();
    msRenderBoard();
    msRenderAuditFeed();
  } else {
    panel.style.display = 'none';
  }
}

let _msDragSrcIdx = null;
function msDragStart(e, idx) {
  _msDragSrcIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.target.style.opacity = '0.4';
}
function msDragOver(e) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  e.currentTarget.style.background = 'rgba(201,165,92,.15)';
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
  const canEdit = msCanAccessResults();
  function reasonFor(entry){
    const picks=(entry.picks||[]).length;
    if(picks < MS_MIN_SLOTS_PICKED) return 'Picked fewer than the minimum '+MS_MIN_SLOTS_PICKED+' slots';
    if(entry._rejectReason==='all-full') return 'All 48 slots were filled before this player could be placed';
    return 'Every slot this player picked was taken by higher-priority players';
  }
  el.innerHTML=MS._lastAllocation.rejected.map(function(entry,i){
    const reason = reasonFor(entry);
    const info = canEdit ? '<span title="'+reason.replace(/"/g,'&quot;')+'" style="cursor:help;margin-left:6px;opacity:.7;font-size:12px">ⓘ why</span>' : '';
    return '<div class="ms-rank-row rejected">'+
      '<span class="ms-rank-num mono">#'+(MS_TOTAL_SLOTS+i+1)+'</span>'+
      '<strong>'+entry.ign+'</strong>'+
      '<span style="color:var(--text3);font-size:12px">'+entry.alliance+'</span>'+
      '<span style="margin-left:auto" class="mono">'+entry.committedHours[MS_RANK_CATEGORY].toFixed(1)+'h training</span>'+
      info+
    '</div>';
  }).join('');
}

function msCopySchedule(){
  if(!MS._lastAllocation || !MS._lastAllocation.assignments.length){ toast('Run allocation first!'); return; }
  const lines=['=== Noble Advisor — Day 4 Schedule ===',
    ...MS._lastAllocation.assignments.map(a=>\`\${msSlotLabel(a.slot)} | \${a.entry.ign} (\${a.entry.alliance})\`)];
  copyText(lines.join('\\n'));
  toast('Schedule copied!');
}

function msClearAllSubs(){
  if(!confirm('⚠️ Admin action: clear ALL Minister Spots submissions for every board? This cannot be undone.')) return;
  MS.submissions=[];
  MS.submissionsByPlayer={};
  MS._lastAllocation=null;
  MS._submittedEntry=null;
  MS._allocByBoard={};   // clear every board's ranked winners too — otherwise stale
  MS._auto=null;         // results (e.g. "2/48", instant slot on resubmit) survive the wipe
  try {
    for(let i=localStorage.length-1; i>=0; i--){
      const k=localStorage.key(i);
      if(k && (k.indexOf('ks1057_ms_submitted_')===0 || k.indexOf('ks1057_ms_progress_')===0)) localStorage.removeItem(k);
    }
  } catch(e){}
  msRenderResultsSummary();
  if(typeof msRenderFinalSchedule==='function') msRenderFinalSchedule();
  if(typeof msRenderRejectedList==='function') msRenderRejectedList();
  if(typeof msRenderSlotGrid==='function') msRenderSlotGrid();
  // Save immediately (not debounced) so the clear reaches the backend before any sign-out
  if(typeof syncPushNow==='function') syncPushNow(); else syncQueuePush();
  if(typeof toast==='function') toast('All submissions cleared.');
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
  playerVerified: false,
  token: null        // signed server token (never a password)
};

const AUTH_DEFAULTS = {
  rallyleader: '',
  r4r5: '',
  admin: ''
};

let loadedPasswords = { rallyleader: null, r4r5: null, admin: null };

const ALLIANCES = ['FIR','LOC','LYL','KNG','KOV','TLA'];

// ── Token handling (server-issued, never a password) ──
function authSaveToken(t){ AUTH.token = t; try { if(t) sessionStorage.setItem('auth_token', t); else sessionStorage.removeItem('auth_token'); } catch(e){} }
function authLoadToken(){ try { AUTH.token = sessionStorage.getItem('auth_token'); } catch(e){} return AUTH.token; }
function stateHeaders(extra){ var h = extra || {}; if(AUTH.token) h['Authorization'] = 'Bearer ' + AUTH.token; return h; }
// Ask the Worker to verify a password/player and issue a token. Returns role or null.
async function msAuthLogin(role, opts){
  opts = opts || {};
  try {
    const res = await fetch('/auth', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ role: role, password: opts.password, playerId: opts.playerId }) });
    const d = await res.json();
    if (res.ok && d.ok && d.token){ authSaveToken(d.token); return d.role; }
  } catch(e) {}
  return null;
}

async function loadPasswords() { /* passwords are server-side only now — never sent to the client */ }

function getPassword(type) { return null; }
function checkPassword(type, input) { return false; }

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
  const r4Notice = document.getElementById('msR4NoticeBanner');
  if (guard) guard.style.display = 'none';
  if (isAdmin()) {
    if (actions) actions.style.display = 'block';
    if (r4Notice) r4Notice.style.display = 'none';
    msRenderDay1OverrideCurrent();
  } else {
    // R4/R5 (non-admin): can still manage/assign players, but not run the
    // destructive/global controls — those are Admin-only.
    if (actions) actions.style.display = 'none';
    if (r4Notice) r4Notice.style.display = 'block';
  }
  msUpdateDeadlineBanners();
}
function msRenderDay1OverrideCurrent(){
  var el = document.getElementById('msDay1OverrideCurrent'); if(!el) return;
  if (MS.kvkDay1Override) {
    el.innerHTML = '⚠️ Override active — Day 1 forced to <strong style="color:#ff9d4d">'+fmtUTCDateTime(new Date(MS.kvkDay1Override).getTime())+'</strong>. All deadlines/allocations are computed from this instead of the normal 28-day cycle.';
  } else {
    el.textContent = 'No override set — using the normal computed schedule.';
  }
}
// ── Force KvK Day-1 override (Admin only, server-enforced) ──
function msSetDay1Override(){
  const input = document.getElementById('msDay1OverrideInput');
  if (!input || !input.value) { toast('Pick a date and time first.'); return; }
  const iso = new Date(input.value).toISOString();
  const willBeInPast = new Date(iso).getTime() < Date.now();
  const warn = '⚠️ This forces KvK Day 1 to '+new Date(iso).toUTCString()+'.\\n\\n'+
    'Every deadline and allocation time for all 3 boards recalculates from this instant.\\n'+
    (willBeInPast ? 'This date is in the PAST relative to now — if the 7-day clear point has already passed for it, ALL current submissions will be auto-cleared on the next scheduled check (within ~30 minutes).\\n\\n' : '') +
    'This cannot be undone automatically — you would need to clear the override manually. Continue?';
  if (!confirm(warn)) return;
  MS.kvkDay1Override = iso;
  syncQueuePush();
  msRenderDay1OverrideCurrent();
  if (typeof msRenderScheduleStrip==='function') msRenderScheduleStrip();
  msUpdateDeadlineBanners();
  toast('KvK Day 1 override set.');
}
function msClearDay1Override(){
  if (!MS.kvkDay1Override) { toast('No override is set.'); return; }
  if (!confirm('Clear the Day-1 override and return to the normal computed 28-day schedule?')) return;
  MS.kvkDay1Override = null;
  syncQueuePush();
  msRenderDay1OverrideCurrent();
  if (typeof msRenderScheduleStrip==='function') msRenderScheduleStrip();
  msUpdateDeadlineBanners();
  toast('Override cleared — back to the normal schedule.');
}

function msInitResultsTab() {
  if (msCanAccessResults()) {
    msShowAdminActions();
    var boards = msBoardsInPlay();
    if (!MS._manageBoard || boards.indexOf(MS._manageBoard) < 0) MS._manageBoard = boards[0];
    if (MS._allocByBoard && MS._allocByBoard[MS._manageBoard]) {
      MS._lastAllocation = MS._allocByBoard[MS._manageBoard];
    }
    msRenderManageBoardTabs();
  } else {
    const guard = document.getElementById('msAdminGuard');
    const actions = document.getElementById('msAdminActions');
    if (guard) guard.style.display = 'block';
    if (actions) actions.style.display = 'none';
  }
}

async function msUnlockAdmin() {
  const input = document.getElementById('msAdminPwInput');
  const err = document.getElementById('msAdminPwErr');
  if (!input) return;
  const role = await msAuthLogin('admin', { password: input.value });
  if (role === 'admin') {
    AUTH.role = 'admin';
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
// ════════════════════════════════════════════════════════
// KINGSHOT.NET OUTAGE BYPASS
// ════════════════════════════════════════════════════════
let _ksNetIsDown = false;

async function checkKingshotHealth() {
  try {
    const res = await fetch('/kingshot-player?id=158134757', { cache: 'no-store' });
    const data = await res.json();
    if (data && (data.status === 'success' || data.status === 'fail')) { _ksNetIsDown = false; return; }
    _ksNetIsDown = true;
  } catch (e) {
    _ksNetIsDown = true;
  }
  if (_ksNetIsDown) showBypassUI();
}

function showBypassUI() {
  const box = document.getElementById('bypassBox');
  if (box) box.style.display = 'block';
}

function bypassEnterMember() {
  const name = (document.getElementById('bypassName').value || '').trim();
  const alliance = document.getElementById('bypassAlliance').value;
  if (!name) { toast('Enter your in-game name.'); return; }
  if (!alliance) { toast('Select your alliance.'); return; }
  verifiedPlayer = { id: 'manual_' + Date.now(), name, kingdom: 1057, level: null, avatar: null };
  _registerAndEnter('member', alliance);
}

async function bypassCheckPassword() {
  const input = document.getElementById('bypassPwInput');
  const errEl = document.getElementById('bypassPwError');
  if (!input) return;

  // R4/R5, Rally Leaders and Admin must also give name + alliance
  const name = (document.getElementById('bypassName').value || '').trim();
  const alliance = document.getElementById('bypassAlliance').value;
  if (!name) { toast('Enter your in-game name first.'); return; }
  if (!alliance) { toast('Select your alliance first.'); return; }

  const pw = input.value;
  let role = null;
  if (await msAuthLogin('admin', {password: pw})) role = 'admin';
  else if (await msAuthLogin('r4r5', {password: pw})) role = 'r4r5';
  else if (await msAuthLogin('rallyleader', {password: pw})) role = 'rallyleader';

  if (role) {
    verifiedPlayer = { id: 'bypass_' + role + '_' + Date.now(), name, kingdom: 1057, level: null, avatar: null };
    await _registerAndEnter(role, alliance);
  } else {
    if (errEl) { errEl.style.display = 'block'; input.value = ''; input.focus(); setTimeout(() => errEl.style.display = 'none', 3000); }
  }
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
  const pid = verifiedPlayer ? String(verifiedPlayer.id) : '';

  let role = null;
  if (pid === ADMIN_PLAYER_ID) { if (await msAuthLogin('admin', {password: pw})) role = 'admin'; }
  if (!role && await msAuthLogin('r4r5', {password: pw})) role = 'r4r5';
  if (!role && await msAuthLogin('rallyleader', {password: pw})) role = 'rallyleader';

  if (role) {
    const alliance = (role === 'rallyleader' || role === 'admin') ? null : AUTH.alliance;
    await _registerAndEnter(role, alliance);
  } else {
    if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Incorrect password.'; }
    input.value = '';
    input.focus();
    setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 3000);
  }
}

async function _registerAndEnter(role, alliance) {
  if (role === 'member' && !AUTH.token && verifiedPlayer) {
    await msAuthLogin('member', { playerId: verifiedPlayer.id });
  }
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
  if(typeof syncFirstPull==='function') syncFirstPull();

  // Tab visibility by role
  const isMemberOnly = role === 'member';
  const isRally = role === 'rallyleader';
  const isR4 = isR4R5();
  const isAdm = isAdmin();

  // Coordinator tabs (Rally Leaders, Team Setup, Battle Strategy)
  ['coordinator','setup','strategy'].forEach(id => {
    const tab = document.querySelector('.nav > .tab[onclick*="' + id + '"]');
    if(tab) tab.style.display = (isRally || isR4 || isAdm) ? '' : 'none';
  });

// Minister Spots — Members, Rally Leaders, R4/R5, and Admin (same experience as Members)
  const msTab = document.querySelector('.nav > .tab[onclick*="minister"]');
  if(msTab) msTab.style.display = (isMemberOnly || isRally || isR4 || isAdm) ? '' : 'none';

  // Swordland / Tri Alliance — R4/R5, Admin, Rally Leaders (view only)
  ['tabSwordland','tabTrialliance'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = (isRally || isR4 || isAdm) ? '' : 'none';
  });

  // Admin tab
  const adminTab = document.getElementById('tabAdmin');
  if(adminTab) adminTab.style.display = isAdm ? '' : 'none';

  // Show user bar
  const stored = verifiedPlayer || (() => { try { const s = sessionStorage.getItem('verifiedPlayer'); return s ? JSON.parse(s) : null; } catch(e) { return null; } })();
  showUserBar(stored, role);

  // Default page by role
if(isMemberOnly) showPageDirect('minister');
  else showPageDirect('strategy');
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

// ── Logout ──
function showUserBar(player, role) {
  const bar = document.getElementById('userBar');
  if (!bar) return;
  bar.style.display = 'flex';
  if (player) {
    const av = document.getElementById('userBarAvatar');
    if (av && player.avatar) { av.src = player.avatar; av.style.display = 'block'; }
    const nm = document.getElementById('userBarName');
    if (nm) nm.textContent = player.name || '';
    const pid = document.getElementById('userBarPlayerId');
    if (pid && player.id) pid.textContent = 'ID: ' + player.id;
    const kg = document.getElementById('userBarKingdom');
    if (kg) kg.textContent = 'Kingdom ' + (player.kingdom || '1057');
  }
  const rl = document.getElementById('userBarRole');
  if (rl) {
    if (role === 'admin') { rl.textContent = '⚙️ Admin'; rl.style.background = 'rgba(255,200,0,.15)'; rl.style.color = 'var(--gold)'; }
    else if (role === 'r4r5') { rl.textContent = '🛡 R4/R5'; rl.style.background = 'rgba(201,165,92,.15)'; rl.style.color = 'var(--accent2)'; }
    else if (role === 'rallyleader') { rl.textContent = '⚔️ Rally Leader'; rl.style.background = 'rgba(201,165,92,.15)'; rl.style.color = 'var(--accent2)'; }
    else { rl.textContent = '👤 Member'; rl.style.background = 'rgba(46,204,113,.1)'; rl.style.color = 'var(--green)'; }
  }
}

function logOut() {
  if(!confirm('Sign out of Kingdom 1057?')) return;
  // Clear session
  try { sessionStorage.clear(); } catch(e) {}
  // Clear role from localStorage (but keep player ID for convenience)
  lsClear('role');
  lsClear('alliance');
  // Reset AUTH
  AUTH.role = null;
  AUTH.alliance = null;
  verifiedPlayer = null;
  // Reset MS state
  MS._submittedEntry = null;
  MS._unlockedStep = 1;
  // Hide app, show landing
  document.getElementById('userBar').style.display = 'none';
  document.getElementById('mainNav').style.display = 'none';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const lp = document.getElementById('page-landing');
  if(lp) { lp.style.display = 'flex'; }
  // Reset landing page steps
  ['landingStepEntry','landingStepAlliance','landingStepPassword'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = id === 'landingStepEntry' ? 'block' : 'none';
  });
  const guide = document.getElementById('landingGuide');
  if(guide) guide.style.display = 'block';
  const roleButtons = document.getElementById('landingRoleButtons');
  if(roleButtons) roleButtons.style.display = 'none';
  const resultEl = document.getElementById('playerLookupResult');
  if(resultEl) resultEl.style.display = 'none';
  const pidInput = document.getElementById('landingPlayerId');
  if(pidInput) pidInput.value = '';
}
async function initApp() {
  authLoadToken();

  // Try session first (same tab/window)
  const { role, alliance } = sessionGetAuth();
  if (role) {
    AUTH.role = role;
    AUTH.alliance = alliance || null;
    try { verifiedPlayer = JSON.parse(sessionStorage.getItem('verifiedPlayer')); } catch(e) {}
    if (!AUTH.token && role === 'member' && verifiedPlayer) { await msAuthLogin('member', { playerId: verifiedPlayer.id }); }
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
      await msAuthLogin('member', { playerId: savedPlayer.id });
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
  checkKingshotHealth();
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
  const btn = document.getElementById('adminRedeemBtn');
  if (btn && btn.disabled) return; // guard against double-fire
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '⏳ Running…'; }
  if (statusEl) statusEl.textContent = '⏳ Redeeming… this may take a minute.';
  try {
    const res = await fetch('/admin-redeem', {
      method: 'POST',
      headers: stateHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (statusEl) statusEl.textContent = data.message || 'Done.';
    adminLoadGiftLog();
  } catch(e) {
    if (statusEl) statusEl.textContent = '⚠ Error: ' + e.message;
  }
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '🎁 Redeem Now for All Members'; }
}

async function adminLoadGiftLog() {
  const logEl = document.getElementById('giftRedeemLog');
  if (!logEl) return;
  try {
    const res = await fetch('/gift-log', { headers: stateHeaders() });
    const data = await res.json();
    if (!data.log || !data.log.length) {
      logEl.innerHTML = '<div style="color:var(--text3)">No redemptions yet.</div>';
      return;
    }
    logEl.innerHTML = data.log.slice().reverse().map(entry => {
      const results = entry.results || [];
      const okN   = (entry.ok  != null) ? entry.ok  : results.filter(r => r.ok).length;
      const skipN = (entry.skip!= null) ? entry.skip: results.filter(r => !r.ok && (r.err||'').includes("already")).length;
      const failN = (entry.fail!= null) ? entry.fail: results.filter(r => !r.ok && !(r.err||'').includes("already")).length;
      const codes = entry.codes ? entry.codes.join(", ") : (entry.code || "—");
      const when = new Date(entry.time).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
      const src = entry.source === "runner" ? '<span style="color:var(--accent2);font-size:10px">⚙ auto</span> ' : "";
      const detail = results.length
        ? '<div style="margin-top:4px;padding-left:8px;color:var(--text2);font-size:11px">' +
            results.map(r => (r.name||r.id) + " · " + (r.code||"") + " → " +
              (r.ok ? '<span style="color:var(--green)">✓</span>'
                    : '<span style="color:'+(((r.err||'').includes("already"))?'var(--text3)':'var(--enemy)')+'">'+(r.err||"fail")+'</span>')
            ).join("<br>") + '</div>'
        : "";
      return '<div style="border-bottom:1px solid var(--border);padding:8px 0">' +
        '<div style="font-size:12px">' + src +
          '<span style="color:var(--text3)">' + when + '</span> · ' +
          '<strong>' + codes + '</strong> · ' +
          '<span style="color:var(--green)">' + okN + ' ✓</span>' +
          (skipN ? ' <span style="color:var(--text3)">' + skipN + ' already</span>' : '') +
          (failN ? ' <span style="color:var(--enemy)">' + failN + ' ✗</span>' : '') +
        '</div>' + detail +
      '</div>';
    }).join('');
  } catch(e) {
    logEl.innerHTML = '<div style="color:var(--enemy)">Could not load log.</div>';
  }
}

async function adminChangePassword(type) {
  const inputId = { rallyleader:'newRallyPw', r4r5:'newR4R5Pw', admin:'newAdminPw' }[type];
  const displayId = { rallyleader:'currentRallyPw', r4r5:'currentR4R5Pw', admin:'currentAdminPw' }[type];
  const newPw = document.getElementById(inputId).value.trim();
  if (!newPw) { toast('Enter a password first.'); return; }
  const res = await fetch('/state', { cache: 'no-store', headers: stateHeaders() });
  const data = res.ok ? await res.json() : {};
  data['pw_' + type] = newPw;
  await fetch('/state', { method: 'PUT', headers: stateHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(data) });
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
    window._adminPlayers = Object.values(data.players || {});
    adminRenderMembers();
  } catch(e) { el.innerHTML = '<div style="color:var(--enemy)">Error loading members.</div>'; }
}
function _escHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function adminRenderMembers() {
  const el = document.getElementById('adminMemberList');
  if (!el) return;
  let players = window._adminPlayers || [];
  const cntEl = document.getElementById('adminMemberCount');
  if (cntEl) cntEl.textContent = '(' + players.length + ')';
  const q = (document.getElementById('adminMemberSearch') || {value:''}).value.trim().toLowerCase();
  if (q) players = players.filter(p => String(p.name||'').toLowerCase().indexOf(q) >= 0 || String(p.id||'').indexOf(q) >= 0);
  if (!players.length) { el.innerHTML = '<div style="color:var(--text3)">' + (q ? 'No members match "' + _escHtml(q) + '".' : 'No registered players yet.') + '</div>'; return; }
  const byAlliance = {};
  players.forEach(p => { const a = p.alliance || 'Unknown'; (byAlliance[a] = byAlliance[a] || []).push(p); });
  const roleLabels = { admin:'⚙️ Admin', r4r5:'🛡 R4/R5', rallyleader:'⚔️ Rally Leader', member:'👤 Member' };
  const mobile = window.innerWidth <= 900;
  let html = '';
  Object.keys(byAlliance).sort().forEach(alliance => {
    html += '<div style="margin-bottom:16px">';
    html += '<div class="sec-title" style="margin-bottom:8px">' + _escHtml(alliance) + ' <span style="color:var(--text3);font-weight:400">(' + byAlliance[alliance].length + ')</span></div>';
    if (mobile) {
      html += byAlliance[alliance].map(p => {
        const opts = ALLIANCES.map(a => '<option value="' + a + '"' + (a === p.alliance ? ' selected' : '') + '>' + a + '</option>').join('');
        return '<div style="display:flex;align-items:center;gap:8px;background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:8px 10px;margin-bottom:6px">' +
          '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _escHtml(p.name) + '</div>' +
          '<div class="mono" style="font-size:11px;color:var(--text3)">' + _escHtml(p.id) + ' · ' + (roleLabels[p.role] || '👤 Member') + '</div></div>' +
          '<select onchange="adminChangeAlliance(&quot;' + _escHtml(p.id) + '&quot;,this.value)" style="width:72px;font-size:12px">' + opts + '</select>' +
          '<button class="btn btn-danger btn-sm" style="padding:6px 10px" onclick="adminRemovePlayer(&quot;' + _escHtml(p.id) + '&quot;)">✕</button></div>';
      }).join('');
    } else {
      html += '<table style="min-width:500px"><thead><tr><th>IGN</th><th>Player ID</th><th>Role</th><th>Alliance</th><th></th></tr></thead><tbody>';
      html += byAlliance[alliance].map(p => {
        const opts = ALLIANCES.map(a => '<option value="' + a + '"' + (a === p.alliance ? ' selected' : '') + '>' + a + '</option>').join('');
        return '<tr>' +
          '<td><strong>' + _escHtml(p.name) + '</strong></td>' +
          '<td class="mono" style="color:var(--text3)">' + _escHtml(p.id) + '</td>' +
          '<td>' + (roleLabels[p.role] || '👤 Member') + '</td>' +
          '<td><select onchange="adminChangeAlliance(&quot;' + _escHtml(p.id) + '&quot;,this.value)" style="width:80px">' + opts + '</select></td>' +
          '<td><button class="btn btn-danger btn-sm" onclick="adminRemovePlayer(&quot;' + _escHtml(p.id) + '&quot;)">✕</button></td>' +
          '</tr>';
      }).join('');
      html += '</tbody></table>';
    }
    html += '</div>';
  });
  el.innerHTML = mobile ? html : '<div style="overflow-x:auto">' + html + '</div>';
}

async function adminChangeAlliance(playerId, newAlliance) {
  try {
    await fetch('/update-player', { method: 'POST', headers: stateHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ id: playerId, alliance: newAlliance }) });
    toast('Alliance updated.');
  } catch(e) { toast('Error updating alliance.'); }
}

function msSetMyAlliance(){
  const sel = document.getElementById('msMyAllianceSelect');
  if(!sel || !sel.value){ toast('Pick an alliance first.'); return; }
  const a = sel.value;
  if(typeof AUTH!=='undefined') AUTH.alliance = a;
  lsSet('alliance', a);
  // Fill the alliance field
  const msA=document.getElementById('msAlliance'); if(msA) msA.value=a;
  // Also fill the in-game name from the verified player (so validation passes)
  const vp = verifiedPlayer || (()=>{ try{ const s=sessionStorage.getItem('verifiedPlayer'); return s?JSON.parse(s):null; }catch(e){ return null; } })();
  const msN=document.getElementById('msIGN');
  if(msN && !msN.value && vp && vp.name) msN.value = vp.name;
  toast('Alliance set to '+a+(msN&&msN.value?' · name '+msN.value:'')+' — you can now submit.');
  if(typeof msInit==='function') msInit();
}

async function adminRemovePlayer(playerId) {
  var _p = (window._adminPlayers || []).find(function(x){ return String(x.id) === String(playerId); });
  if (!confirm('Remove ' + (_p ? _p.name + ' (' + playerId + ')' : 'this player') + '? They will need to re-register.')) return;
  try {
    await fetch('/remove-player', { method: 'POST', headers: stateHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ id: playerId }) });
    toast('Player removed.');
    adminLoadMembers();
  } catch(e) { toast('Error removing player.'); }
}

async function adminReset(what) {
  var labels = { ministers:'minister submissions', leaders:'rally leaders', teams:'teams', attendance:'attendance data', all:'EVERYTHING' };
  var nSubs = (MS.submissions||[]).length, nLead = (S.leaders||[]).length, nTeams = (S.teams||[]).length;
  var detail;
  if (what === 'ministers') detail = nSubs + ' submission' + (nSubs===1?'':'s');
  else if (what === 'leaders') detail = nLead + ' leader' + (nLead===1?'':'s');
  else if (what === 'teams') detail = nTeams + ' team' + (nTeams===1?'':'s');
  else if (what === 'attendance') detail = 'all Swordland + Tri Alliance events';
  else detail = nSubs + ' submissions, ' + nLead + ' leaders, ' + nTeams + ' teams and all attendance';
  if (what === 'all') {
    var typed = prompt('⚠️ This wipes ' + detail + '.\\n\\nType RESET to confirm.');
    if (typed !== 'RESET') { toast('Reset cancelled.'); return; }
  } else {
    if (!confirm('Reset ' + labels[what] + '? This deletes ' + detail + '.')) return;
  }
  // Snapshot for one-shot undo (kept in memory for 10 seconds)
  window._adminResetSnapshot = { what: what,
    ms: JSON.parse(JSON.stringify({ subs: MS.submissions||[], byPlayer: MS.submissionsByPlayer||{}, alloc: MS._lastAllocation||null })),
    leaders: JSON.parse(JSON.stringify(S.leaders||[])),
    teams: JSON.parse(JSON.stringify(S.teams||[])),
    att: JSON.parse(JSON.stringify(ATT)) };
  if (what === 'ministers' || what === 'all') { MS.submissions = []; MS.submissionsByPlayer = {}; MS._lastAllocation = null; }
  if (what === 'leaders' || what === 'all') { S.leaders = []; if (typeof renderLeaderTable==='function') renderLeaderTable(); }
  if (what === 'teams' || what === 'all') { S.teams = []; if (typeof renderSetup==='function') renderSetup(); if (typeof renderBattleStrategy==='function') renderBattleStrategy(); }
  if (what === 'attendance' || what === 'all') { ATT.sw = { members:[], events:[] }; ATT.ta = { members:[], events:[] }; }
  syncQueuePush();
  toast('Reset complete.');
  adminShowUndo();
}
function adminShowUndo() {
  var el = document.getElementById('adminResetUndo'); if (!el) return;
  var secs = 10;
  el.innerHTML = '<button class="btn btn-ghost btn-sm" style="border-color:var(--gold);color:var(--gold)" onclick="adminUndoReset()">↩ Undo (' + secs + 's)</button>';
  clearInterval(window._adminUndoTimer);
  window._adminUndoTimer = setInterval(function() {
    secs--;
    var b = el.querySelector('button');
    if (secs <= 0) { clearInterval(window._adminUndoTimer); el.innerHTML = ''; window._adminResetSnapshot = null; return; }
    if (b) b.textContent = '↩ Undo (' + secs + 's)';
  }, 1000);
}
function adminUndoReset() {
  var s = window._adminResetSnapshot; if (!s) { toast('Nothing to undo.'); return; }
  var w = s.what;
  if (w === 'ministers' || w === 'all') { MS.submissions = s.ms.subs; MS.submissionsByPlayer = s.ms.byPlayer; MS._lastAllocation = s.ms.alloc; }
  if (w === 'leaders' || w === 'all') { S.leaders = s.leaders; if (typeof renderLeaderTable==='function') renderLeaderTable(); }
  if (w === 'teams' || w === 'all') { S.teams = s.teams; if (typeof renderSetup==='function') renderSetup(); if (typeof renderBattleStrategy==='function') renderBattleStrategy(); }
  if (w === 'attendance' || w === 'all') { ATT.sw = s.att.sw; ATT.ta = s.att.ta; }
  window._adminResetSnapshot = null;
  clearInterval(window._adminUndoTimer);
  var el = document.getElementById('adminResetUndo'); if (el) el.innerHTML = '';
  syncQueuePush();
  toast('Reset undone ✓');
}
function adminTogglePw(id) {
  var i = document.getElementById(id); if (!i) return;
  i.type = i.type === 'password' ? 'text' : 'password';
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
      btn.style.background = t === tab ? 'rgba(201,165,92,.2)' : '';
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
    'style="background:rgba(201,165,92,.2);color:var(--accent2);border:1px solid var(--accent)">📋 Signed Up (' + (evt.signedUp||[]).length + ')</button>' +
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
      tEl.style.background = p === panel ? 'rgba(201,165,92,.2)' : '';
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
    // Guide for Signed Up tab
    if (field === 'signedUp') {
            html += '<div style="background:var(--bg4);border:1px solid var(--border);border-radius:7px;padding:12px 14px;margin-bottom:10px;font-size:12px">';
      html += '<div style="font-weight:600;color:var(--text);margin-bottom:10px">📸 How to scan signed-up players</div>';
      html += '<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">';
      html += '<img src="data:image/jpeg;base64,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" style="width:140px;border-radius:6px;border:1px solid var(--border);flex-shrink:0" alt="Legion Combatants guide">';
      html += '<div style="flex:1;min-width:160px">';
      html += '<ol style="color:var(--text2);line-height:2.1;margin:0;padding-left:16px">';
      html += '<li>Open <strong>Legion Combatants</strong> in-game</li>';
      html += '<li>Take a screenshot — scroll down and take more if needed</li>';
      html += '<li><span style="color:var(--green)">✅ Fully visible rows</span> will be read correctly</li>';
      html += '<li><span style="color:var(--enemy)">❌ Cut-off rows</span> (like the bottom one in the example) cannot be read — scroll down and screenshot again</li>';
      html += '<li>The scanner only looks at the right side: <span style="color:var(--green)"><strong>Join</strong></span> = added, <span style="color:var(--enemy)"><strong>No engagements</strong></span> = skipped</li>';
      html += '</ol>';
      html += '<div style="margin-top:8px;color:var(--text3);font-size:11px">💡 Select multiple screenshots at once — all processed together.</div>';
      html += '</div></div></div>';
    }

    const inputId = 'ocrFile-' + prefix + '-' + evt.id + '-' + field;
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">';
    html += '<input type="file" accept="image/*" multiple style="display:none" id="' + inputId + '" onchange="attRunOCR(\\'' + prefix + '\\',\\'' + evt.id + '\\',\\'' + field + '\\',this)">';
    html += '<button class="btn btn-primary btn-sm" onclick="attOpenScanner(\\'' + inputId + '\\')">📸 Scan Screenshot</button>';
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
// Reset file input so same file can be re-selected, and handle cancel gracefully
function attOpenScanner(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = ''; // reset so onchange fires even if same file selected again
  input.click();
}

async function attRunOCR(prefix, eventId, field, fileInput) {
  const files = Array.from(fileInput.files || []);
  // Reset input immediately so retry works even with same file
  fileInput.value = '';

  const previewEl = document.getElementById('ocrPreview-' + prefix + '-' + eventId + '-' + field);

  if (!files.length) {
    // User cancelled — clear any previous scanning message
    if (previewEl) previewEl.style.display = 'none';
    return;
  }
  if (previewEl) { previewEl.style.display = 'block'; previewEl.innerHTML = '<div style="color:var(--text3);font-size:12px">🔍 Scanning ' + files.length + ' image(s)…</div>'; }
  try {
    await ensureTesseract();
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
// PSM 11 (sparse text) correctly reads "Join" and "No" as separate isolated lines.
// Logic: find player name → look ahead up to 6 lines for "Join" (✅) or "No" (❌).
// Handles numeric names like "1913", multi-word names like "Lord Help Us",
// and noise prefixes like "i Ride" → "Ride", "pee Lord Help Us" → "Lord Help Us".
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

  const HEADER   = /combatant|combata|30\\/|2\\/10|squad|power|substitute|ph\\s*join/i;
  const JOIN_RE  = /^join$/i;
  const NO_RE    = /^no$/i;
  // Power number: has comma+digits pattern like "1,774" or "51,768" or 5+ plain digits
  const POWER_RE = /\\d,\\d{3}|\\d{5,}/;
  // Short pure number = valid player name (like "1913")
  const SHORT_NUM = /^\\d{2,4}$/;
  // Single-word noise tokens (OCR artifacts, UI words)
  const NOISE_W  = /^(voted|join|no|substitute|squad|power|legion|engagements|dispatched|combatants?|ts|im|j|fi|ons|its|fat|ons|pe|bg|ie|sy|sif|par|bn|rr|ic|fe|be|or|le|the|ay|sy|iy|pee|ons|oye|ones|aa|fa|sl|y|f|r|w)$/i;
  const WORD_RE  = /^[A-Za-z][A-Za-z0-9_\\-]{1,}$/;

  function extractName(rawLine) {
    // Strip leading non-alphanumeric chars (symbols, OCR noise)
    let s = rawLine.replace(/^[^A-Za-z0-9]+/, '');
    // Strip leading short noise word (1-3 chars) like "i ", "pee ", "> V"
    s = s.replace(/^[a-zA-Z]{1,3}\\s+/, '').trim();
    if (SHORT_NUM.test(s)) return s;
    const words = s.split(/\\s+/).filter(w =>
      (WORD_RE.test(w) || SHORT_NUM.test(w)) && !NOISE_W.test(w)
    );
    return words.length ? words.join(' ') : null;
  }

  function isPlayerLine(rawLine) {
    const s = rawLine.trim();
    if (HEADER.test(s)) return false;
    if (JOIN_RE.test(s) || NO_RE.test(s)) return false;
    if (POWER_RE.test(s)) return false;
    const name = extractName(s);
    return !!(name && name.length >= 2);
  }

  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isPlayerLine(lines[i])) continue;
    const name = extractName(lines[i]);
    if (!name) continue;

    let status = null;
    for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
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
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Current: <span class="mono">•••••</span> <span style="font-size:11px">(hidden — server never sends passwords)</span></div>
      <div class="row" style="margin-bottom:8px"><div class="field" style="flex:1"><label>New password</label><input type="password" id="newRallyPw" style="width:100%"></div><button class="btn btn-ghost btn-sm" style="align-self:flex-end;margin-left:6px" onclick="adminTogglePw('newRallyPw')" title="Show/hide">👁</button></div>
      <button class="btn btn-primary btn-sm" onclick="adminChangePassword('rallyleader')">Save</button>
    </div>
    <div class="card">
      <div class="card-title">🛡 R4/R5 Password</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Current: <span class="mono">•••••</span> <span style="font-size:11px">(hidden — server never sends passwords)</span></div>
      <div class="row" style="margin-bottom:8px"><div class="field" style="flex:1"><label>New password</label><input type="password" id="newR4R5Pw" style="width:100%"></div><button class="btn btn-ghost btn-sm" style="align-self:flex-end;margin-left:6px" onclick="adminTogglePw('newR4R5Pw')" title="Show/hide">👁</button></div>
      <button class="btn btn-primary btn-sm" onclick="adminChangePassword('r4r5')">Save</button>
    </div>
    <div class="card">
      <div class="card-title">⚙️ Admin Password</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Current: <span class="mono">•••••</span> <span style="font-size:11px">(hidden — server never sends passwords)</span></div>
      <div class="row" style="margin-bottom:8px"><div class="field" style="flex:1"><label>New password</label><input type="password" id="newAdminPw" style="width:100%"></div><button class="btn btn-ghost btn-sm" style="align-self:flex-end;margin-left:6px" onclick="adminTogglePw('newAdminPw')" title="Show/hide">👁</button></div>
      <button class="btn btn-primary btn-sm" onclick="adminChangePassword('admin')">Save</button>
    </div>
  </div>
  <!-- Members by Alliance -->
  <div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div class="card-title" style="margin:0">👥 Registered Members <span id="adminMemberCount" style="font-weight:400;font-size:12px;color:var(--text3)"></span></div>
      <button class="btn btn-ghost btn-sm" onclick="adminLoadMembers()">🔄 Refresh</button>
    </div>
    <input id="adminMemberSearch" placeholder="🔍 Search name or Player ID" oninput="adminRenderMembers()" style="width:100%;max-width:320px;margin-bottom:12px;font-size:13px">
    <div id="adminMemberList"><div style="color:var(--text3);font-size:13px">Loading…</div></div>
  </div>
  <!-- Gift Code -->
  <div class="card" style="margin-bottom:14px">
    <div class="card-title">🎁 Gift Code Auto-Redemption</div>
    <p style="color:var(--text2);font-size:12px;margin-bottom:14px">Redeems all active gift codes every 30 minutes for registered members.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <button class="btn btn-primary" id="adminRedeemBtn" onclick="adminRedeemNow()">🎁 Redeem Now for All Members</button>
      <button class="btn btn-ghost" onclick="adminLoadGiftLog()">📋 Refresh Log</button>
    </div>
    <div id="giftRedeemStatus" style="font-size:12px;color:var(--text3);margin-bottom:10px"></div>
    <div id="giftRedeemLog" style="font-size:12px;max-height:300px;overflow-y:auto"></div>
  </div>
  <!-- Reset -->
  <div class="card" style="border:1px solid rgba(224,58,58,.45)">
    <div class="card-title" style="color:#ff8080">🗑 Reset Data — danger zone</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-danger" onclick="adminReset('ministers')">Reset All Minister Submissions</button>
      <button class="btn btn-danger" onclick="adminReset('leaders')">Reset All Rally Leaders</button>
      <button class="btn btn-danger" onclick="adminReset('teams')">Reset All Teams</button>
      <button class="btn btn-danger" onclick="adminReset('attendance')">Reset All Attendance</button>
      <button class="btn btn-danger" onclick="adminReset('all')">⚠️ Reset EVERYTHING</button>
      <span id="adminResetUndo"></span>
    </div>
  </div>
</div>

<!-- SWORDLAND ATTENDANCE PAGE -->
<div id="page-swordland" class="page">
  <div class="card" style="margin-bottom:14px">
    <div class="card-title" style="font-size:20px">⚔️ Swordland Attendance</div>
    <p style="color:var(--text2);font-size:13px;margin-bottom:14px">Track attendance for Swordland events. R4/R5 manage events and mark attendance.</p>
    <div style="display:flex;gap:8px">
      <button class="btn" id="swTab-register" onclick="attSwitchTab('sw','register')" style="background:rgba(201,165,92,.2);color:var(--accent2);border:1px solid var(--accent)">📝 Register Attendance</button>
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
      <button class="btn" id="taTab-register" onclick="attSwitchTab('ta','register')" style="background:rgba(201,165,92,.2);color:var(--accent2);border:1px solid var(--accent)">📝 Register Attendance</button>
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

// ══════════════════════ SERVER-SIDE AUTH ══════════════════════
const AUTH_SECRET_KEY = 'auth_secret_v1';
const PW_DEFAULTS = { rallyleader: 'kvk1057rally', r4r5: 'kvk1057r4r5', admin: 'kvk1057admin' };
function _b64url(bytes){ let s=''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function _b64urlDecode(str){ const b = atob(str.replace(/-/g,'+').replace(/_/g,'/')); const a = new Uint8Array(b.length); for (let i=0;i<b.length;i++) a[i]=b.charCodeAt(i); return a; }
async function getAuthSecret(env){
  let s = await env.SVS_KV.get(AUTH_SECRET_KEY);
  if (!s){ s = _b64url(crypto.getRandomValues(new Uint8Array(32))); await env.SVS_KV.put(AUTH_SECRET_KEY, s); }
  return s;
}
async function _hmac(secret, msg){
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return _b64url(new Uint8Array(sig));
}
async function makeToken(env, role){
  const body = _b64url(new TextEncoder().encode(JSON.stringify({ role, exp: Date.now() + 43200000 }))); // 12h
  const sig = await _hmac(await getAuthSecret(env), body);
  return body + '.' + sig;
}
async function verifyToken(env, token){
  if (!token || token.indexOf('.') < 0) return null;
  const parts = token.split('.');
  const expect = await _hmac(await getAuthSecret(env), parts[0]);
  if (parts[1] !== expect) return null;
  let p; try { p = JSON.parse(new TextDecoder().decode(_b64urlDecode(parts[0]))); } catch(e){ return null; }
  if (!p || !p.exp || Date.now() > p.exp) return null;
  return p.role || null;
}
function stripPw(s){ if (s && typeof s==='object'){ delete s.pw_rallyleader; delete s.pw_r4r5; delete s.pw_admin; } return s; }
function bearer(request){ return (request.headers.get('Authorization')||'').replace(/^Bearer\s+/,''); }

// ═══════════════ DURABLE OBJECT: single source of truth ═══════════════
// All shared state (Battle Strategy + Minister Spots) lives here instead of KV.
// A Durable Object handles one request at a time and its storage is strongly
// consistent, so read-modify-write is atomic and there are no stale edge reads.
// State is cached in memory between requests, so reads cost zero storage rows.
function kingdomStub(env){
  return env.KINGDOM.get(env.KINGDOM.idFromName('1057'));
}

export class KingdomState {
  constructor(ctx, env){
    this.ctx = ctx;
    this.env = env;
    this.st = null;   // in-memory copy of the shared state
    this.rev = 0;     // bumped on every successful write
    this.ready = false;
  }

  // Loads state into memory once per wake. On the very first wake ever, seeds
  // itself from the legacy KV blob so no data is lost during the cutover.
  async init(){
    if (this.ready) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.ready) return;
      let st = await this.ctx.storage.get('state');
      let rv = await this.ctx.storage.get('rev');
      if (st === undefined || st === null){
        let seed = {};
        try {
          const raw = await this.env.SVS_KV.get(STATE_KEY);
          if (raw) seed = JSON.parse(raw) || {};
        } catch(e){ seed = {}; }
        st = seed; rv = 1;
        await this.ctx.storage.put({ state: st, rev: rv, seededAt: Date.now() });
      }
      this.st = st || {};
      this.rev = rv || 1;
      this.ready = true;
    });
  }

  async persist(){
    this.rev++;
    await this.ctx.storage.put({ state: this.st, rev: this.rev });
    return this.rev;
  }

  async fetch(request){
    await this.init();
    const url = new URL(request.url);

    if (url.pathname === '/rev'){
      return json({ ok:true, rev:this.rev });
    }

    if (url.pathname === '/get'){
      const out = stripPw(JSON.parse(JSON.stringify(this.st)));
      out._rev = this.rev;
      return json(out);
    }

    if (url.pathname === '/put'){
      let body = {}; try { body = await request.json(); } catch(e){}
      const role  = body.role || null;
      const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};
      const baseRev = (typeof body.baseRev === 'number') ? body.baseRev : null;
      const revBefore = this.rev;

      // ── Admin-only guards (moved here from the Worker: they need current state) ──
      // A bulk "Run Allocation" pass, clearing/reducing submissions, or changing the
      // manual deadline / KvK Day-1 override are Admin-only. A single manage-board edit
      // (assign/swap/pin/unpin/undo by R4/R5) is NOT flagged, so those still go through.
      const bulkAllocation = patch.msActionHint === 'runAllocation';
      const oldSubs = this.st.msSubmissionsByPlayer ? Object.keys(this.st.msSubmissionsByPlayer).length : 0;
      const subsReduced = ('msSubmissionsByPlayer' in patch)
        && (patch.msSubmissionsByPlayer ? Object.keys(patch.msSubmissionsByPlayer).length : 0) < oldSubs;
      const deadlineChanged = ('msDeadline' in patch)
        && (patch.msDeadline||null) !== (this.st.msDeadline||null);
      const overrideChanged = ('kvkDay1Override' in patch)
        && (patch.kvkDay1Override||null) !== (this.st.kvkDay1Override||null);
      if ((bulkAllocation || subsReduced || deadlineChanged || overrideChanged) && role !== 'admin'){
        return json({ ok:false, error:'admin-required' }, 403);
      }

      // The action hint is a one-shot signal for this write only — never persist it.
      delete patch.msActionHint;
      // Passwords are server-side only; a non-admin may never set them.
      if (role !== 'admin'){
        delete patch.pw_rallyleader; delete patch.pw_r4r5; delete patch.pw_admin;
      }

      // Merge only the keys the client actually changed. Keys it did not send are
      // left untouched — so a Battle Strategy edit can no longer erase a Minister
      // Spots submission that landed in the meantime.
      let touched = false;
      for (const k of Object.keys(patch)){
        if (k === '_rev' || k === '_baseRev') continue;
        this.st[k] = patch[k];
        touched = true;
      }
      if (touched) await this.persist();

      const conflict = (baseRev !== null && baseRev !== revBefore);
      const out = { ok:true, rev:this.rev, conflict:conflict };
      // Someone else wrote while this client was editing — hand back the merged
      // truth so it re-syncs immediately instead of waiting for the next poll.
      if (conflict){
        const s = stripPw(JSON.parse(JSON.stringify(this.st)));
        s._rev = this.rev;
        out.state = s;
      }
      return json(out);
    }

    if (url.pathname === '/automation'){
      const changed = msAutomationTick(this.st);
      if (changed) await this.persist();
      // Mirror to KV (~48 writes/day, far under the 1,000/day free-tier cap).
      // Pure insurance: a <=30-min-old rollback target if we ever need to revert.
      try { await this.env.SVS_KV.put(STATE_KEY, JSON.stringify(this.st)); } catch(e){}
      return json({ ok:true, rev:this.rev, changed:changed });
    }

    return json({ ok:false, error:'not-found' }, 404);
  }
}
// ═══════════════════════════════════════════════════════════════
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
    // ── Images from R2 bucket: GET /img/<key>  (e.g. /img/pets/cave-bear.png) ──
    if (url.pathname.startsWith('/img/') && request.method==='GET') {
      if (!env.IMG) return new Response('Image storage not configured (R2 binding "IMG" missing)', {status:500});
      const key = decodeURIComponent(url.pathname.slice(5));
      if (!key || key.includes('..')) return new Response('Bad key', {status:400});
      const inm = request.headers.get('If-None-Match');
      const obj = await env.IMG.get(key);
      if (!obj) return new Response('Image not found: ' + key, {status:404});
      if (inm && obj.httpEtag && inm === obj.httpEtag) {
        return new Response(null, {status:304, headers:{'ETag':obj.httpEtag,'Cache-Control':'public, max-age=86400, s-maxage=604800'}});
      }
      const ext = key.split('.').pop().toLowerCase();
      const types = {png:'image/png',webp:'image/webp',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',avif:'image/avif'};
      const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || types[ext] || 'application/octet-stream';
      return new Response(obj.body, { headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'ETag': obj.httpEtag || ''
      }});
    }

    if (url.pathname==='/update-player' && request.method==='POST') {
      const _role = await verifyToken(env, bearer(request));
      if (_role!=='admin' && _role!=='r4r5') return json({ok:false,error:'unauthorized'},401);
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
      const _role = await verifyToken(env, bearer(request));
      if (_role!=='admin' && _role!=='r4r5') return json({ok:false,error:'unauthorized'},401);
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
        let adminKey = null; try { adminKey = (await request.json()).adminKey; } catch(e) {}
        const state = await env.SVS_KV.get(STATE_KEY);
        const stateData = state ? JSON.parse(state) : {};
        const _tokRole = await verifyToken(env, bearer(request));
        const _keyOk = adminKey && adminKey === (stateData.pw_admin||'kvk1057admin');
        if (_tokRole !== 'admin' && !_keyOk) return json({ok:false,message:'Unauthorized'},401);
        const result = await runFull(env);
        return json(result);
      } catch(e) { return json({ok:false,message:e.message},500); }
    }
    
    // ── EXTERNAL REDEEMER (GitHub Actions) ──────────────────────────────────
    // Cloudflare Worker IPs are blocked by Century's gift-code API (every fetch
    // throws → "network error"), so the actual redeeming runs off-platform on a
    // runner with a non-datacenter IP. The Worker stays the source of truth for
    // the player list and the redeemed/log ledgers.
    if (url.pathname==='/gift-players' && request.method==='GET') {
      const secret = request.headers.get('X-Gift-Secret');
      if (!env.GIFT_SECRET || secret !== env.GIFT_SECRET) return json({ok:false,error:'unauthorized'},401);
      const raw = await env.SVS_KV.get(PLAYERS_KEY);
      const all = raw ? Object.values(JSON.parse(raw)) : [];
      const players = all.filter(p => p && p.id && Number(p.kingdom) === 1057);
      const redRaw = await env.SVS_KV.get(REDEEMED_KEY);
      const redeemed = redRaw ? JSON.parse(redRaw) : [];
      return json({ ok:true, players: players.map(p => ({ id:String(p.id), name:p.name||String(p.id) })), redeemed });
    }

    if (url.pathname==='/gift-report' && request.method==='POST') {
      const secret = request.headers.get('X-Gift-Secret');
      if (!env.GIFT_SECRET || secret !== env.GIFT_SECRET) return json({ok:false,error:'unauthorized'},401);
      try {
        const body = await request.json();
        const results = Array.isArray(body.results) ? body.results : [];
        const codes = Array.isArray(body.codes) ? body.codes : [];

        // Merge newly-settled pairs into the redeemed ledger
        const redRaw = await env.SVS_KV.get(REDEEMED_KEY);
        const redeemed = new Set(redRaw ? JSON.parse(redRaw) : []);
        let ok=0, skip=0, fail=0;
        for (const r of results) {
          if (!r || !r.id || !r.code) continue;
          if (r.ok) { redeemed.add(r.id + ':' + r.code); ok++; }
          else if (r.err === 'already used') { redeemed.add(r.id + ':' + r.code); skip++; }
          else fail++;
        }
        await env.SVS_KV.put(REDEEMED_KEY, JSON.stringify([...redeemed]));

        // Append to the same gift log the admin page already reads
        const logRaw = await env.SVS_KV.get(GIFT_LOG_KEY);
        const log = logRaw ? JSON.parse(logRaw) : [];
        log.unshift({
          time: new Date().toISOString(),
          codes,
          ok, skip, fail,
          source: 'runner',
          results: results.slice(0, 40).map(r => ({ name:r.name||r.id, id:r.id, code:r.code, ok:!!r.ok, err:r.err||null }))
        });
        await env.SVS_KV.put(GIFT_LOG_KEY, JSON.stringify(log.slice(0, 30)));

        return json({ ok:true, message:'Recorded '+ok+' redeemed, '+skip+' already used, '+fail+' failed.' });
      } catch(e) { return json({ok:false,error:e.message},400); }
    }

    // Gift redemption log
    if (url.pathname==='/gift-log' && request.method==='GET') {
      const _role = await verifyToken(env, bearer(request));
      if (!_role) return json({ok:false, error:'unauthorized'}, 401);
      const raw = await env.SVS_KV.get(GIFT_LOG_KEY);
      const log = raw ? JSON.parse(raw) : [];
      const display = log.map(e=>({
        time: e.time,
        code: (e.codes||[]).join(', '),
        results: (e.results||[]).map(r=>({name:r.name,ok:r.ok,err:r.err}))
      }));
      return json({log:display});
    }

    // ── AI Vision OCR for speedup screenshots ──
    if (url.pathname==='/ocr-speedups' && request.method==='POST') {
      const _role = await verifyToken(env, bearer(request));
      if (!_role) return json({ok:false, error:'unauthorized'}, 401);
      try {
        if (!env.AI) return json({ok:false, error:'AI binding not configured'}, 500);

        const body = await request.json();
        const imageBase64 = body.image; // base64 encoded image
        if (!imageBase64) return json({ok:false, error:'No image provided'}, 400);

        // Convert base64 to uint8array for the API
        const imageBytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));

        const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

        // Auto-agree to Meta license on first use (stored in KV)
        const agreedKey = 'llama_vision_agreed';
        const agreed = await env.SVS_KV.get(agreedKey);
        if (!agreed) {
          try {
            await env.AI.run(MODEL, { prompt: 'agree' });
            await env.SVS_KV.put(agreedKey, '1');
          } catch(e) { /* ignore - may already be agreed */ }
        }

const prompt = `You are reading a Kingshot mobile game screenshot of the "Overview: Resources & Speedups" popup, Speedups tab.
Read these 4 rows in this exact order: General Speedup, Soldier Training Speedup, Construction Speedup, Research Speedup.
Each row shows a time using some of: day(s), hr(s), min(s). Examples: "26 day(s)20 hr(s)49 min(s)", "523 hr(s)10 min(s)", "35 hr(s)".
Do NOT do any math. Just report the raw numbers you see for each row.
Ignore Learning Speedups, Soldier Healing, and everything below them.
Reply with ONLY one line of raw JSON, no explanation, no markdown. Use 0 for any unit not shown. Format exactly:
{"general":{"d":0,"h":0,"m":0},"training":{"d":0,"h":0,"m":0},"construction":{"d":0,"h":0,"m":0},"research":{"d":0,"h":0,"m":0}}`;

        const response = await env.AI.run(MODEL, {
          prompt,
          image: [...imageBytes],
          max_tokens: 400,
          temperature: 0.1
        });

        // Normalize the model output to a string no matter what shape it comes in
        let text = '';
        if (typeof response === 'string') {
          text = response;
        } else if (response && typeof response.response === 'string') {
          text = response.response;
        } else if (response && typeof response.result === 'string') {
          text = response.result;
        } else if (response && response.result && typeof response.result.response === 'string') {
          text = response.result.response;
        } else {
          text = JSON.stringify(response);
        }

// Convert raw {d,h,m} to decimal hours — WE do the math, not the AI
        const dhmToHours = (o) => {
          if (!o || typeof o !== 'object') return null;
          const d = Number(o.d) || 0, h = Number(o.h) || 0, m = Number(o.m) || 0;
          return Math.round((d * 24 + h + m / 60) * 100) / 100;
        };

        // Fallback: read raw d/h/m straight from the text for one labelled row
        const segToHours = (label) => {
          const re = new RegExp(label + '[^\\n]*', 'i');
          const mt = text.match(re);
          if (!mt) return null;
          const s = mt[0].replace(/,/g, '');
          const d = s.match(/(\d+)\s*day/i);
          const h = s.match(/(\d+)\s*hr/i);
          const mi = s.match(/(\d+)\s*min/i);
          if (!d && !h && !mi) return null;
          return dhmToHours({ d: d ? d[1] : 0, h: h ? h[1] : 0, m: mi ? mi[1] : 0 });
        };

        let values = null;

        // 1) Preferred: parse the {d,h,m} JSON the model returns, then convert
        const jsonMatch = text.match(/\{[\s\S]*general[\s\S]*\}/i);
        if (jsonMatch) {
          try {
            let p = JSON.parse(jsonMatch[0]);
            if (p.response && typeof p.response === 'object') p = p.response;
            if (p.general && typeof p.general === 'object') {
              values = {
                general: dhmToHours(p.general),
                training: dhmToHours(p.training),
                construction: dhmToHours(p.construction),
                research: dhmToHours(p.research)
              };
            } else if (typeof p.general === 'number') {
              values = p;
            }
          } catch (e) { /* fall through */ }
        }

        // 2) Fallback: scan the readable text row by row
        if (!values) {
          const g = segToHours('General Speedup');
          const t = segToHours('Soldier Training Speedup');
          const c = segToHours('Construction Speedup');
          const r = segToHours('Research Speedup');
          if (g !== null || t !== null || c !== null || r !== null) {
            values = { general: g, training: t, construction: c, research: r };
          }
        }

        if (!values) return json({ok:false, error:'Could not parse AI response', raw: text}, 422);

        // Ensure all 4 are numbers
        for (const c of ['general','training','construction','research']) {
          if (typeof values[c] !== 'number' || isNaN(values[c])) values[c] = 0;
        }

        return json({ok:true, values});
      } catch(e) {
        return json({ok:false, error:e.message}, 500);
      }
    }

    // Shared state
    if (url.pathname==='/auth' && request.method==='POST') {
      let b={}; try { b = await request.json(); } catch(e) {}
      const role = b.role, password = b.password, playerId = b.playerId;
      const stateRaw = await env.SVS_KV.get(STATE_KEY);
      let st={}; try { st = JSON.parse(stateRaw||'{}'); } catch(e){}
      if (role === 'member') {
        if (!playerId) return json({ok:false, error:'missing-id'}, 400);
        try {
          const r = await fetch(KINGSHOT_API+'/player-info?playerId='+encodeURIComponent(playerId), {headers:{Accept:'application/json'}});
          const d = await r.json();
          const p = (d && d.data) ? d.data : (d && d.status==='success' ? d.data : null);
          const kd = p ? (p.kingdom || p.kid || p.stove_lv || p.k) : null;
          if (!p) return json({ok:false, error:'not-found'}, 404);
          // accept if lookup returned a real player; kingdom check best-effort
          if (kd !== undefined && kd !== null && String(kd) !== '1057' && String(kd) !== '') {
            return json({ok:false, error:'not-1057'}, 403);
          }
        } catch(e) { return json({ok:false, error:'lookup-failed'}, 502); }
        return json({ok:true, role:'member', token: await makeToken(env, 'member')});
      }
      if (role === 'rallyleader' || role === 'r4r5' || role === 'admin') {
        const expected = st['pw_'+role] || PW_DEFAULTS[role];
        if (!password || password !== expected) return json({ok:false, error:'bad-password'}, 401);
        return json({ok:true, role, token: await makeToken(env, role)});
      }
      return json({ok:false, error:'bad-role'}, 400);
    }

    if (url.pathname==='/state' && request.method==='GET') {
      const role = await verifyToken(env, bearer(request));
      if (!role) return json({ok:false, error:'unauthorized'}, 401);
      const res = await kingdomStub(env).fetch('https://kingdom/get');
      return new Response(await res.text(), {status:res.status, headers:{'Content-Type':'application/json',...cors()}});
    }

    // Cheap revision probe — lets the client poll without shipping the whole state.
    if (url.pathname==='/rev' && request.method==='GET') {
      const role = await verifyToken(env, bearer(request));
      if (!role) return json({ok:false, error:'unauthorized'}, 401);
      const res = await kingdomStub(env).fetch('https://kingdom/rev');
      return new Response(await res.text(), {status:res.status, headers:{'Content-Type':'application/json',...cors()}});
    }
    if (url.pathname==='/state' && request.method==='PUT') {
      const role = await verifyToken(env, bearer(request));
      if (!role) return json({ok:false, error:'unauthorized'}, 401);
      const body = await request.text();
      let incoming; try { incoming = JSON.parse(body); } catch(e) { return json({error:'Invalid JSON'},400); }

      // New clients send { _baseRev, patch:{...only changed keys} }.
      // Older clients (a tab still running pre-deploy JS) send the full blob —
      // treat that as a patch containing every key, which behaves exactly as before.
      let patch, baseRev;
      if (incoming && typeof incoming.patch === 'object' && incoming.patch !== null){
        patch = incoming.patch;
        baseRev = (typeof incoming._baseRev === 'number') ? incoming._baseRev : null;
      } else {
        patch = incoming || {};
        baseRev = null;
        delete patch._baseRev;
      }

      const res = await kingdomStub(env).fetch('https://kingdom/put', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ role: role, baseRev: baseRev, patch: patch })
      });
      return new Response(await res.text(), {status:res.status, headers:{'Content-Type':'application/json',...cors()}});
    }

    if (request.method==='GET') return new Response(SITE_HTML,{headers:{'Content-Type':'text/html;charset=UTF-8',...cors()}});
    return new Response('Not found',{status:404,headers:cors()});
  },

// Cron: every 30 min — process next batch of 5 players, and check Minister Spots automation
  async scheduled(event, env, ctx) {
    // NOTE: gift-code redemption no longer runs here. Century's API refuses
    // connections from Cloudflare Worker IPs (fetch throws before any HTTP
    // response), so redeeming is done by the GitHub Actions runner, which calls
    // /gift-players and /gift-report. Minister automation still runs here.
    ctx.waitUntil(kingdomStub(env).fetch('https://kingdom/automation', {method:'POST'})
      .catch(function(e){ console.error('ms automation failed:', e && e.message); }));
  }
};
