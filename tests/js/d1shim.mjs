// A D1-shaped wrapper over node:sqlite for Worker tests: prepare(sql).bind(...).first()/run()/all(), and batch()
// as one transaction. Applies migrations/*.sql in order, like `wrangler d1 migrations apply`. Not a test file itself.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); // D1 enforces foreign keys
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  const plain = (row) => (row ? { ...row } : null);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => plain(db.prepare(sql).get(...args)),
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain), success: true }),
    run: async () => {
      const s = db.prepare(sql);
      if (/\bRETURNING\b/i.test(sql)) return { results: s.all(...args).map(plain), success: true, meta: {} };
      const r = s.run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    _exec: () => {
      const s = db.prepare(sql);
      return /\bRETURNING\b/i.test(sql) ? s.all(...args) : s.run(...args);
    },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => s._exec());
        db.exec("COMMIT");
        return out.map(() => ({ success: true }));
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
