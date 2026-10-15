/**
 * Container registry logins: who sees and changes them, that a secret is sealed
 * at rest and never handed back, and which login a deploy pulls with.
 *
 * The database is an in-memory table and organization access a fixed map; the
 * encryption is the real one, so a stored row is checked against real
 * ciphertext.
 */

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "00000000-0000-7000-8000-0000000000aa";
const OTHER = "00000000-0000-7000-8000-0000000000bb";
const ORG = "00000000-0000-7000-8000-0000000000cc";
const OTHER_ORG = "00000000-0000-7000-8000-0000000000dd";
const APP = "00000000-0000-7000-8000-0000000000ee";
const MASTER_KEY = randomBytes(32).toString("base64");

type Row = {
    id: string;
    ownerId: string;
    orgId: string | null;
    name: string;
    kind: string;
    registry: string;
    username: string;
    encryptedPassword: Uint8Array;
    passwordNonce: Uint8Array;
    passwordKeyId: string;
    lastTestedAt: Date | null;
    lastTestOk: boolean | null;
    createdAt: Date;
    updatedAt: Date;
};

let rows: Row[] = [];
let nextId = 1;
let application: { sourceConfig: string; environment: { project: { ownerId: string; orgId: string | null } } } | null;
/** The organization permissions each (user, org) pair holds. */
let access: Record<string, string[]> = {};

function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value);
}

const prisma = {
    registryCredential: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)),
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
            rows.find((row) => matches(row, where)) ?? null,
        findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
        create: async ({ data }: { data: Omit<Row, "id" | "createdAt" | "updatedAt" | "lastTestedAt" | "lastTestOk"> }) => {
            const row: Row = {
                ...data,
                id: `r${nextId++}`,
                lastTestedAt: null,
                lastTestOk: null,
                createdAt: new Date(),
                updatedAt: new Date()
            };
            rows.push(row);
            return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
            const row = rows.find((entry) => entry.id === where.id)!;
            Object.assign(row, data, { updatedAt: new Date() });
            return row;
        },
        delete: async ({ where }: { where: { id: string } }) => {
            rows = rows.filter((row) => row.id !== where.id);
        }
    },
    application: {
        findUnique: async () => application,
        update: async ({ data }: { data: { sourceConfig: string } }) => {
            if (application) application.sourceConfig = data.sourceConfig;
        }
    }
};

const configuredRequest = vi.fn();

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: MASTER_KEY }) }));
vi.mock("@/lib/safe-fetch", () => ({ configuredRequest }));
vi.mock("@/lib/orgs/org-service", () => ({
    resolveOrgAccess: async (actor: { id: string }, orgId: string) => access[`${actor.id}:${orgId}`] ?? null,
    orgCan: (held: string[] | null, permission: string) => held !== null && held.includes(permission)
}));

const service = await import("@/lib/registry-credential-service");
const form = await import("@/lib/registries/registry-form");

const me = { id: ME, isAdmin: false };
const other = { id: OTHER, isAdmin: false };

function values(overrides: Partial<import("@/lib/registries/registry-form").RegistryFormValues> = {}) {
    return { kind: "ghcr" as const, name: "", host: "", username: "octo", password: "ghp_secret_value", ...overrides };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (caught) {
        if (caught instanceof service.RegistryRefusal) return caught.key;
        throw caught;
    }
    throw new Error("expected a refusal");
}

beforeEach(() => {
    rows = [];
    nextId = 1;
    application = null;
    access = {};
    configuredRequest.mockReset();
});

describe("the registry form", () => {
    it("treats empty required fields as unfinished, keyed for the catalog", () => {
        const issues = form.registryFormIssues(
            { kind: "generic", name: "", host: "", username: "", password: "" },
            false
        );
        expect(issues).toEqual({
            host: "form.hostRequired",
            username: "form.usernameRequired",
            password: "form.secretRequired"
        });
    });

    it("fills the kind's host and canonicalizes a typed one", () => {
        expect(form.normalizeRegistryForm(values()).host).toBe("ghcr.io");
        expect(form.normalizeRegistryForm(values({ host: " https://Index.Docker.io/v2/ " })).host).toBe("docker.io");
        expect(form.registryFormIssues(values({ kind: "generic", host: "not a host" }), false).host).toBe(
            "form.hostInvalid"
        );
    });

    it("lets an edit leave the secret empty", () => {
        expect(form.registryFormIssues(values({ password: "" }), true)).toEqual({});
        expect(form.registryFormIssues(values({ password: "" }), false).password).toBe("form.secretRequired");
    });
});

describe("storing a login", () => {
    it("seals the secret and never returns it", async () => {
        const view = await service.createRegistry(me, null, values());
        expect(Object.keys(view).sort()).toEqual(
            ["id", "kind", "lastTestOk", "lastTestedAt", "name", "orgId", "registry", "updatedAt", "username"].sort()
        );
        expect(JSON.stringify(view)).not.toContain("ghp_secret_value");
        const stored = rows[0]!;
        expect(Buffer.from(stored.encryptedPassword).toString("utf8")).not.toContain("ghp_secret_value");
        expect(stored.registry).toBe("ghcr.io");
        expect(stored.orgId).toBeNull();
    });

    it("refuses a bad form on the server too", async () => {
        expect(await refusal(service.createRegistry(me, null, values({ username: "has space" })))).toBe(
            "form.usernameInvalid"
        );
        expect(rows).toHaveLength(0);
    });

    it("asks for the secret again when the host or user moves", async () => {
        const view = await service.createRegistry(me, null, values());
        expect(await refusal(service.updateRegistry(me, view.id, values({ username: "someone", password: "" })))).toBe(
            "form.secretRequiredOnMove"
        );
        const renamed = await service.updateRegistry(me, view.id, values({ name: "CI images", password: "" }));
        expect(renamed.name).toBe("CI images");
    });
});

describe("who sees and changes a login", () => {
    it("keeps a personal login to its owner", async () => {
        const mine = await service.createRegistry(me, null, values());
        await service.createRegistry(other, null, values({ username: "theirs" }));
        const shelf = await service.listRegistries(me, null);
        expect(shelf.registries.map((entry) => entry.id)).toEqual([mine.id]);
        expect(shelf.canManage).toBe(true);
        expect(await refusal(service.updateRegistry(other, mine.id, values()))).toBe("errors.notFound");
        expect(await refusal(service.deleteRegistry(other, mine.id))).toBe("errors.notFound");
        expect(rows).toHaveLength(2);
    });

    it("lets an organization's members use its logins and only managers change them", async () => {
        access[`${ME}:${ORG}`] = ["org.read", "deploy.manage"];
        access[`${OTHER}:${ORG}`] = ["org.read"];
        const shared = await service.createRegistry(me, ORG, values());

        const memberShelf = await service.listRegistries(other, ORG);
        expect(memberShelf.canManage).toBe(false);
        expect(memberShelf.registries.map((entry) => entry.id)).toEqual([shared.id]);
        expect(await refusal(service.createRegistry(other, ORG, values()))).toBe("errors.cannotManage");
        expect(await refusal(service.updateRegistry(other, shared.id, values({ password: "" })))).toBe(
            "errors.cannotManage"
        );
        expect(await refusal(service.deleteRegistry(other, shared.id))).toBe("errors.cannotManage");

        // The organization's logins are not on anybody's personal shelf.
        expect((await service.listRegistries(me, null)).registries).toEqual([]);
    });

    it("hides an organization's logins from somebody outside it", async () => {
        access[`${ME}:${ORG}`] = ["org.read", "deploy.manage"];
        const shared = await service.createRegistry(me, ORG, values());
        expect(await refusal(service.listRegistries(other, ORG))).toBe("errors.notFound");
        expect(await refusal(service.deleteRegistry(other, shared.id))).toBe("errors.notFound");
    });
});

describe("the login a deploy pulls with", () => {
    it("matches the image host on the owner's own logins, as before", async () => {
        await service.createRegistry(me, null, values());
        const login = await service.resolveRegistryLogin(ME, "ghcr.io/acme/api:1");
        expect(login).toEqual({ registry: "ghcr.io", username: "octo", password: "ghp_secret_value", matchesImage: true });
        expect(await service.resolveRegistryLogin(ME, "nginx:latest")).toBeNull();
        expect(await service.resolveRegistryLogin(OTHER, "ghcr.io/acme/api:1")).toBeNull();
    });

    it("signs in to Docker Hub with an empty registry", async () => {
        await service.createRegistry(me, null, values({ kind: "dockerhub", username: "hubuser" }));
        const login = await service.resolveRegistryLogin(ME, "acme/private:2");
        expect(login?.registry).toBe("");
        expect(login?.username).toBe("hubuser");
    });

    it("prefers the organization's login for an organization's project", async () => {
        access[`${ME}:${ORG}`] = ["org.read", "deploy.manage"];
        await service.createRegistry(me, null, values({ username: "personal" }));
        await service.createRegistry(me, ORG, values({ username: "company" }));
        application = { sourceConfig: "{}", environment: { project: { ownerId: ME, orgId: ORG } } };
        const login = await service.resolveRegistryLogin(ME, "ghcr.io/acme/api:1", APP);
        expect(login?.username).toBe("company");
    });

    it("uses the service's pick, and ignores a pick the project may not use", async () => {
        access[`${ME}:${ORG}`] = ["org.read", "deploy.manage"];
        access[`${ME}:${OTHER_ORG}`] = ["org.read", "deploy.manage"];
        const picked = await service.createRegistry(me, ORG, values({ kind: "generic", host: "registry.acme.test", username: "pinned" }));
        const foreign = await service.createRegistry(me, OTHER_ORG, values({ username: "foreign" }));
        await service.createRegistry(me, ORG, values({ username: "by-host" }));
        application = { sourceConfig: "{}", environment: { project: { ownerId: ME, orgId: ORG } } };

        await service.setApplicationRegistry(APP, picked.id);
        const pinned = await service.resolveRegistryLogin(ME, "ghcr.io/acme/api:1", APP);
        expect(pinned).toMatchObject({ registry: "registry.acme.test", username: "pinned", matchesImage: false });

        expect(await refusal(service.setApplicationRegistry(APP, foreign.id))).toBe("errors.notUsable");
        // A pick that slipped in some other way is still not used.
        application.sourceConfig = JSON.stringify({ registryId: foreign.id });
        expect((await service.resolveRegistryLogin(ME, "ghcr.io/acme/api:1", APP))?.username).toBe("by-host");

        await service.setApplicationRegistry(APP, null);
        expect(JSON.parse(application.sourceConfig)).toEqual({});
    });

    it("never uses an organization's login for a personal project", async () => {
        access[`${ME}:${ORG}`] = ["org.read", "deploy.manage"];
        await service.createRegistry(me, ORG, values());
        application = { sourceConfig: "{}", environment: { project: { ownerId: ME, orgId: null } } };
        expect(await service.resolveRegistryLogin(ME, "ghcr.io/acme/api:1", APP)).toBeNull();
    });
});

describe("testing a login", () => {
    function answer(status: number, headers: Record<string, string> = {}) {
        return new Response(null, { status, headers });
    }

    it("follows the token challenge with the login and records the answer", async () => {
        const view = await service.createRegistry(me, null, values());
        configuredRequest
            .mockResolvedValueOnce(answer(401, { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }))
            .mockResolvedValueOnce(answer(200));
        expect(await service.testRegistry(me, { id: view.id, orgId: null })).toBe("ok");
        const tokenCall = configuredRequest.mock.calls[1]!;
        expect(String(tokenCall[0])).toContain("account=octo");
        expect(tokenCall[1].headers.authorization).toBe(
            `Basic ${Buffer.from("octo:ghp_secret_value").toString("base64")}`
        );
        expect(rows[0]!.lastTestOk).toBe(true);
    });

    it("reports a refused login", async () => {
        const view = await service.createRegistry(me, null, values());
        configuredRequest
            .mockResolvedValueOnce(answer(401, { "www-authenticate": 'Bearer realm="https://ghcr.io/token"' }))
            .mockResolvedValueOnce(answer(401));
        expect(await service.testRegistry(me, { id: view.id, orgId: null })).toBe("denied");
        expect(rows[0]!.lastTestOk).toBe(false);
    });

    it("does not test somebody else's login", async () => {
        const view = await service.createRegistry(me, null, values());
        expect(await refusal(service.testRegistry(other, { id: view.id, orgId: null }))).toBe("errors.notFound");
        expect(configuredRequest).not.toHaveBeenCalled();
    });

    it("never sends a stored secret to a host or user the form moved it to", async () => {
        const view = await service.createRegistry(me, null, values());
        const moved = values({ kind: "generic", host: "evil.example.test", password: "" });
        expect(await refusal(service.testRegistry(me, { id: view.id, orgId: null, values: moved }))).toBe(
            "form.secretRequiredOnMove"
        );
        expect(
            await refusal(service.testRegistry(me, { id: view.id, orgId: null, values: values({ username: "x", password: "" }) }))
        ).toBe("form.secretRequiredOnMove");
        expect(configuredRequest).not.toHaveBeenCalled();
    });
});
