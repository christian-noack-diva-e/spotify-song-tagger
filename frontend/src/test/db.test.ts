import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { db, querySongs, querySong, queryCategories } from '../db'
import type { Song } from '../db'

// Reset the DB before each test
beforeEach(async () => {
  await db.transaction('rw', [db.songs, db.tags, db.categories, db.songTags], async () => {
    await db.songs.clear()
    await db.tags.clear()
    await db.categories.clear()
    await db.songTags.clear()
  })
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedCategory(name: string): Promise<number> {
  return (await db.categories.add({ name })) as number
}

async function seedTag(playlistName: string, categoryId: number, tagValue: string, playlistId = 'pl-1'): Promise<number> {
  return (await db.tags.add({ playlistName, categoryId, tagValue, spotifyPlaylistId: playlistId })) as number
}

async function seedSong(overrides: Partial<Song> = {}): Promise<Song> {
  const song: Song = {
    spotifyUri: 'spotify:track:1',
    title: 'Test Song',
    artist: 'Test Artist',
    coverUrl: null,
    durationMs: 200000,
    discoveredDate: '2024-01-01',
    ignored: false,
    ...overrides,
  }
  await db.songs.add(song)
  return song
}

async function assignTag(songUri: string, tagId: number): Promise<void> {
  await db.songTags.add({ songUri, tagId })
}

// ── queryCategories ───────────────────────────────────────────────────────────

describe('queryCategories', () => {
  it('returns empty array when no categories exist', async () => {
    expect(await queryCategories()).toEqual([])
  })

  it('returns categories with their tags', async () => {
    const catId = await seedCategory('Energy')
    await seedTag('Dance High Energy', catId, 'High')

    const result = await queryCategories()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Energy')
    expect(result[0].tags).toHaveLength(1)
    expect(result[0].tags[0].value).toBe('High')
  })

  it('sorts by categoryNames order from config', async () => {
    // Default config has Energy before Mood before Genre
    await seedCategory('Mood')
    await seedCategory('Energy')
    await seedCategory('Genre')

    const result = await queryCategories()
    expect(result.map(c => c.name)).toEqual(['Energy', 'Mood', 'Genre'])
  })

  it('returns category with id populated', async () => {
    const catId = await seedCategory('Beat')
    const result = await queryCategories()
    expect(result[0].id).toBe(catId)
  })

  it('does not leak tags from other categories into a category', async () => {
    const cat1 = await seedCategory('Energy')
    const cat2 = await seedCategory('Mood')
    await seedTag('Dance High Energy', cat1, 'High')
    await seedTag('Dance Happy Mood', cat2, 'Happy')

    const result = await queryCategories()
    const energy = result.find(c => c.name === 'Energy')!
    expect(energy.tags.every(t => t.categoryName === 'Energy')).toBe(true)
  })
})

// ── querySongs ────────────────────────────────────────────────────────────────

describe('querySongs', () => {
  it('returns empty array when no songs exist', async () => {
    expect(await querySongs()).toEqual([])
  })

  it('excludes ignored songs', async () => {
    await seedSong({ spotifyUri: 'spotify:track:1', title: 'Visible', ignored: false })
    await seedSong({ spotifyUri: 'spotify:track:2', title: 'Hidden', ignored: true })

    const result = await querySongs()
    expect(result.map(s => s.title)).toEqual(['Visible'])
  })

  it('populates tags for each song', async () => {
    const catId = await seedCategory('Energy')
    const tagId = await seedTag('Dance High Energy', catId, 'High')
    const song = await seedSong()
    await assignTag(song.spotifyUri, tagId)

    const result = await querySongs()
    expect(result[0].tags).toHaveLength(1)
    expect(result[0].tags[0].value).toBe('High')
    expect(result[0].tags[0].categoryName).toBe('Energy')
  })

  it('computes missingCategories correctly', async () => {
    const cat1 = await seedCategory('Energy')
    await seedCategory('Mood')
    const tagId = await seedTag('Dance High Energy', cat1, 'High')
    const song = await seedSong()
    await assignTag(song.spotifyUri, tagId)

    const result = await querySongs()
    expect(result[0].missingCategories).toEqual(['Mood'])
  })

  it('reports no missing categories when all are covered', async () => {
    const catId = await seedCategory('Energy')
    const tagId = await seedTag('Dance High Energy', catId, 'High')
    const song = await seedSong()
    await assignTag(song.spotifyUri, tagId)

    const result = await querySongs()
    expect(result[0].missingCategories).toEqual([])
  })

  it('reports all categories as missing for an untagged song', async () => {
    await seedCategory('Energy')
    await seedCategory('Mood')
    await seedSong()

    const result = await querySongs()
    expect(result[0].missingCategories).toEqual(['Energy', 'Mood'])
  })

  it('filters by missingCategory when provided', async () => {
    const cat1 = await seedCategory('Energy')
    await seedCategory('Mood')
    const tagId = await seedTag('Dance High Energy', cat1, 'High')

    // Song A: has Energy, missing Mood
    await seedSong({ spotifyUri: 'spotify:track:A', title: 'Song A' })
    await assignTag('spotify:track:A', tagId)

    // Song B: has nothing, missing both
    await seedSong({ spotifyUri: 'spotify:track:B', title: 'Song B' })

    const result = await querySongs('Mood')
    expect(result.map(s => s.title).sort()).toEqual(['Song A', 'Song B'])
  })

  it('returns no songs when missingCategory filter matches nothing', async () => {
    const catId = await seedCategory('Energy')
    const tagId = await seedTag('Dance High Energy', catId, 'High')
    const song = await seedSong()
    await assignTag(song.spotifyUri, tagId)

    // Song has Energy; filter for Mood which doesn't exist as a category
    const result = await querySongs('Mood')
    expect(result).toEqual([])
  })

  it('passes through all song metadata fields', async () => {
    await seedSong({
      spotifyUri: 'spotify:track:meta',
      title: 'Meta Song',
      artist: 'Some Artist',
      coverUrl: 'https://example.com/cover.jpg',
      durationMs: 180000,
      discoveredDate: '2023-06-15',
    })

    const result = await querySongs()
    const s = result[0]
    expect(s.title).toBe('Meta Song')
    expect(s.artist).toBe('Some Artist')
    expect(s.coverUrl).toBe('https://example.com/cover.jpg')
    expect(s.durationMs).toBe(180000)
    expect(s.discoveredDate).toBe('2023-06-15')
  })

  it('handles a song with multiple tags across multiple categories', async () => {
    const cat1 = await seedCategory('Energy')
    const cat2 = await seedCategory('Mood')
    await seedCategory('Genre')
    const tag1 = await seedTag('Dance High Energy', cat1, 'High')
    const tag2 = await seedTag('Dance Happy Mood', cat2, 'Happy')
    const song = await seedSong()
    await assignTag(song.spotifyUri, tag1)
    await assignTag(song.spotifyUri, tag2)

    const result = await querySongs()
    expect(result[0].tags).toHaveLength(2)
    expect(result[0].missingCategories).toEqual(['Genre'])
  })
})

// ── querySong ─────────────────────────────────────────────────────────────────

describe('querySong', () => {
  it('returns null for an unknown URI', async () => {
    expect(await querySong('spotify:track:nope')).toBeNull()
  })

  it('returns the song with full tag and category join', async () => {
    const catId = await seedCategory('Energy')
    const tagId = await seedTag('Dance High Energy', catId, 'High')
    const song = await seedSong({ spotifyUri: 'spotify:track:single' })
    await assignTag(song.spotifyUri, tagId)

    const result = await querySong('spotify:track:single')
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Test Song')
    expect(result!.tags[0].value).toBe('High')
    expect(result!.missingCategories).toEqual([])
  })

  it('returns a song with no tags and all categories missing', async () => {
    await seedCategory('Mood')
    await seedSong({ spotifyUri: 'spotify:track:bare' })

    const result = await querySong('spotify:track:bare')
    expect(result!.tags).toHaveLength(0)
    expect(result!.missingCategories).toEqual(['Mood'])
  })
})
