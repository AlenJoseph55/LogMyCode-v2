import sqlite3 from "sqlite3";
import pg from "pg";
import path from "path";
import fs from "fs";
import dns from "dns";

// Determine DB configuration
let usePostgres = false;
let pgPool: pg.Pool | null = null;
let sqliteDb: sqlite3.Database | null = null;

export async function initDb() {
  usePostgres = !!process.env.DATABASE_URL;
  if (usePostgres) {
    console.log("Initializing PostgreSQL database client...");
    pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      lookup: (hostname: string, options: any, callback: (err: Error | null, address: string, family: number) => void) => {
        dns.lookup(hostname, { family: 4 }, callback);
      },
    } as any);
    // Create tables in PostgreSQL
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        name TEXT,
        tier TEXT DEFAULT 'free',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try {
      await executeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'free';`);
    } catch (e) {
      // Ignore if column already exists
    }
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS project_mappings (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        folder_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        UNIQUE(user_id, folder_path)
      );
    `);
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS commits (
        hash TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        project_name TEXT NOT NULL,
        message TEXT NOT NULL,
        diff TEXT,
        inferred_intent BOOLEAN NOT NULL,
        confidence_score TEXT NOT NULL,
        summary TEXT NOT NULL,
        concepts TEXT NOT NULL, -- JSON string or comma-separated list
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      );
    `);
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS cognee_datasets (
        user_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        dataset_name TEXT NOT NULL,
        PRIMARY KEY (user_id, project_name),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
  } else {
    console.log("Initializing local SQLite database client (logmycode.db)...");
    const dbPath = path.resolve(process.cwd(), "logmycode.db");
    sqliteDb = new sqlite3.Database(dbPath);

    // Create tables in SQLite (SQLite syntax is compatible here)
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        name TEXT,
        tier TEXT DEFAULT 'free',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    try {
      await executeQuery(`ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'free';`);
    } catch (e) {
      // Ignore if column already exists
    }
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS project_mappings (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        folder_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        UNIQUE(user_id, folder_path),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS commits (
        hash TEXT PRIMARY KEY,
        user_id TEXT,
        project_name TEXT NOT NULL,
        message TEXT NOT NULL,
        diff TEXT,
        inferred_intent INTEGER NOT NULL, -- SQLite fallback: 0 or 1
        confidence_score TEXT NOT NULL,
        summary TEXT NOT NULL,
        concepts TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        date TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS cognee_datasets (
        user_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        dataset_name TEXT NOT NULL,
        PRIMARY KEY (user_id, project_name),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
  }
}

// Helper to run query without returning rows
async function executeQuery(query: string, params: any[] = []): Promise<void> {
  if (usePostgres && pgPool) {
    await pgPool.query(query, params);
  } else if (sqliteDb) {
    return new Promise((resolve, reject) => {
      sqliteDb!.run(query, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } else {
    throw new Error("Database not initialized");
  }
}

// Helper to run query returning all rows
async function selectAll<T>(query: string, params: any[] = []): Promise<T[]> {
  if (usePostgres && pgPool) {
    const res = await pgPool.query(query, params);
    return res.rows as T[];
  } else if (sqliteDb) {
    return new Promise((resolve, reject) => {
      sqliteDb!.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    });
  } else {
    throw new Error("Database not initialized");
  }
}

// Helper to run query returning single row
async function selectOne<T>(query: string, params: any[] = []): Promise<T | null> {
  const rows = await selectAll<T>(query, params);
  return rows.length > 0 ? rows[0] : null;
}

// User Methods
export interface UserRow {
  id: string;
  email: string;
  name: string;
  tier?: string;
  created_at?: string;
}

export async function getUser(id: string): Promise<UserRow | null> {
  return selectOne<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
}

export async function createUser(user: { id: string; email: string; name: string; tier?: string }): Promise<UserRow> {
  const tier = user.tier || "free";
  await executeQuery(
    "INSERT INTO users (id, email, name, tier) VALUES ($1, $2, $3, $4) ON CONFLICT(id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, tier = EXCLUDED.tier",
    [user.id, user.email, user.name, tier]
  );
  return { id: user.id, email: user.email, name: user.name, tier };
}

export async function updateUserTier(id: string, tier: string): Promise<UserRow | null> {
  const user = await getUser(id);
  if (!user) return null;
  await executeQuery("UPDATE users SET tier = $1 WHERE id = $2", [tier, id]);
  return { ...user, tier };
}

// Project Mapping Methods
export interface ProjectMappingRow {
  id: string;
  user_id: string;
  folder_path: string;
  project_name: string;
}

export async function getProjectMappings(userId: string): Promise<ProjectMappingRow[]> {
  return selectAll<ProjectMappingRow>("SELECT * FROM project_mappings WHERE user_id = $1", [userId]);
}

export async function saveProjectMapping(
  userId: string,
  folderPath: string,
  projectName: string
): Promise<ProjectMappingRow> {
  const id = `${userId}_${Buffer.from(folderPath).toString("hex")}`;
  await executeQuery(
    `INSERT INTO project_mappings (id, user_id, folder_path, project_name) 
     VALUES ($1, $2, $3, $4) 
     ON CONFLICT(user_id, folder_path) 
     DO UPDATE SET project_name = EXCLUDED.project_name`,
    [id, userId, folderPath, projectName]
  );
  return { id, user_id: userId, folder_path: folderPath, project_name: projectName };
}

// Commit Methods
export interface CommitRow {
  hash: string;
  user_id: string;
  project_name: string;
  message: string;
  diff?: string;
  inferred_intent: boolean | number;
  confidence_score: string;
  summary: string;
  concepts: string;
  created_at?: string;
}

export async function getCommit(hash: string): Promise<CommitRow | null> {
  return selectOne<CommitRow>("SELECT * FROM commits WHERE hash = $1", [hash]);
}

export async function saveCommit(commit: {
  hash: string;
  userId: string;
  projectName: string;
  message: string;
  diff: string;
  inferredIntent: boolean;
  confidenceScore: string;
  summary: string;
  concepts: string[] | string;
}): Promise<void> {
  const inferred = usePostgres ? commit.inferredIntent : (commit.inferredIntent ? 1 : 0);
  const conceptsVal = Array.isArray(commit.concepts) ? JSON.stringify(commit.concepts) : commit.concepts;
  await executeQuery(
    `INSERT INTO commits (hash, user_id, project_name, message, diff, inferred_intent, confidence_score, summary, concepts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(hash) DO NOTHING`,
    [
      commit.hash,
      commit.userId,
      commit.projectName,
      commit.message,
      commit.diff,
      inferred,
      commit.confidenceScore,
      commit.summary,
      conceptsVal,
    ]
  );
}

// Daily Summary Methods
export interface DailySummaryRow {
  id: string;
  user_id: string;
  date: string;
  content: string;
  created_at?: string;
}

export async function getDailySummary(userId: string, date: string): Promise<DailySummaryRow | null> {
  return selectOne<DailySummaryRow>("SELECT * FROM daily_summaries WHERE user_id = $1 AND date = $2", [
    userId,
    date,
  ]);
}

export async function saveDailySummary(userId: string, date: string, content: string): Promise<DailySummaryRow> {
  const id = `${userId}_${date}`;
  await executeQuery(
    `INSERT INTO daily_summaries (id, user_id, date, content) 
     VALUES ($1, $2, $3, $4) 
     ON CONFLICT(user_id, date) 
     DO UPDATE SET content = EXCLUDED.content`,
    [id, userId, date, content]
  );
  return { id, user_id: userId, date, content };
}

// Cognee Dataset Methods
export async function getCogneeDataset(userId: string, projectName: string): Promise<string | null> {
  const row = await selectOne<{ dataset_name: string }>(
    "SELECT dataset_name FROM cognee_datasets WHERE user_id = $1 AND project_name = $2",
    [userId, projectName]
  );
  return row ? row.dataset_name : null;
}

export async function saveCogneeDataset(userId: string, projectName: string, datasetName: string): Promise<void> {
  await executeQuery(
    `INSERT INTO cognee_datasets (user_id, project_name, dataset_name)
     VALUES ($1, $2, $3)
     ON CONFLICT(user_id, project_name) DO UPDATE SET dataset_name = EXCLUDED.dataset_name`,
    [userId, projectName, datasetName]
  );
}
