/**
 * The one-time carry of the VPN's own access controls into roles and overrides.
 *
 * Before this, who had the VPN was decided by the VPN itself as much as by
 * `vpn.use`: an "open to everyone" switch (`vpn.openAccess`), and a per-person
 * row (`VpnAccess`) that both let somebody in and set their limits. A role
 * holding `vpn.use` let nobody in on its own; a deny shut anybody out. Now
 * `vpn.use` alone decides (`wg.vpnStanding`) and a row is limits only, so on
 * the first start of this version every install writes what the old decision
 * said into the ordinary mechanisms:
 *
 * - open to everyone: every role holds `vpn.use`, `guest` included, since the
 *   switch let in everybody nothing denied; an account with no role at all gets
 *   it on the account itself, since no role can carry it;
 * - closed (also an install that never touched the switch): no role holds it,
 *   since a role alone never let anybody in; each person with a row gets it on
 *   the account; each person a policy naming the VPN reaches, who had no row,
 *   gets a deny on the account, since that policy let them in on nothing.
 *
 * An override somebody already set is never changed, and administrators are
 * left alone, since they always have it. The switch and the rows are kept as
 * they are (the rows are each person's limits now); the grants taken off roles
 * are recorded in the mark, so the change can be undone. It runs once and
 * records that it ran, and every write keeps what is there, so running it twice
 * changes nothing and an install that skipped every version between reads its
 * own state, whatever it holds.
 */

import { prisma } from "@polaris/db";
import { seedDefaultRoles } from "@polaris/auth";
import { getSetting } from "@/lib/setting-store";
import { policyDocumentSchema } from "@polaris/core";

/** Where the carry records that it ran, and what it changed. */
export const VPN_CARRY_MARK = "vpn.accessCarriedToRoles";

/** The switch an earlier release kept. Left in place, never read for access. */
export const LEGACY_OPEN_KEY = "vpn.openAccess";

/** A grant that names the VPN, which is what `wg.vpnGrantOf` reads. */
const NAMES_VPN = (grant: string): boolean => grant === "vpn.use" || grant === "vpn.*";

export interface CarryRole {
    name: string;
    grants: readonly string[];
}

/** One non-administrator account the carry has to look at by name. */
export interface CarryPerson {
    userId: string;
    /** The names of the roles the account holds; empty is no role at all. */
    roles: readonly string[];
    /** Whether the VPN's screen gave them a row (now their limits). */
    hasRow: boolean;
    /** The `vpn.use` override already on the account, if any. */
    override: "allow" | "deny" | null;
    /** Whether a policy allowing `vpn.use` by name reaches them. */
    reachedByPolicy: boolean;
}

export interface VpnCarryPlan {
    /** Roles that get `vpn.use`. */
    grant: string[];
    /** Roles that lose what they held naming the VPN. */
    strip: { name: string; removed: string[] }[];
    users: { userId: string; effect: "allow" | "deny" }[];
}

/**
 * What the carry writes for one install. Pure, so every stored shape can be
 * asserted. `people` holds, when open, the accounts with no role; when closed,
 * the accounts with a row and those a policy naming the VPN reaches.
 */
export function planVpnCarry(
    open: boolean,
    roles: readonly CarryRole[],
    people: readonly CarryPerson[]
): VpnCarryPlan {
    const plan: VpnCarryPlan = { grant: [], strip: [], users: [] };
    for (const role of roles) {
        const naming = role.grants.filter(NAMES_VPN);
        if (open && naming.length === 0) plan.grant.push(role.name);
        if (!open && naming.length > 0) plan.strip.push({ name: role.name, removed: naming });
    }
    for (const person of people) {
        // One somebody already switched on or off stays as they set it.
        if (person.override !== null) continue;
        if (open) {
            if (person.roles.length === 0)
                plan.users.push({ userId: person.userId, effect: "allow" });
            continue;
        }
        if (person.hasRow) plan.users.push({ userId: person.userId, effect: "allow" });
        else if (person.reachedByPolicy) plan.users.push({ userId: person.userId, effect: "deny" });
    }
    return plan;
}

/** A role's stored grant list. Malformed JSON grants nothing. */
function parseGrants(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === "string")
            : [];
    } catch {
        return [];
    }
}

/** Whether a policy document allows `vpn.use` by name. */
export function policyAllowsVpn(raw: string): boolean {
    try {
        const parsed = policyDocumentSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return false;
        return parsed.data.statements.some(
            (statement) => statement.effect === "allow" && statement.actions.some(NAMES_VPN)
        );
    } catch {
        return false;
    }
}

/** The accounts a policy allowing the VPN by name is attached to, directly or
 *  through a group or a role. */
async function reachedByPolicies(): Promise<Set<string>> {
    const policies = await prisma.policy.findMany({
        select: {
            document: true,
            attachments: { select: { principalType: true, principalId: true } }
        }
    });
    const attachments = policies
        .filter((policy) => policyAllowsVpn(policy.document))
        .flatMap((policy) => policy.attachments);
    const of = (type: string) =>
        attachments
            .filter((entry) => entry.principalType === type)
            .map((entry) => entry.principalId);
    const [members, holders] = await Promise.all([
        of("group").length
            ? prisma.groupMember.findMany({
                  where: { groupId: { in: of("group") } },
                  select: { userId: true }
              })
            : [],
        of("role").length
            ? prisma.userRole.findMany({
                  where: { roleId: { in: of("role") } },
                  select: { userId: true }
              })
            : []
    ]);
    return new Set([
        ...of("user"),
        ...members.map((entry) => entry.userId),
        ...holders.map((entry) => entry.userId)
    ]);
}

/** The accounts the plan has to see by name; administrators are left out. */
async function peopleFor(open: boolean): Promise<CarryPerson[]> {
    const select = {
        id: true,
        roles: { select: { role: { select: { name: true } } } },
        permissionOverrides: { where: { permission: "vpn.use" }, select: { effect: true } },
        vpnAccess: { select: { userId: true } }
    } as const;
    let reached = new Set<string>();
    let rows;
    if (open) {
        rows = await prisma.user.findMany({
            where: { isAdmin: false, roles: { none: {} } },
            select
        });
    } else {
        reached = await reachedByPolicies();
        rows = await prisma.user.findMany({
            where: {
                isAdmin: false,
                OR: [{ vpnAccess: { isNot: null } }, { id: { in: [...reached] } }]
            },
            select
        });
    }
    return rows.map((row) => {
        const effect = row.permissionOverrides[0]?.effect;
        return {
            userId: row.id,
            roles: row.roles.map((entry) => entry.role.name),
            hasRow: row.vpnAccess !== null,
            override: effect === undefined ? null : effect === "deny" ? "deny" : "allow",
            reachedByPolicy: reached.has(row.id)
        };
    });
}

export interface CarryOutcome {
    open: boolean;
    granted: string[];
    stripped: { name: string; removed: string[] }[];
    allowed: number;
    denied: number;
}

/** Write one plan with the ordinary mechanisms, keeping whatever is there. */
export async function applyVpnCarry(plan: VpnCarryPlan): Promise<Omit<CarryOutcome, "open">> {
    const touched = new Set([...plan.grant, ...plan.strip.map((entry) => entry.name)]);
    const roles = touched.size
        ? await prisma.role.findMany({
              where: { name: { in: [...touched] } },
              select: { id: true, name: true, permissions: true }
          })
        : [];
    const granted: string[] = [];
    const stripped: { name: string; removed: string[] }[] = [];
    for (const role of roles) {
        const grants = parseGrants(role.permissions);
        if (plan.grant.includes(role.name)) {
            if (grants.some(NAMES_VPN)) continue;
            await prisma.role.update({
                where: { id: role.id },
                data: { permissions: JSON.stringify([...grants, "vpn.use"]) }
            });
            granted.push(role.name);
        } else {
            const removed = grants.filter(NAMES_VPN);
            if (removed.length === 0) continue;
            await prisma.role.update({
                where: { id: role.id },
                data: { permissions: JSON.stringify(grants.filter((grant) => !NAMES_VPN(grant))) }
            });
            stripped.push({ name: role.name, removed });
        }
    }
    let allowed = 0;
    let denied = 0;
    for (let start = 0; start < plan.users.length; start += 500) {
        const batch = plan.users.slice(start, start + 500);
        // An override somebody set meanwhile is theirs, and stays.
        await prisma.userPermission.createMany({
            data: batch.map((entry) => ({
                userId: entry.userId,
                permission: "vpn.use",
                effect: entry.effect
            })),
            skipDuplicates: true
        });
        for (const entry of batch) entry.effect === "deny" ? denied++ : allowed++;
    }
    return { granted, stripped, allowed, denied };
}

/** Carry this install's VPN access, unless that already happened. */
export async function carryVpnAccess(): Promise<CarryOutcome | null> {
    const done = await prisma.setting.findUnique({
        where: { key: VPN_CARRY_MARK },
        select: { key: true }
    });
    if (done) return null;
    // The built-in roles first, so a fresh install has roles to carry into.
    await seedDefaultRoles();
    const open = (await getSetting(LEGACY_OPEN_KEY)) === "true";
    const roles = (await prisma.role.findMany({ select: { name: true, permissions: true } })).map(
        (role) => ({ name: role.name, grants: parseGrants(role.permissions) })
    );
    const plan = planVpnCarry(open, roles, await peopleFor(open));
    const outcome: CarryOutcome = { open, ...(await applyVpnCarry(plan)) };
    await prisma.setting.upsert({
        where: { key: VPN_CARRY_MARK },
        update: {},
        create: {
            key: VPN_CARRY_MARK,
            value: JSON.stringify({ at: new Date().toISOString(), ...outcome })
        }
    });
    return outcome;
}

let pending: Promise<void> | null = null;

/** The carry, once per process; a failure is tried again on the next call. */
export function ensureVpnAccessCarried(): Promise<void> {
    pending ??= carryVpnAccess().then(
        () => undefined,
        (error: unknown) => {
            pending = null;
            throw error;
        }
    );
    return pending;
}

/** Only for tests: forget that this process carried. */
export function forgetVpnCarry(): void {
    pending = null;
}
