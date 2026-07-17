import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const recoveryPath = "docs/credential-recovery-rollout-runbook.md";
const wiserPath = "docs/wiser-go-live-runbook.md";

function bashBlockContaining(document, marker) {
	const blocks = [...document.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(
		(match) => match[1],
	);
	const block = blocks.find((candidate) => candidate.includes(marker));
	assert.ok(block, `missing bash block containing ${marker}`);
	return block;
}

function isolatedPromptFunction(block) {
	const start = block.indexOf("create_private_secrets_envelope() (");
	const end = block.indexOf("\n)\n\n# The operator shell starts clean.", start);
	assert.ok(start >= 0 && end > start, "missing isolated prompt function");
	return block.slice(start, end + 2);
}

function parentCleanupFunctions(block) {
	const start = block.indexOf("cleanup_secrets_file() {");
	const end = block.indexOf("\ncreate_private_secrets_envelope() (", start);
	assert.ok(start >= 0 && end > start, "missing parent cleanup functions");
	return block.slice(start, end);
}

const requiredSecretArray = `REQUIRED_SECRET_NAMES=(
ACCOUNT_RECOVERY_DIRECTORY
ADMIN_BOOTSTRAP_EMAIL
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1
JWT_SECRET
SES_EVENT_WEBHOOK_SECRET
VAPID_PRIVATE_KEY
VAPID_PUBLIC_KEY
)`;

test("recovery rollout keeps exact-size workerd proof ahead of every dry-run", async () => {
	const recovery = await readFile(recoveryPath, "utf8");
	const wiser = await readFile(wiserPath, "utf8");
	for (const document of [recovery, wiser]) {
		const proof = document.indexOf("npm run test:workerd:inbound-exact-size");
		const dryRun = document.indexOf("--dry-run");
		assert.ok(proof >= 0);
		assert.ok(dryRun > proof);
		assert.match(document, /environmental (?:test )?failure, not a waiver/i);
	}
});

test("AWS graph has captured ARNs, exact policies, fixtures, targets, and read-backs", async () => {
	const document = await readFile(recoveryPath, "utf8");
	for (const required of [
		'AWS_ACCOUNT_ID="$(aws sts get-caller-identity',
		'EVENTBRIDGE_CONNECTION_ARN="$(aws events describe-connection',
		'EVENTBRIDGE_API_DESTINATION_ARN="$(aws events describe-api-destination',
		'EVENTBRIDGE_DLQ_ARN="$(aws sqs get-queue-attributes',
		'EVENTBRIDGE_TARGET_ROLE_ARN="$(aws iam get-role',
		'"events:InvokeApiDestination"',
		"iam:PassRole",
		'"aws:SourceArn"',
		"POSITIVE_EVENT=",
		"CROSS_BRAND_EVENT=",
		"FOREIGN_EVENT=",
		"aws events test-event-pattern",
		"aws events list-targets-by-rule",
	]) {
		assert.ok(document.includes(required), required);
	}
	assert.doesNotMatch(document, /AWS_ACCOUNT_ID:event-bus/);
	assert.doesNotMatch(document, /EVENTBRIDGE_(?:CONNECTION|API_DESTINATION|TARGET_ROLE|DLQ)_ARN\}/);
});

test("AWS alert and disposable failure proofs are executable and independent", async () => {
	const document = await readFile(recoveryPath, "utf8");
	for (const required of [
		"aws sns create-topic",
		"aws sns subscribe",
		"aws sns publish",
		"aws cloudwatch put-metric-alarm",
		'Expression:"successful/attempts"',
		"SuccessfulInvocationAttempts",
		"InvocationAttempts",
		"RetryInvocationAttempts",
		"FailedInvocations",
		"InvocationsSentToDlq",
		"InvocationsFailedToBeSentToDlq",
		"IngestionToInvocationSuccessLatency",
		"ApproximateNumberOfMessagesVisible",
		"ApproximateAgeOfOldestMessage",
		"DRILL_5XX_URL",
		"DRILL_TIMEOUT_URL",
		"DRILL_404_URL",
		"MaximumEventAgeInSeconds:60",
		"MaximumRetryAttempts:2",
		"aws events remove-targets",
	]) {
		assert.ok(document.includes(required), required);
	}
	assert.doesNotMatch(document, /canary `Invocations < 1`/);
});

test("every exact CloudWatch alarm action has a received-page drill", async () => {
	const document = await readFile(recoveryPath, "utf8");
	for (const required of [
		'for RULE_NAME in "$EVENT_RULE" "$CANARY_RULE"',
		"for SUFFIX in failed sent-to-dlq failed-dlq-write retries latency",
		'"${ALARM_PREFIX}-${CANARY_RULE}-successful-gap"',
		'"${ALARM_PREFIX}-${EVENT_RULE}-success-rate"',
		'"${ALARM_PREFIX}-dlq-depth"',
		'"${ALARM_PREFIX}-dlq-oldest-age"',
		'test "$ALARM_TEST_COUNT" -eq 14',
		'test "$ALARM_TEST_UNIQUE_COUNT" -eq 14',
		"aws cloudwatch set-alarm-state",
		"--state-value ALARM",
		"exec 3</dev/tty",
		"RECEIVED_ALARM_NAME <&3",
		'test "$RECEIVED_ALARM_NAME" = "$ALARM_NAME"',
		"ALARM_PAGE_MESSAGE_ID <&3",
		"exec 3<&-",
		"ALARM_PAGE_MESSAGE_ID",
		"ALARM_PAGE_RECEIVED_AT",
		'>> "$ALARM_TEST_EVIDENCE"',
		"aws cloudwatch describe-alarm-history",
		'test "$(wc -l < "$ALARM_TEST_EVIDENCE" | tr -d \' \')" -eq 14',
	]) {
		assert.ok(document.includes(required), required);
	}
	assert.match(
		document,
		/\.ActionsEnabled == true and \.AlarmActions == \[\$topic\]/,
	);
	const parsed = spawnSync("bash", ["-n"], {
		input: bashBlockContaining(document, "ALARM_TEST_NAMES="),
		encoding: "utf8",
	});
	assert.equal(parsed.status, 0, parsed.stderr);
});

test("alarm evidence input cannot consume the alarm-name stream", () => {
	const executed = spawnSync(
		"bash",
		[
			"-c",
			[
				"set -eu",
				'names="$(mktemp)"',
				'evidence="$(mktemp)"',
				"printf '%s\\n' alarm-one alarm-two > \"$names\"",
				"exec 3<<<$'alarm-one\\nmessage-one\\nalarm-two\\nmessage-two'",
				'while IFS= read -r alarm; do',
				"  IFS= read -r received <&3",
				'  test "$received" = "$alarm"',
				"  IFS= read -r message_id <&3",
				'  printf "%s:%s\\n" "$alarm" "$message_id" >> "$evidence"',
				'done < "$names"',
				"exec 3<&-",
				'cat "$evidence"',
				'rm -- "$names" "$evidence"',
			].join("\n"),
		],
		{ encoding: "utf8" },
	);
	assert.equal(executed.status, 0, executed.stderr);
	assert.equal(executed.stdout, "alarm-one:message-one\nalarm-two:message-two\n");
});

test("manual application queries cannot satisfy the external monitoring gate", async () => {
	const document = await readFile(recoveryPath, "utf8");
	for (const required of [
		"must remain `0`",
		"is blocked until",
		"missing or late Cron",
		"forward_pending",
		"raw archive",
		"parked or expired",
		"accepted credential-recovery delivery without an exact callback",
		"ambiguous SES attempt",
		"failed DLQ write",
		"manually is not alerting",
	]) {
		assert.ok(document.includes(required), required);
	}
});

test("independent monitor proof precedes recovery enable and Wiser MX cutover", async () => {
	const recovery = await readFile(recoveryPath, "utf8");
	const monitorStep = recovery.indexOf(
		"### 7. Attach and approve the independent monitor proof record",
	);
	const enableWrite = recovery.indexOf(
		"UPDATE credential_recovery_control SET enabled = 1",
	);
	assert.ok(monitorStep >= 0);
	assert.ok(enableWrite > monitorStep);
	for (const required of [
		"MONITOR_PROOF_RECORD",
		"MONITOR_PROOF_APPROVAL",
		"one received test page per named monitor rule",
		"no successful minutely Cron heartbeat for three minutes",
		"oldest ready message",
		"forward_pending",
		"past its stored `lease_expires_at`",
		"older than 24 hours",
		"more than seven days",
		"after fifteen",
		"after five minutes",
		"fifteen-minute EventBridge callback canary gap",
	]) {
		assert.ok(recovery.includes(required), required);
	}

	const wiser = await readFile(wiserPath, "utf8");
	const preMxGate = wiser.indexOf("### Mandatory Pre-MX Monitor Proof Gate");
	const stageTwo = wiser.indexOf(
		"## Stage 2: Separately Approved Apex MX Cutover",
	);
	assert.ok(preMxGate >= 0);
	assert.ok(stageTwo > preMxGate);
	assert.match(
		wiser.slice(preMxGate, stageTwo),
		/14-row CloudWatch\s+alarm action proof/,
	);
});

test("every stale ambiguous attempt is monitored regardless of sibling acceptance", async () => {
	const recovery = await readFile(recoveryPath, "utf8");
	const query = recovery.match(
		/"SELECT COUNT\(\*\) AS ambiguous_attempts_over_sla[^"]+"/,
	)?.[0];
	assert.ok(query);
	assert.match(
		query,
		/FROM credential_recovery_delivery_attempts WHERE state = 'ambiguous'/,
	);
	assert.doesNotMatch(query, /\bJOIN\b|outbox|accepted/i);
	assert.match(
		recovery,
		/even\s+when a\s+different attempt for the same outbox delivery was later accepted/,
	);
});

test("short recovery SLAs page persistent failures and prove clean recovery", async () => {
	const recovery = await readFile(recoveryPath, "utf8");
	const wiser = await readFile(wiserPath, "utf8");
	for (const document of [recovery, wiser]) {
		for (const required of [
			"pending_requests_over_5_minutes",
			"pending_deliveries_over_5_minutes",
			"active_request_non_ambiguous_errors",
			"active_delivery_non_ambiguous_errors",
			"active_deliveries_with_repeated_http_rejections",
			"SES_HTTP_503",
			"SES_NOT_DISPATCHED",
			"PAYLOAD_KEY_UNAVAILABLE",
			"RECOVERY_DIRECTORY_INVALID_CONFIG",
			"third consecutive positive one-minute poll",
		]) {
			assert.ok(document.includes(required), required);
		}
		assert.match(document, /two\s+consecutive zero polls/);
		assert.match(
			document,
			/state IN \('pending', 'leased'\) AND created_at <= \(unixepoch\('now'\) - 300\) \* 1000/,
		);
		assert.match(
			document,
			/state IN \('pending', 'leased', 'dispatching'\) AND created_at <= \(unixepoch\('now'\) - 300\) \* 1000/,
		);
		assert.match(
			document,
			/attempts\.state = 'http_rejected'[\s\S]{0,300}HAVING COUNT\(\*\) >= 2/,
		);
	}
	assert.match(recovery, /before\s+the 15-minute request processing window expires/);
	assert.match(recovery, /Missing either the page or the recovery clear proof blocks enable/);
	assert.match(
		recovery,
		/last_error_code NOT IN \('SES_TRANSPORT_AMBIGUOUS', 'SES_INVALID_SUCCESS_RESPONSE'\)/,
	);
});

test("secret-envelope and single-residue contracts are operator-visible", async () => {
	const recovery = await readFile(recoveryPath, "utf8");
	const wiser = await readFile(wiserPath, "utf8");
	for (const document of [recovery, wiser]) {
		for (const required of [
			"create-secrets-envelope.mjs",
			"set +x",
			"read -r -s SECRET_VALUE </dev/tty",
			"create_private_secrets_envelope() (",
			"the parent receives only the created path",
			"abort_secret_prompt 143",
			"abort_secret_deploy 143",
			'unset "$SECRET_NAME"',
			"JSON-encode",
			"0600",
			"derived",
		]) {
			assert.ok(document.includes(required), required);
		}
		assert.match(
			document,
			/waits for any\s+issued file operation to settle,[\s\S]*re-raises the original `HUP`, `INT`, or `TERM`/,
		);
		assert.match(document, /owned regular\s+non-symlink single-link/);
		assert.match(document, /private\s+0700/);
		assert.doesNotMatch(document, /must use dotenv syntax/i);
		assert.doesNotMatch(document, /<paste exact value>/i);
		const creatorBlock = bashBlockContaining(
			document,
			"create-secrets-envelope.mjs",
		);
		const parsed = spawnSync("bash", ["-n"], {
			input: creatorBlock,
			encoding: "utf8",
		});
		assert.equal(parsed.status, 0, parsed.stderr);
	}
	for (const required of [
		"single primary/guard residue",
		"pair-or-single topology",
		"without returning or printing the token",
	]) {
		assert.ok(recovery.includes(required), required);
	}
	assert.doesNotMatch(recovery, /It refuses lone,/);
});

test("failed and interrupted secret prompts cannot export into the parent shell", async () => {
	const recovery = await readFile(recoveryPath, "utf8");
	const block = bashBlockContaining(
		recovery,
		"create_private_secrets_envelope() (",
	);
	const promptFunction = isolatedPromptFunction(block).replaceAll(
		"</dev/tty",
		"<&3",
	);

	const failedPrompt = spawnSync(
		"bash",
		[
			"-c",
			[
				"set -u",
				requiredSecretArray,
				promptFunction,
				"for SECRET_NAME in \"${REQUIRED_SECRET_NAMES[@]}\"; do unset \"$SECRET_NAME\"; done",
				"set +e",
				'CREATED_PATH="$(create_private_secrets_envelope 3</dev/null)"',
				"STATUS=$?",
				"set -e",
				'test "$STATUS" -ne 0',
				'test -z "$CREATED_PATH"',
				"for SECRET_NAME in \"${REQUIRED_SECRET_NAMES[@]}\"; do",
				'  test -z "${!SECRET_NAME+x}"',
				"done",
			].join("\n"),
		],
		{ encoding: "utf8" },
	);
	assert.equal(failedPrompt.status, 0, failedPrompt.stderr);

	for (const signal of ["TERM", "INT"]) {
		const interruptedPrompt = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -u",
					requiredSecretArray,
					promptFunction,
					"set +e",
					'PROMPT_FIFO="$(mktemp)"',
					'rm -- "$PROMPT_FIFO"',
					'mkfifo "$PROMPT_FIFO"',
					"(printf 'first-private-value\\n'; exec sleep 5) > \"$PROMPT_FIFO\" 2>/dev/null &",
					"WRITER_PID=$!",
					"create_private_secrets_envelope 3< \"$PROMPT_FIFO\" &",
					"PROMPT_PID=$!",
					`(sleep 0.1; kill -${signal} "$PROMPT_PID"; kill "$WRITER_PID" 2>/dev/null || true) &`,
					"KILLER_PID=$!",
					'wait "$PROMPT_PID"',
					"STATUS=$?",
					'wait "$KILLER_PID"',
					'wait "$WRITER_PID" 2>/dev/null || true',
					'rm -- "$PROMPT_FIFO"',
					"set -e",
					'test "$STATUS" -ne 0',
					"for SECRET_NAME in \"${REQUIRED_SECRET_NAMES[@]}\"; do",
					'  test -z "${!SECRET_NAME+x}"',
					"done",
				].join("\n"),
			],
			{ encoding: "utf8", timeout: 2_000 },
		);
		assert.equal(interruptedPrompt.status, 0, interruptedPrompt.stderr);
	}
});

test("parent signal handlers remove received secret artifacts and terminate", async () => {
	const recovery = await readFile(recoveryPath, "utf8");
	const block = bashBlockContaining(
		recovery,
		"create_private_secrets_envelope() (",
	);
	const cleanupFunctions = parentCleanupFunctions(block);
	for (const [signal, status] of [
		["TERM", 143],
		["INT", 130],
	]) {
		const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
			mkdtemp(`/tmp/mail-portal-secret-signal-${signal.toLowerCase()}-`),
		);
		const envelope = `${directory}/envelope.json`;
		await import("node:fs/promises").then(({ writeFile }) =>
			writeFile(envelope, "private", { mode: 0o600 }),
		);
		const cleaned = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -u",
					requiredSecretArray,
					'SECRETS_DIRECTORY="$1"',
					'SECRETS_FILE="$2"',
					cleanupFunctions,
					"trap cleanup_secrets_file EXIT",
					"trap 'abort_secret_deploy 129' HUP",
					"trap 'abort_secret_deploy 130' INT",
					"trap 'abort_secret_deploy 143' TERM",
					`kill -${signal} "$$"`,
					"exit 99",
				].join("\n"),
				"signal-cleanup",
				directory,
				envelope,
			],
			{ encoding: "utf8" },
		);
		assert.equal(cleaned.status, status, cleaned.stderr);
		const exists = spawnSync("test", ["-e", directory]);
		assert.notEqual(exists.status, 0, `${signal} left ${directory}`);
	}
});

test("parent cleanup stays exact and complete when a signal lands after file deletion", async () => {
	const recovery = await readFile(recoveryPath, "utf8");
	const block = bashBlockContaining(
		recovery,
		"create_private_secrets_envelope() (",
	);
	const cleanupFunctions = parentCleanupFunctions(block);
	const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
		mkdtemp("/tmp/mail-portal-secret-mid-cleanup-"),
	);
	const envelope = `${directory}/envelope.json`;
	await import("node:fs/promises").then(({ writeFile }) =>
		writeFile(envelope, "private", { mode: 0o600 }),
	);
	const cleaned = spawnSync(
		"bash",
		[
			"-c",
			[
				"set -eu",
				requiredSecretArray,
				'SECRETS_DIRECTORY="$1"',
				'SECRETS_FILE="$2"',
				cleanupFunctions,
				"trap cleanup_secrets_file EXIT",
				"trap 'abort_secret_deploy 143' TERM",
				"rm() {",
				'  command rm "$@"',
				"  unset -f rm",
				'  kill -TERM "$$"',
				"}",
				"cleanup_secrets_file",
				"exit 99",
			].join("\n"),
			"mid-cleanup-signal",
			directory,
			envelope,
		],
		{ encoding: "utf8" },
	);
	assert.equal(cleaned.status, 143, cleaned.stderr);
	const exists = spawnSync("test", ["-e", directory]);
	assert.notEqual(exists.status, 0, `TERM left ${directory}`);
});

test("inbound runbook distinguishes synchronous rejection and Email Sending proof", async () => {
	const document = await readFile(wiserPath, "utf8");
	for (const required of [
		"original Email Worker invocation",
		"cannot invent a retroactive rejection",
		"forwarding owns every eligible",
		"Email Sending metrics/logs",
		"returned `messageId`",
		"never from the Routing summary status",
		"general Email Service limit is 5 MiB",
		"25 MiB",
	]) {
		assert.ok(document.includes(required), required);
	}
});
