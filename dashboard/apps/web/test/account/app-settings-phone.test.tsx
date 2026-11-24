// @vitest-environment jsdom
/**
 * Settings > This app inside the phone app: the categories the phone keeps
 * (General, Hosts, Updates), drawn from what the app answers over its bridge.
 *
 * What has to hold: the app's answer is read through the shared schema (an
 * older or newer app never breaks the screen), each General row opens the
 * screen it names, servers are changed on the app's own screen, a check for
 * updates comes back through the app's callback, only the phone's categories
 * are offered in the phone app, and a category it does not keep says so.
 */

import { MessagesWrapper } from "../setup/i18n";
import * as core from "@polaris/core/app-settings";
import { APP_SECTIONS, sectionOffered } from "@/lib/apps";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const { AppSettingsView } = await import("../../src/app/(app)/account/app/[category]/app-settings-view");
const { ThisDeviceApp } = await import("../../src/components/this-app/this-device-app");

const SNAPSHOT = {
    version: "0.1.15",
    server: "https://polaris.example.test",
    servers: [
        { origin: "https://polaris.example.test", name: "Home" },
        { origin: "https://work.example.test", name: null }
    ],
    actions: ["notifications", "language", "vault", "browser"],
    updates: "check"
};

type Update = (id: string, json: string) => void;

function phone(snapshot: unknown = SNAPSHOT) {
    const app = {
        platform: () => "android",
        version: () => "0.1.15",
        changeServer: vi.fn(),
        appSettings: vi.fn(() => JSON.stringify(snapshot)),
        appSettingsAction: vi.fn(),
        checkForUpdates: vi.fn()
    };
    (window as { polarisMobile?: unknown }).polarisMobile = app;
    return app;
}

async function draw(category: core.AppSettingCategory) {
    render(
        <MessagesWrapper>
            <AppSettingsView category={category} />
        </MessagesWrapper>
    );
    await act(async () => {
        await Promise.resolve();
    });
}

/** The phone's version and updates, as Downloads draws them. */
async function drawDownloads() {
    render(
        <MessagesWrapper>
            <ThisDeviceApp />
        </MessagesWrapper>
    );
    await act(async () => {
        await Promise.resolve();
    });
}

afterEach(() => {
    cleanup();
    delete (window as { polarisMobile?: unknown }).polarisMobile;
    delete (window as { __polarisMobileUpdate?: unknown }).__polarisMobileUpdate;
});

describe("the phone app's answer", () => {
    it("reads a snapshot from the app's JSON and drops what it does not know", () => {
        const read = core.readPhoneAppSettings(JSON.stringify({ ...SNAPSHOT, actions: ["vault", "teleport"] }));
        expect(read?.actions).toEqual(["vault"]);
        expect(read?.servers).toHaveLength(2);
    });

    it("falls back field by field for an older app, and refuses what is not an object", () => {
        expect(core.readPhoneAppSettings("{}")).toEqual({
            version: "",
            server: null,
            servers: [],
            actions: [],
            updates: "none"
        });
        expect(core.readPhoneAppSettings("not json")).toBeNull();
        expect(core.readPhoneAppSettings("[]")).toBeNull();
        expect(core.readPhoneAppSettings(null)).toBeNull();
    });

    it("counts an unreadable update answer as a failed check", () => {
        expect(core.readPhoneUpdateCheck('{"kind":"available","version":"0.1.16"}')).toEqual({
            kind: "available",
            version: "0.1.16"
        });
        expect(core.readPhoneUpdateCheck('{"kind":"available"}')).toEqual({ kind: "failed" });
        expect(core.readPhoneUpdateCheck("nope")).toEqual({ kind: "failed" });
    });

    it("knows only the actions it names", () => {
        expect(core.readPhoneAppAction("vault")).toBe("vault");
        expect(core.readPhoneAppAction("shell")).toBeNull();
    });
});

describe("the phone app's settings screen", () => {
    it("opens the screen each General row names", async () => {
        const app = phone();
        await draw("general");
        expect(screen.getByText("Notifications")).toBeTruthy();
        expect(screen.getByText("https://polaris.example.test")).toBeTruthy();
        const buttons = screen.getAllByRole("button", { name: "Open" });
        expect(buttons).toHaveLength(4);
        await act(async () => buttons[2]!.click());
        expect(app.appSettingsAction).toHaveBeenCalledWith("vault");
    });

    it("lists only the rows this phone has", async () => {
        phone({ ...SNAPSHOT, actions: ["notifications", "browser"] });
        await draw("general");
        expect(screen.queryByText("Language")).toBeNull();
        expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(2);
    });

    it("lists the servers and changes them on the app's own screen", async () => {
        const app = phone();
        await draw("hosts");
        expect(screen.getByText("Home")).toBeTruthy();
        expect(screen.getByText("https://work.example.test")).toBeTruthy();
        expect(screen.getByText("In use")).toBeTruthy();
        // A phone has no windows: the hint names the app's own screen.
        expect(screen.getByText(/on the app's own screen/)).toBeTruthy();
        expect(screen.queryByText(/window/)).toBeNull();
        await act(async () => screen.getByRole("button", { name: "Manage hosts" }).click());
        expect(app.changeServer).toHaveBeenCalled();
    });

    it("checks for updates through the app's callback, on Downloads", async () => {
        const app = phone();
        await drawDownloads();
        expect(screen.getByText("Polaris 0.1.15")).toBeTruthy();
        await act(async () => screen.getByRole("button", { name: "Check for updates" }).click());
        expect(screen.getByText("Checking for updates...")).toBeTruthy();
        const id = app.checkForUpdates.mock.calls[0]![0] as string;
        const answer = (window as { __polarisMobileUpdate?: Update }).__polarisMobileUpdate!;
        await act(async () => answer(id, '{"kind":"current"}'));
        expect(screen.getByText("You have the latest version.")).toBeTruthy();
    });

    it("says a store updates a copy installed from one", async () => {
        phone({ ...SNAPSHOT, updates: "store" });
        await drawDownloads();
        expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
        expect(screen.getByText("This copy of Polaris updates through the system that installed it.")).toBeTruthy();
    });

    it("says a desktop category is not kept on the phone", async () => {
        phone();
        await draw("clipboard");
        expect(screen.getByText("Only in the desktop app")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Go to General" }).getAttribute("href")).toBe("/account/app/general");
    });

    it("keeps the app's own screen for an app older than the feature", async () => {
        (window as { polarisMobile?: unknown }).polarisMobile = { changeServer: vi.fn() };
        await draw("general");
        expect(screen.getByText("Open this in the desktop app")).toBeTruthy();
    });
});

describe("the This app group in the phone app", () => {
    it("offers the phone's categories only", () => {
        const gate = { isAdmin: true, held: [], installed: [], phone: true };
        const offered = (APP_SECTIONS.account ?? [])
            .filter((section) => section.desktopOnly && sectionOffered(section, gate))
            .map((section) => section.href);
        expect(offered).toEqual(core.APP_PHONE_CATEGORIES.map((category) => `/account/app/${category}`));
    });
});
