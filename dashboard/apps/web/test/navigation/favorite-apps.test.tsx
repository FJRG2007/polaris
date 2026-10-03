// @vitest-environment jsdom

/**
 * The favorites store and the Overview rail that reads it.
 *
 * What is asserted: a change is drawn before the server answers and taken back,
 * with the reason, when it refuses, back to the last list the server accepted; a
 * later change is not undone by an earlier one failing; an order that did not change sends nothing; and the Overview's
 * rail lists only the favorites, in their order, with a way to the rest - in
 * both languages.
 */

import { withMessages } from "../setup/i18n";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const save = vi.fn<(input: unknown) => Promise<{ error?: string }>>();
const show = vi.fn();

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));
vi.mock("@/app/(app)/app-launcher-actions", () => ({
    saveFavoriteAppsAction: (input: unknown) => save(input)
}));
vi.mock("@polaris/ui", async (original) => ({
    ...(await original<typeof import("@polaris/ui")>()),
    useToast: () => ({ show })
}));

const { FavoriteAppsProvider } = await import("@/components/favorite-apps");
const { useFavoriteApps } = await import("@/components/favorite-apps-context");
const { AppSidebar } = await import("@/components/app-sidebar");

type Store = ReturnType<typeof useFavoriteApps>;

beforeEach(() => {
    save.mockReset();
    show.mockReset();
});
afterEach(cleanup);

/** Renders the provider and hands the store out to the test. */
function mount(initial: string[], extra?: ReactNode) {
    const store: { current: Store | null } = { current: null };
    function Grab() {
        const value = useFavoriteApps();
        useEffect(() => {
            store.current = value;
        });
        return <p data-testid="favorites">{value.favorites.join(",")}</p>;
    }
    render(
        withMessages(
            <FavoriteAppsProvider initial={initial}>
                <Grab />
                {extra}
            </FavoriteAppsProvider>
        )
    );
    return {
        get: () => store.current!,
        shown: () => screen.getByTestId("favorites").textContent
    };
}

describe("the favorites store", () => {
    it("draws a new favorite at once and keeps it when the save lands", async () => {
        let answer: (value: { error?: string }) => void = () => undefined;
        save.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        const store = mount(["mail"]);
        act(() => store.get().toggle("chat"));
        expect(store.shown()).toBe("mail,chat");
        expect(save).toHaveBeenCalledWith(["mail", "chat"]);
        await act(async () => answer({}));
        expect(store.shown()).toBe("mail,chat");
        expect(show).not.toHaveBeenCalled();
    });

    it("puts the list back and says why when the server refuses", async () => {
        save.mockResolvedValue({ error: "Those favorites could not be saved." });
        const store = mount(["mail", "chat"]);
        act(() => store.get().arrange(["chat", "mail"]));
        expect(store.shown()).toBe("chat,mail");
        await waitFor(() => expect(store.shown()).toBe("mail,chat"));
        expect(show).toHaveBeenCalledWith({ title: "Those favorites could not be saved." });
    });

    it("does not undo a newer change when an older save fails", async () => {
        let fail: (reason: unknown) => void = () => undefined;
        save.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
        save.mockResolvedValueOnce({});
        const store = mount(["mail"]);
        act(() => store.get().toggle("chat"));
        act(() => store.get().toggle("drive"));
        expect(store.shown()).toBe("mail,chat,drive");
        await act(async () => fail(new Error("offline")));
        expect(store.shown()).toBe("mail,chat,drive");
        expect(show).not.toHaveBeenCalled();
    });

    it("returns to the last saved list when every newer save fails too", async () => {
        const fails: Array<(reason: unknown) => void> = [];
        save.mockImplementation(() => new Promise((_, reject) => fails.push(reject)));
        const store = mount(["mail"]);
        act(() => store.get().toggle("chat"));
        act(() => store.get().toggle("drive"));
        await act(async () => fails[0](new Error("offline")));
        expect(store.shown()).toBe("mail,chat,drive");
        await act(async () => fails[1](new Error("offline")));
        expect(store.shown()).toBe("mail");
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith({
            title: "Your favorites could not be saved. Try again in a moment."
        });
    });

    it("sends nothing for an order that did not change", () => {
        const store = mount(["mail", "chat"]);
        act(() => store.get().arrange(["mail", "chat"]));
        expect(save).not.toHaveBeenCalled();
    });

    it("keeps a favorite this account cannot open in its slot when arranging", () => {
        save.mockResolvedValue({});
        const store = mount(["mail", "admin", "chat"]);
        act(() => store.get().arrange(["chat", "mail"]));
        expect(save).toHaveBeenCalledWith(["chat", "admin", "mail"]);
    });
});

describe("the Overview rail", () => {
    const appIds = ["overview", "drive", "vault", "apps", "tasks", "chat", "mail", "notes", "office"];

    it("lists only the favorites, in their order, then a way to every other app", () => {
        mount(["mail", "drive"], <AppSidebar appIds={appIds} />);
        const links = [...document.querySelectorAll("nav a")].map((link) => link.getAttribute("href"));
        expect(links).toEqual(["/mail", "/drive"]);
        expect(screen.getByText("Favorites")).toBeTruthy();
        expect(screen.getByRole("button", { name: "More apps" })).toBeTruthy();
    });

    it("follows a favorite added elsewhere on the same frame", () => {
        save.mockReturnValue(new Promise(() => undefined));
        const store = mount(["mail"], <AppSidebar appIds={appIds} />);
        act(() => store.get().toggle("notes"));
        const links = [...document.querySelectorAll("nav a")].map((link) => link.getAttribute("href"));
        expect(links).toEqual(["/mail", "/notes"]);
    });

    it("never lists an app the account cannot open, even a favorite", () => {
        mount(["admin", "mail"], <AppSidebar appIds={appIds} />);
        const links = [...document.querySelectorAll("nav a")].map((link) => link.getAttribute("href"));
        expect(links).toEqual(["/mail"]);
    });

    it("reads in Spanish", () => {
        render(
            withMessages(
                <FavoriteAppsProvider initial={["mail"]}>
                    <AppSidebar appIds={appIds} />
                </FavoriteAppsProvider>,
                "es-ES"
            )
        );
        expect(screen.getByText("Favoritos")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Más apps" })).toBeTruthy();
    });
});
