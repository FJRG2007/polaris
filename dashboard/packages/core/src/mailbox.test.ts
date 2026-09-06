/**
 * The parts of a mail client that can be wrong without anybody noticing for
 * weeks.
 *
 * Threading is first because it is what a mail client is judged on: a reply that
 * lands outside its conversation reads as a lost message. The subject fallback
 * is tested in both directions - it has to catch a mailing list that rewrites
 * headers, and it must not join two invoices from different companies six months
 * apart.
 *
 * The tracker scan is tested on the shapes senders actually use rather than on a
 * tidy `<img src>`: a background in a style attribute and a one-pixel image from
 * a host nobody has heard of are how a pixel is hidden from a client that only
 * looks at image tags.
 */

import { describe, expect, it } from "vitest";
import * as mailbox from "./mailbox.js";
import type { MailEnvelope, MailRule, MailRuleSubject } from "./mailbox.js";

function envelope(over: Partial<MailEnvelope> = {}): MailEnvelope {
    return {
        messageId: "a@example.com",
        inReplyTo: "",
        references: [],
        subject: "Quarterly report",
        from: [{ name: "Ada", address: "ada@example.com" }],
        to: [{ name: "Bob", address: "bob@example.com" }],
        cc: [],
        listId: "",
        sentAt: new Date("2026-05-01T10:00:00Z"),
        ...over
    };
}

describe("subjects", () => {
    it("strips every reply prefix, in any language, however many are stacked", () => {
        expect(mailbox.normalizeSubject("Re: AW: Re: Fwd: Quarterly report")).toBe("quarterly report");
        expect(mailbox.normalizeSubject("SV: Rapport")).toBe("rapport");
        expect(mailbox.normalizeSubject("RE[2]: Invoice")).toBe("invoice");
    });

    it("leaves a subject that only looks like a prefix alone", () => {
        // "Register" starts with "re" and is not a reply. The colon is what makes
        // a prefix a prefix.
        expect(mailbox.normalizeSubject("Register for the summit")).toBe("register for the summit");
    });

    it("does not stack prefixes on a reply to a reply", () => {
        expect(mailbox.replySubject("Re: Quarterly report")).toBe("Re: Quarterly report");
        expect(mailbox.forwardSubject("Fwd: Quarterly report")).toBe("Fwd: Quarterly report");
        expect(mailbox.replySubject("")).toBe("Re:");
    });
});

describe("threading", () => {
    it("collects every id a message claims, with the brackets off", () => {
        const ids = mailbox.conversationIds(
            envelope({ messageId: "<c@x>", inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"] })
        );
        expect([...ids]).toEqual(["a@x", "b@x", "c@x"]);
    });

    it("joins a conversation by an id it names", () => {
        const found = mailbox.threadFor(envelope({ messageId: "b@x", inReplyTo: "a@x" }), [
            { id: "t1", messageIds: ["a@x"], subjectKey: null, lastMessageAt: new Date("2026-05-01T09:00:00Z") }
        ]);
        expect(found?.id).toBe("t1");
    });

    it("falls back to the subject inside the window", () => {
        const found = mailbox.threadFor(envelope(), [
            {
                id: "t2",
                messageIds: ["zzz@x"],
                subjectKey: "subject:quarterly report",
                lastMessageAt: new Date("2026-04-20T09:00:00Z")
            }
        ]);
        expect(found?.id).toBe("t2");
    });

    it("does not join two messages that only share a subject months apart", () => {
        const found = mailbox.threadFor(envelope({ subject: "Invoice" }), [
            {
                id: "t3",
                messageIds: [],
                subjectKey: "subject:invoice",
                lastMessageAt: new Date("2025-11-01T09:00:00Z")
            }
        ]);
        expect(found).toBeNull();
    });

    it("keeps two mailing lists with the same subject apart", () => {
        expect(mailbox.subjectThreadKey(envelope({ listId: "<dev.example.com>" }))).toBe(
            "list:<dev.example.com> quarterly report"
        );
        expect(mailbox.subjectThreadKey(envelope())).toBe("subject:quarterly report");
    });

    it("gives an empty subject no key at all, rather than one everything matches", () => {
        expect(mailbox.subjectThreadKey(envelope({ subject: "  " }))).toBeNull();
    });
});

describe("addresses", () => {
    it("quotes a name that would otherwise split the header", () => {
        expect(mailbox.formatAddress({ name: "Doe, Jane", address: "j@x.com" })).toBe('"Doe, Jane" <j@x.com>');
        expect(mailbox.formatAddress({ name: "Jane", address: "j@x.com" })).toBe("Jane <j@x.com>");
        expect(mailbox.formatAddress({ name: "", address: "j@x.com" })).toBe("j@x.com");
    });

    it("keeps the copy that carries a name when the same address appears twice", () => {
        const merged = mailbox.dedupeAddresses([
            { name: "", address: "a@x.com" },
            { name: "Ada", address: "A@X.com" }
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.name).toBe("Ada");
        expect(merged[0]?.address).toBe("a@x.com");
    });

    it("replies to the sender, and to everybody but you on reply-all", () => {
        const message = {
            ...envelope({
                from: [{ name: "Ada", address: "ada@x.com" }],
                to: [
                    { name: "Me", address: "me@x.com" },
                    { name: "Cal", address: "cal@x.com" }
                ],
                cc: [{ name: "Dee", address: "dee@x.com" }]
            }),
            replyTo: []
        };
        const one = mailbox.replyRecipients(message, ["me@x.com"], false);
        expect(one.to.map((entry) => entry.address)).toEqual(["ada@x.com"]);
        expect(one.cc).toHaveLength(0);

        const all = mailbox.replyRecipients(message, ["me@x.com"], true);
        expect(all.to.map((entry) => entry.address)).toEqual(["ada@x.com"]);
        expect(all.cc.map((entry) => entry.address)).toEqual(["cal@x.com", "dee@x.com"]);
    });

    it("honours Reply-To, which is what a mailing list depends on", () => {
        const message = {
            ...envelope({ from: [{ name: "", address: "noreply@x.com" }] }),
            replyTo: [{ name: "List", address: "list@x.com" }]
        };
        expect(mailbox.replyRecipients(message, ["me@x.com"], false).to[0]?.address).toBe("list@x.com");
    });
});

describe("what the list shows", () => {
    it("drops the quoted history out of a snippet", () => {
        expect(mailbox.snippetFrom("Thanks, that works.\n> On Monday you wrote:\n> the old thing")).toBe(
            "Thanks, that works."
        );
    });

    it("cuts a long one rather than returning a paragraph", () => {
        expect(mailbox.snippetFrom("x".repeat(400)).length).toBeLessThanOrEqual(200);
    });
});

describe("folders", () => {
    it("takes the server's flag over the name", () => {
        expect(mailbox.folderRole("Papelera", ["\\Trash"], "/")).toBe("trash");
    });

    it("recognises a role by name where the server flags nothing", () => {
        expect(mailbox.folderRole("Gesendete Objekte", [], "/")).toBe("sent");
        expect(mailbox.folderRole("INBOX/Sent Items", [], "/")).toBe("sent");
        expect(mailbox.folderRole("Projects/2026", [], "/")).toBe("none");
    });

    it("draws INBOX as a word rather than a shout", () => {
        expect(mailbox.folderLabel("INBOX", "/")).toBe("Inbox");
        expect(mailbox.folderLabel("INBOX/Clients/Acme", "/")).toBe("Acme");
    });
});

describe("rules", () => {
    const message: MailRuleSubject = {
        from: [{ name: "Billing", address: "invoices@acme.com" }],
        to: [{ name: "Me", address: "me@x.com" }],
        cc: [],
        subject: "Invoice 4021",
        text: "Your invoice is attached.",
        listId: "",
        hasAttachments: true,
        size: 40_000
    };

    it("matches on a field, whatever case either side was written in", () => {
        expect(mailbox.mailConditionHolds({ field: "from", operator: "contains", value: "INVOICES@" }, message)).toBe(true);
        expect(mailbox.mailConditionHolds({ field: "subject", operator: "starts-with", value: "invoice" }, message)).toBe(true);
        expect(mailbox.mailConditionHolds({ field: "size", operator: "greater-than", value: "1000" }, message)).toBe(true);
    });

    it("treats a broken pattern as no match rather than throwing", () => {
        // A rule that never fires is a bad rule; a rule that throws stops every
        // other rule filing anything.
        expect(mailbox.mailConditionHolds({ field: "subject", operator: "matches", value: "([" }, message)).toBe(false);
    });

    it("collects the actions of every matching rule, and stops where told", () => {
        const rules: MailRule[] = [
            {
                id: "1",
                name: "Invoices",
                enabled: true,
                match: "all",
                conditions: [{ field: "from", operator: "contains", value: "invoices@" }],
                actions: [{ kind: "star" }],
                stop: true
            },
            {
                id: "2",
                name: "Everything else",
                enabled: true,
                match: "any",
                conditions: [{ field: "subject", operator: "contains", value: "invoice" }],
                actions: [{ kind: "trash" }],
                stop: false
            }
        ];
        expect(mailbox.mailActionsFor(rules, message)).toEqual([{ kind: "star" }]);
    });

    it("ignores a rule that is switched off, and one with nothing to match on", () => {
        const off: MailRule = {
            id: "1",
            name: "Off",
            enabled: false,
            match: "all",
            conditions: [{ field: "from", operator: "contains", value: "invoices@" }],
            actions: [{ kind: "trash" }],
            stop: false
        };
        expect(mailbox.mailActionsFor([off], message)).toEqual([]);
        expect(mailbox.mailActionsFor([{ ...off, enabled: true, conditions: [] }], message)).toEqual([]);
    });
});

describe("privacy", () => {
    it("finds what a message would fetch, in an attribute or in a style", () => {
        const html = `
            <img src="https://track.example/pixel.gif" width="1" height="1">
            <div style="background:url('https://cdn.mailchimp.com/logo.png')"></div>
            <img src="cid:embedded">
        `;
        const found = mailbox.remoteResourcesIn(html);
        expect(found.map((one) => one.url)).toEqual([
            "https://track.example/pixel.gif",
            "https://cdn.mailchimp.com/logo.png"
        ]);
    });

    it("names the company behind a tracker, and calls an unnamed pixel a tracker anyway", () => {
        const found = mailbox.trackersIn(mailbox.remoteResourcesIn(`
            <img src="https://list-manage.com/open.gif">
            <img src="https://nobody-has-heard-of.example/x.gif" width="1" height="1">
            <img src="https://cdn.example/hero.jpg" width="600" height="300">
        `));
        expect(found).toHaveLength(2);
        expect(mailbox.trackerVendors(found)).toEqual(["Mailchimp"]);
    });

    it("holds every outside address without throwing it away", () => {
        const held = mailbox.holdRemoteContent('<img src="https://x.example/a.png" srcset="https://x.example/b.png 2x">');
        expect(held).not.toContain(' src="https://');
        expect(held).toContain('data-remote-src="https://x.example/a.png"');
        expect(held).toContain('data-remote-srcset="https://x.example/b.png 2x"');
    });

    it("leaves an inline picture alone, which is part of the message rather than a fetch", () => {
        expect(mailbox.holdRemoteContent('<img src="cid:logo">')).toContain('src="cid:logo"');
    });

    it("takes the reader out of a link without moving where it goes", () => {
        expect(mailbox.cleanLink("https://shop.example/item?id=7&utm_source=news&fbclid=abc")).toBe(
            "https://shop.example/item?id=7"
        );
        expect(mailbox.cleanLink("https://shop.example/item?id=7")).toBe("https://shop.example/item?id=7");
        expect(mailbox.cleanLink("mailto:someone@example.com")).toBe("mailto:someone@example.com");
        expect(mailbox.cleanLink("not a url")).toBe("not a url");
    });
});
