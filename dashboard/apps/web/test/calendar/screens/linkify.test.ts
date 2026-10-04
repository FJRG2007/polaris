/**
 * What an event's text links to: web addresses and email addresses become
 * links, nothing else does, and a location that is a video meeting is known
 * for one. Pure.
 */

import { describe, expect, it } from "vitest";
import { emailHref } from "@polaris-app/calendar/src/screens/contact-links";
import { linkify, meetingLink } from "@polaris-app/calendar/src/screens/editor-model";

function links(text: string) {
    return linkify(text).filter((part) => part.kind !== null);
}

describe("linkify", () => {
    it("links a web address and an email address apart, and keeps the rest as text", () => {
        const parts = linkify(
            "Join https://meet.example.test/abc-defg-hij or write to ana@example.test."
        );
        expect(parts).toEqual([
            { text: "Join ", href: null, kind: null, email: null },
            {
                text: "https://meet.example.test/abc-defg-hij",
                href: "https://meet.example.test/abc-defg-hij",
                kind: "web",
                email: null
            },
            { text: " or write to ", href: null, kind: null, email: null },
            {
                text: "ana@example.test",
                href: "mailto:ana@example.test",
                kind: "email",
                email: "ana@example.test"
            },
            { text: ".", href: null, kind: null, email: null }
        ]);
    });

    it("puts every character back, so the text reads the same", () => {
        const text =
            "Agenda: www.example.test/plan, then mail Bo <bo.ruiz+cal@sub.example.test>; done";
        expect(
            linkify(text)
                .map((part) => part.text)
                .join("")
        ).toBe(text);
    });

    it("reads an address with mailto: in front, and lowercases what is written to", () => {
        expect(links("mailto:Ana.Gil@Example.TEST")).toEqual([
            {
                text: "mailto:Ana.Gil@Example.TEST",
                href: "mailto:ana.gil@example.test",
                kind: "email",
                email: "ana.gil@example.test"
            }
        ]);
    });

    it("keeps an address inside a web link part of the link", () => {
        expect(links("https://example.test/u/ana@example.test/profile")).toEqual([
            {
                text: "https://example.test/u/ana@example.test/profile",
                href: "https://example.test/u/ana@example.test/profile",
                kind: "web",
                email: null
            }
        ]);
    });

    it("gives a bare www. address a secure scheme", () => {
        expect(links("see www.example.test")[0]?.href).toBe("https://www.example.test");
        // Halfway into a word is not an address of its own.
        expect(links("awww.example.test")).toEqual([]);
    });

    it("never links a scheme other than http, https or mailto", () => {
        expect(
            links("javascript:alert(1) data:text/html,hi ftp://example.test file:///etc")
        ).toEqual([]);
    });

    it("drops trailing punctuation from a link", () => {
        expect(links("(see https://example.test/a).")[0]?.href).toBe("https://example.test/a");
    });

    it("does not take a name with no domain for an address", () => {
        expect(links("ana@localhost and @handle")).toEqual([]);
    });
});

describe("meetingLink", () => {
    it("knows a location that is a video meeting", () => {
        expect(meetingLink(" https://meet.google.com/abc-defg-hij ")).toBe(
            "https://meet.google.com/abc-defg-hij"
        );
        expect(meetingLink("https://acme.zoom.us/j/123")).toBe("https://acme.zoom.us/j/123");
    });

    it("leaves a place, a map or a look-alike host alone", () => {
        expect(meetingLink("Room 4, second floor")).toBeNull();
        expect(meetingLink("https://maps.example.test/?q=office")).toBeNull();
        expect(meetingLink("https://meet.google.com.evil.test/x")).toBeNull();
        expect(meetingLink("Meet at https://meet.google.com/abc")).toBeNull();
    });
});

describe("emailHref", () => {
    it("opens a new message in Polaris Mail for somebody with Mail", () => {
        expect(emailHref(["ana@example.test"], true)).toBe(
            "/mail/compose?url=mailto%3Aana%2540example.test"
        );
    });

    it("hands everybody else to the device's mail app", () => {
        expect(emailHref(["ana@example.test", "bo@example.test"], false)).toBe(
            "mailto:ana%40example.test,bo%40example.test"
        );
    });
});
