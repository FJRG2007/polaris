/**
 * Why switching between an organization and the personal shelf froze Mail.
 *
 * The switch ran the shelf action inside an async transition and then asked the
 * router to refresh. Two costs, stacked. An async transition holds every other
 * transition until it ends - every link, every `router.push`, and the router
 * applying the action's own answer - so the screen could not be pressed or left
 * while the server rendered the new shelf. And it rendered it twice: the action
 * revalidates every layout, so its response already carries the whole new tree
 * and the router applies it; the refresh after it fetched the entire signed-in
 * frame, Mail's layout and every count in it, a second time.
 *
 * Same cause as the send freeze (`sending-does-not-hold-the-router`): a server
 * call awaited inside a transition. Now the switch is a plain pending state and
 * one render; the list, whose kept copy belongs to the other shelf, is the one
 * region that waits and draws its skeleton.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("the shelf switch in the header", () => {
    it("waits without a transition", async () => {
        const source = await readFile(`${SRC}components/scope-switcher.tsx`, "utf8");
        expect(source).not.toMatch(/\buseTransition\b|\bstartTransition\b/);
        expect(source).toContain("setPending(true);");
        expect(source).toContain(".finally(() => setPending(false));");
    });

    it("renders the new shelf once, from the action's own answer", async () => {
        const source = await readFile(`${SRC}components/scope-switcher.tsx`, "utf8");
        expect(source).not.toContain("router.refresh()");
        const action = await readFile(`${SRC}app/(app)/scope-actions.ts`, "utf8");
        // Which is what makes that answer carry the new tree at all.
        expect(action).toContain('revalidatePath("/", "layout");');
    });

    it("says so when the shelf could not be switched", async () => {
        const source = await readFile(`${SRC}components/scope-switcher.tsx`, "utf8");
        expect(source).toContain("if (outcome.error) toast.show({ title: outcome.error });");
    });
});

describe("Mail following a shelf switch", () => {
    it("does not render the frame a second time after moving the header", async () => {
        const accounts = await readFile(
            `${SRC}app/(app)/mail/settings/accounts/accounts-view.tsx`,
            "utf8"
        );
        const move = accounts.slice(accounts.indexOf("void setWorkspaceScopeAction(moveShelf)"));
        expect(move.slice(0, move.indexOf("}, [moveShelf]);"))).not.toContain("router.refresh");
    });

    it("keys the list on the shelf, so the new shelf's list is fetched rather than the old one drawn", async () => {
        const list = await readFile(`${SRC}app/(app)/mail/use-mail-list.ts`, "utf8");
        expect(list).toContain("cacheKey: `mail.list.${shelf}.${params}`");
    });
});
