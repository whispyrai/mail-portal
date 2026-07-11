import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatDateTimeLocalValue,
  getSendLaterPresets,
  parseAndValidateLocalSchedule,
  validateScheduledDate,
} from "./send-later.ts";

test("presets use local calendar dates and omit an elapsed later-today slot", () => {
  const fridayMorning = new Date(2026, 6, 10, 10, 15);
  const presets = getSendLaterPresets(fridayMorning);

  assert.deepEqual(
    presets.map((preset) => preset.id),
    ["later-today", "tomorrow-morning", "next-monday-morning"],
  );
  assert.deepEqual(
    presets.map(({ date }) => [
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
    ]),
    [
      [2026, 6, 10, 17, 0],
      [2026, 6, 11, 9, 0],
      [2026, 6, 13, 9, 0],
    ],
  );

  const fridayEvening = new Date(2026, 6, 10, 18, 0);
  assert.deepEqual(
    getSendLaterPresets(fridayEvening).map((preset) => preset.id),
    ["tomorrow-morning", "next-monday-morning"],
  );
});

test("custom local values round-trip through Date and reject invalid, past, and distant times", () => {
  const now = new Date(2026, 0, 15, 12, 0);
  const valid = parseAndValidateLocalSchedule("2026-01-16T09:30", now);
  assert.equal(valid.ok, true);
  if (valid.ok) {
    const parsed = new Date(valid.iso);
    assert.deepEqual(
      [
        parsed.getFullYear(),
        parsed.getMonth(),
        parsed.getDate(),
        parsed.getHours(),
        parsed.getMinutes(),
      ],
      [2026, 0, 16, 9, 30],
    );
  }

  assert.deepEqual(parseAndValidateLocalSchedule("2026-02-30T09:00", now), {
    ok: false,
    error: "Choose a valid local date and time.",
  });
	assert.deepEqual(parseAndValidateLocalSchedule("2026-01-15T11:59", now), {
		ok: false,
		error: "Choose a time at least one minute in the future.",
  });
  assert.deepEqual(parseAndValidateLocalSchedule("2027-01-16T12:00", now), {
    ok: false,
    error: "Choose a time within the next year.",
  });
});

test("datetime-local formatting uses local components rather than slicing UTC strings", () => {
  const local = new Date(2026, 10, 5, 7, 4);
  assert.equal(formatDateTimeLocalValue(local), "2026-11-05T07:04");

  const source = readFileSync(
    new URL("./send-later.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /toISOString\(\)\.slice/);
  assert.doesNotMatch(source, /new Date\(value\)/);
});

test("a previously selected preset is revalidated at submission time", () => {
  const selected = new Date(2026, 0, 15, 17, 0);
	assert.deepEqual(
		validateScheduledDate(selected, new Date(2026, 0, 15, 17, 1)),
		{
			ok: false,
			error: "Choose a time at least one minute in the future.",
		},
	);
});
