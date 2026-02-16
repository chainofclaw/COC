import Database from 'better-sqlite3'
import path from 'path'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  const dbPath = process.env.COC_DB_PATH || path.join(process.cwd(), 'data', 'coc-forum.db')

  // Ensure directory exists
  const dir = path.dirname(dbPath)
  const fs = require('fs')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  initSchema(db)
  return db
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      address TEXT PRIMARY KEY,
      faction TEXT NOT NULL DEFAULT 'none',
      display_name TEXT,
      avatar_url TEXT,
      verified INTEGER DEFAULT 0,
      verification_level INTEGER DEFAULT 0,
      chain_registered INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forum_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_address TEXT NOT NULL,
      author_signature TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      tags TEXT,
      proposal_id INTEGER,
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forum_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      parent_reply_id INTEGER,
      content TEXT NOT NULL,
      author_address TEXT NOT NULL,
      author_signature TEXT NOT NULL,
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (post_id) REFERENCES forum_posts(id)
    );

    CREATE TABLE IF NOT EXISTS forum_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      voter_address TEXT NOT NULL,
      vote_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(target_type, target_id, voter_address)
    );

    CREATE TABLE IF NOT EXISTS proposal_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      chain_proposal_id INTEGER NOT NULL,
      linked_by TEXT NOT NULL,
      linked_at INTEGER NOT NULL,
      FOREIGN KEY (post_id) REFERENCES forum_posts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_category ON forum_posts(category);
    CREATE INDEX IF NOT EXISTS idx_posts_author ON forum_posts(author_address);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON forum_posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_replies_post ON forum_replies(post_id);
    CREATE INDEX IF NOT EXISTS idx_votes_target ON forum_votes(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_identities_faction ON identities(faction);
  `)
}
