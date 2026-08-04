const MAX_STDERR_BYTES = 3000;

/**
 * mutable per-run handle the agent harness writes to as a run progresses.
 * the action's outer try/catch in `main.ts` reads this off `toolState` when
 * the activity-timeout watchdog wins the race against the harness's own
 * catch - the bare timer reject reason ("activity timeout: no output for
 * 302s") tells the user nothing actionable, but `recentStderr` +
 * `lastProviderError` together usually point straight at the upstream cause.
 *
 * `recentStderr` is shared by reference with the harness's bounded ring
 * buffer, so the diagnostic always reflects the latest captured tail.
 */
export type AgentDiagnostic = {
  /** display label for the agent, e.g. "Polaris". used in the headline. */
  label: string;
  /** shared reference to the harness's bounded stderr ring buffer. */
  recentStderr: string[];
  /** most-recent provider-error label from `detectProviderError`, if any. */
  lastProviderError: string | undefined;
  /** count of stdout events successfully parsed before the failure. */
  eventCount: number;
  /**
   * idle span the watchdog measured, in seconds. set structurally because the
   * opencode harness's error string carries only prose - re-parsing it dropped
   * the duration from the rendered explanation entirely.
   */
  idleSec: number | undefined;
  /**
   * whether the model produced a part of its own before the stall. `eventCount`
   * cannot answer this: it counts every SSE event, and our own prompt echo plus
   * session lifecycle events land before the provider is contacted, so it is
   * never 0 on a live stream.
   */
  sawModelOutput: boolean;
};

/**
 * Build a user-facing markdown body for an agent hang or failure.
 *
 * Rendered into both the PR progress comment and the GitHub Actions job
 * summary. Returns `null` when no diagnostic is available, which signals to
 * the caller to fall back to its bare-error rendering.
 *
 * `errorMessage` is the underlying timer / spawn reject string (e.g.
 * `activity timeout: no output for 301s`). The idle seconds are parsed out
 * of it for the hang explanation - total runtime would overstate the stall
 * for runs that streamed for a long time before going quiet.
 */
export function formatAgentHangBody(input: {
  diagnostic: AgentDiagnostic | undefined;
  isHang: boolean;
  errorMessage: string;
}): string | null {
  if (!input.diagnostic) return null;

  // billing exhaustion (CreditsError / FreeUsageLimitError / spending cap /
  // Insufficient balance) is mis-classified as transient by upstream harnesses
  // and the run only ends when the activity-timeout watchdog fires (see #778).
  // when we recognise the billing label, replace the generic "stalled - auth
  // error" headline with a billing-specific CTA that names the actual remedy.
  if (input.diagnostic.lastProviderError === "provider billing exhausted") {
    return formatBillingExhaustedBody(input.diagnostic);
  }

  const verb = input.isHang ? "stalled" : "failed";
  const cause = input.diagnostic.lastProviderError
    ? ` - likely cause: \`${input.diagnostic.lastProviderError}\``
    : "";
  const headline = `**${input.diagnostic.label} ${verb}**${cause}`;

  const explanation = formatExplanation({
    isHang: input.isHang,
    errorMessage: input.errorMessage,
    idleSec: input.diagnostic.idleSec,
  });
  const parts = [headline, "", `${explanation} ${formatEventsPart(input.diagnostic)}`];

  const tail = renderStderrTail(input.diagnostic.recentStderr);
  if (tail) {
    // pick a fence longer than any backtick run in the body so a stderr line
    // containing ``` (provider error JSON occasionally embeds it) can't
    // terminate the fence early and corrupt the rest of the markdown.
    const fence = pickFence(tail);
    parts.push(
      "",
      "<details><summary>Recent agent stderr</summary>",
      "",
      fence,
      tail,
      fence,
      "",
      "</details>"
    );
  }

  return parts.join("\n");
}

function formatExplanation(input: {
  isHang: boolean;
  errorMessage: string;
  idleSec: number | undefined;
}): string {
  if (!input.isHang) return `The agent exited unexpectedly: ${input.errorMessage}`;
  const idleSec = input.idleSec ?? parseIdleSec(input.errorMessage);
  if (idleSec === undefined) {
    return "The agent stopped emitting events and was killed by the activity-timeout watchdog.";
  }
  return `The agent stopped emitting events for ${idleSec}s and was killed by the activity-timeout watchdog.`;
}

/** fallback for the v1 spawn path, whose reject string embeds the span. */
function parseIdleSec(message: string): number | undefined {
  const match = /no output for (\d+)s/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function formatEventsPart(diagnostic: AgentDiagnostic): string {
  // when the provider-error label already names the cause in the headline,
  // the nudges below contradict it (e.g. an immediate 401 also produces no
  // model output but isn't a reachability problem). suppress them.
  if (diagnostic.lastProviderError) {
    return `${diagnostic.eventCount} events were processed before the failure.`;
  }
  // the stall in #1120: the turn is under way but the model never produced a
  // part. keyed off `sawModelOutput`, not `eventCount` - see AgentDiagnostic.
  if (!diagnostic.sawModelOutput) {
    return "The model produced no output at all before the stall - the request was sent but nothing came back. This is usually transient; re-running often succeeds.";
  }
  return `${diagnostic.eventCount} events were processed before the failure.`;
}

function renderStderrTail(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  if (joined.length <= MAX_STDERR_BYTES) return joined;
  return `... (older lines truncated)\n${joined.slice(-MAX_STDERR_BYTES)}`;
}

function pickFence(content: string): string {
  let max = 0;
  for (const match of content.matchAll(/`+/g)) {
    if (match[0].length > max) max = match[0].length;
  }
  return "`".repeat(Math.max(3, max + 1));
}

/**
 * Pull a billing URL out of the captured stderr if the provider helpfully
 * embedded one (OpenCode Zen does - Anthropic and Gemini do not). Restricted
 * to known billing/console hosts so a stray URL elsewhere in the buffer
 * can't masquerade as the remedy link.
 */
function extractBillingUrl(lines: readonly string[]): string | undefined {
  const urlPattern =
    /https:\/\/(?:opencode\.ai\/[^\s"]*billing[^\s"]*|console\.anthropic\.com[^\s"]*|console\.cloud\.google\.com[^\s"]*billing[^\s"]*)/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = urlPattern.exec(lines[i] ?? "");
    if (m) return m[0];
  }
  return undefined;
}

function formatBillingExhaustedBody(diagnostic: AgentDiagnostic): string {
  const headline = `**${diagnostic.label} stopped** - your model provider returned a billing-exhausted response.`;

  const billingUrl = extractBillingUrl(diagnostic.recentStderr);
  const cta = billingUrl
    ? `Top up your provider balance, then re-run: [${billingUrl}](${billingUrl})`
    : "Top up your model-provider balance (or rotate to a key with remaining credits) and re-run.";
  const explanation =
    "The agent kept retrying the request because the provider marked the failure as transient. Polaris's activity-timeout watchdog ended the run after no further events were emitted.";

  const parts = [headline, "", explanation, "", cta];

  const tail = renderStderrTail(diagnostic.recentStderr);
  if (tail) {
    const fence = pickFence(tail);
    parts.push(
      "",
      "<details><summary>Recent agent stderr</summary>",
      "",
      fence,
      tail,
      fence,
      "",
      "</details>"
    );
  }

  return parts.join("\n");
}
