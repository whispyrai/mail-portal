// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";

const pushKeys = {
	config: ["config"] as const,
	devices: (mailboxId: string) => ["push", "devices", mailboxId] as const,
};

/** App config (domains, addresses, VAPID public key). Static per deploy. */
export function useAppConfig() {
	return useQuery({
		queryKey: pushKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function usePushDevices(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId ? pushKeys.devices(mailboxId) : ["push", "devices", "_disabled"],
		queryFn: () => api.listPushSubscriptions(mailboxId!).then((r) => r.subscriptions),
		enabled: !!mailboxId,
	});
}

export function useRegisterPushDevice(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
			api.registerPushSubscription(mailboxId!, sub),
		onSuccess: () => {
			if (mailboxId) qc.invalidateQueries({ queryKey: pushKeys.devices(mailboxId) });
		},
	});
}

export function useDeletePushDevice(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deletePushSubscription(mailboxId!, id),
		onSuccess: () => {
			if (mailboxId) qc.invalidateQueries({ queryKey: pushKeys.devices(mailboxId) });
		},
	});
}
