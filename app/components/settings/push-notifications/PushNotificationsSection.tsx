// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { DeviceMobileIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { formatListDate } from "shared/dates";
import { usePushSubscription } from "~/hooks/pwa/usePushSubscription";
import { useAppConfig, useDeletePushDevice, usePushDevices } from "~/queries/push";
import { detectPwaInstallEnvironment } from "~/utils/pwa/detectPlatform";
import { Guidance } from "./Guidance";
import { InstallGuidance } from "./InstallGuidance";
import { NotificationCard } from "./NotificationCard";
import { derivePushSetupState } from "./push-setup-state";

type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
};

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
	return "prompt" in event && typeof event.prompt === "function";
}

function isStandaloneNavigator(value: Navigator): value is Navigator & { standalone: boolean } {
	return "standalone" in value;
}

function isStandalone(): boolean {
	if (typeof window === "undefined") return false;
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		(isStandaloneNavigator(navigator) && navigator.standalone === true)
	);
}

/** Install-first Web Push opt-in and registered-device management for one mailbox. */
export function PushNotificationsSection({ mailboxId }: { mailboxId: string | undefined }) {
	const toast = useKumoToastManager();
	const configQuery = useAppConfig();
	const hasVapidKey = !!configQuery.data?.vapidPublicKey;
	const devicesQuery = usePushDevices(mailboxId, hasVapidKey);
	const { enable, isSubscribing, pushSupported } = usePushSubscription(mailboxId);
	const deleteDevice = useDeletePushDevice(mailboxId);
	const [mounted, setMounted] = useState(false);
	const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

	useEffect(() => setMounted(true), []);
	useEffect(() => {
		function onPrompt(event: Event) {
			if (!isBeforeInstallPromptEvent(event)) return;
			event.preventDefault();
			setInstallPrompt(event);
		}
		window.addEventListener("beforeinstallprompt", onPrompt);
		return () => window.removeEventListener("beforeinstallprompt", onPrompt);
	}, []);

	const permission =
		typeof Notification === "undefined" ? "default" : Notification.permission;
	const setupState = derivePushSetupState({
		mounted,
		configLoading: configQuery.isLoading,
		hasQueryError: configQuery.isError || (hasVapidKey && devicesQuery.isError),
		hasVapidKey,
		installed: mounted && isStandalone(),
		pushSupported,
		permission,
	});

	async function handleEnable() {
		const enabled = await enable();
		toast.add(
			enabled
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

	async function handleRetry() {
		await Promise.all([configQuery.refetch(), devicesQuery.refetch()]);
	}

	if (setupState === "hidden") return null;
	if (setupState === "loading") {
		return (
			<NotificationCard>
				<div className="flex justify-center py-4">
					<Loader size="sm" />
				</div>
			</NotificationCard>
		);
	}

	if (setupState === "error") {
		return (
			<NotificationCard>
				<div role="alert" className="space-y-3">
					<p className="text-sm text-kumo-default">
						Notification settings could not be loaded. Check your connection and try again.
					</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={handleRetry}
						loading={configQuery.isFetching || devicesQuery.isFetching}
					>
						Retry
					</Button>
				</div>
			</NotificationCard>
		);
	}

	const devices = devicesQuery.data ?? [];
	const environment = detectPwaInstallEnvironment();
	return (
		<NotificationCard>
			<div className="space-y-4">
				<p className="text-xs text-kumo-subtle">
					Get a notification on this device when a new email arrives.
				</p>

				{devicesQuery.isLoading ? (
					<div className="flex justify-center py-2">
						<Loader size="sm" />
					</div>
				) : devices.length > 0 ? (
					<ul className="space-y-2">
						{devices.map((device) => (
							<li
								key={device.id}
								className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2"
							>
								<DeviceMobileIcon size={16} className="shrink-0 text-kumo-subtle" />
								<div className="min-w-0 flex-1">
									<div className="truncate text-sm text-kumo-default">
										{device.deviceLabel || "Unknown device"}
									</div>
									<div className="text-xs text-kumo-subtle">
										Last active {formatListDate(device.lastSeenAt)}
									</div>
								</div>
								<Button
									variant="ghost"
									size="xs"
									icon={<TrashIcon size={14} />}
									onClick={() => handleRemove(device.id)}
									loading={deleteDevice.isPending && deleteDevice.variables === device.id}
										aria-label={`Remove ${device.deviceLabel || "unknown device"}`}
								>
									Remove
								</Button>
							</li>
						))}
					</ul>
				) : null}

				{setupState === "blocked" ? (
					<p className="text-xs text-kumo-danger">
						Notifications are blocked for this app. Enable them in your device settings,
						then reopen the app.
					</p>
				) : setupState === "unsupported" ? (
					<Guidance title="Notifications unavailable">
						This installed app does not support push notifications on this device.
					</Guidance>
				) : setupState === "enable" ? (
					<Button variant="primary" size="sm" onClick={handleEnable} loading={isSubscribing}>
						{devices.length > 0 ? "Enable on this device" : "Enable notifications"}
					</Button>
				) : (
					<InstallGuidance
						environment={environment}
						installPromptAvailable={!!installPrompt}
						onInstall={handleInstall}
					/>
				)}
			</div>
		</NotificationCard>
	);
}
