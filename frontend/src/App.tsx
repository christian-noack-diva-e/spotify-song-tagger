import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { api } from './api'
import type { CategoryResponse, SongResponse, SpotifyStatus } from './types'
import FilterBar from './components/FilterBar'
import SongList from './components/SongList'
import TagPanel from './components/TagPanel'
import PlayerBar from './components/PlayerBar'
import SettingsScreen from './components/SettingsScreen'
import PlaylistExportDialog from './components/PlaylistExportDialog'
import LiveEditPlaylistDialog from './components/LiveEditPlaylistDialog'
import DuplicatesDialog from './components/DuplicatesDialog'
import type { SpotifyPlaylist } from './spotifyApi'
import { handleCallback } from './spotifyAuth'
import { getConfig } from './settingsStore'

export default function App() {
  const [songs, setSongs] = useState<SongResponse[]>([])
  const [categories, setCategories] = useState<CategoryResponse[]>([])
  const [selectedSong, setSelectedSong] = useState<SongResponse | null>(null)
  const [missingFilter, setMissingFilter] = useState<string>('')
  const [minMissing, setMinMissing] = useState<number>(0)
  const [sort, setSort] = useState<'discovered' | 'missing'>('discovered')
  const [search, setSearch] = useState('')
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifyStatus>({ authenticated: false, activeDevice: '' })
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showLiveEditDialog, setShowLiveEditDialog] = useState(false)
  const [liveEditDialogKey, setLiveEditDialogKey] = useState(0)
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [liveEditMode, setLiveEditMode] = useState(false)
  const [liveEditSongs, setLiveEditSongs] = useState<SongResponse[]>([])
  const [liveEditLoading, setLiveEditLoading] = useState(false)
  const [liveEditPlaylistId, setLiveEditPlaylistId] = useState<string | null>(null)
  const [liveEditPlaylistName, setLiveEditPlaylistName] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const showError = useCallback((msg: string) => {
    setErrorMessage(msg)
    setTimeout(() => setErrorMessage(null), 4000)
  }, [])

  // Handle Spotify OAuth callback on first load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('code')) {
      handleCallback().then(() => {
        api.getSpotifyStatus().then(setSpotifyStatus).catch(() => {})
      })
    }
  }, [])

  const loadSongs = useCallback(async () => {
    const s = await api.getSongs(missingFilter || undefined)
    setSongs(s)
    setSelectedSong(prev => prev ? (s.find(x => x.spotifyUri === prev.spotifyUri) ?? prev) : null)
  }, [missingFilter])

  const refreshSelectedSong = useCallback(async (path: string) => {
    const fresh = await api.getSong(path)
    setSelectedSong(fresh)
  }, [])

  useEffect(() => {
    // Show settings immediately if Spotify Client ID is not configured
    if (!getConfig().spotifyClientId) {
      setShowSettings(true)
    }

    Promise.all([
      api.getCategories(),
      api.getSpotifyStatus(),
    ]).then(([cats, status]) => {
      setCategories(cats)
      setSpotifyStatus(status)
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadSongs()
  }, [loadSongs])

  // Poll Spotify status every 15s; surface failure after 3 consecutive errors
  const pollFailures = useRef(0)
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const status = await api.getSpotifyStatus()
        pollFailures.current = 0
        setSpotifyStatus(status)
      } catch {
        pollFailures.current++
        if (pollFailures.current >= 3) {
          setSpotifyStatus({ authenticated: false, activeDevice: '' })
        }
      }
    }, 15000)
    return () => clearInterval(id)
  }, [])

  const loadLivePlaylistSongs = useCallback(async (playlistId: string) => {
    setLiveEditLoading(true)
    setLiveEditSongs([])
    try {
      await api.getLivePlaylistSongs(playlistId, (batch) => {
        setLiveEditSongs(prev => [...prev, ...batch])
      })
    } finally {
      setLiveEditLoading(false)
    }
  }, [])

  const handleLiveEditSelected = useCallback(async (playlist: SpotifyPlaylist) => {
    setShowLiveEditDialog(false)
    setLiveEditMode(true)
    setLiveEditPlaylistId(playlist.id)
    setLiveEditPlaylistName(playlist.name)
    setSelectedSong(null)
    await api.pause().catch(() => {})
    await loadLivePlaylistSongs(playlist.id)
  }, [loadLivePlaylistSongs])

  const handleExitLiveEdit = useCallback(() => {
    setLiveEditMode(false)
    setLiveEditSongs([])
    setLiveEditPlaylistId(null)
    setLiveEditPlaylistName(null)
    setSelectedSong(null)
  }, [])

  const allCategoryNames = categories.map(c => c.name)

  const activeSongs = liveEditMode ? liveEditSongs : songs

  const filteredSongs = useMemo(() => {
    const q = search.trim().toLowerCase()
    const searched = q
      ? activeSongs.filter(s =>
          s.title.toLowerCase().includes(q)
          || s.artist.toLowerCase().includes(q)
          || s.tags.some(t => t.value.toLowerCase().includes(q))
        )
      : activeSongs
    return searched
      .filter(s => s.missingCategories.length >= minMissing)
      .toSorted((a, b) => {
        if (sort === 'missing') return b.missingCategories.length - a.missingCategories.length
        return (b.discoveredDate ?? '').localeCompare(a.discoveredDate ?? '')
      })
  }, [activeSongs, search, minMissing, sort])

  const nextSong = useMemo(() => {
    if (!selectedSong) return null
    const idx = filteredSongs.findIndex(s => s.spotifyUri === selectedSong.spotifyUri)
    return idx !== -1 ? (filteredSongs[idx + 1] ?? null) : null
  }, [filteredSongs, selectedSong])

  const handleIgnore = useCallback(async (path: string, tagIds: number[]) => {
    const next = nextSong
    await api.ignoreSong(path, tagIds)
    if (liveEditMode && liveEditPlaylistId) {
      await api.removeFromLivePlaylist(path, liveEditPlaylistId)
      setLiveEditSongs(prev => prev.filter(s => s.spotifyUri !== path))
    } else {
      await loadSongs()
    }
    setSelectedSong(prev => (prev?.spotifyUri === path ? next : prev))
  }, [loadSongs, loadLivePlaylistSongs, liveEditMode, liveEditPlaylistId, nextSong])

  const handleRemoveFromLivePlaylist = useCallback(async (uri: string) => {
    if (!liveEditPlaylistId) return
    const next = nextSong
    try {
      await api.removeFromLivePlaylist(uri, liveEditPlaylistId)
      setLiveEditSongs(prev => prev.filter(s => s.spotifyUri !== uri))
      setSelectedSong(prev => (prev?.spotifyUri === uri ? next : prev))
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to remove from playlist')
    }
  }, [liveEditPlaylistId, nextSong, showError])

  const handleTagToggle = async (tagId: number, isCurrentlyAssigned: boolean) => {
    if (!selectedSong) return
    const path = selectedSong.spotifyUri
    if (liveEditMode) {
      await api.ensureSongExists(selectedSong)
    }
    if (isCurrentlyAssigned) {
      await api.removeTag(path, tagId)
    } else {
      await api.assignTag(path, tagId)
    }
    if (liveEditMode) {
      const fresh = await api.getSong(path)
      setSelectedSong(fresh)
      setLiveEditSongs(prev => prev.map(s => s.spotifyUri === path ? fresh : s))
    } else {
      await Promise.all([loadSongs(), refreshSelectedSong(path)])
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400">
        Loading…
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-900 text-neutral-100">
      {showSettings && (
        <SettingsScreen onClose={async () => {
          setShowSettings(false)
          const [cats, status] = await Promise.all([api.getCategories(), api.getSpotifyStatus()])
          setCategories(cats)
          setSpotifyStatus(status)
        }} />
      )}
      {showExport && (
        <PlaylistExportDialog onClose={() => setShowExport(false)} />
      )}
      {showLiveEditDialog && (
        <LiveEditPlaylistDialog
          key={liveEditDialogKey}
          onSelect={handleLiveEditSelected}
          onClose={() => setShowLiveEditDialog(false)}
        />
      )}
      {showDuplicates && liveEditPlaylistId && liveEditPlaylistName && (
        <DuplicatesDialog
          playlistId={liveEditPlaylistId}
          playlistName={liveEditPlaylistName}
          onRemoved={() => loadLivePlaylistSongs(liveEditPlaylistId)}
          onClose={() => setShowDuplicates(false)}
        />
      )}

      <FilterBar
        categories={allCategoryNames}
        missingFilter={missingFilter}
        onMissingFilterChange={setMissingFilter}
        minMissing={minMissing}
        onMinMissingChange={setMinMissing}
        sort={sort}
        onSortChange={setSort}
        spotifyStatus={spotifyStatus}
        onLogout={() => setSpotifyStatus({ authenticated: false, activeDevice: '' })}
        onSyncDone={async () => {
          await loadSongs()
          const cats = await api.getCategories()
          setCategories(cats)
        }}
        onOpenSettings={() => setShowSettings(true)}
        onOpenExport={() => setShowExport(true)}
        liveEditPlaylistName={liveEditPlaylistName}
        onOpenLiveEditDialog={() => { setLiveEditDialogKey(k => k + 1); setShowLiveEditDialog(true) }}
        onExitLiveEdit={handleExitLiveEdit}
      />
      {liveEditMode && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-900/40 border-b border-blue-800 text-xs text-blue-300">
          {liveEditLoading ? (
            <>
              <svg className="animate-spin h-3.5 w-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Loading {liveEditPlaylistName ?? 'playlist'}…
            </>
          ) : (
            <>
              <span>Editing: <span className="text-blue-200 font-medium">{liveEditPlaylistName}</span></span>
              <span className="text-blue-700">·</span>
              <button
                onClick={() => setShowDuplicates(true)}
                className="text-blue-300 hover:text-blue-100 underline underline-offset-2"
              >
                Find Duplicates
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden flex-col md:flex-row">
        <div className="md:w-80 w-full md:h-full h-48 flex flex-col border-r border-neutral-800 flex-shrink-0">
          <div className="px-3 py-2 border-b border-neutral-800">
            <input
              type="search"
              placeholder="Search by title or artist…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-neutral-700 text-neutral-100 text-sm rounded px-2 py-1 border border-neutral-600 focus:outline-none placeholder-neutral-500"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            <SongList
              songs={filteredSongs}
              selectedSong={selectedSong}
              onSelect={setSelectedSong}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {selectedSong ? (
            <TagPanel
              song={selectedSong}
              categories={categories}
              onTagToggle={handleTagToggle}
              onCategoriesReordered={setCategories}
              onIgnore={handleIgnore}
              onRemoveFromPlaylist={liveEditMode ? handleRemoveFromLivePlaylist : undefined}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-neutral-500">
              Select a song to tag it
            </div>
          )}
        </div>
      </div>

      <PlayerBar
        song={selectedSong}
        nextSong={nextSong}
        onNextSong={setSelectedSong}
        spotifyStatus={spotifyStatus}
        onSongPlayed={loadSongs}
      />

      {errorMessage && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-red-800 text-white text-sm px-4 py-2 rounded shadow-lg z-50">
          {errorMessage}
        </div>
      )}
    </div>
  )
}
