"""Empaqueta la app en un solo JS y un solo CSS (arranque rápido de la app instalada).

    python tools/bundle.py

Lee app/index.html, concatena EN ORDEN todos los <script src> locales en app/dist/app.js y todos los
<link rel="stylesheet"> en app/dist/app.css, y genera app/dist/index.html (misma estructura, pero con
app.css / app.js). El cargador de tizen-app/index.html usa <tag>/app/dist/* si existen; si no, los
archivos sueltos. Ejecútalo SIEMPRE antes de publicar una etiqueta (y sube app/dist/ al repo).
Si hay Node disponible, valida la sintaxis del bundle con `node --check`.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
DIST = os.path.join(APP, "dist")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def main():
    html = read(os.path.join(APP, "index.html"))
    links = re.findall(r'<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"', html)
    scripts = re.findall(r'<script[^>]+src="([^"]+)"', html)
    scripts = [s for s in scripts if "$WEBAPIS" not in s and not re.match(r"https?:", s)]

    m = re.search(r'App\.version\s*=\s*"([^"]+)"', read(os.path.join(APP, "js", "core.js")))
    version = m.group(1) if m else "?"

    os.makedirs(DIST, exist_ok=True)

    js_parts = ["/* TorBox bundle v%s — generado por tools/bundle.py, no editar */\n" % version]
    for s in scripts:
        p = os.path.join(APP, s)
        if not os.path.isfile(p):
            sys.exit("Falta el script %s" % s)
        src = read(p)
        src = re.sub(r"^//# sourceMappingURL=.*$", "", src, flags=re.M)
        if s.startswith("js/") or s.startswith("i18n/"):
            # un fallo de arranque en un módulo no debe impedir que carguen los siguientes (como con scripts sueltos)
            src = 'try{\n%s\n}catch(__e){ if(window.console) console.error("[bundle] %s", __e); }' % (src, s)
        js_parts.append("/* ==== %s ==== */\n%s\n;\n" % (s, src))
    js = "".join(js_parts)
    with open(os.path.join(DIST, "app.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(js)

    css_parts = ["/* TorBox bundle v%s */\n" % version]
    for l in links:
        p = os.path.join(APP, l)
        if not os.path.isfile(p):
            sys.exit("Falta el CSS %s" % l)
        css_parts.append("/* ==== %s ==== */\n%s\n" % (l, read(p)))
    css = "".join(css_parts)
    with open(os.path.join(DIST, "app.css"), "w", encoding="utf-8", newline="\n") as f:
        f.write(css)

    # index.html del bundle: el <head> sin los <link>, con app.css; el <body> sin los <script src> locales
    head_end = html.index("</head>")
    head = html[:head_end]
    head = re.sub(r'<link[^>]+rel="stylesheet"[^>]*>\s*', "", head)
    head += '<link rel="stylesheet" href="app.css">\n'
    body = html[head_end:]
    body = re.sub(r'<script[^>]+src="(?!\$WEBAPIS|https?:)[^"]+"[^>]*></script>\s*', "", body)
    body = body.replace("</body>", '<script src="app.js"></script>\n</body>')
    with open(os.path.join(DIST, "index.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(head + body)

    manifest = {
        "version": version,
        "js": len(scripts),
        "css": len(links),
        "bytes": {"app.js": len(js.encode("utf-8")), "app.css": len(css.encode("utf-8"))},
        "sha1": hashlib.sha1((js + css).encode("utf-8")).hexdigest()[:12],
    }
    with open(os.path.join(DIST, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=1)

    print("OK v%s: %d scripts -> app/dist/app.js (%d KB), %d css -> app/dist/app.css (%d KB)" % (
        version, len(scripts), manifest["bytes"]["app.js"] // 1024, len(links), manifest["bytes"]["app.css"] // 1024))

    node = shutil.which("node")
    if node:
        r = subprocess.run([node, "--check", os.path.join(DIST, "app.js")], capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr)
            sys.exit("El bundle tiene errores de sintaxis")
        print("node --check OK")
    else:
        print("(node no disponible: sintaxis sin validar)")


if __name__ == "__main__":
    main()
