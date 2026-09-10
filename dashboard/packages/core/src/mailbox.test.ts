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

import * as mailbox from "./mailbox.js";
import { describe, expect, it } from "vitest";
import * as providers from "./mailbox-providers.js";
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

    it("undoes the encoding a message travelled in", () => {
        // Straight out of a real thread. Every one of these was on screen.
        expect(mailbox.snippetFrom("Hola Mar=C3=ADa, =C2=BFqu=C3=A9 tal?")).toBe("Hola María, ¿qué tal?");
        expect(mailbox.snippetFrom("primera=0Asegunda")).toBe("primera segunda");
    });

    it("puts a soft-wrapped paragraph back together", () => {
        // The break is the encoder's, not the author's, so the halves join
        // exactly as they were - the space before it is the author's and stays.
        expect(mailbox.snippetFrom("una linea que sigue =\r\nen la siguiente")).toBe(
            "una linea que sigue en la siguiente"
        );
        // Wrapped mid-word, the word comes back whole rather than split in two.
        expect(mailbox.snippetFrom("inque=\r\nbrantable")).toBe("inquebrantable");
    });

    it("leaves prose that merely contains an equals sign alone", () => {
        // `=50` is the byte for `P`. Decoding this would put "P" in the middle of
        // somebody's sentence, so nothing is decoded without evidence.
        expect(mailbox.snippetFrom("la mesa mide width=50cm de ancho")).toBe(
            "la mesa mide width=50cm de ancho"
        );
    });

    it("reads a message that has no plain half", () => {
        const html = `
            <html><head><style>.a{color:red}</style><title>Ignore me</title></head>
            <body><!-- hidden --><p>Hola&nbsp;Jos&#233;</p><p>Nos vemos &amp; gracias</p>
            <script>alert(1)</script></body></html>
        `;
        expect(mailbox.snippetFrom(html)).toBe("Hola José Nos vemos & gracias");
    });

    it("strips the padding a preheader is stuffed with", () => {
        // Hundreds of these follow the opening line of most marketing mail, for
        // no reason other than to be what a mail client shows instead.
        const padded = `Your order has shipped${"\u200b\u00ad\u200c".repeat(40)}Track it now`;
        expect(mailbox.snippetFrom(padded)).toBe("Your order has shippedTrack it now");
    });

    it("is safe to run twice, which is what repairs an old one", () => {
        const once = mailbox.snippetFrom("Hola Mar=C3=ADa &amp; <b>Jos=C3=A9</b>");
        expect(mailbox.snippetFrom(once)).toBe(once);
        expect(once).toBe("Hola María & José");
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

describe("important, after a sync", () => {
    const flags = (...values: string[]) => new Set(values);

    it("believes a server that says a message is important, always", () => {
        expect(mailbox.importantAfterSync(flags("$Important"), false, false)).toBe(true);
        expect(mailbox.importantAfterSync(flags("$Important"), true, false)).toBe(true);
    });

    it("keeps a mark made here on a folder not known to keep keywords", () => {
        // A read-only open reports no permanent flags and plenty of servers keep
        // none, so the server's silence is not an answer yet.
        expect(mailbox.importantAfterSync(flags("\\Seen"), false, true)).toBe(true);
    });

    it("clears it once the folder is known to keep keywords and it has none", () => {
        // Unmarked on a phone: the folder keeps keywords, so silence is a no.
        expect(mailbox.importantAfterSync(flags("\\Seen"), true, true)).toBe(false);
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

    /**
     * The numbering is a promise to whatever serves the pictures back.
     *
     * That side turns a number into an address by running this same function
     * over the same markup and taking what it hands out, so these tests are the
     * contract between the two. They are written from the three shapes that
     * broke it when a second function walked the markup on its own: an address
     * the sender used twice, a `srcset`, and a background beside an image.
     */
    function proxied(html: string): { html: string; urls: string[] } {
        const urls: string[] = [];
        const out = mailbox.proxyRemoteContent(html, (index, url) => {
            urls[index] = url;
            return `#${index}`;
        });
        return { html: out, urls };
    }

    it("gives an address the sender used twice its own number each time", () => {
        const { html, urls } = proxied(
            '<img src="https://a.ex/logo.png"><img src="https://b.ex/pixel.gif"><img src="https://a.ex/logo.png">'
        );
        // Three pictures, three numbers. Collapsing the repeat is what made every
        // number after it point one address too early, and the last point at
        // nothing at all.
        expect(html).toBe('<img src="#0"><img src="#1"><img src="#2">');
        expect(urls).toEqual([
            "https://a.ex/logo.png",
            "https://b.ex/pixel.gif",
            "https://a.ex/logo.png"
        ]);
    });

    it("numbers a srcset, and hands over the candidate it kept", () => {
        const { html, urls } = proxied('<img src="https://a.ex/1.png" srcset="https://a.ex/2.png 2x, https://a.ex/3.png 3x">');
        expect(html).toBe('<img src="#0" srcset="#1">');
        expect(urls).toEqual(["https://a.ex/1.png", "https://a.ex/2.png"]);
    });

    it("leaves a srcset with nothing outside in it unnumbered", () => {
        // Numbering it would move every address after it by one.
        const { html, urls } = proxied('<img srcset="cid:logo 2x"><img src="https://a.ex/1.png">');
        expect(html).toBe('<img srcset="cid:logo 2x"><img src="#0">');
        expect(urls).toEqual(["https://a.ex/1.png"]);
    });

    it("reads a background attribute where it actually sits", () => {
        const { html, urls } = proxied('<td background="https://bg.ex/b.png"><img src="https://a.ex/1.png"></td>');
        expect(html).toBe('<td background="#0"><img src="#1"></td>');
        expect(urls).toEqual(["https://bg.ex/b.png", "https://a.ex/1.png"]);
    });

    it("catches an address nobody put quotes around", () => {
        const { html, urls } = proxied("<img src=https://a.ex/1.png width=10>");
        expect(html).toBe('<img src="#0" width=10>');
        expect(urls).toEqual(["https://a.ex/1.png"]);
    });

    it("resolves a number back to the address it stood for", () => {
        // Exactly what the route does: rewrite once to draw the message, walk
        // again to answer one picture. The two must agree on every index.
        const html = `
            <img src="https://a.ex/logo.png">
            <td background="https://bg.ex/b.png" style="background:url('https://a.ex/tile.png')"></td>
            <img src="https://a.ex/logo.png" srcset="https://a.ex/logo@2x.png 2x">
            <video poster="https://a.ex/still.jpg"></video>
        `;
        const { urls } = proxied(html);
        expect(urls.length).toBeGreaterThan(4);
        for (const [index, url] of urls.entries()) {
            let found = "";
            mailbox.proxyRemoteContent(html, (position, at) => {
                if (position === index) found = at;
                return "";
            });
            expect(found, `index ${index}`).toBe(url);
        }
    });

    it("leaves a message with nothing to fetch untouched", () => {
        const { html, urls } = proxied('<img src="cid:logo"><a href="https://a.ex/page">read</a>');
        expect(html).toBe('<img src="cid:logo"><a href="https://a.ex/page">read</a>');
        expect(urls).toEqual([]);
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

describe("working out where a domain's mail lives", () => {
    it("recognises a company on a hosting provider by its exchangers, region and all", () => {
        // The real records for a domain this was built against: nothing else
        // about it says where its mail is, so this is the only thing that can
        // answer.
        expect(providers.serviceForExchangers(["mx00.ionos.es", "mx01.ionos.es"])?.slug).toBe("ionos-es");
        expect(providers.serviceForExchangers(["mx00.kundenserver.de"])?.slug).toBe("ionos-de");
        expect(providers.serviceForExchangers(["mx01.perfora.net"])?.slug).toBe("ionos");
        expect(providers.serviceForExchangers(["aspmx.l.google.com"])?.slug).toBe("google-workspace");
        expect(providers.serviceForExchangers(["acme-com.mail.protection.outlook.com"])?.slug).toBe("office365");
    });

    it("matches on a label boundary, so a domain that merely ends in one is not it", () => {
        expect(providers.serviceForExchangers(["mx.notionos.es"])).toBeNull();
        expect(providers.serviceForExchangers(["mail.example.com"])).toBeNull();
        expect(providers.serviceForExchangers([])).toBeNull();
    });

    it("takes the trailing dot a resolver leaves on a name", () => {
        expect(providers.serviceForExchangers(["mx00.ionos.es."])?.slug).toBe("ionos-es");
    });

    it("knows a consumer address by its domain without asking anything", () => {
        expect(providers.serviceForAddress("someone@gmail.com")?.slug).toBe("gmail");
        expect(providers.serviceForAddress("SOMEONE@Hotmail.com")?.slug).toBe("outlook");
        expect(providers.serviceForAddress("someone@tpeoficial.com")).toBeNull();
    });
});

describe("a plain-text message, drawn", () => {
    it("makes a bare address a link, without swallowing the punctuation after it", () => {
        const out = mailbox.textToHtml("See https://example.com/a, then www.example.org.");
        expect(out).toContain('<a href="https://example.com/a">https://example.com/a</a>,');
        expect(out).toContain('<a href="https://www.example.org">www.example.org</a>.');
    });

    it("links an address somebody can write to", () => {
        expect(mailbox.textToHtml("ask ada@example.com")).toContain(
            '<a href="mailto:ada@example.com">ada@example.com</a>'
        );
    });

    it("escapes before it links, so a message cannot write its own anchor", () => {
        const out = mailbox.textToHtml('<a href="https://evil.example">click</a>');
        expect(out).not.toContain("<a href=\"https://evil.example\">click</a>");
        expect(out).toContain("&lt;a href=");
    });

    it("escapes the characters that would end the document", () => {
        const out = mailbox.textToHtml('<script>alert(1)</script> & "quoted"');
        expect(out).not.toContain("<script>");
        expect(out).toContain("&lt;script&gt;");
        expect(out).toContain("&amp;");
        expect(out).toContain("&quot;");
    });

    it("keeps the quoted history, dimmed rather than dropped", () => {
        expect(mailbox.textToHtml("Thanks.\n> the old message")).toContain('<span class="quoted">');
    });
});
