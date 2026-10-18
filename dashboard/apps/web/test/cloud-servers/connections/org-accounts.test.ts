/**
 * A cloud account connected for an organization: only somebody who manages
 * the organization's connections may connect one, use it, or see Connect and
 * Remove on the organization's hub - the same check on the screen and behind it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    managed: [] as { id: string; slug: string; name: string }[],
    usesCloud: true,
    created: [] as Record<string, unknown>[],
    wheres: [] as unknown[],
    dialled: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        cloudAccount: {
            findMany: async ({ where }: { where: unknown }) => {
                state.wheres.push(where);
                return [];
            },
            create: async ({ data }: { data: Record<string, unknown> }) => {
                state.created.push(data);
                return {
                    id: "acc-1",
                    provider: data.provider,
                    name: data.name,
                    lastError: null,
                    organization: null
                };
            }
        }
    }
}));

vi.mock("@polaris-app/cloud-servers/src/lib/providers", () => ({
    adapterFor: async () => {
        state.dialled += 1;
        return { listRegions: async () => [] };
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        i18nRequest: { getLocale: async () => "en-US" },
        session: {
            requireUser: async () => ({ id: "user-1", isAdmin: false }),
            sessionCan: async () => state.usesCloud
        },
        auditService: { recordAudit: async () => undefined },
        cloudServersHost: {
            cloudConnectionOrgs: async () => state.managed,
            managesCloudOrg: async (_user: string, orgId: string) =>
                state.managed.some((org) => org.id === orgId),
            sealCloudSecret: async () => ({
                encryptedSecret: Buffer.from(""),
                secretNonce: Buffer.from(""),
                secretKeyId: "k"
            })
        }
    }
}));

const service = await import("@polaris-app/cloud-servers/src/lib/service");
const { cloudConnectionsSlot } = await import(
    "@polaris-app/cloud-servers/src/lib/connections-slot"
);

const ORG = { id: "11111111-1111-4111-8111-111111111111", slug: "acme", name: "Acme" };
const input = { provider: "hetzner" as const, name: "Production", credentials: { token: "t" } };

beforeEach(() => {
    state.managed = [];
    state.usesCloud = true;
    state.created = [];
    state.wheres = [];
    state.dialled = 0;
});

describe("connecting a cloud account for an organization", () => {
    it("is refused to somebody who does not manage it, before any provider is called", async () => {
        await expect(service.addAccount("user-1", input, ORG.id)).rejects.toThrow(/manage/);
        expect(state.dialled).toBe(0);
        expect(state.created).toEqual([]);
    });

    it("stores the organization for somebody who manages it", async () => {
        state.managed = [ORG];
        await service.addAccount("user-1", input, ORG.id);
        expect(state.created[0]).toMatchObject({ ownerId: "user-1", organizationId: ORG.id });
    });

    it("keeps an account with no organization its owner's own", async () => {
        await service.addAccount("user-1", input);
        expect(state.created[0]).toMatchObject({ ownerId: "user-1", organizationId: null });
    });
});

describe("which accounts somebody may use", () => {
    it("is their own, plus those of the organizations they manage", async () => {
        state.managed = [ORG];
        await service.listAccounts("user-1");
        expect(state.wheres[0]).toEqual({
            OR: [{ ownerId: "user-1", organizationId: null }, { organizationId: { in: [ORG.id] } }]
        });
    });

    it("is only their own when they manage none, as before", async () => {
        await service.listAccounts("user-1");
        expect(state.wheres[0]).toEqual({ OR: [{ ownerId: "user-1", organizationId: null }] });
    });
});

describe("the Cloud servers section of a hub", () => {
    const org = (canManage: boolean) =>
        ({ kind: "org", orgId: ORG.id, orgSlug: ORG.slug, orgName: ORG.name, canManage }) as const;

    it("offers Connect on an organization's hub only to its managers", async () => {
        const managed = await cloudConnectionsSlot({
            userId: "user-1",
            scope: org(true),
            returnTo: null
        });
        expect(managed?.props).toMatchObject({ orgId: ORG.id, canManage: true });
        // A member who does not manage it, with nothing connected, sees no section.
        await expect(
            cloudConnectionsSlot({ userId: "user-1", scope: org(false), returnTo: null })
        ).resolves.toBeNull();
    });

    it("never widens the organization's answer for somebody who cannot use Cloud servers", async () => {
        state.usesCloud = false;
        await expect(
            cloudConnectionsSlot({ userId: "user-1", scope: { kind: "personal" }, returnTo: null })
        ).resolves.toBeNull();
        await expect(
            cloudConnectionsSlot({ userId: "user-1", scope: org(true), returnTo: null })
        ).resolves.toBeNull();
    });

    it("lists only that organization's accounts on its hub", async () => {
        await cloudConnectionsSlot({
            userId: "user-1",
            scope: org(true),
            returnTo: "/apps/servers/cloud"
        });
        expect(state.wheres[0]).toEqual({ organizationId: ORG.id });
    });
});
