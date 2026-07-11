export type SnoozePreset = "later_today" | "tomorrow" | "next_week";

const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1_000;

export class SnoozeTimeError extends Error {
	constructor(message = "Choose a valid future date and time") {
		super(message);
		this.name = "SnoozeTimeError";
	}
}

function assertBounded(date: Date, now: Date): Date {
	const timestamp = date.getTime();
	if (
		!Number.isFinite(timestamp) ||
		timestamp < now.getTime() + MIN_DELAY_MS ||
		timestamp > now.getTime() + MAX_DELAY_MS
	) {
		throw new SnoozeTimeError();
	}
	return date;
}

function atLocalTime(date: Date, hour: number, minute = 0): Date {
	const result = new Date(date);
	result.setHours(hour, minute, 0, 0);
	return result;
}

export function snoozePresetTime(preset: SnoozePreset, now = new Date()): Date {
	if (preset === "later_today") {
		const today = atLocalTime(now, 18);
		if (today.getTime() >= now.getTime() + MIN_DELAY_MS) return today;
		const tomorrow = new Date(now);
		tomorrow.setDate(tomorrow.getDate() + 1);
		return assertBounded(atLocalTime(tomorrow, 8), now);
	}
	if (preset === "tomorrow") {
		const tomorrow = new Date(now);
		tomorrow.setDate(tomorrow.getDate() + 1);
		return assertBounded(atLocalTime(tomorrow, 8), now);
	}
	const nextMonday = new Date(now);
	const daysAhead = ((8 - nextMonday.getDay()) % 7) || 7;
	nextMonday.setDate(nextMonday.getDate() + daysAhead);
	return assertBounded(atLocalTime(nextMonday, 8), now);
}

export function customLocalSnoozeTime(value: string, now = new Date()): Date {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
	if (!match) throw new SnoozeTimeError();
	const [, year, month, day, hour, minute] = match.map(Number);
	const result = new Date(year, month - 1, day, hour, minute, 0, 0);
	if (
		result.getFullYear() !== year ||
		result.getMonth() !== month - 1 ||
		result.getDate() !== day ||
		result.getHours() !== hour ||
		result.getMinutes() !== minute
	) {
		throw new SnoozeTimeError();
	}
	return assertBounded(result, now);
}
