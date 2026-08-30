export type WorkflowPath = "live" | "replay" | "recovery";

export type WorkflowMutation = "src_lock" | "secret_reveal" | "refund";

export type DispatchReason =
  | "applied"
  | "already_applied"
  | "stale_sequence"
  | "lower_priority";

export interface DispatchDecision {
  shouldApply: boolean;
  reason: DispatchReason;
}

const PATH_PRIORITY: Record<WorkflowPath, number> = {
  live: 0,
  replay: 1,
  recovery: 2,
};

export interface DispatchInput {
  path: WorkflowPath;
  mutation: WorkflowMutation;
  incomingSequence: number | null;
  existingSequence: number | null;
  alreadyApplied: boolean;
}

/**
 * Deterministic mutation dispatch contract used by listeners/replay/recovery.
 *
 * The policy is intentionally simple:
 * - If the mutation was already applied, skip.
 * - Newer sequence always wins over older sequence.
 * - For equal/unknown sequence, path priority wins: live > replay > recovery.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  if (input.alreadyApplied) {
    return { shouldApply: false, reason: "already_applied" };
  }

  if (
    input.existingSequence !== null &&
    input.incomingSequence !== null &&
    input.incomingSequence < input.existingSequence
  ) {
    return { shouldApply: false, reason: "stale_sequence" };
  }

  if (input.existingSequence === input.incomingSequence) {
    if (PATH_PRIORITY[input.path] > PATH_PRIORITY.live) {
      return { shouldApply: false, reason: "lower_priority" };
    }
  }

  return { shouldApply: true, reason: "applied" };
}
