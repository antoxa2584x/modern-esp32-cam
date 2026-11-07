"""Builds dist/camera-demo.html: the web UI plus demo/demo.js in one file that
runs without a camera (open it from disk or host it anywhere).

    python scripts/build_demo.py
"""
import os
import re
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*p):
    return open(os.path.join(ROOT, *p), encoding="utf-8").read()


html = read("web", "index.html")
css = read("web", "app.css")
app = read("web", "app.js")
demo = read("demo", "demo.js")
i18n = read("web", "i18n.js")
icon = "data:image/svg+xml;charset=utf-8," + urllib.parse.quote(read("web", "icon.svg").strip())

for s in (app, demo, i18n):
    assert "</script" not in s.lower(), "inline script would end early"

html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', "")
html = html.replace("<title>Камера</title>", "<title>Демо камери</title>")
html = html.replace('<link rel="stylesheet" href="app.css">', "<style>\n" + css + "</style>")
html = html.replace('<script src="i18n.js" defer></script>\n', "")
html = html.replace('<script src="app.js" defer></script>\n', "")
html = html.replace('href="icon.svg"', 'href="' + icon + '"')
app = app.replace("'icon.svg'", "'" + icon + "'")
scripts = "".join("<script>\n" + js + "</script>\n" for js in (i18n, demo, app))
html = html.replace("</body>", scripts + "</body>")

out = os.path.join(ROOT, "dist", "camera-demo.html")
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, "w", encoding="utf-8", newline="\n").write(html)
print("wrote", out, len(html.encode("utf-8")), "bytes")

# The same without the document skeleton, for hosts that add their own
# (Claude artifacts): title + styles first, then the body content.
head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
head = re.sub(r'\s*<meta (charset|name="viewport")[^>]*>', "", head)
fragment = head.strip() + "\n" + body.strip() + "\n"
out = os.path.join(ROOT, "dist", "camera-demo-fragment.html")
open(out, "w", encoding="utf-8", newline="\n").write(fragment)
print("wrote", out)
