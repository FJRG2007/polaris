/**
 * reasoning effort, stored as a POSITION rather than a name.
 *
 * a rung name is only meaningful inside the model that published it: `high` is
 * DeepSeek's floor and Opus's midpoint, and a model is free to call its rungs
 * anything at all. so a stored name is untransferable the moment the model
 * changes underneath the setting - which happens without anyone editing it (the
 * org default cascades, the Router clamps by card status, an `auto/*` tier
 * resolves to a concrete model, a `--model=` flag overrides per run, and the
 * models-bump cron can rewrite a ladder under a stored value).
 *
 * a position on [0, 1] has no such problem: 0 is whatever that model calls its
 * cheapest rung and 1 is whatever it calls its most expensive. resolution is a
 * lookup into the model's own published ladder, so the result is always a rung
 * that model actually offers. an invalid effort is unrepresentable rather than
 * merely guarded against.
 *
 * neither harness needs us to know a provider's wire format: claude-code takes
 * `--effort <level>` and opencode takes `--variant <level>`, and each owns the
 * per-model, per-transport translation upstream.
 */

/** a point on the effort axis. 0 = the model's cheapest rung, 1 = its most expensive. */
export type EffortPosition = number;

/**
 * where a repo sits when it has never configured effort.
 *
 * 0.5 is not a round number picked for feel - it is EXACTLY the position `high`
 * occupies on a five-rung ladder (`2/4`), so the default and a user clicking
 * **High** in the console store the same value. It lands on `high` for the
 * Claude and GPT flagships, Kimi K3 and DeepSeek, and `medium` on a three-rung
 * ladder. That keeps the flagships at the level every model already effectively
 * ran at before this setting existed.
 */
export const DEFAULT_EFFORT_POSITION: EffortPosition = 0.5;

/**
 * names we accept on user-facing surfaces (`--effort=`, the action input),
 * mapped to fixed points on the axis. these are a typing convenience, NOT an
 * ordering authority - a model's own ladder decides what each point resolves to.
 * a 5-rung ladder lands each of these on its own rung; a shorter one folds them
 * together, which is the correct behaviour rather than a lossy one.
 */
export const EFFORT_ALIASES: Readonly<Record<string, EffortPosition>> = {
  low: 0,
  medium: 0.25,
  high: 0.5,
  xhigh: 0.75,
  max: 1,
};

/** rung names that mean "don't reason", which no review or build run wants. */
const DISABLING_RUNGS: readonly string[] = ["none", "minimal"];

export function isEffortPosition(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * parse a user-supplied effort into a position. accepts a name (`high`, `MED`)
 * or a bare number (`0.75`). returns undefined for anything else, so a typo
 * stays visible in the prose instead of silently becoming a level.
 */
export function parseEffortPosition(raw: string): EffortPosition | undefined {
  const normalized = raw.trim().toLowerCase();
  const named = EFFORT_ALIASES[normalized === "med" ? "medium" : normalized];
  if (named !== undefined) return named;
  const numeric = Number(normalized);
  return normalized !== "" && isEffortPosition(numeric) ? numeric : undefined;
}

/**
 * the rungs a model offers a user: its published ladder minus the ones that turn
 * reasoning off. order is the publisher's, already ascending - we never reorder
 * it, because the array IS the scale.
 */
export function offeredRungs(published: readonly string[]): readonly string[] {
  return published.filter((rung) => !DISABLING_RUNGS.includes(rung));
}

/**
 * land a position on a model's ladder. the result is always a rung the model
 * published, or undefined when it publishes none - there is no arithmetic here
 * that can produce a name the model doesn't have.
 *
 * a position between two rungs ALWAYS rounds DOWN, so it never costs more than
 * was asked for. a rung's own position lands back on itself exactly (pinned by
 * the round-trip test over every registry ladder), so rounding down never
 * undershoots a level the user actually picked.
 */
export function resolveRung(params: {
  position: EffortPosition;
  published: readonly string[];
}): string | undefined {
  const rungs = offeredRungs(params.published);
  if (rungs.length === 0) return undefined;
  const clamped = Math.min(1, Math.max(0, params.position));
  return rungs[Math.floor(clamped * (rungs.length - 1))];
}

/**
 * the position a rung sits at within its own ladder - the inverse of
 * `resolveRung`, used when a user picks a rung in the console. a single-rung
 * ladder has no axis to speak of, so its one rung is the floor.
 */
export function rungPosition(params: {
  rung: string;
  published: readonly string[];
}): EffortPosition | undefined {
  const rungs = offeredRungs(params.published);
  const index = rungs.indexOf(params.rung);
  if (index === -1) return undefined;
  return rungs.length > 1 ? index / (rungs.length - 1) : 0;
}

/** human label for a rung, for models whose names aren't already presentable. */
export function rungLabel(rung: string): string {
  const known: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
  return known[rung] ?? rung.charAt(0).toUpperCase() + rung.slice(1);
}
