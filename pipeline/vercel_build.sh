#!/bin/sh
# Vercel build (see vercel.json). Builds the web app, and copies the build image's libexpat into lib/ for the
# "Land here" function (api/site.py): the rasterio wheel needs it and the function image does not have it.
set -e
mkdir -p lib
for f in /usr/lib64/libexpat.so.1 /lib64/libexpat.so.1 /usr/lib/x86_64-linux-gnu/libexpat.so.1; do
  if [ -e "$f" ]; then cp -L "$f" lib/libexpat.so.1; break; fi
done
if [ ! -e lib/libexpat.so.1 ] && command -v dnf >/dev/null 2>&1; then
  dnf install -y -q expat >/dev/null 2>&1 && cp -L /usr/lib64/libexpat.so.1 lib/libexpat.so.1 || true
fi
ls -la lib/ || true
cd web && npm run build
