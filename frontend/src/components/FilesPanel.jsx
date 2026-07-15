import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentSocket } from '../lib/useAgentSocket'
import { usePanelBridge } from '../lib/usePanelBridge'
import { useDialogs } from '../lib/useDialogs'
import FilePreview from './FilePreview'

// Toutes les lignes de l'arbre font la même hauteur (une seule ligne de
// texte) — doit rester vrai pour tout ajout futur dans la même liste
// (renommage/création inline, Lot 8), sinon le calcul par index casse.
const ROW_HEIGHT = 27
const VIRTUALIZE_THRESHOLD = 150
const OVERSCAN = 8

async function fetchChildren(path, root) {
  const res = await fetch(`/api/files/list?path=${encodeURIComponent(path)}&root=${encodeURIComponent(root)}`)
  if (!res.ok) throw new Error(`Erreur ${res.status}`)
  const data = await res.json()
  return data.items
}

// Chemin absolu = root + relatif — nécessaire pour "envoyer au chat"/glisser-
// déposer une fois que l'explorateur peut naviguer hors du dossier de session
// de l'agent (un chemin relatif à une racine qui n'est plus la sienne ne
// voudrait rien dire pour ses outils read_file/edit).
function absolutePath(root, relative) {
  if (!relative) return root
  return `${root.replace(/\/$/, '')}/${relative}`
}

// node_modules/__pycache__ noient le reste sur n'importe quel projet JS/Python —
// masqués par défaut comme les dotfiles, togglable via l'oeil dans la barre d'outils.
const HIDDEN_NAMES = new Set(['node_modules', '__pycache__'])
function isHidden(name) {
  return name.startsWith('.') || HIDDEN_NAMES.has(name)
}

const SORT_OPTIONS = [
  { id: 'name', label: 'Nom' },
  { id: 'size', label: 'Taille' },
  { id: 'modified', label: 'Modifié' },
]

function sortItems(items, sortBy, foldersFirst) {
  return [...items].sort((a, b) => {
    if (foldersFirst && a.type !== b.type) return a.type === 'folder' ? -1 : 1
    if (sortBy === 'size') return (a.size ?? -1) - (b.size ?? -1)
    if (sortBy === 'modified') return new Date(b.modified) - new Date(a.modified)
    return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
  })
}

function buildRows(childrenByPath, expandedPaths, parentPath, depth, out, sortBy, foldersFirst, showHidden) {
  const raw = childrenByPath[parentPath]
  if (!raw) return
  const children = sortItems(showHidden ? raw : raw.filter((it) => !isHidden(it.name)), sortBy, foldersFirst)
  for (const item of children) {
    const path = parentPath ? `${parentPath}/${item.name}` : item.name
    out.push({ ...item, path, depth })
    if (item.type === 'folder' && expandedPaths[path]) {
      buildRows(childrenByPath, expandedPaths, path, depth + 1, out, sortBy, foldersFirst, showHidden)
    }
  }
}

function formatSize(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

function formatModified(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const RECENT_MS = 5 * 60 * 1000
function isRecent(iso, now) {
  return iso ? now - new Date(iso).getTime() < RECENT_MS : false
}

function countLoaded(childrenByPath, showHidden) {
  return Object.values(childrenByPath).reduce(
    (sum, items) => sum + items.filter((i) => i.type === 'file' && (showHidden || !isHidden(i.name))).length,
    0
  )
}

const GIT_BADGE_META = {
  '?': { label: '+', color: 'var(--lo)', title: 'non suivi' },
  A: { label: '+', color: 'var(--lo)', title: 'ajouté' },
  D: { label: '−', color: 'var(--hi)', title: 'supprimé' },
  U: { label: '!', color: 'var(--hi)', title: 'conflit' },
  M: { label: 'M', color: 'var(--md)', title: 'modifié' },
}

function gitBadge(code, summary) {
  if (!code) return null
  const marker = ['U', 'D', 'M', 'A', '?'].find((m) => code.includes(m)) ?? code[0]
  const meta = GIT_BADGE_META[marker] ?? { label: '•', color: 'var(--md)', title: code }
  // summary vient du rollup dossier ("2M · 1D") — plus honnête qu'un seul mot
  // quand plusieurs enfants ont des statuts différents (voir files_api.py).
  return { ...meta, title: summary ?? meta.title }
}

const FILE_ICONS = {
  py: '🐍', js: '📜', jsx: '📜', mjs: '📜', ts: '📜', tsx: '📜',
  json: '🧩', md: '📝', css: '🎨', html: '🌐',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️',
  pdf: '📕', txt: '📄', log: '📄',
  yml: '⚙️', yaml: '⚙️', toml: '⚙️', ini: '⚙️', cfg: '⚙️',
  sh: '🖥️', bat: '🖥️', ps1: '🖥️',
  env: '🔐', lock: '🔒',
  db: '🗄️', sqlite: '🗄️', sqlite3: '🗄️',
  zip: '🗜️', gz: '🗜️', tar: '🗜️',
  woff: '🔤', woff2: '🔤', ttf: '🔤', otf: '🔤',
}

function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return FILE_ICONS[ext] ?? '📄'
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg'])

function previewKind(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return 'text'
}

export default function FilesPanel({ variant, gridArea, onActivate }) {
  const { cwd, filesChangedAt } = useAgentSocket()
  const { sendToChat } = usePanelBridge()
  const { confirm, alert, prompt } = useDialogs()
  // Racine actuelle de l'explorateur — indépendante du cwd de la session agent
  // une fois qu'on a navigué vers un parent (voir architecture.md "Navigation
  // libre dans l'explorateur") : remonter dans l'arbre ne déplace pas le
  // dossier de travail de l'agent, juste ce que l'explorateur affiche.
  const [root, setRoot] = useState(null)
  const [parentAvailable, setParentAvailable] = useState(false)
  const [childrenByPath, setChildrenByPath] = useState({})
  const [expandedPaths, setExpandedPaths] = useState({})
  const [selectedPath, setSelectedPath] = useState(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState(null)
  const [showHidden, setShowHidden] = useState(false)
  const [sortBy, setSortBy] = useState('name')
  const [foldersFirst, setFoldersFirst] = useState(true)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [preview, setPreview] = useState(null)
  const [searchMode, setSearchMode] = useState('name')
  const [searchResults, setSearchResults] = useState(null)
  const [contentResults, setContentResults] = useState(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState(() => new Set())
  const [contextMenu, setContextMenu] = useState(null)
  const treeRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)

  // (Re)charge la racine quand le dossier de session change (nouvelle session)
  // — ramène aussi l'explorateur au dossier du projet si on avait navigué
  // ailleurs sur une session précédente.
  useEffect(() => {
    if (!cwd) return
    setRoot(cwd)
  }, [cwd])

  // Recharge l'arbre à chaque changement de racine (session ou navigation
  // parent/accueil) — un seul point d'entrée pour ne pas dupliquer le reset
  // d'état entre les deux déclencheurs.
  useEffect(() => {
    if (!root) return
    setChildrenByPath({})
    setExpandedPaths({})
    setSelectedPath(null)
    setPreview(null)
    setError(null)
    setFilter('')
    setSearchResults(null)
    setContentResults(null)
    setSelectedPaths(new Set())
    setContextMenu(null)
    fetchChildren('', root).then(
      (items) => setChildrenByPath({ '': items }),
      (err) => setError(err.message)
    )
    fetch(`/api/files/parent?root=${encodeURIComponent(root)}`)
      .then((r) => r.json())
      .then((data) => setParentAvailable(data.parent != null))
      .catch(() => setParentAvailable(false))
  }, [root])

  function goToParent() {
    fetch(`/api/files/parent?root=${encodeURIComponent(root)}`)
      .then((r) => r.json())
      .then((data) => { if (data.parent) setRoot(data.parent) })
  }

  function goHome() {
    if (cwd) setRoot(cwd)
  }

  // Déclenché directement au clic (pas via un effect sur selectedPath) — évite
  // de devoir re-dériver l'item sélectionné dans une dépendance d'effet.
  function selectFile(item) {
    setSelectedPath(item.path)
    const kind = previewKind(item.name)
    if (kind !== 'text') {
      setPreview({ path: item.path, kind, loading: false, error: null })
      return
    }
    setPreview({ path: item.path, kind: 'text', loading: true, error: null })
    fetch(`/api/files/read?path=${encodeURIComponent(item.path)}&root=${encodeURIComponent(root)}`)
      .then((r) => r.json())
      .then((data) => setPreview({
        path: item.path,
        kind: data.binary ? 'unsupported' : 'text',
        loading: false,
        error: null,
        content: data.content,
        truncated: data.truncated,
      }))
      .catch((err) => setPreview({ path: item.path, kind: 'text', loading: false, error: err.message }))
  }

  function selectSingle(item) {
    setSelectedPaths(new Set())
    setSelectedPath(item.path)
    if (item.type === 'file') selectFile(item)
  }

  // Ctrl/Cmd+clic — ajoute/retire de la sélection multiple sans perdre les
  // autres. La preview suit toujours le dernier élément cliqué (comportement
  // standard d'un gestionnaire de fichiers).
  function toggleMultiSelect(item) {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(item.path)) next.delete(item.path)
      else next.add(item.path)
      return next
    })
    setSelectedPath(item.path)
    if (item.type === 'file') selectFile(item)
  }

  function handleRowClick(e, item, { expandable } = {}) {
    if (e.ctrlKey || e.metaKey) {
      toggleMultiSelect(item)
      return
    }
    if (expandable && item.type === 'folder') {
      toggleFolder(item.path)
      return
    }
    selectSingle(item)
  }

  function handleRowContextMenu(e, item) {
    e.preventDefault()
    if (!selectedPaths.has(item.path)) {
      setSelectedPaths(new Set([item.path]))
      setSelectedPath(item.path)
    }
    setContextMenu({ x: e.clientX, y: e.clientY, item })
  }

  // Racine + dossiers actuellement dépliés — inutile de re-précharger les
  // dossiers repliés, ils seront rafraîchis de toute façon à la prochaine ouverture.
  async function refreshAll() {
    setRefreshing(true)
    const paths = ['', ...Object.keys(expandedPaths).filter((p) => expandedPaths[p])]
    const results = await Promise.all(
      paths.map((p) => fetchChildren(p).then((items) => [p, items]).catch(() => [p, null]))
    )
    setChildrenByPath((prev) => {
      const next = { ...prev }
      for (const [p, items] of results) if (items) next[p] = items
      return next
    })
    setRefreshing(false)
  }

  // Auto-refresh quand un tool call se termine — l'agent vient peut-être de
  // créer/éditer/supprimer un fichier, sinon l'explorateur ne le verrait
  // jamais tant qu'on ne change pas de session (cache qui ne s'invalidait pas).
  useEffect(() => {
    if (filesChangedAt == null) return
    refreshAll()
  }, [filesChangedAt])

  // Recherche récursive réelle (nom ou contenu selon searchMode) — remplace le
  // filtre substring qui ne portait que sur les dossiers déjà dépliés/chargés.
  // Debounce 250ms pour ne pas taper le backend à chaque frappe.
  useEffect(() => {
    const q = filter.trim()
    if (!q || !root) {
      setSearchResults(null)
      setContentResults(null)
      setSearchLoading(false)
      return
    }
    let cancelled = false
    setSearchLoading(true)
    setSelectedPaths(new Set())
    const timer = setTimeout(() => {
      const endpoint = searchMode === 'content' ? '/api/files/grep' : '/api/files/search'
      fetch(`${endpoint}?query=${encodeURIComponent(q)}&showHidden=${showHidden}&root=${encodeURIComponent(root)}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return
          if (searchMode === 'content') setContentResults(data.results)
          else setSearchResults(data.results)
          setSearchLoading(false)
        })
        .catch(() => { if (!cancelled) setSearchLoading(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [filter, showHidden, searchMode, root])

  // Ferme le menu contextuel au clic ailleurs ou à l'échap — un seul listener
  // global, pas un par ligne.
  useEffect(() => {
    if (!contextMenu) return
    function close() { setContextMenu(null) }
    function onKey(e) { if (e.key === 'Escape') setContextMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  // Fait "vieillir" le highlight des fichiers récents sans action de l'utilisateur.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Hauteur du viewport de l'arbre — nécessaire pour savoir combien de lignes
  // rendre en mode virtualisé (gros dossiers, node_modules...).
  useEffect(() => {
    const el = treeRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => setViewportHeight(entries[0].contentRect.height))
    observer.observe(el)
    setViewportHeight(el.clientHeight)
    return () => observer.disconnect()
  }, [])

  function handleTreeScroll(e) {
    setScrollTop(e.currentTarget.scrollTop)
  }

  // Réutilisé par la nav clavier maintenant, et par renommer/créer au Lot 8
  // (amener une ligne fraîchement créée/éditée dans le viewport).
  function scrollIndexIntoView(index) {
    const el = treeRef.current
    if (!el) return
    const rowTop = index * ROW_HEIGHT
    const rowBottom = rowTop + ROW_HEIGHT
    if (rowTop < el.scrollTop) el.scrollTop = rowTop
    else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight
  }

  async function toggleFolder(path) {
    const isExpanded = expandedPaths[path]
    if (isExpanded) {
      setExpandedPaths((p) => ({ ...p, [path]: false }))
      return
    }
    if (!childrenByPath[path]) {
      try {
        const items = await fetchChildren(path, root)
        setChildrenByPath((p) => ({ ...p, [path]: items }))
      } catch (err) {
        setError(err.message)
        return
      }
    }
    setExpandedPaths((p) => ({ ...p, [path]: true }))
  }

  // Après un renommage/suppression de DOSSIER, tout chemin en cache sous
  // l'ancien préfixe (childrenByPath, expandedPaths) devient orphelin — plus
  // simple et plus sûr de tout replier et repartir de la racine que d'essayer
  // de ré-indexer chaque clé une par une.
  function resetTree() {
    setChildrenByPath({})
    setExpandedPaths({})
    fetchChildren('', root).then(
      (items) => setChildrenByPath({ '': items }),
      (err) => setError(err.message)
    )
  }

  function parentOf(path) {
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  }

  async function refreshFolder(path) {
    const items = await fetchChildren(path, root)
    setChildrenByPath((p) => ({ ...p, [path]: items }))
  }

  async function handleCreate(parentPath, kind) {
    const name = await prompt(kind === 'folder' ? 'Nom du nouveau dossier :' : 'Nom du nouveau fichier :')
    if (!name) return
    try {
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: parentPath, name, type: kind, root }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        await alert(err.detail || `Erreur ${res.status}`)
        return
      }
      await refreshFolder(parentPath)
      if (parentPath && !expandedPaths[parentPath]) setExpandedPaths((p) => ({ ...p, [parentPath]: true }))
    } catch (err) {
      await alert(err.message)
    }
  }

  async function handleRename(item) {
    const newName = await prompt('Renommer en :', item.name)
    if (!newName || newName === item.name) return
    try {
      const res = await fetch('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path, newName, root }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        await alert(err.detail || `Erreur ${res.status}`)
        return
      }
      if (item.type === 'folder') resetTree()
      else await refreshFolder(parentOf(item.path))
      setSelectedPath(null)
      setSelectedPaths(new Set())
      setPreview(null)
    } catch (err) {
      await alert(err.message)
    }
  }

  async function handleDelete(items) {
    if (items.length === 0) return
    const label = items.length > 1 ? `${items.length} éléments` : items[0].name
    if (!(await confirm(`Supprimer définitivement ${label} ? Cette action est irréversible.`))) return
    const hasFolder = items.some((it) => it.type === 'folder')
    for (const item of items) {
      try {
        const res = await fetch(`/api/files/delete?path=${encodeURIComponent(item.path)}&root=${encodeURIComponent(root)}`, { method: 'DELETE' })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          await alert(`${item.name} : ${err.detail || `Erreur ${res.status}`}`)
        }
      } catch (err) {
        await alert(`${item.name} : ${err.message}`)
      }
    }
    if (hasFolder) {
      resetTree()
    } else {
      const parents = new Set(items.map((it) => parentOf(it.path)))
      await Promise.all([...parents].map(refreshFolder))
    }
    setSelectedPath(null)
    setSelectedPaths(new Set())
    setPreview(null)
  }

  // Mémoïsé indépendamment de scrollTop/now : sans ça, buildRows (parcours
  // récursif + tri à chaque niveau de l'arbre déplié) retournait à chaque
  // pixel de scroll (state scrollTop mis à jour à chaque event onScroll) —
  // annulait une bonne partie du bénéfice de la virtualisation ci-dessous sur
  // un gros dossier (node_modules...).
  const rows = useMemo(() => {
    const out = []
    buildRows(childrenByPath, expandedPaths, '', 0, out, sortBy, foldersFirst, showHidden)
    return out
  }, [childrenByPath, expandedPaths, sortBy, foldersFirst, showHidden])
  const isSearching = filter.trim().length > 0
  // Un item peut venir d'un résultat de recherche (dossier pas forcément
  // déplié dans l'arbre, ou fichier trouvé via grep) — pas seulement des
  // lignes de l'arbre visible. Le fallback grep n'a pas taille/date connues
  // (juste de quoi activer l'aperçu/renommer/supprimer), acceptable pour un
  // résultat de recherche.
  function findItem(path) {
    return rows.find((r) => r.path === path)
      ?? searchResults?.find((r) => r.path === path)
      ?? (contentResults?.some((r) => r.path === path)
        ? { path, name: path.split('/').pop(), type: 'file' }
        : undefined)
  }
  const selectedItem = selectedPath ? findItem(selectedPath) : undefined

  // Vue normalisée du mode courant (arbre / résultats nom / résultats grep) —
  // sert uniquement à la navigation clavier, qui n'a pas besoin du détail
  // ligne/snippet propre au rendu grep.
  const visibleItems = isSearching
    ? (searchMode === 'content'
      ? (contentResults || []).map((r) => ({ path: r.path, name: r.path.split('/').pop(), type: 'file' }))
      : (searchResults || []))
    : rows

  function handleTreeKeyDown(e) {
    if (e.key === 'Escape') { setSelectedPaths(new Set()); return }
    if (visibleItems.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = visibleItems.findIndex((it) => it.path === selectedPath)
      const step = e.key === 'ArrowDown' ? 1 : -1
      const nextIdx = idx === -1 ? 0 : Math.max(0, Math.min(visibleItems.length - 1, idx + step))
      selectSingle(visibleItems[nextIdx])
      if (!isSearching) scrollIndexIntoView(nextIdx)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const current = visibleItems.find((it) => it.path === selectedPath)
      if (!current) return
      if (!isSearching && current.type === 'folder') toggleFolder(current.path)
      else if (current.type === 'file') selectFile(current)
    } else if (e.key === 'ArrowRight' && !isSearching) {
      const current = rows.find((r) => r.path === selectedPath)
      if (current?.type === 'folder' && !expandedPaths[current.path]) toggleFolder(current.path)
    } else if (e.key === 'ArrowLeft' && !isSearching) {
      const current = rows.find((r) => r.path === selectedPath)
      if (current?.type === 'folder' && expandedPaths[current.path]) toggleFolder(current.path)
    }
  }

  // Ne s'active qu'au-delà du seuil — inutile d'ajouter la complexité des
  // espaceurs pour un dossier de 20 fichiers qui tient déjà à l'écran.
  const virtualize = !isSearching && rows.length > VIRTUALIZE_THRESHOLD
  const virtualStart = virtualize ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0
  const virtualEnd = virtualize
    ? Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
    : rows.length
  const visibleRows = virtualize ? rows.slice(virtualStart, virtualEnd) : rows

  return (
    <div className="panel is-main" style={{ gridArea }} data-slot={gridArea}>
      <div className="panel-full">
        <div className="section-header">
          <div className="section-title-row">
            <div className="section-title">
              <span className="sym">◎</span>
              <span className="name">Explorateur</span>
              <span className="pill">{countLoaded(childrenByPath, showHidden)} fichiers</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {variant !== 'full' && (
                <button
                  className="btn"
                  style={{ background: 'var(--card-2)', color: 'var(--muted)', borderRadius: 6, width: 24, height: 24, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={onActivate}
                  title="Agrandir ce panneau"
                >
                  ⤢
                </button>
              )}
              <span className="kbd">⌘2</span>
            </div>
          </div>
          <div className="files-breadcrumb">
            <button
              className="btn files-toggle"
              onClick={goToParent}
              disabled={!parentAvailable}
              title={parentAvailable ? 'Remonter au dossier parent' : 'Déjà à la racine du disque'}
            >
              ⬆
            </button>
            <span className="files-root-path" title={root ?? ''}>{root ?? '—'}</span>
            {root !== cwd && (
              <button className="btn files-toggle" onClick={goHome} title="Revenir au dossier du projet">
                🏠
              </button>
            )}
          </div>
          <div className="files-toolbar">
            <input
              className="files-search"
              placeholder={searchMode === 'content' ? 'Rechercher dans le contenu…' : 'Filtrer les fichiers…'}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              className={`btn files-toggle${searchMode === 'content' ? ' active' : ''}`}
              onClick={() => { setSearchMode((m) => (m === 'content' ? 'name' : 'content')); setFilter('') }}
              title={searchMode === 'content' ? 'Revenir à la recherche par nom' : 'Rechercher dans le contenu des fichiers'}
            >
              🔎
            </button>
            <button
              className="btn files-toggle"
              onClick={() => setShowHidden((v) => !v)}
              title={showHidden ? 'Masquer les fichiers cachés / node_modules' : 'Afficher les fichiers cachés / node_modules'}
            >
              {showHidden ? '🙈' : '👁'}
            </button>
            <button
              className={`btn files-toggle${refreshing ? ' spinning' : ''}`}
              onClick={refreshAll}
              disabled={refreshing}
              title="Rafraîchir"
            >
              🔄
            </button>
            <div className="files-sort-wrap">
              <button className="btn files-toggle" onClick={() => setSortMenuOpen((v) => !v)} title="Trier">⇅</button>
              {sortMenuOpen && (
                <div className="mobile-menu-dropdown files-sort-dropdown">
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => { setSortBy(opt.id); setSortMenuOpen(false) }}
                      style={sortBy === opt.id ? { color: 'var(--accent)' } : undefined}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <button onClick={() => setFoldersFirst((v) => !v)}>
                    {foldersFirst ? '☑' : '☐'} Dossiers d'abord
                  </button>
                </div>
              )}
            </div>
            <div className="files-sort-wrap">
              <button className="btn files-toggle" onClick={() => setCreateMenuOpen((v) => !v)} title="Créer à la racine">➕</button>
              {createMenuOpen && (
                <div className="mobile-menu-dropdown files-sort-dropdown">
                  <button onClick={() => { setCreateMenuOpen(false); handleCreate('', 'file') }}>📄 Nouveau fichier</button>
                  <button onClick={() => { setCreateMenuOpen(false); handleCreate('', 'folder') }}>📁 Nouveau dossier</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="tree" tabIndex={0} onKeyDown={handleTreeKeyDown} onScroll={handleTreeScroll} ref={treeRef}>
          {error && <div style={{ padding: 12, fontSize: 12, color: 'var(--hi)' }}>⚠ {error}</div>}

          {!error && isSearching && searchLoading && (
            <div className="empty-daemon">
              <div><span className="caret">&gt;</span> myai.files.{searchMode === 'content' ? 'grep' : 'search'}("{filter}")</div>
              <div className="note">[note] recherche en cours…</div>
            </div>
          )}

          {!error && isSearching && !searchLoading && searchMode === 'name' && (
            searchResults?.length ? searchResults.map((r) => {
              const isSelected = r.path === selectedPath || selectedPaths.has(r.path)
              const icon = r.type === 'folder' ? '📁' : fileIcon(r.name)
              return (
                <div
                  key={r.path}
                  className={`tree-row${isSelected ? ' selected' : ''}`}
                  style={{ paddingLeft: 12 }}
                  draggable={r.type === 'file'}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', absolutePath(root, r.path))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={(e) => handleRowClick(e, r)}
                  onContextMenu={(e) => handleRowContextMenu(e, r)}
                >
                  <span className="file-icon">{icon}</span>
                  {(() => {
                    const badge = gitBadge(r.gitStatus, r.gitSummary)
                    return badge && (
                      <span className="git-badge" style={{ color: badge.color }} title={badge.title}>{badge.label}</span>
                    )
                  })()}
                  <span className="search-result-path">{r.path}</span>
                </div>
              )
            }) : (
              <div className="empty-daemon">
                <div><span className="caret">&gt;</span> myai.files.search("{filter}")</div>
                <div className="note">[note] aucun résultat.</div>
              </div>
            )
          )}

          {!error && isSearching && !searchLoading && searchMode === 'content' && (
            contentResults?.length ? contentResults.map((r, i) => {
              const item = { path: r.path, name: r.path.split('/').pop(), type: 'file' }
              const isSelected = selectedPath === r.path || selectedPaths.has(r.path)
              return (
                <div
                  key={`${r.path}:${r.line}:${i}`}
                  className={`tree-row grep-row${isSelected ? ' selected' : ''}`}
                  style={{ paddingLeft: 12 }}
                  onClick={(e) => handleRowClick(e, item)}
                  onContextMenu={(e) => handleRowContextMenu(e, item)}
                >
                  <span className="file-icon">{fileIcon(r.path)}</span>
                  <span className="grep-location">{r.path}:{r.line}</span>
                  <span className="grep-snippet">{r.snippet}</span>
                </div>
              )
            }) : (
              <div className="empty-daemon">
                <div><span className="caret">&gt;</span> myai.files.grep("{filter}")</div>
                <div className="note">[note] aucun résultat.</div>
              </div>
            )
          )}

          {!error && !isSearching && childrenByPath[''] && rows.length === 0 && (
            <div className="empty-daemon">
              <div><span className="caret">&gt;</span> myai.files.list()</div>
              <div>éléments: 0</div>
              <div className="note">[note] dossier vide.</div>
            </div>
          )}
          {virtualize && <div style={{ height: virtualStart * ROW_HEIGHT }} />}
          {!isSearching && visibleRows.map((r) => {
            const isSelected = r.path === selectedPath || selectedPaths.has(r.path)
            const isExpanded = expandedPaths[r.path]
            const chevron = r.type === 'folder' ? (isExpanded ? '▾' : '▸') : ''
            const icon = r.type === 'folder' ? (isExpanded ? '📂' : '📁') : fileIcon(r.name)
            const indent = r.depth * 18 + 12
            return (
              <div
                key={r.path}
                className={`tree-row${isSelected ? ' selected' : ''}`}
                style={{ paddingLeft: indent }}
                draggable={r.type === 'file'}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', absolutePath(root, r.path))
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={(e) => handleRowClick(e, r, { expandable: true })}
                onContextMenu={(e) => handleRowContextMenu(e, r)}
              >
                <span className="chevron">{chevron}</span>
                <span className="file-icon">{icon}</span>
                {(() => {
                  const badge = gitBadge(r.gitStatus, r.gitSummary)
                  return badge && (
                    <span className="git-badge" style={{ color: badge.color }} title={badge.title}>{badge.label}</span>
                  )
                })()}
                <span>{r.name}</span>
                {r.type === 'file' && isRecent(r.modified, now) && (
                  <span className="recent-dot" title="modifié il y a moins de 5 min" />
                )}
              </div>
            )
          })}
          {virtualize && <div style={{ height: (rows.length - virtualEnd) * ROW_HEIGHT }} />}
        </div>

        {selectedItem?.type === 'file' && <FilePreview preview={preview} gitStatus={selectedItem.gitStatus} root={root} />}

        <div className="file-footer">
          <span>{selectedPaths.size > 1 ? `${selectedPaths.size} éléments sélectionnés` : (selectedItem?.name ?? cwd ?? '—')}</span>
          {(selectedItem || selectedPaths.size > 1)
            ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {selectedPaths.size <= 1 && `${formatSize(selectedItem?.size)} · modifié ${formatModified(selectedItem?.modified)}`}
                <button
                  className="btn"
                  onClick={() => sendToChat(selectedPaths.size > 1 ? [...selectedPaths].map((p) => absolutePath(root, p)).join('\n') : absolutePath(root, selectedItem.path))}
                  title="Insérer le(s) chemin(s) dans le composeur du chat — équivalent tactile du glisser-déposer desktop"
                >
                  ▸ Envoyer{selectedPaths.size > 1 ? ` ${selectedPaths.size} fichiers` : ''} au chat
                </button>
              </span>
            )
            : <span />}
        </div>

        {contextMenu && (
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => { navigator.clipboard.writeText(absolutePath(root, contextMenu.item.path)); setContextMenu(null) }}>
              📋 Copier le chemin
            </button>
            <button
              onClick={() => {
                const paths = selectedPaths.size > 1 ? [...selectedPaths] : [contextMenu.item.path]
                sendToChat(paths.map((p) => absolutePath(root, p)).join('\n'))
                setContextMenu(null)
              }}
            >
              ▸ Envoyer au chat{selectedPaths.size > 1 ? ` (${selectedPaths.size})` : ''}
            </button>
            {contextMenu.item.type === 'folder' && (
              <>
                <button onClick={() => { const p = contextMenu.item.path; setContextMenu(null); handleCreate(p, 'file') }}>
                  📄 Nouveau fichier ici
                </button>
                <button onClick={() => { const p = contextMenu.item.path; setContextMenu(null); handleCreate(p, 'folder') }}>
                  📁 Nouveau dossier ici
                </button>
              </>
            )}
            <button onClick={() => { const item = contextMenu.item; setContextMenu(null); handleRename(item) }}>
              ✏️ Renommer
            </button>
            <button
              onClick={() => {
                const targets = selectedPaths.size > 1
                  ? [...selectedPaths].map(findItem).filter(Boolean)
                  : [contextMenu.item]
                setContextMenu(null)
                handleDelete(targets)
              }}
              style={{ color: 'var(--hi)' }}
            >
              🗑️ Supprimer{selectedPaths.size > 1 ? ` (${selectedPaths.size})` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
