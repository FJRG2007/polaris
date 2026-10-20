import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
    DEFAULT_POLAR_POLICY,
    audienceAdmits,
    decidePolarAccess,
    polarPolicySchema,
    unsavedPolarPolicy,
    type AccessFacts,
    type PolarAudience
} from "@/lib/polar/access";

vi.mock("@/lib/api-session", () => ({ apiUser: async () => null }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/agents/model-keys", () => ({}));

const GROUP = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const PICKED = "00000000-0000-4000-8000-000000000001";

const member: AccessFacts = {
    userId: "00000000-0000-4000-8000-000000000002",
    isAdmin: false,
    guest: false,
    groupIds: []
};
const admin: AccessFacts = {
    ...member,
    userId: "00000000-0000-4000-8000-000000000003",
    isAdmin: true
};
const guest: AccessFacts = {
    ...member,
    userId: "00000000-0000-4000-8000-000000000004",
    guest: true
};

const audience = (patch: Partial<PolarAudience>): PolarAudience => ({
    who: "everyone",
    userIds: [],
    groupIds: [],
    guests: false,
    ...patch
});

describe("Polar access policy", () => {
    it("defaults to Polar for everybody signed in but the deployment's keys for administrators only", () => {
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, member)).toMatchObject({
            use: true,
            spend: false
        });
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, admin)).toMatchObject({
            use: true,
            spend: true
        });
    });

    it("carries the deployment's key sharing over to a policy that was never saved", () => {
        expect(unsavedPolarPolicy(false)).toEqual(DEFAULT_POLAR_POLICY);
        expect(decidePolarAccess(unsavedPolarPolicy(true), member)).toMatchObject({
            use: true,
            spend: true
        });
        expect(decidePolarAccess(unsavedPolarPolicy(true), guest)).toMatchObject({
            use: false,
            spend: false
        });
    });

    it("keeps guests out unless the audience lets them in or names them", () => {
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, guest)).toMatchObject({
            use: false,
            spend: false
        });
        expect(audienceAdmits(audience({ guests: true }), guest)).toBe(true);
        expect(audienceAdmits(audience({ who: "chosen", userIds: [guest.userId] }), guest)).toBe(
            true
        );
        expect(
            audienceAdmits(audience({ who: "chosen", groupIds: [GROUP] }), {
                ...guest,
                groupIds: [GROUP]
            })
        ).toBe(false);
    });

    it("admits chosen people and members of chosen groups only", () => {
        const chosen = audience({ who: "chosen", userIds: [PICKED], groupIds: [GROUP] });
        expect(audienceAdmits(chosen, { ...member, userId: PICKED })).toBe(true);
        expect(audienceAdmits(chosen, { ...member, groupIds: [GROUP] })).toBe(true);
        expect(audienceAdmits(chosen, { ...member, groupIds: [OTHER] })).toBe(false);
        expect(audienceAdmits(chosen, member)).toBe(false);
    });

    it("never lets anybody spend the keys of a Polar they may not use", () => {
        const policy = {
            use: audience({ who: "admins" }),
            spend: audience({ who: "everyone" }),
            web: true
        };
        expect(decidePolarAccess(policy, member)).toMatchObject({ use: false, spend: false });
        expect(decidePolarAccess(policy, admin)).toMatchObject({ use: true, spend: true });
    });

    it("lets Polar on the web by default, and not once an administrator turns it off", () => {
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, member).web).toBe(true);
        // A policy saved before the setting existed reads as on.
        const saved = polarPolicySchema.parse({
            use: { who: "everyone" },
            spend: { who: "admins" }
        });
        expect(saved.web).toBe(true);
        expect(decidePolarAccess({ ...saved, web: false }, member).web).toBe(false);
        expect(decidePolarAccess({ ...saved, web: false }, admin).web).toBe(false);
        // Nobody barred from Polar reaches its web tools.
        expect(decidePolarAccess(DEFAULT_POLAR_POLICY, guest).web).toBe(false);
    });

    it("rejects a policy that is not one of the audiences", () => {
        expect(
            polarPolicySchema.safeParse({ use: { who: "anyone" }, spend: { who: "admins" } })
                .success
        ).toBe(false);
        expect(
            polarPolicySchema.safeParse({
                use: { who: "chosen", userIds: ["x"] },
                spend: { who: "admins" }
            }).success
        ).toBe(false);
    });

    it("is asked by every Polar route instead of the plain session check", () => {
        const root = resolve(__dirname, "../../src/app/api/polar");
        const routes: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (statSync(path).isDirectory()) walk(path);
                else if (name === "route.ts") routes.push(path);
            }
        };
        walk(root);
        expect(routes.length).toBeGreaterThan(10);
        for (const path of routes) {
            const source = readFileSync(path, "utf8");
            expect(source, path).toContain("polarCaller()");
            expect(source, path).not.toMatch(/\bapiUser\(/);
        }
    });
});
