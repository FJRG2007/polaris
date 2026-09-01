import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";

// The screen calls server actions and the router on interaction only; rendering
// it needs them to exist, not to work.
// The task screen's comment box is the one from Chat, whose emoji picker reaches
// Chat's own server actions - and that module reads Polaris' configuration as it
// is imported. A running server has all of this; a test process has to say so.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh() {}, push() {} }),
    usePathname: () => "/tasks/everything"
}));
vi.mock("@/app/(app)/tasks/actions", () => ({}));
// The description editor asks these for its @ and # pickers, which nothing here
// opens; the module reaches the database and the session on import.
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

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
