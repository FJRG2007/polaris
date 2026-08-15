/**
 * The addresses a conversation and a message have.
 *
 * Short, and the point of it is the shape: a message link is the conversation's
 * own link with the message on the end, so a route that serves one serves the
 * other and there is no second way to name a conversation. The other thing worth
 * pinning is that both are built on the address Polaris hands out rather than on
 * the tab's hostname - the tab's may be the LAN name the installer wrote, which
 * resolves on that network and nowhere else, and a link nobody else can open is
 * the whole failure this avoids.
 */

import { describe, expect, it } from "vitest";
import { channelLink, messageLink } from "../../src/app/(app)/chat/links";

const base = "https://polaris.example.com";
const channel = "0193b0f0-0000-7000-8000-000000000001";
const message = "0193b0f0-0000-7000-8000-000000000002";

describe("a conversation", () => {
    it("is the same address whether it is a channel, a group or one person", () => {
        // They are one kind of row with one id, so there is one route.
        expect(channelLink(base, channel)).toBe(`${base}/chat/c/${channel}`);
    });

    it("is built on the address it is given rather than on any current origin", () => {
        expect(channelLink("https://box.local", channel)).toBe(
            `https://box.local/chat/c/${channel}`
        );
    });
});

describe("a message", () => {
    it("is its conversation, then the message", () => {
        expect(messageLink(base, channel, message)).toBe(
            `${base}/chat/c/${channel}/${message}`
        );
    });

    it("extends the conversation's own link rather than inventing a route", () => {
        expect(
            messageLink(base, channel, message).startsWith(`${channelLink(base, channel)}/`)
        ).toBe(true);
    });
});
