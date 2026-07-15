"""Explorateur de fichiers — listing direct via pathlib, pas de dépendance à
desktop-commander (réservé à l'usage interne de l'agent piloté, voir rules.md).

La racine par défaut est le dossier de la session en cours (current_cwd de
l'AgentBridge), mais le frontend peut demander une racine différente (voir
resolve_root) — navigation libre sur le disque depuis l'explorateur (2026-07-03,
voir architecture.md), le panneau Terminal offrant déjà un accès équivalent
sans restriction. Une fois une racine choisie, les chemins RELATIFS à cette
racine restent bornés (_resolve_safe_path) — seule la racine elle-même n'est
plus fixée au dossier de session.
"""

import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

MAX_PREVIEW_BYTES = 200_000
MAX_DIFF_BYTES = 200_000


def resolve_root(root: str | None, default: str) -> str:
    """Racine effective de l'explorateur pour cette requête. Navigable
    librement en dehors du dossier de la session agent (voir architecture.md
    "Navigation libre dans l'explorateur") — décision explicite de Julien
    (2026-07-03) : le panneau Terminal donne déjà un accès disque complet
    équivalent (pty shell sans restriction), border spécifiquement
    l'explorateur n'apportait pas de vraie protection supplémentaire.
    _resolve_safe_path reste inchangé et continue de borner les chemins
    RELATIFS à cette racine, une fois choisie."""
    if not root:
        return default
    path = Path(root)
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Dossier introuvable")
    return str(path)


def get_parent_directory(root: str) -> str | None:
    path = Path(root).resolve()
    parent = path.parent
    return None if parent == path else str(parent)


def _resolve_safe_path(base: str, relative: str) -> Path:
    base_path = Path(base).resolve()
    target = (base_path / relative).resolve() if relative else base_path
    if target != base_path and base_path not in target.parents:
        raise HTTPException(status_code=400, detail="Chemin hors du dossier de la session")
    return target


def get_git_status(base: str) -> dict[str, str]:
    """{chemin_relatif_a_base: code_statut_2_lettres}, {} si pas un dépôt git."""
    try:
        result = subprocess.run(
            ["git", "-C", base, "status", "--porcelain=v1"],
            capture_output=True, text=True, timeout=3, check=False,
        )
        if result.returncode != 0:
            return {}
        status = {}
        for line in result.stdout.splitlines():
            if len(line) < 4:
                continue
            code = line[:2].strip()
            path = line[3:]
            if " -> " in path:  # renommage : "R  old -> new"
                path = path.split(" -> ", 1)[1]
            status[path] = code
        return status
    except (OSError, subprocess.TimeoutExpired):
        return {}


# Ordre de priorité pour représenter un dossier par un seul badge : un conflit
# prime sur une suppression, qui prime sur une modification, etc. — plus honnête
# que prendre arbitrairement le premier enfant trouvé (bug précédent).
_GIT_PRIORITY = "UDMA?"


def _rollup_child_status(child_codes: list[str]) -> tuple[str, str] | None:
    if not child_codes:
        return None
    counts: dict[str, int] = {}
    for code in child_codes:
        marker = next((m for m in _GIT_PRIORITY if m in code), code[0])
        counts[marker] = counts.get(marker, 0) + 1
    top_marker = next(m for m in _GIT_PRIORITY if m in counts)
    summary = " · ".join(f"{n}{m}" for m, n in counts.items())
    return top_marker, summary


def _entry_status(git_status: dict[str, str], entry: Path, entry_rel: str) -> tuple[str | None, str | None]:
    git_code = git_status.get(entry_rel)
    if git_code is not None or not entry.is_dir():
        return git_code, None
    prefix = entry_rel + "/"
    child_codes = [code for p, code in git_status.items() if p.startswith(prefix)]
    return _rollup_child_status(child_codes) or (None, None)


def list_directory(base: str, relative: str = "") -> dict:
    target = _resolve_safe_path(base, relative)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Dossier introuvable")

    git_status = get_git_status(base)

    items = []
    for entry in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        try:
            stat = entry.stat()
        except OSError:
            continue
        entry_rel = f"{relative}/{entry.name}" if relative else entry.name
        git_code, git_summary = _entry_status(git_status, entry, entry_rel)
        items.append({
            "name": entry.name,
            "type": "folder" if entry.is_dir() else "file",
            "size": stat.st_size if entry.is_file() else None,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            "gitStatus": git_code,
            "gitSummary": git_summary,
        })

    return {"path": relative, "items": items}


# node_modules/__pycache__ ralentiraient beaucoup une recherche récursive pour
# peu d'intérêt — même règle de masquage par défaut que dans FilesPanel.jsx.
_HIDDEN_NAMES = {"node_modules", "__pycache__"}
SEARCH_MAX_RESULTS = 300
GREP_MAX_RESULTS = 200
GREP_MAX_PER_FILE = 5
GREP_MAX_FILE_BYTES = 2_000_000


def _should_skip(name: str, show_hidden: bool) -> bool:
    if name == ".git":
        return True  # jamais utile d'y descendre (objets internes Git), même si show_hidden
    return not show_hidden and (name.startswith(".") or name in _HIDDEN_NAMES)


def search_files(base: str, query: str, show_hidden: bool) -> list[dict]:
    """Recherche récursive par nom, sur tout l'arbre (pas seulement les
    dossiers déjà dépliés côté frontend) — remplace le filtre substring qui ne
    portait que sur les lignes déjà chargées."""
    base_path = Path(base).resolve()
    git_status = get_git_status(base)
    query_lower = query.lower()
    results: list[dict] = []

    def walk(dir_path: Path, rel: str):
        if len(results) >= SEARCH_MAX_RESULTS:
            return
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for entry in entries:
            if len(results) >= SEARCH_MAX_RESULTS:
                return
            if _should_skip(entry.name, show_hidden):
                continue
            entry_rel = f"{rel}/{entry.name}" if rel else entry.name
            if query_lower in entry.name.lower():
                try:
                    stat = entry.stat()
                except OSError:
                    continue
                git_code, git_summary = _entry_status(git_status, entry, entry_rel)
                results.append({
                    "name": entry.name,
                    "path": entry_rel,
                    "type": "folder" if entry.is_dir() else "file",
                    "size": stat.st_size if entry.is_file() else None,
                    "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    "gitStatus": git_code,
                    "gitSummary": git_summary,
                })
            if entry.is_dir():
                walk(entry, entry_rel)

    walk(base_path, "")
    return results


def grep_files(base: str, query: str, show_hidden: bool) -> list[dict]:
    """Recherche de contenu — pas de ripgrep dispo sur cette machine (vérifié),
    implémentation Python bornée en taille de fichier et en nombre de résultats
    pour rester utilisable sans dépendance externe."""
    base_path = Path(base).resolve()
    query_lower = query.lower()
    results: list[dict] = []

    def walk(dir_path: Path, rel: str):
        if len(results) >= GREP_MAX_RESULTS:
            return
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for entry in entries:
            if len(results) >= GREP_MAX_RESULTS:
                return
            if _should_skip(entry.name, show_hidden):
                continue
            entry_rel = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir():
                walk(entry, entry_rel)
                continue
            try:
                if entry.stat().st_size > GREP_MAX_FILE_BYTES:
                    continue
                text = entry.read_bytes().decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            found_in_file = 0
            for lineno, line in enumerate(text.splitlines(), start=1):
                if query_lower in line.lower():
                    results.append({"path": entry_rel, "line": lineno, "snippet": line.strip()[:200]})
                    found_in_file += 1
                    if found_in_file >= GREP_MAX_PER_FILE or len(results) >= GREP_MAX_RESULTS:
                        break

    walk(base_path, "")
    return results


def get_file_diff(base: str, relative: str) -> dict:
    """Diff vs HEAD — récupère juste les deux versions complètes (courante +
    HEAD via `git show`) et laisse DiffView (déjà utilisé pour les
    approbations de tool call, même limite connue : pas un vrai diff aligné
    LCS) faire le rendu, plutôt que de parser un format unified diff."""
    target = _resolve_safe_path(base, relative)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Fichier introuvable")

    # Contrairement à read_file_preview (plafonné à MAX_PREVIEW_BYTES), ce
    # endpoint n'avait aucune limite — un diff sur un gros fichier généré
    # (build, lockfile) lisait tout puis DiffView rendait une <div> par ligne
    # sans virtualisation, de quoi geler l'onglet le temps de tout monter.
    truncated = target.stat().st_size > MAX_DIFF_BYTES
    try:
        new_text = target.read_bytes()[:MAX_DIFF_BYTES].decode("utf-8")
    except UnicodeDecodeError:
        return {"binary": True, "oldText": None, "newText": None, "truncated": False}

    try:
        result = subprocess.run(
            ["git", "-C", base, "show", f"HEAD:{relative}"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        # returncode != 0 : fichier absent de HEAD (nouveau, non commité) —
        # tout le contenu apparaît comme ajouté, comportement attendu.
        old_text = result.stdout if result.returncode == 0 else ""
        if len(old_text) > MAX_DIFF_BYTES:
            old_text = old_text[:MAX_DIFF_BYTES]
            truncated = True
    except (OSError, subprocess.TimeoutExpired):
        old_text = ""

    return {"binary": False, "oldText": old_text, "newText": new_text, "truncated": truncated}


def read_file_preview(base: str, relative: str) -> dict:
    target = _resolve_safe_path(base, relative)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Fichier introuvable")

    data = target.read_bytes()[:MAX_PREVIEW_BYTES]
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        return {"path": relative, "binary": True, "content": None, "truncated": False}

    full_size = target.stat().st_size
    return {"path": relative, "binary": False, "content": content, "truncated": full_size > MAX_PREVIEW_BYTES}


def resolve_raw_file(base: str, relative: str) -> Path:
    """Pour l'aperçu image/PDF (frontend fetch les octets bruts directement,
    read_file_preview ne convient pas — décode en utf-8, échoue sur du binaire)."""
    target = _resolve_safe_path(base, relative)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return target


def _validate_name(name: str):
    # Un nom (pas un chemin) : bloque toute tentative d'évasion du dossier
    # parent via le champ nom lui-même (ex. "../../etc"), en plus de la
    # protection déjà faite par _resolve_safe_path sur les chemins complets.
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise HTTPException(status_code=400, detail="Nom invalide")


def create_entry(base: str, relative: str, name: str, kind: str) -> dict:
    _validate_name(name)
    parent = _resolve_safe_path(base, relative)
    if not parent.is_dir():
        raise HTTPException(status_code=404, detail="Dossier parent introuvable")
    new_relative = f"{relative}/{name}" if relative else name
    target = _resolve_safe_path(base, new_relative)
    if target.exists():
        raise HTTPException(status_code=409, detail="Un élément porte déjà ce nom")
    if kind == "folder":
        target.mkdir()
    else:
        target.touch()
    return {"name": name, "path": new_relative, "type": kind}


def rename_entry(base: str, relative: str, new_name: str) -> dict:
    _validate_name(new_name)
    target = _resolve_safe_path(base, relative)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Élément introuvable")
    parent_relative = relative.rsplit("/", 1)[0] if "/" in relative else ""
    new_relative = f"{parent_relative}/{new_name}" if parent_relative else new_name
    new_target = _resolve_safe_path(base, new_relative)
    if new_target.exists():
        raise HTTPException(status_code=409, detail="Un élément porte déjà ce nom")
    target.rename(new_target)
    return {"name": new_name, "path": new_relative}


def delete_entry(base: str, relative: str):
    if not relative:
        raise HTTPException(status_code=400, detail="Impossible de supprimer la racine du projet")
    target = _resolve_safe_path(base, relative)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Élément introuvable")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
