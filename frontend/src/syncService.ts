import { db } from './db'
import type { Song, Tag, SongTag } from './db'
import { getConfig } from './settingsStore'
import { getCurrentUserId, fetchAllPlaylists, fetchPlaylistTracks } from './spotifyApi'

export interface SyncResult {
  playlistsProcessed: number
  songsUpdated: number
}

export interface SyncProgress {
  current: string   // playlist name currently being fetched
  done: number      // playlists fetched so far
  total: number     // total matching playlists
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface ParsedTag {
  category: string
  value: string
}

// Direct port of PlaylistSyncService.parseCategoryAndValue()
function parseCategoryAndValue(
  playlistName: string,
  filterWord: string,
  categoryKeywords: Set<string>,
): ParsedTag | null {
  const stripped = playlistName
    .replace(new RegExp(`\\b${escapeRegex(filterWord)}\\b`, 'gi'), '')
    .trim()
    .replace(/\s+/g, ' ')

  if (!stripped) return null

  const lastSpaceIdx = stripped.lastIndexOf(' ')
  const lastWord = lastSpaceIdx >= 0 ? stripped.substring(lastSpaceIdx + 1) : stripped
  const remainder = lastSpaceIdx >= 0 ? stripped.substring(0, lastSpaceIdx).trim() : ''

  for (const keyword of categoryKeywords) {
    if (keyword.toLowerCase() === lastWord.toLowerCase()) {
      return { category: keyword, value: remainder || keyword }
    }
  }
  return { category: 'Other', value: stripped }
}

export async function sync(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
  const config = getConfig()
  const categoryKeywords = new Set(config.categoryNames)

  const currentUserId = await getCurrentUserId()
  const allPlaylists = await fetchAllPlaylists()

  const filtered = allPlaylists.filter(p =>
    p.ownerId === currentUserId &&
    p.name.toLowerCase().includes(config.playlistNameFilter.toLowerCase()) &&
    !config.playlistNameBlacklist.some(bl => p.name.includes(bl)) &&
    p.id !== config.shazamPlaylistId
  )

  // Collect tracks per playlist (same algorithm as Java)
  const playlistsByUri = new Map<string, string[]>()  // uri → playlist names
  const playlistIdByName = new Map<string, string>()
  const trackMetaByUri = new Map<string, { title: string; artist: string; coverUrl: string | null; durationMs: number }>()
  const earliestAddedAt = new Map<string, string>()

  for (const [i, playlist] of filtered.entries()) {
    onProgress?.({ current: playlist.name, done: i, total: filtered.length })
    playlistIdByName.set(playlist.name, playlist.id)
    const tracks = await fetchPlaylistTracks(playlist.tracksHref)
    for (const track of tracks) {
      if (!playlistsByUri.has(track.uri)) playlistsByUri.set(track.uri, [])
      playlistsByUri.get(track.uri)!.push(playlist.name)
      if (!trackMetaByUri.has(track.uri)) {
        trackMetaByUri.set(track.uri, {
          title: track.title, artist: track.artist,
          coverUrl: track.coverUrl, durationMs: track.durationMs,
        })
      }
      if (track.addedAt) {
        const current = earliestAddedAt.get(track.uri)
        if (!current || track.addedAt < current) earliestAddedAt.set(track.uri, track.addedAt)
      }
    }
  }

  await db.transaction('rw', [db.songs, db.tags, db.categories, db.songTags], async () => {
    const existingSongs = new Map((await db.songs.toArray()).map(s => [s.spotifyUri, s]))
    const existingCategories = new Map((await db.categories.toArray()).map(c => [c.name, c]))
    const existingTags = new Map((await db.tags.toArray()).map(t => [t.playlistName, t]))

    // Clear all song-tag associations; rebuild from scratch
    await db.songTags.clear()

    const newSongTags: SongTag[] = []
    const songsToSave: Song[] = []

    for (const [uri, playlistNames] of playlistsByUri) {
      const meta = trackMetaByUri.get(uri)!
      const song: Song = existingSongs.get(uri) ?? {
        spotifyUri: uri, title: meta.title, artist: meta.artist,
        coverUrl: null, durationMs: null, discoveredDate: null, ignored: false,
      }

      song.title = meta.title
      song.artist = meta.artist
      if (meta.coverUrl) song.coverUrl = meta.coverUrl
      if (meta.durationMs) song.durationMs = meta.durationMs

      const discovered = earliestAddedAt.get(uri)
      if (discovered && (!song.discoveredDate || discovered < song.discoveredDate)) {
        song.discoveredDate = discovered
      }

      for (const playlistName of playlistNames) {
        const parsed = parseCategoryAndValue(playlistName, config.playlistNameFilter, categoryKeywords)
        if (!parsed) continue

        // Upsert category
        if (!existingCategories.has(parsed.category)) {
          const newId = await db.categories.add({ name: parsed.category })
          existingCategories.set(parsed.category, { id: newId as number, name: parsed.category })
        }
        const category = existingCategories.get(parsed.category)!

        // Upsert tag by playlistName (preserves ID across syncs)
        let tag = existingTags.get(playlistName)
        if (!tag) {
          const newId = await db.tags.add({
            playlistName,
            categoryId: category.id!,
            tagValue: parsed.value,
            spotifyPlaylistId: playlistIdByName.get(playlistName) ?? null,
          })
          tag = {
            id: newId as number, playlistName, categoryId: category.id!,
            tagValue: parsed.value, spotifyPlaylistId: playlistIdByName.get(playlistName) ?? null,
          } as Tag
          existingTags.set(playlistName, tag)
        } else {
          await db.tags.update(tag.id!, {
            categoryId: category.id!,
            tagValue: parsed.value,
            spotifyPlaylistId: playlistIdByName.get(playlistName) ?? null,
          })
          tag.categoryId = category.id!
          tag.tagValue = parsed.value
          tag.spotifyPlaylistId = playlistIdByName.get(playlistName) ?? null
        }

        newSongTags.push({ songUri: uri, tagId: tag.id! })
      }

      // Ignored if any playlist parses to value "Ignore"
      song.ignored = playlistNames.some(name => {
        const p = parseCategoryAndValue(name, config.playlistNameFilter, categoryKeywords)
        return p?.value.toLowerCase() === 'ignore'
      })

      songsToSave.push(song)
    }

    // Reset ignored = false for songs no longer in any playlist
    for (const [uri, song] of existingSongs) {
      if (!playlistsByUri.has(uri)) {
        song.ignored = false
        songsToSave.push(song)
      }
    }

    // Delete tags that no longer appear in any playlist
    const allActivePlaylistNames = new Set<string>()
    for (const names of playlistsByUri.values()) {
      for (const n of names) allActivePlaylistNames.add(n)
    }
    const tagsToDelete = [...existingTags.values()]
      .filter(t => !allActivePlaylistNames.has(t.playlistName) && t.id != null)
      .map(t => t.id!)
    if (tagsToDelete.length > 0) await db.tags.bulkDelete(tagsToDelete)

    // Also remove categories that have no tags left
    const activeCategoryIds = new Set((await db.tags.toArray()).map(t => t.categoryId))
    const categoriesToDelete = [...existingCategories.values()]
      .filter(c => c.id != null && !activeCategoryIds.has(c.id!))
      .map(c => c.id!)
    if (categoriesToDelete.length > 0) await db.categories.bulkDelete(categoriesToDelete)

    await db.songs.bulkPut(songsToSave)
    const tagIdToPlaylistName = new Map([...existingTags.values()].map(t => [t.id!, t.playlistName]))
    const seen = new Set<string>()
    const dedupedSongTags: SongTag[] = []
    for (const st of newSongTags) {
      const key = `${st.songUri}|${st.tagId}`
      if (seen.has(key)) {
        const songTitle = trackMetaByUri.get(st.songUri)?.title ?? st.songUri
        const playlistName = tagIdToPlaylistName.get(st.tagId) ?? String(st.tagId)
        console.warn(`Duplicate song in playlist: "${songTitle}" in "${playlistName}"`)
      } else {
        seen.add(key)
        dedupedSongTags.push(st)
      }
    }
    await db.songTags.bulkAdd(dedupedSongTags)
  })

  return { playlistsProcessed: filtered.length, songsUpdated: playlistsByUri.size }
}

// Export parseCategoryAndValue for unit testing
export { parseCategoryAndValue }
