// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState } from "react";
import { decodeBase64Url } from "../../../shared/base64url";
import { useAppConfig, useRegisterPushDevice } from "~/queries/push";

const SW_READY_TIMEOUT_MS = 10_000;

// navigator.serviceWorker.ready never rejects, so race it against a timeout.
async function waitForServiceWorkerReady(): Promise<ServiceWorkerRegistration | null> {
	if (!("serviceWorker" in navigator)) return null;
	return Promise.race([
		navigator.serviceWorker.ready,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)),
	]);
}

/**
 * Subscribe this device to Web Push for `mailboxId` (WISER-240). `enable()`
 * requests permission (must be called from a user gesture), waits for the SW,
 * subscribes with the env's VAPID key, and stores the subscription.
 */
export function usePushSubscription(mailboxId: string | undefined) {
	const { data: config } = useAppConfig();
	const register = useRegisterPushDevice(mailboxId);
	const [isSubscribing, setIsSubscribing] = useState(false);

	const pushSupported =
		typeof window !== "undefined" &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window;

	const vapidKey = config?.vapidPublicKey ?? null;
	const canSubscribe = pushSupported && !!vapidKey && !!mailboxId;

	async function enable(): Promise<boolean> {
		if (!canSubscribe || !vapidKey) return false;
		const applicationServerKey = decodeBase64Url(vapidKey);
		if (!applicationServerKey) return false;
		setIsSubscribing(true);
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") return false;

			const registration = await waitForServiceWorkerReady();
			if (!registration) return false;

			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey,
			});
			const json = subscription.toJSON();
			await register.mutateAsync({
				endpoint: json.endpoint ?? "",
				keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
			});
			return true;
		} catch (err) {
			console.error("[pwa] push subscribe failed", err);
			return false;
		} finally {
			setIsSubscribing(false);
		}
	}

	return { enable, canSubscribe, isSubscribing, pushSupported, hasVapidKey: !!vapidKey };
}
