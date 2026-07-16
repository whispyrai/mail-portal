import { DurableObject } from "cloudflare:workers";
import {
	applyMigrations,
	mailboxMigrations,
} from "../durableObject/migrations.ts";

interface MigrationHistoryEnvironment {
	MIGRATIONS: DurableObjectNamespace<MigrationHistoryTestDO>;
}

export class MigrationHistoryTestDO extends DurableObject<MigrationHistoryEnvironment> {
	applyForTest(names?: string[]): void {
		this.ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
		const selected = names === undefined
			? mailboxMigrations
			: mailboxMigrations.filter((migration) => names.includes(migration.name));
		applyMigrations(this.ctx.storage.sql, selected, this.ctx.storage);
	}

	executeForTest(query: string, bindings: unknown[] = []): Record<string, unknown>[] {
		return [...this.ctx.storage.sql.exec(query, ...bindings)];
	}

	columnsForTest(table: string): string[] {
		return [...this.ctx.storage.sql.exec(`PRAGMA table_info(${table})`)]
			.map((row) => String(row.name));
	}
}

type MigrationHistoryStub = DurableObjectStub<MigrationHistoryTestDO> & {
	applyForTest(names?: string[]): Promise<void>;
	executeForTest(
		query: string,
		bindings?: unknown[],
	): Promise<Record<string, unknown>[]>;
	columnsForTest(table: string): Promise<string[]>;
};

export default {
	async fetch(request: Request, env: MigrationHistoryEnvironment): Promise<Response> {
		const url = new URL(request.url);
		const database = url.searchParams.get("database") ?? "fresh";
		const stub = env.MIGRATIONS.get(
			env.MIGRATIONS.idFromName(database),
		) as MigrationHistoryStub;

		if (url.pathname === "/apply") {
			const body = await request.json() as { names?: string[] };
			await stub.applyForTest(body.names);
			return Response.json({ applied: true });
		}
		if (url.pathname === "/execute") {
			const body = await request.json() as {
				query: string;
				bindings?: unknown[];
			};
			return Response.json(await stub.executeForTest(
				body.query,
				body.bindings,
			));
		}
		if (url.pathname === "/columns") {
			const { table } = await request.json() as { table: string };
			if (!/^[a-z0-9_]+$/i.test(table)) {
				return Response.json({ error: "Invalid table" }, { status: 400 });
			}
			return Response.json(await stub.columnsForTest(table));
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
};
