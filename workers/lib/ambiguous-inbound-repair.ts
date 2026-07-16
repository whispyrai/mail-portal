import { DerivedEmailConsumerError } from "./streaming-email.ts";
import type {
  InboundDerivedContentRepairResult,
  InboundDerivedContentRepairAttemptTerminal,
} from "./inbound-projection-contract.ts";

export async function resolveAmbiguousInboundRepair(input: {
  repairError: unknown;
  finalizeAttempt(): Promise<InboundDerivedContentRepairAttemptTerminal>;
}): Promise<InboundDerivedContentRepairResult> {
  let terminal: InboundDerivedContentRepairAttemptTerminal;
  try {
    terminal = await input.finalizeAttempt();
  } catch (verificationError) {
    throw new DerivedEmailConsumerError(
      "unverified",
      new AggregateError(
        [input.repairError, verificationError],
        "Repair outcome could not be verified",
      ),
    );
  }
  if (terminal.outcome !== "committed") {
    throw new DerivedEmailConsumerError("not_committed", input.repairError);
  }
  return {
    status: "repaired",
    generation: terminal.generation,
    ambiguousCommit: true,
  };
}
