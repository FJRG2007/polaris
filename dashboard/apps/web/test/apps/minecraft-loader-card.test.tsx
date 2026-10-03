// @vitest-environment jsdom

/**
 * The card a server's own page shows for its mod loader (see
 * `crash-loop-loader.test.ts` and `minecraft-loader-pin-sweep.test.ts` for the
 * incident this exists to prevent). Rendered rather than only read, because the
 * one way to update a held loader is a button this card draws and a dialog it
 * opens - the business rules do not say whether a reader actually sees "Pinned",
 * the hint that explains it, and an "Update loader" button that works.
 */

import userEvent from "@testing-library/user-event";
import { provideAppHostUi } from "@polaris/app-host/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoaderPinView } from "@polaris-app/game-servers/src/lib/minecraft/loader-pin-service";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTALLED_APP_ID = "22222222-2222-4222-8222-222222222222";

let confirmAnswer = true;
const confirmCalls: Array<{ title: string; description: string; confirmLabel: string }> = [];

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({
    readLoaderPinAction: async () => readAnswer,
    updateLoaderAction: async () => updateAnswer
}));

let readAnswer: { view?: LoaderPinView; error?: string } = { error: "unset" };
let updateAnswer: { restarted?: boolean; error?: string } = { error: "unset" };

provideAppHostUi({
    confirmDialog: {
        useConfirm: () => [
            async (options: { title: string; description: string; confirmLabel: string }) => {
                confirmCalls.push(options);
                return confirmAnswer;
            },
            null
        ]
    },
    i18nProvider: { useLocale: () => "en-US" },
    liveRead: { useKeptSnapshot: () => undefined },
    snapshotCache: { writeSnapshot: () => undefined }
} as never);

const { MinecraftLoader } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-loader"
);

beforeEach(() => {
    confirmAnswer = true;
    confirmCalls.length = 0;
    readAnswer = { error: "unset" };
    updateAnswer = { error: "unset" };
});

afterEach(() => cleanup());

describe("a loader held at the version it installed", () => {
    it("shows the pinned badge, the version, and an Update loader button", async () => {
        readAnswer = {
            view: {
                pin: { state: "held", loader: "NeoForge", key: "NEOFORGE_VERSION", version: "21.4.158" },
                updating: false
            }
        };
        await act(async () => {
            render(<MinecraftLoader installedAppId={INSTALLED_APP_ID} playersOnline={0} running={true} />);
        });

        expect(screen.getByText("Mod loader")).toBeTruthy();
        expect(screen.getByText("NeoForge 21.4.158")).toBeTruthy();
        expect(screen.getByText("Pinned")).toBeTruthy();
        expect(
            screen.getByText("Every start runs this version without asking NeoForge's repository.")
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: /Update loader/ })).toBeTruthy();
    });

    it("warns about dropped players and restarts the server once confirmed", async () => {
        readAnswer = {
            view: {
                pin: { state: "held", loader: "NeoForge", key: "NEOFORGE_VERSION", version: "21.4.158" },
                updating: false
            }
        };
        updateAnswer = { restarted: true };
        const user = userEvent.setup();
        await act(async () => {
            render(<MinecraftLoader installedAppId={INSTALLED_APP_ID} playersOnline={3} running={true} />);
        });

        await act(async () => {
            await user.click(screen.getByRole("button", { name: /Update loader/ }));
        });

        expect(confirmCalls).toHaveLength(1);
        expect(confirmCalls[0]?.title).toBe("Update NeoForge?");
        expect(confirmCalls[0]?.description).toContain("Mods built for 21.4.158 may not load on the new version.");
        expect(confirmCalls[0]?.description).toContain("3 players are connected and will be disconnected");
        expect(confirmCalls[0]?.confirmLabel).toBe("Update and restart");

        expect(await screen.findByText("The server is restarting with the newest NeoForge.")).toBeTruthy();
    });

    it("does not touch the server when the operator backs out of the confirm dialog", async () => {
        readAnswer = {
            view: {
                pin: { state: "held", loader: "Forge", key: "FORGE_VERSION", version: "47.4.0" },
                updating: false
            }
        };
        confirmAnswer = false;
        const updateSpy = vi.fn();
        const actions = await import(
            "@polaris-app/game-servers/src/screens/installed/minecraft-actions"
        );
        vi.spyOn(actions, "updateLoaderAction").mockImplementation(updateSpy);

        const user = userEvent.setup();
        await act(async () => {
            render(<MinecraftLoader installedAppId={INSTALLED_APP_ID} playersOnline={0} running={false} />);
        });
        await act(async () => {
            await user.click(screen.getByRole("button", { name: /Update loader/ }));
        });

        expect(updateSpy).not.toHaveBeenCalled();
        expect(screen.queryByText(/restarting|installs the next time/)).toBeNull();
    });
});

describe("a loader still following the newest release", () => {
    it("explains it will be pinned once the server is up, with no button to press yet", async () => {
        readAnswer = {
            view: { pin: { state: "following", loader: "Fabric", key: "FABRIC_LOADER_VERSION" }, updating: false }
        };
        await act(async () => {
            render(<MinecraftLoader installedAppId={INSTALLED_APP_ID} playersOnline={0} running={true} />);
        });

        expect(screen.getByText("Fabric, newest version")).toBeTruthy();
        expect(
            screen.getByText(
                "Each start asks Fabric's repository for the newest version. Polaris pins the installed one once the server is up."
            )
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Update loader/ })).toBeNull();
    });
});

describe("a loader whose update is already installing", () => {
    it("says so instead of offering the button twice", async () => {
        readAnswer = {
            view: {
                pin: { state: "held", loader: "NeoForge", key: "NEOFORGE_VERSION", version: "21.4.158" },
                updating: true
            }
        };
        await act(async () => {
            render(<MinecraftLoader installedAppId={INSTALLED_APP_ID} playersOnline={0} running={true} />);
        });

        expect(
            screen.getByText(
                "The next start installs the newest NeoForge, and Polaris pins it again once the server is up."
            )
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Update loader/ })).toBeNull();
        expect(screen.queryByText("Pinned")).toBeNull();
    });
});

describe("a server with nothing to hold", () => {
    it("draws nothing at all", async () => {
        readAnswer = { view: { pin: { state: "none" }, updating: false } };
        const { container } = await act(async () =>
            render(<MinecraftLoader installedAppId={INSTALLED_APP_ID} playersOnline={0} running={true} />)
        );
        expect(container.textContent).toBe("");
    });
});
