import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_BYTES = 2 * 1024 * 1024;
const PAGE_BYTES = 4096;
const BUSY_TIMEOUT_MS = 1000;

function fileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function ownedPrivately(info: { mode: number; uid: number }): boolean {
  return process.platform === "win32" || ((info.mode & 0o077) === 0 && info.uid === process.geteuid?.());
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Each task has an independently locked SQLite file with one versioned snapshot. */
export function createNativeExecutionStore<T>(
  directory: string,
  decode: (taskId: string, value: unknown) => T[],
  unavailable: () => Error,
) {
  const root = resolve(directory);

  function location(taskId: string): string {
    return resolve(root, `${createHash("sha256").update(taskId).digest("hex")}.sqlite`);
  }

  function load(database: DatabaseSync, taskId: string): T[] {
    const row = database.prepare(`
      SELECT version, task_id, CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload END AS payload
      FROM execution WHERE singleton = 1
    `).get(MAX_BYTES);
    if (row?.version !== 1 || row.task_id !== taskId || typeof row.payload !== "string") throw unavailable();
    return decode(taskId, JSON.parse(row.payload) as unknown);
  }

  async function existing(path: string): Promise<DatabaseSync | undefined> {
    let info;
    try {
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || !ownedPrivately(rootInfo)) throw unavailable();
      info = await lstat(path);
    } catch (error) {
      if (fileMissing(error)) return undefined;
      throw error;
    }
    if (!info.isFile() || info.size < PAGE_BYTES || info.size > MAX_BYTES || !ownedPrivately(info)) {
      throw unavailable();
    }
    // Open read/write so SQLite can recover an interrupted transaction before a read.
    return new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  }

  async function initialize(path: string, taskId: string): Promise<void> {
    const createdDirectory = await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || !ownedPrivately(rootInfo)) throw unavailable();
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.close();
      const database = new DatabaseSync(temp);
      try {
        database.exec(`
          PRAGMA page_size = ${PAGE_BYTES};
          PRAGMA synchronous = EXTRA;
          CREATE TABLE execution (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            version INTEGER NOT NULL CHECK (version = 1),
            task_id TEXT NOT NULL,
            payload TEXT NOT NULL
          ) STRICT;
        `);
        database.prepare("INSERT INTO execution VALUES (1, 1, ?, '[]')").run(taskId);
      } finally {
        database.close();
      }
      // Publish only a complete database. A competing initializer can never replace it.
      try {
        await link(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
      }
      if (process.platform !== "win32") {
        // Flush the file name and the parent entries of any new directories.
        const top = createdDirectory === undefined ? root : dirname(createdDirectory);
        let current = root;
        for (;;) {
          await syncDirectory(current);
          if (current === top) break;
          current = dirname(current);
        }
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  return {
    async read(taskId: string): Promise<T[]> {
      try {
        const database = await existing(location(taskId));
        if (database === undefined) return [];
        try {
          return load(database, taskId);
        } finally {
          database.close();
        }
      } catch {
        throw unavailable();
      }
    },

    async update<R>(
      taskId: string,
      mutate: (entries: T[]) => { result: R; entries?: T[] },
    ): Promise<R> {
      const path = location(taskId);
      let database: DatabaseSync | undefined;
      try {
        database = await existing(path);
        if (database === undefined) {
          await initialize(path, taskId);
          database = await existing(path);
        }
      } catch {
        throw unavailable();
      }
      if (database === undefined) throw unavailable();
      try {
        let entries: T[];
        try {
          database.exec(`
            PRAGMA synchronous = EXTRA;
            PRAGMA max_page_count = ${MAX_BYTES / PAGE_BYTES};
            BEGIN IMMEDIATE;
          `);
          entries = load(database, taskId);
        } catch {
          throw unavailable();
        }

        // Preserve domain errors. Closing a connection rolls back an unfinished transaction.
        const mutation = mutate(entries);
        try {
          if (mutation.entries !== undefined) {
            const payload = JSON.stringify(mutation.entries);
            if (Buffer.byteLength(payload) > MAX_BYTES) throw unavailable();
            decode(taskId, JSON.parse(payload) as unknown);
            database.prepare("UPDATE execution SET payload = ? WHERE singleton = 1").run(payload);
          }
          database.exec("COMMIT");
        } catch {
          throw unavailable();
        }
        return mutation.result;
      } finally {
        database.close();
      }
    },
  };
}
