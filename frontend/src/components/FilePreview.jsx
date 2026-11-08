import { useEffect, useRef, useState } from 'react'
import DiffView from './DiffView'
import { Btn, IconBtn, Icone } from '@declic/ui'

// Chargé à la demande (pas d'import statique) — pdfjs-dist pèse plusieurs
// centaines de Ko, inutile de l'envoyer à tout le monde tant qu'aucun PDF
// n'a été ouvert.
let pdfjsPromise = null
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.mjs?url'),
    ]).then(([lib, workerUrlModule]) => {
      lib.GlobalWorkerOptions.workerSrc = workerUrlModule.default
      return lib
    })
  }
  return pdfjsPromise
}

function PdfPreview({ url }) {
  const canvasRef = useRef(null)
  const docRef = useRef(null)
  const [pageNum, setPageNum] = useState(1)
  const [numPages, setNumPages] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setPageNum(1)
    setNumPages(null)
    setError(null)
    loadPdfjs()
      .then((pdfjs) => pdfjs.getDocument({ url }).promise)
      .then((pdf) => {
        if (cancelled) return
        docRef.current = pdf
        setNumPages(pdf.numPages)
      })
      .catch((err) => !cancelled && setError(err.message))
    return () => { cancelled = true }
  }, [url])

  useEffect(() => {
    if (!docRef.current || !canvasRef.current || !numPages) return
    let cancelled = false
    docRef.current.getPage(pageNum).then((page) => {
      if (cancelled) return
      const viewport = page.getViewport({ scale: 1.3 })
      const canvas = canvasRef.current
      canvas.width = viewport.width
      canvas.height = viewport.height
      page.render({ canvasContext: canvas.getContext('2d'), viewport })
    })
    return () => { cancelled = true }
  }, [pageNum, numPages])

  if (error) return <div className="preview-error"><Icone nom="erreur" /> Aperçu PDF impossible : {error}</div>

  return (
    <div className="pdf-preview">
      <canvas ref={canvasRef} />
      {numPages > 1 && (
        <div className="pdf-preview-nav">
          <IconBtn kind="ghost" label="Page précédente" icon={<Icone nom="retour" />} disabled={pageNum <= 1} onClick={() => setPageNum((p) => p - 1)} />
          <span>{pageNum} / {numPages}</span>
          <IconBtn kind="ghost" label="Page suivante" icon={<Icone nom="suivant" />} disabled={pageNum >= numPages} onClick={() => setPageNum((p) => p + 1)} />
        </div>
      )}
    </div>
  )
}

// Diff vs HEAD séparé de l'aperçu normal — un seul bouton de bascule, le
// contenu diff n'est chargé qu'au premier clic (pas systématiquement pour
// chaque fichier ouvert, la plupart n'ont pas de changement à montrer).
function TextPreview({ preview, gitStatus, root }) {
  const [showDiff, setShowDiff] = useState(false)
  const [diff, setDiff] = useState(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState(null)

  useEffect(() => {
    setShowDiff(false)
    setDiff(null)
    setDiffError(null)
  }, [preview.path])

  function toggleDiff() {
    if (showDiff) { setShowDiff(false); return }
    setShowDiff(true)
    if (diff) return
    setDiffLoading(true)
    setDiffError(null)
    fetch(`/api/files/diff?path=${encodeURIComponent(preview.path)}&root=${encodeURIComponent(root)}`)
      .then((r) => r.json())
      .then((data) => { setDiff(data); setDiffLoading(false) })
      .catch((err) => { setDiffError(err.message); setDiffLoading(false) })
  }

  return (
    <div className="file-preview">
      {gitStatus && (
        <div className="preview-toolbar">
          <Btn kind="ghost" icon={<Icone nom={showDiff ? 'fichier' : 'git'} />} onClick={toggleDiff} aria-pressed={showDiff}>
            {showDiff ? 'Aperçu' : 'Diff avec HEAD'}
          </Btn>
        </div>
      )}
      {showDiff ? (
        <>
          {diffLoading && <div className="preview-loading">Chargement du diff…</div>}
          {!diffLoading && diffError && <div className="preview-error"><Icone nom="erreur" /> {diffError}</div>}
          {!diffLoading && !diffError && diff?.binary && <div className="preview-error">Diff indisponible : fichier binaire.</div>}
          {!diffLoading && !diffError && diff && !diff.binary && <DiffView diff={diff} />}
        </>
      ) : (
        <>
          <pre className="preview-text">{preview.content}</pre>
          {preview.truncated && <div className="preview-truncated">Aperçu tronqué : fichier trop volumineux pour un aperçu complet.</div>}
        </>
      )}
    </div>
  )
}

export default function FilePreview({ preview, gitStatus, root }) {
  if (!preview) return null

  if (preview.kind === 'image') {
    return (
      <div className="file-preview">
        <img className="preview-image" src={`/api/files/raw?path=${encodeURIComponent(preview.path)}&root=${encodeURIComponent(root)}`} alt={preview.path} />
      </div>
    )
  }

  if (preview.kind === 'pdf') {
    return (
      <div className="file-preview">
        <PdfPreview url={`/api/files/raw?path=${encodeURIComponent(preview.path)}&root=${encodeURIComponent(root)}`} />
      </div>
    )
  }

  if (preview.loading) return <div className="file-preview preview-loading">Chargement…</div>
  if (preview.error) return <div className="file-preview preview-error"><Icone nom="erreur" /> {preview.error}</div>
  if (preview.kind === 'unsupported') {
    return <div className="file-preview preview-error">Aperçu indisponible : fichier binaire non reconnu.</div>
  }

  return <TextPreview preview={preview} gitStatus={gitStatus} root={root} />
}
