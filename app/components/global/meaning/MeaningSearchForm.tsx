import { Button } from "@cloudflare/kumo";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { SEMANTIC_SEARCH_LIMITS } from "../../../../shared/semantic-search.ts";

export default function MeaningSearchForm({
	query,
	isLoading,
	isOnline,
	onQueryChange,
	onSubmit,
}: {
	query: string;
	isLoading: boolean;
	isOnline: boolean;
	onQueryChange(query: string): void;
	onSubmit(): void;
}) {
	return (
		<form
			className="mt-8"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<label htmlFor="meaning-query" className="text-sm font-semibold text-kumo-default">
				What do you need to find?
			</label>
			<div className="mt-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
				<input
					id="meaning-query"
					name="meaning-query"
					type="search"
					autoComplete="off"
					maxLength={SEMANTIC_SEARCH_LIMITS.queryChars}
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					placeholder="Messages where a customer seems likely to leave"
					aria-describedby="meaning-query-help"
					className="min-h-12 min-w-0 rounded-md border border-kumo-line bg-kumo-base px-4 text-base text-kumo-default outline-none placeholder:text-kumo-subtle focus:border-kumo-brand focus:ring-2 focus:ring-kumo-brand/20"
				/>
				<Button
					type="submit"
					variant="primary"
					icon={<ArrowRightIcon size={17} />}
					loading={isLoading}
					disabled={!isOnline || isLoading || query.trim().length < 2}
					className="min-h-12 w-full justify-center px-5 sm:w-auto"
				>
					Find by meaning
				</Button>
			</div>
			<div id="meaning-query-help" className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs leading-5 text-kumo-subtle">
				<p>Your wording stays out of the URL and browser history.</p>
				<p className="tabular-nums">{query.length}/{SEMANTIC_SEARCH_LIMITS.queryChars}</p>
			</div>
		</form>
	);
}
