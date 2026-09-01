/**
 * Who is offered a column, and where.
 *
 * A status is the space's word for a state of work, so reshaping one reshapes
 * every board in that space - which is why the affordance is meant to appear on
 * a screen that belongs to one space and only for somebody who may change it.
 * Both halves are asserted here, on the two screens that show statuses.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusView } from "@/lib/tasks/space-service";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";

// The task screen's comment box is the one from Chat, whose emoji picker reaches
// Chat's own server actions - and that module reads Polaris' configuration as it
// is imported. A running server has all of this; a test process has to say so.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh() {}, push() {} }),
    usePathname: () => "/tasks"
}));
vi.mock("@/app/(app)/tasks/actions", () => ({}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

const { ListScreen } = await import("@/app/(app)/tasks/list-view");
const { SpaceScreen } = await import("@/app/(app)/tasks/space-view");

const STATUSES: StatusView[] = [
    { id: "st1", name: "Open", type: "open", color: "#64748b", order: 1 },
    { id: "st2", name: "Done", type: "done", color: "#22c55e", order: 2 }
];

function context(overrides: Partial<SpaceContext> = {}): SpaceContext {
    return {
        spaceId: "s1",
        statuses: STATUSES,
        tags: [],
        fields: [],
        people: [],
        canEdit: true,
        canModerate: true,
        currentUserId: "u1",
        siblings: [],
        ...overrides
    };
}

function board(overrides: Partial<SpaceContext> = {}): string {
    return renderToStaticMarkup(
        <ListScreen
            listId="l1"
            defaultListId="l1"
            title="Inbox"
            tasks={[] as readonly TaskRow[]}
            savedViews={[]}
            context={context(overrides)}
            lists={[{ id: "l1", name: "Inbox", spaceId: "s1" }]}
        />
    );
}

function spaceSettings(canManage: boolean): string {
    return renderToStaticMarkup(
        <SpaceScreen
            spaceId="s1"
            name="Product"
            prefix="PRD"
            description=""
            visibility="internal"
            orgName={null}
            lists={[]}
            statuses={STATUSES}
            fields={[]}
            tags={[]}
            members={[]}
            automations={[]}
            forms={[]}
            people={[]}
            canManage={canManage}
            baseUrl="https://polaris.test"
            initialTab="Statuses"
        />
    );
}

describe("managing a board's columns", () => {
    it("offers them on a space's own board, to somebody who may change its statuses", () => {
        const markup = board();
        expect(markup).toContain('aria-label="Column options for Open"');
        expect(markup).toContain("New column");
    });

    it("offers nothing to a member who may not", () => {
        const markup = board({ canModerate: false });
        expect(markup).not.toContain("Column options");
        expect(markup).not.toContain("New column");
    });

    it("offers nothing on a screen that spans spaces, where there is no one set to change", () => {
        // Everything and the sprint boards: the statuses shown belong to several
        // spaces at once, so reordering them would mean reordering all of them.
        const markup = board({ spaceId: "" });
        expect(markup).not.toContain("Column options");
        expect(markup).not.toContain("New column");
    });
});

describe("the space's own statuses tab", () => {
    it("lets a manager reshape a status as well as remove it", () => {
        const markup = spaceSettings(true);
        expect(markup).toContain('aria-label="Edit Open"');
        expect(markup).toContain('aria-label="Remove Open"');
    });

    it("shows a reader the statuses and no way to change them", () => {
        const markup = spaceSettings(false);
        expect(markup).toContain("Open");
        expect(markup).not.toContain('aria-label="Edit Open"');
        expect(markup).not.toContain('aria-label="Remove Open"');
        expect(markup).not.toContain('aria-label="Move Open down"');
    });

    it("lets the order be changed without a pointer", () => {
        // The board only reorders by dragging a column header, which is no use
        // from a keyboard or a touch screen; this tab is the other way in.
        const markup = spaceSettings(true);
        expect(markup).toContain('aria-label="Move Open down"');
        expect(markup).toContain('aria-label="Move Done up"');
    });

    it("disables the moves that would fall off either end, and only those", () => {
        const markup = spaceSettings(true);
        // Open is first and Done is last, so those two have nowhere to go. The
        // attribute is matched ahead of the label because the class list also
        // carries the word (`disabled:opacity-30`), which would match anything.
        expect(markup).toMatch(/disabled=""[^>]*aria-label="Move Open up"/);
        expect(markup).toMatch(/disabled=""[^>]*aria-label="Move Done down"/);
        // The two that lead somewhere stay live.
        expect(markup).not.toMatch(/disabled=""[^>]*aria-label="Move Open down"/);
        expect(markup).not.toMatch(/disabled=""[^>]*aria-label="Move Done up"/);
    });
});
