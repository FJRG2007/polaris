/**
 * Chat slash commands an app declares in its manifest: registered under the
 * app's own permission, never over a reserved or taken name, recognised in a
 * message, and listed in the composer only to a writer holding the permission
 * while the app is installed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ can: true, installed: true }));
vi.mock("@/lib/app-bundles/store", () => ({ bundleRoot: () => "/nonexistent-polaris-test" }));
vi.mock("@polaris/auth", () => ({ can: async () => state.can }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => state.installed }));
vi.mock("@/lib/chat/text", () => ({ chatWordsFor: async () => (key: string) => key }));
vi.mock("@/lib/polar/access", () => ({ polarAccessFor: async () => ({ use: false }) }));
vi.mock("@/lib/chat/agent-message", () => ({ postAgentMessage: async () => "m" }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/access", () => ({ channelAccess: async () => true }));

import * as core from "@polaris/core";
import { HOST_API } from "@polaris/app-host/version";
import { appCommandIn } from "@/lib/chat/chat-command";
import { appCommandsFor } from "@/lib/chat/app-commands";
import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import { KNOWN_PERMISSIONS } from "@/lib/apps/runtime-catalog";
import { readAppCatalog, runtimeViews } from "@/lib/apps/runtime-catalog-schema";

const command = (over: Record<string, unknown> = {}) => ({
    name: "loaf",
    description: { "en-US": "Says how a loaf is doing", "es-ES": "Dice como va una barra" },
    hint: { "en-US": "loaf" },
    permission: "bakery.use",
    ...over
});

const bakery = {
    id: "bakery",
    version: "1.0.0",
    hostApi: HOST_API,
    name: { "en-US": "Bakery", "es-ES": "Panaderia" },
    summary: { "en-US": "Run a bakery." },
    description: { "en-US": "Orders and ovens." },
    category: "Productivity",
    permissions: ["bakery.use"],
    permissionDefs: [{ key: "bakery.use", label: { "en-US": "Take orders" } }],
    chatCommands: [
        command(),
        // Polaris's own name, and another app's permission: both left out.
        command({ name: "polar" }),
        command({ name: "borrow", permission: "deploy.manage" })
    ],
    bundle: { file: "bakery.zip", digest: `sha256:${"e".repeat(64)}`, size: 1024 },
    published: "2026-11-28T00:00:00.000Z"
};

const deliver = (apps: unknown[], locale = "en-US") =>
    registerRuntimeApps(
        runtimeViews(readAppCatalog({ schema: 1, kind: "apps", issued: "2026-11-28T00:00:00.000Z", apps }), KNOWN_PERMISSIONS, locale)
    );

afterEach(() => {
    deliver([]);
    state.can = true;
    state.installed = true;
});

describe("a manifest's Chat commands", () => {
    it("registers only the app's own, never a reserved name, in the reader's language", () => {
        deliver([bakery], "es-ES");
        expect(core.appChatCommands()).toEqual([
            { name: "loaf", description: "Dice como va una barra", hint: "loaf", permission: "bakery.use", app: "bakery", appName: "Panaderia" }
        ]);
    });

    it("keeps a name for the first app that claims it", () => {
        deliver([bakery, { ...bakery, id: "oven", name: { "en-US": "Oven" }, chatCommands: [command({ permission: "oven.use" })] }]);
        expect(core.appChatCommand("loaf")?.app).toBe("bakery");
    });

    it("is recognised in a message only while it is declared", () => {
        expect(appCommandIn("/loaf rye")).toBeNull();
        deliver([bakery]);
        expect(appCommandIn("/loaf rye")).toEqual({ name: "loaf", text: "rye" });
        expect(appCommandIn("/borrow x")).toBeNull();
    });

    it("is listed only to a writer holding its permission, while the app is installed", async () => {
        deliver([bakery]);
        state.can = true;
        expect((await appCommandsFor("u1")).filter((one) => one.name === "loaf")).toEqual([
            { name: "loaf", description: "Says how a loaf is doing", hint: "loaf", app: "Bakery" }
        ]);
        state.installed = false;
        expect((await appCommandsFor("u1")).some((one) => one.name === "loaf")).toBe(false);
        state.installed = true;
        state.can = false;
        expect(await appCommandsFor("u1")).toEqual([]);
    });
});
