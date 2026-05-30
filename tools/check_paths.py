"""
Path-integrity checker for the frontend.

Scans web/index.html, web/views/**, web/js/** for asset references and asserts
each resolves to a file that exists. Guards the module-folder reorg against a
missed path update.

Checks:
  - any quoted string  'js/...'.js | 'views/...'.html | 'css/...'.css   (web-root relative)
  - import('./relative.js')                                            (file-dir relative)
  - sidebar nav  data-target="X"  ->  views/X.html exists
  - BTT_VIEW_SCRIPTS keys           ->  views/<key>.html exists

Exit code != 0 if any reference dangles.

Run:  .venv\\Scripts\\python.exe tools\\check_paths.py
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"

FILES = [WEB / "index.html"] + sorted((WEB / "views").rglob("*.html")) + sorted((WEB / "js").rglob("*.js"))
CSS_FILES = sorted((WEB / "css").rglob("*.css"))

# Quoted web-root-relative asset refs, e.g. 'js/x.js', "views/a/b.html", 'css/x.css'
RE_WEBREF = re.compile(r"""['"]((?:js|views|css)/[^'"]+?\.(?:js|html|css))['"]""")
# Relative dynamic imports, e.g. import('./file_manager.js')
RE_IMPORT = re.compile(r"""import\(\s*['"](\.\.?/[^'"]+?\.js)['"]\s*\)""")
# CSS @import url('...') / @import "..." (resolved relative to the css file's dir)
RE_CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?['"]([^'"]+?\.css)['"]""")
# Sidebar nav targets
RE_TARGET = re.compile(r"""data-target=['"]([a-z_]+)['"]""")
# BTT_VIEW_SCRIPTS keys (top-level keys of the object literal)
RE_VS_BLOCK = re.compile(r"BTT_VIEW_SCRIPTS\s*=\s*\{(.*?)\n\s*\};", re.DOTALL)
RE_VS_KEY = re.compile(r"^\s*([a-z_]+)\s*:", re.MULTILINE)

dangling = []  # (referrer, ref, resolved)


def check(referrer: Path, ref: str, base: Path):
    # ignore urls / template-literal fragments
    if "${" in ref or ref.startswith(("http:", "https:", "//")):
        return
    target = (base / ref).resolve()
    if not target.exists():
        dangling.append((referrer.relative_to(ROOT).as_posix(), ref, target.relative_to(ROOT).as_posix() if ROOT in target.parents else str(target)))


for f in FILES:
    src = f.read_text(encoding="utf-8")
    for m in RE_WEBREF.finditer(src):
        check(f, m.group(1), WEB)
    for m in RE_IMPORT.finditer(src):
        check(f, m.group(1), f.parent)

# CSS @import are resolved relative to the importing stylesheet's directory
for f in CSS_FILES:
    src = f.read_text(encoding="utf-8")
    for m in RE_CSS_IMPORT.finditer(src):
        check(f, m.group(1), f.parent)

# nav targets -> views/<target>.html
index = (WEB / "index.html").read_text(encoding="utf-8")
for m in RE_TARGET.finditer(index):
    tgt = m.group(1)
    if not (WEB / "views" / f"{tgt}.html").exists():
        dangling.append(("index.html", f"data-target={tgt}", f"views/{tgt}.html"))

# BTT_VIEW_SCRIPTS keys -> views/<key>.html
main_js = (WEB / "js" / "main.js").read_text(encoding="utf-8")
block = RE_VS_BLOCK.search(main_js)
if block:
    for m in RE_VS_KEY.finditer(block.group(1)):
        key = m.group(1)
        if not (WEB / "views" / f"{key}.html").exists():
            dangling.append(("main.js BTT_VIEW_SCRIPTS", key, f"views/{key}.html"))

if dangling:
    print(f"FAIL - {len(dangling)} dangling reference(s):")
    for referrer, ref, resolved in dangling:
        print(f"  {referrer}: {ref}  ->  MISSING {resolved}")
    raise SystemExit(1)
print("PASS - all asset references resolve.")
