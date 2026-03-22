import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CategoryResponse, CategorySuggestion, SongResponse } from '../types'

interface Props {
  song: SongResponse
  categories: CategoryResponse[]
  onTagToggle: (tagId: number, isCurrentlyAssigned: boolean) => Promise<void>
  onCategoriesReordered: (categories: CategoryResponse[]) => void
  onIgnore: (path: string) => Promise<void>
  onRemoveFromShazam?: (path: string) => Promise<void>
}

export default function TagPanel({ song, categories, onTagToggle, onCategoriesReordered, onIgnore, onRemoveFromShazam }: Props) {
  const [ordered, setOrdered] = useState(categories)
  const [tagSearch, setTagSearch] = useState('')
  const [suggestions, setSuggestions] = useState<CategorySuggestion[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)
  const [pendingTagId, setPendingTagId] = useState<number | null>(null)
  const dragIndex = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  // Sync when categories prop changes (e.g. after reload)
  useEffect(() => { setOrdered(categories) }, [categories])

  // Fetch suggestions whenever the selected song changes
  useEffect(() => {
    let cancelled = false
    setSuggestions([])
    setSuggestionError(null)
    setLoadingSuggestions(true)
    api.getSuggestions(song.spotifyUri, song)
      .then(data => { if (!cancelled) setSuggestions(data) })
      .catch(err => { if (!cancelled) setSuggestionError(err instanceof Error ? err.message : 'Failed to load suggestions') })
      .finally(() => { if (!cancelled) setLoadingSuggestions(false) })
    return () => { cancelled = true }
  }, [song.spotifyUri])

  const assignedTagIds = new Set(song.tags.map(t => t.id))
  const missingSet = new Set(song.missingCategories)

  // Build a set of suggested tag IDs for fast lookup
  const suggestedTagIdSet = new Set(suggestions.flatMap(s => s.suggestedTagIds))

  const handleDragStart = (index: number) => {
    dragIndex.current = index
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }

  const handleDrop = async (dropIndex: number) => {
    const from = dragIndex.current
    if (from === null || from === dropIndex) {
      dragIndex.current = null
      setDragOverIndex(null)
      return
    }

    const previous = ordered
    const next = [...ordered]
    const [moved] = next.splice(from, 1)
    next.splice(dropIndex, 0, moved)

    dragIndex.current = null
    setDragOverIndex(null)
    setOrdered(next)
    onCategoriesReordered(next)

    try {
      api.updateCategoryOrder(next)
    } catch {
      setOrdered(previous)
      onCategoriesReordered(previous)
    }
  }

  const handleDragEnd = () => {
    dragIndex.current = null
    setDragOverIndex(null)
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-start gap-4 mb-6">
        {song.coverUrl ? (
          <img
            src={song.coverUrl}
            alt="Cover"
            className="w-24 h-24 rounded-lg object-cover flex-shrink-0 shadow-lg"
          />
        ) : (
          <div className="w-24 h-24 rounded-lg bg-neutral-700 flex items-center justify-center text-4xl flex-shrink-0">
            ♪
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{song.title}</h1>
          <p className="text-neutral-400 truncate">{song.artist}</p>
          {song.discoveredDate && (
            <p className="text-xs text-neutral-500 mt-1">Discovered: {song.discoveredDate}</p>
          )}
          {song.missingCategories.length > 0 && (
            <p className="text-xs text-red-400 mt-1">
              Missing: {song.missingCategories.join(', ')}
            </p>
          )}
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => onIgnore(song.spotifyUri)}
              className="text-xs px-2 py-1 rounded border border-neutral-600 text-neutral-400 hover:border-red-700 hover:text-red-400 transition-colors"
              title="Hide this song from the list"
            >
              Add to ignore list
            </button>
            {onRemoveFromShazam && (
              <button
                onClick={() => onRemoveFromShazam(song.spotifyUri)}
                className="text-xs px-2 py-1 rounded border border-neutral-600 text-neutral-400 hover:border-orange-600 hover:text-orange-400 transition-colors"
                title="Remove from Shazam playlist"
              >
                Remove from Shazam
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mb-3">
        <input
          type="search"
          placeholder="Search tags…"
          value={tagSearch}
          onChange={e => setTagSearch(e.target.value)}
          className="w-full bg-neutral-700 text-neutral-100 text-sm rounded px-2 py-1 border border-neutral-600 focus:outline-none placeholder-neutral-500"
        />
      </div>

      <div className="space-y-2">
        {ordered.map((cat, index) => {
          const visibleTags = tagSearch.trim()
            ? cat.tags.filter(t => t.value.toLowerCase().includes(tagSearch.toLowerCase()))
            : cat.tags
          if (visibleTags.length === 0) return null
          const isMissing = missingSet.has(cat.name)
          const isOver = dragOverIndex === index
          const hasSuggestions = isMissing && visibleTags.some(t => suggestedTagIdSet.has(t.id))
          return (
            <div
              key={cat.id}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={e => handleDragOver(e, index)}
              onDrop={() => handleDrop(index)}
              onDragEnd={handleDragEnd}
              className={`rounded-lg border transition-colors ${
                isMissing
                  ? 'border-red-800 bg-red-950/20'
                  : 'border-neutral-700 bg-neutral-800/50'
              } ${isOver ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-neutral-900' : ''}`}
            >
              <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                {/* Drag handle */}
                <span
                  className="text-neutral-500 hover:text-neutral-300 cursor-grab active:cursor-grabbing select-none text-lg leading-none"
                  title="Drag to reorder"
                >
                  ⠿
                </span>
                <span className="text-sm font-semibold text-neutral-300">{cat.name}</span>
                {isMissing && <span className="text-xs text-red-400">● missing</span>}
                {isMissing && loadingSuggestions && (
                  <span className="text-xs text-amber-400 animate-pulse ml-1">Fetching suggestions…</span>
                )}
                {isMissing && suggestionError && !loadingSuggestions && (
                  <span className="text-xs text-red-400 ml-1" title={suggestionError}>⚠ suggestions unavailable</span>
                )}
                {hasSuggestions && !loadingSuggestions && (
                  <span className="text-xs text-amber-400 ml-1">✦ AI suggestions</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2 px-3 pb-3">
                {visibleTags.map(tag => {
                  const assigned = assignedTagIds.has(tag.id)
                  const isSuggested = !assigned && suggestedTagIdSet.has(tag.id)
                  return (
                    <button
                      key={tag.id}
                      onClick={async () => {
                        if (pendingTagId !== null) return
                        setPendingTagId(tag.id)
                        try {
                          await onTagToggle(tag.id, assigned)
                        } finally {
                          setPendingTagId(null)
                        }
                      }}
                      disabled={pendingTagId !== null}
                      className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                        pendingTagId === tag.id
                          ? 'opacity-50 cursor-wait'
                          : pendingTagId !== null
                          ? 'opacity-40 cursor-not-allowed'
                          : assigned
                          ? 'bg-green-700 border-green-500 text-white hover:bg-red-700 hover:border-red-500'
                          : isSuggested
                          ? 'bg-amber-900/40 border-amber-600 text-amber-200 hover:bg-amber-800/60'
                          : 'bg-neutral-700 border-neutral-600 text-neutral-300 hover:bg-neutral-600'
                      }`}
                      title={assigned ? `Remove from ${tag.playlistName}` : `Add to ${tag.playlistName}`}
                    >
                      {isSuggested ? `✦ ${tag.value}` : tag.value}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
