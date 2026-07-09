// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader, useKumoToastManager } from "@cloudflare/kumo";
import {
	BellIcon,
	DeviceMobileIcon,
	ShareNetworkIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { formatListDate } from "shared/dates";
import { usePushSubscription } from "~/hooks/pwa/usePushSubscription";
import { useAppConfig, useDeletePushDevice, usePushDevices } from "~/queries/push";
import {
	detectPwaInstallEnvironment,
	type PwaInstallEnvironment,
} from "~/utils/pwa/detectPlatform";

// Chrome/Edge fire this so we can trigger the native install prompt. Not in
// lib.dom; declare the shape we use.
interface BeforeInstallPromptEvent extends Event {
	prompt: () => Promise<void>;
}

// Home-screen / installed PWA runs in standalone display mode. iOS also exposes
// the legacy navigator.standalone.
function isStandalone(): boolean {
	if (typeof window === "undefined") return false;
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		(navigator as unknown as { standalone?: boolean }).standalone === true
	);
}

/**
 * Web Push opt-in for this mailbox (WISER-240). Hidden entirely when the
 * environment has no VAPID key configured. Otherwise walks the user through the
 * platform-gated path: iOS must install via Safari before it can subscribe;
 * Android/desktop can subscribe in-browser.
 */
export function PushNotificationsSection({ mailboxId }: { mailboxId: string | undefined }) {
	const toast = useKumoToastManager();
	const { data: config, isLoading: configLoading } = useAppConfig();
	const { data: devices, isLoading: devicesLoading } = usePushDevices(mailboxId);
	const { enable, isSubscribing, pushSupported } = usePushSubscription(mailboxId);
	const deleteDevice = useDeletePushDevice(mailboxId);

	// Detection touches navigator/matchMedia, so only after mount — a stable
	// placeholder renders on the server to avoid a hydration mismatch.
	const [mounted, setMounted] = useState(false);
	const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

	useEffect(() => setMounted(true), []);
	useEffect(() => {
		function onPrompt(e: Event) {
			e.preventDefault();
			setInstallPrompt(e as BeforeInstallPromptEvent);
		}
		window.addEventListener("beforeinstallprompt", onPrompt);
		return () => window.removeEventListener("beforeinstallprompt", onPrompt);
	}, []);

	const card = (children: React.ReactNode) => (
		<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="flex items-center gap-2 mb-4">
				<BellIcon size={16} weight="duotone" className="text-kumo-subtle" />
				<span className="text-sm font-medium text-kumo-default">Notifications</span>
			</div>
			{children}
		</div>
	);

	if (!mounted || configLoading) {
		return card(
			<div className="flex justify-center py-4">
				<Loader size="sm" />
			</div>,
		);
	}

	// Push not configured for this deploy — nothing to offer.
	if (!config?.vapidPublicKey) return null;

	const env = detectPwaInstallEnvironment();
	const installed = isStandalone();
	const permission =
		typeof Notification !== "undefined" ? Notification.permission : "default";
	// iOS only delivers push to an installed (standalone) PWA; other platforms
	// can subscribe straight from the browser.
	const canEnableHere = pushSupported && (env.platform !== "ios" || installed);

	async function handleEnable() {
		const ok = await enable();
		toast.add(
			ok
				? { title: "Notifications enabled on this device" }
				: {
						title: "Couldn't enable notifications",
						description: "Check that notifications are allowed, then try again.",
						variant: "error",
					},
		);
	}

	async function handleRemove(id: string) {
		try {
			await deleteDevice.mutateAsync(id);
			toast.add({ title: "Device removed" });
		} catch {
			toast.add({ title: "Couldn't remove device", variant: "error" });
		}
	}

	async function handleInstall() {
		if (!installPrompt) return;
		await installPrompt.prompt();
		setInstallPrompt(null);
	}

	return card(
		<div className="space-y-4">
			<p className="text-xs text-kumo-subtle">
				Get a notification on this device when a new email arrives.
			</p>

			{/* Registered devices */}
			{devicesLoading ? (
				<div className="flex justify-center py-2">
					<Loader size="sm" />
				</div>
			) : devices && devices.length > 0 ? (
				<ul className="space-y-2">
					{devices.map((d) => (
						<li
							key={d.id}
							className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2"
						>
							<DeviceMobileIcon size={16} className="shrink-0 text-kumo-subtle" />
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm text-kumo-default">
									{d.deviceLabel || "Unknown device"}
								</div>
								<div className="text-xs text-kumo-subtle">
									Last active {formatListDate(d.lastSeenAt)}
								</div>
							</div>
							<Button
								variant="ghost"
								size="xs"
								icon={<TrashIcon size={14} />}
								onClick={() => handleRemove(d.id)}
								loading={deleteDevice.isPending && deleteDevice.variables === d.id}
								aria-label="Remove device"
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			) : null}

			{/* Enable on this device / install guidance */}
			{permission === "denied" ? (
				<p className="text-xs text-kumo-danger">
					Notifications are blocked for this site. Enable them in your browser
					settings, then reload.
				</p>
			) : canEnableHere ? (
				<Button variant="primary" size="sm" onClick={handleEnable} loading={isSubscribing}>
					{devices && devices.length > 0
						? "Enable on this device"
						: "Enable notifications"}
				</Button>
			) : (
				<InstallGuidance env={env} installPrompt={!!installPrompt} onInstall={handleInstall} />
			)}
		</div>,
	);
}

// Platform-specific steps to get an installable, push-capable app. Shown only
// when this device can't subscribe from where it is (iOS not yet installed, or
// a browser that must first install the PWA).
function InstallGuidance({
	env,
	installPrompt,
	onInstall,
}: {
	env: PwaInstallEnvironment;
	installPrompt: boolean;
	onInstall: () => void;
}) {
	if (env.platform === "ios") {
		if (env.browser !== "safari") {
			return (
				<Guidance title="Open in Safari to continue">
					On iPhone and iPad, notifications need the app installed from Safari.
					Open this page in Safari, then follow the steps to add it to your Home
					Screen.
				</Guidance>
			);
		}
		return (
			<Guidance title="Install to enable notifications">
				<ol className="mt-1 list-decimal space-y-1 pl-4">
					<li className="flex items-center gap-1">
						Tap the Share button
						<ShareNetworkIcon size={14} className="inline text-kumo-subtle" />
					</li>
					<li>Choose "Add to Home Screen"</li>
					<li>Open the app from your Home Screen, then return here to enable</li>
				</ol>
			</Guidance>
		);
	}

	if (env.platform === "android") {
		if (env.browser !== "chrome") {
			return (
				<Guidance title="Open in Chrome to continue">
					On Android, install the app from Chrome to enable notifications.
				</Guidance>
			);
		}
		if (installPrompt) {
			return (
				<div>
					<Button variant="primary" size="sm" onClick={onInstall}>
						Install app
					</Button>
				</div>
			);
		}
		return (
			<Guidance title="Install to enable notifications">
				Open the browser menu and choose "Install app" (or "Add to Home
				screen"), then reopen the app to enable notifications.
			</Guidance>
		);
	}

	// Desktop that can't subscribe (older / unsupported browser).
	return (
		<Guidance title="Notifications unavailable">
			This browser doesn't support push notifications. Try Chrome, Edge, or
			Firefox.
		</Guidance>
	);
}

function Guidance({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2.5">
			<div className="text-sm font-medium text-kumo-default">{title}</div>
			<div className="mt-0.5 text-xs text-kumo-subtle">{children}</div>
		</div>
	);
}
