export const WORKER_DEFAULT_SERVICE_SUBREQUEST_LIMIT = 10_000;
export const INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET = 9_000;

export const RECONCILIATION_LANE_OVERHEAD_SERVICE_SUBREQUESTS = 3;

export const INBOUND_REPAIR_ATTEMPT_RECONCILIATION_BATCH_SIZE = 20;
// Pending read + resolution read + finalize RPC + immutable resolution
// put/reread + guarded cleanup RPC + pending-ledger delete.
export const MAX_REPAIR_ATTEMPT_SERVICE_SUBREQUESTS_PER_ITEM = 7;

export const INBOUND_CLEANUP_INTENT_RECONCILIATION_BATCH_SIZE = 7;
export const MAX_CLEANUP_INTENT_DISCOVERY_LIST_CALLS = 514;
// Intent read + exhaustive two-prefix listing + manifest RPC + cleanup RPC +
// the three-call CAS transition used by the worst abandoned-intent branch.
export const MAX_CLEANUP_INTENT_SERVICE_SUBREQUESTS_PER_ITEM = 520;

export const INBOUND_ARCHIVE_RECONCILIATION_BATCH_SIZE = 7;
// Archive head + receipt read + Mailbox truth RPCs + anomaly resolution +
// manifest RPC + 512 integrity heads + anomaly marker + failure-ledger delete.
export const MAX_ARCHIVE_SERVICE_SUBREQUESTS_PER_ITEM = 521;

// Each lane spends one read, one list, and one cursor write outside its item
// loop. The per-item ceilings mirror the actual worst-case call graphs so an
// admitted page can finish without relying on a mid-item budget exception.
export const INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS =
	RECONCILIATION_LANE_OVERHEAD_SERVICE_SUBREQUESTS * 3 +
	INBOUND_REPAIR_ATTEMPT_RECONCILIATION_BATCH_SIZE *
		MAX_REPAIR_ATTEMPT_SERVICE_SUBREQUESTS_PER_ITEM +
	INBOUND_CLEANUP_INTENT_RECONCILIATION_BATCH_SIZE *
		MAX_CLEANUP_INTENT_SERVICE_SUBREQUESTS_PER_ITEM +
	INBOUND_ARCHIVE_RECONCILIATION_BATCH_SIZE *
		MAX_ARCHIVE_SERVICE_SUBREQUESTS_PER_ITEM;

if (
	INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS >
		INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET ||
	INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET >=
		WORKER_DEFAULT_SERVICE_SUBREQUEST_LIMIT
) {
	throw new Error(
		"Inbound reconciliation exceeds its service-subrequest budget",
	);
}
