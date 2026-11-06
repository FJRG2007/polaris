/** Chat lock actions: every input is parsed, and nobody without Chat gets in. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ allowed: true, calls: [] as string[] }));

vi.mock("@/lib/session", () => ({
    requirePermission: async () => {
        if (!fake.allowed) throw new Error("forbidden");
        return { id: "ada", name: "Ada" };
    }
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/i18n/request", () => ({
    getLocale: async () => "en-US",
    getTranslations: async () => (key: string) => key
}));
vi.mock("@/lib/chat/chat-lock", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/lib/chat/chat-lock");
    const record =
        (name: string, answer?: unknown) =>
        async (..._args: unknown[]) => {
            fake.calls.push(name);
            return answer;
        };
    return {
        ...actual,
        lockState: record("lockState", {
            hasCode: true,
            hideLocked: false,
            unlockMinutes: -1,
            codeLength: null
        }),
        setLockCode: record("setLockCode"),
        setHideLocked: record("setHideLocked"),
        setChannelLocked: record("setChannelLocked"),
        setChannelHidden: record("setChannelHidden"),
        unlockChannel: record("unlockChannel", "proof"),
        unlockAll: record("unlockAll", { c: "proof" })
    };
});

import * as actions from "@/app/(app)/chat/lock-actions";

const channelId = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
    fake.allowed = true;
    fake.calls = [];
});

describe("lock actions", () => {
    it("refuse input that does not parse, before reaching the service", async () => {
        const refused = [
            await actions.setLockCodeAction({ code: "12" }),
            await actions.setLockCodeAction(null),
            await actions.setHideLockedAction({ hide: "yes" }),
            await actions.setChannelLockedAction({ channelId: "nope", on: true }),
            await actions.setChannelLockedAction({ channelId, on: false, code: "1" }),
            await actions.setChannelHiddenAction({ channelId, on: "true" }),
            await actions.unlockChannelAction({ channelId }),
            await actions.openLockedChatsAction({ code: 1234 })
        ];
        for (const result of refused) expect(result.error).toBeTruthy();
        expect(fake.calls).toEqual([]);
    });

    it("pass parsed input through", async () => {
        expect(await actions.setLockCodeAction({ code: "1234" })).toEqual({});
        expect(await actions.setChannelHiddenAction({ channelId, on: true })).toEqual({});
        expect(await actions.unlockChannelAction({ channelId, code: "1234" })).toEqual({
            proof: "proof"
        });
        expect(await actions.openLockedChatsAction({ code: "1234" })).toEqual({
            proofs: { c: "proof" }
        });
        expect(fake.calls).toEqual([
            "setLockCode",
            "setChannelHidden",
            "unlockChannel",
            "unlockAll"
        ]);
    });

    it("refuse somebody without Chat", async () => {
        fake.allowed = false;
        await expect(actions.lockStateAction()).rejects.toThrow("forbidden");
        await expect(actions.setChannelLockedAction({ channelId, on: true })).rejects.toThrow(
            "forbidden"
        );
        await expect(actions.unlockChannelAction({ channelId, code: "1234" })).rejects.toThrow(
            "forbidden"
        );
        expect(fake.calls).toEqual([]);
    });
});
