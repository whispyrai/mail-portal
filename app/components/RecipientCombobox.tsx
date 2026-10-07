import { XIcon } from "@phosphor-icons/react";
import {
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type KeyboardEvent,
	type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import {
	isValidRecipientAddress,
	normalizedAddress,
	parseRecipientText,
	RECIPIENT_FIELDS,
	type RecipientField,
	type RecipientFieldValues,
} from "../../shared/recipient-addresses.ts";
import {
	applyRecipientComboboxKeyEvent,
	filterRecipientSuggestions,
	mergeRecipients,
	serializeRecipients,
	splitFinishedRecipients,
} from "../lib/recipient-input.ts";
import { useRecipientSuggestions } from "../queries/recipient-suggestions.ts";

const FIELD_LABELS: Record<RecipientField, string> = {
	to: "To",
	cc: "Cc",
	bcc: "Bcc",
};

export type RecipientComboboxProps = {
	id: string;
	label: string;
	field: RecipientField;
	mailboxId: string;
	/** Comma-separated addresses: the recipients this field already holds. */
	value: string;
	recipients: RecipientFieldValues;
	onChange: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	autoFocus?: boolean;
	required?: boolean;
	limit?: number;
	className?: string;
};

/**
 * One recipient field. Every finished address is a chip showing exactly what
 * will be sent, so a writer can see at a glance who gets the message. Typing
 * Enter, Tab, a comma, a semicolon or a space after a full address turns the
 * text into a chip, and so does leaving the field; pasted lists split into one
 * chip per address. Text that is not an address stays a chip too, marked for
 * fixing, so nothing typed is ever dropped silently.
 */
export default function RecipientCombobox({
	id,
	label,
	field,
	mailboxId,
	value,
	recipients,
	onChange,
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
	const problemId = `${id}-${generatedId}-problem`;
	const inputRef = useRef<HTMLInputElement>(null);
	const chips = useMemo(() => parseRecipientText(value), [value]);
	const invalidChips = chips.filter((address) => !isValidRecipientAddress(address));
	const [draft, setDraft] = useState("");
	const [focused, setFocused] = useState(false);
	const [selectedChip, setSelectedChip] = useState(-1);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [announcement, setAnnouncement] = useState("");
	// Said on screen, not only to screen readers: why an address did not appear.
	const [notice, setNotice] = useState("");
	const [dismissed, setDismissed] = useState(false);
	const token = draft.trim().toLowerCase();
	const query = useRecipientSuggestions(
		mailboxId,
		token,
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
	const ready = focused && query.ready && query.debouncedToken === token;
	const expanded =
		ready &&
		!disabled &&
		!dismissed &&
		(token.length > 0 || suggestions.length > 0);
	const activeSuggestion = activeIndex >= 0 ? suggestions[activeIndex] : undefined;
	// A half-typed name picks its best match on Enter. Once there is an "@" the
	// writer is typing an address, which is taken exactly as typed.
	const preselectsSuggestion = token.length > 0 && !token.includes("@");

	useEffect(() => {
		setActiveIndex(-1);
		setAnnouncement("");
		setDismissed(false);
		setDraft("");
		setNotice("");
		setSelectedChip(-1);
	}, [mailboxId, field]);

	useEffect(() => {
		setDismissed(false);
	}, [token]);

	useEffect(() => {
		if (!expanded || query.isFetching) {
			setActiveIndex(-1);
			return;
		}
		setActiveIndex(preselectsSuggestion && suggestions.length > 0 ? 0 : -1);
	}, [expanded, query.isFetching, preselectsSuggestion, suggestions.length, token]);

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

	function focusInput() {
		window.requestAnimationFrame(() => inputRef.current?.focus());
	}

	/**
	 * `flush` commits before the current event finishes, for the one path that
	 * sends in the same keystroke: Cmd/Ctrl+Enter reads the form right after.
	 */
	function addRecipients(text: string, flush = false) {
		setDraft("");
		setSelectedChip(-1);
		setActiveIndex(-1);
		// An address already in another field stays there: each address is
		// sent once, so a second chip would show a recipient the headers lack.
		const elsewhere = new Map<string, string>();
		for (const other of RECIPIENT_FIELDS) {
			if (other === field) continue;
			for (const address of parseRecipientText(recipients[other])) {
				elsewhere.set(normalizedAddress(address), FIELD_LABELS[other]);
			}
		}
		const additions = parseRecipientText(text);
		const duplicate = additions.find((address) =>
			elsewhere.has(normalizedAddress(address)),
		);
		const duplicateNotice = duplicate
			? `${duplicate} is already in ${elsewhere.get(normalizedAddress(duplicate))}.`
			: "";
		setNotice(duplicateNotice);
		const fresh = additions.filter(
			(address) => !elsewhere.has(normalizedAddress(address)),
		);
		if (fresh.length === 0) {
			if (duplicateNotice) setAnnouncement(duplicateNotice);
			return;
		}
		const next = mergeRecipients(chips, fresh);
		const apply = () => onChange(serializeRecipients(next));
		if (flush) flushSync(apply);
		else apply();
		setAnnouncement(
			next.length > chips.length
				? `${next.slice(chips.length).join(", ")} added to ${label}.`
				: `Already in ${label}.`,
		);
	}

	function removeChip(index: number) {
		const address = chips[index];
		if (address === undefined) return;
		onChange(serializeRecipients(chips.filter((_, position) => position !== index)));
		setSelectedChip(-1);
		setAnnouncement(`${address} removed from ${label}.`);
		focusInput();
	}

	function editChip(index: number) {
		const address = chips[index];
		if (address === undefined) return;
		const remaining = chips.filter((_, position) => position !== index);
		onChange(
			serializeRecipients(mergeRecipients(remaining, parseRecipientText(draft))),
		);
		setDraft(address);
		setSelectedChip(-1);
		setAnnouncement(`Editing ${address}.`);
		focusInput();
	}

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const text = event.target.value;
		setSelectedChip(-1);
		setNotice("");
		const { finished, pending } = splitFinishedRecipients(text);
		if (finished.trim()) {
			addRecipients(finished);
			setDraft(pending);
			return;
		}
		if (/\s$/.test(text) && isValidRecipientAddress(text.trim())) {
			addRecipients(text);
			return;
		}
		setDraft(text);
	}

	function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
		const pasted = event.clipboardData.getData("text/plain");
		const addresses = parseRecipientText(pasted);
		const isList = addresses.length > 1 || /[,;\r\n<]/.test(pasted);
		if (!isList && !(addresses.length === 1 && isValidRecipientAddress(addresses[0]!))) {
			return;
		}
		event.preventDefault();
		// Commit exactly what the field would hold after the paste, so pasting
		// over a selection replaces it rather than keeping it as a recipient.
		const input = event.currentTarget;
		const start = input.selectionStart ?? draft.length;
		const end = input.selectionEnd ?? start;
		addRecipients(`${draft.slice(0, start)}${pasted}${draft.slice(end)}`);
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.nativeEvent.isComposing) return;
		// Cmd/Ctrl+Enter always sends. It commits exactly what was typed, before
		// the send reads the form, and never quietly picks a suggestion instead.
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			if (draft.trim()) addRecipients(draft, true);
			return;
		}
		const action = applyRecipientComboboxKeyEvent(
			event,
			activeIndex,
			expanded ? suggestions.length : 0,
			expanded,
		);
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
		if (action.kind === "accept") {
			const selected = suggestions[action.index];
			if (selected) addRecipients(selected.address);
			return;
		}

		const input = event.currentTarget;
		const caretAtStart = input.selectionStart === 0 && input.selectionEnd === 0;
		switch (event.key) {
			case "Enter":
				// Never an implicit form submit: Enter finishes the address.
				event.preventDefault();
				if (draft.trim()) addRecipients(draft);
				return;
			case "Tab":
				if (draft.trim()) addRecipients(draft);
				return;
			case "Backspace":
			case "Delete":
				if (selectedChip >= 0) {
					event.preventDefault();
					removeChip(selectedChip);
				} else if (event.key === "Backspace" && caretAtStart && chips.length > 0) {
					// First press marks the last chip, the second removes it, so one
					// stray key never drops a recipient unnoticed.
					event.preventDefault();
					setSelectedChip(chips.length - 1);
					setAnnouncement(`${chips.at(-1)} selected. Press Backspace again to remove it.`);
				}
				return;
			case "ArrowLeft":
				if (selectedChip > 0 || (selectedChip < 0 && caretAtStart && chips.length > 0)) {
					event.preventDefault();
					const next = selectedChip < 0 ? chips.length - 1 : selectedChip - 1;
					setSelectedChip(next);
					setAnnouncement(`${chips[next]} selected.`);
				}
				return;
			case "ArrowRight":
				if (selectedChip >= 0) {
					event.preventDefault();
					const next = selectedChip + 1 < chips.length ? selectedChip + 1 : -1;
					setSelectedChip(next);
					if (next >= 0) setAnnouncement(`${chips[next]} selected.`);
				}
				return;
			case "Escape":
				if (selectedChip >= 0) {
					event.preventDefault();
					event.stopPropagation();
					setSelectedChip(-1);
				}
				return;
			default:
				if (selectedChip >= 0 && event.key.length === 1) setSelectedChip(-1);
		}
	}

	// Chip buttons keep focus in the input, so using them never commits or
	// loses what is being typed.
	const keepInputFocus = (event: MouseEvent) => event.preventDefault();

	return (
		<div className={`relative min-w-0 ${className}`}>
			<label
				htmlFor={id}
				className="mb-1.5 block text-xs font-medium text-kumo-default"
			>
				{label}
			</label>
			<div
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					inputRef.current?.focus();
				}}
				className={`flex min-h-11 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border bg-kumo-control px-2 py-1.5 focus-within:ring-2 focus-within:ring-kumo-ring ${invalidChips.length > 0 ? "border-kumo-danger" : "border-kumo-line"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
			>
				<div role="list" aria-label={`${label} recipients`} className="contents">
					{chips.map((address, index) => {
						const invalid = !isValidRecipientAddress(address);
						const selected = index === selectedChip;
						return (
							<span
								key={`${address}-${index}`}
								role="listitem"
								data-recipient-chip={address}
								data-invalid={invalid || undefined}
								className={`inline-flex min-h-8 max-w-full items-center gap-0.5 rounded-full border ps-2.5 pe-0.5 text-sm ${
									invalid
										? "border-kumo-danger bg-kumo-danger-tint text-kumo-danger"
										: "border-kumo-line bg-kumo-fill text-kumo-default"
								} ${selected ? "ring-2 ring-kumo-brand" : ""}`}
							>
								<button
									type="button"
									tabIndex={-1}
									disabled={disabled}
									onMouseDown={keepInputFocus}
									onClick={() => editChip(index)}
									title={invalid
										? `“${address}” is not a valid email address. Click to fix it.`
										: `${address} (click to edit)`}
									className="min-w-0 truncate text-start"
								>
									{invalid && <span className="sr-only">Invalid address: </span>}
									{address}
								</button>
								<button
									type="button"
									tabIndex={-1}
									disabled={disabled}
									onMouseDown={keepInputFocus}
									onClick={() => removeChip(index)}
									aria-label={`Remove ${address}`}
									className="flex size-7 shrink-0 items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-fill-hover hover:text-kumo-default"
								>
									<XIcon size={12} weight="bold" />
								</button>
							</span>
						);
					})}
				</div>
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
					aria-describedby={invalidChips.length > 0 ? `${statusId} ${problemId}` : statusId}
					aria-required={required || undefined}
					aria-invalid={invalidChips.length > 0 || undefined}
					value={draft}
					placeholder={chips.length === 0 ? placeholder : undefined}
					disabled={disabled}
					autoFocus={autoFocus}
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					inputMode="email"
					onChange={handleChange}
					onPaste={handlePaste}
					onFocus={() => {
						setFocused(true);
						setDismissed(false);
					}}
					onBlur={() => {
						if (draft.trim()) addRecipients(draft);
						setFocused(false);
						setActiveIndex(-1);
						setSelectedChip(-1);
					}}
					onKeyDown={handleKeyDown}
					// Narrow while idle so chips never leave an empty row behind them.
					className={`min-h-8 flex-1 bg-transparent px-1 text-sm text-kumo-default outline-none placeholder:text-kumo-subtle disabled:cursor-not-allowed ${
						focused || draft || chips.length === 0 ? "min-w-[8rem]" : "min-w-8"
					}`}
				/>
			</div>
			{notice && (
				<p role="status" aria-live="polite" className="mt-1 text-xs text-kumo-subtle">
					{notice}
				</p>
			)}
			{invalidChips.length > 0 && (
				<p id={problemId} className="mt-1 text-xs font-medium text-kumo-danger">
					{invalidChips.length === 1
						? `“${invalidChips[0]}” is not a valid email address. Click it to fix it.`
						: `${invalidChips.length} addresses are not valid. Click one to fix it.`}
				</p>
			)}

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
							onMouseDown={keepInputFocus}
							onMouseMove={() => setActiveIndex(index)}
							onClick={() => addRecipients(suggestion.address)}
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
