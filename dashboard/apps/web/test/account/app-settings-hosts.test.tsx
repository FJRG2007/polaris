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

/** Pick an entry from a host row's three-dots menu. */
async function fromMenu(user: ReturnType<typeof userEvent.setup>, host: string, item: string) {
    await user.click(screen.getByRole("button", { name: `Actions for ${host}` }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
}

/** Open "Add host" from the header and return its dialog. */
async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Add host" }));
    return within(await screen.findByRole("dialog"));
}

describe("the hosts list", () => {
    it("draws the hosts as a table with how each answers and the one in use", async () => {
        install(fakeHosts());
        await draw();
        expect(screen.getByRole("table")).toBeTruthy();
        const home = screen.getAllByText("Home")[0].closest("tr") as HTMLElement;
        expect(within(home).getAllByText("In use").length).toBeGreaterThan(0);
        expect(within(home).getAllByText("Answering").length).toBeGreaterThan(0);
        // A host with no name is shown by its address.
        const lab = screen.getAllByText("lab.example.test")[0].closest("tr") as HTMLElement;
        expect(within(lab).getAllByText("Not answering").length).toBeGreaterThan(0);
        expect(within(lab).getByRole("button", { name: "Actions for lab.example.test" })).toBeTruthy();
    });

    it("adds through one header button, never an inline form under the list", async () => {
        install(fakeHosts());
        await draw();
        expect(screen.queryByLabelText("Address *")).toBeNull();
        const add = screen.getByRole("button", { name: "Add host" });
        expect(add.querySelector("svg")).toBeTruthy();
    });

    it("draws the list this device saw last before the app answers", async () => {
        window.localStorage.setItem("polaris.this-app.hosts", JSON.stringify(LIST));
        install(fakeHosts({ list: vi.fn(() => new Promise(() => undefined)), status: vi.fn(() => new Promise(() => undefined)) }));
        await draw();
        expect(screen.getAllByText("Home").length).toBeGreaterThan(0);
        // Each row draws its state twice - the phone line and the column - one of them hidden by width.
        expect(screen.getAllByText("Checking").length).toBe(4);
        expect(document.querySelector("[aria-busy=true].h-9")).toBeNull();
    });

    it("ignores a kept list that is not one", async () => {
        window.localStorage.setItem("polaris.this-app.hosts", JSON.stringify({ servers: "nope" }));
        install(fakeHosts({ list: vi.fn(() => new Promise(() => undefined)) }));
        await draw();
        expect(screen.getByText("Reading the hosts this app keeps.")).toBeTruthy();
    });

    it("switches to a host from its row menu, and offers no switch for the one in use", async () => {
        const hosts = fakeHosts();
        install(hosts);
        await draw();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Actions for Home" }));
        await screen.findAllByRole("menuitem");
        expect(screen.queryByRole("menuitem", { name: "Use this host" })).toBeNull();
        await user.keyboard("{Escape}");
        await fromMenu(user, "lab.example.test", "Use this host");
        expect(hosts.switchTo).toHaveBeenCalledWith(LAB.origin);
    });

    it("removes a host only after asking, and puts it back when the app refuses", async () => {
        let answer: (value: unknown) => void = () => undefined;
        const hosts = fakeHosts({ remove: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
        install(hosts);
        await draw();
        const user = userEvent.setup();
        await fromMenu(user, "lab.example.test", "Remove");
        expect(hosts.remove).not.toHaveBeenCalled();
        const dialog = await screen.findByRole("dialog");
        await act(async () => within(dialog).getByRole("button", { name: "Remove" }).click());
        expect(hosts.remove).toHaveBeenCalledWith(LAB.origin);
        expect(screen.queryAllByText("lab.example.test")).toHaveLength(0);
        await act(async () => answer({ ok: false, error: "Refused." }));
        expect(screen.getAllByText("lab.example.test").length).toBeGreaterThan(0);
    });

    it("warns that removing the host in use closes its windows", async () => {
        install(fakeHosts());
        await draw();
        const user = userEvent.setup();
        await fromMenu(user, "Home", "Remove");
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText(/its windows close/)).toBeTruthy();
    });

    it("edits a host's name and address together, in a dialog", async () => {
        const hosts = fakeHosts();
        install(hosts);
        await draw();
        const user = userEvent.setup();
        await fromMenu(user, "Home", "Edit");
        const dialog = within(await screen.findByRole("dialog"));
        const save = dialog.getByRole("button", { name: "Save" });
        // Nothing changed yet: nothing to save.
        expect(save.getAttribute("aria-disabled")).toBe("true");
        const name = dialog.getByLabelText("Name");
        await user.clear(name);
        await user.type(name, "  Home   server ");
        // The address it already has needs no asking.
        expect(hosts.check).not.toHaveBeenCalled();
        await user.click(dialog.getByRole("button", { name: "Save" }));
        expect(hosts.edit).toHaveBeenCalledWith(HOME.origin, HOME.origin, "Home server");
    });
});

describe("adding a host", () => {
    it("adds only once the app says the address is a Polaris", async () => {
        const hosts = fakeHosts();
        install(hosts);
        await draw();
        const user = userEvent.setup();
        const dialog = await openAdd(user);
        const add = dialog.getByRole("button", { name: "Add" });
        // Empty is incomplete, not wrong: no error, no asking, nothing added.
        expect(add.getAttribute("aria-disabled")).toBe("true");
        expect(dialog.queryByRole("alert")).toBeNull();
        await user.click(add);
        expect(hosts.add).not.toHaveBeenCalled();

        await user.type(dialog.getByLabelText("Address *"), "  new.example.test ");
        await afterTyping();
        expect(hosts.check).toHaveBeenLastCalledWith("new.example.test");
        expect(dialog.getByText("A Polaris answers at this address.")).toBeTruthy();
        await user.type(dialog.getByLabelText("Name"), "New");
        await user.click(dialog.getByRole("button", { name: "Add" }));
        expect(hosts.add).toHaveBeenCalledWith("new.example.test", "New");
        await waitFor(() => expect(hosts.list).toHaveBeenCalledTimes(2));
        // Added: the dialog closes on its own.
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("says what the app found wrong and does not add it", async () => {
        const hosts = fakeHosts({ check: vi.fn(async () => ({ ok: false, message: "That is not a Polaris." })) });
        install(hosts);
        await draw();
        const user = userEvent.setup();
        const dialog = await openAdd(user);
        await user.type(dialog.getByLabelText("Address *"), "example.test");
        await afterTyping();
        expect(dialog.getByRole("alert").textContent).toBe("That is not a Polaris.");
        await user.click(dialog.getByRole("button", { name: "Add" }));
        expect(hosts.add).not.toHaveBeenCalled();
    });

    it("refuses a name longer than the app keeps", async () => {
        install(fakeHosts());
        await draw();
        const user = userEvent.setup();
        const dialog = await openAdd(user);
        await user.type(dialog.getByLabelText("Address *"), "new.example.test");
        await afterTyping();
        await user.type(dialog.getByLabelText("Name"), "x".repeat(41));
        expect(dialog.getByText("Use at most 40 characters.")).toBeTruthy();
        expect(dialog.getByRole("button", { name: "Add" }).getAttribute("aria-disabled")).toBe("true");
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
