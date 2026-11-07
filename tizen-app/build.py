"""Empaqueta la app instalable: python tizen-app/build.py → tizen-app/TorBox.wgt (sin firmar;
TizenBrew Installer la firma con tu certificado al instalarla). Copia antes ../service.js."""
import os, shutil, zipfile
here = os.path.dirname(os.path.abspath(__file__))
shutil.copy(os.path.join(here, "..", "service.js"), os.path.join(here, "service.js"))
out = os.path.join(here, "TorBox.wgt")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in ["config.xml", "index.html", "icon.png", "service.js"]:
        z.write(os.path.join(here, f), f)
print("OK", out, os.path.getsize(out), "bytes")
