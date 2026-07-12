import { AI_SEARCH_INTERPRETER_LIMITS } from "../../shared/ai-search-interpreter.ts";
import { InternalFolders } from "../../shared/folders.ts";
import type { AiSearchCatalog } from "./ai-search-interpreter.ts";

type SqlValue = ArrayBuffer | string | number | null;

export interface AiSearchCatalogSqlReader {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

type CatalogRow = { id: string; name: string };

/** Read only the bounded identities that the interpreter is allowed to see. */
export function readAiSearchInterpreterCatalog(
	sql: AiSearchCatalogSqlReader,
): AiSearchCatalog {
	const limit = AI_SEARCH_INTERPRETER_LIMITS.catalogEntries + 1;
	const folders = [...sql.exec<CatalogRow>(
		`SELECT id, name
		 FROM folders
		 WHERE id <> ?1
		 ORDER BY id ASC, name ASC
		 LIMIT ?2`,
		InternalFolders.RETIRED_OUTBOUND,
		limit,
	)];
	const labels = [...sql.exec<CatalogRow>(
		`SELECT id, name
		 FROM labels
		 ORDER BY id ASC, name ASC
		 LIMIT ?1`,
		limit,
	)];
	return { folders, labels };
}
