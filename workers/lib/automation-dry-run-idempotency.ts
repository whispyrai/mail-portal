async function sha256(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function automationDryRunTestId(input: {
	mailboxId: string;
	actorId: string;
	operationId: string;
}): Promise<string> {
	const digest = await sha256([
		"automation-dry-run-operation",
		1,
		input.mailboxId.toLowerCase(),
		input.actorId,
		input.operationId,
	]);
	return `test_operation_${digest}`;
}
