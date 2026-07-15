"""Persistance de l'historique de chat en SQLite — survit à un restart du
backend. Indexé par dossier de session (current_cwd) plutôt que par sessionId
ACP, qui change à chaque redémarrage du process qwen-code.
"""

import json
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).parent / "history.db"


class HistoryStore:
    def __init__(self, db_path: Path = DB_PATH):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        # WAL : les lecteurs ne bloquent plus les écrivains (et inversement) et
        # le commit n'attend plus un fsync complet du journal à chaque append —
        # utile ici vu la fréquence des écritures (un event par chunk streamé).
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_key TEXT NOT NULL,
                event_json TEXT NOT NULL,
                ts REAL NOT NULL
            )
            """
        )
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_session_key ON events(session_key)")
        self._conn.commit()

    def append(self, session_key: str, event: dict):
        self._conn.execute(
            "INSERT INTO events (session_key, event_json, ts) VALUES (?, ?, ?)",
            (session_key, json.dumps(event), time.time()),
        )
        self._conn.commit()

    def load(self, session_key: str) -> list[dict]:
        rows = self._conn.execute(
            "SELECT event_json FROM events WHERE session_key = ? ORDER BY id", (session_key,)
        ).fetchall()
        return [json.loads(r[0]) for r in rows]
