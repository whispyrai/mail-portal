import {
	MIN_SCHEDULE_LEAD_MS,
	outboundScheduleHorizon,
} from "../../shared/outbound-schedule.ts";

export const SEND_LATER_HOUR = 17;
export const MORNING_HOUR = 9;

export type SendLaterPreset = {
  id: "later-today" | "tomorrow-morning" | "next-monday-morning";
  title: string;
  date: Date;
};

function atLocalTime(source: Date, hour: number, daysToAdd = 0): Date {
  const result = new Date(source);
  result.setDate(result.getDate() + daysToAdd);
  result.setHours(hour, 0, 0, 0);
  return result;
}

export function getSendLaterPresets(now = new Date()): SendLaterPreset[] {
  const presets: SendLaterPreset[] = [];
  const laterToday = atLocalTime(now, SEND_LATER_HOUR);
  if (laterToday.getTime() > now.getTime()) {
    presets.push({
      id: "later-today",
      title: "Later today",
      date: laterToday,
    });
  }

  presets.push({
    id: "tomorrow-morning",
    title: "Tomorrow morning",
    date: atLocalTime(now, MORNING_HOUR, 1),
  });

  const daysUntilNextMonday = (8 - now.getDay()) % 7 || 7;
  presets.push({
    id: "next-monday-morning",
    title: "Next Monday morning",
    date: atLocalTime(now, MORNING_HOUR, daysUntilNextMonday),
  });
  return presets;
}

export function scheduleHorizonEnd(now = new Date()): Date {
	return outboundScheduleHorizon(now);
}

export function earliestScheduleTime(now = new Date()): Date {
	const minimum = now.getTime() + MIN_SCHEDULE_LEAD_MS;
	const nextMinute = new Date(minimum);
	nextMinute.setSeconds(0, 0);
	if (nextMinute.getTime() < minimum) {
		nextMinute.setMinutes(nextMinute.getMinutes() + 1);
	}
  return nextMinute;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDateTimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatScheduledTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export type ScheduleValidation =
  | { ok: true; iso: string; date: Date }
  | { ok: false; error: string };

export type ScheduledDateValidation =
  | { ok: true; date: Date }
  | { ok: false; error: string };

export function validateScheduledDate(
  date: Date,
  now = new Date(),
): ScheduledDateValidation {
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: "Choose a valid local date and time." };
  }
	if (date.getTime() - now.getTime() < MIN_SCHEDULE_LEAD_MS) {
		return { ok: false, error: "Choose a time at least one minute in the future." };
  }
  if (date.getTime() > scheduleHorizonEnd(now).getTime()) {
    return { ok: false, error: "Choose a time within the next year." };
  }
  return { ok: true, date };
}

export function parseAndValidateLocalSchedule(
  value: string,
  now = new Date(),
): ScheduleValidation {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match)
    return { ok: false, error: "Choose a valid local date and time." };

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText) - 1;
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(hour, minute, 0, 0);

  // Date normalizes impossible calendar and DST values. Require every local
  // component to survive so a nonexistent wall-clock time cannot be shifted.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return { ok: false, error: "Choose a valid local date and time." };
  }
  const validation = validateScheduledDate(date, now);
  if (!validation.ok) return validation;
  return { ok: true, iso: date.toISOString(), date };
}
