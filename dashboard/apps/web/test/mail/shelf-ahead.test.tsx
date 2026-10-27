// @vitest-environment jsdom

/**
 * Mail draws the shelf the header is switching to before the server has.
 *
 * Switching shelf waited on the server rendering the whole frame for the new
 * shelf, so the direction whose shelf had more mail to count felt slow. The
 * switcher now announces where it is going; Mail's list follows at once and the
 * server's render takes over when it lands. A refused switch withdraws the
 * announcement and the list goes back.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { announceShelf, announcedShelf, shelfAhead, useAnnouncedShelf } from "@/lib/shelf-announce";

const setWorkspaceScopeAction = vi.fn<(value: string) => Promise<{ error?: string }>>();
const replace = vi.fn();
let pathname = "/mail";
let query = "";

vi.mock("@/app/(app)/scope-actions", () => ({
    setWorkspaceScopeAction: (value: string) => setWorkspaceScopeAction(value)
}));
vi.mock("@/components/device-accounts", () => ({ AccountSwitcherDialog: () => null }));
vi.mock("next/navigation", () => ({
    usePathname: () => pathname,
    useRouter: () => ({ replace }),
    useSearchParams: () => new URLSearchParams(query)
}));

const { ScopeSwitcher } = await import("@/components/scope-switcher");
const { useListShelf: useMailListShelf } = await import("@/app/(app)/mail/list-shelf");

const ORG = "018f2b7a-0000-7000-8000-0000000000c3";

/** What Mail's list is drawn for, as the shell works it out. */
function useListShelf(server: string, followsHeader = true): string {
    return shelfAhead(server, useAnnouncedShelf(), followsHeader);
}

afterEach(() => {
    act(() => announceShelf(null));
    cleanup();
});

describe("a shelf switch on its way", () => {
    it("moves the list to the shelf picked before the server answers", () => {
        const view = renderHook(({ server }) => useListShelf(server), {
            initialProps: { server: ORG }
        });
        expect(view.result.current).toBe(ORG);
        act(() => announceShelf({ from: ORG, to: "personal" }));
        expect(view.result.current).toBe("personal");
    });

    it("hands over to the server's frame once it lands, and stays there", () => {
        const view = renderHook(({ server }) => useListShelf(server), {
            initialProps: { server: "personal" }
        });
        act(() => announceShelf({ from: "personal", to: ORG }));
        expect(view.result.current).toBe(ORG);
        view.rerender({ server: ORG });
        expect(view.result.current).toBe(ORG);
        act(() => announceShelf(null));
        expect(view.result.current).toBe(ORG);
    });

    it("goes back to where it was when the switch is refused", () => {
        const view = renderHook(({ server }) => useListShelf(server), {
            initialProps: { server: ORG }
        });
        act(() => announceShelf({ from: ORG, to: "personal" }));
        expect(view.result.current).toBe("personal");
        act(() => announceShelf(null));
        expect(view.result.current).toBe(ORG);
    });

    it("never pulls a list off a shelf the switch did not start from", () => {
        // Left behind by a switch made elsewhere: the server is on a third shelf.
        const view = renderHook(({ server }) => useListShelf(server), {
            initialProps: { server: "personal" }
        });
        act(() => announceShelf({ from: ORG, to: "personal" }));
        view.rerender({ server: "018f2b7a-0000-7000-8000-0000000000d4" });
        expect(view.result.current).toBe("018f2b7a-0000-7000-8000-0000000000d4");
    });

    it("leaves a list that shows every mailbox where it is", () => {
        const view = renderHook(() => useListShelf("*", false));
        act(() => announceShelf({ from: "*", to: ORG }));
        expect(view.result.current).toBe("*");
    });
});

describe("the header's switcher", () => {
    const org = { id: ORG, slug: "acme", name: "Acme" };

    beforeEach(() => {
        setWorkspaceScopeAction.mockReset();
    });

    async function switchToPersonal(): Promise<void> {
        render(<ScopeSwitcher personalName="Ada" organizations={[org]} current={org} />, {
            wrapper: MessagesWrapper
        });
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /Acme/ }));
        await user.click(await screen.findByRole("menuitem", { name: "Ada" }));
    }

    it("announces the shelf picked before the server answers", async () => {
        let answer: (outcome: { error?: string }) => void = () => undefined;
        setWorkspaceScopeAction.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        await switchToPersonal();
        expect(setWorkspaceScopeAction).toHaveBeenCalledOnce();
        expect(announcedShelf()).toEqual({ from: ORG, to: "personal" });
        await act(async () => answer({}));
        // Left for the server's frame to make moot.
        expect(announcedShelf()).toEqual({ from: ORG, to: "personal" });
    });

    it("withdraws it when the server refuses the switch", async () => {
        setWorkspaceScopeAction.mockResolvedValue({ error: "Not allowed" });
        await switchToPersonal();
        await waitFor(() => expect(announcedShelf()).toBeNull());
    });

    it("withdraws it when the switch fails", async () => {
        setWorkspaceScopeAction.mockRejectedValue(new Error("offline"));
        await switchToPersonal();
        await waitFor(() => expect(announcedShelf()).toBeNull());
    });
});

describe("Mail's list following a switch", () => {
    const reloadLists = vi.fn();

    beforeEach(() => {
        replace.mockReset();
        reloadLists.mockReset();
        pathname = "/mail/t/thread-1";
        query = "";
    });

    function mount(server: string) {
        return renderHook(({ server }) => useMailListShelf(server, reloadLists), {
            initialProps: { server }
        });
    }

    it("draws the shelf picked and closes the conversation of the one left", () => {
        const view = mount(ORG);
        act(() => announceShelf({ from: ORG, to: "personal" }));
        expect(view.result.current).toBe("personal");
        expect(reloadLists).toHaveBeenCalledOnce();
        expect(replace).toHaveBeenCalledWith("/mail", { scroll: false });
    });

    it("stays on the server's shelf when Mail shows every mailbox", () => {
        const view = mount("*");
        act(() => announceShelf({ from: "*", to: ORG }));
        expect(view.result.current).toBe("*");
        expect(reloadLists).not.toHaveBeenCalled();
    });

    it("reopens the conversation a refused switch closed", () => {
        query = "";
        const view = mount(ORG);
        act(() => announceShelf({ from: ORG, to: "personal" }));
        pathname = "/mail";
        view.rerender({ server: ORG });
        replace.mockReset();
        act(() => announceShelf(null));
        expect(view.result.current).toBe(ORG);
        expect(reloadLists).toHaveBeenCalledTimes(2);
        expect(replace).toHaveBeenCalledWith("/mail/t/thread-1", { scroll: false });
    });

    it("does not reopen it once the switch went through", () => {
        const view = mount(ORG);
        act(() => announceShelf({ from: ORG, to: "personal" }));
        pathname = "/mail";
        view.rerender({ server: "personal" });
        replace.mockReset();
        act(() => announceShelf(null));
        view.rerender({ server: ORG });
        expect(view.result.current).toBe(ORG);
        expect(replace).not.toHaveBeenCalled();
    });

    it("leaves alone a conversation opened while the switch was on its way", () => {
        const view = mount(ORG);
        act(() => announceShelf({ from: ORG, to: "personal" }));
        pathname = "/mail/t/thread-2";
        view.rerender({ server: ORG });
        replace.mockReset();
        act(() => announceShelf(null));
        expect(replace).toHaveBeenCalledWith("/mail", { scroll: false });
        expect(replace).not.toHaveBeenCalledWith("/mail/t/thread-1", { scroll: false });
    });
});
