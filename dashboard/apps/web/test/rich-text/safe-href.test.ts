/**
 * Which written addresses become links.
 *
 * This is the file to be paranoid in. Everything rendered through RichText was
 * typed by somebody else - a chat message, a task comment, a shared note - and
 * Markdown lets a link carry any scheme it likes. `[click me](javascript:...)`
 * is a script that runs as the reader, in the reader's session, the moment they
 * click something that looks like an ordinary link. React escapes text; it does
 * not check an href.
 *
 * So the rule is an allowlist, and the cases below are the ways an allowlist
 * gets talked around: casing, leading whitespace, control characters inside the
 * scheme, and a protocol-relative path that looks local and is not.
 */

import { describe, expect, it } from "vitest";
import { isSafeHref } from "@/components/rich-text/rich-text";

describe("what may be linked to", () => {
    it("allows the three schemes a written link has a reason to use", () => {
        expect(isSafeHref("https://example.com/thing")).toBe(true);
        expect(isSafeHref("http://192.168.1.10:8080/admin")).toBe(true);
        expect(isSafeHref("mailto:someone@example.com")).toBe(true);
    });

    it("refuses script schemes, however they are written", () => {
        expect(isSafeHref("javascript:alert(1)")).toBe(false);
        expect(isSafeHref("JavaScript:alert(1)")).toBe(false);
        expect(isSafeHref("  javascript:alert(1)")).toBe(false);
        expect(isSafeHref("java\tscript:alert(1)")).toBe(false);
        expect(isSafeHref("java\nscript:alert(1)")).toBe(false);
        expect(isSafeHref("javascript:alert(1)")).toBe(false);
    });

    it("refuses a data URL, which is a page the writer wrote", () => {
        expect(isSafeHref("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBe(false);
        expect(isSafeHref("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
    });

    it("refuses the other schemes that reach something on the machine", () => {
        expect(isSafeHref("file:///etc/passwd")).toBe(false);
        expect(isSafeHref("vbscript:msgbox(1)")).toBe(false);
        expect(isSafeHref("blob:https://example.com/abc")).toBe(false);
    });

    it("refuses a relative address, which the caller handles separately", () => {
        // Anything without a scheme is either an in-Polaris path - decided
        // before this is asked - or not an address at all.
        expect(isSafeHref("/drive")).toBe(false);
        expect(isSafeHref("example.com")).toBe(false);
        expect(isSafeHref("")).toBe(false);
        expect(isSafeHref("   ")).toBe(false);
    });

    it("refuses protocol-relative, which looks local and is not", () => {
        expect(isSafeHref("//evil.example/steal")).toBe(false);
    });
});
