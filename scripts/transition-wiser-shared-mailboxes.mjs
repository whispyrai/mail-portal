#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createPrivateOperationLogger } from "./private-operation-logger.mjs";

const execFileAsync = promisify(execFile);

export const WISER_ROLE_ADDRESSES = Object.freeze([
	"hello@wiserchat.ai",
	"contact@wiserchat.ai",
]);

export const WISER_INITIAL_SHARED_MEMBERS = Object.freeze([
	"hesham@wiserchat.ai",
	"ibrahem@wiserchat.ai",
]);

const APPLY_CONFIRMATION = "transition-wiser-role-mailboxes";
const GUARD_TABLE = "_wiser_shared_mailbox_transition_guard";
const GUARD_TRIGGER = "_wiser_shared_mailbox_transition_abort";

function sqlLiteral(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlList(values) {
	return values.map(sqlLiteral).join(", ");
}

const roleAddressesSql = sqlList(WISER_ROLE_ADDRESSES);
const memberAddressesSql = sqlList(WISER_INITIAL_SHARED_MEMBERS);

export function parseTransitionArguments(argv) {
	if (argv.length === 0) return { apply: false };
	if (
		argv.length === 3 &&
		argv[0] === "--apply" &&
		argv[1] === "--confirm" &&
		argv[2] === APPLY_CONFIRMATION
	) {
		return { apply: true };
	}
	throw new Error(
		`Use no arguments for read-only preflight, or --apply --confirm ${APPLY_CONFIRMATION} after exact production approval`,
	);
}

export function buildTransitionStateSql() {
	return `
SELECT
  (SELECT COUNT(*) FROM users
    WHERE email IN (${roleAddressesSql})) AS legacy_role_users,
  (SELECT COUNT(*) FROM users AS u
    JOIN mailboxes AS m ON m.id = u.mailbox_address
    WHERE u.email IN (${roleAddressesSql})
      AND u.email = u.mailbox_address
      AND m.id = m.address
      AND m.address = u.email
      AND m.type = 'PERSONAL'
      AND m.owner_user_id = u.id
      AND u.role = 'AGENT'
      AND u.is_active = 1
      AND m.is_active = 1) AS active_legacy_role_users,
  (SELECT COUNT(*) FROM users AS u
    JOIN mailboxes AS m ON m.id = u.mailbox_address
    WHERE u.email IN (${roleAddressesSql})
      AND u.email = u.mailbox_address
      AND m.id = m.address
      AND m.address = u.email
      AND m.type = 'SHARED'
      AND m.owner_user_id IS NULL
      AND u.role = 'AGENT'
      AND u.is_active = 0
      AND u.mcp_token_hash IS NULL
      AND u.session_version >= 2
      AND m.is_active = 1
      AND EXISTS (
        SELECT 1 FROM credential_recovery_audit AS audit
        WHERE audit.user_id = u.id
          AND audit.event_type = 'account_deactivated'
          AND audit.created_at = u.updated_at
      )) AS retired_role_users,
  (SELECT COUNT(*) FROM users AS u
    JOIN mailboxes AS m ON m.id = u.mailbox_address
    WHERE u.email IN (${roleAddressesSql})
      AND u.email = u.mailbox_address
      AND m.id = m.address
      AND m.address = u.email
      AND m.type = 'PERSONAL'
      AND m.owner_user_id = u.id
      AND m.is_active = 1) AS personal_role_mailboxes,
  (SELECT COUNT(*) FROM mailboxes
    WHERE address IN (${roleAddressesSql})
      AND id = address
      AND type = 'SHARED'
      AND owner_user_id IS NULL
      AND is_active = 1) AS shared_role_mailboxes,
  (SELECT COUNT(*) FROM users AS u
    JOIN mailboxes AS m ON m.id = u.mailbox_address
    WHERE u.email IN (${memberAddressesSql})
      AND u.email = u.mailbox_address
      AND m.id = m.address
      AND m.address = u.email
      AND m.type = 'PERSONAL'
      AND m.owner_user_id = u.id
      AND u.is_active = 1
      AND m.is_active = 1) AS active_selected_members,
  (SELECT COUNT(*) FROM mailboxes AS m
    JOIN users AS u ON u.id = m.owner_user_id
    WHERE u.email IN (${memberAddressesSql})
      AND u.email = u.mailbox_address
      AND m.id = m.address
      AND m.address = u.email
      AND m.type = 'PERSONAL'
      AND m.is_active = 1) AS selected_personal_mailboxes,
  (SELECT COUNT(*) FROM mailbox_memberships AS mm
    JOIN mailboxes AS m ON m.id = mm.mailbox_id
    WHERE m.address IN (${roleAddressesSql})) AS role_mailbox_memberships,
  (SELECT COUNT(*) FROM mailbox_memberships AS mm
    JOIN mailboxes AS m ON m.id = mm.mailbox_id
    JOIN users AS u ON u.id = mm.user_id
    WHERE m.address IN (${roleAddressesSql})
      AND u.email IN (${memberAddressesSql})) AS expected_role_memberships,
  (SELECT COUNT(*) FROM credential_recovery_tokens AS token
    JOIN users AS u ON u.id = token.user_id
    WHERE u.email IN (${roleAddressesSql})
      AND token.consumed_at IS NULL) AS active_role_recovery_tokens,
  (SELECT COUNT(*) FROM credential_recovery_delivery_outbox AS delivery
    JOIN credential_recovery_tokens AS token ON token.id = delivery.token_id
    JOIN users AS u ON u.id = token.user_id
    WHERE u.email IN (${roleAddressesSql})
      AND (
        delivery.state IN ('pending', 'leased')
        OR (
          delivery.state = 'dispatching'
          AND COALESCE(delivery.cancellation_reason, '') <> 'ACCOUNT_DEACTIVATED'
        )
      )) AS unsafe_role_recovery_deliveries,
  (SELECT COUNT(*) FROM agent_connection_revocations AS revocation
    JOIN users AS u ON u.id = revocation.user_id
    WHERE u.email IN (${roleAddressesSql})
      AND revocation.scope = 'ACTOR') AS outstanding_role_revocations;
`.trim();
}

function exactLegacyPredicate() {
	return `
    (SELECT COUNT(*) FROM users
      WHERE email IN (${roleAddressesSql})) = 2
    AND (SELECT COUNT(*) FROM users AS u
      JOIN mailboxes AS m ON m.id = u.mailbox_address
      WHERE u.email IN (${roleAddressesSql})
        AND u.email = u.mailbox_address
        AND m.id = m.address
        AND m.address = u.email
        AND m.type = 'PERSONAL'
        AND m.owner_user_id = u.id
        AND u.role = 'AGENT'
        AND u.is_active = 1
        AND m.is_active = 1) = 2
    AND (SELECT COUNT(*) FROM mailboxes
      WHERE address IN (${roleAddressesSql})
        AND type = 'SHARED') = 0
    AND (SELECT COUNT(*) FROM users AS u
      JOIN mailboxes AS m ON m.id = u.mailbox_address
      WHERE u.email IN (${memberAddressesSql})
        AND u.email = u.mailbox_address
        AND m.id = m.address
        AND m.address = u.email
        AND m.type = 'PERSONAL'
        AND m.owner_user_id = u.id
        AND u.is_active = 1
        AND m.is_active = 1) = 2
    AND (SELECT COUNT(*) FROM mailbox_memberships AS mm
      JOIN mailboxes AS m ON m.id = mm.mailbox_id
      WHERE m.address IN (${roleAddressesSql})) = 0
	`.trim();
}

function exactFinalPredicate() {
	return `
    (SELECT COUNT(*) FROM users
      WHERE email IN (${roleAddressesSql})) = 2
    AND (SELECT COUNT(*) FROM users AS u
      JOIN mailboxes AS m ON m.id = u.mailbox_address
      WHERE u.email IN (${roleAddressesSql})
        AND u.email = u.mailbox_address
        AND m.id = m.address
        AND m.address = u.email
        AND m.type = 'SHARED'
        AND m.owner_user_id IS NULL
        AND u.role = 'AGENT'
        AND u.is_active = 0
        AND u.mcp_token_hash IS NULL
        AND u.session_version >= 2
        AND m.is_active = 1
        AND EXISTS (
          SELECT 1 FROM credential_recovery_audit AS audit
          WHERE audit.user_id = u.id
            AND audit.event_type = 'account_deactivated'
            AND audit.created_at = u.updated_at
        )) = 2
    AND (SELECT COUNT(*) FROM mailboxes
      WHERE address IN (${roleAddressesSql})
        AND id = address
        AND type = 'SHARED'
        AND owner_user_id IS NULL
        AND is_active = 1) = 2
    AND (SELECT COUNT(*) FROM users AS u
      JOIN mailboxes AS m ON m.id = u.mailbox_address
      WHERE u.email IN (${memberAddressesSql})
        AND u.email = u.mailbox_address
        AND m.id = m.address
        AND m.address = u.email
        AND m.type = 'PERSONAL'
        AND m.owner_user_id = u.id
        AND u.is_active = 1
        AND m.is_active = 1) = 2
    AND (SELECT COUNT(*) FROM mailbox_memberships AS mm
      JOIN mailboxes AS m ON m.id = mm.mailbox_id
      WHERE m.address IN (${roleAddressesSql})) = 4
    AND (SELECT COUNT(*) FROM mailbox_memberships AS mm
      JOIN mailboxes AS m ON m.id = mm.mailbox_id
      JOIN users AS u ON u.id = mm.user_id
      WHERE m.address IN (${roleAddressesSql})
        AND u.email IN (${memberAddressesSql})) = 4
    AND (SELECT COUNT(*) FROM credential_recovery_tokens AS token
      JOIN users AS u ON u.id = token.user_id
      WHERE u.email IN (${roleAddressesSql})
        AND token.consumed_at IS NULL) = 0
    AND (SELECT COUNT(*) FROM credential_recovery_delivery_outbox AS delivery
      JOIN credential_recovery_tokens AS token ON token.id = delivery.token_id
      JOIN users AS u ON u.id = token.user_id
      WHERE u.email IN (${roleAddressesSql})
        AND (
          delivery.state IN ('pending', 'leased')
          OR (
            delivery.state = 'dispatching'
            AND COALESCE(delivery.cancellation_reason, '') <> 'ACCOUNT_DEACTIVATED'
          )
        )) = 0
    AND (SELECT COUNT(DISTINCT u.id)
      FROM agent_connection_revocations AS revocation
      JOIN users AS u ON u.id = revocation.user_id
      WHERE u.email IN (${roleAddressesSql})
        AND revocation.scope = 'ACTOR'
        AND revocation.mailbox_id = u.email) = 2
`.trim();
}

function createTransitionMutationInput() {
	return {
		at: Date.now(),
		roleCredentials: WISER_ROLE_ADDRESSES.map((email) => ({
			email,
			passwordHash: randomBytes(32).toString("base64"),
			passwordSalt: randomBytes(16).toString("base64"),
			auditId: `audit_${randomBytes(16).toString("hex")}`,
		})),
	};
}

export function buildTransitionApplySql(
	mutation = createTransitionMutationInput(),
) {
	const credentialCases = (field) =>
		mutation.roleCredentials
			.map((credential) =>
				`WHEN ${sqlLiteral(credential.email)} THEN ${sqlLiteral(credential[field])}`,
			)
			.join("\n      ");
	const auditRows = mutation.roleCredentials
		.map(
			(credential) =>
				`(${sqlLiteral(credential.auditId)}, (SELECT id FROM users WHERE email = ${sqlLiteral(credential.email)}), 'account_deactivated', NULL, ${mutation.at})`,
		)
		.join(",\n  ");
	return `
CREATE TABLE ${GUARD_TABLE} (
  exact_state INTEGER NOT NULL
);

CREATE TRIGGER ${GUARD_TRIGGER}
BEFORE INSERT ON ${GUARD_TABLE}
WHEN NEW.exact_state <> 1
BEGIN
  SELECT RAISE(ABORT, 'Wiser Shared Mailbox transition state changed or is incomplete');
END;

INSERT INTO ${GUARD_TABLE}(exact_state)
SELECT CASE WHEN
  ${exactLegacyPredicate()}
THEN 1 ELSE 0 END;

UPDATE credential_recovery_tokens
SET consumed_at = ${mutation.at}
WHERE consumed_at IS NULL
  AND user_id IN (
    SELECT id FROM users WHERE email IN (${roleAddressesSql})
  );

UPDATE credential_recovery_delivery_outbox
SET state = 'cancelled',
    lease_token = NULL,
    lease_expires_at = NULL,
    payload_key_version = NULL,
    payload_iv = NULL,
    payload_ciphertext = NULL,
    completed_at = ${mutation.at},
    updated_at = ${mutation.at},
    last_error_code = 'ACCOUNT_DEACTIVATED',
    cancellation_reason = 'ACCOUNT_DEACTIVATED',
    cancellation_observed_at = ${mutation.at}
WHERE token_id IN (
    SELECT token.id
    FROM credential_recovery_tokens AS token
    JOIN users AS u ON u.id = token.user_id
    WHERE u.email IN (${roleAddressesSql})
  )
  AND state IN ('pending', 'leased');

UPDATE credential_recovery_delivery_outbox
SET cancellation_reason = COALESCE(cancellation_reason, 'ACCOUNT_DEACTIVATED'),
    cancellation_observed_at = COALESCE(cancellation_observed_at, ${mutation.at}),
    updated_at = ${mutation.at}
WHERE token_id IN (
    SELECT token.id
    FROM credential_recovery_tokens AS token
    JOIN users AS u ON u.id = token.user_id
    WHERE u.email IN (${roleAddressesSql})
  )
  AND state = 'dispatching';

UPDATE users
SET is_active = 0,
    password_hash = CASE email
      ${credentialCases("passwordHash")}
    END,
    password_salt = CASE email
      ${credentialCases("passwordSalt")}
    END,
    mcp_token_hash = NULL,
    session_version = session_version + 1,
    updated_at = ${mutation.at}
WHERE email IN (${roleAddressesSql});

INSERT INTO credential_recovery_audit (
  id, user_id, event_type, actor_user_id, created_at
) VALUES
  ${auditRows};

UPDATE mailboxes
SET type = 'SHARED',
    owner_user_id = NULL,
    is_active = 1,
    updated_at = unixepoch() * 1000
WHERE address IN (${roleAddressesSql});

INSERT INTO mailbox_memberships(mailbox_id, user_id, created_at)
SELECT m.id, u.id, unixepoch() * 1000
FROM mailboxes AS m
CROSS JOIN users AS u
WHERE m.address IN (${roleAddressesSql})
  AND m.type = 'SHARED'
  AND m.owner_user_id IS NULL
  AND u.email IN (${memberAddressesSql})
  AND u.is_active = 1;

INSERT INTO ${GUARD_TABLE}(exact_state)
SELECT CASE WHEN
  ${exactFinalPredicate()}
THEN 1 ELSE 0 END;

DROP TRIGGER ${GUARD_TRIGGER};
DROP TABLE ${GUARD_TABLE};
`.trim();
}

function integerField(row, name) {
	const value = row?.[name];
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`D1 returned an invalid ${name} count`);
	}
	return value;
}

export function classifyTransitionState(row) {
	const state = {
		legacyRoleUsers: integerField(row, "legacy_role_users"),
		personalRoleMailboxes: integerField(row, "personal_role_mailboxes"),
		sharedRoleMailboxes: integerField(row, "shared_role_mailboxes"),
		activeSelectedMembers: integerField(row, "active_selected_members"),
		selectedPersonalMailboxes: integerField(row, "selected_personal_mailboxes"),
		roleMailboxMemberships: integerField(row, "role_mailbox_memberships"),
		expectedRoleMemberships: integerField(row, "expected_role_memberships"),
		activeLegacyRoleUsers: integerField(row, "active_legacy_role_users"),
		retiredRoleUsers: integerField(row, "retired_role_users"),
		activeRoleRecoveryTokens: integerField(row, "active_role_recovery_tokens"),
		unsafeRoleRecoveryDeliveries: integerField(
			row,
			"unsafe_role_recovery_deliveries",
		),
		outstandingRoleRevocations: integerField(
			row,
			"outstanding_role_revocations",
		),
	};

	const ready =
		state.legacyRoleUsers === 2 &&
		state.activeLegacyRoleUsers === 2 &&
		state.retiredRoleUsers === 0 &&
		state.personalRoleMailboxes === 2 &&
		state.sharedRoleMailboxes === 0 &&
		state.activeSelectedMembers === 2 &&
		state.selectedPersonalMailboxes === 2 &&
		state.roleMailboxMemberships === 0 &&
		state.expectedRoleMemberships === 0;
	const committed =
		state.legacyRoleUsers === 2 &&
		state.activeLegacyRoleUsers === 0 &&
		state.retiredRoleUsers === 2 &&
		state.personalRoleMailboxes === 0 &&
		state.sharedRoleMailboxes === 2 &&
		state.activeSelectedMembers === 2 &&
		state.selectedPersonalMailboxes === 2 &&
		state.roleMailboxMemberships === 4 &&
		state.expectedRoleMemberships === 4 &&
		state.activeRoleRecoveryTokens === 0 &&
		state.unsafeRoleRecoveryDeliveries === 0;
	const applied = committed && state.outstandingRoleRevocations === 0;
	const committedCleanupPending =
		committed && state.outstandingRoleRevocations > 0;

	return {
		kind: ready
			? "ready"
			: applied
				? "applied"
				: committedCleanupPending
					? "committed_cleanup_pending"
					: "blocked",
		state,
	};
}

function extractSingleRow(result) {
	if (!Array.isArray(result)) throw new Error("D1 output was not an array");
	const rows = result.flatMap((entry) =>
		Array.isArray(entry?.results) ? entry.results : [],
	);
	if (rows.length !== 1) {
		throw new Error(`Expected one D1 state row, received ${rows.length}`);
	}
	return rows[0];
}

// Wrangler sends this complete command to D1's remote query endpoint. Cloudflare
// documents semicolon-separated D1 batches as transactional with full rollback:
// https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
async function executeWrangler(command) {
	const { stdout, stderr } = await execFileAsync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"DB",
			"--env",
			"wiser",
			"--remote",
			"--command",
			command,
			"--json",
		],
		{
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		},
	);
	return {
		result: JSON.parse(stdout),
		diagnostics: stderr,
	};
}

function stateSummary(classification) {
	const state = classification.state;
	return [
		`state=${classification.kind}`,
		`legacy_role_users=${state.legacyRoleUsers}`,
		`retired_role_users=${state.retiredRoleUsers}`,
		`shared_role_mailboxes=${state.sharedRoleMailboxes}`,
		`active_selected_members=${state.activeSelectedMembers}`,
		`role_memberships=${state.roleMailboxMemberships}`,
		`outstanding_role_revocations=${state.outstandingRoleRevocations}`,
	].join(" ");
}

export async function runTransition({
	argv,
	logger,
	runWrangler = executeWrangler,
}) {
	const { apply } = parseTransitionArguments(argv);
	await logger.progress(
		`Wiser Shared Mailbox transition starting mode=${apply ? "apply" : "preflight"} log=${logger.logFilePath}`,
	);
	await logger.progress("Phase 1/3: reading exact D1 transition state");
	const beforeOutput = await runWrangler(buildTransitionStateSql());
	await logger.detail(`preflight_diagnostics=${beforeOutput.diagnostics || "(none)"}`);
	await logger.detail(`preflight_result=${JSON.stringify(beforeOutput.result)}`);
	const before = classifyTransitionState(extractSingleRow(beforeOutput.result));
	await logger.progress(`Preflight ${stateSummary(before)}`);

	if (before.kind === "blocked") {
		throw new Error(
			"Transition blocked: D1 is neither the exact verified legacy state nor the exact completed state",
		);
	}
	if (before.kind === "applied") {
		await logger.progress("PASS transition was already applied exactly; no write performed");
		return { kind: "applied", wrote: false };
	}
	if (before.kind === "committed_cleanup_pending") {
		await logger.progress(
			"COMMITTED cleanup pending: role accounts are tombstoned and Shared Mailboxes are exact; Agent revocations remain durably owned",
		);
		return { kind: "committed_cleanup_pending", wrote: false };
	}
	if (!apply) {
		await logger.progress(
			`READY rerun with --apply --confirm ${APPLY_CONFIRMATION} after exact Wiser D1 approval`,
		);
		return { kind: "ready", wrote: false };
	}

	await logger.progress(
		"Phase 2/3: applying one guarded D1 batch for conversion, credential retirement, and memberships",
	);
	const applyOutput = await runWrangler(buildTransitionApplySql());
	await logger.detail(`apply_diagnostics=${applyOutput.diagnostics || "(none)"}`);
	await logger.detail(`apply_result=${JSON.stringify(applyOutput.result)}`);

	await logger.progress("Phase 3/3: verifying exact final D1 state");
	const afterOutput = await runWrangler(buildTransitionStateSql());
	await logger.detail(`verify_diagnostics=${afterOutput.diagnostics || "(none)"}`);
	await logger.detail(`verify_result=${JSON.stringify(afterOutput.result)}`);
	const after = classifyTransitionState(extractSingleRow(afterOutput.result));
	await logger.progress(`Verification ${stateSummary(after)}`);
	if (
		after.kind !== "applied" &&
		after.kind !== "committed_cleanup_pending"
	) {
		throw new Error("Transition did not reach the exact verified final state");
	}
	if (after.kind === "committed_cleanup_pending") {
		await logger.progress(
			"COMMITTED cleanup pending: role accounts are tombstoned, both Shared Mailboxes are exact, and Agent revocations remain durably owned",
		);
		return { kind: "committed_cleanup_pending", wrote: true };
	}
	await logger.progress(
		"PASS both role addresses are Shared Mailboxes, legacy role logins are tombstoned, both current human accounts are members, and Agent cleanup is complete",
	);
	return { kind: "applied", wrote: true };
}

async function createLogger() {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = randomBytes(6).toString("hex");
	const logFilePath = resolve(
		"script-logs",
		`transition-wiser-shared-mailboxes-${timestamp}-${process.pid}-${suffix}.log`,
	);
	return createPrivateOperationLogger({
		logFilePath,
		header: `transition-wiser-shared-mailboxes\nstarted_at=${new Date().toISOString()}\ntarget=wiser_mail_portal_users`,
		sanitize: (value) =>
			String(value ?? "")
				.replace(/[\r\n\t]+/g, " ")
				.slice(0, 20_000),
	});
}

async function main() {
	const logger = await createLogger();
	try {
		await runTransition({ argv: process.argv.slice(2), logger });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await logger.failure(`FAIL ${message}`);
		process.exitCode = 1;
	} finally {
		await logger.close();
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await main();
}
