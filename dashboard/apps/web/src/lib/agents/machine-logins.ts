/**
 * An agent signed in on the sessions' machine, kept as a connection row.
 *
 * The login itself lives in the tool's own files in the person's home, so the
 * row holds no secret: an empty envelope and a config naming the login's
 * variable (`{ machineLogin: "<ENV>" }`). It is a row so it has what every other
 * connection has - a name, a place in the order, a switch - and the rotation
 * reads it like any account. Picked for a session, it hands the session nothing:
 * the tool signs in with the login already on the machine.
 *
 * The row itself is written by `machine-login-rows.ts`.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { homeSigninSlugs } from "@/lib/agents/signin-runtime";
import { isMachineLogin, machineLoginEnv } from "@/lib/agents/machine-login-config";
import { agentSignins, signinSlug } from "@/lib/agents/agent-signins";

/** The login variable this owner's row stands for, or null when it is not a
 *  machine login (or not theirs). */
export async function machineLoginOf(userId: string | null, id: string): Promise<string | null> {
    if (!userId) return null;
    const row = await prisma.userModelKey.findFirst({ where: { id, userId }, select: { config: true } });
    return row ? machineLoginEnv(row.config) : null;
}

/** The sign-in slugs a tool's accounts are stored under, the machine's own
 *  login included: what the rotation moves a session of it between. */
export function rotationSlugs(cli: string): { stored: string[]; machine: string[] } {
    const signins = new Set(agentSignins().map((entry) => entry.slug));
    const stored = (core.agentCliById(cli)?.credentials ?? [])
        .map((entry) => signinSlug(entry.env))
        .filter((slug) => signins.has(slug));
    return { stored, machine: homeSigninSlugs(cli) };
}

/**
 * Whether a session runs on the machine's own login because of a row: the one
 * it picked is a machine login, or - having picked none - its tool's machine
 * login is ahead of the tool's stored accounts in the owner's order. With no
 * stored account to outrank, nothing changes: the session is handed what it was
 * handed before these rows existed. Only the person's own rows count, as the
 * login is in their home. A tool with no machine login never asks.
 */
export async function machineLoginChosen(
    userId: string | null,
    cli: string,
    accountId: string | null
): Promise<boolean> {
    if (!userId) return false;
    const { stored, machine } = rotationSlugs(cli);
    if (machine.length === 0) return false;
    const now = new Date();
    const rows = await prisma.userModelKey.findMany({
        where: {
            userId,
            ...(accountId ? { id: accountId } : { provider: { in: [...stored, ...machine] } }),
            enabled: true,
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }]
        },
        select: { provider: true, config: true },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: 50
    });
    const first = rows[0];
    if (!first || !machine.includes(first.provider) || !isMachineLogin(first.config)) return false;
    return accountId !== null || rows.some((row) => stored.includes(row.provider));
}
