// @vitest-environment jsdom

/**
 * The game server tabs that read a container draw themselves before it answers.
 *
 * Each of these screens is a list Polaris already has - ARK's and FiveM's
 * settings, Minecraft's rules, the headings of the mod lists, the table of
 * resources, what the side panel and the linked chat are for - with values that
 * only the running server can give. The list is on screen at once and only the
 * values wait; a reading that fails says so rather than leaving a pulse behind.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { english } from "../setup/game-english";
import { gameMessage } from "@polaris-app/game-servers/src/lib/game-message";

/** A reading nobody has answered yet. */
const never = () => new Promise<never>(() => undefined);

/** What each tab's read will say, set per test. Unset, it never answers. */
const answers: {
    worldRules?: () => Promise<unknown>;
    storedRules?: () => Promise<unknown>;
    liveDisplay?: () => Promise<unknown>;
    chatLink?: () => Promise<unknown>;
} = {};

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        i18nProvider: { useLocale: () => "en-US" },
        liveRead: { useKeptSnapshot: () => undefined },
        snapshotCache: {
            readSnapshot: () => null,
            writeSnapshot: () => undefined,
            dropSnapshots: () => undefined
        },
        structuralMerge: { mergeUnchanged: <T,>(_previous: T, next: T) => next },
        confirmDialog: { useConfirm: () => [async () => true, null] },
        copyButton: { CopyButton: () => null },
        relativeTime: { RelativeTime: () => null },
        displayFormat: { useDisplayFormat: () => ({ dateTime: (at: number) => String(at) }) },
        gameLogo: { GameLogo: () => null }
    }
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/restart-actions", () => ({
    readGameRestartAction: never,
    scheduleGameRestartAction: never,
    restartGameNowAction: never,
    cancelGameRestartAction: never
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/ark-actions", () => ({
    readArkRulesAction: never,
    setArkRulesAction: never,
    readArkModsAction: never,
    setArkModsAction: never,
    setArkMapModAction: never,
    readArkModShelvesAction: never,
    lookUpArkModAction: never,
    searchArkModsAction: never
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/fivem-actions", () => ({
    readFivemRulesAction: never,
    saveFivemRulesAction: never,
    listFivemResourcesAction: never,
    refreshFivemResourcesAction: never,
    actOnFivemResourceAction: never
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({
    readWorldRulesAction: () => (answers.worldRules ?? never)(),
    storedWorldRulesAction: () => (answers.storedRules ?? never)(),
    setWorldRuleAction: never,
    setWorldDifficultyAction: never
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/live-display-actions", () => ({
    readLiveDisplayAction: () => (answers.liveDisplay ?? never)(),
    saveLiveDisplayAction: never
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/announce-actions", () => ({}));
vi.mock("@polaris-app/game-servers/src/screens/installed/chat-link-actions", () => ({
    readChatLinkAction: () => (answers.chatLink ?? never)(),
    saveChatLinkAction: never
}));

const SERVER = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
    cleanup();
    delete answers.worldRules;
    delete answers.storedRules;
    delete answers.liveDisplay;
    delete answers.chatLink;
});

describe("ARK's settings before the server answers", () => {
    it("draws the search and every setting, with no control in a guessed position", async () => {
        const { ArkRules } = await import(
            "@polaris-app/game-servers/src/screens/installed/ark-rules"
        );
        const { arkSettingGroups } = await import("@polaris-app/game-servers/src/lib/ark/settings");
        render(<ArkRules installedAppId={SERVER} canManage running />);
        expect(screen.getByLabelText("Find a setting")).toBeTruthy();
        const setting = arkSettingGroups()[0]!.settings[0]!;
        expect(screen.getByText(setting.key)).toBeTruthy();
        expect(screen.queryByLabelText(setting.label)).toBeNull();
    });
});

describe("FiveM's settings before the server answers", () => {
    it("draws the search and every setting, with no control in a guessed position", async () => {
        const { FivemRules } = await import(
            "@polaris-app/game-servers/src/screens/installed/fivem-rules"
        );
        const { FIVEM_SETTINGS } = await import("@polaris-app/game-servers/src/lib/fivem/settings");
        render(<FivemRules installedAppId={SERVER} canManage running />);
        expect(screen.getByLabelText("Find a setting")).toBeTruthy();
        const setting = FIVEM_SETTINGS[0]!;
        expect(screen.getByText(setting.key)).toBeTruthy();
        expect(screen.queryByLabelText(setting.label)).toBeNull();
    });
});

describe("ARK's mods before the server answers", () => {
    it("draws both lists' headings and claims nothing about what is in them", async () => {
        const { ArkMods } = await import(
            "@polaris-app/game-servers/src/screens/installed/ark-mods"
        );
        render(<ArkMods installedAppId={SERVER} canManage={false} running />);
        expect(screen.getByText("Map")).toBeTruthy();
        expect(screen.getByText("Mods")).toBeTruthy();
        expect(screen.queryByText(/^No mods\./)).toBeNull();
    });
});

describe("FiveM's resources before the server answers", () => {
    it("draws the table and its search, and says nothing about it being empty", async () => {
        const { FivemResources } = await import(
            "@polaris-app/game-servers/src/screens/installed/fivem-resources"
        );
        render(<FivemResources installedAppId={SERVER} applicationId={null} canManage running />);
        expect(screen.getByPlaceholderText("Search resources")).toBeTruthy();
        expect(screen.getByText("Resource")).toBeTruthy();
        expect(screen.queryByText(/^No resources yet/)).toBeNull();
    });
});

describe("Minecraft's rules before the server answers", () => {
    it("draws the difficulty and every rule, with no control in a guessed position", async () => {
        const { MinecraftRules } = await import(
            "@polaris-app/game-servers/src/screens/installed/minecraft-rules"
        );
        const { ruleGroups } = await import("@polaris-app/game-servers/src/lib/minecraft/rules");
        render(<MinecraftRules installedAppId={SERVER} canManage />);
        expect(screen.getByText("Difficulty")).toBeTruthy();
        const rule = ruleGroups()[0]!.rules[0]!;
        const label = english(gameMessage("minecraft", rule.label));
        expect(screen.getByText(label)).toBeTruthy();
        expect(screen.queryByLabelText(label)).toBeNull();
        expect(screen.queryByLabelText("Difficulty")).toBeNull();
    });

    it("keeps the rules on screen and says so when neither reading arrives", async () => {
        answers.storedRules = async () => ({ error: "No record" });
        answers.worldRules = async () => ({ error: "The server is not running" });
        const { MinecraftRules } = await import(
            "@polaris-app/game-servers/src/screens/installed/minecraft-rules"
        );
        const { ruleGroups } = await import("@polaris-app/game-servers/src/lib/minecraft/rules");
        render(<MinecraftRules installedAppId={SERVER} canManage />);
        await waitFor(() => expect(screen.getByText("The server is not running")).toBeTruthy());
        expect(screen.getByText("Difficulty")).toBeTruthy();
        expect(
            screen.getByText(english(gameMessage("minecraft", ruleGroups()[0]!.rules[0]!.label)))
        ).toBeTruthy();
    });
});

describe("the side panel and the linked chat before they are read", () => {
    it("say what each card is at once", async () => {
        const { MinecraftSidebar } = await import(
            "@polaris-app/game-servers/src/screens/installed/minecraft-sidebar"
        );
        const { MinecraftChatLink } = await import(
            "@polaris-app/game-servers/src/screens/installed/minecraft-chat-link"
        );
        render(
            <>
                <MinecraftSidebar installedAppId={SERVER} canManage />
                <MinecraftChatLink installedAppId={SERVER} />
            </>
        );
        expect(screen.getByText(/A box on the right of every player/)).toBeTruthy();
        expect(screen.getByText(/The chat group or space this server talks through/)).toBeTruthy();
        expect(screen.queryByLabelText("Show the side panel")).toBeNull();
    });

    it("keep the heading and say why when the reading fails", async () => {
        answers.liveDisplay = async () => ({ error: "The panel could not be read" });
        answers.chatLink = async () => ({ error: "The linked chat could not be read" });
        const { MinecraftSidebar } = await import(
            "@polaris-app/game-servers/src/screens/installed/minecraft-sidebar"
        );
        const { MinecraftChatLink } = await import(
            "@polaris-app/game-servers/src/screens/installed/minecraft-chat-link"
        );
        render(
            <>
                <MinecraftSidebar installedAppId={SERVER} canManage />
                <MinecraftChatLink installedAppId={SERVER} />
            </>
        );
        await waitFor(() => expect(screen.getByText("The panel could not be read")).toBeTruthy());
        expect(screen.getByText("The linked chat could not be read")).toBeTruthy();
        expect(screen.getByText("Side panel")).toBeTruthy();
        expect(screen.getByText("Linked chat")).toBeTruthy();
    });
});
