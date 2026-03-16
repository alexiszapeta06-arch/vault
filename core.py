"""
Vault — Core Handlers
registry.py + apk_handler.py + zip_handler.py en un solo archivo
para simplificar el despliegue dentro de Alpine.
"""

import os, json, time, stat, shutil, hashlib, tarfile, zipfile
import subprocess, tempfile
from pathlib import Path

# ═══════════════════════════════════════════════════════
# REGISTRY
# ═══════════════════════════════════════════════════════
VAULT_HOME  = Path("/home/vault")          # Dentro de Alpine
APPS_DIR    = VAULT_HOME / "apps"          # Apps Linux extraídas
APKS_DIR    = VAULT_HOME / "apks"          # Copias de APKs
REGISTRY_F  = VAULT_HOME / "registry" / "db.json"
SHORTCUTS   = VAULT_HOME / "shortcuts"     # Scripts de lanzamiento

for d in (APPS_DIR, APKS_DIR, SHORTCUTS, REGISTRY_F.parent):
    d.mkdir(parents=True, exist_ok=True)


def _load() -> dict:
    try:
        return json.loads(REGISTRY_F.read_text()) if REGISTRY_F.exists() else {}
    except Exception:
        return {}


def _save(data: dict):
    REGISTRY_F.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def all_apps() -> list:
    return sorted(_load().values(), key=lambda a: a.get("installed_at", 0), reverse=True)


def get_app(app_id: str) -> dict | None:
    return _load().get(app_id)


def register(meta: dict) -> dict:
    data = _load()
    data[meta["id"]] = {**meta, "updated_at": int(time.time())}
    _save(data)
    return data[meta["id"]]


def unregister(app_id: str) -> bool:
    data = _load()
    if app_id in data:
        del data[app_id]
        _save(data)
        return True
    return False


def make_id(filename: str) -> str:
    stem = Path(filename).stem.lower()
    # Quitar extensiones dobles como .tar
    stem = stem.replace(".tar", "").replace(".liberty", "")
    stem = "".join(c if c.isalnum() else "_" for c in stem)
    suffix = hashlib.sha1(filename.encode()).hexdigest()[:6]
    return f"{stem}_{suffix}"


# ═══════════════════════════════════════════════════════
# APK HANDLER
# ═══════════════════════════════════════════════════════
# Alpine no puede ejecutar APKs nativamente (son binarios
# Dalvik/ART para Android). Lo que sí podemos hacer:
#   - Guardar el APK en el volumen persistente
#   - Copiarlo a /sdcard/Download (accesible por Android)
#   - Lanzar el instalador nativo via termux-open
# El usuario toca "Instalar" en el diálogo del sistema.
# ═══════════════════════════════════════════════════════

SDCARD_DL = Path("/sdcard/Download")


class APKError(Exception):
    pass


def _apk_info(path: Path) -> dict:
    """Extrae package name y versión con aapt si está disponible."""
    info = {"label": path.stem, "version": "1.0", "package": None}
    try:
        out = subprocess.run(
            ["aapt", "dump", "badging", str(path)],
            capture_output=True, text=True, timeout=10
        ).stdout
        for line in out.splitlines():
            if line.startswith("package:"):
                for part in line.split():
                    if part.startswith("name="):
                        info["package"] = part.split("'")[1]
                    if part.startswith("versionName="):
                        info["version"] = part.split("'")[1]
            if line.startswith("application-label:"):
                info["label"] = line.split("'")[1]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return info


def install_apk(src: Path, original_name: str) -> dict:
    if not src.exists():
        raise APKError(f"Archivo no encontrado: {src}")

    app_id     = make_id(original_name)
    local_copy = APKS_DIR / f"{app_id}.apk"

    # 1 — Guardar en volumen persistente
    shutil.copy2(src, local_copy)

    # 2 — Copiar a /sdcard para que Android pueda instalarlo
    dl_path = SDCARD_DL / original_name
    try:
        SDCARD_DL.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dl_path)
    except PermissionError:
        raise APKError(
            "Sin acceso a /sdcard/Download. "
            "Ejecuta 'termux-setup-storage' en Termux y otorga el permiso."
        )

    info    = _apk_info(local_copy)
    launched = False

    # 3 — Lanzar instalador nativo de Android
    for cmd in [["termux-open", str(dl_path)], ["xdg-open", str(dl_path)]]:
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            launched = True
            break
        except FileNotFoundError:
            continue

    # 4 — Registrar
    meta = {
        "id":           app_id,
        "name":         info["label"] or Path(original_name).stem,
        "filename":     original_name,
        "type":         "apk",
        "version":      info["version"],
        "package":      info["package"],
        "icon":         "📦",
        "local_path":   str(local_copy),
        "dl_path":      str(dl_path),
        "installed_at": int(time.time()),
        "launched":     launched,
    }
    register(meta)

    return {
        "success": True,
        "app_id":  app_id,
        "name":    meta["name"],
        "launched": launched,
        "message": (
            "Instalador de Android abierto. Toca 'Instalar' para completar."
            if launched else
            f"APK guardado en {dl_path}. Ábrelo manualmente para instalar."
        ),
    }


def delete_apk(app_id: str) -> dict:
    app = get_app(app_id)
    if not app:
        raise APKError("APK no encontrado en el registry")
    for key in ("local_path", "dl_path"):
        p = Path(app.get(key, ""))
        if p.exists():
            p.unlink(missing_ok=True)
    unregister(app_id)
    return {"success": True, "message": f"'{app['name']}' eliminado del Vault"}


# ═══════════════════════════════════════════════════════
# ZIP / LINUX APP HANDLER
# ═══════════════════════════════════════════════════════

class ZipError(Exception):
    pass


def _unpack(src: Path, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    name = src.name.lower()
    if name.endswith((".tar.gz", ".tgz", ".liberty")):
        with tarfile.open(src) as tf:
            safe = [m for m in tf.getmembers()
                    if ".." not in m.name and not m.name.startswith("/")]
            tf.extractall(dest, members=safe)
    elif name.endswith(".zip"):
        with zipfile.ZipFile(src) as zf:
            safe = [n for n in zf.namelist()
                    if ".." not in n and not n.startswith("/")]
            zf.extractall(dest, members=safe)
    else:
        raise ZipError(f"Formato no soportado: {src.name}")

    contents = list(dest.iterdir())
    return contents[0] if len(contents) == 1 and contents[0].is_dir() else dest


_MANIFEST_DEFAULTS = {
    "name": None, "version": "1.0.0", "description": "",
    "category": "App", "icon": "🔧",
    "entrypoint": [], "env": {}, "requires": [],
}


def _read_manifest(root: Path, stem: str) -> dict:
    for fname in ("manifest.json", "vault.json", "liberty.json", "package.json"):
        mf = root / fname
        if mf.exists():
            try:
                return {**_MANIFEST_DEFAULTS, **json.loads(mf.read_text())}
            except Exception:
                pass
    return {**_MANIFEST_DEFAULTS,
            "name": stem.replace("-", " ").replace("_", " ").title(),
            "entrypoint": _detect_entry(root)}


def _detect_entry(root: Path) -> list:
    for name, pre in [
        ("start.sh",  ["/bin/sh"]), ("run.sh", ["/bin/sh"]),
        ("main.sh",   ["/bin/sh"]), ("main.py", ["python3"]),
        ("app.py",    ["python3"]), ("server.py", ["python3"]),
        ("index.js",  ["node"]),    ("main.js", ["node"]),
        ("main",      []),          ("app", []),
    ]:
        p = root / name
        if p.exists():
            return pre + [str(p)]
    for f in (root / "bin").iterdir() if (root / "bin").exists() else []:
        if f.is_file() and os.access(f, os.X_OK):
            return [str(f)]
    return ["/bin/echo", "Vault: sin entrypoint"]


def _fix_perms(paths: list):
    for p in paths:
        f = Path(p)
        if f.exists() and f.is_file():
            f.chmod(f.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)


def _install_deps(requires: list):
    if not requires:
        return
    apk = [r for r in requires if not r.startswith("pip:")]
    pip = [r[4:] for r in requires if r.startswith("pip:")]
    if apk:
        subprocess.run(["apk", "add", "--no-cache", "-q"] + apk,
                       capture_output=True)
    if pip:
        subprocess.run(["pip3", "install", "--quiet",
                        "--break-system-packages"] + pip,
                       capture_output=True)


def _create_shortcut(name: str, entrypoint: list,
                     app_dir: Path, env: dict) -> Path:
    """
    Crea un script ejecutable en /home/vault/shortcuts/<name>.sh
    Este directorio está en el volumen persistente y se sincroniza
    a ~/.shortcuts/ del host en cada arranque del servidor.
    """
    sc = SHORTCUTS / f"{name}.sh"
    env_lines = "\n".join(f'export {k}="{v}"' for k, v in env.items())
    cmd = " ".join(str(e) for e in entrypoint)
    sc.write_text(f"""#!/bin/sh
# Vault — {name}
cd "{app_dir}"
{env_lines}
clear
echo ""
echo "  ▶  {name}"
echo "  ──────────────────"
echo ""
{cmd}
""")
    sc.chmod(sc.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
    return sc


def install_zip(src: Path, original_name: str) -> dict:
    if not src.exists():
        raise ZipError(f"Archivo no encontrado: {src}")

    app_id   = make_id(original_name)
    stem     = Path(original_name).stem.replace(".tar", "").replace(".liberty", "")
    dest_dir = APPS_DIR / app_id

    if dest_dir.exists():
        shutil.rmtree(dest_dir)

    with tempfile.TemporaryDirectory() as tmp:
        app_root = _unpack(src, Path(tmp))
        shutil.copytree(app_root, dest_dir)

    manifest = _read_manifest(dest_dir, stem)
    if not manifest.get("name"):
        manifest["name"] = stem.replace("-", " ").replace("_", " ").title()

    # Reubicar entrypoint al destino final
    ep = manifest.get("entrypoint", [])
    fixed = []
    for part in ep:
        cand = dest_dir / Path(part).name
        fixed.append(str(cand) if cand.exists() else part)
    manifest["entrypoint"] = fixed
    _fix_perms(fixed)

    _install_deps(manifest.get("requires", []))

    sc = _create_shortcut(
        name       = manifest["name"],
        entrypoint = manifest["entrypoint"],
        app_dir    = dest_dir,
        env        = manifest.get("env", {}),
    )

    meta = {
        "id":          app_id,
        "name":        manifest["name"],
        "filename":    original_name,
        "type":        "linux",
        "version":     manifest.get("version", "1.0.0"),
        "description": manifest.get("description", ""),
        "category":    manifest.get("category", "App"),
        "icon":        manifest.get("icon", "🔧"),
        "entrypoint":  manifest["entrypoint"],
        "env":         manifest.get("env", {}),
        "app_dir":     str(dest_dir),
        "shortcut":    str(sc),
        "installed_at": int(time.time()),
    }
    register(meta)
    return {
        "success":  True,
        "app_id":   app_id,
        "name":     meta["name"],
        "shortcut": str(sc),
        "message":  f"'{meta['name']}' instalada correctamente.",
    }


def uninstall_linux(app_id: str) -> dict:
    app = get_app(app_id)
    if not app:
        raise ZipError("App no encontrada")
    for key in ("app_dir",):
        p = Path(app.get(key, ""))
        if p.exists():
            shutil.rmtree(p)
    sc = Path(app.get("shortcut", ""))
    if sc.exists():
        sc.unlink(missing_ok=True)
    unregister(app_id)
    return {"success": True, "message": f"'{app['name']}' desinstalada"}
