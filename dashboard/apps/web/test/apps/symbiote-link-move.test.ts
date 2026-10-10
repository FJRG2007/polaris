/**
 * Symbiote entries written before the jar moved behind the pack link.
 *
 * What is pinned: when the dashboard boots, every server still listing the
 * public route's address is moved onto its own pack link, with the rest of its
 * list kept; a server already on its link, a removed one, and a dashboard with
 * no public address are left alone; and reading the row never writes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const FILE = "symbiote-neoforge-1.21.4.jar";
const SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b298";
const BASE = "https://polaris.example";
const OTHER = "https://example.com/some-mod.jar";

const fake = vi.hoisted(() => ({
    mods: "",
    installed: true,
    base: "https://polaris.example" as string | null,
    writes: [] as Array<{ scopeId: string; owner: string; value: string }>
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret" }) }));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => (fake.installed ? { id: SERVER, ownerId: "owner-1" } : null)
        },
        envVar: {
            findMany: async () =>
                fake.mods.includes(FILE) ? [{ scopeId: "app-1", value: fake.mods }] : []
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: { readInstallConfig: () => ({}) },
        envVarService: {
            listEnvVars: async () => [{ key: "MODS", value: fake.mods }],
            setEnvVars: async (
                _scope: string,
                scopeId: string,
                owner: string,
                vars: Array<{ value: string }>
            ) => {
                for (const item of vars) fake.writes.push({ scopeId, owner, value: item.value });
                return vars.length;
            }
        },
        domainService: { publicAppUrl: async () => fake.base }
    }
}));

const { packUrl } = await import("@polaris-app/game-servers/src/lib/minecraft/client-pack");
const service = await import("@polaris-app/game-servers/src/lib/minecraft/symbiote-service");

const LINK = packUrl(BASE, SERVER, FILE);
const PUBLIC = `${BASE}/api/minecraft/mod/${FILE}`;

beforeEach(() => {
    fake.mods = `${OTHER},${PUBLIC}`;
    fake.installed = true;
    fake.base = BASE;
    fake.writes = [];
});

describe("moving Symbiote onto the pack link", () => {
    it("moves a server still listing the public route, keeping the rest of its list", async () => {
        await service.moveSymbioteLinks();
        expect(fake.writes).toEqual([
            { scopeId: "app-1", owner: "owner-1", value: `${OTHER},${LINK}` }
        ]);
    });

    it("leaves a server already on its link, a removed one, and no public address alone", async () => {
        fake.mods = `${OTHER},${LINK}`;
        await service.moveSymbioteLinks();
        fake.mods = `${OTHER},${PUBLIC}`;
        fake.installed = false;
        await service.moveSymbioteLinks();
        fake.installed = true;
        fake.base = null;
        await service.moveSymbioteLinks();
        expect(fake.writes).toEqual([]);
    });

    it("never writes when the row only reads", async () => {
        const state = await service.symbioteState("app-1", "owner-1", SERVER);
        expect(state.installed).toBe(true);
        expect(fake.writes).toEqual([]);
    });
});
