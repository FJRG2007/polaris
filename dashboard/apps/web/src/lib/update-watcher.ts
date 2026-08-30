/**
 * Noticing that Polaris has an update, and acting on it.
 *
 * Two jobs on one loop. The first is that a published build reaches the people
 * who can install it: without this, an update is only ever found by opening
 * Settings, so a deployment nobody visits stays behind indefinitely. The second
 * is installing it unattended, when the deployment has been told to - straight
 * away, or at a set time of day so the restart lands when the box is idle.
 *
 * Everything that must happen once is claimed in the settings table rather than
 * held in memory. Two web containers serve at the same time during a rollover,
 * and both run this loop: a fact kept in a process would announce twice and, far
 * worse, could start two updates at once. Each claim is a conditional write, so
 * exactly one container wins it and the loser does nothing.
 *
 * The claims are keyed by the published build, so the announcement, the install
 * and the report of a failed install each happen once per version - never once
 * per tick, and never again for a version already dealt with. A failed install
 * is reported and then left alone: retrying a broken update every few minutes is
 * how one bad build takes a deployment down all night.
 */

import { prisma } from "@polaris/db";
import { getUpdateSource } from "@/lib/update-source";
import { getUpdateStatus } from "@/lib/update-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { notifyOperators } from "@/lib/notifications/operators";
import { sweepExpiringModelKeys } from "@/lib/agents/model-key-expiry";
import { refreshModelCatalogIfStale } from "@/lib/agents/model-catalog";
import { markNotificationsReadByType } from "@/lib/notification-service";
import { notifyGithubPermissionGap } from "@/lib/integrations/github-permission-notice";
import { lastUpdateOutcome, publishUpdateSource, startHostUpdate, updateTriggerReason, type UpdateTrigger } from "@/lib/update-runner";
import {
    autoUpdateRunsAt,
    parseAutoUpdatePolicy,
    stringifyAutoUpdatePolicy,
    type AutoUpdatePolicy,
    type NotificationLevel,
    type Permission
} from "@polaris/core";

/** Who is told about an update - the same people allowed to install one. */
const UPDATE_PERMISSION: Permission = "system.manage";

/** The alerts this file raises, and therefore the ones it retires once the build
 *  they are about is the one being served. */
const UPDATE_EVENTS = ["system.update", "system.updated"] as const;

/**
 * The alert that says an update is waiting, on its own.
 *
 * Superseded rather than accumulated. Only the newest of these is worth
 * anything: installing takes the deployment to the latest build, never to the
 * one an older alert happened to name, so a bell holding five of them is one
 * instruction and four that are wrong. It is answered by the install as well,
 * whichever build was named.
 *
 * Kept apart from `system.updated`, which reports what happened - an install
 * that started, or one that failed. Those have to outlive the next
 * announcement: a failure swept away by the following build's alert is a
 * deployment that quietly stopped updating and told nobody twice.
 */
const READY_EVENT = "system.update";

const POLICY_KEY = "updates.auto";
const ANNOUNCED_KEY = "updates.announced";
const INSTALLED_KEY = "updates.installed";

/** Close enough that a schedule set to 05:00 runs at 05:00, cheap enough to
 *  leave running: the status behind it is cached, so most ticks read nothing. */
const INTERVAL_MS = Number(process.env.POLARIS_UPDATE_WATCH_MS) || 5 * 60_000;
/** Let the deployment finish coming up before reaching for the registry. */
const FIRST_PASS_MS = 40_000;

let started = false;

/** How this deployment installs updates on its own. */
export async function getAutoUpdatePolicy(): Promise<AutoUpdatePolicy> {
    return parseAutoUpdatePolicy(await getSetting(POLICY_KEY));
}

export async function saveAutoUpdatePolicy(policy: AutoUpdatePolicy): Promise<void> {
    await setSetting(POLICY_KEY, stringifyAutoUpdatePolicy(policy));
}

/**
 * Take one fact about one build, once, whichever container gets there first.
 *
 * The row is written only when it is not already about this build, which is a
 * single conditional statement in the database and therefore a decision only one
 * caller can win. Returns false for everyone else.
 */
async function claim(key: string, sha: string, value: string): Promise<boolean> {
    try {
        await prisma.setting.create({ data: { key, value, scope: "global" } });
        return true;
    } catch {
        // The row exists (or the create raced another one): move it on only if it
        // is still about an older build.
        const taken = await prisma.setting.updateMany({
            where: { key, NOT: { value: { startsWith: `${sha} ` } } },
            data: { value }
        });
        return taken.count === 1;
    }
}

/** Tell everyone who could act on this. One alert each, through their own rules. */
async function tellOperators(input: {
    event: string;
    title: string;
    body: string;
    level?: NotificationLevel;
    actionRequired?: boolean;
}): Promise<void> {
    await notifyOperators({ ...input, permission: UPDATE_PERMISSION, href: "/admin/settings" });
}

/**
 * When this deployment first saw the published build, which is what a daily
 * schedule counts from. Announces it on the way, if this container is the one
 * that noticed.
 */
async function firstSeen(sha: string, policy: AutoUpdatePolicy): Promise<Date> {
    const now = new Date();
    if (await claim(ANNOUNCED_KEY, sha, `${sha} ${now.toISOString()}`)) {
        // Before raising this one, put down the ones it replaces - they name
        // builds this announcement supersedes. Done here rather than in the
        // reader so what reaches a phone or a chat webhook is superseded too,
        // and so the bell holds the latest rather than the pile.
        await markNotificationsReadByType([READY_EVENT]);
        const plan =
            policy.mode === "daily"
                ? `It installs itself at ${policy.at}, or install it now from Settings.`
                : policy.mode === "immediate"
                  ? "It is being installed now."
                  : "Install it from Settings, where you can also see what changed.";
        await tellOperators({
            event: "system.update",
            title: "A Polaris update is ready to install",
            body: `Build ${sha}. ${plan}`,
            actionRequired: policy.mode === "off"
        });
        return now;
    }
    const stored = (await getSetting(ANNOUNCED_KEY))?.split(" ")[1];
    const at = stored ? new Date(stored) : null;
    return at && !Number.isNaN(at.getTime()) ? at : now;
}

/**
 * Start an update on the host, having first told it which kind to run. The two
 * go together everywhere - the button in Settings and the schedule below - so a
 * deployment that was switched to building its own image while the shared file
 * was unwritable still gets the update it asked for rather than the other one.
 */
export async function startUpdate(): Promise<UpdateTrigger> {
    await publishUpdateSource(await getUpdateSource());
    return startHostUpdate();
}

/** Start the install, and say whether it got going. */
async function install(sha: string): Promise<void> {
    const trigger = await startUpdate();
    if (trigger === "started") {
        await tellOperators({
            event: "system.updated",
            title: "Polaris is installing an update",
            body: `Build ${sha}. The dashboard keeps serving while the new build starts; Settings shows the log.`
        });
        return;
    }
    // Nothing was started, so nothing will report back: this is the only chance
    // to say that an unattended update did not happen.
    await setSetting(INSTALLED_KEY, `${sha} failed`);
    await tellOperators({
        event: "system.updated",
        title: "Polaris could not install an update",
        body: `${updateTriggerReason(trigger)} Build ${sha} can still be installed from Settings, or with "polaris update" on the host.`,
        level: "danger",
        actionRequired: true
    });
}

/**
 * Report an install that was started and never landed.
 *
 * Reached only when this deployment started an install for a build it is still
 * not running, so a successful update never comes through here - it takes the
 * new build's own container past the "nothing to do" check at the top of a tick.
 * A run still writing its log has not failed yet, and one that ended without a
 * code cannot be called either way, so both are left for the next tick.
 *
 * The result has to be newer than the install that was started, because the log
 * still holds the last run's exit marker until this one gets far enough to
 * truncate it - and "far enough" can mean after a slow pull of the updater
 * image. Without the comparison a previous failure is reported as this one, and
 * the real result is then never reported at all.
 */
async function reportFailedInstall(sha: string): Promise<void> {
    const startedAt = Date.parse((await getSetting(INSTALLED_KEY))?.split(" ")[2] ?? "");
    if (Number.isNaN(startedAt)) return;
    const outcome = await lastUpdateOutcome();
    if (!outcome || outcome.exitCode === null || outcome.exitCode === 0) return;
    if (outcome.endedAt < startedAt) return;
    const claimed = await prisma.setting.updateMany({
        where: { key: INSTALLED_KEY, value: { startsWith: `${sha} started` } },
        data: { value: `${sha} failed` }
    });
    if (claimed.count !== 1) return;
    await tellOperators({
        event: "system.updated",
        title: "A Polaris update failed to install",
        body: `Build ${sha}. The updater stopped with exit code ${outcome.exitCode}; Settings has the log and can report it.`,
        level: "danger",
        actionRequired: true
    });
}

/**
 * Put down the alerts about a build that has now landed.
 *
 * Everything raised here - the announcement, the install, a failure along the
 * way - is about a version that was not being served yet. Once it is, none of it
 * describes anything left to do, and an operator should not have to empty their
 * bell by hand after every release. The container that notices is the new build's
 * own: it is the one whose stamp matches what was announced.
 *
 * Both rows are dropped rather than marked, which is what makes this happen once
 * across the containers serving at the same time - the delete is a conditional
 * write exactly one of them can win. A later build re-announces itself normally,
 * since the claims are keyed by version and this one's are gone with it.
 */
async function retireLandedNotices(current: string | null): Promise<void> {
    if (!current) return;
    const announced = (await getSetting(ANNOUNCED_KEY))?.split(" ")[0];
    if (announced !== current) return;
    const claimed = await prisma.setting.deleteMany({
        where: { key: ANNOUNCED_KEY, value: { startsWith: `${current} ` } }
    });
    if (claimed.count !== 1) return;
    await prisma.setting.deleteMany({ where: { key: INSTALLED_KEY, value: { startsWith: `${current} ` } } });
    await markNotificationsReadByType(UPDATE_EVENTS);
}

/** One pass: notice, then install if it is time to. */
export async function checkForUpdate(): Promise<void> {
    const status = await getUpdateStatus();
    // Before anything else: the build this deployment was told about may be the
    // one it is now serving, in which case what it was told is answered.
    await retireLandedNotices(status.current);
    // And whatever build they named, an alert saying an update is ready to
    // install is answered the moment there is nothing left to install. That is
    // the case the check above misses: it only recognises the build it last
    // announced, so an operator who installed while a newer one was already
    // announced kept an "Action needed" for work they had done.
    if (status.upToDate) await markNotificationsReadByType([READY_EVENT]);
    // Only a published image that this deployment can actually move to. Anything
    // else - up to date, still building, a commit that failed its checks - is
    // nothing to announce and nothing to install.
    if (status.phase !== "available" || !status.latest) return;
    const sha = status.latest;

    const policy = await getAutoUpdatePolicy();
    const seen = await firstSeen(sha, policy);

    const runsAt = autoUpdateRunsAt(policy, seen);
    if (!runsAt || Date.now() < runsAt.getTime()) return;

    // The moment goes in the row: it is what tells this run's result from the one
    // still sitting in the log the updater has not truncated yet.
    if (await claim(INSTALLED_KEY, sha, `${sha} started ${new Date().toISOString()}`)) {
        await install(sha);
        return;
    }
    await reportFailedInstall(sha);
}

export function startUpdateWatcher(): void {
    if (started) return;
    started = true;
    const tick = (): void => {
        void checkForUpdate().catch((error) => console.error("polaris: update watcher tick failed:", error));
        // Rides along rather than starting a timer of its own: both ask "is this
        // deployment waiting on somebody", both are cheap when the answer is no,
        // and one interval is one thing to reason about. An update that widened
        // the App's permissions is also exactly when a new gap appears.
        void notifyGithubPermissionGap();
        // Same reasoning, and the same shape: an indexed read on almost every
        // tick, one download a day. Nothing waits on it - the model pickers cope
        // with an empty catalogue - so a failure is logged at debug and retried
        // on the next tick rather than reported to anybody.
        void refreshModelCatalogIfStale().catch(() => undefined);
        // And again: an indexed read that matches nothing on a deployment where
        // nobody has given a key an end date. It has to run on a timer rather
        // than when somebody opens a screen, because the whole point is telling
        // them before the morning a run stops working.
        void sweepExpiringModelKeys().catch(() => undefined);
    };
    setTimeout(tick, FIRST_PASS_MS).unref();
    setInterval(tick, INTERVAL_MS).unref();
}
