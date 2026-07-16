import type { DatabaseSync } from "node:sqlite";
import {
	applyMigrations,
	type Migration,
} from "../durableObject/migrations.ts";

type SqlBinding = ArrayBuffer | string | number | null;

/** Apply the production migration runner to a Node SQLite test database. */
export function applySqliteMigrations(
	database: DatabaseSync,
	migrations: Migration[],
): void {
	const sql = {
		exec<T extends Record<string, SqlBinding>>(
			query: string,
			...bindings: SqlBinding[]
		): Iterable<T> {
			if (bindings.length > 0 || /^(?:PRAGMA|SELECT)\b/i.test(query.trim())) {
				return database.prepare(query).all(...bindings) as T[];
			}
			database.exec(query);
			return [];
		},
	} as SqlStorage;
	const storage = {
		transactionSync<T>(operation: () => T): T {
			database.exec("BEGIN IMMEDIATE");
			try {
				const result = operation();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	};
	applyMigrations(sql, migrations, storage);
}
