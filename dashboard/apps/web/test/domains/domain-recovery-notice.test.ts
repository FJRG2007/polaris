/**
 * A domain coming back closes the notice that said it went down.
 *
 * Down is one open notice per person for everything one pass found down; up
 * rewrites that same notice as the recovery and marks it read, instead of a
 * second "back" row beside it. Only a recovery no open notice covers is told
 * on its own. The dispatcher is replaced, but a condition still lands in an
 * in-memory table through the real notification service.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { conditionStore } from "../notifications/fixtures/condition-store";

const bell = vi.hoisted(() => ({
    store: null as ReturnType<
        typeof import("../notifications/fixtures/condition-store").conditionStore
    > | null,
    plain: [] as Array<{ userId: string; event: string; title: string }>
}));

function project() {
    return { id: "shop", name: "Shop", ownerId: "owner", orgId: null };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        domain: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({
                    id,
                    hostname: `${id}.example.test`,
                    application: {
                        id: "app-shop",
                        name: "web",
                        environment: { project: project() }
                    }
                }))
        },
        projectMember: { findMany: async () => [] },
        notification: {
            updateMany: (args: never) => bell.store!.notification.updateMany(args),
            create: (args: never) => bell.store!.notification.create(args),
            findMany: (args: never) => bell.store!.notification.findMany(args)
        }
    }
}));
vi.mock("@/lib/shelf", () => ({ shelfFilter: () => ({}) }));
vi.mock("@/lib/follow/follow", () => ({ followers: async () => [] }));
vi.mock("@/lib/deploy-project-service", () => ({ dispatchProjectWebhooks: async () => undefined }));
vi.mock("@/lib/deploy/automations", () => ({ raiseAutomationEvent: async () => undefined }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: { condition?: string; event: string; userId: string; title: string }) => {
        if (!input.condition) {
            bell.plain.push(input);
            return;
        }
        const { raiseCondition } = await import("@/lib/notification-service");
        await raiseCondition(input.condition, { ...(input as never), type: input.event });
    }
}));

const { notifyDomainHealthChanges, notifyDomainHealthChanged } =
    await import("@/lib/notifications/domain-events");

const rows = () => bell.store!.rows;

beforeEach(() => {
    bell.store = conditionStore();
    bell.plain.length = 0;
});

describe("a domain that comes back", () => {
    it("rewrites the down notice as the recovery instead of adding one", async () => {
        await notifyDomainHealthChanged({ domainId: "a", status: "down", detail: "HTTP 502" });
        await notifyDomainHealthChanged({ domainId: "a", status: "down", detail: "HTTP 502" });
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({
            type: "domain.down",
            conditionKey: "domain.down:a",
            actionRequired: true
        });

        await notifyDomainHealthChanged({ domainId: "a", status: "up", detail: null });
        expect(bell.plain).toHaveLength(0);
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({
            conditionKey: null,
            level: "success",
            actionRequired: false
        });
        expect(rows()[0]!.title).toContain("a.example.test");
        expect(rows()[0]!.readAt).toBeInstanceOf(Date);
    });

    it("keeps a sweep's notice open while part of it is still down", async () => {
        await notifyDomainHealthChanges([
            { domainId: "a", status: "down", detail: null },
            { domainId: "b", status: "down", detail: null }
        ]);
        expect(rows()).toHaveLength(1);
        await notifyDomainHealthChanged({ domainId: "a", status: "up", detail: null });
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({ conditionKey: "domain.down:a", actionRequired: true });
        expect(JSON.parse(rows()[0]!.metadata!).members).toEqual(["b"]);

        await notifyDomainHealthChanged({ domainId: "b", status: "up", detail: null });
        expect(rows()[0]).toMatchObject({ conditionKey: null, level: "success" });
        expect(bell.plain).toHaveLength(0);
    });

    it("raises a new notice when a domain goes down again beside a sweep still open", async () => {
        await notifyDomainHealthChanges([
            { domainId: "a", status: "down", detail: null },
            { domainId: "b", status: "down", detail: null }
        ]);
        await notifyDomainHealthChanged({ domainId: "a", status: "up", detail: null });
        await notifyDomainHealthChanged({ domainId: "a", status: "down", detail: "HTTP 502" });
        expect(rows()).toHaveLength(2);
        expect(rows()[0]).toMatchObject({ conditionKey: "domain.down:a", actionRequired: true });
        expect(JSON.parse(rows()[0]!.metadata!).members).toEqual(["b"]);
        expect(rows()[1]).toMatchObject({ conditionKey: "domain.down:a#2", actionRequired: true });
        expect(JSON.parse(rows()[1]!.metadata!).members).toEqual(["a"]);

        await notifyDomainHealthChanged({ domainId: "b", status: "up", detail: null });
        expect(rows()[0]).toMatchObject({ conditionKey: null, level: "success" });
        expect(rows()[1]).toMatchObject({ conditionKey: "domain.down:a#2", actionRequired: true });
        expect(bell.plain).toHaveLength(0);
    });

    it("tells a recovery nothing announced on its own", async () => {
        await notifyDomainHealthChanged({ domainId: "a", status: "up", detail: null });
        expect(rows()).toHaveLength(0);
        expect(bell.plain).toMatchObject([{ userId: "owner", event: "domain.up" }]);
    });
});
