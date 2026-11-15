import { describe, expect, it } from "vitest";
import {
    findStartChat,
    hashLinkToken,
    newLinkToken,
    telegramStartLink
} from "@/lib/messaging/telegram-link-token";

describe("Telegram link token", () => {
    it("fits Telegram's start parameter: A-Z a-z 0-9 _ -, at most 64 characters", () => {
        for (let i = 0; i < 50; i++) {
            const token = newLinkToken();
            expect(token).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        }
        expect(newLinkToken()).not.toBe(newLinkToken());
    });

    it("stores a hash, never the token", () => {
        const token = newLinkToken();
        expect(hashLinkToken(token)).not.toContain(token);
        expect(hashLinkToken(token)).toBe(hashLinkToken(token));
    });

    it("builds the deep link without the @", () => {
        expect(telegramStartLink("@polaris_bot", "abc_-1")).toBe("https://t.me/polaris_bot?start=abc_-1");
    });

    it("finds the private chat that sent /start <token>", () => {
        const updates = [
            { update_id: 1, message: { text: "/start other", chat: { id: 5, type: "private" } } },
            { update_id: 2, message: { text: "/start tok", chat: { id: 7, type: "group" } } },
            { update_id: 3, message: { text: "/start tok", chat: { id: 9, type: "private", username: "ana" } } }
        ];
        expect(findStartChat(updates, "tok")).toEqual({ chatId: "9", username: "ana" });
        expect(findStartChat(updates, "missing")).toBeNull();
    });
});
