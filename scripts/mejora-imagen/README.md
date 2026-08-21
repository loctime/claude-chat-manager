# mejora-imagen (vendorizado)

Copia de `mejorar_imagen.py` traída adentro del repo para que el escáner de
documentos (`POST /api/scan` en `src/server.js`) sea autocontenido — antes
dependía de una carpeta hermana `../../mejora-imagen/` fuera de este repo,
que no estaba en git y no existía en el checkout de nadie más (Diego
incluido). Ver `docs/superpowers/specs/2026-08-17-escaner-documentos-design.md`.

La copia "fuente" (con el historial completo de hallazgos y los otros
scripts de la carpeta, como `leer_documento.py` para OCR) sigue viviendo en
`/mnt/c/Users/Fernando/Desktop/claude/mejora-imagen/` — esa carpeta no es un
repo git y se usa también fuera del escáner (remitos, facturas sueltas). Si
se corrige un bug en la detección de documento ahí, replicar el cambio acá
a mano (o al revés) — no hay symlink ni submódulo, son dos copias.

## Dependencias

```bash
bash setup.sh   # instala opencv-python-headless
```

## Uso standalone

```bash
python3 mejorar_imagen.py "ruta/imagen.jpg" "carpeta/salida/" --json
```
