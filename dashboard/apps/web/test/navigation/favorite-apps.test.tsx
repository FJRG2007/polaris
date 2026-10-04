// @vitest-environment jsdom

/**
 * The app menu's order - and the favorites an older menu saved with its star -
 * and the Overview rail that reads them.
 *
 * What is asserted: an arrangement is drawn before the server answers and taken
 * back, with the reason, when it refuses, back to the last lists the server
 * accepted; a later change is not undone by an earlier one failing; an order
 * that did not change sends nothing; the first arrangement folds the old
 * favorites into the order without moving anything; an arrangement keeps apps
 * this account cannot open in their slots and can be forgotten; and the
 * Overview's rail lists the old favorites until the menu is arranged, then the
 * first apps of the menu - in both languages.
 */

import { withMessages } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { HardDrive, Mail, MessageCircle } from "lucide-react";
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
const { AppLauncher } = await import("@/components/app-nav");

type Store = ReturnType<typeof useFavoriteApps>;

beforeEach(() => {
    save.mockReset();
    show.mockReset();
});
afterEach(cleanup);

/** Renders the provider and hands the store out to the test. */
function mount(initial: string[], extra?: ReactNode, initialOrder: string[] = []) {
    const store: { current: Store | null } = { current: null };
    function Grab() {
        const value = useFavoriteApps();
        useEffect(() => {
            store.current = value;
        });
        return (
            <>
                <p data-testid="favorites">{value.favorites.join(",")}</p>
                <p data-testid="order">{value.order.join(",")}</p>
            </>
        );
    }
    render(
        withMessages(
            <FavoriteAppsProvider initial={initial} initialOrder={initialOrder}>
                <Grab />
                {extra}
            </FavoriteAppsProvider>
        )
    );
    return {
        get: () => store.current!,
        shown: () => screen.getByTestId("favorites").textContent,
        order: () => screen.getByTestId("order").textContent
    };
}

describe("the favorites store", () => {
    it("folds the old favorites into the order the first time the menu is arranged", async () => {
        let answer: (value: { error?: string }) => void = () => undefined;
        save.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        const store = mount(["mail", "chat"]);
        act(() => store.get().arrangeApps(["chat", "mail", "drive"]));
        expect(store.order()).toBe("chat,mail,drive");
        expect(store.shown()).toBe("");
        expect(save).toHaveBeenCalledWith({ favorites: [], order: ["chat", "mail", "drive"] });
        await act(async () => answer({}));
        expect(store.order()).toBe("chat,mail,drive");
        expect(show).not.toHaveBeenCalled();
    });

    it("keeps a favorite this account cannot open today in the order it folds into", () => {
        save.mockResolvedValue({});
        const store = mount(["admin", "mail"]);
        act(() => store.get().arrangeApps(["chat", "mail"]));
        expect(save).toHaveBeenCalledWith({ favorites: [], order: ["admin", "chat", "mail"] });
    });

    it("puts the order back and says why when the server refuses", async () => {
        save.mockResolvedValue({ error: "Those favorites could not be saved." });
        const store = mount(["mail"], undefined, ["mail", "chat"]);
        act(() => store.get().arrangeApps(["chat", "mail"]));
        expect(store.order()).toBe("chat,mail");
        expect(save).toHaveBeenCalledWith({ favorites: [], order: ["chat", "mail"] });
        await waitFor(() => expect(store.order()).toBe("mail,chat"));
        // Back to exactly what was saved, the old favorite included.
        expect(store.shown()).toBe("mail");
        expect(show).toHaveBeenCalledWith({ title: "Those favorites could not be saved." });
    });

    it("puts the order back when the save does not reach the server", async () => {
        save.mockRejectedValue(new Error("offline"));
        const store = mount([], undefined, []);
        act(() => store.get().arrangeApps(["chat", "mail"]));
        expect(store.order()).toBe("chat,mail");
        await waitFor(() => expect(store.order()).toBe(""));
        expect(show).toHaveBeenCalledWith({
            title: "Your app order could not be saved. Try again in a moment."
        });
    });

    it("does not undo a newer change when an older save fails", async () => {
        let fail: (reason: unknown) => void = () => undefined;
        save.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
        save.mockResolvedValueOnce({});
        const store = mount([], undefined, ["mail", "chat", "drive"]);
        act(() => store.get().arrangeApps(["chat", "mail", "drive"]));
        act(() => store.get().arrangeApps(["drive", "chat", "mail"]));
        expect(store.order()).toBe("drive,chat,mail");
        await act(async () => fail(new Error("offline")));
        expect(store.order()).toBe("drive,chat,mail");
        expect(show).not.toHaveBeenCalled();
    });

    it("returns to the last saved list when every newer save fails too", async () => {
        const fails: Array<(reason: unknown) => void> = [];
        save.mockImplementation(() => new Promise((_, reject) => fails.push(reject)));
        const store = mount(["mail"], undefined, ["mail", "chat", "drive"]);
        act(() => store.get().arrangeApps(["chat", "mail", "drive"]));
        act(() => store.get().arrangeApps(["drive", "chat", "mail"]));
        await act(async () => fails[0](new Error("offline")));
        expect(store.order()).toBe("drive,chat,mail");
        await act(async () => fails[1](new Error("offline")));
        expect(store.order()).toBe("mail,chat,drive");
        expect(store.shown()).toBe("mail");
        expect(show).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledWith({
            title: "Your app order could not be saved. Try again in a moment."
        });
    });

    it("sends nothing for an order that did not change", () => {
        const store = mount(["mail"], undefined, ["mail", "chat"]);
        act(() => store.get().arrangeApps(["mail", "chat"]));
        expect(save).not.toHaveBeenCalled();
    });

    it("sends nothing to forget an arrangement that was never made", () => {
        const store = mount(["mail"]);
        act(() => store.get().resetOrder());
        expect(save).not.toHaveBeenCalled();
    });

    it("keeps an app this account cannot open in its slot when arranging", () => {
        save.mockResolvedValue({});
        const store = mount(["mail"], undefined, ["mail", "admin", "chat"]);
        act(() => store.get().arrangeApps(["chat", "mail"]));
        expect(save).toHaveBeenCalledWith({
            favorites: [],
            order: ["chat", "admin", "mail"]
        });
    });

    it("forgets the arrangement and keeps the favorites", () => {
        save.mockResolvedValue({});
        const store = mount(["mail"], undefined, ["chat", "mail"]);
        act(() => store.get().resetOrder());
        expect(store.order()).toBe("");
        expect(save).toHaveBeenCalledWith({ favorites: ["mail"], order: [] });
    });
});

describe("the Overview rail", () => {
    const appIds = [
        "overview",
        "drive",
        "vault",
        "apps",
        "tasks",
        "chat",
        "mail",
        "notes",
        "office"
    ];

    it("lists only the old favorites, in their order, then a way to every other app", () => {
        mount(["mail", "drive"], <AppSidebar appIds={appIds} />);
        const links = [...document.querySelectorAll("nav a")].map((link) =>
            link.getAttribute("href")
        );
        expect(links).toEqual(["/mail", "/drive"]);
        expect(screen.getByText("Favorites")).toBeTruthy();
        expect(screen.getByRole("button", { name: "More apps" })).toBeTruthy();
    });

    it("follows the menu's first apps once it is arranged, on the same frame", () => {
        save.mockReturnValue(new Promise(() => undefined));
        const store = mount(["mail"], <AppSidebar appIds={appIds} />);
        act(() => store.get().arrangeApps(["notes", "mail", "drive", "vault", "apps", "tasks", "chat", "office"]));
        const links = [...document.querySelectorAll("nav a")].map((link) =>
            link.getAttribute("href")
        );
        expect(links.slice(0, 2)).toEqual(["/notes", "/mail"]);
        expect(links).toHaveLength(6);
        expect(screen.queryByText("Favorites")).toBeNull();
    });

    it("lists the favorites in the order the app menu was arranged in", () => {
        mount(["mail", "drive"], <AppSidebar appIds={appIds} />, ["drive", "chat", "mail"]);
        const links = [...document.querySelectorAll("nav a")].map((link) =>
            link.getAttribute("href")
        );
        expect(links).toEqual(["/drive", "/mail"]);
    });

    it("never lists an app the account cannot open, even a favorite", () => {
        mount(["admin", "mail"], <AppSidebar appIds={appIds} />);
        const links = [...document.querySelectorAll("nav a")].map((link) =>
            link.getAttribute("href")
        );
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

describe("the app menu", () => {
    const apps = [
        { id: "drive", label: "Drive", icon: HardDrive, href: "/drive" },
        { id: "chat", label: "Chat", icon: MessageCircle, href: "/chat" },
        { id: "mail", label: "Mail", icon: Mail, href: "/mail" }
    ];
    const tiles = () =>
        [...document.querySelectorAll("[data-launcher-tile]")].map((node) =>
            node.getAttribute("data-launcher-tile")
        );

    it("opens on the favorites, then the apps used most", async () => {
        const user = userEvent.setup();
        mount(
            ["mail"],
            <AppLauncher
                apps={apps}
                currentAppId="drive"
                usage={{ chat: { score: 3, at: 1000 } }}
                now={1000}
            />
        );
        await user.click(screen.getByRole("button", { name: /drive/i }));
        await screen.findByRole("menu");
        expect(tiles()).toEqual(["mail", "chat", "drive"]);
    });

    it("saves a keyboard move as the whole order and takes it back when the save fails", async () => {
        const user = userEvent.setup();
        let fail: (reason: unknown) => void = () => undefined;
        save.mockReturnValue(new Promise((_, reject) => (fail = reject)));
        mount([], <AppLauncher apps={apps} currentAppId="drive" />);
        await user.click(screen.getByRole("button", { name: /drive/i }));
        await screen.findByRole("menu");
        await user.keyboard("{ArrowDown}{Alt>}{ArrowRight}{/Alt}");
        expect(save).toHaveBeenCalledWith({ favorites: [], order: ["chat", "drive", "mail"] });
        expect(tiles()).toEqual(["chat", "drive", "mail"]);
        await act(async () => fail(new Error("offline")));
        expect(tiles()).toEqual(["drive", "chat", "mail"]);
        expect(show).toHaveBeenCalledTimes(1);
    });

    it("arranges from the dialog with buttons, for a finger or a screen reader", async () => {
        const user = userEvent.setup();
        save.mockResolvedValue({});
        mount([], <AppLauncher apps={apps} currentAppId="drive" />, ["chat", "drive", "mail"]);
        await user.click(screen.getByRole("button", { name: /drive/i }));
        await user.click(await screen.findByRole("menuitem", { name: "Arrange apps" }));
        await user.click(await screen.findByRole("button", { name: "Move Mail earlier" }));
        expect(save).toHaveBeenCalledWith({ favorites: [], order: ["chat", "mail", "drive"] });
        await user.click(screen.getByRole("button", { name: "Use automatic order" }));
        expect(save).toHaveBeenLastCalledWith({ favorites: [], order: [] });
    });

    it("draws the options under the grid as icons named by their words", async () => {
        const user = userEvent.setup();
        mount([], <AppLauncher apps={apps} currentAppId="drive" marketplace />);
        await user.click(screen.getByRole("button", { name: /drive/i }));
        const arrange = await screen.findByRole("menuitem", { name: "Arrange apps" });
        const more = screen.getByRole("menuitem", { name: "Find more apps" });
        expect(arrange.getAttribute("title")).toBe("Arrange apps");
        expect(more.getAttribute("title")).toBe("Find more apps");
        expect(more.getAttribute("href")).toBe("/apps/marketplace");
        expect(arrange.textContent).toBe("");
        expect(more.textContent).toBe("");
    });

    it("reads in Spanish", async () => {
        const user = userEvent.setup();
        const many = Array.from({ length: 14 }, (_, at) => ({
            id: `fixture-${at}`,
            label: `Fixture ${at}`,
            icon: HardDrive,
            href: `/fixture-${at}`
        }));
        render(
            withMessages(
                <FavoriteAppsProvider initial={[]}>
                    <AppLauncher apps={many} currentAppId="fixture-0" />
                </FavoriteAppsProvider>,
                "es-ES"
            )
        );
        await user.click(screen.getByRole("button", { name: /fixture 0/i }));
        expect(await screen.findByRole("menuitem", { name: "Más" })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: "Ordenar apps" }).getAttribute("title")).toBe(
            "Ordenar apps"
        );
        expect(screen.getByRole("textbox", { name: "Buscar apps" })).toBeTruthy();
    });
});
