import {
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type KeyboardEvent,
} from "react";
import {
	activeRecipientSegment,
	applyRecipientComboboxKeyEvent,
	filterRecipientSuggestions,
	replaceActiveRecipientSegmentWithCursor,
	type RecipientField,
	type RecipientFieldValues,
} from "../lib/recipient-input.ts";
import { useRecipientSuggestions } from "../queries/recipient-suggestions.ts";

export type RecipientComboboxProps = {
	id: string;
	label: string;
	field: RecipientField;
	mailboxId: string;
	value: string;
	recipients: RecipientFieldValues;
	onChange: (value: string) => void;
	onBlur?: () => void;
	placeholder?: string;
	disabled?: boolean;
	autoFocus?: boolean;
	required?: boolean;
	limit?: number;
	className?: string;
};

export default function RecipientCombobox({
	id,
	label,
	field,
	mailboxId,
	value,
	recipients,
	onChange,
	onBlur,
	placeholder,
	disabled,
	autoFocus,
	required,
	limit = 10,
	className = "",
}: RecipientComboboxProps) {
	const generatedId = useId().replace(/:/g, "");
	const listboxId = `${id}-${generatedId}-suggestions`;
	const statusId = `${id}-${generatedId}-status`;
	const inputRef = useRef<HTMLInputElement>(null);
	const [focused, setFocused] = useState(false);
	const [cursor, setCursor] = useState(value.length);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [announcement, setAnnouncement] = useState("");
	const [dismissed, setDismissed] = useState(false);
	const segment = useMemo(
		() => activeRecipientSegment(value, cursor),
		[value, cursor],
	);
	const query = useRecipientSuggestions(
		mailboxId,
		segment.token,
		focused,
		limit,
		`${mailboxId}:${field}`,
	);
	const suggestions = useMemo(
		() => filterRecipientSuggestions(query.data ?? [], {
			...recipients,
			mailboxAddress: mailboxId,
		}),
		[query.data, recipients, mailboxId],
	);
	const ready = focused && query.ready && query.debouncedToken === segment.token;
	const expanded = ready && !disabled && !dismissed;
	const activeSuggestion = activeIndex >= 0 ? suggestions[activeIndex] : undefined;

	useEffect(() => {
		setActiveIndex(-1);
		setAnnouncement("");
		setDismissed(false);
	}, [mailboxId, field]);

	useEffect(() => {
		setActiveIndex(-1);
		setDismissed(false);
	}, [segment.token]);

	useEffect(() => {
		if (query.isFetching) setActiveIndex(-1);
	}, [query.isFetching]);

	useEffect(() => {
		if (!expanded || query.isFetching) return;
		if (query.isError) {
			setAnnouncement("Recipient suggestions could not be loaded.");
		} else if (suggestions.length === 0) {
			setAnnouncement("No matching recipients.");
		} else {
			setAnnouncement(
				`${suggestions.length} recipient suggestion${suggestions.length === 1 ? "" : "s"} available.`,
			);
		}
	}, [expanded, query.isFetching, query.isError, suggestions.length]);

	function accept(address: string, restoreFocus = true) {
		const replacement = replaceActiveRecipientSegmentWithCursor(
			value,
			cursor,
			address,
		);
		onChange(replacement.value);
		setCursor(replacement.cursor);
		setActiveIndex(-1);
		setAnnouncement(`${address} selected.`);
		if (!restoreFocus) return;
		window.requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(
				replacement.cursor,
				replacement.cursor,
			);
		});
	}

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		onChange(event.target.value);
		setCursor(event.target.selectionStart ?? event.target.value.length);
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		const action = applyRecipientComboboxKeyEvent(
			event,
			activeIndex,
			expanded ? suggestions.length : 0,
			expanded,
		);
		if (action.kind === "ignored") return;
		if (action.kind === "close") {
			setDismissed(true);
			setActiveIndex(-1);
			setAnnouncement("Recipient suggestions closed.");
			return;
		}
		if (action.kind === "move") {
			setActiveIndex(action.index);
			setAnnouncement(`${suggestions[action.index]?.address ?? ""}, option ${action.index + 1} of ${suggestions.length}.`);
			return;
		}
		const selected = suggestions[action.index];
		if (selected) {
			accept(selected.address, event.key !== "Tab");
		}
	}

	return (
		<div className={`relative min-w-0 ${className}`}>
			<label
				htmlFor={id}
				className="mb-1.5 block text-xs font-medium text-kumo-default"
			>
				{label}
			</label>
			<input
				ref={inputRef}
				id={id}
				type="text"
				role="combobox"
				aria-label={label}
				aria-autocomplete="list"
				aria-controls={listboxId}
				aria-expanded={expanded}
				aria-activedescendant={activeSuggestion ? `${listboxId}-option-${activeIndex}` : undefined}
				aria-describedby={statusId}
				value={value}
				placeholder={placeholder}
				disabled={disabled}
				autoFocus={autoFocus}
				required={required}
				onChange={handleChange}
				onSelect={(event) => setCursor(event.currentTarget.selectionStart ?? value.length)}
				onFocus={(event) => {
					setCursor(event.currentTarget.selectionStart ?? value.length);
					setFocused(true);
					setDismissed(false);
				}}
				onBlur={() => {
					setFocused(false);
					setActiveIndex(-1);
					onBlur?.();
				}}
				onKeyDown={handleKeyDown}
				className="min-h-11 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-sm text-kumo-default outline-none placeholder:text-kumo-subtle focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-50"
			/>

			{expanded && (
				<div
					id={listboxId}
					role="listbox"
					aria-label={`${label} suggestions`}
					className="absolute inset-x-0 z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-elevated p-1 shadow-lg"
				>
					{query.isFetching ? (
						<p role="status" className="flex min-h-11 items-center px-3 text-sm text-kumo-subtle">Finding recipients…</p>
					) : query.isError ? (
						<p role="status" className="flex min-h-11 items-center px-3 text-sm text-kumo-danger">Suggestions unavailable. Keep typing an address.</p>
					) : suggestions.length === 0 ? (
						<p role="status" className="flex min-h-11 items-center px-3 text-sm text-kumo-subtle">No matching recipients. Keep typing an address.</p>
					) : suggestions.map((suggestion, index) => (
						<button
							key={suggestion.address}
							id={`${listboxId}-option-${index}`}
							type="button"
							role="option"
							aria-selected={index === activeIndex}
							tabIndex={-1}
							onMouseDown={(event) => event.preventDefault()}
							onMouseMove={() => setActiveIndex(index)}
							onClick={() => accept(suggestion.address)}
							className={`flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm font-medium text-kumo-default ${index === activeIndex ? "bg-kumo-fill" : "hover:bg-kumo-tint"}`}
						>
							{suggestion.address}
						</button>
					))}
				</div>
			)}
			<p id={statusId} className="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{announcement}
			</p>
		</div>
	);
}
