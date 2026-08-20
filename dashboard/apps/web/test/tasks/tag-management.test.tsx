// @vitest-environment jsdom

/**
 * Where a tag goes to be renamed or taken away.
 *
 * Tags are made in the one place they are needed - the picker on a task, under
 * whatever was being typed - and until now that was the only place they existed
 * at all. A name typed in a hurry, or one idea spelled two ways, stayed on the
 * space forever: the screen that could remove one was a settings tab nothing
 * linked to, and it could not rename one at all.
 *
 * So two things are asserted, and they are the two halves of the same
 * complaint - the picker offers the way to that screen, and the screen can
 * actually change a tag rather than only add and delete. The picker offers it
 * only where there is one space to send somebody to, which is the same rule the
 * status picker follows.
 */

import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import type { TagView } from "@/lib/tasks/space-service";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh() {}, push() {} }),
    usePathname: () => "/tasks"
}));
vi.mock("@/app/(app)/tasks/actions", () => ({}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

const { SpaceScreen } = await import("@/app/(app)/tasks/space-view");
const { TagPicker } = await import("@/app/(app)/tasks/pickers");

afterEach(cleanup);

const TAGS: TagView[] = [
    { id: "tg1", name: "backend", color: "#7c5cff" },
    { id: "tg2", name: "urgent", color: "#ef4444" }
];

/** The picker as a task draws it, opened. Its menu is portalled and built only
 *  when it opens, so there is nothing to read until it has been. */
async function openPicker(spaceId: string) {
    render(<TagPicker tags={TAGS} spaceId={spaceId} selected={[]} onChange={() => undefined} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Tags" }));
    return screen.findByRole("menu");
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
            statuses={[]}
            fields={[]}
            tags={TAGS}
            members={[]}
            automations={[]}
            forms={[]}
            people={[]}
            canManage={canManage}
            baseUrl="https://polaris.test"
            initialTab="Tags"
        />
    );
}

describe("the space's own tags tab", () => {
    it("lets a manager rename a tag as well as remove it", () => {
        const markup = spaceSettings(true);
        expect(markup).toContain('aria-label="Edit backend"');
        expect(markup).toContain('aria-label="Remove backend"');
    });

    it("shows a reader the tags and no way to change them", () => {
        const markup = spaceSettings(false);
        expect(markup).toContain("backend");
        expect(markup).not.toContain('aria-label="Edit backend"');
        expect(markup).not.toContain('aria-label="Remove backend"');
    });
});

describe("the way there", () => {
    it("is offered from the picker that makes them", async () => {
        const menu = await openPicker("s1");
        const link = menu.querySelector("a[href='/tasks/s/s1?tab=Tags']");
        expect(link).not.toBeNull();
        expect(link?.textContent).toContain("Edit tags");
    });

    it("is not offered where the tags belong to several spaces at once", async () => {
        // Everything and the sprint boards: there is no single space whose tags
        // these are, so there is nowhere to send anybody.
        const menu = await openPicker("");
        expect(menu.querySelector("a[href*='tab=Tags']")).toBeNull();
    });
});
