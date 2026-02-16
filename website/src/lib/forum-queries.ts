import { getDb } from './db'

export type PostCategory = 'general' | 'proposal' | 'technical' | 'governance'
export type SortBy = 'newest' | 'popular' | 'discussed'
export type FactionFilter = 'all' | 'human' | 'claw'

export interface ForumPost {
  id: number
  title: string
  content: string
  author_address: string
  author_signature: string
  category: PostCategory
  tags: string | null
  proposal_id: number | null
  upvotes: number
  downvotes: number
  reply_count: number
  pinned: number
  created_at: number
  updated_at: number
  author_faction?: string
  author_display_name?: string
}

export interface ForumReply {
  id: number
  post_id: number
  parent_reply_id: number | null
  content: string
  author_address: string
  author_signature: string
  upvotes: number
  downvotes: number
  created_at: number
  author_faction?: string
  author_display_name?: string
}

export interface ForumVote {
  id: number
  target_type: string
  target_id: number
  voter_address: string
  vote_type: string
  created_at: number
}

interface ListPostsParams {
  page?: number
  limit?: number
  category?: PostCategory
  faction?: FactionFilter
  sortBy?: SortBy
  search?: string
}

export function listPosts(params: ListPostsParams = {}): { posts: ForumPost[]; total: number } {
  const db = getDb()
  const { page = 1, limit = 20, category, faction, sortBy = 'newest', search } = params

  let where = 'WHERE 1=1'
  const queryParams: unknown[] = []

  if (category) {
    where += ' AND p.category = ?'
    queryParams.push(category)
  }

  if (faction && faction !== 'all') {
    where += ' AND i.faction = ?'
    queryParams.push(faction)
  }

  if (search) {
    where += ' AND (p.title LIKE ? OR p.content LIKE ?)'
    queryParams.push(`%${search}%`, `%${search}%`)
  }

  let orderBy = 'ORDER BY p.pinned DESC, '
  switch (sortBy) {
    case 'popular':
      orderBy += 'p.upvotes DESC, p.created_at DESC'
      break
    case 'discussed':
      orderBy += 'p.reply_count DESC, p.created_at DESC'
      break
    default:
      orderBy += 'p.created_at DESC'
  }

  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM forum_posts p
    LEFT JOIN identities i ON p.author_address = i.address
    ${where}
  `).get(...queryParams) as { total: number }

  const offset = (page - 1) * limit
  const posts = db.prepare(`
    SELECT p.*, i.faction as author_faction, i.display_name as author_display_name
    FROM forum_posts p
    LEFT JOIN identities i ON p.author_address = i.address
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...queryParams, limit, offset) as ForumPost[]

  return { posts, total: countRow.total }
}

export function getPost(id: number): ForumPost | undefined {
  const db = getDb()
  return db.prepare(`
    SELECT p.*, i.faction as author_faction, i.display_name as author_display_name
    FROM forum_posts p
    LEFT JOIN identities i ON p.author_address = i.address
    WHERE p.id = ?
  `).get(id) as ForumPost | undefined
}

export function createPost(data: {
  title: string
  content: string
  author_address: string
  author_signature: string
  category?: PostCategory
  tags?: string
}): ForumPost {
  const db = getDb()
  const now = Date.now()
  const result = db.prepare(`
    INSERT INTO forum_posts (title, content, author_address, author_signature, category, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(data.title, data.content, data.author_address, data.author_signature, data.category || 'general', data.tags || null, now, now)

  return getPost(result.lastInsertRowid as number)!
}

export function getReplies(postId: number): ForumReply[] {
  const db = getDb()
  return db.prepare(`
    SELECT r.*, i.faction as author_faction, i.display_name as author_display_name
    FROM forum_replies r
    LEFT JOIN identities i ON r.author_address = i.address
    WHERE r.post_id = ?
    ORDER BY r.created_at ASC
  `).all(postId) as ForumReply[]
}

export function createReply(data: {
  post_id: number
  content: string
  author_address: string
  author_signature: string
  parent_reply_id?: number
}): ForumReply {
  const db = getDb()
  const now = Date.now()

  const result = db.prepare(`
    INSERT INTO forum_replies (post_id, parent_reply_id, content, author_address, author_signature, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.post_id, data.parent_reply_id || null, data.content, data.author_address, data.author_signature, now)

  db.prepare('UPDATE forum_posts SET reply_count = reply_count + 1, updated_at = ? WHERE id = ?').run(now, data.post_id)

  return db.prepare(`
    SELECT r.*, i.faction as author_faction, i.display_name as author_display_name
    FROM forum_replies r
    LEFT JOIN identities i ON r.author_address = i.address
    WHERE r.id = ?
  `).get(result.lastInsertRowid as number) as ForumReply
}

export function castVote(data: {
  target_type: 'post' | 'reply'
  target_id: number
  voter_address: string
  vote_type: 'up' | 'down'
}): { upvotes: number; downvotes: number } {
  const db = getDb()
  const now = Date.now()

  // Check existing vote
  const existing = db.prepare(
    'SELECT * FROM forum_votes WHERE target_type = ? AND target_id = ? AND voter_address = ?'
  ).get(data.target_type, data.target_id, data.voter_address) as ForumVote | undefined

  const table = data.target_type === 'post' ? 'forum_posts' : 'forum_replies'

  if (existing) {
    if (existing.vote_type === data.vote_type) {
      // Remove vote (toggle off)
      db.prepare('DELETE FROM forum_votes WHERE id = ?').run(existing.id)
      const col = data.vote_type === 'up' ? 'upvotes' : 'downvotes'
      db.prepare(`UPDATE ${table} SET ${col} = MAX(0, ${col} - 1) WHERE id = ?`).run(data.target_id)
    } else {
      // Switch vote
      db.prepare('UPDATE forum_votes SET vote_type = ?, created_at = ? WHERE id = ?').run(data.vote_type, now, existing.id)
      const addCol = data.vote_type === 'up' ? 'upvotes' : 'downvotes'
      const removeCol = data.vote_type === 'up' ? 'downvotes' : 'upvotes'
      db.prepare(`UPDATE ${table} SET ${addCol} = ${addCol} + 1, ${removeCol} = MAX(0, ${removeCol} - 1) WHERE id = ?`).run(data.target_id)
    }
  } else {
    // New vote
    db.prepare(
      'INSERT INTO forum_votes (target_type, target_id, voter_address, vote_type, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(data.target_type, data.target_id, data.voter_address, data.vote_type, now)
    const col = data.vote_type === 'up' ? 'upvotes' : 'downvotes'
    db.prepare(`UPDATE ${table} SET ${col} = ${col} + 1 WHERE id = ?`).run(data.target_id)
  }

  const row = db.prepare(`SELECT upvotes, downvotes FROM ${table} WHERE id = ?`).get(data.target_id) as { upvotes: number; downvotes: number }
  return row
}

export function linkProposal(postId: number, chainProposalId: number, linkedBy: string): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO proposal_links (post_id, chain_proposal_id, linked_by, linked_at) VALUES (?, ?, ?, ?)'
  ).run(postId, chainProposalId, linkedBy, Date.now())

  db.prepare('UPDATE forum_posts SET proposal_id = ?, updated_at = ? WHERE id = ?').run(chainProposalId, Date.now(), postId)
}

// Identity queries
export function getIdentity(address: string) {
  const db = getDb()
  return db.prepare('SELECT * FROM identities WHERE address = ?').get(address.toLowerCase())
}

export function upsertIdentity(data: {
  address: string
  faction: string
  display_name?: string
  chain_registered?: boolean
}) {
  const db = getDb()
  const now = Date.now()
  const addr = data.address.toLowerCase()

  db.prepare(`
    INSERT INTO identities (address, faction, display_name, chain_registered, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      faction = excluded.faction,
      display_name = COALESCE(excluded.display_name, identities.display_name),
      chain_registered = COALESCE(excluded.chain_registered, identities.chain_registered),
      updated_at = excluded.updated_at
  `).run(addr, data.faction, data.display_name || null, data.chain_registered ? 1 : 0, now, now)
}

export function getForumStats() {
  const db = getDb()
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM forum_posts) as total_posts,
      (SELECT COUNT(*) FROM forum_replies) as total_replies,
      (SELECT COUNT(*) FROM identities WHERE faction = 'human') as human_count,
      (SELECT COUNT(*) FROM identities WHERE faction = 'claw') as claw_count,
      (SELECT COUNT(*) FROM identities) as total_users
  `).get() as Record<string, number>
  return stats
}
