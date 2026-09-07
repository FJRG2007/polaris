/**
 * Which page a message is drawn on.
 *
 * The two failures are opposite and both are ugly. Take a designed newsletter's
 * white page away and its black text lands on a dark screen, which is the single
 * most complained-about thing in any mail client. Give a receipt or a password
 * reset a white page it never asked for and a dark mailbox has a torch in the
 * middle of it - and that is most of the mail anybody gets, because almost every
 * automated message sets a colour on a heading and no background at all.
 *
 * So the test is a background, not a colour. What follows from it is checked
 * here rather than by eye, because the case that matters - a message with a dark
 * grey heading, on a dark page - is invisible in exactly the way a screenshot
 * does not show.
 */

import { describe, expect, it } from "vitest";
import { dressesItself } from "@/app/(app)/mail/message-body";

describe("whether a message brought its own page", () => {
    it("says so for a newsletter that sets a background", () => {
        expect(dressesItself('<table bgcolor="#f6f6f6"><tr><td>Hello</td></tr></table>')).toBe(true);
        expect(dressesItself('<div style="background-color:#fff;padding:20px">Hi</div>')).toBe(true);
        expect(dressesItself('<body style="background:#111 url(x.png)">Hi</body>')).toBe(true);
    });

    it("says no for a message that only colours its own words", () => {
        // The commonest mail there is: a receipt with a grey heading. It was
        // written against whatever page it landed on, and a white card in the
        // middle of a dark mailbox is not what its author had in mind either.
        expect(dressesItself('<p style="color:#333">Your order shipped</p>')).toBe(false);
        expect(dressesItself('<font color="#555">Thanks</font>')).toBe(false);
        expect(dressesItself('<h1 style="color: rgb(20,20,20)">Reset your password</h1>')).toBe(false);
    });

    it("says no for plain text turned into markup", () => {
        expect(dressesItself('<div class="plain">Hello\n\nSee you at six.</div>')).toBe(false);
    });

    it("is not fooled by the word appearing in the text", () => {
        // "background" in a sentence is not a background on an element.
        expect(dressesItself("<p>Some background on the project follows.</p>")).toBe(false);
    });
});
