import {
	ArrowDownLeftIcon,
	ArrowUpRightIcon,
} from "@phosphor-icons/react";
import type { MailPersonSummary } from "../../../shared/mail-people.ts";
import { formatListDate } from "~/lib/utils";

export default function PeopleList({
	items,
	selectedId,
	onSelect,
}: {
	items: MailPersonSummary[];
	selectedId: string | null;
	onSelect: (personId: string) => void;
}) {
	return (
		<div role="list" aria-label="Mailbox people" className="divide-y divide-kumo-line">
			{items.map((person) => {
				const selected = person.id === selectedId;
				const hasName = Boolean(person.displayName);
				const DirectionIcon = person.latestDirection === "received"
					? ArrowDownLeftIcon
					: ArrowUpRightIcon;
				return (
					<div key={person.id} role="listitem">
						<button
							id={`person-row-${person.id}`}
							type="button"
							onClick={() => onSelect(person.id)}
							aria-current={selected ? "true" : undefined}
							className={`group flex min-h-20 w-full min-w-0 items-start gap-3 border-s-2 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring sm:px-5 ${
								selected
									? "border-s-kumo-brand bg-kumo-fill"
									: "border-s-transparent hover:bg-kumo-tint"
							}`}
						>
							<span className="min-w-0 flex-1">
								<span className="flex min-w-0 items-baseline gap-2">
									<span className="truncate text-sm font-semibold text-kumo-default">
										{person.displayName ?? person.address}
									</span>
									<span className="ms-auto shrink-0 text-xs text-kumo-subtle">
										{formatListDate(person.lastInteractionAt)}
									</span>
								</span>
								<span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
									{hasName ? <span className="truncate">{person.address}</span> : null}
									{hasName ? <span aria-hidden="true">·</span> : null}
									<span className="truncate">{person.domain}</span>
									{person.nameProvenance === "imported" ? (
										<span className="shrink-0 text-kumo-warning">Imported name</span>
									) : null}
								</span>
								<span className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-kumo-strong">
									<span className="inline-flex items-center gap-1">
										<DirectionIcon size={14} aria-hidden="true" />
										{person.latestDirection === "received" ? "Received" : "Sent"}
									</span>
									<span aria-hidden="true">·</span>
									<span>{person.receivedCount} in</span>
									<span aria-hidden="true">·</span>
									<span>{person.sentCount} out</span>
								</span>
							</span>
						</button>
					</div>
				);
			})}
		</div>
	);
}
