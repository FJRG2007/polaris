/**
 * A connection's address rule on its own: what each mode lets through, and
 * that a stored value nobody can read means "anywhere" rather than a refusal.
 */

import { describe, expect, it } from "vitest";
import { ipPolicyAllows, ipPolicySchema, readIpPolicy } from "@/lib/mcp/oauth/ip-policy";

const context = (sessions: string[] = [], approvedIp: string | null = "203.0.113.5") => ({
    approvedIp,
    sessionIps: async () => sessions
});

describe("a connection's address rule", () => {
    it("lets anything through when there is none", async () => {
        expect(await ipPolicyAllows(readIpPolicy(null), undefined, context())).toBe(true);
        expect(await ipPolicyAllows(readIpPolicy("{not json"), "1.2.3.4", context())).toBe(true);
    });

    it("matches the approved address, including its IPv4-mapped form", async () => {
        const policy = readIpPolicy(JSON.stringify({ mode: "origin" }));
        expect(await ipPolicyAllows(policy, "203.0.113.5", context())).toBe(true);
        expect(await ipPolicyAllows(policy, "::ffff:203.0.113.5", context())).toBe(true);
        expect(await ipPolicyAllows(policy, "203.0.113.6", context())).toBe(false);
        expect(await ipPolicyAllows(policy, "203.0.113.5", context([], null))).toBe(false);
    });

    it("lets a deny entry win, and an empty allow list mean everything else", async () => {
        const both = ipPolicySchema.parse({
            mode: "list",
            allow: ["10.0.0.0/8"],
            deny: ["10.1.0.0/16"]
        });
        expect(await ipPolicyAllows(both, "10.2.3.4", context())).toBe(true);
        expect(await ipPolicyAllows(both, "10.1.3.4", context())).toBe(false);
        const denyOnly = ipPolicySchema.parse({ mode: "list", deny: ["2001:db8::/32"] });
        expect(await ipPolicyAllows(denyOnly, "2001:db8::1", context())).toBe(false);
        expect(await ipPolicyAllows(denyOnly, "2001:db9::1", context())).toBe(true);
        expect(await ipPolicyAllows(denyOnly, "not-an-ip", context())).toBe(false);
    });

    it("refuses a list rule with nothing in it, and anything that is not an address", () => {
        expect(ipPolicySchema.safeParse({ mode: "list" }).success).toBe(false);
        expect(ipPolicySchema.safeParse({ mode: "list", allow: ["example.com"] }).success).toBe(
            false
        );
        expect(ipPolicySchema.safeParse({ mode: "anything" }).success).toBe(false);
        expect(ipPolicySchema.parse({ mode: "list", allow: [" 192.0.2.0/24 "] }).allow).toEqual([
            "192.0.2.0/24"
        ]);
    });

    it("follows live sessions, an IPv6 one by its /64, and refuses with none", async () => {
        const policy = ipPolicySchema.parse({ mode: "sessions" });
        const live = context(["192.0.2.9", "2001:db8:1:2::abcd"]);
        expect(await ipPolicyAllows(policy, "192.0.2.9", live)).toBe(true);
        expect(await ipPolicyAllows(policy, "192.0.2.10", live)).toBe(false);
        expect(await ipPolicyAllows(policy, "2001:db8:1:2:ffff::1", live)).toBe(true);
        expect(await ipPolicyAllows(policy, "2001:db8:1:3::1", live)).toBe(false);
        expect(await ipPolicyAllows(policy, "192.0.2.9", context([]))).toBe(false);
    });
});
