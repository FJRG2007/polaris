/**
 * The one-time carry of Polar's old audiences into roles and overrides.
 *
 * Before this, who might use Polar and spend the deployment's keys was decided
 * by two audiences of Polar's own (`polar.access` in the settings table), with
 * `polar.use` and `polar.spend` deciding over them only when something named
 * them. Polar is decided by the permission system alone now, so on the first
 * start of this version every install translates what its audiences said into
 * the same state written with the ordinary mechanisms:
 *
 * - everybody signed in: every role but `guest` holds the permission, and
 *   `guest` too when the audience took guests (an account with no role at all
 *   gets it on the account itself, since no role can carry it);
 * - chosen people: an override on each account; chosen groups: a policy
 *   allowing it, attached to each group, plus a deny on the guest members the
 *   audience left out;
 * - administrators only: nothing, since an administrator is always allowed.
 *
 * A deployment that never saved a policy carries what it read, the unsaved
 * defaults below. It runs once and records that it ran; the old row is left
 * exactly as it is, so the change can be undone, and is never read for access
 * again. Every write keeps what is already there (a role's other grants, an
 * override somebody set), so running it twice changes nothing, and an install
 * that skipped every version between reads its own row, whatever it holds.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { getSetting } from "@/lib/setting-store";
import { instanceKeysAreShared } from "@/lib/agents/model-keys";
import { resolveGlobalStatements, seedDefaultRoles } from "@polaris/auth";
import { ALL_PERMISSIONS, type AuthzDecision } from "@polaris/core";

/** Where the carry records that it ran. */
export const POLAR_CARRY_MARK = "polar.accessCarriedToRoles";

/** The row the audiences were stored in, shared with Polar's options. */
const LEGACY_KEY = "polar.access";

const LEGACY_WHO = ["admins", "chosen", "everyone"] as const;

const legacyAudienceSchema = z.object({
    who: z.enum(LEGACY_WHO),
    userIds: z.array(z.string()).max(500).default([]),
    groupIds: z.array(z.string()).max(200).default([]),
    guests: z.boolean().default(false)
});
export type LegacyAudience = z.infer<typeof legacyAudienceSchema>;

const legacyPolicySchema = z.object({ use: legacyAudienceSchema, spend: legacyAudienceSchema });
export type LegacyPolarPolicy = z.infer<typeof legacyPolicySchema>;

const nobodyNamed = { userIds: [], groupIds: [], guests: false };

/** What a stored row that no longer read gave: Polar for everybody signed in
 *  but guests, the deployment's keys for the administrators. */
export const LEGACY_DEFAULT: LegacyPolarPolicy = {
    use: { who: "everyone", ...nobodyNamed },
    spend: { who: "admins", ...nobodyNamed }
};

/** What a deployment that never saved a policy read: the same, with the keys
 *  for everybody when its administrator shares them. */
export function unsavedPolarPolicy(keysShared: boolean): LegacyPolarPolicy {
    if (!keysShared) return LEGACY_DEFAULT;
    return { ...LEGACY_DEFAULT, spend: { who: "everyone", ...nobodyNamed } };
}

/** The audiences one stored row held; whatever does not read is the default. */
export function parseLegacyPolicy(raw: string): LegacyPolarPolicy {
    try {
        const parsed = legacyPolicySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : LEGACY_DEFAULT;
    } catch {
        return LEGACY_DEFAULT;
    }
}

type PolarPermission = "polar.use" | "polar.spend";

/** One account the carry has to look at by name. */
export interface CarryPerson {
    userId: string;
    /** No role but `guest`, or none at all - outside "everybody" unless guests were in. */
    guest: boolean;
    /** No role at all, so no role can carry anything to it. */
    roleless: boolean;
    groupIds: readonly string[];
    /** What the permission system says before the carry, read with
     *  `polarGrantsOf`; absent is nothing said. */
    holds?: Partial<Record<PolarPermission, AuthzDecision>>;
}

export interface PolarCarryPlan {
    /** Every role but `guest` (and any holding `*`) gets these; `guest` too when `guestRole`. */
    roles: { permission: PolarPermission; guestRole: boolean }[];
    groups: { groupId: string; permission: PolarPermission }[];
    users: { userId: string; permission: PolarPermission; effect: "allow" | "deny" }[];
}

/** Whether one audience took one account, as the old decision read it. */
function admittedBy(audience: LegacyAudience, person: CarryPerson): boolean {
    if (audience.who === "admins") return false;
    if (audience.userIds.includes(person.userId)) return true;
    if (person.guest && !audience.guests) return false;
    if (audience.who === "everyone") return true;
    return person.groupIds.some((id) => audience.groupIds.includes(id));
}

/**
 * The audience each permission is carried from. Spending never opened anything
 * without Polar itself, so where Polar is not everybody's, "the keys for
 * everybody" is carried as "the keys for the people who have Polar" - a role
 * must not end up holding `polar.spend` without `polar.use`, which the role
 * editor would complete into Polar for everybody the next time it is saved.
 */
function carriedAudiences(
    policy: LegacyPolarPolicy,
    people: readonly CarryPerson[]
): [PolarPermission, LegacyAudience][] {
    const { use, spend } = policy;
    const parts: [PolarPermission, LegacyAudience][] = [["polar.use", use]];
    if (use.who === "admins" || spend.who === "admins") return parts;
    if (use.who === "everyone") {
        // Guests spend only when they also have Polar.
        parts.push(["polar.spend", { ...spend, guests: spend.guests && use.guests }]);
        return parts;
    }
    if (spend.who === "chosen") {
        parts.push(["polar.spend", spend]);
        return parts;
    }
    const byId = new Map(people.map((person) => [person.userId, person]));
    const named = use.userIds.filter((id) => {
        const person = byId.get(id);
        return !person || admittedBy(spend, person);
    });
    parts.push([
        "polar.spend",
        {
            who: "chosen",
            userIds: [...new Set([...named, ...spend.userIds])],
            groupIds: use.groupIds,
            guests: spend.guests
        }
    ]);
    return parts;
}

/**
 * What the carry writes for one install. Pure, so every stored shape can be
 * asserted. `people` holds the accounts named in either audience, the guest
 * members of the chosen groups and the accounts with no role; administrators
 * are left out, since they are allowed regardless.
 */
export function planPolarCarry(
    policy: LegacyPolarPolicy,
    people: readonly CarryPerson[]
): PolarCarryPlan {
    const plan: PolarCarryPlan = { roles: [], groups: [], users: [] };
    const byId = new Map(people.map((person) => [person.userId, person]));
    const allow = (userId: string, permission: PolarPermission) => {
        if (!plan.users.some((entry) => entry.userId === userId && entry.permission === permission))
            plan.users.push({ userId, permission, effect: "allow" });
    };

    for (const [permission, audience] of carriedAudiences(policy, people)) {
        if (audience.who === "admins") continue;
        if (audience.who === "everyone") {
            plan.roles.push({ permission, guestRole: audience.guests });
            for (const person of people) {
                // No role reaches an account that has none.
                if (audience.guests && person.roleless) allow(person.userId, permission);
            }
            for (const id of audience.userIds) {
                const person = byId.get(id);
                // A named guest is the one guest "everybody" took.
                if (person?.guest && !audience.guests) allow(id, permission);
            }
            continue;
        }
        for (const id of audience.userIds) allow(id, permission);
        for (const groupId of audience.groupIds) plan.groups.push({ groupId, permission });
        if (audience.guests) continue;
        // The group's policy reaches its guests too, which the audience did not.
        for (const person of people) {
            if (!person.guest || audience.userIds.includes(person.userId)) continue;
            if (!person.groupIds.some((id) => audience.groupIds.includes(id))) continue;
            // One somebody already let in or kept out stays as they were.
            if ((person.holds?.[permission] ?? "implicit-deny") !== "implicit-deny") continue;
            plan.users.push({ userId: person.userId, permission, effect: "deny" });
        }
    }
    return plan;
}

/** The policy a chosen group is given each permission through. */
const GROUP_POLICY_NAMES: Record<PolarPermission, string> = {
    "polar.use": "Polar (carried from Polar access)",
    "polar.spend": "Polar on this deployment's keys (carried from Polar access)"
};

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

/** The accounts the plan has to see by name, read with bounded queries. */
async function peopleFor(policy: LegacyPolarPolicy): Promise<CarryPerson[]> {
    const audiences = [policy.use, policy.spend];
    const named = [...new Set(audiences.flatMap((audience) => audience.userIds))];
    const groupIds = [
        ...new Set(
            audiences
                .filter((audience) => audience.who === "chosen")
                .flatMap((audience) => audience.groupIds)
        )
    ];
    const anyGuests = audiences.some((audience) => audience.who === "everyone" && audience.guests);
    const select = {
        id: true,
        roles: { select: { role: { select: { name: true } } } },
        groups: { select: { groupId: true } }
    } as const;
    const [byName, groupGuests, roleless] = await Promise.all([
        named.length
            ? prisma.user.findMany({ where: { id: { in: named }, isAdmin: false }, select })
            : [],
        groupIds.length
            ? prisma.user.findMany({
                  where: {
                      isAdmin: false,
                      groups: { some: { groupId: { in: groupIds } } },
                      roles: { every: { role: { name: "guest" } } }
                  },
                  select
              })
            : [],
        anyGuests
            ? prisma.user.findMany({ where: { isAdmin: false, roles: { none: {} } }, select })
            : []
    ]);
    const rows = new Map([...byName, ...groupGuests, ...roleless].map((row) => [row.id, row]));
    const { polarGrantsOf } = await import("@/lib/polar/access");
    return Promise.all(
        [...rows.values()].map(async (row) => {
            const roles = row.roles.map((entry) => entry.role.name);
            const guest = roles.every((name) => name === "guest");
            const person: CarryPerson = {
                userId: row.id,
                guest,
                roleless: roles.length === 0,
                groupIds: row.groups.map((entry) => entry.groupId)
            };
            // Only a guest in a chosen group may be denied, so only they are asked.
            if (guest && person.groupIds.some((id) => groupIds.includes(id))) {
                const grants = polarGrantsOf(await resolveGlobalStatements(row.id));
                person.holds = { "polar.use": grants.use, "polar.spend": grants.spend };
            }
            return person;
        })
    );
}

/** The policy allowing one permission, found or made. */
async function groupPolicy(permission: PolarPermission): Promise<string> {
    const name = GROUP_POLICY_NAMES[permission];
    const existing = await prisma.policy.findUnique({ where: { name }, select: { id: true } });
    if (existing) return existing.id;
    const document = { statements: [{ effect: "allow", actions: [permission], resources: ["*"] }] };
    try {
        const created = await prisma.policy.create({
            data: { name, document: JSON.stringify(document) },
            select: { id: true }
        });
        return created.id;
    } catch (error) {
        // Another process made it a moment ago.
        const again = await prisma.policy.findUnique({ where: { name }, select: { id: true } });
        if (again) return again.id;
        throw error;
    }
}

export interface CarryOutcome {
    roles: number;
    groups: number;
    users: number;
}

/** Write one plan with the ordinary mechanisms, keeping whatever is there. */
export async function applyPolarCarry(plan: PolarCarryPlan): Promise<CarryOutcome> {
    const outcome: CarryOutcome = { roles: 0, groups: 0, users: 0 };
    if (plan.roles.length) {
        const roles = await prisma.role.findMany({ select: { id: true, name: true, permissions: true } });
        for (const role of roles) {
            const grants = parseGrants(role.permissions);
            if (grants.includes(ALL_PERMISSIONS)) continue;
            const missing = plan.roles
                .filter((entry) => role.name !== "guest" || entry.guestRole)
                .map((entry) => entry.permission)
                .filter((permission) => !grants.includes(permission));
            if (missing.length === 0) continue;
            await prisma.role.update({
                where: { id: role.id },
                data: { permissions: JSON.stringify([...grants, ...missing]) }
            });
            outcome.roles += 1;
        }
    }
    if (plan.groups.length) {
        const present = new Set(
            (
                await prisma.group.findMany({
                    where: { id: { in: [...new Set(plan.groups.map((entry) => entry.groupId))] } },
                    select: { id: true }
                })
            ).map((row) => row.id)
        );
        for (const entry of plan.groups) {
            if (!present.has(entry.groupId)) continue;
            const policyId = await groupPolicy(entry.permission);
            await prisma.policyAttachment.upsert({
                where: {
                    policyId_principalType_principalId: {
                        policyId,
                        principalType: "group",
                        principalId: entry.groupId
                    }
                },
                update: {},
                create: { policyId, principalType: "group", principalId: entry.groupId }
            });
            outcome.groups += 1;
        }
    }
    if (plan.users.length) {
        const present = new Set(
            (
                await prisma.user.findMany({
                    where: { id: { in: [...new Set(plan.users.map((entry) => entry.userId))] } },
                    select: { id: true }
                })
            ).map((row) => row.id)
        );
        for (const entry of plan.users) {
            if (!present.has(entry.userId)) continue;
            // An override somebody already set is theirs, and stays.
            await prisma.userPermission.upsert({
                where: { userId_permission: { userId: entry.userId, permission: entry.permission } },
                update: {},
                create: { userId: entry.userId, permission: entry.permission, effect: entry.effect }
            });
            outcome.users += 1;
        }
    }
    return outcome;
}

/** Carry this install's audiences, unless that already happened. */
export async function carryPolarAccess(): Promise<CarryOutcome | null> {
    const done = await prisma.setting.findUnique({
        where: { key: POLAR_CARRY_MARK },
        select: { key: true }
    });
    if (done) return null;
    // The built-in roles first, so a fresh install has roles to carry into.
    await seedDefaultRoles();
    const raw = await getSetting(LEGACY_KEY);
    const policy = raw ? parseLegacyPolicy(raw) : unsavedPolarPolicy(await instanceKeysAreShared());
    const outcome = await applyPolarCarry(planPolarCarry(policy, await peopleFor(policy)));
    const value = JSON.stringify({ at: new Date().toISOString(), ...outcome });
    await prisma.setting.upsert({
        where: { key: POLAR_CARRY_MARK },
        update: {},
        create: { key: POLAR_CARRY_MARK, value }
    });
    return outcome;
}

let pending: Promise<void> | null = null;

/** The carry, once per process; a failure is tried again on the next call. */
export function ensurePolarAccessCarried(): Promise<void> {
    pending ??= carryPolarAccess().then(
        () => undefined,
        (error: unknown) => {
            pending = null;
            throw error;
        }
    );
    return pending;
}

/** Only for tests: forget that this process carried. */
export function forgetPolarCarry(): void {
    pending = null;
}

