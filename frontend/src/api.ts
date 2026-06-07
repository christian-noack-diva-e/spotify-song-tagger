import type { CategoryResponse, CategorySuggestion, SongResponse, SpotifyStatus } from './types'
import { querySongs, querySong, queryCategories, createTrackSongBuilder, db } from './db'
import { getConfig, saveConfig } from './settingsStore'
import * as spotifyAuth from './spotifyAuth'
import * as spotifyApi from './spotifyApi'
import { sync } from './syncService'
import type { SyncProgress } from './syncService'
export type { SyncProgress }
import { getSuggestions } from './anthropicApi'

export const api = {
  getSongs: (missingCategory?: string): Promise<SongResponse[]> =>
    querySongs(missingCategory),

  getSong: (spotifyUri: string): Promise<SongResponse> =>
    querySong(spotifyUri).then(s => {
      if (!s) throw new Error(`Song not found: ${spotifyUri}`)
      return s
    }),

  getCategories: (): Promise<CategoryResponse[]> =>
    queryCategories(),

  updateCategoryOrder: (categories: CategoryResponse[]): void => {
    saveConfig({ categoryNames: categories.map(c => c.name) })
  },

  assignTag: async (spotifyUri: string, tagId: number): Promise<void> => {
    const tag = await db.tags.get(tagId)
    if (!tag?.spotifyPlaylistId) throw new Error(`Tag ${tagId} has no Spotify playlist ID`)
    await db.songTags.put({ songUri: spotifyUri, tagId })
    await spotifyApi.addTrackToPlaylist(spotifyUri, tag.spotifyPlaylistId)
  },

  removeTag: async (spotifyUri: string, tagId: number): Promise<void> => {
    const tag = await db.tags.get(tagId)
    await db.songTags.delete([spotifyUri, tagId] as unknown as [string, number])
    if (tag?.spotifyPlaylistId) {
      await spotifyApi.removeTrackFromPlaylist(spotifyUri, tag.spotifyPlaylistId)
    }
  },

  getAccessToken: async (): Promise<{ accessToken: string }> => ({
    accessToken: await spotifyAuth.getAccessToken(),
  }),

  play: (spotifyUri: string, deviceId?: string): Promise<void> =>
    spotifyApi.play(spotifyUri, deviceId),

  pause: (): Promise<void> => spotifyApi.pause(),

  resume: (): Promise<void> => spotifyApi.resume(),

  seek: (positionMs: number): Promise<void> => spotifyApi.seek(positionMs),

  getSpotifyStatus: async (): Promise<SpotifyStatus> => ({
    authenticated: spotifyAuth.isAuthenticated(),
    activeDevice: (await spotifyApi.getActiveDeviceName()) ?? '',
  }),

  authSpotify: async (): Promise<void> => {
    await spotifyAuth.startAuth()
  },

  logout: (): Promise<void> => {
    spotifyAuth.logout()
    return Promise.resolve()
  },

  getSuggestions: async (spotifyUri: string, fallbackSong?: SongResponse): Promise<CategorySuggestion[]> => {
    const config = getConfig()
    if (!config.anthropicApiKey) {
      throw new Error('Anthropic API key not configured — add it in Settings')
    }

    const [song, categories] = await Promise.all([querySong(spotifyUri), queryCategories()])
    const resolvedSong = song ?? fallbackSong ?? null
    if (!resolvedSong) return []

    const trackId = spotifyUri.split(':')[2]
    if (!trackId) return []

    const artistId = await spotifyApi.getTrackArtistId(trackId)
    const genres = artistId ? await spotifyApi.getArtistGenres(artistId) : []

    return getSuggestions(
      resolvedSong, categories, genres,
      config.anthropicApiKey,
      config.anthropicProxyUrl || undefined,
    )
  },

  ignoreSong: async (spotifyUri: string, tagIds?: number[]): Promise<void> => {
    const config = getConfig()
    await db.songs.update(spotifyUri, { ignored: true })

    // Determine which playlists are the ignore destinations
    const ignorePlaylistIds = new Set<string>()
    if (tagIds && tagIds.length > 0) {
      for (const tagId of tagIds) {
        const tag = await db.tags.get(tagId)
        if (tag?.spotifyPlaylistId) {
          ignorePlaylistIds.add(tag.spotifyPlaylistId)
          await spotifyApi.addTrackToPlaylist(spotifyUri, tag.spotifyPlaylistId)
        }
      }
    } else if (config.ignorePlaylistId) {
      ignorePlaylistIds.add(config.ignorePlaylistId)
      await spotifyApi.addTrackToPlaylist(spotifyUri, config.ignorePlaylistId)
    }

    // Remove from all currently assigned tag playlists (except ignore destinations)
    const currentSongTags = await db.songTags.where('songUri').equals(spotifyUri).toArray()
    for (const st of currentSongTags) {
      const tag = await db.tags.get(st.tagId)
      if (tag?.spotifyPlaylistId && !ignorePlaylistIds.has(tag.spotifyPlaylistId)) {
        await spotifyApi.removeTrackFromPlaylist(spotifyUri, tag.spotifyPlaylistId)
      }
    }

    // Clear all tag assignments from the DB
    await db.songTags.where('songUri').equals(spotifyUri).delete()
  },

  syncPlaylists: (onProgress?: (p: SyncProgress) => void): Promise<{ playlistsProcessed: number; songsUpdated: number }> =>
    sync(onProgress),

  removeFromLivePlaylist: async (spotifyUri: string, playlistId: string): Promise<void> => {
    await spotifyApi.removeTrackFromPlaylist(spotifyUri, playlistId)
  },

  getLivePlaylistSongs: async (playlistId: string, onBatch: (songs: SongResponse[]) => void): Promise<void> => {
    const buildSongs = await createTrackSongBuilder()
    await spotifyApi.streamPlaylistTracks(playlistId, (tracks) => onBatch(buildSongs(tracks)))
  },

  ensureSongExists: async (song: SongResponse): Promise<void> => {
    const existing = await db.songs.get(song.spotifyUri)
    if (!existing) {
      await db.songs.add({
        spotifyUri: song.spotifyUri,
        title: song.title,
        artist: song.artist,
        coverUrl: song.coverUrl,
        durationMs: song.durationMs,
        discoveredDate: song.discoveredDate,
        releaseDate: song.releaseDate,
        ignored: false,
      })
    }
  },
}
