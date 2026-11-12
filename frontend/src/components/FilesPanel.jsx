import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentSocket } from '../lib/useAgentSocket'
import { usePanelBridge } from '../lib/usePanelBridge'
import { useDialogs } from '../lib/useDialogs'
import FilePreview from './FilePreview'
import { BarreOutils, Btn, EnTetePanneau, IconBtn, Icone, Touche } from '@declic/ui'
import { MenuPop, MenuItem, MenuSep } from './MenuPop'

// Toutes les lignes de l'arbre font la même hauteur (une seule ligne de
// texte) — doit rester vrai pour tout ajout futur dans la même liste
// (renommage/création inline, Lot 8), sinon le calcul par index casse.
const ROW_HEIGHT = 28 // = hauteur de .tree-row dans index.css
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
  const n = (x) => x.toLocaleString('fr-FR', { maximumFractionDigits: 1 })
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${n(bytes / 1024)} Ko`
  return `${n(bytes / (1024 * 1024))} Mo`
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
  '?': { label: '+', color: 'var(--lo)', title: 'Non suivi par Git' },
  A: { label: '+', color: 'var(--lo)', title: 'Ajouté' },
  D: { label: '−', color: 'var(--hi)', title: 'Supprimé' },
  U: { label: '!', color: 'var(--hi)', title: 'En conflit' },
  M: { label: 'M', color: 'var(--md)', title: 'Modifié' },
}

function gitBadge(code, summary) {
  if (!code) return null
  const marker = ['U', 'D', 'M', 'A', '?'].find((m) => code.includes(m)) ?? code[0]
  const meta = GIT_BADGE_META[marker] ?? { label: '•', color: 'var(--md)', title: code }
  // summary vient du rollup dossier ("2M · 1D") — plus honnête qu'un seul mot
  // quand plusieurs enfants ont des statuts différents (voir files_api.py).
  return { ...meta, title: summary ?? meta.title }
}

// Icônes de la charte (icones/) : une famille par type de fichier, pas une par extension.
const FILE_ICONS = {
  py: 'code', js: 'code', jsx: 'code', mjs: 'code', ts: 'code', tsx: 'code', css: 'code',
  json: 'donnees', html: 'globe',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', ico: 'image',
  yml: 'reglages', yaml: 'reglages', toml: 'reglages', ini: 'reglages', cfg: 'reglages',
  sh: 'terminal', bat: 'terminal', ps1: 'terminal',
  env: 'cle', lock: 'verrou',
  db: 'base-de-donnees', sqlite: 'base-de-donnees', sqlite3: 'base-de-donnees',
  zip: 'paquet', gz: 'paquet', tar: 'paquet',
  woff: 'police', woff2: 'police', ttf: 'police', otf: 'police',
}

function fileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return <Icone nom={FILE_ICONS[ext] ?? 'fichier'} />
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
  const sortBtnRef = useRef(null)
  const createBtnRef = useRef(null)

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
    const name = await prompt(kind === 'folder' ? 'Nouveau dossier' : 'Nouveau fichier', '', { action: kind === 'folder' ? 'Créer le dossier' : 'Créer le fichier' })
    if (!name) return
    try {
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: parentPath, name, type: kind, root }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        await alert(`Création impossible : ${err.detail || `erreur ${res.status}`}.`)
        return
      }
      await refreshFolder(parentPath)
      if (parentPath && !expandedPaths[parentPath]) setExpandedPaths((p) => ({ ...p, [parentPath]: true }))
    } catch (err) {
      await alert(`Création impossible. Vérifie que le serveur MyAI tourne, puis réessaie.`)
      console.error(err)
    }
  }

  async function handleRename(item) {
    const newName = await prompt(`Renommer « ${item.name} »`, item.name, { action: 'Renommer' })
    if (!newName || newName === item.name) return
    try {
      const res = await fetch('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path, newName, root }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        await alert(`Renommage impossible : ${err.detail || `erreur ${res.status}`}.`)
        return
      }
      if (item.type === 'folder') resetTree()
      else await refreshFolder(parentOf(item.path))
      setSelectedPath(null)
      setSelectedPaths(new Set())
      setPreview(null)
    } catch (err) {
      await alert(`Renommage impossible. Vérifie que le serveur MyAI tourne, puis réessaie.`)
      console.error(err)
    }
  }

  async function handleDelete(items) {
    if (items.length === 0) return
    const label = items.length > 1 ? `les ${items.length} éléments sélectionnés` : `« ${items[0].name} »`
    const action = items.length > 1 ? `Supprimer les ${items.length} éléments` : (items[0].type === 'folder' ? 'Supprimer le dossier' : 'Supprimer le fichier')
    if (!(await confirm(`Supprimer ${label} ?\nCette action ne peut pas être annulée.`, { action, danger: true }))) return
    const hasFolder = items.some((it) => it.type === 'folder')
    for (const item of items) {
      try {
        const res = await fetch(`/api/files/delete?path=${encodeURIComponent(item.path)}&root=${encodeURIComponent(root)}`, { method: 'DELETE' })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          await alert(`Suppression de « ${item.name} » impossible : ${err.detail || `erreur ${res.status}`}.`)
        }
      } catch (err) {
        await alert(`Suppression de « ${item.name} » impossible. Vérifie que le serveur MyAI tourne, puis réessaie.`)
        console.error(err)
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

  function gitBadgeEl(r) {
    const badge = gitBadge(r.gitStatus, r.gitSummary)
    return badge && (
      <span className="git-badge" style={{ color: badge.color }} data-tip={badge.title} aria-label={badge.title}>{badge.label}</span>
    )
  }

  const selCount = selectedPaths.size

  return (
    <div className="panel is-main coupe" style={{ gridArea }} data-slot={gridArea}>
      <div className="panel-full">
        <EnTetePanneau titre="Explorateur" meta={root ?? '—'} actions={<>
          <IconBtn
            kind="ghost"
            onClick={goToParent}
            disabled={!parentAvailable}
            label={parentAvailable ? 'Remonter au dossier parent' : 'Déjà à la racine du disque'}
            icon={<Icone nom="monter" />}
          />
          {root !== cwd && (
            <IconBtn kind="ghost" onClick={goHome} label="Revenir au dossier du projet" icon={<Icone nom="accueil" />} />
          )}
          {variant !== 'full' && (
            <IconBtn kind="ghost" label="Agrandir ce panneau" icon={<Icone nom="plein-ecran" />} onClick={onActivate} />
          )}
          <span className="kbd"><Touche>Ctrl 2</Touche></span>
        </>} />
        <BarreOutils
          filtre={filter}
          onFiltre={setFilter}
          label={searchMode === 'content' ? 'Rechercher dans le contenu' : 'Filtrer les fichiers'}
          placeholder={searchMode === 'content' ? 'Rechercher dans le contenu' : 'Filtrer'}
          icone={searchMode === 'content' ? 'recherche' : 'filtrer'}
        >
          <IconBtn
            kind={searchMode === 'content' ? 'pri' : 'sec'}
            aria-pressed={searchMode === 'content'}
            onClick={() => { setSearchMode((m) => (m === 'content' ? 'name' : 'content')); setFilter('') }}
            label={searchMode === 'content' ? 'Revenir à la recherche par nom' : 'Rechercher dans le contenu des fichiers'}
            icon={<Icone nom="recherche" />}
          />
          <IconBtn
            aria-pressed={showHidden}
            onClick={() => setShowHidden((v) => !v)}
            label={showHidden ? 'Masquer les fichiers cachés et node_modules' : 'Afficher les fichiers cachés et node_modules'}
            icon={<Icone nom={showHidden ? 'oeil' : 'oeil-barre'} />}
          />
          <IconBtn
            onClick={refreshAll}
            disabled={refreshing}
            label="Rafraîchir"
            icon={refreshing ? <declic-loader size="16" mono /> : <Icone nom="recharger" />}
          />
          <IconBtn ref={sortBtnRef} label="Trier" icon={<Icone nom="trier" />}
            aria-haspopup="menu" aria-expanded={sortMenuOpen} onClick={() => setSortMenuOpen((v) => !v)} />
          <MenuPop anchorRef={sortBtnRef} open={sortMenuOpen} onClose={() => setSortMenuOpen(false)} width={220} label="Trier">
            {SORT_OPTIONS.map((opt) => (
              <MenuItem key={opt.id} label={opt.label} checked={sortBy === opt.id}
                onSelect={() => { setSortBy(opt.id); setSortMenuOpen(false) }} />
            ))}
            <MenuSep />
            <MenuItem label="Dossiers d’abord" checked={foldersFirst} onSelect={() => setFoldersFirst((v) => !v)} />
          </MenuPop>
          <IconBtn ref={createBtnRef} label="Créer à la racine" icon={<Icone nom="ajouter" />}
            aria-haspopup="menu" aria-expanded={createMenuOpen} onClick={() => setCreateMenuOpen((v) => !v)} />
          <MenuPop anchorRef={createBtnRef} open={createMenuOpen} onClose={() => setCreateMenuOpen(false)} width={220} label="Créer">
            <MenuItem icon="fichier" label="Nouveau fichier" onSelect={() => { setCreateMenuOpen(false); handleCreate('', 'file') }} />
            <MenuItem icon="dossier" label="Nouveau dossier" onSelect={() => { setCreateMenuOpen(false); handleCreate('', 'folder') }} />
          </MenuPop>
        </BarreOutils>

        <div className="tree" tabIndex={0} aria-label="Arborescence des fichiers" onKeyDown={handleTreeKeyDown} onScroll={handleTreeScroll} ref={treeRef}>
          {error && <div className="tree-error"><span className="badge cut bg-hi"><Icone nom="erreur" /> {error}</span></div>}

          {!error && isSearching && searchLoading && (
            <div className="empty-daemon">
              <div><span className="caret">&gt;</span> myai.files.{searchMode === 'content' ? 'grep' : 'search'}(«&nbsp;{filter}&nbsp;»)</div>
              <div className="note">[note] recherche en cours…</div>
            </div>
          )}

          {!error && isSearching && !searchLoading && searchMode === 'name' && (
            searchResults?.length ? searchResults.map((r) => {
              const isSelected = r.path === selectedPath || selectedPaths.has(r.path)
              return (
                <div
                  key={r.path}
                  className={`tree-row cut${isSelected ? ' selected' : ''}`}
                  style={{ paddingLeft: 'var(--s-3)' }}
                  draggable={r.type === 'file'}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', absolutePath(root, r.path))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={(e) => handleRowClick(e, r)}
                  onContextMenu={(e) => handleRowContextMenu(e, r)}
                >
                  <span className="file-icon">{r.type === 'folder' ? <Icone nom="dossier" /> : fileIcon(r.name)}</span>
                  {gitBadgeEl(r)}
                  <span className="search-result-path">{r.path}</span>
                </div>
              )
            }) : (
              <div className="empty-daemon">
                <div><span className="caret">&gt;</span> myai.files.search(«&nbsp;{filter}&nbsp;»)</div>
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
                  className={`tree-row grep-row cut${isSelected ? ' selected' : ''}`}
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
                <div><span className="caret">&gt;</span> myai.files.grep(«&nbsp;{filter}&nbsp;»)</div>
                <div className="note">[note] aucun résultat.</div>
              </div>
            )
          )}

          {!error && !isSearching && childrenByPath[''] && rows.length === 0 && (
            <div className="empty-daemon">
              <div><span className="caret">&gt;</span> myai.files.list()</div>
              <div>éléments&nbsp;: 0</div>
              <div className="note">[note] dossier vide.</div>
            </div>
          )}
          {virtualize && <div style={{ height: virtualStart * ROW_HEIGHT }} />}
          {!isSearching && visibleRows.map((r) => {
            const isSelected = r.path === selectedPath || selectedPaths.has(r.path)
            const isExpanded = expandedPaths[r.path]
            return (
              <div
                key={r.path}
                className={`tree-row cut${isSelected ? ' selected' : ''}`}
                style={{ paddingLeft: `calc(${r.depth} * var(--s-4) + var(--s-3))` }}
                draggable={r.type === 'file'}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', absolutePath(root, r.path))
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={(e) => handleRowClick(e, r, { expandable: true })}
                onContextMenu={(e) => handleRowContextMenu(e, r)}
              >
                <span className="chevron">{r.type === 'folder' && <Icone nom={isExpanded ? 'deplier' : 'chevron'} />}</span>
                <span className="file-icon">{r.type === 'folder' ? <Icone nom="dossier" /> : fileIcon(r.name)}</span>
                {gitBadgeEl(r)}
                <span className="tree-name">{r.name}</span>
                {r.type === 'file' && isRecent(r.modified, now) && (
                  <span className="recent-dot cut" data-tip="Modifié il y a moins de 5 min" aria-label="Modifié il y a moins de 5 min" />
                )}
              </div>
            )
          })}
          {virtualize && <div style={{ height: (rows.length - virtualEnd) * ROW_HEIGHT }} />}
        </div>

        {selectedItem?.type === 'file' && <FilePreview preview={preview} gitStatus={selectedItem.gitStatus} root={root} />}

        <div className="file-footer">
          <span className="file-footer-name">{selCount > 1 ? `${selCount} éléments sélectionnés` : (selectedItem?.name ?? `${countLoaded(childrenByPath, showHidden)} fichiers`)}</span>
          {(selectedItem || selCount > 1)
            ? (
              <span className="file-footer-actions">
                {selCount <= 1 && `${formatSize(selectedItem?.size)} · modifié ${formatModified(selectedItem?.modified)}`}
                <Btn
                  kind="ghost"
                  icon={<Icone nom="envoyer" />}
                  onClick={() => sendToChat(selCount > 1 ? [...selectedPaths].map((p) => absolutePath(root, p)).join('\n') : absolutePath(root, selectedItem.path))}
                  data-tip="Insérer le ou les chemins dans le composeur du chat (équivalent tactile du glisser-déposer)"
                >
                  Envoyer{selCount > 1 ? ` ${selCount} fichiers` : ''} au chat
                </Btn>
              </span>
            )
            : <span />}
        </div>

        <MenuPop point={contextMenu} open={Boolean(contextMenu)} onClose={() => setContextMenu(null)} width={240} label="Actions sur le fichier">
          {contextMenu && (
            <>
              <MenuItem icon="copier" label="Copier le chemin"
                onSelect={() => { navigator.clipboard.writeText(absolutePath(root, contextMenu.item.path)); setContextMenu(null) }} />
              <MenuItem icon="envoyer" label={`Envoyer au chat${selCount > 1 ? ` (${selCount})` : ''}`}
                onSelect={() => {
                  const paths = selCount > 1 ? [...selectedPaths] : [contextMenu.item.path]
                  sendToChat(paths.map((p) => absolutePath(root, p)).join('\n'))
                  setContextMenu(null)
                }} />
              {contextMenu.item.type === 'folder' && (
                <>
                  <MenuItem icon="fichier" label="Nouveau fichier ici"
                    onSelect={() => { const p = contextMenu.item.path; setContextMenu(null); handleCreate(p, 'file') }} />
                  <MenuItem icon="dossier" label="Nouveau dossier ici"
                    onSelect={() => { const p = contextMenu.item.path; setContextMenu(null); handleCreate(p, 'folder') }} />
                </>
              )}
              <MenuItem icon="modifier" label="Renommer"
                onSelect={() => { const item = contextMenu.item; setContextMenu(null); handleRename(item) }} />
              <MenuSep />
              <MenuItem icon="supprimer" dan label={`Supprimer${selCount > 1 ? ` (${selCount})` : ''}`}
                onSelect={() => {
                  const targets = selCount > 1 ? [...selectedPaths].map(findItem).filter(Boolean) : [contextMenu.item]
                  setContextMenu(null)
                  handleDelete(targets)
                }} />
            </>
          )}
        </MenuPop>
      </div>
    </div>
  )
}
