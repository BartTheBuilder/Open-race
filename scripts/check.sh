#!/usr/bin/env bash
# Quick pre-commit sanity checks - not a real test suite (this project has no
# build/test toolchain), but catches the concrete mistakes that came up
# repeatedly while building this app by hand: merge-conflict markers left in
# a file, an id referenced in app.js with no matching element in index.html
# (or vice versa - a leftover unused id), and load-time JS errors (undefined
# references, typos) via a real parse+execute under gjs against a DOM stub.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
fail=0

echo "== conflict markers =="
if grep -rnE '^(<{7}|={7}|>{7})' app.js index.html style.css README.md 2>/dev/null; then
  echo "FAIL: merge conflict markers found"
  fail=1
else
  echo "OK"
fi

echo "== id cross-check (app.js getElementById <-> index.html id=) =="
js_ids=$(grep -oE "getElementById\('[^']+'\)" app.js | sed -E "s/getElementById\('([^']+)'\)/\1/" | LC_ALL=C sort -u)
html_ids=$(grep -oE 'id="[^"]+"' index.html | sed -E 's/id="([^"]+)"/\1/' | LC_ALL=C sort -u)
missing_in_html=$(comm -23 <(echo "$js_ids") <(echo "$html_ids"))
if [ -n "$missing_in_html" ]; then
  echo "FAIL: app.js references ids with no matching element in index.html:"
  echo "$missing_in_html" | sed 's/^/  - /'
  fail=1
else
  echo "OK (every getElementById id exists in index.html)"
fi
unused_in_js=$(comm -13 <(echo "$js_ids") <(echo "$html_ids"))
if [ -n "$unused_in_js" ]; then
  echo "INFO: index.html ids not referenced via getElementById in app.js (fine if CSS-only, e.g. page/tab ids):"
  echo "$unused_in_js" | sed 's/^/  - /'
fi

echo "== brace/paren balance (app.js) =="
python3 -c "
src = open('app.js').read()
ob, cb = src.count('{'), src.count('}')
op, cp = src.count('('), src.count(')')
ok = ob == cb and op == cp
print(f'braces {ob}/{cb}  parens {op}/{cp}  ->', 'OK' if ok else 'FAIL')
exit(0 if ok else 1)
" || fail=1

echo "== gjs load smoke test (app.js against DOM/Leaflet stub) =="
if command -v gjs >/dev/null 2>&1; then
  gjs "$REPO_DIR/scripts/smoke-test.js" "$REPO_DIR/scripts/smoke-test.js" || fail=1
else
  echo "SKIP: gjs not installed"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All checks passed."
else
  echo "One or more checks FAILED - see above."
fi
exit "$fail"
