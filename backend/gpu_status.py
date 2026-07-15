"""Lecture VRAM/GPU via nvidia-smi — même pattern que context_status.py."""

import asyncio

# Le profil qwen-code tourne normalement à ~93-95% de VRAM (voir
# architecture.md — offload du modèle sur la VRAM disponible, pas une fuite).
# Un seuil à 90% déclenchait l'alerte en permanence en usage normal, ce qui
# la rendait anxiogène pour rien (retour Julien) — 97% ne réagit qu'à une
# vraie approche de l'OOM CUDA, pas à la charge attendue du modèle.
VRAM_WARNING_PERCENT = 97


async def get_gpu_usage() -> dict | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi",
            "--query-gpu=memory.used,memory.total,utilization.gpu",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.0)
        if proc.returncode != 0:
            return None

        line = stdout.decode().strip().splitlines()[0]
        used_str, total_str, util_str = (p.strip() for p in line.split(","))
        used, total, util = int(used_str), int(total_str), int(util_str)
        percent = round((used / total) * 100) if total else 0

        return {
            "used": used,
            "total": total,
            "percent": percent,
            "utilization": util,
            "warning": percent >= VRAM_WARNING_PERCENT,
        }
    except (FileNotFoundError, asyncio.TimeoutError, ValueError, IndexError):
        return None
