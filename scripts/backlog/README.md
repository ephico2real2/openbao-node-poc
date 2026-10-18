# Backlog generator

`data.py` is the backlog: epics, features and stories with acceptance criteria and
evidence. Two scripts turn it into the two places people read it:

```bash
python3 scripts/backlog/issues.py   # create or update the GitHub issues (gh CLI, REST API)
python3 scripts/backlog/render.py   # write docs/modernization/backlog.md with the issue links
```

`issues.py` is idempotent. It remembers each item's issue in `issue-numbers.json`, updates
titles, labels, bodies and open/closed state, and links sub-issues (epic → feature →
story). Titles start with the track, `APP:` or `TUTORIAL:`. Parked work also gets the
`parked` label. An item is closed only when it is done and every acceptance criterion is
checked.
