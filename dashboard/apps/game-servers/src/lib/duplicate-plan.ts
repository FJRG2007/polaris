/**
 * What a duplicate of a server is made of, decided without touching anything.
 *
 * A copy has to be a whole server of its own: the same game, settings, mods,
 * world and rules, and nothing the two would fight over. The fights are the
 * point of this module - two servers answering to one RCON password, one plugin
 * reporting itself under the other's id, one port published twice - so the rules
 * for each are written down here, as data, where a test can hold them.
 *
 * Pure: the service reads the source and does the work; this only answers.
 */

import { z } from "zod";
import { gameMessage } from "./game-message";

/** Where a copy in progress keeps how far it has got, on the copy's own config. */
export const DUPLICATE_KEY = "duplicating";

/** The longest a server name may be - the create form's limit. */
export const SERVER_NAME_MAX = 48;

/** What the dialog sends and the action checks, from the same schema. */
export const duplicateServerSchema = z.object({
    installedAppId: z.string().uuid(),
    name: z
        .string()
        .transform(normalizeServerName)
        .pipe(
            z
                .string()
                .min(1, gameMessage("games", "duplicate.nameRequired"))
                .max(SERVER_NAME_MAX, gameMessage("games", "duplicate.nameTooLong", { max: SERVER_NAME_MAX }))
        )
});

export type DuplicateServerInput = z.input<typeof duplicateServerSchema>;

/** One shape for a name on both sides: trimmed, inner runs of space made one. */
export function normalizeServerName(name: string): string {
    return name.trim().replace(/\s+/g, " ");
}

/** Whether a name is already one of these servers', the way a person reads it. */
export function nameTaken(name: string, taken: Iterable<string>): boolean {
    const wanted = normalizeServerName(name).toLowerCase();
    for (const existing of taken) if (normalizeServerName(existing).toLowerCase() === wanted) return true;
    return false;
}

/**
 * The name a copy is offered under: "<name> copy", numbered the way a file
 * manager numbers them when that is taken too, and shortened from the source's
 * end so the word that says what it is always fits.
 *
 * `word` is the localized pattern, called with the base (and the number from the
 * second on), so the order of name and word is the language's and not this file's.
 */
export function defaultCopyName(
    name: string,
    taken: Iterable<string>,
    word: (base: string, count: number | null) => string
): string {
    const names = [...taken];
    const base = normalizeServerName(name);
    for (let count = 1; count < 100; count += 1) {
        const numbered = count === 1 ? null : count;
        const room = SERVER_NAME_MAX - word("", numbered).length;
        const candidate = normalizeServerName(word(base.slice(0, Math.max(1, room)).trim(), numbered));
        if (!nameTaken(candidate, names)) return candidate;
    }
    return normalizeServerName(word(base.slice(0, 20), Date.now() % 1000));
}

/** Who may duplicate a server, and the reason shown to everybody else. */
export type DuplicatePermission =
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: "cannot-create" | "not-owner" };

/**
 * A copy is a new server, so it takes what creating one takes; and it is a copy
 * of somebody's world and settings, so it takes what deleting this one takes -
 * being the person who created it, or an administrator. Being invited to help run
 * a server was never an offer to clone it into the owner's account.
 */
export function duplicatePermission(who: {
    readonly canCreate: boolean;
    readonly isOwner: boolean;
    readonly isAdmin: boolean;
}): DuplicatePermission {
    if (!who.canCreate) return { allowed: false, reason: "cannot-create" };
    if (!who.isOwner && !who.isAdmin) return { allowed: false, reason: "not-owner" };
    return { allowed: true };
}

/**
 * Config keys that describe what the source has been doing rather than what it
 * is, or that point outward at something only one server may hold. Everything
 * else in the config is a setting and travels.
 *
 * Dropped rather than listed as what travels, because a setting added next month
 * should be copied without anybody remembering this file; a piece of runtime
 * state added next month is at worst a stale note on a copy that corrects itself
 * on its first sweep.
 */
export const DROPPED_CONFIG_KEYS: readonly string[] = [
    // The address: provisioned for the copy under its own name.
    "hostname",
    "portless",
    // A relay into a conversation or a call: two servers posting into one
    // channel is exactly the fight a copy must not start.
    "chatLink",
    "callGroupId",
    // What the source has been through.
    "crashLoop",
    "onlineSince",
    "emptySince",
    "lastOnlineAt",
    "pendingRestart",
    "memoryExhaustedAt",
    "memoryWatch",
    "restartWatch",
    "routineRuns",
    "scheduleCheckedAt",
    "wokenAt",
    "worldTrimRun",
    "eventState",
    "challengeState",
    "lastDeath",
    "backupFailure",
    "modsChangedAt",
    "fivemAccessDigest",
    "playerTimeouts",
    "updating",
    DUPLICATE_KEY
];

/** Swap every occurrence of each `from` for its `to`, in order. */
export function substitute(value: string, substitutions: readonly (readonly [string, string])[]): string {
    let out = value;
    for (const [from, to] of substitutions) if (from.length > 0) out = out.split(from).join(to);
    return out;
}

/**
 * The copy's config: the source's settings, its runtime state and outward links
 * dropped, and anything that named the source re-pointed at the copy.
 */
export function copiedConfig(
    config: Readonly<Record<string, unknown>>,
    substitutions: readonly (readonly [string, string])[]
): Record<string, unknown> {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
        if (!DROPPED_CONFIG_KEYS.includes(key)) kept[key] = value;
    }
    // Ids and tokens are hex and dashes, which JSON never escapes, so swapping
    // them in the serialized form reaches every nested value at once.
    return JSON.parse(substitute(JSON.stringify(kept), substitutions)) as Record<string, unknown>;
}

/** One environment variable. */
export interface EnvEntry {
    readonly key: string;
    readonly value: string;
    readonly isSecret: boolean;
}

/**
 * The copy's environment: the source's, with every credential the two would
 * share minted again, every value that named the source re-pointed, and the
 * values the caller has to decide (ports) written over the top.
 *
 * `remint` names the variables whose value is a credential of this server, with
 * how to mint a new one. Only the ones the source actually has are written -
 * a server that never had an RCON password does not gain one here.
 */
export function copiedEnv(input: {
    readonly env: readonly EnvEntry[];
    readonly remint: Readonly<Record<string, () => string>>;
    readonly substitutions: readonly (readonly [string, string])[];
    readonly overrides?: Readonly<Record<string, string>>;
}): EnvEntry[] {
    const out = new Map<string, EnvEntry>();
    for (const entry of input.env) {
        const mint = input.remint[entry.key];
        out.set(entry.key, {
            key: entry.key,
            value: mint ? mint() : substitute(entry.value, input.substitutions),
            isSecret: mint ? true : entry.isSecret
        });
    }
    for (const [key, value] of Object.entries(input.overrides ?? {})) {
        out.set(key, { key, value, isSecret: out.get(key)?.isSecret ?? false });
    }
    return [...out.values()];
}

/** The steps a copy goes through, in order, plus the one it can end on instead. */
export const DUPLICATE_STAGES = ["preparing", "stopping", "copying", "starting", "failed"] as const;
export type DuplicateStage = (typeof DUPLICATE_STAGES)[number];

/** Why a copy failed, as the key of the sentence that says so. */
export const DUPLICATE_FAILURES = [
    "noSpace",
    "copyFailed",
    "timedOut",
    "wrongVolume",
    "startFailed",
    "interrupted",
    "neverDeployed"
] as const;
export type DuplicateFailure = (typeof DUPLICATE_FAILURES)[number];

/** How far a copy has got, as kept on the copy's config. */
export interface DuplicateState {
    readonly from: string;
    readonly fromName: string;
    readonly stage: DuplicateStage;
    readonly copiedBytes: number;
    readonly totalBytes: number | null;
    readonly failure: DuplicateFailure | null;
    readonly needBytes: number | null;
    readonly freeBytes: number | null;
    /** Whether the source was up when the copy began, so it is brought back -
     *  by the copy, by a retry, or by the boot after a copy was cut short. */
    readonly sourceWasRunning: boolean;
    readonly startedAt: string;
}

/** A state read back off a config, or null when it is not one. */
export function readDuplicateState(config: Readonly<Record<string, unknown>>): DuplicateState | null {
    const raw = config[DUPLICATE_KEY];
    if (typeof raw !== "object" || raw === null) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.from !== "string" || !DUPLICATE_STAGES.includes(value.stage as DuplicateStage))
        return null;
    const number = (field: unknown): number | null =>
        typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : null;
    return {
        from: value.from,
        fromName: typeof value.fromName === "string" ? value.fromName : "",
        stage: value.stage as DuplicateStage,
        copiedBytes: number(value.copiedBytes) ?? 0,
        totalBytes: number(value.totalBytes),
        failure: DUPLICATE_FAILURES.includes(value.failure as DuplicateFailure)
            ? (value.failure as DuplicateFailure)
            : null,
        needBytes: number(value.needBytes),
        freeBytes: number(value.freeBytes),
        sourceWasRunning: value.sourceWasRunning === true,
        startedAt: typeof value.startedAt === "string" ? value.startedAt : ""
    };
}

/** Whole percent copied, or null while the size is not known yet. Never 100
 *  before the copy has said it finished. */
export function copyPercent(state: Pick<DuplicateState, "copiedBytes" | "totalBytes">): number | null {
    if (state.totalBytes === null) return null;
    if (state.totalBytes === 0) return 99;
    return Math.min(99, Math.floor((state.copiedBytes / state.totalBytes) * 100));
}

/** Whether a stage still holds the source down, so nothing else may start it. */
export function holdsSource(stage: DuplicateStage): boolean {
    return stage === "preparing" || stage === "stopping" || stage === "copying";
}

/** The refusal codes the dashboard's copy service throws, as failure keys. */
export function failureFor(code: string): DuplicateFailure {
    switch (code) {
        case "no-space":
            return "noSpace";
        case "timed-out":
            return "timedOut";
        case "wrong-volume":
            return "wrongVolume";
        case "never-deployed":
            return "neverDeployed";
        default:
            return "copyFailed";
    }
}

/**
 * Host ports a copy is published on: one per published port of the source,
 * each the first free one from where the source's sits, and never one already
 * handed to an earlier port of the same copy - the registry only knows ports
 * that are saved, and none of these are yet.
 */
export async function nextFreePorts(
    wanted: readonly { readonly from: number; readonly protocol: "tcp" | "udp" }[],
    free: (from: number, protocol: "tcp" | "udp") => Promise<number>
): Promise<number[]> {
    const handed = new Set<string>();
    const out: number[] = [];
    for (const port of wanted) {
        let from = port.from;
        let found = await free(from, port.protocol);
        while (handed.has(`${found}/${port.protocol}`)) {
            from = found + 1;
            found = await free(from, port.protocol);
        }
        handed.add(`${found}/${port.protocol}`);
        out.push(found);
    }
    return out;
}

/** Bytes as somebody reads them on a disk-space message. */
export function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
