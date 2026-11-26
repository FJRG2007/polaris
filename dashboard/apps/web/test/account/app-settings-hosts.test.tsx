// @vitest-environment jsdom
/**
 * Settings > This app > Hosts in a desktop app that manages its hosts through the
 * page (`appSettings.hosts`).
 *
 * What has to hold: the list draws at once from what this device last saw, with
 * how each host answers and which one is in use; every change goes to the app and
 * only through it (add only once the app said the address is a Polaris, edit,
 * switch, remove with a confirmation and put back when refused); the list is sent
 * and taken in through the app; the page tells the app it draws hosts only when
 * the app can manage them here; and the account menu opens them here.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: () => undefined }) }));
vi.mock("@enigmax/primitives/react/network", () => ({ useNetworkState: () => ({ online: true, recovered: 0 }) }));
vi.mock("@/lib/auth-client", () => ({ signOut: async () => undefined }));
vi.mock("@/components/presence-store", () => ({ usePresenceRefresh: () => () => undefined, usePresence: () => null }));
vi.mock("@/components/device-accounts", () => ({ AccountSwitcherDialog: () => null }));
vi.mock("@/app/(app)/account/preferences/actions", () => ({
    presenceNowAction: async () => ({ held: { choice: "auto", until: null, scheduled: false, nextChangeAt: null }, status: { text: "", until: null } }),
    setPresenceAction: async () => ({ held: { choice: "auto", until: null, scheduled: false, nextChangeAt: null } }),
    setStatusAction: async () => ({ status: { text: "", until: null } })
}));

const { AppSettingsView } = await import("../../src/app/(app)/account/app/[category]/app-settings-view");
const { forgetHostsSnapshot, normalizeHostName } = await import("../../src/components/this-app/hosts-manager");
const { DesktopAppSettingsListener } = await import("../../src/components/desktop-app-settings-listener");
const { AccountMenu } = await import("../../src/components/account-menu");

const HOME = { origin: "https://polaris.example.test", name: "Home", host: "polaris.example.test", active: true };
const LAB = { origin: "https://lab.example.test", name: null, host: "lab.example.test", active: false };
const LIST = { servers: [HOME, LAB], error: null };

function fakeHosts(overrides: Record<string, unknown> = {}) {
    return {
        list: vi.fn(async () => LIST),
        check: vi.fn(async () => ({ ok: true, message: "Polaris 1.0" })),
        add: vi.fn(async () => ({ ok: true })),
        switchTo: vi.fn(async () => ({ ok: true })),
        edit: vi.fn(async () => ({ ok: true })),
        remove: vi.fn(async () => ({ ok: true })),
        status: vi.fn(async (origin: string) => (origin === HOME.origin ? "online" : "offline")),
        link: vi.fn(async () => "polaris://hosts?list=fixture"),
        copy: vi.fn(async () => ({ ok: true, count: 2 })),
        exportFile: vi.fn(async () => ({ ok: true, added: 0, named: 0, skipped: 0 })),
        importFile: vi.fn(async () => ({ ok: false, error: null })),
        importText: vi.fn(async () => ({ ok: true, added: 1, named: 0, skipped: 0 })),
        ...overrides
    };
}

function install(hosts: ReturnType<typeof fakeHosts> | null) {
    const appSettings = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => null),
        record: vi.fn(async () => undefined),
        setShortcut: vi.fn(async () => null),
        clearClipboard: vi.fn(async () => undefined),
        relaunch: vi.fn(async () => undefined),
        manageHosts: vi.fn(async () => undefined),
        announce: vi.fn(async () => undefined),
        onChange: vi.fn(() => () => undefined),
        onOpen: vi.fn(() => () => undefined),
        ...(hosts ? { hosts } : {})
    };
    const bridge = {
        version: "0.1.98",
        platform: "win32",
        notify: vi.fn(),
        closeNotice: vi.fn(),
        pickFolder: vi.fn(),
        pushLocal: vi.fn(),
        openWindow: vi.fn(),
        openServers: vi.fn(async () => undefined),
        appSettings
    };
    (window as { polarisDesktop?: unknown }).polarisDesktop = bridge;
    return bridge;
}

async function draw() {
    render(
        <MessagesWrapper>
            <AppSettingsView category="hosts" />
        </MessagesWrapper>
    );
    await act(async () => {
        await Promise.resolve();
    });
}

/** Past the pause the page waits for before asking about a typed address. */
async function afterTyping() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
    });
}

/** jsdom here has no working `localStorage`: a plain in-memory one. */
function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, String(value))
    };
}

beforeEach(() => {
    forgetHostsSnapshot();
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    push.mockClear();
});
afterEach(() => {
    cleanup();
    delete (window as { polarisDesktop?: unknown }).polarisDesktop;
});

describe("the hosts list", () => {
    it("lists every host with how it answers and the one in use", async () => {
        install(fakeHosts());
        await draw();
        const home = screen.getByText("Home").closest("li") as HTMLElement;
        expect(within(home).getByText("In use")).toBeTruthy();
        expect(within(home).getByText("Answering")).toBeTruthy();
        // A host with no name is shown by its address, and offers to switch to it.
        const lab = screen.getByText("lab.example.test").closest("li") as HTMLElement;
        expect(within(lab).getByText("Not answering")).toBeTruthy();
        expect(within(lab).getByRole("button", { name: "Switch" })).toBeTruthy();
        expect(within(home).queryByRole("button", { name: "Switch" })).toBeNull();
    });

    it("draws the list this device saw last before the app answers", async () => {
        window.localStorage.setItem("polaris.this-app.hosts", JSON.stringify(LIST));
        install(fakeHosts({ list: vi.fn(() => new Promise(() => undefined)), status: vi.fn(() => new Promise(() => undefined)) }));
        await draw();
        expect(screen.getByText("Home")).toBeTruthy();
        expect(screen.getAllByText("Checking").length).toBe(2);
        expect(document.querySelector("[aria-busy=true].h-9")).toBeNull();
    });

    it("ignores a kept list that is not one", async () => {
        window.localStorage.setItem("polaris.this-app.hosts", JSON.stringify({ servers: "nope" }));
        install(fakeHosts({ list: vi.fn(() => new Promise(() => undefined)) }));
        await draw();
        expect(screen.getByText("Reading the hosts this app keeps.")).toBeTruthy();
    });

    it("switches to a host through the app", async () => {
        const hosts = fakeHosts();
        install(hosts);
        await draw();
        const lab = screen.getByText("lab.example.test").closest("li") as HTMLElement;
        await act(async () => within(lab).getByRole("button", { name: "Switch" }).click());
        expect(hosts.switchTo).toHaveBeenCalledWith(LAB.origin);
    });

    it("removes a host only after asking, and puts it back when the app refuses", async () => {
        let answer: (value: unknown) => void = () => undefined;
        const hosts = fakeHosts({ remove: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
        install(hosts);
        await draw();
        await act(async () => screen.getByRole("button", { name: "Remove lab.example.test" }).click());
        expect(hosts.remove).not.toHaveBeenCalled();
        const dialog = await screen.findByRole("dialog");
        await act(async () => within(dialog).getByRole("button", { name: "Remove" }).click());
        expect(hosts.remove).toHaveBeenCalledWith(LAB.origin);
        expect(screen.queryByText("lab.example.test")).toBeNull();
        await act(async () => answer({ ok: false, error: "Refused." }));
        expect(screen.getByText("lab.example.test")).toBeTruthy();
    });

    it("warns that removing the host in use closes its windows", async () => {
        install(fakeHosts());
        await draw();
        await act(async () => screen.getByRole("button", { name: "Remove Home" }).click());
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText(/its windows close/)).toBeTruthy();
    });

    it("draws a row's edit and remove as icons, named for the host they act on", async () => {
        install(fakeHosts());
        await draw();
        for (const name of ["Edit Home", "Remove Home"]) {
            const button = screen.getByRole("button", { name });
            // A phone row has no room for two words beside the name: an icon, its words for a screen reader.
            expect(button.querySelector("svg")).toBeTruthy();
            expect(button.textContent?.trim()).toBe("");
        }
    });

    it("edits a host's name and address together", async () => {
        const hosts = fakeHosts();
        install(hosts);
        await draw();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Edit Home" }));
        const save = screen.getByRole("button", { name: "Save" });
        // Nothing changed yet: nothing to save.
        expect(save.getAttribute("aria-disabled")).toBe("true");
        const form = screen.getByRole("button", { name: "Save" }).closest("form") as HTMLElement;
        const name = within(form).getByLabelText("Name");
        await user.clear(name);
        await user.type(name, "  Home   server ");
        // The address it already has needs no asking.
        expect(hosts.check).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(hosts.edit).toHaveBeenCalledWith(HOME.origin, HOME.origin, "Home server");
    });
});

describe("adding a host", () => {
    it("adds only once the app says the address is a Polaris", async () => {
        const hosts = fakeHosts();
        install(hosts);
        await draw();
        const user = userEvent.setup();
        const add = screen.getByRole("button", { name: "Add" });
        // Empty is incomplete, not wrong: no error, no asking, nothing added.
        expect(add.getAttribute("aria-disabled")).toBe("true");
        expect(screen.queryByRole("alert")).toBeNull();
        await user.click(add);
        expect(hosts.add).not.toHaveBeenCalled();

        await user.type(screen.getByLabelText("Address *"), "  new.example.test ");
        await afterTyping();
        expect(hosts.check).toHaveBeenLastCalledWith("new.example.test");
        expect(screen.getByText("A Polaris answers at this address.")).toBeTruthy();
        await user.type(screen.getByLabelText("Name"), "New");
        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(hosts.add).toHaveBeenCalledWith("new.example.test", "New");
        await waitFor(() => expect(hosts.list).toHaveBeenCalledTimes(2));
    });

    it("says what the app found wrong and does not add it", async () => {
        const hosts = fakeHosts({ check: vi.fn(async () => ({ ok: false, message: "That is not a Polaris." })) });
        install(hosts);
        await draw();
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Address *"), "example.test");
        await afterTyping();
        expect(screen.getByRole("alert").textContent).toBe("That is not a Polaris.");
        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(hosts.add).not.toHaveBeenCalled();
    });

    it("refuses a name longer than the app keeps", async () => {
        install(fakeHosts());
        await draw();
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Address *"), "new.example.test");
        await afterTyping();
        await user.type(screen.getByLabelText("Name"), "x".repeat(41));
        expect(screen.getByText("Use at most 40 characters.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Add" }).getAttribute("aria-disabled")).toBe("true");
        expect(normalizeHostName("  a   b ")).toBe("a b");
    });
});

describe("sending and taking in the list", () => {
    it("shows the list as a QR code and copies it through the app", async () => {
        const hosts = fakeHosts();
        install(hosts);
        await draw();
        await act(async () => screen.getByRole("button", { name: "Show QR code" }).click());
        expect(hosts.link).toHaveBeenCalled();
        expect(await screen.findByLabelText("QR code with the hosts of this app")).toBeTruthy();
        await act(async () => screen.getByRole("button", { name: "Copy code" }).click());
        expect(hosts.copy).toHaveBeenCalled();
        await act(async () => screen.getByRole("button", { name: "Save to a file" }).click());
        expect(hosts.exportFile).toHaveBeenCalled();
    });

    it("takes in a pasted code and a file through the app", async () => {
        const hosts = fakeHosts();
        install(hosts);
        await draw();
        const user = userEvent.setup();
        const importButton = screen.getByRole("button", { name: "Import" });
        expect(importButton.getAttribute("aria-disabled")).toBe("true");
        await user.type(screen.getByLabelText("Code"), "  polaris://hosts?list=fixture ");
        await user.click(screen.getByRole("button", { name: "Import" }));
        expect(hosts.importText).toHaveBeenCalledWith("polaris://hosts?list=fixture");
        await waitFor(() => expect((screen.getByLabelText("Code") as HTMLTextAreaElement).value).toBe(""));
        await user.click(screen.getByRole("button", { name: "Open a file" }));
        expect(hosts.importFile).toHaveBeenCalled();
    });
});

describe("an app older than hosts managed here", () => {
    it("keeps the list and the button to its own window", async () => {
        const bridge = install(null);
        bridge.appSettings.get = vi.fn(async () => ({
            openAtLogin: true,
            startMinimized: true,
            minimizeToTray: true,
            launcher: true,
            launcherBinding: "Alt+Space",
            launcherGameMode: false,
            launcherEngine: "google",
            launcherClipboard: true,
            launcherClipboardKeep: "week",
            voiceWidget: true,
            voiceWidgetGameOnly: false,
            hardwareAcceleration: true,
            restartPending: false,
            launcherClipboardPersists: true,
            launcherKey: "Alt+Space",
            launcherProblem: null,
            version: "0.1.72",
            server: HOME.origin,
            servers: [{ origin: HOME.origin, name: "Home" }]
        })) as never;
        await draw();
        await act(async () => screen.getByRole("button", { name: "Manage hosts" }).click());
        expect(bridge.appSettings.manageHosts).toHaveBeenCalled();
    });
});

describe("telling the app and opening hosts", () => {
    it("says the page draws hosts only when the app manages them here", async () => {
        const managed = install(fakeHosts());
        render(<DesktopAppSettingsListener />);
        await act(async () => Promise.resolve());
        expect(managed.appSettings.announce).toHaveBeenCalledWith(["hosts"]);
        cleanup();
        const older = install(null);
        render(<DesktopAppSettingsListener />);
        await act(async () => Promise.resolve());
        expect(older.appSettings.announce).toHaveBeenCalledWith([]);
    });

    it("opens hosts from the account menu here, or in an older app's own window", async () => {
        const managed = install(fakeHosts());
        const user = userEvent.setup();
        const menu = () =>
            render(
                <AccountMenu
                    id="ada"
                    name="Ada"
                    email="ada@example.com"
                    presence="auto"
                    presenceUntil={null}
                    presenceScheduled={false}
                    presenceNextChange={null}
                    status=""
                    statusUntil={null}
                />,
                { wrapper: MessagesWrapper }
            );
        menu();
        await user.click(screen.getByRole("button", { name: "Your account" }));
        const items = await screen.findAllByRole("menuitem");
        const hostsItem = items.find((item) => item.textContent === "Hosts") as HTMLElement;
        await user.click(hostsItem);
        expect(push).toHaveBeenCalledWith("/account/app/hosts");
        expect(managed.openServers).not.toHaveBeenCalled();
        cleanup();

        const older = install(null);
        menu();
        await user.click(screen.getByRole("button", { name: "Your account" }));
        const again = await screen.findAllByRole("menuitem");
        await user.click(again.find((item) => item.textContent === "Hosts") as HTMLElement);
        expect(older.openServers).toHaveBeenCalled();
    });
});
