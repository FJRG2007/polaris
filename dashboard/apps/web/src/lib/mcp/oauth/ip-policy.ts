/**
 * Where a connected app may call from: the address rule a person sets on one
 * connection, on top of the account's own access rules.
 *
 *   - none      anywhere (the default, and what every connection made before
 *               this existed reads as)
 *   - origin    only the address it was approved from
 *   - list      an allow list and a deny list of addresses and CIDR ranges; a
 *               deny entry wins, and an empty allow list means "anything not
 *               denied"
 *   - sessions  only from where this person is signed in to Polaris right now,
 *               so the assistant works from their own devices and stops when
 *               they sign out there. An IPv6 address counts for its whole /64,
 *               because a device rotates its temporary address inside one.
 *
 * Matching is `ipAllowed` from core, the same check API keys and sign-in rules
 * use, so a rule means the same thing on every screen. Pure, so the MCP
 * endpoint, the token endpoint and the tests share one answer.
 */

import { z } from "zod";
import { ipAllowed, ipRuleField, isCidr, isIpAddress } from "@polaris/core";

export const IP_POLICY_MODES = ["none", "origin", "list", "sessions"] as const;
export type IpPolicyMode = (typeof IP_POLICY_MODES)[number];

/** More than anybody types by hand, few enough to check on every call. */
export const IP_LIST_MAX = 50;

const ruleList = z.array(ipRuleField).max(IP_LIST_MAX);

export const ipPolicySchema = z
    .object({
        mode: z.enum(IP_POLICY_MODES),
        allow: ruleList.default([]),
        deny: ruleList.default([])
    })
    .superRefine((value, context) => {
        if (value.mode === "list" && value.allow.length === 0 && value.deny.length === 0) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["allow"],
                message: "Add at least one address"
            });
        }
    });

export type IpPolicy = z.infer<typeof ipPolicySchema>;

export const OPEN_POLICY: IpPolicy = { mode: "none", allow: [], deny: [] };

/** A stored policy, or "anywhere" for a column that is empty or unreadable -
 *  never a refusal nobody can see the reason for. */
export function readIpPolicy(stored: string | null | undefined): IpPolicy {
    if (!stored) return OPEN_POLICY;
    try {
        const parsed = ipPolicySchema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : OPEN_POLICY;
    } catch {
        return OPEN_POLICY;
    }
}

/** An IPv4 address a dual-stack socket reported as ::ffff:a.b.c.d, as itself. */
function folded(address: string): string {
    return address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
}

/** An IPv6 address as its /64, so a device's rotating address still matches. */
function sessionRule(address: string): string | null {
    if (!isIpAddress(address)) return null;
    address = folded(address);
    if (!address.includes(":")) return address;
    const cidr = `${address}/64`;
    return isCidr(cidr) ? cidr : address;
}

export interface IpContext {
    /** The address the connection was approved from, when it was recorded. */
    readonly approvedIp: string | null;
    /** Where the person is signed in right now. Read only for "sessions". */
    readonly sessionIps: () => Promise<readonly string[]>;
}

/** Whether a call from `ip` may go through. No address resolves to a refusal
 *  under any rule but "none": a rule exists to name where calls come from. */
export async function ipPolicyAllows(
    policy: IpPolicy,
    ip: string | undefined,
    context: IpContext
): Promise<boolean> {
    if (policy.mode === "none") return true;
    if (!ip || !isIpAddress(ip)) return false;
    ip = folded(ip);
    if (policy.mode === "origin") {
        return context.approvedIp !== null && ipAllowed(ip, [folded(context.approvedIp)]);
    }
    if (policy.mode === "list") {
        if (policy.deny.length > 0 && ipAllowed(ip, policy.deny)) return false;
        return ipAllowed(ip, policy.allow);
    }
    const rules = (await context.sessionIps())
        .map(sessionRule)
        .filter((rule): rule is string => rule !== null);
    return rules.length > 0 && ipAllowed(ip, rules);
}
