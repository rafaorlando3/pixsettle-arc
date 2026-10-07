# v4 panel check with asserts (v3 + replay as first event shows Unknown, never None). Needs: `npx hardhat node` on :8545 and one fresh demo-flow run whose JSON output
# is in /tmp/flow-parsed.json. Serves a copy of web/index.html with the testnet RPC pointed at the local node.
# Covers: full range, published deploy, empty window after activity, replay-only start, close/return-only start,
# two inverted loads, and an old error arriving after a new success. Exit code 1 on any failed expectation.
import json, os, re, subprocess, sys, threading, time, urllib.request, http.server, functools
from playwright.sync_api import sync_playwright

RPC = "http://127.0.0.1:8545"
def rpc(m, p):
    r = urllib.request.urlopen(urllib.request.Request(RPC, json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(), {"content-type": "application/json"}))
    return json.load(r)["result"]
flow = json.load(open("/tmp/flow-parsed.json"))
L = flow["ledger"].lower()
B = {s["l"].split(" ")[0]: int(s["block"]) for s in flow["steps"]}
deploy = next(n for n in range(B["approve"], -1, -1) if rpc("eth_getCode", [L, hex(n - 1)]) in ("0x", None)) if rpc("eth_getCode", [L, hex(B["approve"])]) != "0x" else None
for _ in range(3): rpc("evm_mine", [])
latest = int(rpc("eth_blockNumber", []), 16)

src = open(os.path.join(os.path.dirname(__file__), "..", "web", "index.html")).read()
d = "/tmp/panelv4"; os.makedirs(d, exist_ok=True)
base_html = src.replace("https://rpc.testnet.arc.io", RPC)
if os.environ.get("PANEL_NO_GUARD"):  # negative control: without the load guard the inverted-load checks must fail
    base_html = base_html.replace("const live = () => seq === current;", "const live = () => true;").replace("if (controller) controller.abort();", "")
open(f"{d}/index.html", "w").write(base_html)
pub_html = re.sub(r"const PUBLISHED = \{[^\n]*\};",
    f'const PUBLISHED = {{ mainnet: null, testnet: {{ address: "{L}", deployBlock: {deploy}n, deployTx: "0x{"ab"*32}" }} }};', base_html, count=1)
assert pub_html != base_html
open(f"{d}/published.html", "w").write(pub_html)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8766), functools.partial(http.server.SimpleHTTPRequestHandler, directory=d))
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails, out = [], {}
def check(name, cond, info):
    out[name] = info
    print(("OK   " if cond else "FAIL ") + name, json.dumps(info, ensure_ascii=False)[:400])
    if not cond: fails.append(name)

def read(pg):
    return dict(status=pg.inner_text("#status"), cov=pg.inner_text("#cov") if pg.is_visible("#cov") else "",
                covcls=pg.get_attribute("#cov", "class"), settled=pg.inner_text("#cSettled"), vol=pg.inner_text("#cVolume"),
                rep=pg.inner_text("#cReplay"), exp=pg.inner_text("#cExposure"), ret=pg.inner_text("#cReturned"),
                rows=pg.inner_text("#rows"), cards=pg.is_visible("#cards"))

def node_ref(n):
    return subprocess.check_output(["node", "-e", f'const v=require("viem");console.log(v.keccak256(v.toHex("demo-{flow["run"]}-{n}")))'], text=True).strip()
REFS = {}
def ref(n):
    if n not in REFS: REFS[n] = node_ref(n)
    return REFS[n]
def short(h): return h[:10] + "\u2026" + h[-6:]
def rows_of(r): return [x.split("\t") for x in r["rows"].split("\n") if "\t" in x]
def row_of(r, h):
    return next((x for x in rows_of(r) if x[0] == short(h)), None)
def chain_state(n):
    out = subprocess.check_output(["node", "tools/local-call.cjs", L, "0x0000000000000000000000000000000000000000", "state", flow["run"], str(n)], text=True)
    return json.loads(out)["state"]

def go(pg, page, frm, wait=2500):
    pg.goto(f"http://127.0.0.1:8766/{page}?net=testnet&address={L}&from={frm}")
    pg.wait_for_function("!document.getElementById('status').textContent.startsWith('Loading')", timeout=15000)
    pg.wait_for_timeout(200)
    return read(pg)

with sync_playwright() as p:
    b = p.chromium.launch()
    for w in (375, 768, 1280):
        pg = b.new_page(viewport={"width": w, "height": 900})
        r = go(pg, "index.html", deploy)
        hs = pg.evaluate("document.documentElement.scrollWidth>window.innerWidth")
        os.makedirs("/tmp/webtest", exist_ok=True); pg.screenshot(path=f"/tmp/webtest/painel-v4-{w}.png", full_page=True)
        check(f"range-from-deploy-{w}", r["settled"] == "2" and r["vol"] == "0.20" and r["rep"] == "1" and r["exp"] == "0.00"
              and r["ret"] == "0.10" and r["cov"].startswith("Range only") and r["covcls"] == "partial" and not hs, {**r, "hscroll": hs})
        pg.close()
    pg = b.new_page(viewport={"width": 375, "height": 900})
    r = go(pg, "published.html", deploy)
    check("published-deploy-full-history", r["cov"].startswith("Full history") and r["covcls"] == "" and r["exp"] == "0.00", r)
    r = go(pg, "published.html", latest)
    check("published-empty-window-is-not-zero", "not a zero balance" in r["rows"] and r["settled"] == "0", r)
    r = go(pg, "index.html", latest)
    check("empty-window-after-activity", r["exp"] == "unknown" and "not a zero balance" in r["rows"] and "earlier blocks were not read" in r["rows"]
          and r["cov"].startswith("Range only"), r)
    r = go(pg, "index.html", B["2"])
    o1row = row_of(r, ref(1))
    check("replay-only-start", "1 order(s) have events whose start is before" in r["cov"] and r["status"] and r["settled"] == "1"
          and o1row is not None and o1row[1] == "Unknown" and not any(x[1].startswith("None") for x in rows_of(r)), {**r, "order1": o1row})
    r = go(pg, "index.html", B["4d"])
    check("return-and-close-only-start", "1 order(s)" in r["cov"] and r["exp"] in ("unknown", "0.00 +?") and r["ret"] == "0.10"
          and "Closed (history before range)" in r["rows"], r)
    r = go(pg, "index.html", B["4b"])
    check("exposure-opened-without-settlement", "+?" in r["exp"] and "(history before range)" in r["rows"], r)

    # Two loads, the first one slow: only the second may reach the page. The delay is injected in the page
    # (wrapped fetch with setTimeout), so the second load really finishes first; a blocking route handler
    # would serialize both loads and test nothing.
    slow_from = hex(deploy)
    for mode in ("success", "error"):
        pg2 = b.new_page(viewport={"width": 768, "height": 900})
        pg2.add_init_script("""(() => { const f = window.fetch; window.__delayed = 0;
          window.fetch = async (url, opt) => {
            const body = (opt && opt.body) || "";
            if (body.includes('"eth_getLogs"') && body.includes('"fromBlock":"%s"')) {
              window.__delayed++; await new Promise((r) => setTimeout(r, 1500));
              if ("%s" === "error") return new Response("boom", { status: 500 });
            }
            return f(url, opt);
          }; })();""" % (slow_from, mode))
        pg2.goto("http://127.0.0.1:8766/index.html?net=testnet")
        pg2.evaluate(f'() => {{ load("testnet", "{L}", "{deploy}"); }}')  # do not await: both loads in flight
        pg2.wait_for_timeout(150)
        pg2.evaluate(f'() => {{ load("testnet", "{L}", "{B["4d"]}"); }}')
        pg2.wait_for_timeout(600)
        mid = pg2.inner_text("#status")
        pg2.wait_for_timeout(2500)
        r = read(pg2); n = pg2.evaluate("window.__delayed")
        check(f"inverted-loads-old-{mode}-ignored", n >= 1 and f"blocks {B['4d']} to" in mid and f"blocks {B['4d']} to" in r["status"]
              and r["settled"] == "0" and r["ret"] == "0.10" and r["cards"] and "500" not in r["status"],
              {**r, "delayed_requests": n, "second_done_first": mid})
        pg2.close()

    # v4: replay as the FIRST event in the range for orders whose real state is Settled, Exposure and Closed.
    # Order 5 is settled and put in exposure only for this check; then orders 1, 4 and 5 are replayed.
    OPS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
    call = lambda fn, n: json.loads(subprocess.check_output(["node", "tools/local-call.cjs", L, OPS, fn, flow["run"], str(n)], text=True))
    call("settleLike1", 5); call("openRefundCase", 5)
    rp = [call("replay", n) for n in (1, 4, 5)]
    first = min(int(x["block"]) for x in rp)
    real = {n: chain_state(n) for n in (1, 4, 5)}
    check("chain-states-before-replay-check", real == {1: 1, 4: 4, 5: 3}, real)
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    r = go(pg, "index.html", first)
    rows = {n: row_of(r, ref(n)) for n in (1, 4, 5)}
    check("replay-first-settled-exposure-closed-are-unknown", r["rep"] == "3" and r["settled"] == "0" and len(rows_of(r)) == 3
          and all(rows[n] is not None and rows[n][1] == "Unknown" for n in rows)
          and "3 order(s) have events whose start is before" in r["cov"] and r["exp"] == "0.00 +?",
          {**r, "rows_by_order": rows, "chain": real})
    r = go(pg, "index.html", deploy)
    full = {n: (row_of(r, ref(n)) or [None, None])[1] for n in (1, 3, 4, 5)}
    check("full-flow-keeps-real-states", full == {1: "Settled", 3: "Closed", 4: "Closed", 5: "Exposure"} and r["rep"] == "4"
          and r["exp"] == "0.10" and "Unknown" not in r["rows"], {**r, "states": full})
    pg.close()
    b.close()
srv.shutdown()
json.dump(out, open("/tmp/panel-v4-result.json", "w"), ensure_ascii=False, indent=1)
print("deploy", deploy, "latest", latest, "fails", fails)
sys.exit(1 if fails else 0)
