/**
 * Private addresses: one deployed domain that only answers people signed in to
 * Polaris and allowed in.
 *
 * Built on the firewall's require-login path rather than beside it. The edge guard
 * already sits in front of a route as Traefik `forwardAuth`, sends a visitor without
 * a token to `/edge/authorize`, and turns the short-lived, host-bound token that
 * comes back into a host-only cookie on the app's own domain - which is the one
 * handoff that works for a name outside the Polaris domain as well as under it. A
 * private domain is that rule switched on for one hostname, with its own list of who
 * gets in.
 *
 * "Project members" cannot be written into the edge rule: membership is teams,
 * organizations, policies and visibility resolved at request time, not a list of
 * principals the guard could compare offline. So it is decided at `/edge/authorize`,
 * live, and the token minted for a private address lives minutes rather than hours -
 * a member who is removed loses the address when that token runs out. A chosen list
 * of users, groups and roles also travels in the rule, so the guard re-checks it on
 * every request.
 *
 * Pure: no database, no request. The renderer and the authorize endpoint both call
 * it, so the rule the edge enforces and the answer the sign-in hop gives cannot drift.
 */

import { z } from "zod";
import type { AppRoute } from "@/lib/deploy/router";
import { principalVerdict } from "@polaris/core/waf";
import { WAF_LIST_MAX, wafPrincipalGrantSchema, type WafPrincipalGrant } from "@polaris/core";

/** How long a sign-in to a private address lasts before it is asked again. Short on
 *  purpose: project membership is checked when the token is minted, not after. */
export const PRIVATE_TOKEN_TTL_SECONDS = 15 * 60;

const grantList = z
    .array(wafPrincipalGrantSchema)
    .max(WAF_LIST_MAX, `At most ${WAF_LIST_MAX} entries`);

/** Who a private address admits: the project's members, named principals, or both
 *  (either is enough), minus anybody it refuses. */
export const privateAccessSchema = z
    .object({
        members: z.boolean(),
        allow: grantList.default([]),
        deny: grantList.default([])
    })
    .refine((access) => access.members || access.allow.length > 0, {
        message: "issues.privateAudience",
        path: ["allow"]
    });

export type PrivateAccess = z.infer<typeof privateAccessSchema>;

/** The action's input: null makes the address public again. */
export const domainPrivateInputSchema = z.object({
    domainId: z.string().uuid(),
    access: privateAccessSchema.nullable()
});

/** The stored column, read total: anything that does not parse is a public domain
 *  rather than an error, because a row older than this code must still route. */
export function parsePrivateAccess(raw: string | null | undefined): PrivateAccess | null {
    if (!raw) return null;
    try {
        const parsed = privateAccessSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * The route with its private rule folded in. Login is required whatever the
 * service's firewall says; a named list is added as one more list a visitor must
 * satisfy (lists AND, entries within one OR) - but only when members are not
 * admitted, because a list the guard enforces would shut members out. Refusals
 * always reach the guard.
 */
export function withPrivateAccess(route: AppRoute, access: PrivateAccess | null): AppRoute {
    if (!access) return route;
    return {
        ...route,
        requireLogin: true,
        loginAllowLists: access.members
            ? (route.loginAllowLists ?? [])
            : [...(route.loginAllowLists ?? []), access.allow],
        loginDeny: [...(route.loginDeny ?? []), ...access.deny]
    };
}

/** Whether a signed-in account may open a private address. `isMember` is the live
 *  project check; it is only asked when the address admits members. */
export function privateVerdict(
    access: PrivateAccess,
    held: ReadonlySet<string>,
    isMember: boolean,
    now: number
): "admitted" | "refused" | "not-admitted" {
    if (principalVerdict({ loginAllowLists: [], loginDeny: access.deny }, held, now) === "refused")
        return "refused";
    if (access.members && isMember) return "admitted";
    if (access.allow.length > 0) {
        const named = principalVerdict({ loginAllowLists: [access.allow] }, held, now);
        if (named === "admitted") return "admitted";
    }
    return "not-admitted";
}

/** Serialized for the column. */
export function storePrivateAccess(access: PrivateAccess | null): string | null {
    return access ? JSON.stringify(access) : null;
}

export type { WafPrincipalGrant };
