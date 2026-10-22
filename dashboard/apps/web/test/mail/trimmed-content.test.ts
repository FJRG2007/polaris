// @vitest-environment jsdom

/**
 * The history under a message, folded behind "...".
 *
 * Two promises are pinned here. In the composer, a quote nobody opened is sent
 * as exactly the text it was always sent as, and one somebody opened and edited
 * is sent as edited. In the reader, the copy of the conversation a message
 * quotes is trimmed for the clients that write one - and nothing else is: not a
 * message that is only a quote, not a forward, not an answer written between
 * quoted lines.
 */

import { describe, expect, it } from "vitest";
import { withSignature } from "@/app/(app)/mail/signature";
import { forwardSeed, replySeed, type AnswerableMessage } from "@/app/(app)/mail/answering";
import {
    joinComposerBody,
    trimComposerBody,
    trimReceivedHtml,
    trimReceivedText
} from "@/app/(app)/mail/trimmed-content";

const message: AnswerableMessage = {
    id: "m1",
    accountId: "a1",
    subject: "Plans",
    from: [{ name: "Ann Example", address: "ann@example.test" }],
    to: [{ name: "", address: "me@example.test" }],
    cc: [],
    replyTo: [],
    listId: "",
    sentAt: "2026-10-20T10:00:00.000Z"
};

const QUOTED = "Shall we meet on Friday?\n\nAnn";

function replyBody(): string {
    return replySeed(message, ["me@example.test"], false, QUOTED).body;
}

describe("the composer's trimmed quote", () => {
    it("trims a fresh reply to the empty line above the quote", () => {
        const split = trimComposerBody(replyBody(), false);
        expect(split?.head).toBe("\n\n");
        expect(split?.tail.startsWith("On 2026-10-20 10:00 UTC, Ann Example <ann@example.test> wrote:")).toBe(true);
    });

    it("sends exactly what it always did while the quote stays folded", () => {
        const account = { signature: "Me", signatureAuto: "always", signatureAboveQuote: true };
        const bodies = [
            replyBody(),
            forwardSeed(message, QUOTED).body,
            withSignature({ body: replyBody(), inReplyToId: "m1" }, account, undefined),
            withSignature(
                { body: replyBody(), inReplyToId: "m1" },
                { ...account, signatureAboveQuote: false },
                undefined
            )
        ];
        for (const body of bodies) {
            const split = trimComposerBody(body, false);
            expect(split).not.toBeNull();
            expect(joinComposerBody(split!.head, split!.tail)).toBe(body);
        }
    });

    it("keeps the signature above the quote in front of the writer", () => {
        const body = withSignature(
            { body: replyBody(), inReplyToId: "m1" },
            { signature: "Me", signatureAuto: "always", signatureAboveQuote: true },
            undefined
        );
        expect(trimComposerBody(body, false)?.head).toBe("\n\n-- \nMe\n\n\n");
    });

    it("puts what was typed above the folded quote, a paragraph apart", () => {
        const split = trimComposerBody(replyBody(), false)!;
        // What the editor hands back for a line typed into the empty head.
        const sent = joinComposerBody("Friday works.", split.tail);
        expect(sent).toBe(`Friday works.\n\n${split.tail}`);
    });

    it("trims a forward's block, and a forward with no quote at all", () => {
        const split = trimComposerBody(forwardSeed(message, QUOTED).body, false);
        expect(split?.tail.startsWith("---------- Forwarded message ----------")).toBe(true);
        // What the editor writes back for that line once it has been through it.
        expect(trimComposerBody("FYI\n\n\\---------- Forwarded message ----------\nFrom: x", true)?.head).toBe(
            "FYI\n\n"
        );
    });

    it("folds a reopened draft again while its quote is only the quote", () => {
        const split = trimComposerBody(replyBody(), false)!;
        const saved = joinComposerBody("Friday works.", split.tail);
        const reopened = trimComposerBody(saved, true);
        expect(reopened).toEqual({ head: "Friday works.\n\n", tail: split.tail });
        expect(joinComposerBody(reopened!.head, reopened!.tail)).toBe(saved);
    });

    it("reads the quote back the way the editor writes it", () => {
        const saved =
            "Friday works.\n\nOn 2026-10-20 10:00 UTC, Ann Example [ann@example.test](mailto:ann@example.test) wrote:\n\n> Shall we meet on Friday?\n>\n> Ann";
        expect(trimComposerBody(saved, true)?.head).toBe("Friday works.\n\n");
    });

    it("leaves a draft open once somebody answered between the quoted lines", () => {
        const edited = `${replyBody()}\n\nYes, Friday.\n\n> More quoted`;
        expect(trimComposerBody(edited, true)).toBeNull();
        // Opened, the whole body is the editor's and is sent as it stands.
        expect(joinComposerBody(edited, "")).toBe(edited);
    });

    it("leaves a body alone that only mentions somebody writing", () => {
        expect(trimComposerBody("On Monday she wrote:\nnothing quoted here", false)).toBeNull();
        expect(trimComposerBody("Just a message", false)).toBeNull();
    });
});

describe("the reader's trimmed history", () => {
    it("trims Gmail's quote", () => {
        const html =
            '<div dir="ltr">Thanks, see you then!</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, Oct 20, 2026 at 10:00 AM Ann &lt;ann@example.test&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex">Shall we meet?</blockquote></div>';
        const trimmed = trimReceivedHtml(html);
        expect(trimmed).toContain("Thanks, see you then!");
        expect(trimmed).not.toContain("Shall we meet?");
        expect(trimmed).not.toContain("wrote:");
    });

    it("trims Outlook on the web's divider and everything under it", () => {
        const html =
            '<div>See below.</div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Ann<br><b>Sent:</b> Monday<br><b>To:</b> Me<br><b>Subject:</b> Plans</div><div>Shall we meet?</div>';
        const trimmed = trimReceivedHtml(html);
        expect(trimmed).toContain("See below.");
        expect(trimmed).not.toContain("Shall we meet?");
        expect(trimmed).not.toContain("<hr");
    });

    it("trims Outlook desktop's header block", () => {
        const html =
            '<div class="WordSection1"><p class="MsoNormal">Done.</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Ann<br><b>Sent:</b> Monday<br><b>Subject:</b> RE: Plans</p></div></div><p class="MsoNormal">Shall we meet?</p></div>';
        const trimmed = trimReceivedHtml(html);
        expect(trimmed).toContain("Done.");
        expect(trimmed).not.toContain("Shall we meet?");
    });

    it("trims Apple Mail's cited block with its attribution", () => {
        const html =
            '<div>Sounds good.</div><div><br><blockquote type="cite"><div>On 20 Oct 2026, at 10:00, Ann &lt;ann@example.test&gt; wrote:</div><br><div>Shall we meet?</div></blockquote></div>';
        const trimmed = trimReceivedHtml(html);
        expect(trimmed).toContain("Sounds good.");
        expect(trimmed).not.toContain("Shall we meet?");
    });

    it("trims Thunderbird's attribution line with the quote under it", () => {
        const html =
            '<p>Agreed.</p><div class="moz-cite-prefix">On 20/10/2026 10:00, Ann wrote:<br></div><blockquote type="cite">Shall we meet?</blockquote>';
        const trimmed = trimReceivedHtml(html);
        expect(trimmed).toContain("Agreed.");
        expect(trimmed).not.toContain("Ann wrote:");
    });

    it("never trims a message down to nothing", () => {
        const html =
            '<div class="gmail_quote"><div class="gmail_attr">On Mon, Ann wrote:</div><blockquote class="gmail_quote">Only the quote</blockquote></div>';
        expect(trimReceivedHtml(html)).toBeNull();
        expect(trimReceivedText("On Mon, Ann wrote:\n> Only the quote")).toBeNull();
    });

    it("never trims a forward, where the history is the message", () => {
        const html =
            '<div>FYI</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Ann</div><div>The report</div></div>';
        expect(trimReceivedHtml(html)).toBeNull();
        expect(trimReceivedText("FYI\n\n---------- Forwarded message ---------\nOn Mon, Ann wrote:\n> x")).toBeNull();
        expect(
            trimReceivedText("FYI\n\nFrom: Ann\nSent: Monday\nTo: Me\nSubject: FW: The report\n\nThe report")
        ).toBeNull();
    });

    it("keeps answers written between quoted lines, trimming only the end", () => {
        const html =
            '<div>Answers inline.</div><blockquote type="cite">First question?</blockquote><div>Yes.</div><blockquote type="cite">Second question?</blockquote>';
        const trimmed = trimReceivedHtml(html);
        expect(trimmed).toContain("First question?");
        expect(trimmed).toContain("Yes.");
        expect(trimmed).not.toContain("Second question?");
    });

    it("trims a plain-text reply's quote and its attribution", () => {
        const text = "Friday works.\n\nOn Mon, 20 Oct 2026 at 10:00, Ann <ann@example.test> wrote:\n> Shall we meet?\n>\n> Ann\n";
        expect(trimReceivedText(text)).toBe("Friday works.");
    });

    it("takes an attribution the sender's client wrapped over two lines", () => {
        const text = "Friday works.\n\nOn Mon, 20 Oct 2026 at 10:00, Ann Example <ann@example.test>\nwrote:\n\n> Shall we meet?";
        expect(trimReceivedText(text)).toBe("Friday works.");
    });

    it("trims Outlook's plain-text dividers", () => {
        expect(trimReceivedText("Done.\n\n-----Original Message-----\nFrom: Ann\nShall we?")).toBe("Done.");
        expect(
            trimReceivedText("Done.\n\n________________________________\nFrom: Ann\nSent: Monday\nTo: Me\nSubject: Plans\n\nShall we?")
        ).toBe("Done.");
    });

    it("leaves plain text alone that only looks like a header or a quote", () => {
        expect(trimReceivedText("Trip\nFrom: Madrid\nDate: Monday\nSeat 4A")).toBeNull();
        expect(trimReceivedText("Point by point:\n> first\nyes\n> second\nno")).toBeNull();
        expect(trimReceivedText("Nothing quoted here.")).toBeNull();
        expect(trimReceivedText("")).toBeNull();
    });

    it("leaves a message with no history untouched", () => {
        expect(trimReceivedHtml("<p>Hello there</p>")).toBeNull();
        expect(trimReceivedHtml("")).toBeNull();
    });
});
