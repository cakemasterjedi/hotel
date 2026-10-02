#!/usr/bin/env bash
# Stop hook: when Claude finishes a reply, commit any changes and push the
# current branch to GitHub. Prints a one-line status for the user.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

branch=$(git branch --show-current)
[ -n "$branch" ] || exit 0                       # detached HEAD: nothing to push

say() { printf '{"systemMessage": "%s"}\n' "$1"; }

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  files=$(git diff --cached --name-only | head -5 | xargs -n1 basename 2>/dev/null | paste -sd, - | sed 's/,/, /g')
  count=$(git diff --cached --name-only | wc -l | tr -d ' ')
  trailer="Co-Authored-By: Claude <noreply@anthropic.com>"
  if [ -n "${CLAUDE_CODE_REMOTE_SESSION_ID:-}" ]; then
    trailer="$trailer
Claude-Session: https://claude.ai/code/session_${CLAUDE_CODE_REMOTE_SESSION_ID#cse_}"
  fi
  git commit -q -m "Auto-commit: update ${files}$([ "$count" -gt 5 ] && echo " and $((count - 5)) more")

$trailer" || { say "Auto-push: commit failed"; exit 0; }
fi

# Push only if there is something the remote doesn't have yet.
if git rev-parse --verify -q "origin/$branch" >/dev/null && [ -z "$(git log "origin/$branch..HEAD" --oneline)" ]; then
  exit 0
fi

for delay in 0 2 4 8 16; do
  sleep "$delay"
  if git push -q -u origin "$branch" 2>/tmp/auto-push.err; then
    say "Auto-pushed $(git rev-parse --short HEAD) to $branch"
    exit 0
  fi
  grep -qiE 'network|timed out|could not resolve|connection|RPC failed|unexpected disconnect' /tmp/auto-push.err || break
done
say "Auto-push to $branch failed: $(head -1 /tmp/auto-push.err | tr '"' "'")"
exit 0
