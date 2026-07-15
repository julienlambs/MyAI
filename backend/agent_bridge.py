"""Pont entre le backend FastAPI et un process `qwen --acp` unique et persistant.

Le process survit aux (dé)connexions WebSocket — seul new_session() le fait
changer de dossier de travail (nouvelle session ACP sur le même process).
"""

import asyncio
import itertools
import json
import logging
import os
import platform
import re
import shutil

from context_status import get_context_usage
from history_store import HistoryStore
import push_notifications
from qwen_sessions import list_sessions

logger = logging.getLogger("agent_bridge")

# Les hooks PreToolUse natifs de qwen-code ne se déclenchent jamais sous --acp
# (vérifié empiriquement le 2026-07-09 : session/request_permission arrive
# normalement côté hôte ACP, mais le pipeline de hooks qwen-code est
# court-circuité — seuls SessionStart/etc. fonctionnent encore). L'hôte ACP
# (nous) doit donc porter lui-même ces garde-fous. Voir cadrage-agents-locaux.md.
_WEB_FETCH_BLOCKED_REASON = (
    "web_fetch natif bloqué par policy MyAI (échoue quasi systématiquement, 403 "
    "sur la plupart des sites) — utilise tavily_search/tavily_extract à la place."
)

_DANGEROUS_COMMAND_PATTERNS = [
    (re.compile(r"rm\s+.*-[a-zA-Z]*r[a-zA-Z]*f|rm\s+.*-[a-zA-Z]*f[a-zA-Z]*r", re.IGNORECASE), "rm -rf (ou variante -fr/-Rf)"),
    (re.compile(r"git\s+push\s+.*--force(?!-with-lease)|git\s+push\s+.*\s-f(\s|$)", re.IGNORECASE), "git push --force"),
]


def _dangerous_command_label(tool_call: dict) -> str | None:
    """Retourne un libellé si rawInput.command matche un pattern destructeur connu, sinon None."""
    raw_input = tool_call.get("rawInput") or {}
    command = raw_input.get("command")
    if not isinstance(command, str):
        return None
    for pattern, label in _DANGEROUS_COMMAND_PATTERNS:
        if pattern.search(command):
            return label
    return None

# shutil.which résout le .cmd généré par npm sur Windows — asyncio.create_subprocess_exec
# n'y arrive pas seul (contrairement à un shell), il lui faut le chemin complet.
QWEN_EXECUTABLE = shutil.which("qwen") or "qwen"

# Permet à un script de démarrage (ex. myai-start --q80b) de choisir le
# profil llama-swap chargé par défaut, sans toucher au code.
DEFAULT_MODEL_ID = os.getenv("MYAI_DEFAULT_MODEL", "qwen-35b")

QWEN_SETTINGS_PATH = os.path.expanduser("~/.qwen/settings.json")

# qwen-code calcule son seuil de compaction automatique à partir de
# model.generationConfig.contextWindowSize dans ~/.qwen/settings.json — une
# valeur STATIQUE, jamais réévaluée par rapport au modèle réellement lancé via
# `-m`. Sans synchronisation, switch_model() vers qwen-80b (n_ctx réel 229376
# sur Linux) gardait la valeur tunée pour qwen-35b (175104), déclenchant une
# compaction vers ~78000 tokens au lieu de ~200000 (bug remonté par Julien,
# 2026-07-08 — root-causé en lisant chunk-AGZF43UV.js : contextLimit =
# contextWindowSize - 64000 réservés en sortie, seuil auto = 70% de ça).
#
# Valeurs par plateforme car config.yaml (Windows) et config.linux.yaml
# n'utilisent pas les mêmes --ctx-size/--fit-ctx pour devstral-texte et
# qwen-80b (VRAM/contraintes GPU différentes, voir architecture.md). qwen-35b
# vise le même --fit-ctx (175000) des deux côtés ; 175104 est la valeur réelle
# observée via /slots côté Linux (n_ctx padé), pas encore reconfirmée côté
# Windows mais attendue identique (même modèle, mêmes flags de batch).
# Valeurs Windows devstral-texte/qwen-80b reprises telles quelles du
# --fit-ctx de config.yaml, jamais vérifiées via /slots (--fit-ctx n'est
# qu'un plancher, pas la taille réelle) — à corriger si un jour mesurées
# différentes. À remettre à jour si le contexte d'un profil change (même
# piège déjà documenté pour la valeur unique d'origine).
if platform.system() == "Windows":
    MODEL_CONTEXT_SIZES = {
        "qwen-35b": 150016,
        "qwen-80b": 114688,
        "devstral-texte": 32768,
    }
else:
    MODEL_CONTEXT_SIZES = {
        "qwen-35b": 175104,
        "qwen-80b": 229376,
        "devstral-texte": 49152,
    }


class AgentBridge:
    def __init__(self, workspace_root: str):
        self.workspace_root = workspace_root
        self.current_cwd = workspace_root
        self.process: asyncio.subprocess.Process | None = None
        self.session_id: str | None = None
        self.subscribers: set = set()
        self.history: list[dict] = []
        self.history_store = HistoryStore()
        # Modes d'approbation qwen-code (plan/default/auto-edit/auto/yolo),
        # vérifiés empiriquement via session/new — currentModeId + la liste
        # complète pour le sélecteur.
        self.current_mode_id: str | None = None
        self.available_modes: list[dict] = []
        # Reprendre une session (session/load) rejoue l'historique depuis le
        # fichier local de qwen-code, sans jamais toucher llama-server — donc
        # /slots ne montre aucune activité nouvelle et continuerait d'afficher
        # le contexte de la session PRÉCÉDENTE indéfiniment (bug remonté par
        # Julien : la barre restait bloquée sur l'ancienne valeur même en
        # attendant). Ce repère capture le dernier id_task connu juste avant un
        # changement de session — /api/context ne renvoie une vraie valeur que
        # si l'id_task observé le dépasse (preuve d'une activité réelle et
        # postérieure), sinon "inconnu" plutôt qu'un chiffre potentiellement faux.
        self.context_baseline_task_id: int | None = None
        # Profil llama-swap actif — passé en `-m` au lancement de qwen-code,
        # jamais changeable en ACP (session/set_model ne connaît que ce modèle
        # + un modèle qwen-oauth cloud sans rapport, vérifié empiriquement le
        # 2026-07-03 : qwen-code ne découvre pas /v1/models de llama-swap).
        # Changer de modèle passe donc par switch_model() (tue + relance le
        # process), pas par un simple appel ACP à la volée.
        self.model_id = DEFAULT_MODEL_ID
        # Bloque switch_model() pendant un tour ou une approbation en cours —
        # tuer le process qwen-code à ce moment laisserait le Future de la
        # requête en attente pendante indéfiniment (voir switch_model).
        self._generating = False
        self._id_counter = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._pending_permissions: dict[int, asyncio.Future] = {}
        self._pending_permission_options: dict[int, list] = {}
        self._start_lock = asyncio.Lock()
        # Un seul `session/prompt` à la fois — en envoyer un second pendant qu'un
        # tour est en cours annule le premier côté qwen-code (`Request was aborted`).
        self._prompt_queue: asyncio.Queue = asyncio.Queue()
        self._queue_task: asyncio.Task | None = None

    async def _snapshot_context_baseline(self):
        usage = await get_context_usage()
        self.context_baseline_task_id = usage.get("task_id") if usage else None

    async def ensure_started(self):
        async with self._start_lock:
            await self._ensure_started_locked()

    async def _ensure_started_locked(self):
        """Corps de ensure_started() sans acquérir le lock — appelé aussi par
        switch_model(), qui tient déjà self._start_lock (asyncio.Lock n'est
        pas réentrant, un second `async with` dessus bloquerait pour toujours)."""
        if self.process is None:
            await self._spawn()
        if self.session_id is None:
            await self._snapshot_context_baseline()
            # _load_or_create tente un session/load sur la session la plus
            # récente de current_cwd (pas workspace_root — un respawn après
            # crash doit reprendre le projet actif, pas retomber sur le
            # projet de démarrage si Julien avait changé de projet entre
            # temps). Confirmé empiriquement (crash sqlite exploité pour le
            # diagnostiquer) que qwen-code rejoue bien tout l'historique via
            # de vraies notifications session/update PENDANT cet appel, qui
            # remontent par le pipeline normal (_emit) et peuplent
            # self.history correctement. Pas besoin de relire history_store
            # en plus : une tentative précédente le faisait par cwd (pas par
            # session_id), ce qui mélangeait l'historique de TOUTES les
            # sessions passées de ce dossier au redémarrage — inutile de
            # toute façon vu que le rejeu natif s'en charge déjà.
            await self._load_or_create(self.current_cwd)
        if self._queue_task is None:
            self._queue_task = asyncio.create_task(self._process_queue())

    async def switch_model(self, model_id: str):
        """Change de profil llama-swap actif — tue le process qwen-code en
        cours et le relance avec `-m <model_id>`, puis reprend la même session
        (session/load reroute vers la session la plus récente de current_cwd,
        qui est justement celle qu'on vient d'interrompre) pour ne pas perdre
        la conversation en cours. Réutilise le chemin déjà éprouvé de la
        reprise après crash (voir _ensure_started_locked / journal 2026-07-03)."""
        if self._generating or self._pending_permissions:
            raise RuntimeError("Impossible de changer de modèle pendant que l'agent travaille ou attend une approbation")
        async with self._start_lock:
            if model_id == self.model_id and self.process is not None:
                return
            self._drain_queue()
            old_process = self.process
            # Retiré AVANT de tuer le process : _watch_exit(old_process) tourne
            # en tâche de fond sur le même process et compare `self.process is
            # process` à son réveil — sans ça, une mort "attendue" ici serait
            # traitée comme un crash (déconnexion forcée de tous les clients).
            self.process = None
            self.session_id = None
            self._fail_pending(RuntimeError("Process qwen-code arrêté pour changement de modèle"))
            if old_process is not None:
                await self._kill_process_tree(old_process)
            self.model_id = model_id
            await self._ensure_started_locked()
        await self.broadcast({"type": "model_update", "model": self.model_id})
        await self.broadcast({"type": "mode_update", "modeId": self.current_mode_id, "availableModes": self.available_modes})

    async def new_session(self, cwd: str):
        """Départ explicitement vierge, choisi par l'utilisateur (bouton
        "Nouvelle session") — jamais de reprise, même si ce dossier a déjà des
        sessions. Voir resume_session() pour la reprise automatique/choisie."""
        await self.ensure_started()
        self._drain_queue()
        await self._snapshot_context_baseline()
        cwd = os.path.normpath(cwd)
        self.history = []
        # session_reset DOIT partir avant _create_session : qwen-code peut déjà
        # répondre à des notifications (pas le cas pour session/new, mais on
        # garde le même ordre que resume_session() par cohérence/prudence).
        await self.broadcast({"type": "session_reset", "cwd": cwd})
        await self._create_session(cwd)
        await self.broadcast({"type": "mode_update", "modeId": self.current_mode_id, "availableModes": self.available_modes})

    async def resume_session(self, cwd: str, session_id: str | None = None):
        """Reprend une vraie session qwen-code (session/load) — la plus récente
        de ce dossier par défaut (changement de projet), ou une précise si
        fournie (clic sur une entrée de la liste Sessions). Le rejeu de
        l'historique arrive via les notifications session/update de qwen-code,
        émises PENDANT l'appel session/load (pas après) — session_reset doit
        donc partir avant, sinon il efface le rejeu qui vient d'arriver
        (bug trouvé empiriquement : l'historique rejoué disparaissait aussitôt)."""
        await self.ensure_started()
        self._drain_queue()
        await self._snapshot_context_baseline()
        cwd = os.path.normpath(cwd)
        self.history = []
        await self.broadcast({"type": "session_reset", "cwd": cwd})
        await self._load_or_create(cwd, session_id)
        await self.broadcast({"type": "mode_update", "modeId": self.current_mode_id, "availableModes": self.available_modes})

    async def _load_or_create(self, cwd: str, session_id: str | None = None) -> bool:
        # qwen-code stocke le cwd de chaque session avec des antislashs (format
        # natif Windows) et fait une comparaison stricte de chaîne pour
        # résoudre session/load — nos chemins internes utilisent des slashs
        # partout (frontend, .env, projects.json), donc sans ça chaque tentative
        # échoue avec "Resource not found" (root-causé empiriquement).
        cwd = os.path.normpath(cwd)
        target_id = session_id
        if target_id is None:
            sessions = list_sessions(cwd)
            target_id = sessions[0]["id"] if sessions else None
        if target_id:
            # Assignés AVANT l'appel, pas après : le rejeu de l'historique arrive
            # via des notifications session/update PENDANT session/load (avant
            # que sa réponse ne résolve, voir resume_session() ci-dessus) — sans
            # session_id déjà connu à ce moment, ces events tentaient de se
            # persister avec une clé NULL (crash sqlite trouvé en testant).
            self.session_id = target_id
            self.current_cwd = cwd
            try:
                result = await self._request("session/load", {"sessionId": target_id, "cwd": cwd, "mcpServers": []})
                self._capture_modes(result)
                return True
            except Exception:
                logger.exception("session/load a échoué pour %s — repli sur une session vierge", target_id)
        await self._create_session(cwd)
        return False

    def _capture_modes(self, result: dict | None):
        modes = (result or {}).get("modes") or {}
        self.current_mode_id = modes.get("currentModeId", self.current_mode_id)
        self.available_modes = modes.get("availableModes", self.available_modes)

    async def set_mode(self, mode_id: str):
        await self._request("session/set_mode", {"sessionId": self.session_id, "modeId": mode_id})
        # La confirmation arrive normalement via la notification
        # qwen/notify/session/mode-update — mise à jour immédiate en plus au
        # cas où elle tarderait, l'UI ne doit pas sembler figée sur l'ancien mode.
        self.current_mode_id = mode_id
        await self.broadcast({"type": "mode_update", "modeId": mode_id})

    async def send_user_message(self, text: str):
        await self._emit({"type": "user_message", "text": text})
        await self._prompt_queue.put(text)

    async def compact(self):
        await self._emit({"type": "compact_started"})
        await self._prompt_queue.put("/compress")

    async def cancel_turn(self):
        """`session/cancel` (ACP) — abort() réel de la requête HTTP en cours vers
        llama-server côté qwen-code (cancelPendingPrompt(), pas juste un rejet
        d'approbation). Le session/prompt en attente se résout alors avec
        stopReason="cancelled", que _run_prompt() émet déjà normalement en
        turn_end — aucun changement nécessaire de ce côté."""
        if not self._generating:
            return
        await self._request("session/cancel", {"sessionId": self.session_id})

    async def respond_permission(self, request_id: int, option_id: str, answers: dict | None = None):
        self._pending_permission_options.pop(request_id, None)
        fut = self._pending_permissions.pop(request_id, None)
        if fut and not fut.done():
            fut.set_result((option_id, answers))
        # Retire l'event du fil courant — sinon un autre client déjà connecté
        # (ex. téléphone pendant que tu réponds depuis le PC) garde un bouton
        # "Approuver" mort affiché indéfiniment.
        self.history = [e for e in self.history if not (e.get("type") == "permission_request" and e.get("id") == request_id)]
        await self.broadcast({"type": "permission_resolved", "id": request_id})

    def subscribe(self, ws):
        self.subscribers.add(ws)

    def unsubscribe(self, ws):
        self.subscribers.discard(ws)

    # -- internes -----------------------------------------------------------

    async def _kill_process_tree(self, process: asyncio.subprocess.Process):
        """process.terminate()/kill() ne tue que le process direct — qwen-code
        est lancé via le shim npm (.cmd → node → node), laissant les enfants
        orphelins (bug trouvé empiriquement en testant switch_model : l'ancien
        modèle restait chargé à côté du nouveau). `taskkill /T` tue tout
        l'arbre sur Windows ; ailleurs (cible Linux, Bloc 9) un simple
        terminate() suffit, pas de chaîne de spawn équivalente à reproduire."""
        if platform.system() == "Windows":
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/F", "/T", "/PID", str(process.pid),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
        else:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

    def _sync_qwen_settings_context_window(self):
        """Réécrit model.name/contextWindowSize dans ~/.qwen/settings.json pour
        qu'ils correspondent au profil sur le point d'être lancé (voir
        MODEL_CONTEXT_SIZES) — sans ça, qwen-code garde la dernière valeur
        écrite à la main, quel que soit le `-m` réellement utilisé. Best-effort :
        un settings.json absent/corrompu ne doit pas empêcher le démarrage,
        qwen-code retombe alors sur son propre défaut (131072, trop bas mais pas
        bloquant)."""
        context_window = MODEL_CONTEXT_SIZES.get(self.model_id)
        if context_window is None:
            logger.warning("Pas de taille de contexte connue pour le modèle %s — settings.json inchangé", self.model_id)
            return
        try:
            with open(QWEN_SETTINGS_PATH, encoding="utf-8") as f:
                settings = json.load(f)
        except (OSError, json.JSONDecodeError):
            logger.warning("Impossible de lire %s pour synchroniser contextWindowSize", QWEN_SETTINGS_PATH)
            return
        model_cfg = settings.setdefault("model", {})
        model_cfg["name"] = self.model_id
        model_cfg.setdefault("generationConfig", {})["contextWindowSize"] = context_window
        try:
            with open(QWEN_SETTINGS_PATH, "w", encoding="utf-8") as f:
                json.dump(settings, f, indent=2)
        except OSError:
            logger.warning("Impossible d'écrire %s pour synchroniser contextWindowSize", QWEN_SETTINGS_PATH)

    def _qwen_args(self) -> list[str]:
        return [
            "--acp",
            "--auth-type", "openai",
            "--openai-base-url", "http://127.0.0.1:9090/v1",
            "--openai-api-key", "local-no-auth",
            "-m", self.model_id,
            # Reprend le mode d'approbation choisi avant un éventuel switch_model
            # plutôt que de retomber sur "default" à chaque changement de modèle.
            "--approval-mode", self.current_mode_id or "default",
        ]

    async def _spawn(self):
        self._sync_qwen_settings_context_window()
        process = await asyncio.create_subprocess_exec(
            QWEN_EXECUTABLE, *self._qwen_args(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            # Avant : DEVNULL — un crash de qwen-code ne laissait alors
            # absolument aucune trace (bug trouvé le 2026-07-03 : le process
            # mourait silencieusement, le bridge continuait de croire qu'il
            # était vivant et avalait chaque échec d'écriture sans rien
            # afficher). Capturé pour diagnostiquer un futur crash.
            stderr=asyncio.subprocess.PIPE,
            # Le buffer par défaut (64 Ko) est trop petit : la réponse `session/new`
            # de qwen-code embarque un long catalogue de modèles sur une seule ligne.
            limit=10 * 1024 * 1024,
        )
        self.process = process
        asyncio.create_task(self._read_loop())
        asyncio.create_task(self._read_stderr_loop(process))
        asyncio.create_task(self._watch_exit(process))
        await self._request("initialize", {"protocolVersion": 1, "clientCapabilities": {}})

    async def _read_stderr_loop(self, process):
        async for raw_line in process.stderr:
            line = raw_line.decode(errors="ignore").rstrip()
            if line:
                logger.warning("qwen-code stderr: %s", line)

    async def _watch_exit(self, process):
        """Le process qwen-code est censé survivre tout le cycle de vie du
        backend (voir docstring du module) — s'il meurt quand même (crash,
        tué de l'extérieur...), le bridge ne le détectait jamais avant ça :
        self.process restait une référence morte, chaque écriture suivante
        échouait silencieusement (avalée par le except Exception générique de
        _process_queue), et les clients voyaient une page qui a l'air normale
        mais qui n'envoie plus jamais de réponse (bug remonté par Julien,
        2026-07-03)."""
        code = await process.wait()
        if self.process is not process:
            return  # déjà remplacé par un respawn plus récent, rien à faire
        logger.warning("qwen-code s'est arrêté de façon inattendue (code %s)", code)
        self._fail_pending(RuntimeError("Le process qwen-code s'est arrêté de façon inattendue"))
        self.process = None
        self.session_id = None
        # Force une reconnexion propre plutôt que de tenter un respawn discret
        # pendant qu'un client est déjà connecté : ensure_started() ne
        # respawn/recharge la session qu'au prochain appel, et le rejeu
        # d'historique de _load_or_create ne doit partir qu'une fois vers un
        # nouveau websocket (sinon duplication dans le fil déjà affiché). Le
        # reconnect existant du frontend (session_info → reset → rejeu propre)
        # gère déjà exactement ce cas.
        for ws in list(self.subscribers):
            try:
                await ws.close(code=1011)
            except Exception:
                pass
        self.subscribers.clear()

    def _fail_pending(self, exc: Exception):
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()
        for fut in self._pending_permissions.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending_permissions.clear()

    async def _create_session(self, cwd: str):
        cwd = os.path.normpath(cwd)
        result = await self._request("session/new", {"cwd": cwd, "mcpServers": []})
        self.session_id = result["sessionId"]
        self.current_cwd = cwd
        self._capture_modes(result)

    def _drain_queue(self):
        while not self._prompt_queue.empty():
            self._prompt_queue.get_nowait()
            self._prompt_queue.task_done()

    async def _process_queue(self):
        while True:
            text = await self._prompt_queue.get()
            try:
                await self._run_prompt(text)
            except Exception:
                logger.exception("Erreur pendant le traitement du prompt en file")
            finally:
                self._prompt_queue.task_done()

    async def _run_prompt(self, text: str):
        # Un session/prompt qui échoue (ex. modèle changé vers un contexte trop
        # petit pour la conversation reprise, voir switch_model) ne doit jamais
        # laisser le frontend bloqué en "génération en cours" indéfiniment —
        # bug trouvé le 2026-07-03 : l'exception était avalée par le except
        # générique de _process_queue, sans jamais émettre turn_end, donc sans
        # jamais éteindre l'indicateur de chargement côté client (voir aussi
        # LoadingIndicator dans ChatPanel.jsx).
        self._generating = True
        try:
            stop_reason = "error"
            try:
                result = await self._request("session/prompt", {
                    "sessionId": self.session_id,
                    "prompt": [{"type": "text", "text": text}],
                })
                stop_reason = (result or {}).get("stopReason")
            except Exception as exc:
                logger.exception("session/prompt a échoué")
                await self._emit({"type": "error", "message": f"Le modèle a rejeté la requête : {exc}"})
            await self._emit({"type": "turn_end", "stopReason": stop_reason})
        finally:
            self._generating = False

    async def _request(self, method: str, params: dict):
        req_id = next(self._id_counter)
        fut = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        await self._write({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        return await fut

    async def _write(self, obj: dict):
        self.process.stdin.write((json.dumps(obj) + "\n").encode())
        await self.process.stdin.drain()

    async def _read_loop(self):
        async for raw_line in self.process.stdout:
            line = raw_line.decode(errors="ignore").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Ligne non-JSON ignorée: %s", line[:200])
                continue
            await self._handle_message(msg)

    async def _handle_message(self, msg: dict):
        if "id" in msg and ("result" in msg or "error" in msg):
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                if "error" in msg:
                    err = msg["error"]
                    # err["data"]["details"] porte le message utile côté
                    # llama.cpp (ex. dépassement de contexte) — str(err) brut
                    # ({'code':...,'message':'Internal error',...}) n'aide
                    # personne une fois affiché dans le chat.
                    detail = (err.get("data") or {}).get("details") or err.get("message") or str(err)
                    fut.set_exception(RuntimeError(detail))
                else:
                    fut.set_result(msg.get("result"))
            return

        method = msg.get("method")
        if method == "session/update":
            event = self._normalize_update(msg["params"]["update"])
            if event:
                await self._emit(event)
            return

        # Notification custom qwen-code (pas un session/update standard) —
        # confirmée empiriquement en testant session/set_mode.
        if method == "qwen/notify/session/mode-update":
            self.current_mode_id = msg["params"].get("currentModeId")
            await self.broadcast({"type": "mode_update", "modeId": self.current_mode_id})
            return

        if method == "session/request_permission":
            params = msg["params"]
            tool_call = params.get("toolCall", {})
            tool_name = (tool_call.get("_meta") or {}).get("toolName")

            # Blocage silencieux (pas de round-trip vers Julien) : web_fetch natif
            # échoue quasi systématiquement, voir architecture.md. Choix délibéré
            # de ne pas remonter cette demande dans l'UI — ce n'est pas une
            # décision à arbitrer au cas par cas.
            if tool_name == "web_fetch" or tool_call.get("kind") == "fetch":
                options = params.get("options", [])
                cancel_option = next((o["optionId"] for o in options if o.get("kind", "").startswith("reject")), None)
                if cancel_option:
                    logger.info("web_fetch bloqué automatiquement (policy MyAI)")
                    await self._write({
                        "jsonrpc": "2.0",
                        "id": msg["id"],
                        "result": {"outcome": {"outcome": "selected", "optionId": cancel_option}},
                    })
                    return

            diff = next(
                (c for c in tool_call.get("content", []) if c.get("type") == "diff"),
                None,
            )
            event = {
                "type": "permission_request",
                "id": msg["id"],
                "toolTitle": tool_call.get("title"),
                "toolKind": tool_call.get("kind"),
                "diff": {"path": diff["path"], "oldText": diff["oldText"], "newText": diff["newText"]} if diff else None,
                "rawInput": tool_call.get("rawInput") if not diff else None,
                "options": params.get("options", []),
                "dangerousCommand": _dangerous_command_label(tool_call),
            }
            fut = asyncio.get_event_loop().create_future()
            self._pending_permissions[msg["id"]] = fut
            self._pending_permission_options[msg["id"]] = event["options"]
            # Pas persisté : un redémarrage du backend perd le Future associé,
            # rejouer cette demande plus tard ferait planer un bouton "Approuver"
            # qui ne fait plus rien (voir bug trouvé en testant le Bloc terminal↔chat).
            await self._emit(event, persist=False)
            asyncio.create_task(self._resolve_permission(msg["id"], fut))

    async def _resolve_permission(self, request_id: int, fut: asyncio.Future):
        option_id, answers = await fut
        result = {"outcome": {"outcome": "selected", "optionId": option_id}}
        if answers:
            # Extension qwen-code hors spec ACP standard (confirmée en lisant
            # acpAgent-PKCTYWJV.js : AskUserQuestionToolInvocation lit
            # `output.answers` au même niveau que `output.outcome`) — porte les
            # réponses du formulaire de l'outil natif `ask_user_question`.
            result["answers"] = answers
        await self._write({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result,
        })

    def _normalize_update(self, update: dict):
        kind = update.get("sessionUpdate")
        if kind == "user_message_chunk":
            # N'arrive que lors du rejeu d'une session reprise (session/load) —
            # en streaming live, le message utilisateur part de send_user_message().
            return {"type": "user_message", "text": update["content"]["text"]}
        if kind == "agent_thought_chunk":
            return {"type": "agent_thought_chunk", "text": update["content"]["text"]}
        if kind == "agent_message_chunk":
            return {"type": "agent_message_chunk", "text": update["content"]["text"]}
        if kind in ("tool_call", "tool_call_update"):
            # "tool_call" (annonce initiale, porte le titre) était ignoré —
            # seul "tool_call_update" (deltas de statut, souvent sans titre)
            # était géré, laissant les entrées du journal avec un texte
            # générique "action" au lieu du vrai nom de l'outil.
            return {
                "type": "tool_call_update",
                "id": update.get("toolCallId"),
                "status": update.get("status"),
                "title": update.get("title"),
            }
        return None

    async def _emit(self, event: dict, persist: bool = True):
        """Ajoute au fil courant (mémoire, + SQLite si persist) puis diffuse —
        ne pas utiliser pour les events de contrôle (ex. session_reset) qui ne
        doivent pas être rejoués tels quels à la reconnexion."""
        self.history.append(event)
        if persist:
            # Indexé par session_id qwen-code, PAS par cwd — un même dossier
            # accumule plusieurs sessions au fil du temps (nouvelle session,
            # reprises différentes), indexer par cwd rechargeait au redémarrage
            # un mélange de TOUTES les conversations passées de ce dossier
            # (régression trouvée en testant juste après le premier correctif).
            # sqlite3 est synchrone (commit = fsync-ish) — appelé via to_thread,
            # sinon un chunk de streaming sur deux bloquerait l'event loop entier
            # (donc tous les autres clients WS) le temps de l'écriture disque.
            await asyncio.to_thread(self.history_store.append, self.session_id, event)
        await self.broadcast(event)
        self._maybe_push_notify(event)

    def _maybe_push_notify(self, event: dict):
        # webpush() fait une vraie requête HTTP bloquante — jamais dans l'event
        # loop. Fire-and-forget : un push raté ne doit pas casser le tour en cours.
        if event["type"] == "permission_request":
            title = "Approbation requise"
            body = event.get("toolTitle") or "qwen-code attend une action de ta part."
        elif event["type"] == "turn_end":
            title = "Tâche terminée"
            body = "qwen-code a fini de répondre."
        else:
            return
        asyncio.create_task(asyncio.to_thread(push_notifications.notify_all, title, body))

    async def broadcast(self, event: dict):
        dead = set()
        for ws in list(self.subscribers):
            try:
                await ws.send_json(event)
            except Exception:
                dead.add(ws)
        self.subscribers -= dead
