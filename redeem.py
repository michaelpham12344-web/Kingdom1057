#!/usr/bin/env python3
"""Kingdom 1057 gift-code redeemer — corrected against real browser capture."""
import hashlib, json, os, sys, time, urllib.parse, urllib.request

WORKER = os.environ.get("WORKER_URL", "https://ks.kvk1057.workers.dev").rstrip("/")
SECRET = os.environ.get("GIFT_SECRET", "")
SALT = "mN4!pQs6JrYwV9"
API = "https://kingshot-giftcode.centurygame.com/api"
KINGSHOT_API = "https://kingshot.net/api"

# Headers the real browser sends — Origin/Referer matter for the WAF.
API_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://ks-giftcode.centurygame.com",
    "Referer": "https://ks-giftcode.centurygame.com/",
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"),
}

def _post(path, fields):
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(API + path, data=body, headers=API_HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def sign_fields(fields):
    """sign = md5 of URL-decoded params sorted alphabetically by key, concatenated k=v&..., + SALT.
    (captcha_code is included even when empty, matching the browser.)"""
    parts = "&".join(f"{k}={fields[k]}" for k in sorted(fields))
    return hashlib.md5((parts + SALT).encode()).hexdigest()

def login(fid):
    t = int(time.time() * 1000)
    f = {"fid": str(fid), "time": str(t)}
    f["sign"] = sign_fields(f)
    return _post("/player", f)

def redeem(fid, cdk):
    t = int(time.time() * 1000)
    f = {"captcha_code": "", "cdk": cdk, "fid": str(fid), "time": str(t)}
    f["sign"] = sign_fields(f)
    return _post("/gift_code", f)

def classify(resp):
    ec = resp.get("err_code")
    msg = (resp.get("msg") or "").strip()
    if ec in (20000,):                    return True,  "OK"
    if ec in (40008,):                    return False, "expired"
    if "TYPE EXCHANGE" in msg.upper():    return False, "already used"       # 40011
    if ec in (40014,) or "RECEIVED" in msg.upper(): return False, "already used"
    if "CDK NOT FOUND" in msg.upper() or ec in (40007,): return False, "invalid code"
    if "TIME ERROR" in msg.upper():       return False, "retry"
    if "CAPTCHA" in msg.upper():          return False, "CAPTCHA REQUIRED"
    if resp.get("code") == 0:             return True,  "OK"
    return False, f"{ec}: {msg or 'unknown'}"

def fetch_codes():
    try:
        d = json.load(urllib.request.urlopen(
            urllib.request.Request(f"{KINGSHOT_API}/gift-codes",
                                   headers={"User-Agent": API_HEADERS["User-Agent"]}), timeout=30))
    except Exception as e:
        print(f"::warning::could not fetch codes: {e}"); return []
    if d.get("status") != "success": return []
    now = time.time(); out = []
    for c in (d.get("data", {}) or {}).get("giftCodes", []) or []:
        exp = c.get("expiresAt")
        if exp:
            try:
                if time.mktime(time.strptime(exp[:19], "%Y-%m-%dT%H:%M:%S")) <= now: continue
            except Exception: pass
        if c.get("code"): out.append(c["code"])
    return out

def main():
    if not SECRET:
        print("::error::GIFT_SECRET not set"); return 1
    hdr = {"X-Gift-Secret": SECRET}
    try:
        info = json.load(urllib.request.urlopen(
            urllib.request.Request(f"{WORKER}/gift-players", headers=hdr), timeout=30))
    except Exception as e:
        print(f"::error::cannot reach worker: {e}"); return 1
    if not info.get("ok"):
        print(f"::error::worker refused: {info}"); return 1

    players  = info.get("players", [])
    redeemed = set(info.get("redeemed", []))
    codes    = fetch_codes()
    print(f"{len(players)} players in kingdom 1057 - {len(codes)} active codes")
    if not players or not codes:
        print("nothing to do"); return 0

    results = []
    for p in players:
        try:
            login(p["id"]); time.sleep(1)
        except Exception as e:
            print(f"  {p.get('name',p['id'])} - login failed: {e}")
        for c in codes:
            if f"{p['id']}:{c}" in redeemed: continue
            try:
                ok, label = classify(redeem(p["id"], c))
            except Exception as e:
                ok, label = False, f"network: {e}"
            results.append({"id": p["id"], "name": p.get("name", p["id"]),
                            "code": c, "ok": ok, "err": None if ok else label})
            print(f"  {p.get('name', p['id'])} - {c} -> {label}")
            time.sleep(3)

    if not results:
        print("everyone already has every active code"); return 0
    rep = json.load(urllib.request.urlopen(urllib.request.Request(
        f"{WORKER}/gift-report", data=json.dumps({"codes": codes, "results": results}).encode(),
        headers={**hdr, "Content-Type": "application/json"}, method="POST"), timeout=30))
    print(rep.get("message", rep))
    print(f"redeemed {sum(1 for r in results if r['ok'])}/{len(results)} attempts")
    return 0

if __name__ == "__main__":
    sys.exit(main())
      
