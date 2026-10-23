/**
 * A status page shared to edit (`status.page`). Whoever runs status pages
 * reaches every page; somebody given one page reaches that page and nothing
 * else - not another page, not by moving a component or a check onto one - and
 * nothing once the share is taken back. Making, deleting and sharing pages stay
 * with `status.manage`.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    manager: false,
    granted: new Set<string>()
}));

const PAGE_A = "0190b9f6-0000-7000-8000-00000000000a";
const PAGE_B = "0190b9f6-0000-7000-8000-00000000000b";
const COMPONENT_A = "0190b9f6-0000-7000-8000-0000000000ca";
const COMPONENT_B = "0190b9f6-0000-7000-8000-0000000000cb";
const CHECK_B = "0190b9f6-0000-7000-8000-0000000000eb";

vi.mock("@polaris/app-host", () => ({
    host: {
        session: {
            requireUser: vi.fn(async () => ({ id: "u1", isAdmin: false })),
            sessionCan: vi.fn(async () => state.manager),
            requirePermission: vi.fn(async () => {
                throw new Error("refused");
            })
        },
        accessGrants: {
            liveGrants: vi.fn(async (_user: string, _subject: string, id: string) =>
                state.granted.has(id) ? [{ capability: "edit", actions: [] }] : []
            ),
            grantedSubjects: vi.fn(
                async () => new Map([...state.granted].map((id) => [id, "edit"]))
            ),
            reachesAnySubject: vi.fn(async () => state.granted.size > 0),
            dropGrantsFor: vi.fn(async () => undefined)
        }
    }
}));

const componentPage: Record<string, string> = { [COMPONENT_A]: PAGE_A, [COMPONENT_B]: PAGE_B };

vi.mock("@polaris/db", () => ({
    prisma: {
        statusPage: {
            findUnique: vi.fn(async ({ where }: { where: { slug: string } }) =>
                where.slug === "a" ? { id: PAGE_A } : where.slug === "b" ? { id: PAGE_B } : null
            )
        },
        statusComponent: {
            findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.filter((id) => componentPage[id]).map((id) => ({ pageId: componentPage[id] }))
            )
        },
        statusCheck: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                where.id === CHECK_B ? { component: { pageId: PAGE_B } } : null
            )
        },
        statusIncident: { findUnique: vi.fn(async () => null) },
        statusMaintenance: { findUnique: vi.fn(async () => null) }
    }
}));

vi.mock("@polaris-app/status-pages/src/lib/i18n", () => ({
    statusT: async () => (key: string) => key
}));

const access = await import("@polaris-app/status-pages/src/lib/page-access");

describe("who edits a status page", () => {
    beforeEach(() => {
        state.manager = false;
        state.granted = new Set();
    });

    it("lets whoever runs status pages edit any page", async () => {
        state.manager = true;
        await expect(access.requirePageEditor([{ page: PAGE_B }])).resolves.toMatchObject({
            id: "u1"
        });
    });

    it("lets somebody given a page edit it, its components and by its address", async () => {
        state.granted.add(PAGE_A);
        await expect(
            access.requirePageEditor([{ page: PAGE_A }, { components: [COMPONENT_A] }])
        ).resolves.toMatchObject({ id: "u1" });
        await expect(access.requirePageEditor([{ slug: "a" }])).resolves.toBeTruthy();
    });

    it("refuses another page, a check on it, and moving a component onto it", async () => {
        state.granted.add(PAGE_A);
        for (const targets of [
            [{ page: PAGE_B }],
            [{ check: CHECK_B }],
            [{ slug: "b" }],
            [{ page: PAGE_B }, { components: [COMPONENT_A] }],
            [{ components: [COMPONENT_A, "0190b9f6-0000-7000-8000-0000000000ff"] }]
        ] as const) {
            await expect(access.requirePageEditor(targets)).rejects.toThrow("errors.notAllowed");
        }
    });

    it("refuses everything once the share is taken back", async () => {
        state.granted.add(PAGE_A);
        await expect(access.requirePageEditor([{ page: PAGE_A }])).resolves.toBeTruthy();
        state.granted.clear();
        await expect(access.requirePageEditor([{ page: PAGE_A }])).rejects.toThrow(
            "errors.notAllowed"
        );
        expect(await access.reachesAnyPage("u1")).toBe(false);
    });

    it("lists only the pages given to edit", async () => {
        state.granted.add(PAGE_A);
        expect(await access.editablePageIds("u1")).toEqual([PAGE_A]);
    });
});

describe("the status page subject", () => {
    it("hands over editing and nothing else, and is not a link", () => {
        expect(core.GRANT_CAPABILITIES["status.page"]).toEqual(["edit"]);
        expect(core.isGrantLinkSubject("status.page")).toBe(false);
    });
});
