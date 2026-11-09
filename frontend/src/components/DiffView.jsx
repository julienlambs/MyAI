// Partagé entre l'approbation de tool call (ChatPanel) et l'aperçu de fichier
// (FilesPanel, diff vs HEAD) — même limite connue : toutes les lignes
// supprimées puis toutes les ajoutées, pas un vrai diff aligné (LCS), voir
// journal.md backlog.

// Le texte lui-même est déjà plafonné côté backend pour le diff vs HEAD (voir
// files_api.py, MAX_DIFF_BYTES), mais pas pour le diff d'approbation d'un tool
// call (payload ACP direct) — filet de sécurité ici pour ne jamais monter des
// milliers de <div> d'un coup, quelle que soit la source.
const MAX_LINES = 2000

export default function DiffView({ diff }) {
  const oldLines = diff.oldText ? diff.oldText.split('\n') : []
  const newLines = diff.newText ? diff.newText.split('\n') : []
  const oldTruncated = oldLines.length > MAX_LINES
  const newTruncated = newLines.length > MAX_LINES
  return (
    <div className="diff-view coupe">
      {oldLines.slice(0, MAX_LINES).map((l, i) => <div key={`o${i}`} className="diff-line diff-remove">− {l || ' '}</div>)}
      {oldTruncated && <div className="diff-line-truncated">{oldLines.length - MAX_LINES} lignes supprimées non affichées.</div>}
      {newLines.slice(0, MAX_LINES).map((l, i) => <div key={`n${i}`} className="diff-line diff-add">+ {l || ' '}</div>)}
      {newTruncated && <div className="diff-line-truncated">{newLines.length - MAX_LINES} lignes ajoutées non affichées.</div>}
      {diff.truncated && <div className="diff-line-truncated">Fichier tronqué : trop volumineux pour un diff complet.</div>}
    </div>
  )
}
