/**
 * Resolving a Minecraft server once per poll, and never across polls.
 *
 * One poll of a server's page asks the same install for its status, its roster,
 * its firewall and its history, and each of those used to look the install up on
 * its own - the same queries four times over for one answer. Inside a scope
 * opened for that poll the lookup is shared; outside one it is not, so a verb
 * never acts on a row older than the request it came in.
 *
 * The batch lookup is the watcher's: every server an owner has, resolved in one
 * pass rather than one pass each, with the ones that cannot be resolved left out
 * for the single lookup to explain.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ONE = "aaaaaaaa-1111-4111-8111-111111111111";
const TWO = "bbbbbbbb-1111-4111-8111-111111111111";

let installReads = 0;
let applicationReads = 0;

function installRow(id: string, applicationId: string | null) {
    return {
        id,
        name: `Server ${id.slice(0, 1)}`,
        catalogId: "minecraft",
        applicationId,
        config: "{}"
    };
}

function application(id: string) {
    return {
        id,
        slug: `app-${id.slice(0, 1)}`,
        sourceConfig: "{}",
        desiredState: "running",
        currentDeploymentId: null,
        target: { id: "local", kind: "local", hostId: null },
        environment: { project: { slug: "games" } }
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async ({ where }: { where: { id: string } }) => {
                installReads += 1;
                return installRow(where.id, `app-${where.id}`);
            },
            findMany: async () => {
                installReads += 1;
                // The second server was never deployed, so it cannot be resolved.
                return [installRow(ONE, `app-${ONE}`), installRow(TWO, null)];
            }
        },
        application: {
            findFirst: async ({ where }: { where: { id: string } }) => {
                applicationReads += 1;
                return application(where.id);
            },
            findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                applicationReads += 1;
                return where.id.in.map(application);
            }
        }
    }
}));

vi.mock("@/lib/deploy/releases", () => ({
    currentReleaseRef: async (app: { id: string }) => ({
        name: `container-${app.id}`,
        portSubject: app.id
    })
}));
vi.mock("@/lib/deploy-service", () => ({
    readAppRuntimeLog: async () => "",
    hostPortForApp: () => 25565
}));

const service = await import("@polaris-app/game-servers/src/lib/minecraft/service");

beforeEach(() => {
    installReads = 0;
    applicationReads = 0;
});

describe("sharingInstallReads", () => {
    it("looks the install up once for every read in the scope", async () => {
        await service.sharingInstallReads(() =>
            Promise.all([
                service.getPlayerSessions(OWNER, ONE),
                service.getPlayerSessions(OWNER, ONE),
                service.getPlayerSessions(OWNER, ONE)
            ])
        );
        expect(installReads).toBe(1);
        expect(applicationReads).toBe(1);
    });

    it("shares nothing outside a scope", async () => {
        await service.getPlayerSessions(OWNER, ONE);
        await service.getPlayerSessions(OWNER, ONE);
        expect(installReads).toBe(2);
    });

    it("does not carry one scope's lookup into the next", async () => {
        await service.sharingInstallReads(() => service.getPlayerSessions(OWNER, ONE));
        await service.sharingInstallReads(() => service.getPlayerSessions(OWNER, ONE));
        expect(installReads).toBe(2);
    });
});

describe("resolveInstalls", () => {
    it("resolves many servers in one pass and leaves out the ones it cannot", async () => {
        const resolved = await service.resolveInstalls(OWNER, [ONE, TWO]);
        expect(installReads).toBe(1);
        expect(applicationReads).toBe(1);
        expect([...resolved.keys()]).toEqual([ONE]);
        expect(resolved.get(ONE)).toMatchObject({
            installedAppId: ONE,
            applicationId: `app-${ONE}`,
            container: `container-app-${ONE}`,
            running: true,
            edition: "java"
        });
    });

    it("asks nothing for an empty list", async () => {
        expect((await service.resolveInstalls(OWNER, [])).size).toBe(0);
        expect(installReads).toBe(0);
    });
});
