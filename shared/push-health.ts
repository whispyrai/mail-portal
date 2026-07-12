export const PUSH_HEALTH_STATES = [
	"not_configured",
	"no_devices",
	"healthy",
	"retrying",
	"degraded",
] as const;

export const PUSH_DEVICE_HEALTH_STATES = [
	"never_attempted",
	"accepted",
	"temporary_issue",
	"reenable_required",
] as const;

export type PushHealthState = (typeof PUSH_HEALTH_STATES)[number];
export type PushDeviceHealthState = (typeof PUSH_DEVICE_HEALTH_STATES)[number];

export interface PushDeviceHealth {
	id: string;
	label: string;
	registeredAt: string;
	lastAttemptAt: string | null;
	lastAcceptedAt: string | null;
	health: PushDeviceHealthState;
	consecutiveFailures: number;
}

export interface PushHealthResponse {
	state: PushHealthState;
	pendingCount: number;
	refreshedAt: string;
	devices: PushDeviceHealth[];
}

export class PushHealthContractError extends Error {
	constructor() {
		super("Push health response is invalid");
		this.name = "PushHealthContractError";
	}
}

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function invalid(): never {
	throw new PushHealthContractError();
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid();
	}
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
		invalid();
	}
}

function requiredDate(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 64 ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) invalid();
	return value;
}

function optionalDate(value: unknown): string | null {
	return value === null ? null : requiredDate(value);
}

function count(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) {
		invalid();
	}
	return Number(value);
}

export function validatePushHealthResponse(value: unknown): PushHealthResponse {
	const root = record(value);
	exact(root, ["state", "pendingCount", "refreshedAt", "devices"]);
	if (!PUSH_HEALTH_STATES.includes(root.state as PushHealthState)) {
		invalid();
	}
	if (!Array.isArray(root.devices) || root.devices.length > 50) {
		invalid();
	}
	const seen = new Set<string>();
	const devices = root.devices.map((candidate): PushDeviceHealth => {
		const device = record(candidate);
		exact(device, [
			"id",
			"label",
			"registeredAt",
			"lastAttemptAt",
			"lastAcceptedAt",
			"health",
			"consecutiveFailures",
		]);
		if (
			typeof device.id !== "string" ||
			device.id.length < 1 ||
			device.id.length > 200 ||
			device.id.trim() !== device.id ||
			UNSAFE_TEXT.test(device.id) ||
			seen.has(device.id) ||
			typeof device.label !== "string" ||
			device.label.length < 1 ||
			device.label.length > 100 ||
			device.label.trim() !== device.label ||
			device.label.normalize("NFC") !== device.label ||
			UNSAFE_TEXT.test(device.label) ||
			!PUSH_DEVICE_HEALTH_STATES.includes(device.health as PushDeviceHealthState)
		) invalid();
		seen.add(device.id);
		return {
			id: device.id,
			label: device.label,
			registeredAt: requiredDate(device.registeredAt),
			lastAttemptAt: optionalDate(device.lastAttemptAt),
			lastAcceptedAt: optionalDate(device.lastAcceptedAt),
			health: device.health as PushDeviceHealthState,
			consecutiveFailures: count(device.consecutiveFailures),
		};
	});
	for (let index = 1; index < devices.length; index += 1) {
		const previous = devices[index - 1]!;
		const current = devices[index]!;
		if (
			previous.registeredAt < current.registeredAt ||
			(previous.registeredAt === current.registeredAt && previous.id > current.id)
		) invalid();
	}
	const state = root.state as PushHealthState;
	const pendingCount = count(root.pendingCount);
	if (
		(state === "no_devices" && (devices.length !== 0 || pendingCount !== 0)) ||
		(state === "healthy" && (devices.length === 0 || pendingCount !== 0)) ||
		(state === "retrying" && (devices.length === 0 || pendingCount === 0)) ||
		(state === "degraded" && devices.length === 0) ||
		(state === "not_configured" && pendingCount !== 0)
	) invalid();
	return {
		state,
		pendingCount,
		refreshedAt: requiredDate(root.refreshedAt),
		devices,
	};
}
