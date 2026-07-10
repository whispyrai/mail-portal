// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

/** App config (domains, addresses, VAPID public key). Static per deploy. */
export function useAppConfig() {
	return useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function usePushDevices(mailboxId: string | undefined, pushConfigured = true) {
	return useQuery({
		queryKey: queryKeys.push.devices(mailboxId),
		queryFn: () => {
			if (!mailboxId) throw new Error("A mailbox is required to list push devices");
			return api.listPushSubscriptions(mailboxId).then((response) => response.subscriptions);
		},
		enabled: !!mailboxId && pushConfigured,
	});
}

export function useRegisterPushDevice(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => {
			if (!mailboxId) throw new Error("A mailbox is required to register a push device");
			return api.registerPushSubscription(mailboxId, sub);
		},
		onSuccess: () => {
			if (mailboxId) qc.invalidateQueries({ queryKey: queryKeys.push.devices(mailboxId) });
		},
	});
}

export function useDeletePushDevice(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => {
			if (!mailboxId) throw new Error("A mailbox is required to remove a push device");
			return api.deletePushSubscription(mailboxId, id);
		},
		onSuccess: () => {
			if (mailboxId) qc.invalidateQueries({ queryKey: queryKeys.push.devices(mailboxId) });
		},
	});
}
