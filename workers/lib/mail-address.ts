// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Normalize the mailbox identifiers this application supports. */
export function normalizeMailAddress(value: string): string | null {
	const address = value.trim().toLowerCase();
	const at = address.indexOf("@");
	if (
		at <= 0 ||
		at !== address.lastIndexOf("@") ||
		at === address.length - 1 ||
		/\s/.test(address)
	) {
		return null;
	}
	return address;
}

/** True only when the address domain exactly matches one declared DOMAINS entry. */
export function isAddressInConfiguredMailDomains(
	value: string,
	domainsVar: string | undefined,
): boolean {
	const address = normalizeMailAddress(value);
	if (!address) return false;
	const domain = address.slice(address.lastIndexOf("@") + 1);
	return (domainsVar ?? "")
		.split(",")
		.map((configuredDomain) => configuredDomain.trim().toLowerCase())
		.filter(Boolean)
		.includes(domain);
}
