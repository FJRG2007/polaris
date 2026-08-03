import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";

// The screen calls server actions and the router on interaction only; rendering
// it needs them to exist, not to work.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh() {}, push() {} }),
    usePathname: () => "/tasks/everything"
}));
vi.mock("@/app/(app)/tasks/actions", () => ({}));

const { ListScreen } = await import("@/app/(app)/tasks/list-view");

function context(): SpaceContext {
    return {
        // Everything spans spaces, so it has no space of its own.
        spaceId: "",
        statuses: [{ id: "st1", name: "Open", type: "open", color: "#64748b", order: 0 }],
        tags: [],
        fields: [],
        people: [],
        canEdit: true,
        canModerate: false,
        currentUserId: "u1",
        siblings: []
    };
}

function screen(props: { listId: string | null; defaultListId: string | null; lists: { id: string; name: string }[] }) {
    return renderToStaticMarkup(
        <ListScreen
            listId={props.listId}
            defaultListId={props.defaultListId}
            title="Everything"
            tasks={[] as readonly TaskRow[]}
            savedViews={[]}
            context={context()}
            lists={props.lists}
        />
    );
}

describe("making a task from the list screen", () => {
    it("offers it on a screen that spans lists, where the dialog asks which one", () => {
        const markup = screen({ listId: null, defaultListId: null, lists: [{ id: "l1", name: "Inbox" }] });
        expect(markup).toContain("New task");
    });

    it("offers it on one list", () => {
        const markup = screen({ listId: "l1", defaultListId: "l1", lists: [{ id: "l1", name: "Inbox" }] });
        expect(markup).toContain("New task");
    });

    it("says nothing about it when there is no list in reach to put one in", () => {
        const markup = screen({ listId: null, defaultListId: null, lists: [] });
        expect(markup).not.toContain("New task");
    });
});
