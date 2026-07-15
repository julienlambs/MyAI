import json
import os
import platform
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from agent_bridge import AgentBridge
from context_status import get_available_models, get_context_usage
from files_api import (
    create_entry,
    delete_entry,
    get_file_diff,
    get_parent_directory,
    grep_files,
    list_directory,
    read_file_preview,
    rename_entry,
    resolve_raw_file,
    resolve_root,
    search_files,
)
from gpu_status import get_gpu_usage
import push_notifications
from qwen_sessions import list_sessions
from terminal_bridge import TerminalManager

# .env vit sur la partition partagée Windows/Linux (dual-boot) — un seul fichier
# physique ne peut pas porter 2 jeux de chemins à la fois. Même principe que
# config.yaml/config.linux.yaml pour llama-swap : un fichier par OS.
_env_file = ".env.linux" if platform.system() == "Linux" else ".env"
load_dotenv(Path(__file__).parent / _env_file)

app = FastAPI(title="MyAI")

# Pas d'auth applicative — la sécurité vient du binding réseau (Tailscale
# uniquement, voir architecture.md "Accès réseau"). Mais un CORS "*" ouvre un
# vecteur différent : n'importe quelle page web ouverte dans un onglet sur un
# appareil du tailnet (pas forcément un pair malveillant du réseau lui-même)
# pourrait appeler ces endpoints. Restreindre aux origines réelles bloque le
# preflight du navigateur sur les requêtes non-simples (POST/DELETE).
_DEFAULT_ORIGINS = [
    "http://localhost:5180",
    "http://127.0.0.1:5180",
]
# Configurable via .env (ALLOWED_ORIGINS, séparées par des virgules) plutôt que
# figée en dur — l'IP locale du PC sur le réseau domestique (ex. 192.168.x.x)
# est aussi une origine légitime en pratique (accès direct sans passer par
# `tailscale serve`), et elle peut changer avec le bail DHCP.
_env_origins = os.getenv("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = [o.strip() for o in _env_origins.split(",") if o.strip()] or _DEFAULT_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

WORKSPACE_ROOT = os.getenv("WORKSPACE_ROOT", os.getcwd())
PROJECTS_ROOT = os.getenv("PROJECTS_ROOT", str(Path(WORKSPACE_ROOT).parent))
bridge = AgentBridge(WORKSPACE_ROOT)
terminal_manager = TerminalManager(WORKSPACE_ROOT)
PROJECTS_FILE = Path(__file__).parent / "projects.json"
# projects.local.json (non versionné) prend le dessus si présent — permet de garder
# sa vraie liste de projets en local sans la committer dans le repo public, qui ne
# porte que projects.json (générique, MyAI seul) pour rester fonctionnel après un clone.
PROJECTS_LOCAL_FILE = Path(__file__).parent / "projects.local.json"


def _load_projects() -> list[dict]:
    """projects.json/projects.local.json stockent des chemins RELATIFS à PROJECTS_ROOT —
    ce fichier vit sur la partition partagée avec le futur dual-boot Linux, un chemin
    absolu Windows n'aurait aucun sens une fois lu depuis Linux (point de montage
    différent). PROJECTS_ROOT vient de .env, qui lui n'est pas partagé entre OS."""
    source = PROJECTS_LOCAL_FILE if PROJECTS_LOCAL_FILE.exists() else PROJECTS_FILE
    try:
        entries = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    return [{"name": p["name"], "path": str(Path(PROJECTS_ROOT) / p["path"])} for p in entries]


def _is_allowed_cwd(cwd: str) -> bool:
    """cwd doit être un des dossiers listés dans projects.json — sans ça,
    new_session/resume_project côté client pourraient pointer l'agent (accès
    shell/fichiers complet) et l'explorateur sur n'importe quel dossier du
    disque, la protection anti path-traversal de files_api.py bornant les
    chemins RELATIFS à ce cwd, pas le cwd lui-même."""
    normalized = os.path.normpath(cwd).lower()
    return any(os.path.normpath(p["path"]).lower() == normalized for p in _load_projects())


async def _reject_if_bad_origin(websocket: WebSocket) -> bool:
    """CORSMiddleware ne protège que les requêtes HTTP — un navigateur n'applique
    jamais la politique CORS à une connexion WebSocket. Sans ce contrôle,
    n'importe quelle page web ouverte sur un appareil du tailnet pourrait ouvrir
    /ws/chat ou /ws/terminal et obtenir un accès complet (agent shell/fichiers,
    terminal partagé). Les clients non-navigateur (curl, tests) n'envoient pas
    d'Origin — on les laisse passer plutôt que de casser ce usage existant.
    Retourne True si la connexion a été rejetée (l'appelant doit s'arrêter là)."""
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        await websocket.close(code=4403)
        return True
    return False


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/context")
async def context():
    usage = await get_context_usage()
    if not usage:
        return {"percent": None, "used": None, "total": None, "model": None}
    # Repère posé au dernier changement de session (voir agent_bridge.py) —
    # si aucune activité modèle réelle n'a eu lieu depuis (cas d'une session
    # reprise, qui ne rejoue que localement sans jamais appeler llama-server),
    # la valeur lue serait celle de la session précédente : mieux vaut "inconnu"
    # qu'un chiffre qui a l'air à jour mais ne l'est pas.
    baseline = bridge.context_baseline_task_id
    task_id = usage.get("task_id")
    # id_task est un compteur interne au process llama-server actif, pas un
    # identifiant durable — un TTL/crash/reload le fait repartir de zéro sans
    # que notre repère (posé au dernier changement de session) ne le sache.
    # Un id_task qui redescend SOUS l'ancien repère ne peut arriver que dans ce
    # cas (impossible autrement, un compteur ne régresse jamais tout seul) :
    # c'est la preuve d'un nouveau process, l'ancien repère n'a plus de sens
    # (bug remonté par Julien : la barre restait "-" en boucle après les
    # rechargements répétés dus au TTL trop court de qwen-80b).
    if task_id is not None and baseline is not None and task_id < baseline:
        bridge.context_baseline_task_id = None
        baseline = None
    if baseline is not None and (task_id is None or task_id <= baseline):
        return {"percent": None, "used": None, "total": None, "model": usage.get("model")}
    return {"percent": usage["percent"], "used": usage["used"], "total": usage["total"], "model": usage.get("model")}


@app.get("/api/gpu")
async def gpu():
    usage = await get_gpu_usage()
    return usage or {"percent": None, "used": None, "total": None, "utilization": None, "warning": False}


@app.get("/api/models")
async def models():
    return {"available": await get_available_models(), "current": bridge.model_id}


@app.get("/api/projects")
def projects():
    return _load_projects()


@app.get("/api/sessions")
def sessions():
    return list_sessions(bridge.current_cwd)


@app.get("/api/files/list")
def files_list(path: str = "", root: str | None = None):
    return list_directory(resolve_root(root, bridge.current_cwd), path)


@app.get("/api/files/read")
def files_read(path: str, root: str | None = None):
    return read_file_preview(resolve_root(root, bridge.current_cwd), path)


@app.get("/api/files/raw")
def files_raw(path: str, root: str | None = None):
    # Octets bruts (images, PDF) — read_file_preview décode en utf-8 et échoue
    # sur du binaire, ne convient pas pour un <img>/pdf.js côté frontend.
    return FileResponse(resolve_raw_file(resolve_root(root, bridge.current_cwd), path))


@app.get("/api/files/search")
def files_search(query: str, showHidden: bool = False, root: str | None = None):
    if not query.strip():
        return {"results": []}
    return {"results": search_files(resolve_root(root, bridge.current_cwd), query, showHidden)}


@app.get("/api/files/grep")
def files_grep(query: str, showHidden: bool = False, root: str | None = None):
    if not query.strip():
        return {"results": []}
    return {"results": grep_files(resolve_root(root, bridge.current_cwd), query, showHidden)}


@app.get("/api/files/diff")
def files_diff(path: str, root: str | None = None):
    return get_file_diff(resolve_root(root, bridge.current_cwd), path)


@app.post("/api/files/create")
async def files_create(request: Request):
    body = await request.json()
    base = resolve_root(body.get("root"), bridge.current_cwd)
    return create_entry(base, body.get("path", ""), body["name"], body.get("type", "file"))


@app.post("/api/files/rename")
async def files_rename(request: Request):
    body = await request.json()
    base = resolve_root(body.get("root"), bridge.current_cwd)
    return rename_entry(base, body["path"], body["newName"])


@app.delete("/api/files/delete")
def files_delete(path: str, root: str | None = None):
    delete_entry(resolve_root(root, bridge.current_cwd), path)
    return {"status": "ok"}


@app.get("/api/files/parent")
def files_parent(root: str):
    # Racine du disque (ex. "C:\\") atteinte : parent == la racine elle-même.
    return {"parent": get_parent_directory(resolve_root(root, bridge.current_cwd))}


@app.get("/api/push/vapid-public-key")
def push_vapid_public_key():
    return {"key": push_notifications.VAPID_PUBLIC_KEY}


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    push_notifications.add_subscription(await request.json())
    return {"status": "ok"}


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(request: Request):
    body = await request.json()
    push_notifications.remove_subscription(body["endpoint"])
    return {"status": "ok"}


@app.get("/api/terminals")
def terminals_list():
    return terminal_manager.list()


@app.post("/api/terminals")
async def terminals_create():
    # async, pas juste def — sinon FastAPI dispatche dans un thread du pool
    # (pas la boucle event loop principale), et ensure_started() plante sur
    # asyncio.get_event_loop() ("no current event loop in thread"). Voir
    # aussi ws_terminal, qui appelait déjà ensure_started() depuis un handler
    # async pour la même raison, avant l'introduction du multi-terminal.
    return terminal_manager.create()


@app.delete("/api/terminals/{terminal_id}")
def terminals_close(terminal_id: str):
    terminal_manager.close(terminal_id)
    return {"status": "ok"}


@app.websocket("/ws/chat")
async def ws_chat(websocket: WebSocket):
    if await _reject_if_bad_origin(websocket):
        return
    await websocket.accept()
    await bridge.ensure_started()
    bridge.subscribe(websocket)
    await websocket.send_json({
        "type": "session_info",
        "cwd": bridge.current_cwd,
        "modeId": bridge.current_mode_id,
        "availableModes": bridge.available_modes,
        "model": bridge.model_id,
    })
    for event in bridge.history:
        await websocket.send_json(event)
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            if msg_type == "user_message":
                await bridge.send_user_message(data["text"])
            elif msg_type == "permission_response":
                await bridge.respond_permission(data["id"], data["optionId"], data.get("answers"))
            elif msg_type == "new_session":
                if _is_allowed_cwd(data["cwd"]):
                    await bridge.new_session(data["cwd"])
                else:
                    await websocket.send_json({"type": "error", "message": "Dossier non autorisé — absent de projects.json"})
            elif msg_type == "resume_project":
                if _is_allowed_cwd(data["cwd"]):
                    await bridge.resume_session(data["cwd"], data.get("sessionId"))
                else:
                    await websocket.send_json({"type": "error", "message": "Dossier non autorisé — absent de projects.json"})
            elif msg_type == "compact":
                await bridge.compact()
            elif msg_type == "cancel_turn":
                await bridge.cancel_turn()
            elif msg_type == "set_mode":
                await bridge.set_mode(data["modeId"])
            elif msg_type == "switch_model":
                model_id = data.get("modelId")
                available = await get_available_models()
                if model_id not in available:
                    await websocket.send_json({"type": "error", "message": f"Modèle inconnu : {model_id}"})
                else:
                    try:
                        await bridge.switch_model(model_id)
                    except RuntimeError as exc:
                        await websocket.send_json({"type": "error", "message": str(exc)})
    except WebSocketDisconnect:
        bridge.unsubscribe(websocket)


@app.websocket("/ws/terminal/{terminal_id}")
async def ws_terminal(websocket: WebSocket, terminal_id: str):
    if await _reject_if_bad_origin(websocket):
        return
    term = terminal_manager.get(terminal_id)
    if term is None:
        # accept() avant close() est nécessaire pour que le code 4404 arrive
        # vraiment côté navigateur — fermer avant accept() se traduit par un
        # rejet HTTP générique au niveau du handshake (le code personnalisé
        # est perdu), et le frontend recevrait alors un code de fermeture
        # anormal indiscernable d'une vraie coupure réseau, retentant en
        # boucle un id de terminal qui n'existe plus.
        await websocket.accept()
        await websocket.close(code=4404)
        return
    await websocket.accept()
    term.subscribe(websocket)
    # Pas de replay du buffer brut (une troncature couperait une séquence ANSI
    # en plein milieu, déjà vu — voir architecture.md). Mais envoyer un simple
    # reset ANSI au client ne suffit pas : PowerShell continue de croire que
    # son curseur est là où il l'a laissé avant cette (re)connexion, donc son
    # prochain redessin de ligne (PSReadLine, positionnement absolu) atterrit
    # au mauvais endroit côté client tant qu'aucune frappe n'a forcé un
    # prompt neuf — c'est le bug "premières lettres tapées = charabia, correct
    # après la première touche Entrée" remonté par Julien. On envoie donc
    # Ctrl+L (0x0c) comme une vraie frappe : PowerShell/PSReadLine l'interprète
    # nativement comme "effacer l'écran et réafficher le prompt actuel", ce qui
    # resynchronise réellement son curseur avec un écran client vierge.
    term.write("\x0c")
    try:
        while True:
            msg = await websocket.receive_json()
            if msg.get("type") == "input":
                term.write(msg["data"])
            elif msg.get("type") == "resize":
                term.resize(msg["rows"], msg["cols"])
    except WebSocketDisconnect:
        term.unsubscribe(websocket)
