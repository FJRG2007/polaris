import { beforeEach, describe, expect, it, vi } from "vitest";

const hosts = new Map<string, { id: string; ownerId: string; name: string; address: string; dockerId: string | null }>();
const domains = new Map<string, { id: string; hostname: string; ownerId: string }>();
const grants = new Map<string, { capability: string; actions: string[] }[]>();

const OWNER = "owner-1";
const VISITOR = "visitor-1";
const LENT = "0190a000-0000-7000-8000-000000000001";
const OTHER = "0190a000-0000-7000-8000-000000000002";
const LOCAL_ROW = "0190a000-0000-7000-8000-000000000003";
const DOMAIN = "0190a000-0000-7000-8000-0000000000d1";

vi.mock("@polaris/db", () => ({
    prisma: {
        host: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => hosts.get(where.id) ?? null),
            findFirst: vi.fn(
                async ({ where }: { where: { id: string; ownerId: string } }) =>
                    [...hosts.values()].find((host) => host.id === where.id && host.ownerId === where.ownerId) ?? null
            )
        },
        domain: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
                const domain = domains.get(where.id);
                return domain
                    ? {
                          id: domain.id,
                          hostname: domain.hostname,
                          application: { environment: { project: { ownerId: domain.ownerId } } }
                      }
                    : null;
            })
        }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    GrantError: class GrantError extends Error {},
    liveGrants: vi.fn(async (userId: string, subject: string, id: string) =>
        (grants.get(`${userId}:${subject}:${id}`) ?? []).map((grant, index) => ({
            id: `g-${index}`,
            capability: grant.capability,
            actions: grant.actions,
            until: null,
            counted: true
        }))
    ),
    grantedSubjects: vi.fn(async () => new Map())
}));
vi.mock("@/lib/local-machine", () => ({
    localMachineIdentity: vi.fn(async () => ({ hostId: LOCAL_ROW, dockerId: null, addresses: new Set() })),
    isLocalMachine: (host: { id?: string }, identity: { hostId: string }) => host.id === identity.hostId
}));
vi.mock("@/lib/session", () => ({
    sessionCan: vi.fn(async (user: { id: string }) => user.id === OWNER)
}));
vi.mock("@/lib/metrics-history-service", () => ({
    subjectBelongsToOwner: vi.fn(async (_type: string, subject: string, ownerId: string) =>
        [...hosts.values()].some((host) => host.id === subject && host.ownerId === ownerId)
    ),
    getMetricSeries: vi.fn(async () => [])
}));
vi.mock("@/lib/api-session", () => ({ apiUser: vi.fn() }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/metrics-live", () => ({
    subjectKey: (type: string, id: string) => `${type}:${id}`,
    metricTickStream: vi.fn(() => new Response("stream"))
}));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: vi.fn(async () => []) }));
vi.mock("@/lib/notes/access", () => ({ requireSpace: vi.fn() }));
vi.mock("@/lib/office/documents", () => ({ requireShareable: vi.fn() }));
vi.mock("@/lib/chat/access", () => ({ requireSpace: vi.fn(), requireChannel: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({ requireSpace: vi.fn(), requireFolder: vi.fn() }));

import * as core from "@polaris/core";
import { apiUser } from "@/lib/api-session";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { getMetricSeries } from "@/lib/metrics-history-service";
import { containerMachineId } from "@/lib/machines/machine-links";
import { requireMayShare, shareIsBounded } from "@/lib/access/sharing-service";
import { GET as stream } from "@/app/api/watch/hosts/[id]/metrics/stream/route";
import { GET as history } from "@/app/api/watch/hosts/[id]/metrics/history/route";
import { borrowedDomain, borrowedServer, serverMetricsOwner } from "@/lib/machines/machine-access";

const owner = { id: OWNER, isAdmin: false } as never;
const visitor = { id: VISITOR, isAdmin: false } as never;

beforeEach(() => {
    hosts.clear();
    domains.clear();
    grants.clear();
    hosts.set(LENT, { id: LENT, ownerId: OWNER, name: "Web", address: "10.0.0.2", dockerId: null });
    hosts.set(OTHER, { id: OTHER, ownerId: OWNER, name: "Db", address: "10.0.0.3", dockerId: null });
    hosts.set(LOCAL_ROW, { id: LOCAL_ROW, ownerId: OWNER, name: "Box", address: "10.0.0.1", dockerId: null });
    domains.set(DOMAIN, { id: DOMAIN, hostname: "app.example.test", ownerId: OWNER });
    vi.mocked(getMetricSeries).mockClear();
});

function lend(subject: string, id: string, actions: string[] = ["watch"]) {
    grants.set(`${VISITOR}:${subject}:${id}`, [{ capability: "view", actions }]);
}

describe("servers and domains lent to watch", () => {
    it("offers watching only", () => {
        for (const subject of ["place.server", "place.domain"] as const) {
            expect(core.GRANT_CAPABILITIES[subject]).toEqual(["view"]);
            expect(core.GRANT_ACTIONS[subject]).toEqual(["watch"]);
            expect(core.grantActions(subject, "view", [])).toEqual(["watch"]);
            expect(shareIsBounded(subject)).toBe(true);
        }
    });

    it("lets the owner lend a server and a domain, and nobody else", async () => {
        await expect(requireMayShare(owner, "place.server", LENT)).resolves.toBeUndefined();
        await expect(requireMayShare(owner, "place.domain", DOMAIN)).resolves.toBeUndefined();
        await expect(requireMayShare(visitor, "place.server", LENT)).rejects.toThrow("You cannot share that");
        await expect(requireMayShare(visitor, "place.domain", DOMAIN)).rejects.toThrow("You cannot share that");
    });

    it("never lends the machine Polaris runs on, by any of its ids", async () => {
        for (const id of [core.LOCAL_SERVER_ID, LOCAL_HOST_SUBJECT, LOCAL_ROW]) {
            await expect(requireMayShare(owner, "place.server", id)).rejects.toThrow("You cannot share that");
        }
        lend("place.server", LOCAL_ROW);
        expect(await borrowedServer(VISITOR, LOCAL_ROW)).toBeNull();
    });

    it("shows a visitor the one server lent to them and no other", async () => {
        lend("place.server", LENT);
        expect(await borrowedServer(VISITOR, LENT)).toMatchObject({ id: LENT, ownerId: OWNER });
        expect(await borrowedServer(VISITOR, OTHER)).toBeNull();
        expect(await borrowedServer(OWNER, LENT)).toBeNull();
    });

    it("shows a visitor a lent domain, and nothing once the grant is gone", async () => {
        lend("place.domain", DOMAIN);
        expect(await borrowedDomain(VISITOR, DOMAIN)).toMatchObject({ ownerId: OWNER });
        // An expired or revoked grant is not live, so liveGrants answers none.
        grants.clear();
        expect(await borrowedDomain(VISITOR, DOMAIN)).toBeNull();
        expect(await borrowedServer(VISITOR, LENT)).toBeNull();
    });

    it("reads a borrowed server's load as its owner's", async () => {
        lend("place.server", LENT);
        expect(await serverMetricsOwner(owner, LENT)).toBe(OWNER);
        expect(await serverMetricsOwner(visitor, LENT)).toBe(OWNER);
        expect(await serverMetricsOwner(visitor, OTHER)).toBeNull();
        expect(await serverMetricsOwner(visitor, core.LOCAL_SERVER_ID)).toBeNull();
    });
});

describe("the load routes", () => {
    const call = (route: typeof history, id: string) =>
        route(new Request(`http://polaris.test/api/watch/hosts/${id}/metrics/x?range=1h`), {
            params: Promise.resolve({ id })
        });

    it("serve a borrowed server and refuse every other", async () => {
        vi.mocked(apiUser).mockResolvedValue(visitor);
        lend("place.server", LENT);
        const lent = await call(history, LENT);
        expect(lent.status).toBe(200);
        expect(vi.mocked(getMetricSeries).mock.calls[0]![0]).toMatchObject({ subjectId: LENT, ownerId: OWNER });
        expect((await call(stream, LENT)).status).toBe(200);

        for (const id of [OTHER, core.LOCAL_SERVER_ID]) {
            expect((await call(history, id)).status).toBe(404);
            expect((await call(stream, id)).status).toBe(404);
        }
    });

    it("stop serving it once the grant is gone", async () => {
        vi.mocked(apiUser).mockResolvedValue(visitor);
        expect((await call(history, LENT)).status).toBe(404);
        expect((await call(stream, LENT)).status).toBe(404);
    });
});

describe("a container's id in Places", () => {
    it("is the server's metric subject and the engine's id", () => {
        expect(containerMachineId({ local: true }, "abc")).toBe(`${LOCAL_HOST_SUBJECT}:abc`);
        expect(containerMachineId({ host: true, hostId: LENT }, "abc")).toBe(`${LENT}:abc`);
        expect(containerMachineId({}, "abc")).toBeNull();
    });
});
