/**
 * Installed apps keeping up with their own releases, with nobody pressing
 * Update: the background half of `releases.ts`.
 *
 * The model is the device add-ons' (`desktop/src/main/addons/updates.ts`): a
 * pass a minute after start and every six hours after, retried from five
 * minutes, doubling, while the registry cannot be reached. A newer release goes
 * in by itself through the same verified update the screen runs, unless
 * automatic updates are off for it or for every app, it asks to reach something
 * an administrator never accepted, or that release already failed here. The
 * release it replaced stays on the volume and is put back when the new one does
 * not keep running. Each release is announced once, to the administrators who
 * can act on it, with what it changes.
 *
 * Everything it keeps is a setting row with a default in code, so an install
 * from before this needs nothing written anywhere to take part.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { loadedBundle } from "./loader";
import { appFailure } from "./lifecycle";
import { readBundleState } from "./store";
import { findApp } from "@/lib/apps/catalog";
import { DEFAULT_LOCALE } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { getSetting, setSetting } from "@/lib/setting-store";
import { notifyOperators } from "@/lib/notifications/operators";
import {
    appReleaseStatuses,
    rollbackApp,
    updateApp,
    type AppReleaseStatus
} from "./releases";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How often installed apps are compared with their releases. */
export const PASS_EVERY_MS = 6 * HOUR;
/** The first retry after a pass that could not reach the registry; doubled each time. */
export const RETRY_FROM_MS = 5 * MINUTE;
/** Let the dashboard finish coming up before the first pass. */
const FIRST_PASS_AFTER_MS = MINUTE;
/** How long a new release has to keep running before it counts as healthy. */
const HEALTH_GRACE_MS = 15_000;
/** Failed releases remembered per app, newest last. */
const MAX_FAILED = 5;

const POLICY_KEY = "apps.updates.policy";
const STATE_KEY = "apps.updates.state";
const WAITING_KEY = "apps.updates.waiting";

const AppId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/**
 * Whether apps update by themselves: one switch for all, and an override per
 * app. On by default, as device add-ons are.
 */
const PolicySchema = z.object({
    auto: z.boolean().catch(true),
    apps: z.record(AppId, z.boolean()).catch({})
});
export type AppUpdatePolicy = z.infer<typeof PolicySchema>;
export const DEFAULT_POLICY: AppUpdatePolicy = { auto: true, apps: {} };

const AppStateSchema = z.object({
    /** The release last announced, so each one is announced once. */
    announced: z.string().max(80).optional(),
    /** Releases that failed here and are not tried by themselves again. */
    failed: z.array(z.string().max(80)).max(MAX_FAILED).optional(),
    /** What an administrator accepted the app reaching. */
    accepted: z.array(z.string().max(64)).max(32).optional()
});
type AppState = z.infer<typeof AppStateSchema>;
const StateSchema = z.record(AppId, AppStateSchema);
type State = z.infer<typeof StateSchema>;

function readJson<S extends z.ZodTypeAny>(raw: string | null, schema: S, fallback: z.output<S>): z.output<S> {
    if (!raw) return fallback;
    try {
        const parsed = schema.safeParse(JSON.parse(raw));
        return parsed.success ? (parsed.data as z.output<S>) : fallback;
    } catch {
        return fallback;
    }
}

export async function readAppUpdatePolicy(): Promise<AppUpdatePolicy> {
    return readJson(await getSetting(POLICY_KEY), PolicySchema, DEFAULT_POLICY);
}

export async function writeAppUpdatePolicy(policy: AppUpdatePolicy): Promise<void> {
    await setSetting(POLICY_KEY, JSON.stringify(PolicySchema.parse(policy)));
}

/** Whether one app updates by itself: its own override, else the switch for all. */
export function autoFor(policy: AppUpdatePolicy, id: string): boolean {
    return policy.apps[id] ?? policy.auto;
}

async function readState(): Promise<State> {
    return readJson(await getSetting(STATE_KEY), StateSchema, {});
}

async function writeState(state: State): Promise<void> {
    await setSetting(STATE_KEY, JSON.stringify(state));
}

/** The apps whose update waits on an administrator, as the last pass found them. */
export async function appsWaitingOnUpdate(): Promise<string[]> {
    return readJson(await getSetting(WAITING_KEY), z.array(AppId).max(256), []);
}

/** What a release asks to reach that was never accepted, in its own order. */
export function newPermissions(
    asked: readonly string[] | undefined,
    accepted: readonly string[]
): string[] {
    const known = new Set(accepted);
    return (asked ?? []).filter((name) => !known.has(name));
}

export type AppUpdateDecision =
    /** Nothing newer, or nothing installed to update. */
    | "current"
    /** The newer release needs a newer Polaris: the dashboard's update brings it. */
    | "needsPolaris"
    /** Goes in by itself now. */
    | "apply"
    /** Automatic updates are off for it. */
    | "manual"
    /** It asks to reach something nobody accepted. */
    | "permissions"
    /** It already failed here. */
    | "failedBefore";

/** Whether a decision leaves the update waiting on a person. */
export function waitsOnPerson(decision: AppUpdateDecision): boolean {
    return decision === "manual" || decision === "permissions" || decision === "failedBefore";
}

/** What to do about one app's newest release. Pure, so every branch is asserted. */
export function decideAppUpdate(input: {
    readonly installed: string | null;
    readonly available: {
        readonly digest: string;
        readonly runs: boolean;
        readonly permissions?: readonly string[];
    } | null;
    readonly auto: boolean;
    readonly accepted: readonly string[];
    readonly failed: readonly string[];
}): { readonly decision: AppUpdateDecision; readonly newPermissions: readonly string[] } {
    const { installed, available } = input;
    if (!installed || !available || available.digest === installed)
        return { decision: "current", newPermissions: [] };
    if (!available.runs) return { decision: "needsPolaris", newPermissions: [] };
    const added = newPermissions(available.permissions, input.accepted);
    if (added.length > 0) return { decision: "permissions", newPermissions: added };
    if (input.failed.includes(available.digest))
        return { decision: "failedBefore", newPermissions: [] };
    return { decision: input.auto ? "apply" : "manual", newPermissions: [] };
}

/**
 * What an app was accepted reaching: what was recorded, else - for an install
 * from before this was recorded - what the release it runs asked for.
 */
function acceptedOf(row: AppState | undefined, status: AppReleaseStatus): string[] {
    return row?.accepted ?? [...(status.installed?.permissions ?? [])];
}

/** The decision for one app, as the screen and the pass both read it. */
export function decisionFor(
    status: AppReleaseStatus,
    policy: AppUpdatePolicy,
    row: AppState | undefined
): { readonly decision: AppUpdateDecision; readonly newPermissions: readonly string[] } {
    return decideAppUpdate({
        installed: status.installed?.digest ?? null,
        available: status.available,
        auto: autoFor(policy, status.id),
        accepted: acceptedOf(row, status),
        failed: row?.failed ?? []
    });
}

/** Each app's update decision, for the updates screen. */
export async function appUpdateDecisions(
    statuses: readonly AppReleaseStatus[]
): Promise<Record<string, { decision: AppUpdateDecision; newPermissions: readonly string[] }>> {
    const [policy, state] = await Promise.all([readAppUpdatePolicy(), readState()]);
    return Object.fromEntries(
        statuses.map((status) => [status.id, decisionFor(status, policy, state[status.id])])
    );
}

/**
 * An administrator updated an app from the screen: what its release asks to
 * reach is accepted from now on, and a release that failed before is theirs
 * to have tried again.
 */
export async function acceptAppRelease(id: string): Promise<void> {
    const pinned = await readBundleState(id);
    if (!pinned) return;
    const state = await readState();
    const row = state[id] ?? {};
    state[id] = {
        ...row,
        accepted: [...new Set([...(row.accepted ?? []), ...(pinned.current.permissions ?? [])])],
        failed: (row.failed ?? []).filter((digest) => digest !== pinned.current.digest)
    };
    await writeState(state);
}

/**
 * An administrator went back from a release on the screen: it is not put in
 * again by itself, which would undo what they just did on the next pass.
 */
export async function holdAppRelease(id: string, digest: string): Promise<void> {
    const state = await readState();
    const row = state[id] ?? {};
    state[id] = { ...failed(row, digest), announced: row.announced ?? digest };
    await writeState(state);
}

/** The administrators: updating an app is theirs (`requireAdmin` on its actions). */
async function admins(): Promise<string[]> {
    const rows = await prisma.user.findMany({
        where: { isAdmin: true, bannedAt: null, disabledAt: null },
        select: { id: true }
    });
    return rows.map((row) => row.id);
}

type Say = (t: NamespaceTranslator<"notices">) => { title: string; body: string };

/** Where an app's update is reviewed: its settings when it has a page of them. */
export function updateHref(id: string): string {
    return findApp(id)?.settingsAt
        ? `/admin/apps/${encodeURIComponent(id)}/settings#app-updates`
        : "/admin/updates#app-updates";
}

export interface PassDeps {
    readonly statuses: () => Promise<AppReleaseStatus[]>;
    readonly update: (id: string) => ReturnType<typeof updateApp>;
    readonly rollback: (id: string) => ReturnType<typeof rollbackApp>;
    /** Whether the release now serving is healthy after its grace. */
    readonly healthy: (id: string, digest: string) => Promise<boolean>;
    readonly recipients: () => Promise<string[]>;
    readonly tell: (input: {
        recipients: string[];
        event: "apps.update" | "apps.updated";
        id: string;
        say: Say;
        level?: "info" | "success" | "warning";
        actionRequired?: boolean;
    }) => Promise<void>;
}

async function healthyAfterGrace(id: string, digest: string): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, HEALTH_GRACE_MS));
    const loaded = loadedBundle(id);
    const pinned = await readBundleState(id);
    return Boolean(loaded) && !appFailure(id) && pinned?.current.digest === digest;
}

const DEFAULT_DEPS: PassDeps = {
    statuses: () => appReleaseStatuses({ check: true }),
    update: updateApp,
    rollback: rollbackApp,
    healthy: healthyAfterGrace,
    recipients: admins,
    tell: async ({ recipients, event, id, say, level, actionRequired }) => {
        if (recipients.length === 0) return;
        const words = say(translatorFor(DEFAULT_LOCALE, "notices"));
        await notifyOperators({
            permission: "system.manage",
            recipients,
            event,
            title: words.title,
            body: words.body,
            say,
            href: updateHref(id),
            level,
            actionRequired,
            metadata: { app: id }
        });
    }
};

export interface PassReport {
    readonly checked: number;
    readonly applied: string[];
    readonly rolledBack: string[];
    readonly waiting: string[];
    /** Some release could not be read: the pass is tried again soon. */
    unreachable: boolean;
}

const versionOf = (build: { version?: string; digest: string }) =>
    build.version ?? build.digest.replace(/^sha256:/, "").slice(0, 7);

/**
 * One pass over every installed app: announce what is new once, apply what may
 * go in by itself, put back what does not keep running.
 */
export async function runAppUpdatePass(deps: PassDeps = DEFAULT_DEPS): Promise<PassReport> {
    const [statuses, policy, state] = await Promise.all([
        deps.statuses(),
        readAppUpdatePolicy(),
        readState()
    ]);
    const report: PassReport = {
        checked: statuses.length,
        applied: [],
        rolledBack: [],
        waiting: [],
        unreachable: statuses.some((status) => status.checkFailed)
    };
    let recipients: string[] | null = null;
    const who = async () => (recipients ??= await deps.recipients().catch(() => []));

    for (const status of statuses) {
        const row: AppState = state[status.id] ?? {};
        const { decision, newPermissions: added } = decisionFor(status, policy, row);
        const available = status.available;
        if (decision === "current" || decision === "needsPolaris" || !available) continue;
        const name = findApp(status.id)?.name ?? status.id;
        const version = versionOf(available);
        const notes = available.notes;
        const fresh = row.announced !== available.digest;

        if (decision !== "apply") {
            report.waiting.push(status.id);
            if (fresh) {
                const say: Say = (t) => {
                    const plan =
                        decision === "permissions"
                            ? t("appUpdate.planPermissions", { permissions: added.join(", ") })
                            : t("appUpdate.planManual");
                    return {
                        title: t("appUpdate.readyTitle", { name, version }),
                        body: notes
                            ? t("appUpdate.readyBody", { notes, plan })
                            : t("appUpdate.readyBodyPlain", { plan })
                    };
                };
                await deps
                    .tell({
                        recipients: await who(),
                        event: "apps.update",
                        id: status.id,
                        say,
                        actionRequired: true
                    })
                    .catch(() => undefined);
                state[status.id] = { ...row, announced: available.digest };
            }
            continue;
        }

        const outcome = await deps.update(status.id);
        if (!outcome.ok) {
            // Unreachable, busy, or gone meanwhile: tried again on the next
            // pass, said nothing. Only a release that would not run is held.
            if (outcome.code !== "failed" && outcome.code !== "needsPolaris") {
                report.unreachable ||= outcome.code === "unreachable";
                continue;
            }
            state[status.id] = failed(row, available.digest);
            report.waiting.push(status.id);
            await deps
                .tell({
                    recipients: await who(),
                    event: "apps.updated",
                    id: status.id,
                    level: "warning",
                    say: (t) => ({
                        title: t("appUpdate.failedTitle", { name }),
                        body: t("appUpdate.failedBody", { version })
                    })
                })
                .catch(() => undefined);
            continue;
        }
        if (!outcome.changed) continue;

        if (!(await deps.healthy(status.id, available.digest).catch(() => false))) {
            const back = await deps.rollback(status.id);
            state[status.id] = failed(row, available.digest);
            report.rolledBack.push(status.id);
            report.waiting.push(status.id);
            const before = status.installed ? versionOf(status.installed) : version;
            await deps
                .tell({
                    recipients: await who(),
                    event: "apps.updated",
                    id: status.id,
                    level: "warning",
                    say: (t) =>
                        back.ok
                            ? {
                                  title: t("appUpdate.rolledBackTitle", { name, version: before }),
                                  body: t("appUpdate.rolledBackBody", { failed: version })
                              }
                            : {
                                  title: t("appUpdate.failedTitle", { name }),
                                  body: t("appUpdate.failedBody", { version })
                              }
                })
                .catch(() => undefined);
            continue;
        }

        report.applied.push(status.id);
        state[status.id] = { ...row, announced: available.digest };
        if (fresh) {
            await deps
                .tell({
                    recipients: await who(),
                    event: "apps.updated",
                    id: status.id,
                    level: "success",
                    say: (t) => ({
                        title: t("appUpdate.updatedTitle", { name, version }),
                        body: notes
                            ? t("appUpdate.updatedBody", { notes })
                            : t("appUpdate.updatedBodyPlain")
                    })
                })
                .catch(() => undefined);
        }
    }

    await writeState(state);
    await setSetting(WAITING_KEY, JSON.stringify(report.waiting));
    return report;
}

function failed(row: AppState, digest: string): AppState {
    const list = [...(row.failed ?? []).filter((one) => one !== digest), digest];
    return { ...row, announced: digest, failed: list.slice(-MAX_FAILED) };
}

type Pacing = { nextAt: number; retryMs: number; startedAt: number };
const pacing: Pacing = ((globalThis as Record<symbol, unknown>)[
    Symbol.for("polaris.app-bundles.auto-update")
] ??= { nextAt: 0, retryMs: RETRY_FROM_MS, startedAt: Date.now() }) as Pacing;

/** When the next pass is due after one ended, and the retry it leaves behind. */
export function nextPass(
    now: number,
    unreachable: boolean,
    retryMs: number
): { nextAt: number; retryMs: number } {
    if (!unreachable) return { nextAt: now + PASS_EVERY_MS, retryMs: RETRY_FROM_MS };
    const wait = Math.min(retryMs, PASS_EVERY_MS);
    return { nextAt: now + wait, retryMs: Math.min(retryMs * 2, PASS_EVERY_MS) };
}

/**
 * The scheduled job: a pass when one is due, nothing otherwise. The scheduler
 * calls it every few minutes so a retry can come early; the cadence is here.
 */
export async function tickAppUpdates(now = Date.now()): Promise<PassReport | { skipped: string }> {
    if (now - pacing.startedAt < FIRST_PASS_AFTER_MS) return { skipped: "Starting up" };
    if (now < pacing.nextAt) return { skipped: "Not due" };
    // Taken before the pass, so a pass that throws is not retried every tick.
    pacing.nextAt = now + pacing.retryMs;
    const report = await runAppUpdatePass();
    Object.assign(pacing, nextPass(Date.now(), report.unreachable, pacing.retryMs));
    return report;
}
