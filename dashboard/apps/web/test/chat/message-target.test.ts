/**
 * @vitest-environment jsdom
 */

/**
 * What a right-click on a message is actually about.
 *
 * Wrapping the whole message row in a menu takes the browser's own away, and
 * with it every way there was to copy a link somebody wrote or save a picture
 * they sent. The menu has to ask what the pointer was over instead, and each of
 * these rules fails silently if it is wrong: a scheme that should never reach a
 * clipboard, an address handed out on a hostname that only resolves on this
 * network, or a face treated as one of the message's pictures.
 */

import { describe, expect, it } from "vitest";
import { messageTarget, NOTHING } from "@/app/(app)/chat/message-target";

const BASE = "https://polaris.example";

/** A message row with the given markup in it, and the element to right-click. */
function row(html: string): { root: Element; at: (selector: string) => Element } {
    const root = document.createElement("div");
    root.innerHTML = html;
    return {
        root,
        at: (selector) => {
            const found = root.querySelector(selector);
            if (!found) throw new Error(`nothing matching ${selector}`);
            return found;
        }
    };
}

describe("a right-click on nothing in particular", () => {
    it("reports neither a link nor a picture", () => {
        const { root, at } = row("<p><span>Just words</span></p>");
        expect(messageTarget(at("span"), root, BASE)).toEqual(NOTHING);
    });

    it("reports nothing for an element that is not in this message", () => {
        // A portalled dialog, or a target that has already left the document.
        const { root } = row("<p>Words</p>");
        const stray = document.createElement("a");
        stray.setAttribute("href", "https://example.com");
        expect(messageTarget(stray, root, BASE)).toEqual(NOTHING);
    });
});

describe("a link somebody wrote", () => {
    it("copies an outside address as it is", () => {
        const { root, at } = row('<p><a href="https://example.com/a?b=1">read this</a></p>');
        expect(messageTarget(at("a"), root, BASE).link).toEqual({
            copy: "https://example.com/a?b=1",
            open: "https://example.com/a?b=1",
            kind: "web"
        });
    });

    it("is found from the text inside it, which is what the pointer is on", () => {
        const { root, at } = row('<p><a href="https://example.com"><em>read this</em></a></p>');
        expect(messageTarget(at("em"), root, BASE).link?.copy).toBe("https://example.com");
    });

    it("hands out an address inside Polaris on the domain Polaris answers to", () => {
        // The tab may be on the LAN name the installer wrote, which resolves on
        // this network and nowhere else. A copied link is for somebody else.
        const { root, at } = row('<p><a href="/tasks/17">the ticket</a></p>');
        expect(messageTarget(at("a"), root, BASE).link).toEqual({
            copy: "https://polaris.example/tasks/17",
            open: "/tasks/17",
            kind: "inside"
        });
    });

    it("copies an email address without its scheme, which is what gets pasted", () => {
        const { root, at } = row('<p><a href="mailto:ana@example.com">Ana</a></p>');
        expect(messageTarget(at("a"), root, BASE).link).toEqual({
            copy: "ana@example.com",
            open: "mailto:ana@example.com",
            kind: "email"
        });
    });

    it("refuses a scheme that runs as whoever pastes it", () => {
        const { root, at } = row('<p><a href="javascript:alert(1)">looks ordinary</a></p>');
        expect(messageTarget(at("a"), root, BASE).link).toBeNull();
    });

    it("refuses a protocol-relative address, which is a different site", () => {
        const { root, at } = row('<p><a href="//elsewhere.example/x">elsewhere</a></p>');
        expect(messageTarget(at("a"), root, BASE).link).toBeNull();
    });

    it("refuses an address that only Polaris can resolve", () => {
        // A mention is stored as `polaris:user/<id>`. Copying one hands over a
        // string nothing else in the world can open.
        const { root, at } = row('<p><a href="polaris:user/abc">@Ana</a></p>');
        expect(messageTarget(at("a"), root, BASE).link).toBeNull();
    });

    it("refuses a jump to somewhere on this page", () => {
        const { root, at } = row('<p><a href="#top">back up</a></p>');
        expect(messageTarget(at("a"), root, BASE).link).toBeNull();
    });
});

describe("a picture in the message", () => {
    it("takes its name from the alt text, which is the file's own name", () => {
        const { root, at } = row(
            '<img src="/api/chat/attachments/9" alt="the roof.jpg" />'
        );
        expect(messageTarget(at("img"), root, BASE).image).toEqual({
            url: "/api/chat/attachments/9",
            name: "the roof.jpg"
        });
    });

    it("falls back to the last part of the address", () => {
        const { root, at } = row('<img src="https://example.com/pics/cat%20nap.png" alt="" />');
        expect(messageTarget(at("img"), root, BASE).image?.name).toBe("cat nap.png");
    });

    it("falls back again when there is no name to be had", () => {
        const { root, at } = row('<img src="/api/chat/links/4/image" alt="" />');
        expect(messageTarget(at("img"), root, BASE).image?.name).toBe("Image");
    });

    it("is not a face", () => {
        // Pressing a face opens the person's photo, so the picture actions would
        // half fit - which is exactly the kind of item somebody reaches for once
        // and never trusts again.
        const { root, at } = row('<span data-avatar=""><img src="/api/avatar/1" alt="" /></span>');
        expect(messageTarget(at("img"), root, BASE).image).toBeNull();
    });
});

describe("a picture that is also a link", () => {
    it("reports both, because an embed's thumbnail is both", () => {
        const { root, at } = row(
            '<a href="https://example.com/post"><img src="/api/chat/links/4/image" alt="" /></a>'
        );
        const target = messageTarget(at("img"), root, BASE);
        expect(target.link?.copy).toBe("https://example.com/post");
        expect(target.image?.url).toBe("/api/chat/links/4/image");
    });
});
