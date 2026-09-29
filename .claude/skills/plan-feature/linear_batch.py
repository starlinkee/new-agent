#!/usr/bin/env python3
"""Create a dependency tree of Linear tickets safely for the Contrabass queue.

Contrabass starts every ticket that is not in Backlog within seconds, so the order matters:
  1. create every ticket in Backlog (idempotent by exact title, re-checked before any retry,
     so a timeout never produces duplicates),
  2. replace {{key}} placeholders in descriptions with the real identifiers (NEW-<N>),
  3. add every "blocks" relation,
  4. only then move the root tickets (no blockers) to Todo. Dependents stay in Backlog;
     scripts/linear_sync.py (promote_unblocked) moves each to Todo once all its blockers are merged.

Spec (JSON):
  {"project_url": "https://linear.app/<ws>/project/<slug>-<slugId>",   # optional, default: .contrabass/WORKFLOW.md
   "tickets": [{"key": "api", "title": "...", "description": "... {{api}} ..."}],
   "edges": [["api", "page"]]}                                           # blocker, blocked

Every blocked ticket's description must mention each blocker as {{key}}: the worker's
"Zero" precheck reads blockers from the description.

Usage: linear_batch.py spec.json [--dry-run] [--activate Todo|none]
Env:   LINEAR_API_KEY
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request


def gql(query, variables=None):
    last = None
    for attempt in range(6):
        try:
            req = urllib.request.Request(
                "https://api.linear.app/graphql",
                data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                headers={"Authorization": os.environ["LINEAR_API_KEY"], "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.load(r)
            if data.get("errors"):
                raise RuntimeError(data["errors"][0]["message"])
            return data["data"]
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            print(f"  linear unavailable ({e}), retry {attempt + 1}/6", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Linear unavailable: {last}")


def project_url_from_workflow():
    try:
        m = re.search(r"^project_url:\s*(\S+)", open(".contrabass/WORKFLOW.md").read(), re.M)
    except OSError:
        m = None
    if not m:
        sys.exit("no project_url in the spec and none in .contrabass/WORKFLOW.md")
    return m.group(1)


def resolve_project(url):
    slug_id = url.rstrip("/").split("/")[-1].split("-")[-1]
    nodes = gql(
        """query($s:String!){projects(filter:{slugId:{eq:$s}}){nodes{id name
        teams{nodes{id key states{nodes{id name type}}}}}}}""",
        {"s": slug_id},
    )["projects"]["nodes"]
    if not nodes:
        sys.exit(f"Linear project {slug_id} not found")
    p = nodes[0]
    team = p["teams"]["nodes"][0]
    return p, team, {s["name"]: s["id"] for s in team["states"]["nodes"]}


def project_issues(project_id):
    d = gql(
        """query($p:String!){project(id:$p){issues(first:250){nodes{id identifier title url state{name}
        inverseRelations{nodes{type issue{identifier}}}}}}}""",
        {"p": project_id},
    )
    return {n["title"]: n for n in d["project"]["issues"]["nodes"]}


def topo_order(keys, edges):
    deps = {k: {a for a, b in edges if b == k} for k in keys}
    order, done = [], set()
    while len(order) < len(keys):
        ready = [k for k in keys if k not in done and deps[k] <= done]
        if not ready:
            sys.exit("dependency cycle in edges")
        order += ready
        done |= set(ready)
    return order


def validate(spec):
    keys = [t["key"] for t in spec["tickets"]]
    if len(set(keys)) != len(keys):
        sys.exit("duplicate ticket keys")
    if len({t["title"] for t in spec["tickets"]}) != len(keys):
        sys.exit("duplicate titles (titles are the idempotency key)")
    for a, b in spec["edges"]:
        if a not in keys or b not in keys:
            sys.exit(f"edge {a}->{b} uses an unknown key")
    by_key = {t["key"]: t for t in spec["tickets"]}
    for a, b in spec["edges"]:
        if "{{" + a + "}}" not in by_key[b]["description"]:
            sys.exit(f"ticket '{b}' is blocked by '{a}' but its description does not mention {{{{{a}}}}}")
    for t in spec["tickets"]:
        for ref in re.findall(r"\{\{(\w+)\}\}", t["description"]):
            if ref not in keys:
                sys.exit(f"ticket '{t['key']}' references unknown key {{{{{ref}}}}}")
    return keys, topo_order(keys, spec["edges"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--activate", default="Todo", help="state to move the tickets to at the end, or 'none'")
    args = ap.parse_args()
    if not os.environ.get("LINEAR_API_KEY"):
        sys.exit("LINEAR_API_KEY is not set")

    spec = json.load(open(args.spec, encoding="utf-8"))
    keys, order = validate(spec)
    project, team, states = resolve_project(spec.get("project_url") or project_url_from_workflow())
    if "Backlog" not in states or (args.activate != "none" and args.activate not in states):
        sys.exit(f"missing state; team has {sorted(states)}")
    print(f"project {project['name']} / team {team['key']}; activation order: {' -> '.join(order)}")
    if args.dry_run:
        for k in order:
            t = next(t for t in spec["tickets"] if t["key"] == k)
            blockers = [a for a, b in spec["edges"] if b == k]
            print(f"  [{k}] {t['title']}  blocked by: {', '.join(blockers) or '-'}")
        return

    by_key = {t["key"]: t for t in spec["tickets"]}
    existing = project_issues(project["id"])

    # 1. create in Backlog, never twice: after a failed create, look the title up before retrying
    ids = {}
    for k in order:
        title = by_key[k]["title"]
        while title not in existing:
            try:
                d = gql(
                    """mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{id identifier title url state{name}}}}""",
                    {"i": {"teamId": team["id"], "projectId": project["id"], "stateId": states["Backlog"],
                           "title": title, "description": by_key[k]["description"]}},
                )
                existing[title] = {**d["issueCreate"]["issue"], "inverseRelations": {"nodes": []}}
                print(f"  created {existing[title]['identifier']} {title}", flush=True)
            except RuntimeError as e:
                print(f"  create failed ({e}); re-checking before retry", flush=True)
                existing = project_issues(project["id"])
        ids[k] = existing[title]
    ident = {k: ids[k]["identifier"] for k in keys}

    # 2. real identifiers in the descriptions
    for k in keys:
        desc = re.sub(r"\{\{(\w+)\}\}", lambda m: ident[m.group(1)], by_key[k]["description"])
        gql("""mutation($id:String!,$i:IssueUpdateInput!){issueUpdate(id:$id,input:$i){success}}""",
            {"id": ids[k]["id"], "i": {"description": desc}})

    # 3. relations (skip the ones that exist)
    for a, b in spec["edges"]:
        have = {r["issue"]["identifier"] for r in ids[b]["inverseRelations"]["nodes"] if r["type"] == "blocks"}
        if ident[a] in have:
            continue
        gql("""mutation($a:String!,$b:String!){issueRelationCreate(input:{issueId:$a,relatedIssueId:$b,type:blocks}){success}}""",
            {"a": ids[a]["id"], "b": ids[b]["id"]})
        print(f"  {ident[a]} blocks {ident[b]}", flush=True)

    # 4. activate only the roots (no blockers). Dependents stay in Backlog: Contrabass does not treat a
    #    Backlog/In Review blocker as open, and a dependent it starts early fails the worker's precheck and is
    #    retried again and again. linear_sync.py promote_unblocked moves them to Todo once every blocker's PR is merged.
    if args.activate != "none":
        blocked = {b for _, b in spec["edges"]}
        for k in order:
            if k in blocked or ids[k]["state"]["name"] != "Backlog":
                continue
            gql("""mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}""",
                {"id": ids[k]["id"], "s": states[args.activate]})
            print(f"  {ident[k]} -> {args.activate}", flush=True)

    final = project_issues(project["id"])
    print("\nresult:")
    for k in order:
        n = final[by_key[k]["title"]]
        blockers = sorted(r["issue"]["identifier"] for r in n["inverseRelations"]["nodes"] if r["type"] == "blocks")
        print(f"  {n['identifier']:8} {n['state']['name']:12} {n['title']}  blocked by: {', '.join(blockers) or '-'}  {n['url']}")


if __name__ == "__main__":
    main()
