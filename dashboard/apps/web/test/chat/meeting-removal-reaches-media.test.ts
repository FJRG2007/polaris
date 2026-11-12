/**
 * A host showing somebody out of a meeting closes their connection on the
 * media server, not only their seat (VULN-0039): a browser that ignores the
 * roster would otherwise keep hearing and sending. When the media server does
 * not confirm it, the host is told so instead of shown a removal that has not
 * happened yet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const removeFromMeeting = vi.fn(async () => undefined);
const applyToSeat = vi.fn(async () => true);

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "host", name: "Host" }) }));
vi.mock("@polaris/auth", () => ({ can: async () => true }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => key,
    getLocale: async () => "en-US"
}));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/chat/meetings", () => ({ removeFromMeeting }));
vi.mock("@/lib/chat/call-server", () => ({ applyToSeat }));
vi.mock("@/lib/chat/call-moderation", () => ({
    REMOVAL_NOT_ENFORCED: "not confirmed",
    NOT_ENFORCED_YET: "later"
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => undefined }) }));
vi.mock("@/lib/notification-service", () => ({}));
vi.mock("@/lib/chat/chat-service", () => ({}));
vi.mock("@/lib/chat/meeting-link-access", () => ({}));
vi.mock("@/lib/link-denial", () => ({}));
vi.mock("@/lib/backup-access/service", () => ({}));
vi.mock("@/lib/privacy-service", () => ({}));
vi.mock("@/lib/presence-service", () => ({}));
vi.mock("@/lib/chat/declined-calls", () => ({}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));

const { removeFromMeetingAction } = await import("@/app/(app)/chat/meeting-actions");

beforeEach(() => {
    removeFromMeeting.mockClear();
    applyToSeat.mockReset();
    applyToSeat.mockResolvedValue(true);
});

describe("showing somebody out of a meeting", () => {
    it("drops their connection on the media server", async () => {
        expect(await removeFromMeetingAction("m1", "p2")).toEqual({});
        expect(removeFromMeeting).toHaveBeenCalledWith({ id: "host" }, "m1", "p2");
        expect(applyToSeat).toHaveBeenCalledWith("m1", "p2", { kind: "remove" });
    });

    it("says so when the media server did not confirm it", async () => {
        applyToSeat.mockResolvedValue(false);
        expect(await removeFromMeetingAction("m1", "p2")).toEqual({ warning: "not confirmed" });
    });
});
