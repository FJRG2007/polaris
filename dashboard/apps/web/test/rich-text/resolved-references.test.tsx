/**
 * A reference in written text, once somebody has resolved what it points at.
 *
 * Three behaviours, and each of them is what somebody reading actually sees.
 *
 * **The name is the current one.** A chip draws the label frozen into the link
 * when it was pasted, which is right for something that does not move and wrong
 * for a conversation somebody renamed in April. The resolution wins.
 *
 * **Out of reach is named nowhere.** The whole point of withholding a room from
 * somebody who is not in it is not saying what it is called, so the chip says
 * that there is something there and nothing else.
 *
 * **A reference drawn in full underneath comes out of the sentence** - and the
 * line it was alone on goes with it. A message that was nothing but an address
 * has to render as the card alone, not as a blank line above one.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText, type ResolvedReference } from "@/components/rich-text/rich-text";

const CHANNEL = "0193aaaa-1111-4222-8333-444444444444";
const MESSAGE = "0193bbbb-5555-4666-8777-888888888888";
const HERE = "https://polaris.example";

function render(
    markdown: string,
    references?: ReadonlyMap<string, ResolvedReference>,
    origin: string | null = null
): string {
    return renderToStaticMarkup(
        <RichText value={markdown} references={references} origin={origin} />
    );
}

describe("what a chip says", () => {
    it("says what it is called now, not what it was called when it was pasted", () => {
        const out = render(
            `see [#old-name](polaris:channel/${CHANNEL})`,
            new Map([[`channel/${CHANNEL}`, { reachable: true, label: "general" }]])
        );
        expect(out).toContain("#general");
        expect(out).not.toContain("old-name");
    });

    it("keeps the written label when nobody resolved it", () => {
        const out = render(`see [#general](polaris:channel/${CHANNEL})`);
        expect(out).toContain("#general");
    });
});

describe("something the reader may not see", () => {
    it("is drawn, and named nowhere", () => {
        const out = render(
            `see [#payroll](polaris:channel/${CHANNEL})`,
            new Map([[`channel/${CHANNEL}`, { reachable: false, label: "payroll" }]])
        );
        expect(out).toContain("Unavailable");
        // The one thing that must not survive.
        expect(out).not.toContain("payroll");
    });

    it("is not a link, since it would go somewhere that refuses them", () => {
        const out = render(
            `see [#payroll](polaris:channel/${CHANNEL})`,
            new Map([[`channel/${CHANNEL}`, { reachable: false, label: "payroll" }]])
        );
        expect(out).not.toContain(`/chat/c/${CHANNEL}`);
    });
});

describe("something drawn in full underneath", () => {
    const quoted = new Map<string, ResolvedReference>([
        [`message/${MESSAGE}`, { reachable: true, label: "Message in General", hidden: true }]
    ]);

    it("comes out of the sentence", () => {
        const out = render(`look at this [Message](polaris:message/${MESSAGE}) please`, quoted);
        expect(out).toContain("look at this");
        expect(out).toContain("please");
        expect(out).not.toContain("Message in General");
    });

    it("takes the line with it when it was the whole of it", () => {
        // A message that was nothing but an address renders as the card alone,
        // rather than as a blank line sitting above one.
        expect(render(`[Message](polaris:message/${MESSAGE})`, quoted)).toBe("");
    });

    it("does the same for an address somebody simply pasted", () => {
        expect(render(`${HERE}/chat/c/${CHANNEL}/${MESSAGE}`, quoted, HERE)).toBe("");
    });
});

describe("an address written in full", () => {
    it("is read as the thing it points at once the deployment is known", () => {
        const out = render(
            `${HERE}/chat/c/${CHANNEL}`,
            new Map([[`channel/${CHANNEL}`, { reachable: true, label: "general" }]]),
            HERE
        );
        expect(out).toContain("#general");
        expect(out).not.toContain("polaris.example");
    });

    it("stays a link when it belongs to somebody else", () => {
        const out = render(`https://elsewhere.example/chat/c/${CHANNEL}`, undefined, HERE);
        expect(out).toContain("elsewhere.example");
    });
});
