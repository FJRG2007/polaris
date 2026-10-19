/** A deployment one release behind, on a home server with a domain of its own. */

import { CREW, TEAM, VIEWER, ago, id, type FixturePerson } from "./people";
import type { Page } from "@/lib/pagination/cursor";
import type { RoleOption } from "@/lib/role-service";
import type { InviteListItem } from "@/lib/invite-service";
import type { DirectoryUser } from "@/lib/user-admin-service";
import type { SceneContext } from "../runtime/scene";
import type { UpdateStatus } from "@/lib/update-service";
import type { UpdateLogTail } from "@/lib/update-log";
import type { SettingsOverview } from "@/app/(app)/admin/settings/overview";

export const DEPLOYMENT = {
    hostname: "polaris",
    repo: "example/polaris",
    branch: "main",
    autoUpdate: true
} as const;

export function updateStatus(ctx: SceneContext): UpdateStatus {
    return {
        phase: "available",
        source: "image",
        current: "3f1c2a9",
        latest: "8b7e410",
        behindBy: 4,
        upToDate: false,
        buildingCount: null,
        publishedAt: ago(ctx.now, 95),
        checks: "passed",
        checksUrl: null,
        url: "https://github.com/example/polaris/compare/3f1c2a9...8b7e410",
        checkedAt: ago(ctx.now, 2)
    };
}

export function settingsOverview(ctx: SceneContext): SettingsOverview {
    const checked = ago(ctx.now, 1);
    const up = { state: "up" as const, checkedAt: checked, detail: null };
    return {
        status: updateStatus(ctx),
        addresses: [
            {
                url: "https://polaris.example.com",
                host: "polaris.example.com",
                kind: "domain",
                health: up
            },
            { url: "http://polaris.local", host: "polaris.local", kind: "local", health: up }
        ],
        // Documentation ranges (RFC 5737), which route nowhere.
        publicIp: "203.0.113.24",
        serverIp: "192.0.2.10"
    };
}

/** The update log of a run that finished long ago: nothing to re-attach to. */
export function quietUpdateLog(ctx: SceneContext): UpdateLogTail {
    return {
        exists: false,
        content: "",
        nextOffset: 0,
        size: 0,
        done: true,
        exitCode: null,
        finished: true,
        updatedAt: 0,
        now: ctx.now,
        build: "3f1c2a9"
    };
}

/** An account as the people directory lists it, with nothing imposed on it. */
function member(
    ctx: SceneContext,
    person: FixturePerson,
    fields: Partial<DirectoryUser> & { joinedDaysAgo: number; seenMinutesAgo: number | null }
): DirectoryUser {
    const { joinedDaysAgo, seenMinutesAgo, ...rest } = fields;
    return {
        id: person.id,
        name: person.name,
        email: person.email,
        username: person.email.split("@")[0],
        company: null,
        isAdmin: false,
        banned: false,
        banReason: null,
        bannedAt: null,
        bannedUntil: null,
        emailVerified: true,
        phone: null,
        phoneVerified: false,
        twoFactorEnabled: true,
        roles: ["member"],
        groups: [],
        lastSeenAt: seenMinutesAgo === null ? null : ago(ctx.now, seenMinutesAgo),
        // Documentation range (RFC 5737), which routes nowhere.
        lastIp: seenMinutesAgo === null ? null : "198.51.100.7",
        lastCountry: seenMinutesAgo === null ? null : "ES",
        createdAt: ago(ctx.now, joinedDaysAgo * 24 * 60),
        enforced: { groupIds: [], allowedCidrs: [], allowedCountries: [], allowedContinents: [] },
        ...rest
    };
}

/** The Northwind people, as the directory reads them: admins, members, a
 *  support role, a guest limited to one country, and one suspended account. */
export function directory(ctx: SceneContext): Page<DirectoryUser> {
    return {
        items: [
            member(ctx, VIEWER, {
                isAdmin: true,
                roles: ["admin"],
                joinedDaysAgo: 420,
                seenMinutesAgo: 0
            }),
            member(ctx, TEAM.ana, {
                isAdmin: true,
                roles: ["admin"],
                joinedDaysAgo: 410,
                seenMinutesAgo: 1
            }),
            member(ctx, TEAM.kenji, { joinedDaysAgo: 300, seenMinutesAgo: 3 }),
            member(ctx, TEAM.priya, { roles: ["support"], joinedDaysAgo: 260, seenMinutesAgo: 45 }),
            member(ctx, TEAM.lena, { joinedDaysAgo: 190, seenMinutesAgo: 60 * 5 }),
            member(ctx, CREW.grace, {
                roles: ["support"],
                twoFactorEnabled: false,
                joinedDaysAgo: 120,
                seenMinutesAgo: 60 * 26
            }),
            member(ctx, CREW.mateo, {
                roles: ["guest"],
                twoFactorEnabled: false,
                joinedDaysAgo: 30,
                seenMinutesAgo: 60 * 50,
                enforced: {
                    groupIds: [],
                    allowedCidrs: [],
                    allowedCountries: ["ES"],
                    allowedContinents: []
                }
            }),
            member(ctx, TEAM.sam, {
                roles: ["viewer"],
                banned: true,
                banReason: ctx.say("Left the company", "Dejó la empresa"),
                bannedAt: ago(ctx.now, 60 * 24 * 3),
                joinedDaysAgo: 360,
                seenMinutesAgo: 60 * 24 * 4
            })
        ],
        next: null
    };
}

/** Two invitations still waiting to be accepted. */
export function pendingInvites(ctx: SceneContext): InviteListItem[] {
    return [
        {
            id: id("invite", 1),
            email: "omar@example.com",
            method: "magic",
            role: "member",
            needsPassword: false,
            restricted: false,
            sentAt: ago(ctx.now, 60 * 3),
            expiresAt: ago(ctx.now, -60 * 24 * 6),
            createdAt: ago(ctx.now, 60 * 3)
        },
        {
            id: id("invite", 2),
            email: "yuki@example.com",
            method: "link",
            role: "guest",
            needsPassword: false,
            restricted: true,
            sentAt: null,
            expiresAt: ago(ctx.now, -60 * 24 * 2),
            createdAt: ago(ctx.now, 60 * 24)
        }
    ];
}

/** The roles the invite and role pickers offer. */
export const ROLE_OPTIONS: RoleOption[] = [
    { name: "admin", grants: 0 },
    { name: "guest", grants: 4 },
    { name: "member", grants: 24 },
    { name: "support", grants: 10 },
    { name: "viewer", grants: 8 }
];
