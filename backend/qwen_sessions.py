"""Historique de sessions qwen-code — lu directement depuis son stockage
disque (~/.qwen/projects/<slug>/chats/*.jsonl), qwen-code n'exposant pas
de commande "lister mes sessions" via ACP.

Algorithme de slug — retrouvé dans le code source de qwen-code lui-même
(fonction `sanitizeCwd`, bundle npm) après un bug trouvé le 2026-07-08 sur
Linux : la mise en minuscules n'a lieu QUE sous Windows
(`os.platform() === "win32" ? cwd.toLowerCase() : cwd`), la casse du chemin
est préservée telle quelle sur Linux/macOS. La première vérification
empirique (2026-07-01) avait été faite uniquement sous Windows, d'où le
`.lower()` inconditionnel ici — invisible tant qu'aucun chemin de projet ne
contenait de majuscule testée en usage réel côté Linux, mais cassait la
lecture de l'historique pour TOUS les projets une fois portés sur Linux
(`/mnt/shared/Projets/...` contient déjà une majuscule dans "Projets").

Schéma JSONL vérifié sur un vrai fichier de session : une ligne par entrée,
champ "type" parmi user/assistant/system/tool_result, message utilisateur
dans message.parts[].text.
"""

import json
import platform
import re
from pathlib import Path

QWEN_PROJECTS_DIR = Path.home() / ".qwen" / "projects"


def _slugify(path: str) -> str:
    normalized = path.lower() if platform.system() == "Windows" else path
    return re.sub(r"[^a-zA-Z0-9]", "-", normalized)


def _extract_user_text(entry: dict) -> str | None:
    parts = entry.get("message", {}).get("parts", [])
    for part in parts:
        if isinstance(part, dict) and part.get("text"):
            return part["text"]
    return None


def list_sessions(cwd: str) -> list[dict]:
    chats_dir = QWEN_PROJECTS_DIR / _slugify(cwd) / "chats"
    if not chats_dir.is_dir():
        return []

    sessions = []
    for chat_file in chats_dir.glob("*.jsonl"):
        summary = None
        message_count = 0
        try:
            with chat_file.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    message_count += 1
                    if summary is None and entry.get("type") == "user":
                        summary = _extract_user_text(entry)
        except OSError:
            continue

        sessions.append({
            "id": chat_file.stem,
            "summary": (summary or "(sans titre)")[:140],
            "messageCount": message_count,
            "modified": chat_file.stat().st_mtime,
        })

    sessions.sort(key=lambda s: s["modified"], reverse=True)
    return sessions
