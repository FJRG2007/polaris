/**
 * What an app's settings do to its services: administrators only, by the same
 * check the settings page makes, and nothing for an id that is not well formed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    admin: true,
    restarted: [] as string[],
    read: [] as string[]
}));

vi.mock("@/lib/session", () => ({
    requireAdmin: async () => {
        if (!state.admin) throw new Error("NEXT_REDIRECT");
        return { id: "admin-1", isAdmin: true };
    }
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/activity/activity", () => ({ record: async () => undefined }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: async () => undefined }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/apps/app-services", () => ({
    restartAppService: async (_app: string, id: string) => {
        state.restarted.push(id);
        return true;
    },
    readAppServiceLog: async (_app: string, id: string) => {
        state.read.push(id);
        return "line\n";
    }
}));

const actions = await import("@/app/(app)/admin/apps/[appId]/settings/service-actions");
const ID = "0198f4c1-2b7a-7000-8000-000000000001";

beforeEach(() => {
    state.admin = true;
    state.restarted = [];
    state.read = [];
});

describe("an app's service actions", () => {
    it("restart and read for an administrator", async () => {
        expect(await actions.restartAppServiceAction("vpn", ID)).toEqual({});
        expect(await actions.readAppServiceLogAction("vpn", ID)).toEqual({ log: "line\n" });
        expect(state.restarted).toEqual([ID]);
        expect(state.read).toEqual([ID]);
    });

    it("do nothing for anybody else", async () => {
        state.admin = false;
        await expect(actions.restartAppServiceAction("vpn", ID)).rejects.toThrow();
        await expect(actions.readAppServiceLogAction("vpn", ID)).rejects.toThrow();
        expect(state.restarted).toEqual([]);
        expect(state.read).toEqual([]);
    });

    it("refuse an id that is not one", async () => {
        expect(await actions.restartAppServiceAction("vpn", "../etc")).toEqual({
            error: "services.notFound"
        });
        expect(await actions.readAppServiceLogAction("", ID)).toEqual({ error: "services.notFound" });
        expect(state.restarted).toEqual([]);
        expect(state.read).toEqual([]);
    });
});
