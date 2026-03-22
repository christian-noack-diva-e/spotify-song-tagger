import Dexie from 'dexie'
import type { SongResponse, TagResponse, CategoryResponse } from './types'
import { getConfig } from './settingsStore'

// — Raw DB row types —

export interface Song {
  spotifyUri: string
  title: string
  artist: string
  coverUrl: string | null
  durationMs: number | null
  discoveredDate: string | null  // "YYYY-MM-DD"
  ignored: boolean
}

export interface Tag {
  id?: number
  playlistName: string
  categoryId: number
  tagValue: string
  spotifyPlaylistId: string | null
}

export interface Category {
  id?: number
  name: string
}

export interface SongTag {
  songUri: string
  tagId: number
}

// — DB schema —

class SpotifyTaggerDB extends Dexie {
  songs!: Dexie.Table<Song, string>
  tags!: Dexie.Table<Tag, number>
  categories!: Dexie.Table<Category, number>
  songTags!: Dexie.Table<SongTag, [string, number]>

  constructor() {
    super('SpotifyTaggerDB')
    this.version(1).stores({
      songs: 'spotifyUri, title, artist, ignored',
      tags: '++id, &playlistName, categoryId, spotifyPlaylistId',
      categories: '++id, &name',
      songTags: '[songUri+tagId], songUri, tagId',
    })
  }
}

export const db = new SpotifyTaggerDB()

// — Join helpers —

async function loadJoinData() {
  const [allCategories, allTags, allSongTags] = await Promise.all([
    db.categories.toArray(),
    db.tags.toArray(),
    db.songTags.toArray(),
  ])
  const nameOrder = new Map(getConfig().categoryNames.map((name, i) => [name, i]))
  allCategories.sort((a, b) => (nameOrder.get(a.name) ?? 999) - (nameOrder.get(b.name) ?? 999))
  return { allCategories, allTags, allSongTags }
}

function buildSongResponse(
  song: Song,
  allSongTags: SongTag[],
  tagsById: Map<number, Tag>,
  categoriesById: Map<number, Category>,
  allCategoryNames: string[],
): SongResponse {
  const mySongTags = allSongTags.filter(st => st.songUri === song.spotifyUri)
  const tags: TagResponse[] = mySongTags
    .map(st => {
      const tag = tagsById.get(st.tagId)
      if (!tag || tag.id == null) return null
      const cat = categoriesById.get(tag.categoryId)
      return {
        id: tag.id,
        categoryName: cat?.name ?? 'Other',
        value: tag.tagValue,
        playlistName: tag.playlistName,
      } as TagResponse
    })
    .filter((t): t is TagResponse => t !== null)

  const assignedCategoryNames = new Set(tags.map(t => t.categoryName))
  const missingCategories = allCategoryNames.filter(n => !assignedCategoryNames.has(n))

  return {
    spotifyUri: song.spotifyUri,
    title: song.title,
    artist: song.artist,
    coverUrl: song.coverUrl,
    durationMs: song.durationMs,
    discoveredDate: song.discoveredDate,
    missingCategories,
    tags,
  }
}

// — Query API used by api.ts —

export async function querySongs(missingCategory?: string): Promise<SongResponse[]> {
  const { allCategories, allTags, allSongTags } = await loadJoinData()
  const tagsById = new Map(allTags.filter(t => t.id != null).map(t => [t.id!, t]))
  const categoriesById = new Map(allCategories.filter(c => c.id != null).map(c => [c.id!, c]))
  const allCategoryNames = allCategories.map(c => c.name)

  const songs = (await db.songs.toArray()).filter(s => !s.ignored)
  const result = songs.map(s =>
    buildSongResponse(s, allSongTags, tagsById, categoriesById, allCategoryNames)
  )

  if (missingCategory) {
    return result.filter(s => s.missingCategories.includes(missingCategory))
  }
  return result
}

export async function querySong(spotifyUri: string): Promise<SongResponse | null> {
  const song = await db.songs.get(spotifyUri)
  if (!song) return null
  const { allCategories, allTags, allSongTags } = await loadJoinData()
  const tagsById = new Map(allTags.filter(t => t.id != null).map(t => [t.id!, t]))
  const categoriesById = new Map(allCategories.filter(c => c.id != null).map(c => [c.id!, c]))
  const allCategoryNames = allCategories.map(c => c.name)
  return buildSongResponse(song, allSongTags, tagsById, categoriesById, allCategoryNames)
}

export async function createTrackSongBuilder(): Promise<
  (tracks: Array<{ uri: string; title: string; artist: string; coverUrl: string | null; durationMs: number; addedAt: string | null }>) => SongResponse[]
> {
  const { allCategories, allTags, allSongTags } = await loadJoinData()
  const tagsById = new Map(allTags.filter(t => t.id != null).map(t => [t.id!, t]))
  const categoriesById = new Map(allCategories.filter(c => c.id != null).map(c => [c.id!, c]))
  const allCategoryNames = allCategories.map(c => c.name)
  return (tracks) => tracks.map(track => buildSongResponse(
    { spotifyUri: track.uri, title: track.title, artist: track.artist, coverUrl: track.coverUrl, durationMs: track.durationMs, discoveredDate: track.addedAt, ignored: false },
    allSongTags, tagsById, categoriesById, allCategoryNames,
  ))
}

export async function queryTracksAsSongs(
  tracks: Array<{ uri: string; title: string; artist: string; coverUrl: string | null; durationMs: number; addedAt: string | null }>,
): Promise<SongResponse[]> {
  const { allCategories, allTags, allSongTags } = await loadJoinData()
  const tagsById = new Map(allTags.filter(t => t.id != null).map(t => [t.id!, t]))
  const categoriesById = new Map(allCategories.filter(c => c.id != null).map(c => [c.id!, c]))
  const allCategoryNames = allCategories.map(c => c.name)

  return tracks.map(track => {
    const song: Song = {
      spotifyUri: track.uri,
      title: track.title,
      artist: track.artist,
      coverUrl: track.coverUrl,
      durationMs: track.durationMs,
      discoveredDate: track.addedAt,
      ignored: false,
    }
    return buildSongResponse(song, allSongTags, tagsById, categoriesById, allCategoryNames)
  })
}

export async function queryCategories(): Promise<CategoryResponse[]> {
  const nameOrder = new Map(getConfig().categoryNames.map((name, i) => [name, i]))
  const categories = (await db.categories.toArray())
    .sort((a, b) => (nameOrder.get(a.name) ?? 999) - (nameOrder.get(b.name) ?? 999))
  const allTags = await db.tags.toArray()

  return categories
    .filter(c => c.id != null)
    .map(c => ({
      id: c.id!,
      name: c.name,
      tags: allTags
        .filter(t => t.categoryId === c.id && t.id != null)
        .map(t => ({
          id: t.id!,
          categoryName: c.name,
          value: t.tagValue,
          playlistName: t.playlistName,
        }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    }))
}
