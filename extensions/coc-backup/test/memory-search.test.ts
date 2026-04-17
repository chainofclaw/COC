import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Dynamic import of node:sqlite
let DatabaseSync: typeof import("node:sqlite").DatabaseSync | null = null
try {
  const mod = await import("node:sqlite")
  DatabaseSync = mod.DatabaseSync
} catch {
  // node:sqlite not available
}

import { searchMemories } from "../src/recovery/memory-search.ts"
import type { MemorySearchResult } from "../src/recovery/memory-search.ts"

const skipSqlite = DatabaseSync === null

function createTestDb(dbPath: string): void {
  if (!DatabaseSync) throw new Error("node:sqlite not available")

  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT,
      text TEXT,
      type TEXT,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER,
      created_at TEXT,
      created_at_epoch INTEGER,
      content_hash TEXT,
      generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, subtitle, narrative, text, facts, concepts,
      content='observations', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
    END;
  `)

  const insert = db.prepare(`
    INSERT INTO observations (type, title, narrative, facts, concepts, project, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const now = Math.floor(Date.now() / 1000)

  insert.run("decision", "Implemented Redis caching", "Added Redis to reduce database load by 60%", '["Reduced queries by 60%"]', '["redis","caching"]', "api-project", new Date().toISOString(), now)
  insert.run("discovery", "Found SQL injection vulnerability", "Discovered unparameterized query in login endpoint", '["Login endpoint vulnerable"]', '["security","sql"]', "api-project", new Date().toISOString(), now - 100)
  insert.run("pattern", "Repository pattern usage", "All services consistently use repository pattern for data access", '["Consistent data access"]', '["architecture","pattern"]', "api-project", new Date().toISOString(), now - 200)
  insert.run("learning", "TypeScript strict mode benefits", "Enabling strict mode caught 12 type errors at compile time", '["12 type errors found"]', '["typescript","quality"]', "other-project", new Date().toISOString(), now - 300)

  db.close()
}

describe("memory-search", { skip: skipSqlite ? "node:sqlite not available" : false }, () => {
  let tmpDir: string

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "coc-search-test-"))
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("searches via SQLite FTS5 when worker is unavailable", async () => {
    const dbDir = join(tmpDir, "fts-test")
    const memDir = join(dbDir, "memory")
    await mkdir(memDir, { recursive: true })
    createTestDb(join(memDir, "claude-mem.db"))

    const result = await searchMemories({
      query: "Redis caching",
      limit: 10,
      dataDir: dbDir,
      claudeMemWorkerUrl: "http://127.0.0.1:99999", // unreachable
    })

    assert.ok(result.source === "sqlite-fts" || result.source === "sqlite-like")
    assert.ok(result.results.length > 0)

    const redisHit = result.results.find((r) => r.title?.includes("Redis"))
    assert.ok(redisHit, "Expected to find Redis observation")
    assert.equal(redisHit!.type, "decision")
  })

  it("filters by observation type", async () => {
    const dbDir = join(tmpDir, "type-filter-test")
    const memDir = join(dbDir, "memory")
    await mkdir(memDir, { recursive: true })
    createTestDb(join(memDir, "claude-mem.db"))

    const result = await searchMemories({
      query: "pattern",
      limit: 10,
      type: "pattern",
      dataDir: dbDir,
      claudeMemWorkerUrl: "http://127.0.0.1:99999",
    })

    // All results should be of type "pattern"
    for (const hit of result.results) {
      assert.equal(hit.type, "pattern")
    }
  })

  it("respects limit parameter", async () => {
    const dbDir = join(tmpDir, "limit-test")
    const memDir = join(dbDir, "memory")
    await mkdir(memDir, { recursive: true })
    createTestDb(join(memDir, "claude-mem.db"))

    const result = await searchMemories({
      query: "project",
      limit: 2,
      dataDir: dbDir,
      claudeMemWorkerUrl: "http://127.0.0.1:99999",
    })

    assert.ok(result.results.length <= 2)
  })

  it("returns empty results when no database exists", async () => {
    const result = await searchMemories({
      query: "anything",
      limit: 10,
      dataDir: join(tmpDir, "nonexistent"),
      claudeMemWorkerUrl: "http://127.0.0.1:99999",
    })

    assert.equal(result.results.length, 0)
  })

  it("falls back to LIKE when FTS table structure differs", async () => {
    const dbDir = join(tmpDir, "like-fallback-test")
    const memDir = join(dbDir, "memory")
    await mkdir(memDir, { recursive: true })

    // Create DB without FTS triggers (simulating schema mismatch)
    if (!DatabaseSync) throw new Error("node:sqlite not available")
    const dbPath = join(memDir, "claude-mem.db")
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT, title TEXT, narrative TEXT,
        facts TEXT, concepts TEXT, created_at TEXT,
        created_at_epoch INTEGER
      );
    `)
    db.prepare(`
      INSERT INTO observations (type, title, narrative, facts, concepts, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("decision", "Added Redis caching", "Reduced DB load", '["perf improvement"]', '["redis"]', new Date().toISOString(), Date.now())
    db.close()

    const result = await searchMemories({
      query: "Redis",
      limit: 10,
      dataDir: dbDir,
      claudeMemWorkerUrl: "http://127.0.0.1:99999",
    })

    assert.equal(result.source, "sqlite-like")
    assert.ok(result.results.length > 0)
  })
})
