"""Lecture du contexte du modèle local actif, via llama-swap + llama-server.

llama-swap ne proxifie pas /slots — il faut trouver le port interne du
llama-server actif via /running, puis interroger /slots directement dessus.
"""

import httpx

LLAMA_SWAP_URL = "http://127.0.0.1:9090"


async def get_available_models() -> list[str]:
    """Profils déclarés dans config.yaml, tels qu'exposés par llama-swap —
    source unique de vérité, pas de duplication de cette liste côté webapp."""
    async with httpx.AsyncClient(timeout=3.0) as client:
        try:
            resp = await client.get(f"{LLAMA_SWAP_URL}/v1/models")
            resp.raise_for_status()
            return [m["id"] for m in resp.json().get("data", [])]
        except (httpx.HTTPError, KeyError, ValueError):
            return []


async def get_context_usage() -> dict | None:
    async with httpx.AsyncClient(timeout=3.0) as client:
        try:
            running_resp = await client.get(f"{LLAMA_SWAP_URL}/running")
            running_resp.raise_for_status()
            running = running_resp.json().get("running", [])
            if not running:
                return None

            active = running[0]
            proxy_url = active["proxy"]

            slots_resp = await client.get(f"{proxy_url}/slots")
            slots_resp.raise_for_status()
            slots = slots_resp.json()
            if not slots:
                return None

            # llama-server répartit les requêtes sur plusieurs slots (4 vus en
            # pratique) sans garantir que la conversation en cours reste sur le
            # même — slots[0] pouvait pointer vers un slot inactif/périmé,
            # affichant 0% pendant que la vraie conversation grossissait sur un
            # autre slot (bug trouvé empiriquement : la barre restait à zéro
            # puis "sautait" quand la conversation réelle retombait par hasard
            # sur le slot 0). id_task augmente à chaque nouvelle requête tous
            # slots confondus — le slot avec l'id_task le plus élevé est celui
            # qui vient de servir la requête la plus récente, un meilleur
            # indicateur de "conversation active maintenant" que le nombre brut
            # de tokens (qui pourrait juste refléter une grosse conversation
            # ancienne, plus utilisée depuis — ex. un test CLI ponctuel sur le
            # même modèle en parallèle de l'app).
            slot = max(slots, key=lambda s: s.get("id_task") if s.get("id_task") is not None else -1)
            used = slot.get("n_prompt_tokens", 0)
            total = slot.get("n_ctx", 0)
            percent = round((used / total) * 100) if total else 0

            return {
                "percent": percent,
                "used": used,
                "total": total,
                "model": active.get("model"),
                # Exposé pour agent_bridge.py : permet de détecter si cette
                # valeur reflète une activité réellement postérieure au dernier
                # changement de session (voir set_context_baseline).
                "task_id": slot.get("id_task"),
            }
        except (httpx.HTTPError, KeyError, IndexError, ValueError):
            return None
