"""The AI jury's verdict comment: written by run_jury.py, read by run_merge_doctor.py.

Every verdict names the head commit it reviewed, in a hidden marker on its first line:

    <!-- ai-jury verdict=APPROVED sha=<40 hex> -->

A verdict counts only for exactly that commit, so it can never be applied to code pushed
after the review, and no other comment (a doctor summary quoting "STATUS: APPROVED", say)
is ever mistaken for one. scripts/linear_sync.py parses the same marker; keep them in sync.
"""
import re

MARKER_RE = re.compile(r"<!-- ai-jury verdict=(APPROVED|REJECTED) sha=([0-9a-f]{40}) -->")


def marker(status, sha):
    return f"<!-- ai-jury verdict={status} sha={sha} -->"
