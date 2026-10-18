import json, subprocess, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import EPICS, B

R = "ephico2real2/openbao-node-poc"
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "issue-numbers.json")

def api(method, path, body=None):
    cmd = ["gh", "api", "-X", method, f"repos/{R}/{path}", "-H", "Accept: application/vnd.github+json"]
    inp = None
    if body is not None:
        cmd += ["--input", "-"]
        inp = json.dumps(body)
    p = subprocess.run(cmd, input=inp, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(f"{method} {path}: {p.stdout} {p.stderr}")
    return json.loads(p.stdout) if p.stdout.strip() else None

LABELS = {
    "type:epic": ("5319e7", "An epic: a business outcome made of features"),
    "type:feature": ("1d76db", "A feature: a capability made of stories"),
    "type:story": ("0e8a16", "A user story with acceptance criteria"),
    "size:S": ("c5def5", "Up to a day"), "size:M": ("bfd4f2", "Up to three days"), "size:L": ("a2c4f0", "Up to a week"),
    "needs-aws-verification": ("fbca04", "Built and linted; confirm on a real AWS account"),
    "app": ("b60205", "APP track: modernizing the application (what the redesign changes)"),
    "tutorial": ("0052cc", "TUTORIAL track: building the tutorial, guides and demos about it"),
    "parked": ("d4c5f9", "Planned, not scheduled yet"),
}
for e in EPICS:
    LABELS[f"epic:{e['id']}"] = ("ededed", e["title"])

existing = {l["name"] for l in api("GET", "labels?per_page=100")}
for name, (color, desc) in LABELS.items():
    if name not in existing:
        api("POST", "labels", {"name": name, "color": color, "description": desc[:100]})

state = json.load(open(STATE)) if os.path.exists(STATE) else {}

def walk():
    for e in EPICS:
        yield e, None, None
        for f in e["children"]:
            yield f, e, None
            for s in f.get("children", []):
                yield s, e, f

def closed(item):
    own = all(c for c, _ in item.get("criteria", [])) and item.get("status") == "done"
    kids = item.get("children", [])
    if "criteria" not in item:  # grouping feature or epic: done when its children are
        return all(closed(k) for k in kids) if kids else item.get("status") == "done"
    return own and all(closed(k) for k in kids)

TRACK = {}
for _e in EPICS:
    for _i in [_e] + _e["children"] + [s for f in _e["children"] for s in f.get("children", [])]:
        TRACK[_i["id"]] = _i.get("track", _e["track"])

def title(item):
    return f"{TRACK[item['id']].upper()}: {item['id']} · {item['title']}"

def labels(item, epic):
    t = item.get("type", "epic")
    ls = [TRACK[item["id"]], f"type:{t}", f"epic:{(epic or item)['id']}"]
    if item.get("size"): ls.append(f"size:{item['size']}")
    if item.get("aws"): ls.append("needs-aws-verification")
    if (epic or item).get("parked"): ls.append("parked")
    return ls

# 1. create every issue once (placeholder body), remembering numbers and ids
for item, epic, feat in walk():
    if item["id"] in state:
        continue
    r = api("POST", "issues", {"title": title(item), "body": "_Being written from the backlog…_", "labels": labels(item, epic)})
    state[item["id"]] = {"number": r["number"], "id": r["id"]}
    json.dump(state, open(STATE, "w"), indent=1)
    time.sleep(1.2)

num = lambda i: state[i]["number"]
BACKLOG = f"{B}docs/modernization/backlog.md"

def body(item, epic, feat):
    lines = []
    up = []
    if epic and epic is not item: up.append(f"**Epic:** #{num(epic['id'])}")
    if feat: up.append(f"**Feature:** #{num(feat['id'])}")
    if up: lines += [" · ".join(up), ""]
    if "outcome" in item: lines += [f"**Outcome:** {item['outcome']}", ""]
    if item.get("story"): lines += [f"> {item['story']}", ""]
    if item.get("criteria"):
        lines += ["### Acceptance criteria", ""] + [f"- [{'x' if c else ' '}] {t}" for c, t in item["criteria"]] + [""]
    kids = item.get("children", [])
    if kids:
        lines += [f"### {'Features' if 'outcome' in item else 'Stories'}", ""]
        lines += [f"- [{'x' if closed(k) else ' '}] #{num(k['id'])}" for k in kids] + [""]
    if item.get("size"): lines += [f"**Size:** {item['size']}", ""]
    ev = item.get("evidence") or item.get("docs") or []
    if ev: lines += ["### Docs and evidence", ""] + [f"- {x}" for x in ev] + [""]
    if item.get("aws"): lines += ["⚠️ Built and linted in CI; one criterion needs a run on a real AWS account (the manual `aws (Part C)` workflow).", ""]
    lines += ["---", f"Source of truth for wording: the [backlog]({BACKLOG}) · [initiative]({B}docs/modernization/README.md)"]
    return "\n".join(lines)

# 2. bodies, sub-issue links, open/closed state
for item, epic, feat in walk():
    n = num(item["id"])
    is_closed = closed(item)
    api("PATCH", f"issues/{n}", {"title": title(item), "labels": labels(item, epic), "body": body(item, epic, feat), "state": "closed" if is_closed else "open",
                                 **({"state_reason": "completed"} if is_closed else {})})
    parent = feat or (epic if epic is not None and epic is not item else None)
    if parent and not state[item["id"]].get("linked"):
        try:
            api("POST", f"issues/{num(parent['id'])}/sub_issues", {"sub_issue_id": state[item["id"]]["id"], "replace_parent": True})
            state[item["id"]]["linked"] = True
        except RuntimeError as err:
            if "already" in str(err).lower() or "duplicate" in str(err).lower():
                state[item["id"]]["linked"] = True
            else:
                print("sub-issue link failed:", item["id"], str(err)[:200])
        json.dump(state, open(STATE, "w"), indent=1)
    time.sleep(0.8)

print(json.dumps({k: v["number"] for k, v in state.items()}))
