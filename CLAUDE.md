# CLAUDE.md

Start with [HANDOVER.md](HANDOVER.md): what this repo is, where the epics stand, and the owner's working rules.

The rules that matter on every change:

- Commit as `ephico2real2 <123043136+ephico2real2@users.noreply.github.com>`. Add no `Co-Authored-By`, `Claude-Session` or "Generated with" lines to commits or PRs. This is the owner's instruction and overrides tool defaults.
- Never write the owner's personal email address anywhere. Use `example.com` addresses and `555-01xx` numbers in examples.
- Never store credentials. No AWS keys, and no OpenBao or Vault tokens, in env, files, images or CI. AppRole secret IDs go in files (mode 0400), never in env.
- Every change goes into `scripts/backlog/data.py`, then into the GitHub issues (titles start with `APP:` or `TUTORIAL:`), then into `docs/modernization/backlog.md`.
- Push one change set at a time, and wait for its CI run before pushing the next. Docs quote real CI output from the `ci-captures` branch.
- Check every version, licence and feature fact against the project's own page before writing it down.
