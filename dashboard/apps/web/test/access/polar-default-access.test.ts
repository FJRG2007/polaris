/**
 * Polar's default access (the audiences behind `polar.use` and `polar.spend`)
 * is edited under Management > Roles, and the rest of Polar's policy under
 * Polaris apps > Polar > Settings. Both write parts of the one stored policy,
 * so neither screen may change the other's part, and nobody gains or loses
 * Polar on the update that split them.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ rows: new Map<string, string>(), shared: false }));

vi.mock("@/lib/api-session", () => ({ apiUser: async () => null }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/auth", () => ({ resolveGlobalStatements: async () => [] }));
vi.mock("@/lib/agents/model-keys", () => ({ instanceKeysAreShared: async () => store.shared }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => store.rows.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
        store.rows.set(key, value);
    }
}));

import {
    decidePolarAccess,
    polarAudiencesSchema,
    polarOptionsSchema,
    readPolarPolicy,
    savePolarPolicyPart,
    type AccessFacts,
    type PolarPolicy
} from "@/lib/polar/access";

const GROUP = "00000000-0000-4000-8000-0000000000a1";
const PICKED = "00000000-0000-4000-8000-000000000001";

const people: AccessFacts[] = [
    { userId: "00000000-0000-4000-8000-000000000002", isAdmin: false, guest: false, groupIds: [] },
    { userId: "00000000-0000-4000-8000-000000000003", isAdmin: true, guest: false, groupIds: [] },
    { userId: "00000000-0000-4000-8000-000000000004", isAdmin: false, guest: true, groupIds: [] },
    { userId: PICKED, isAdmin: false, guest: true, groupIds: [] },
    { userId: "00000000-0000-4000-8000-000000000005", isAdmin: false, guest: false, groupIds: [GROUP] },
    {
        userId: "00000000-0000-4000-8000-000000000006",
        isAdmin: false,
        guest: false,
        groupIds: [],
        grants: { use: "deny", spend: "none" }
    },
    {
        userId: "00000000-0000-4000-8000-000000000007",
        isAdmin: false,
        guest: true,
        groupIds: [],
        grants: { use: "allow", spend: "allow" }
    }
];

/** A policy saved before the split: chosen people, a group and guests. */
const stored: PolarPolicy = {
    use: { who: "chosen", userIds: [PICKED], groupIds: [GROUP], guests: true },
    spend: { who: "everyone", userIds: [], groupIds: [], guests: false },
    web: false,
    connectors: { who: "admins", hosts: ["mcp.example.test"], privateNetwork: true },
    freeModels: true,
    zenStandInEveryone: true
};

const answers = (policy: PolarPolicy) => people.map((facts) => decidePolarAccess(policy, facts));

beforeEach(() => {
    store.rows.clear();
    store.shared = false;
});

describe("Polar's default access, edited apart from its options", () => {
    it("saving the options leaves every audience, and so everybody's access, as it was", async () => {
        store.rows.set("polar.access", JSON.stringify(stored));
        const before = answers(await readPolarPolicy());

        await savePolarPolicyPart(polarOptionsSchema.parse({ ...stored, web: true }));

        const after = await readPolarPolicy();
        expect(after.use).toEqual(stored.use);
        expect(after.spend).toEqual(stored.spend);
        expect(after.web).toBe(true);
        expect(answers(after).map(({ use, spend }) => ({ use, spend }))).toEqual(
            before.map(({ use, spend }) => ({ use, spend }))
        );
    });

    it("saving the audiences leaves the options", async () => {
        store.rows.set("polar.access", JSON.stringify(stored));

        await savePolarPolicyPart(
            polarAudiencesSchema.parse({ ...stored, spend: { ...stored.spend, who: "admins" } })
        );

        const after = await readPolarPolicy();
        expect(polarOptionsSchema.parse(after)).toEqual(polarOptionsSchema.parse(stored));
        expect(after.use).toEqual(stored.use);
        expect(after.spend.who).toBe("admins");
    });

    it("an install that never saved a policy keeps the answer it was reading", async () => {
        for (const shared of [false, true]) {
            store.rows.clear();
            store.shared = shared;
            const before = answers(await readPolarPolicy());

            await savePolarPolicyPart(polarOptionsSchema.parse(await readPolarPolicy()));
            // Turning the deployment's key sharing off afterwards no longer moves it:
            // the stored policy is what saving the whole card stored before.
            store.shared = !shared;

            expect(answers(await readPolarPolicy())).toEqual(before);
        }
    });

    it("each part's schema holds only its own fields", () => {
        expect(Object.keys(polarAudiencesSchema.parse(stored)).sort()).toEqual(["spend", "use"]);
        expect(Object.keys(polarOptionsSchema.parse(stored)).sort()).toEqual([
            "connectors",
            "freeModels",
            "web",
            "zenStandInEveryone"
        ]);
    });
});

describe("where Polar's settings are edited", () => {
    const admin = resolve(__dirname, "../../src/app/(app)/admin");
    const read = (...path: string[]) => readFileSync(join(admin, ...path), "utf8");

    it("the audiences are on Management > Roles, not on a settings page", () => {
        expect(read("roles", "loader.tsx")).toContain("PolarAudienceCard");
        expect(read("roles", "polar-actions.ts")).toContain("polarAudiencesSchema");
        const settings = read("apps", "[appId]", "settings", "_polar", "polar-options-card.tsx");
        expect(settings).not.toMatch(/\bspend\b|polarAccess\.use|polarAccess\.who/);
        expect(read("agents", "loader.tsx")).not.toMatch(/Polar|Routing|SharedWorkspace/);
    });

    it("Polar's own settings are drawn on Polaris apps > Polar > Settings", () => {
        const page = read("apps", "[appId]", "settings", "_polar", "polar-settings.tsx");
        for (const card of ["PolarOptionsCard", "RoutingCard", "SharedWorkspaceCard", "PolarCodeView"]) {
            expect(page).toContain(card);
        }
    });
});
