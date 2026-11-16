/**
 * The buttons a session's push carries to a phone: Allow, Deny and Always for
 * a permission prompt, each answering it with no tab open; Reply for a
 * question, opening the session with the cursor in its reply box. The Reply
 * address still names the session, so a tab showing it keeps the alert quiet.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn(), pushNotice: vi.fn() }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: async () => (key: string) => key }));

const notices = await import("@/lib/agents/agent-notices");
const subjects = await import("@/lib/notifications/view-subject");

const ID = "5f0c1b8e-3d2a-4c6b-9e7f-0a1b2c3d4e5f";
const words = (key: string) => `t:${key}`;

describe("sessionPushActions", () => {
    it("answers a permission prompt on the notification, Always last", () => {
        const actions = notices.sessionPushActions(ID, words, { requestId: "r1" });
        expect(actions.map((one) => one.action)).toEqual(["allow", "deny", "always"]);
        expect(actions[0]).toEqual({
            action: "allow",
            title: "t:agents.permissionAllow",
            request: { url: "/api/agents/sessions/permission", body: { requestId: "r1", choice: "allow" } }
        });
        expect(actions.every((one) => one.href === undefined)).toBe(true);
    });

    it("gives a question Reply, which opens the session's reply box", () => {
        expect(notices.sessionPushActions(ID, words, null)).toEqual([
            { action: "reply", title: "t:agents.reply", href: `/polar?session=${ID}&reply=1` }
        ]);
    });
});

describe("sessionReplyHref", () => {
    it("names the same session as the notice, for presence", () => {
        const href = subjects.sessionReplyHref(ID);
        expect(subjects.viewSubject(href)).toBe(notices.polarSessionHref(ID));
        expect(new URLSearchParams(href.split("?")[1]).get(subjects.REPLY_PARAM)).toBe("1");
    });
});
