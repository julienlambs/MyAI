# MyAI

Webapp locale pour piloter un agent de code IA local ([qwen-code](https://github.com/QwenLM/qwen-code)) depuis un navigateur : chat avec streaming, explorateur de fichiers, terminal indépendant (xterm.js). Interface à 3 panneaux (un actif en plein écran, les deux autres réduits en cartes), pensée pour un usage local et à distance (mobile/tablette via un tunnel type Tailscale).

## Architecture

- **`backend/`** — FastAPI (Python). Lance et pilote un process `qwen --acp` (Agent Client Protocol, JSON-RPC sur stdio) via `agent_bridge.py`, et l'expose au frontend par WebSocket. Explorateur de fichiers et terminal (pty) implémentés directement, indépendants de qwen-code.
- **`frontend/`** — React + Vite, JavaScript pur (pas de TypeScript). CSS custom (variables, pas de framework utilitaire).

qwen-code lui-même route vers un serveur LLM local compatible OpenAI (ex. [llama.cpp](https://github.com/ggml-org/llama.cpp) + [llama-swap](https://github.com/mostlygeek/llama-swap)) — MyAI ne fait pas tourner de modèle, il pilote juste l'agent.

## Prérequis

- Python 3.10+
- Node 18+
- [`qwen-code`](https://github.com/QwenLM/qwen-code) : `npm install -g @qwen-code/qwen-code`
- Un serveur LLM local compatible OpenAI, exposé sur `http://127.0.0.1:9090/v1` par défaut (port attendu par `agent_bridge.py`) — llama-swap devant llama.cpp/llama-server fonctionne bien pour gérer plusieurs profils de modèles

## Installation

### Backend

```
cd backend
python -m venv .venv
.venv\Scripts\activate       # Windows — sous Linux/macOS : source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env         # renseigner WORKSPACE_ROOT, PROJECTS_ROOT, ALLOWED_ORIGINS...
uvicorn main:app --host 0.0.0.0 --port 8000
```

`WORKSPACE_ROOT` doit pointer vers le dossier de ce projet, `PROJECTS_ROOT` vers le dossier parent contenant les projets que l'explorateur/agent peuvent ouvrir.

### Frontend

```
cd frontend
npm install
cp .env.example .env         # VITE_ALLOWED_HOSTS si exposé via un tunnel HTTPS (ex. tailscale serve)
npm run dev
```

Port fixé à `5180` (`vite.config.js`, `strictPort: true`). Le dev server proxifie `/api` et `/ws` vers le backend sur `:8000`.

## Configuration des modèles

`backend/agent_bridge.py` (`MODEL_CONTEXT_SIZES`) attend des identifiants de profil précis, à faire correspondre à ta config llama-swap (nom de profil + taille de contexte réelle négociée, vérifiable via l'endpoint `/slots` du `llama-server` actif).

## Liste des projets accessibles

`backend/projects.json` (générique, contient uniquement `MyAI` par défaut) liste les dossiers ouvrables depuis l'explorateur et par l'agent — c'est aussi la liste blanche de sécurité qui borne les sessions autorisées. Pour ajouter tes propres projets sans les committer, crée `backend/projects.local.json` (même format, prioritaire s'il existe, ignoré par git) :

```json
[
  { "name": "MyAI", "path": "MyAI" },
  { "name": "MonAutreProjet", "path": "chemin/relatif/a/PROJECTS_ROOT" }
]
```

## Notifications push (optionnel)

Web Push standard (VAPID). Une paire de clés est générée automatiquement au premier lancement du backend (`backend/vapid_private.pem`, jamais committée). Renseigne `VAPID_CONTACT` dans `.env` (adresse mailto ou URL, requis par la spec Web Push).

## Accès distant

Le backend doit écouter sur `0.0.0.0` (ou l'IP de ton tunnel) pour être joignable depuis un autre appareil — `llama-swap`/le serveur LLM, eux, doivent rester en local uniquement (`127.0.0.1`). `ALLOWED_ORIGINS` (backend) et `VITE_ALLOWED_HOSTS` (frontend) doivent lister les origines/hôtes réels utilisés (localhost, IP locale, hostname de tunnel HTTPS).
