"""Notifications push (Web Push standard, VAPID) — déclenchées sur
permission_request et turn_end par agent_bridge.py. Un seul utilisateur,
un seul jeu de clés VAPID généré une fois (voir README ci-dessous),
abonnements stockés dans un fichier JSON (pas besoin d'une vraie table)."""

import json
import logging
import os
from pathlib import Path

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid
from pywebpush import WebPushException, webpush
import base64

logger = logging.getLogger("push_notifications")

BACKEND_DIR = Path(__file__).parent
PRIVATE_KEY_FILE = BACKEND_DIR / "vapid_private.pem"
SUBSCRIPTIONS_FILE = BACKEND_DIR / "push_subscriptions.json"
# Contact requis par la spec Web Push (RFC 8292) — un mailto: ou une URL
VAPID_CLAIMS = {"sub": os.getenv("VAPID_CONTACT", "mailto:admin@example.com")}

if not PRIVATE_KEY_FILE.exists():
    vapid = Vapid()
    vapid.generate_keys()
    vapid.save_key(str(PRIVATE_KEY_FILE))
else:
    vapid = Vapid.from_file(str(PRIVATE_KEY_FILE))

_raw_public_key = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
VAPID_PUBLIC_KEY = base64.urlsafe_b64encode(_raw_public_key).rstrip(b"=").decode()


def _load_subscriptions() -> list[dict]:
    try:
        return json.loads(SUBSCRIPTIONS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []


def _save_subscriptions(subs: list[dict]):
    SUBSCRIPTIONS_FILE.write_text(json.dumps(subs, indent=2), encoding="utf-8")


def add_subscription(subscription: dict):
    subs = _load_subscriptions()
    if not any(s["endpoint"] == subscription["endpoint"] for s in subs):
        subs.append(subscription)
        _save_subscriptions(subs)


def remove_subscription(endpoint: str):
    subs = [s for s in _load_subscriptions() if s["endpoint"] != endpoint]
    _save_subscriptions(subs)


def notify_all(title: str, body: str):
    """Synchrone (requêtes HTTP bloquantes) — à appeler via asyncio.to_thread
    depuis le code async d'agent_bridge.py, jamais directement dans l'event loop."""
    subs = _load_subscriptions()
    for sub in subs:
        try:
            webpush(
                subscription_info=sub,
                data=json.dumps({"title": title, "body": body}),
                vapid_private_key=str(PRIVATE_KEY_FILE),
                vapid_claims=dict(VAPID_CLAIMS),
            )
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                # Abonnement expiré/révoqué côté navigateur — nettoyage silencieux.
                remove_subscription(sub["endpoint"])
            else:
                logger.warning("Échec envoi push vers %s: %s", sub["endpoint"], exc)
