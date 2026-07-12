export type TodayBriefDayBoundary = {
	timeZone: string;
	localDate: string;
	startAt: string;
	endAt: string;
};

type DateTimeParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

const MAX_TIME_ZONE_CHARS = 100;

function formatter(timeZone: string) {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
}

function dateTimeParts(value: Date, timeZone: string): DateTimeParts {
	const values = new Map(
		formatter(timeZone)
			.formatToParts(value)
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, Number(part.value)]),
	);
	const parts = {
		year: values.get("year") ?? Number.NaN,
		month: values.get("month") ?? Number.NaN,
		day: values.get("day") ?? Number.NaN,
		hour: values.get("hour") ?? Number.NaN,
		minute: values.get("minute") ?? Number.NaN,
		second: values.get("second") ?? Number.NaN,
	};
	if (Object.values(parts).some((part) => !Number.isInteger(part))) {
		throw new Error("Time zone could not be resolved");
	}
	return parts;
}

function asUtc(parts: DateTimeParts): number {
	return Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
}

function localDateTimeToInstant(
	target: DateTimeParts,
	timeZone: string,
): number {
	const targetAsUtc = asUtc(target);
	let guess = targetAsUtc;
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const represented = asUtc(dateTimeParts(new Date(guess), timeZone));
		const adjustment = targetAsUtc - represented;
		if (adjustment === 0) return guess;
		guess += adjustment;
	}
	const resolved = dateTimeParts(new Date(guess), timeZone);
	if (asUtc(resolved) !== targetAsUtc) {
		throw new Error("Local day boundary could not be resolved");
	}
	return guess;
}

function localDate(parts: Pick<DateTimeParts, "year" | "month" | "day">) {
	return `${parts.year.toString().padStart(4, "0")}-${parts.month
		.toString()
		.padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function resolveTodayBriefDay(
	rawTimeZone: string,
	now = Date.now(),
): TodayBriefDayBoundary {
	const timeZone = rawTimeZone.trim();
	if (
		!timeZone ||
		timeZone.length > MAX_TIME_ZONE_CHARS ||
		!Number.isFinite(now)
	) {
		throw new Error("A valid time zone is required");
	}
	try {
		formatter(timeZone).format(new Date(now));
	} catch {
		throw new Error("A valid time zone is required");
	}

	const current = dateTimeParts(new Date(now), timeZone);
	const currentDay = new Date(Date.UTC(current.year, current.month - 1, current.day));
	const nextDay = new Date(currentDay);
	nextDay.setUTCDate(nextDay.getUTCDate() + 1);
	const start = localDateTimeToInstant(
		{
			year: current.year,
			month: current.month,
			day: current.day,
			hour: 0,
			minute: 0,
			second: 0,
		},
		timeZone,
	);
	const end = localDateTimeToInstant(
		{
			year: nextDay.getUTCFullYear(),
			month: nextDay.getUTCMonth() + 1,
			day: nextDay.getUTCDate(),
			hour: 0,
			minute: 0,
			second: 0,
		},
		timeZone,
	);
	if (!(start <= now && now < end) || end - start < 20 * 60 * 60 * 1_000 || end - start > 28 * 60 * 60 * 1_000) {
		throw new Error("Local day boundary could not be resolved");
	}
	return {
		timeZone,
		localDate: localDate(current),
		startAt: new Date(start).toISOString(),
		endAt: new Date(end).toISOString(),
	};
}
