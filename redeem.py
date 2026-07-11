#!/usr/bin/env python3
import hashlib, json, os, sys, time, urllib.parse, urllib.request

WORKER = os.environ.get("WORKER_URL", "https://ks.kvk1057.workers.dev").rstrip("/")
SECRET = os.environ.get("GIFT_SECRET", "")
SALT = "tB87#kPtkxqOS2"
GIFTCODE_API = "https://ks-giftcode.centurygame.com/api"
KINGSHOT_API = "https://kingshot.net/api"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

def http(url, data=None, headers=None, timeout=30):
    hdrs = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if headers: hdrs.update(headers)
    body = None
    if data is not None:
        if isinstance(data, dict) and hdrs.get("Content-Type") == "application/json":
            body = json.dumps(data).encode()
        else:
            body = urllib.parse.urlencode(data).encode()
            hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
    req = urllib.request.Request(url, data=body, headers=hdrs, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def sign(fid, t):
    return hashlib.md5(f"fid={fid}&time={t}{SALT}".encode()).hexdigest()

def fetch_codes():
    try:
        d = http(f"{KINGSHOT_API}/gift-codes")
    except Exception as e:
        print(f"::warning::could not fetch codes: {e}")
        return []
    if d.get("status") != "success": return []
    now = time.time(); out = []
    for c in (d.get("data", {}) or {}).get("giftCodes", []) or []:
        exp = c.get("expiresAt")
        if exp:
            try:
                ts = time.mktime(time.strptime(exp[:19], "%Y-%m-%dT%H:%M:%S"))
                if ts <= now: continue
            except Exception: pass
        if c.get("code"): out.append(c["code"])
    return out

def redeem(fid, code, attempts=3):
    for a in range(1, attempts + 1):
        t = int(time.time() * 1000)
        try:
            d = http(f"{GIFTCODE_API}/redeem_code", data={
                "fid": str(fid), "code": code, "time": str(t), "sign": sign(fid, t),
            }, headers={
                "Origin": "https://ks-giftcode.centurygame.com",
                "Referer": "https://ks-giftcode.centurygame.com/",
            })
        except Exception as e:
            if a < attempts: time.sleep(2 * a); continue
            return {"ok": False, "err": f"network: {e}"}
        ec = d.get("err_code")
        if ec == 0: return {"ok": True}
        if ec == 40014: return {"ok": False, "err": "already used"}
        if ec == 40008: return {"ok": False, "err": "expired"}
        msg = str(d.get("msg", ""))
        if "TIMEOUT" in msg.upper() and a < attempts: time.sleep(2 * a); continue
        return {"ok": False, "err": f"{ec}: {msg or 'unknown'}"}
    return {"ok": False, "err": "exhausted"}

def main():
    if not SECRET:
        print("::error::GIFT_SECRET is not set"); return 1
    hdr = {"X-Gift-Secret": SECRET}
    try:
        info = http(f"{WORKER}/gift-players", headers=hdr)
    except Exception as e:
        print(f"::error::cannot reach worker: {e}"); return 1
    if not info.get("ok"):
        print(f"::error::worker refused: {info}"); return 1
    players = info.get("players", [])
    redeemed = set(info.get("redeemed", []))
    codes = fetch_codes()
    print(f"{len(players)} players in kingdom 1057 - {len(codes)} active codes")
    if not players or not codes:
        print("nothing to do"); return 0
    results = []
    for p in players:
        for c in codes:
            if f"{p['id']}:{c}" in redeemed: continue
            r = redeem(p["id"], c)
            results.append({"id": p["id"], "name": p.get("name", p["id"]), "code": c, "ok": r["ok"], "err": r.get("err")})
            print(f"  {p.get('name', p['id'])} - {c} -> {'OK' if r['ok'] else r.get('err')}")
            time.sleep(3)
    if not results:
        print("everyone already has every active code"); return 0
    rep = http(f"{WORKER}/gift-report", data={"codes": codes, "results": results}, headers={**hdr, "Content-Type": "application/json"})
    print(rep.get("message", rep))
    ok = sum(1 for r in results if r["ok"])
    print(f"redeemed {ok}/{len(results)} attempts")
    return 0

if __name__ == "__main__":
    sys.exit(main())
