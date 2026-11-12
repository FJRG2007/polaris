/**
 * Chat's settings live under Polaris apps > Chat > Settings.
 *
 * Chat is always installed, so the shared app settings page draws them with no
 * catalog entry and no install row behind it - for administrators only - and the
 * old /admin/chat address keeps sending a reader there (temporarily, like every
 * moved screen: a cached 308 could never be taken back).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { notFound, requireAdmin, hasAppInstall, ChatAdminSettings } = vi.hoisted(() => ({
    notFound: vi.fn((): never => {
        throw new Error("not-found");
    }),
    requireAdmin: vi.fn(),
    hasAppInstall: vi.fn(async () => true),
    ChatAdminSettings: function ChatAdminSettings() {
        return null;
    }
}));
vi.mock("next/navigation", () => ({
    notFound,
    redirect: (to: string): never => {
        throw new Error(`redirect:${to}`);
    }
}));

vi.mock("@/lib/session", () => ({ requireAdmin }));
vi.mock("@/app/(app)/apps/marketplace/store-installs", () => ({ hasAppInstall }));
vi.mock("@/app/(app)/vpn/vpn-admin-settings", () => ({ VpnAdminSettings: () => null }));
vi.mock("@/lib/apps/app-services", () => ({
    appHasServices: async () => false,
    listAppServices: async () => []
}));
vi.mock("@/app/(app)/admin/apps/[appId]/settings/app-services-panel", () => ({
    AppServicesPanel: () => null,
    AppServicesSkeleton: () => null
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
// The page draws the first of Chat's screens through this.
vi.mock("@/app/(app)/admin/apps/[appId]/settings/_chat/chat-screen", () => ({
    ChatSettingsPage: ChatAdminSettings
}));
vi.mock("@/app/(app)/admin/apps/[appId]/settings/_chat/chat-settings", () => ({
    ChatAdminSettings
}));
vi.mock("@/app/(app)/admin/apps/[appId]/settings/_polar/polar-settings", () => ({
    PolarAdminSettings: () => null
}));

import config from "../../next.config.mjs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import SettingsPage from "@/app/(app)/admin/apps/[appId]/settings/page";
import { builtInSettingsHref, CHAT_SETTINGS_PATH } from "@/lib/apps/app-settings";
import { builtInApps } from "@/lib/apps/marketplace-store";

/** Whether a rendered tree holds an element of this component type. */
function holds(node: unknown, type: unknown): boolean {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((child) => holds(child, type));
    const element = node as { type?: unknown; props?: Record<string, unknown> };
    if (element.type === type) return true;
    return holds(element.props?.children, type);
}

async function render(appId: string): Promise<unknown> {
    const page = await SettingsPage({ params: Promise.resolve({ appId }) });
    // The built-in branch hands back an async component; draw it as the server would.
    const element = page as { type: (props: unknown) => unknown; props: unknown };
    return typeof element.type === "function" ? await element.type(element.props) : element;
}

describe("Chat settings under Polaris apps", () => {
    beforeEach(() => {
        requireAdmin.mockReset();
        hasAppInstall.mockClear();
    });

    it("sends /admin/chat to its new place, with no page left to answer it", async () => {
        const rules = await config.redirects();
        expect(rules).toContainEqual({
            source: "/admin/chat",
            destination: CHAT_SETTINGS_PATH,
            permanent: false
        });
        expect(CHAT_SETTINGS_PATH).toBe("/admin/apps/chat/settings");
        expect(existsSync(join(process.cwd(), "src/app/(app)/admin/chat/page.tsx"))).toBe(false);
    });

    it("draws the chat settings for an administrator, with no install row asked", async () => {
        requireAdmin.mockResolvedValue({ id: "admin", isAdmin: true });
        const tree = await render("chat");
        expect(holds(tree, ChatAdminSettings)).toBe(true);
        expect(hasAppInstall).not.toHaveBeenCalled();
    });

    it("refuses anybody who is not an administrator before drawing anything", async () => {
        requireAdmin.mockRejectedValue(new Error("forbidden"));
        await expect(render("chat")).rejects.toThrow("forbidden");
    });

    it("offers settings on the Chat card and on no other built-in", () => {
        expect(builtInApps().map((app) => app.id)).toContain("chat");
        expect(builtInSettingsHref("chat")).toBe("/admin/apps/chat/settings");
        expect(builtInSettingsHref("notes")).toBeNull();
    });
});
