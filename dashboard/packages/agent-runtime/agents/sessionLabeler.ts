/**
 * Track per-session labels so log lines from parallel subagents can be
 * differentiated. The orchestrator dispatches lens subagents (e.g. reviewer)
 * via the Task tool; each subagent runs in its own opencode/claude Session
 * with its own `sessionID` (or `session_id`) tag on the NDJSON event stream.
 *
 * Without per-session prefixing, parallel subagent tool_use / tool_result /
 * text events appear as a single interleaved stream tagged with `[Polaris]`,
 * making it impossible for a human reading the logs to attribute work to a
 * specific lens.
 *
 * The labeler is deliberately runtime-agnostic - both opencode.ts and
 * claude.ts feed it the same shape. The contract is FIFO: when the orchestrator
 * dispatches N task tool_use blocks in a single assistant turn (the parallel
 * fan-out the multi-lens prompt requires), the i-th new sessionID is assumed
 * to belong to the i-th task dispatch. This is correct as long as parallel
 * dispatches are emitted in source-order and the runtimes respect that order
 * when assigning child sessions; we do not depend on it for correctness of
 * the read-only contract - only for log readability.
 */

export interface TaskDispatchInput {
  description?: string | undefined;
  subagent_type?: string | undefined;
  prompt?: string | undefined;
}

export const ORCHESTRATOR_LABEL = "orchestrator";

const LENS_PROMPT_PATTERN = /^\s*(?:lens|Lens|LENS)\s*[:=]\s*([A-Za-z][\w &/.-]{0,60})/m;

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Extract a human-readable label from a Task tool's input. Tries (in order):
 *   1. explicit `lens: <name>` marker on a line in the prompt - preferred,
 *      lets the orchestrator name the lens deterministically
 *   2. the Task tool's `description` field - short, written by orchestrator
 *      per call, usually enough
 *   3. the `subagent_type` (e.g. `reviewer`) - falls back to the named
 *      subagent identity when description is missing
 *   4. generic "subagent" - last resort
 */
export function deriveLabelFromTaskInput(input: TaskDispatchInput): string {
  if (typeof input.prompt === "string") {
    const match = input.prompt.match(LENS_PROMPT_PATTERN);
    if (match?.[1]) {
      const slugged = slug(match[1]);
      if (slugged) return `lens:${slugged}`;
    }
  }
  if (input.description) {
    const slugged = slug(input.description);
    if (slugged) return `lens:${slugged}`;
  }
  if (input.subagent_type) {
    return input.subagent_type;
  }
  return "subagent";
}

/**
 * Stateful tracker mapping subagent activity back to human-readable labels.
 *
 * Two attribution channels are supported because the runtimes differ:
 *
 *   - **OpenCode** spawns each subagent as its own opencode `Session` with
 *     a distinct `sessionID`. The harness records each Task dispatch into a
 *     pending FIFO queue; the next previously-unseen sessionID consumes the
 *     head of the queue and binds it to that label.
 *
 *   - **Claude Code** runs subagents inside the orchestrator's session - they
 *     all share `session_id` - and instead stamps every subagent message with
 *     `parent_tool_use_id` pointing at the Agent tool_use id that spawned them.
 *     The harness binds each Agent tool_use id to its dispatched label up
 *     front, then `labelFor` looks the label up directly when an event arrives
 *     carrying that `parent_tool_use_id`.
 *
 * `labelFor(sessionID, parentToolUseId?)` accepts both: when
 * `parentToolUseId` is set and known it short-circuits to the direct mapping;
 * otherwise it falls through to the FIFO/sessionID path.
 */
export class SessionLabeler {
  private readonly labels = new Map<string, string>();
  private readonly labelsByToolUseId = new Map<string, string>();
  private readonly pendingLabels: string[] = [];
  private fallbackCounter = 0;

  /**
   * Record a Task/Agent tool dispatch.
   *
   * @param input  Task tool input - used to derive the lens label.
   * @param toolUseId  Optional Agent tool_use id. When provided, future events
   *                   carrying `parent_tool_use_id === toolUseId` resolve
   *                   directly to this label without consuming the FIFO queue
   *                   (Claude path). Always also pushed to the FIFO queue so
   *                   the OpenCode path still works when toolUseId is absent.
   */
  recordTaskDispatch(input: TaskDispatchInput, toolUseId?: string | null): string {
    const label = deriveLabelFromTaskInput(input);
    this.pendingLabels.push(label);
    if (toolUseId) this.labelsByToolUseId.set(toolUseId, label);
    return label;
  }

  /**
   * Return a label for the given event.
   *
   * @param sessionID         Session id from the event (OpenCode: per-session;
   *                          Claude: shared across orchestrator + subagents).
   * @param parentToolUseId   Claude's `parent_tool_use_id` - non-null on
   *                          subagent messages. When set and known, takes
   *                          priority over the FIFO/sessionID path.
   */
  labelFor(sessionID: string | undefined | null, parentToolUseId?: string | null): string {
    // Claude path: subagent messages carry parent_tool_use_id pointing at
    // the Agent tool_use that spawned them. resolve directly without
    // touching the sessionID-keyed map (which is bound to the orchestrator
    // for the shared session_id and would otherwise misattribute).
    if (parentToolUseId) {
      const direct = this.labelsByToolUseId.get(parentToolUseId);
      if (direct) return direct;
    }

    if (!sessionID) return ORCHESTRATOR_LABEL;
    const existing = this.labels.get(sessionID);
    if (existing) return existing;

    let label: string;
    if (this.labels.size === 0) {
      label = ORCHESTRATOR_LABEL;
    } else if (this.pendingLabels.length > 0) {
      label = this.pendingLabels.shift() as string;
    } else {
      this.fallbackCounter += 1;
      label = `subagent#${this.fallbackCounter}`;
    }
    this.labels.set(sessionID, label);
    return label;
  }

  /** number of distinct sessions seen so far (for diagnostics) */
  size(): number {
    return this.labels.size;
  }

  /** all (sessionID, label) pairs, oldest first */
  entries(): Array<[string, string]> {
    return Array.from(this.labels.entries());
  }

  /** how many pending labels are queued waiting to bind to a new session */
  pendingDispatchCount(): number {
    return this.pendingLabels.length;
  }
}

/**
 * Format a log message with a session label prefix in magenta. Mirrors the
 * style of utils/log.ts:prefixLines() so per-session prefixes look the same
 * as the dormant withLogPrefix-based ones.
 */
export function formatWithLabel(label: string, message: string): string {
  const MAGENTA = "\x1b[35m";
  const RESET = "\x1b[0m";
  const colored = `${MAGENTA}[${label}]${RESET} `;
  return message
    .split("\n")
    .map((line) => `${colored}${line}`)
    .join("\n");
}
