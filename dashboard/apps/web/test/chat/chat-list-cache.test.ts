import { beforeEach, describe, expect, it, vi } from "vitest";
import { readChatLists, writeChatLists } from "@/app/(app)/chat/chat-list-cache";

const kept = new Map<string, string>();

beforeEach(() => {
    kept.clear();
    vi.stubGlobal("sessionStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value)
    });
});

const lists = { channels: [{ id: "a" }], spaces: [], categories: [] };

describe("the chat rail kept in the tab", () => {
    it("comes back for the same account", () => {
        writeChatLists("me", lists);
        expect(readChatLists("me")).toEqual(lists);
    });

    it("is not shown to another account", () => {
        writeChatLists("me", lists);
        expect(readChatLists("somebody-else")).toBeNull();
    });

    it("is ignored when it is unreadable or the wrong shape", () => {
        kept.set("polaris.chat.lists.v1.me", "{not json");
        expect(readChatLists("me")).toBeNull();
        kept.set("polaris.chat.lists.v1.me", JSON.stringify({ channels: "x" }));
        expect(readChatLists("me")).toBeNull();
    });

    it("costs nothing when storage refuses", () => {
        vi.stubGlobal("sessionStorage", {
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            }
        });
        expect(() => writeChatLists("me", lists)).not.toThrow();
        expect(readChatLists("me")).toBeNull();
    });
});
