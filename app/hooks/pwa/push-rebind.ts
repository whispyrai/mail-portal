export type PushRegistrationPayload = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
};

type ExistingPushSubscription = {
	toJSON(): {
		endpoint?: string;
		keys?: { p256dh?: string; auth?: string };
	};
};

type PushRegistration = {
	pushManager: {
		getSubscription(): Promise<ExistingPushSubscription | null>;
	};
};

/**
 * Re-associate a browser-held Web Push capability with the current live user.
 * This never requests notification permission or creates a new subscription.
 */
export async function rebindExistingPushSubscription(
	registration: PushRegistration,
	register: (payload: PushRegistrationPayload) => Promise<unknown>,
): Promise<"rebound" | "skipped"> {
	const subscription = await registration.pushManager.getSubscription();
	if (!subscription) return "skipped";
	const json = subscription.toJSON();
	const endpoint = json.endpoint ?? "";
	const p256dh = json.keys?.p256dh ?? "";
	const auth = json.keys?.auth ?? "";
	if (!endpoint || !p256dh || !auth) return "skipped";
	await register({ endpoint, keys: { p256dh, auth } });
	return "rebound";
}
