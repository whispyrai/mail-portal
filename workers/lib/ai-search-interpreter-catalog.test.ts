import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readAiSearchInterpreterCatalog } from "./ai-search-interpreter-catalog.ts";

test("catalog projection reads identity only, excludes internal folders, and changes no rows", () => {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT);
		INSERT INTO folders VALUES ('sent', 'Sent'), ('inbox', 'Inbox'),
			('_cancelled_outbound', 'Retired');
		INSERT INTO labels VALUES ('label-vip', 'VIP', 'red');
	`);
	const before = database.prepare("SELECT total_changes() AS value").get() as {
		value: number;
	};
	const catalog = readAiSearchInterpreterCatalog({
		exec<T extends Record<string, ArrayBuffer | string | number | null>>(
			query: string,
			...bindings: (ArrayBuffer | string | number | null)[]
		) {
			return database.prepare(query).all(...bindings) as T[];
		},
	});
	assert.deepEqual({
		folders: catalog.folders.map((row) => ({ ...row })),
		labels: catalog.labels.map((row) => ({ ...row })),
	}, {
		folders: [
			{ id: "inbox", name: "Inbox" },
			{ id: "sent", name: "Sent" },
		],
		labels: [{ id: "label-vip", name: "VIP" }],
	});
	const after = database.prepare("SELECT total_changes() AS value").get() as {
		value: number;
	};
	assert.equal(after.value, before.value);
	database.close();
});
