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
    await db.songTags.add({ songUri: spotifyUri, tagId })
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

  ignoreSong: async (spotifyUri: string): Promise<void> => {
    const config = getConfig()
    await db.songs.update(spotifyUri, { ignored: true })
    if (config.ignorePlaylistId) {
      await spotifyApi.addTrackToPlaylist(spotifyUri, config.ignorePlaylistId)
    }
  },

  syncPlaylists: (onProgress?: (p: SyncProgress) => void): Promise<{ playlistsProcessed: number; songsUpdated: number }> =>
    sync(onProgress),

  removeFromShazam: async (spotifyUri: string): Promise<void> => {
    const config = getConfig()
    if (!config.shazamPlaylistId) throw new Error('Shazam playlist not configured')
    await spotifyApi.removeTrackFromPlaylist(spotifyUri, config.shazamPlaylistId)
  },

  getShazamSongs: async (onBatch: (songs: SongResponse[]) => void): Promise<void> => {
    const config = getConfig()
    if (!config.shazamPlaylistId) return
    const buildSongs = await createTrackSongBuilder()
    await spotifyApi.streamPlaylistTracks(config.shazamPlaylistId, (tracks) => onBatch(buildSongs(tracks)))
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
        ignored: false,
      })
    }
  },
}
