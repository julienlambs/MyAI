"""Pont terminal — pty indépendant de l'agent (voir architecture.md), pywinpty
en dev Windows / pty stdlib visé pour la cible Linux.

Connu et documenté : les caractères accentués tapés dans le terminal peuvent
être corrompus (limite d'encodage d'entrée observée avec pywinpty sur
Windows) — n'affecte pas les commandes ASCII usuelles (git, npm, python…).
"""

import asyncio
import logging
import sys
import threading
import uuid

logger = logging.getLogger("terminal_bridge")

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    import winpty as pty_backend

    SHELL_CMD = ["powershell.exe", "-NoLogo"]
else:
    import ptyprocess as pty_backend

    SHELL_CMD = ["/bin/bash"]


class TerminalBridge:
    def __init__(self, cwd: str):
        self.cwd = cwd
        self.pty = None
        self.subscribers: set = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def ensure_started(self):
        if self.pty is not None:
            return
        self._loop = asyncio.get_event_loop()
        self.pty = pty_backend.PtyProcess.spawn(SHELL_CMD, cwd=self.cwd, dimensions=(24, 80))
        threading.Thread(target=self._read_loop, daemon=True).start()

    def write(self, data: str):
        if self.pty and self.pty.isalive():
            self.pty.write(data if IS_WINDOWS else data.encode("utf-8"))

    def resize(self, rows: int, cols: int):
        if self.pty and self.pty.isalive():
            self.pty.setwinsize(rows, cols)

    def subscribe(self, ws):
        self.subscribers.add(ws)

    def unsubscribe(self, ws):
        self.subscribers.discard(ws)

    def terminate(self):
        if self.pty and self.pty.isalive():
            self.pty.terminate(force=True)

    def _read_loop(self):
        while True:
            try:
                data = self.pty.read(4096)
            except EOFError:
                break
            if not IS_WINDOWS:
                data = data.decode("utf-8", errors="replace")
            asyncio.run_coroutine_threadsafe(self._broadcast(data), self._loop)

    async def _broadcast(self, data: str):
        dead = set()
        for ws in list(self.subscribers):
            try:
                await ws.send_json({"type": "data", "data": data})
            except Exception:
                dead.add(ws)
        self.subscribers -= dead


class TerminalManager:
    """Plusieurs pty indépendants (un par onglet côté frontend). La liste
    d'onglets n'a pas d'état frontend propre — le backend est la source de
    vérité (survit à un refresh de page, comme le terminal unique avant lui)."""

    def __init__(self, cwd: str):
        self.cwd = cwd
        self._terminals: dict[str, TerminalBridge] = {}
        self._names: dict[str, str] = {}
        self._counter = 0

    def list(self) -> list[dict]:
        return [{"id": tid, "name": self._names[tid]} for tid in self._terminals]

    def create(self) -> dict:
        self._counter += 1
        tid = uuid.uuid4().hex[:8]
        bridge = TerminalBridge(self.cwd)
        bridge.ensure_started()
        self._terminals[tid] = bridge
        self._names[tid] = f"Terminal {self._counter}"
        return {"id": tid, "name": self._names[tid]}

    def get(self, tid: str) -> TerminalBridge | None:
        return self._terminals.get(tid)

    def close(self, tid: str):
        bridge = self._terminals.pop(tid, None)
        self._names.pop(tid, None)
        if bridge:
            bridge.terminate()
