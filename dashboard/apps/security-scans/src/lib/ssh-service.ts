/**
 * SSH hardening on every managed server: password sign-in off, root kept to a
 * key, read, applied and undone.
 *
 * Turning passwords off can shut out whoever only has one, so it is the
 * firewall's way (`./firewall-service.ts`): a person sees who keeps signing in
 * and who stops, the server undoes the change by itself after 120 s, and only a
 * confirm Polaris sends over a fresh key login - proof that a key still gets
 * in - keeps it. Polaris never applies it by itself; it tells the owner once
 * that a server still takes passwords.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { securityTFor } from "./i18n";
import * as model from "../model/ssh";
import { createHash, randomUUID } from "node:crypto";
import { parseKey, publicKeyBlob } from "@polaris/ssh";
import { host } from "@polaris/app-host";
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

export interface SshView {
    readonly state: model.SshState;
    readonly plan: model.SshPlan;
    readonly choice: string | null;
    /** The keys that keep signing in; Polaris's own is named. Empty when the
     *  host service predates listing them. */
    readonly keys: readonly SshKeyView[];
}

export interface SshKeyView {
    readonly account: string;
    readonly type: string;
    readonly comment: string;
    /** OpenSSH's `SHA256:` fingerprint, as `ssh-keygen -l` prints it. */
    readonly fingerprint: string;
    /** The key Polaris itself signs in to this server with. */
    readonly polaris: boolean;
}

/** OpenSSH's fingerprint of a key blob: `SHA256:` and the unpadded base64 hash. */
export function keyFingerprint(blob: string): string {
    const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
    return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** The public half of the key Polaris signs in with, as a blob; null locally,
 *  with a password, or when it cannot be read. */
async function polarisBlobOf(target: ScanTarget): Promise<string | null> {
    if (isLocal(target)) return null;
    try {
        const { auth } = await host.hostService.getHostConnection(target.hostId!, target.ownerId);
        if (auth.method !== "key" || !auth.privateKey) return null;
        const parsed = parseKey(auth.privateKey, auth.passphrase);
        const key = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!key || key instanceof Error) return null;
        return key.getPublicSSH().toString("base64");
    } catch {
        return null;
    }
}

/** The status read's keys as the dialog shows them: only real keys, with
 *  Polaris's own named. Pure apart from the hash. */
export function keyViews(
    lines: readonly model.SshKeyLine[],
    polarisBlob: string | null
): SshKeyView[] {
    return lines
        .filter((line) => publicKeyBlob(`${line.type} ${line.blob}`) !== null)
        .map((line) => ({
            account: line.account,
            type: line.type,
            comment: line.comment,
            fingerprint: keyFingerprint(line.blob),
            polaris: line.blob === polarisBlob
        }));
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

/** How Polaris signs in to the server: "key" or "password"; null locally. */
async function polarisAuthOf(target: ScanTarget): Promise<string | null> {
    if (isLocal(target)) return null;
    const row = await prisma.host.findFirst({
        where: { id: target.hostId!, ownerId: target.ownerId },
        select: { authMethod: true }
    });
    return row?.authMethod ?? null;
}

async function record(targetId: string, data: Record<string, unknown>): Promise<void> {
    await prisma.securitySetting.upsert({
        where: { targetId },
        create: { targetId, ...data },
        update: data
    });
}

async function readWith(
    target: ScanTarget,
    run: typeof runHostAction
): Promise<{ report: model.SshReport; plan: model.SshPlan }> {
    const { output } = await run(target, "ssh-status");
    const report = model.parseSshLog(output);
    if (!report) throw new ScanFailure("sshFailed");
    const plan = model.planSsh(report, {
        local: isLocal(target),
        polarisAuth: await polarisAuthOf(target)
    });
    return { report, plan };
}

/** Read the server's SSH sign-in settings and who a change would shut out. */
export async function readSsh(targetId: string): Promise<SshView> {
    const target = await targetOf(targetId);
    const setting = await prisma.securitySetting.findUnique({
        where: { targetId },
        select: { sshChoice: true }
    });
    const { report, plan } = await readWith(target, runHostAction);
    await record(targetId, {
        ssh: report.state,
        sshAt: new Date(),
        sshHardened: plan.hardened,
        sshBlocked: plan.blocked
    });
    const keys = report.keys.length > 0 ? keyViews(report.keys, await polarisBlobOf(target)) : [];
    return { state: report.state, plan, choice: setting?.sshChoice ?? null, keys };
}

/** Wait for the server to say the change held. Null when it never answered in time. */
async function confirmed(target: ScanTarget, apply: string): Promise<boolean | null> {
    const deadline = Date.now() + CONFIRM_MS;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
        // A connection of its own each time: a key that no longer gets in never confirms.
        const answer = await hostActionNow(target, "ssh-confirm", { apply })
            .then(({ output }) => model.parseSshEnding(output))
            .catch(() => null);
        if (answer === "confirmed") return true;
        if (answer === "rolled-back") return false;
    }
    return null;
}

const REFUSALS: Partial<Record<model.SshEnding, string>> = {
    unavailable: "sshUnavailable",
    nokeys: "sshNoKeys",
    invalid: "sshInvalid",
    overridden: "sshOverridden"
};

const BLOCKERS: Record<model.SshBlocker, string> = {
    unavailable: "sshUnavailable",
    passwordLogin: "sshPolarisPassword",
    noKeys: "sshNoKeys"
};

/** Turn password sign-in off. Only a person does this, and it records their choice. */
export async function applySsh(targetId: string): Promise<SshView> {
    const target = await targetOf(targetId);
    await withFirewallHold(target, async () => {
        const { plan } = await readWith(target, hostActionNow);
        if (plan.blocked) throw new ScanFailure(BLOCKERS[plan.blocked]);
        const apply = randomUUID();
        const { output } = await hostActionNow(target, "ssh-apply", { apply });
        const ending = model.parseSshEnding(output);
        if (ending !== "armed") throw new ScanFailure(REFUSALS[ending ?? "failed"] ?? "sshFailed");
        const held = await confirmed(target, apply);
        if (held === false) throw new ScanFailure("sshRolledBack");
        if (held === null) throw new ScanFailure("sshUnconfirmed");
    });
    await record(targetId, { sshChoice: "on", sshChosenAt: new Date() });
    return readSsh(targetId);
}

/** Take Polaris's hardening away; passwords work again. Recorded as a choice. */
export async function sshOff(targetId: string): Promise<SshView> {
    const target = await targetOf(targetId);
    const { output } = await runHostAction(target, "ssh-off");
    if (model.parseSshEnding(output) !== "off") throw new ScanFailure("sshFailed");
    await record(targetId, { sshChoice: "off", sshChosenAt: new Date() });
    return readSsh(targetId);
}

/** Tell the owner, once, that a server still takes passwords. */
async function announceReview(target: { id: string; ownerId: string; name: string }): Promise<void> {
    const t = await securityTFor(target.ownerId);
    await host.notificationsDispatch
        .notify({
            userId: target.ownerId,
            event: "security.ssh",
            level: "warning",
            title: t("ssh.notify.title", { server: target.name }),
            body: t("ssh.notify.body", { server: target.name }),
            href: hostHref(target.id, "ssh"),
            metadata: { targetId: target.id }
        })
        .catch(() => undefined);
}

/** How often a server's SSH settings are read again. */
const SSH_READ_MS = 12 * 60 * 60_000;
/** How long a server that could not be reached waits before it is tried again. */
const SSH_RETRY_MS = 60 * 60_000;
const triedAt = new Map<string, number>();

/** The pass: keep what each server's SSH accepts current, and tell the owner
 *  of one that still takes passwords that the review waits on them. */
export async function planSshHardening(now: Date): Promise<void> {
    const targets = await prisma.deployTarget.findMany({
        where: {
            OR: [
                { securitySetting: null },
                { securitySetting: { sshAt: null } },
                { securitySetting: { sshAt: { lt: new Date(now.getTime() - SSH_READ_MS) } } }
            ]
        },
        select: { id: true, ownerId: true, name: true, securitySetting: true },
        orderBy: { id: "asc" },
        take: 50
    });
    let reached = 0;
    for (const target of targets) {
        if (reached >= 3) break;
        if (now.getTime() - (triedAt.get(target.id) ?? 0) < SSH_RETRY_MS) continue;
        triedAt.set(target.id, now.getTime());
        reached += 1;
        try {
            const view = await readSsh(target.id);
            triedAt.delete(target.id);
            if (model.sshStep(target.securitySetting, view) === "review") {
                await announceReview(target);
                await record(target.id, { sshNotifiedAt: now });
            }
        } catch (caught) {
            // Unreachable, the limited edition, an old daemon, a busy server: tried again later.
            if (!(caught instanceof ScanFailure)) {
                console.error("polaris: SSH hardening pass failed for a server:", caught);
            }
        }
    }
}
