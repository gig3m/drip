#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Send to drip
# @raycast.mode silent
# @raycast.packageName drip
# @raycast.icon 💧
# @raycast.description Upload the clipboard file/image (or Finder selection) to drip

# Raycast's GUI process may not inherit your shell PATH, so resolve drip explicitly:
# prefer PATH, then the default installer location (~/.local/bin/drip).
DRIP="$(command -v drip 2>/dev/null || echo "$HOME/.local/bin/drip")"
if [ ! -x "$DRIP" ]; then
  echo "drip not installed — run: curl -fsSL __DRIP_BASE_URL__/install.sh | sh"
  exit 1
fi

# Default: send whatever is on the clipboard (a copied file, or a screenshot/image).
# `drip clip` prints the URL on success and copies it; on failure (nothing on the
# clipboard) it exits non-zero and we fall back to the current Finder selection.
if "$DRIP" clip 2>/dev/null; then
  exit 0
fi

# Fallback: the current Finder selection as newline-separated POSIX paths.
sel=$(osascript <<'APPLESCRIPT' 2>/dev/null
tell application "Finder"
  set out to ""
  repeat with i in (selection as alias list)
    set out to out & POSIX path of i & linefeed
  end repeat
  return out
end tell
APPLESCRIPT
)

if [ -n "$sel" ]; then
  IFS=$'\n'
  set -- $sel
  unset IFS
  exec "$DRIP" "$@"
fi

echo "nothing to send — clipboard is empty and Finder has no selection"
exit 1
