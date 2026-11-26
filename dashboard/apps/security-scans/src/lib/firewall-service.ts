/**
 * The host firewall on every managed server: read, planned from what runs
 * there, applied, and kept in step with what gets deployed.
 *
 * A change can cut the very connection it travels on, so it is never trusted
 * to have worked. The server undoes it by itself after 120 s unless Polaris
 * comes back - over a connection of its own - and confirms it under the same
 * id, the router app's way (`apps/web/src/lib/router/service.ts`).
 *
 * Default-deny closes whatever Polaris does not know about, so Polaris turns
 * it on by itself only where nothing listening would close (and says so);
 * anywhere else a person who has seen what would close turns it on, and
 * Polaris tells the owner once that the review waits on them. Once a person has turned it on, Polaris opens what gets deployed
 * there since - opening a port never locks anybody out.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { securityTFor } from "./i18n";
import { randomUUID } from "node:crypto";
import { host } from "@polaris/app-host";
import * as model from "../model/firewall";
import { hostHref } from "../model/landing";
import {
    hostActionNow,
    runHostAction,
    ScanFailure,
    withFirewallHold,
    type ScanTarget
} from "./runner";

const TARGET_SELECT = {
    id: true,
    ownerId: true,
    kind: true,
    hostId: true,
    runtime: true,
    proxyNetwork: true
} as const;

/** How long Polaris keeps trying to confirm, inside the server's own 120 s. */
const CONFIRM_MS = 100_000;
const CONFIRM_POLL_MS = 3_000;

export interface FirewallView {
    readonly state: model.FirewallState | "router";
    readonly plan: model.FirewallPlan;
    readonly keep: readonly string[];
    readonly choice: string | null;
    readonly replaced: model.OtherFirewall | null;
}

async function targetOf(targetId: string): Promise<ScanTarget> {
    const target = await prisma.deployTarget.findUnique({
        where: { id: targetId },
        select: TARGET_SELECT
    });
    if (!target) throw new ScanFailure("notFound");
    return target;
}

function isLocal(target: ScanTarget): boolean {
    return target.kind === "local" || !target.hostId;
}

/** The port Polaris logs in on, which a change must never close. */
async function sshPortOf(target: ScanTarget): Promise<number | null> {
    if (isLocal(target)) return null;
    const connection = await host.hostService.getHostConnection(target.hostId!, target.ownerId);
    return connection.port;
}

async function readReport(
    target: ScanTarget,
    run: typeof runHostAction = runHostAction
): Promise<model.FirewallReport> {
    const { output } = await run(target, "firewall-status");
    const report = model.parseFirewallLog(output);
    if (!report) throw new ScanFailure("firewallFailed");
    return report;
}

async function record(targetId: string, data: Record<string, unknown>): Promise<void> {
    await prisma.securitySetting.upsert({
        where: { targetId },
        create: { targetId, ...data },
        update: data
    });
}

function stateOf(report: model.FirewallReport): FirewallView["state"] {
    return report.router ? "router" : report.state;
}

/** Read the server's firewall and what a change would leave open and close. */
export async function readFirewall(targetId: string): Promise<FirewallView> {
    const target = await targetOf(targetId);
    const setting = await prisma.securitySetting.findUnique({
        where: { targetId },
        select: { firewallKeep: true, firewallChoice: true }
    });
    const keep = setting?.firewallKeep ?? [];
    const report = await readReport(target);
    const plan = model.planFirewall(report, {
        local: isLocal(target),
        sshPort: await sshPortOf(target),
        keep
    });
    await record(targetId, {
        firewall: stateOf(report),
        firewallAt: new Date(),
        firewallOpen: [...report.allowed],
        firewallClosing: plan.closing.length,
        ...(report.state === "on" ? { firewallNotifiedAt: null } : {})
    });
    return {
        state: stateOf(report),
        plan,
        keep,
        choice: setting?.firewallChoice ?? null,
        replaced: report.replaced
    };
}

/** Wait for the server to say the change held. Null when it never answered in time. */
async function confirmed(target: ScanTarget, apply: string): Promise<boolean | null> {
    const deadline = Date.now() + CONFIRM_MS;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
        const answer = await hostActionNow(target, "firewall-confirm", { apply })
            .then(({ output }) => model.parseFirewallEnding(output))
            .catch(() => null);
        if (answer === "confirmed") return true;
        if (answer === "rolled-back") return false;
    }
    return null;
}

const REFUSALS: Partial<Record<model.FirewallEnding, string>> = {
    unavailable: "firewallUnavailable",
    router: "firewallRouter",
    invalid: "firewallFailed",
    failed: "firewallFailed"
};

/**
 * Turn the firewall on, or bring it in step, leaving open what the plan says
 * plus `keep`. A person's call records their choice; Polaris's own never does.
 */
export async function applyFirewall(
    targetId: string,
    keep: readonly string[] | null,
    by: "person" | "polaris" = "person"
): Promise<FirewallView> {
    const target = await targetOf(targetId);
    const setting = await prisma.securitySetting.findUnique({
        where: { targetId },
        select: { firewallKeep: true }
    });
    const kept = keep ?? setting?.firewallKeep ?? [];
    const sshPort = await sshPortOf(target);
    await withFirewallHold(target, async () => {
        const report = await readReport(target, hostActionNow);
        if (report.router) throw new ScanFailure("firewallRouter");
        const plan = model.planFirewall(report, { local: isLocal(target), sshPort, keep: kept });
        const apply = randomUUID();
        const { output } = await hostActionNow(target, "firewall-apply", {
            apply,
            ports: plan.open.map(({ word }) => word)
        });
        const ending = model.parseFirewallEnding(output);
        if (ending !== "armed") throw new ScanFailure(REFUSALS[ending ?? "failed"] ?? "firewallFailed");
        const held = await confirmed(target, apply);
        if (held === false) throw new ScanFailure("firewallRolledBack");
        if (held === null) throw new ScanFailure("firewallUnconfirmed");
    });
    await record(targetId, {
        firewallKeep: [...kept],
        ...(by === "person" ? { firewallChoice: "on", firewallChosenAt: new Date() } : {})
    });
    return readFirewall(targetId);
}

/** Turn the firewall off; one Polaris replaced comes back. Recorded as a choice. */
export async function firewallOff(targetId: string): Promise<FirewallView> {
    const target = await targetOf(targetId);
    const { output } = await runHostAction(target, "firewall-off");
    if (!/POLARIS_FIREWALL=off/.test(output)) throw new ScanFailure("firewallFailed");
    await record(targetId, { firewallChoice: "off", firewallChosenAt: new Date() });
    return readFirewall(targetId);
}

/**
 * Tell the owner, once: that a server has no firewall and the review waits on
 * them, or that Polaris turned one on where nothing in use would close.
 */
async function announceReview(
    target: { id: string; ownerId: string; name: string },
    what: "review" | "enabled" = "review"
): Promise<void> {
    const t = await securityTFor(target.ownerId);
    await host.notificationsDispatch
        .notify({
            userId: target.ownerId,
            event: "security.firewall",
            level: what === "review" ? "warning" : "info",
            title: t(`firewall.notify.${what}.title`, { server: target.name }),
            body: t(`firewall.notify.${what}.body`, { server: target.name }),
            href: hostHref(target.id, "firewall"),
            metadata: { targetId: target.id }
        })
        .catch(() => undefined);
}

/** How often a server's firewall is read again, to open what was deployed since. */
const FIREWALL_READ_MS = 15 * 60_000;
/** How long a server that could not be reached waits before it is tried again. */
const FIREWALL_RETRY_MS = 60 * 60_000;
const triedAt = new Map<string, number>();

/** The pass: keep a person's firewall in step with what is deployed, and tell
 *  the owner of a server with none that the review waits on them. */
export async function planFirewalls(now: Date): Promise<void> {
    const targets = await prisma.deployTarget.findMany({
        where: {
            OR: [
                { securitySetting: null },
                { securitySetting: { firewallAt: null } },
                { securitySetting: { firewallAt: { lt: new Date(now.getTime() - FIREWALL_READ_MS) } } }
            ]
        },
        select: { id: true, ownerId: true, name: true, securitySetting: true },
        orderBy: { id: "asc" },
        take: 50
    });
    let reached = 0;
    for (const target of targets) {
        if (reached >= 3) break;
        if (now.getTime() - (triedAt.get(target.id) ?? 0) < FIREWALL_RETRY_MS) continue;
        triedAt.set(target.id, now.getTime());
        reached += 1;
        try {
            const view = await readFirewall(target.id);
            triedAt.delete(target.id);
            const step = model.firewallStep(target.securitySetting, view);
            if (step === "sync") {
                await applyFirewall(target.id, null, "polaris");
            } else if (step === "enable") {
                // Nothing in use closes. Should the change not hold anyway, the
                // server undoes it by itself and the owner gets the review.
                const enabled = await applyFirewall(target.id, null, "polaris")
                    .then((after) => after.state === "on")
                    .catch(() => false);
                // Not a person's choice, but kept in step with what is deployed from here on.
                if (enabled) await record(target.id, { firewallChoice: "auto", firewallChosenAt: now });
                await announceReview(target, enabled ? "enabled" : "review");
                await record(target.id, { firewallNotifiedAt: now });
            } else if (step === "review") {
                await announceReview(target);
                await record(target.id, { firewallNotifiedAt: now });
            }
        } catch (caught) {
            // Unreachable, the limited edition, an old daemon, a busy server: tried again later.
            if (!(caught instanceof ScanFailure)) {
                console.error("polaris: host firewall pass failed for a server:", caught);
            }
        }
    }
}
