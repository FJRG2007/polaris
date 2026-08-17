/**
 * When a face offers to open the photo behind it.
 *
 * The press is the whole feature and it is also the thing a privacy setting says
 * no to, so the two ways of being wrong are worth pinning down separately: a face
 * that offers nothing where somebody allowed it is a feature that quietly does
 * not work, and a face that offers it where they did not is the setting failing
 * open. The first paint is the interesting case for the second - the answer has
 * not arrived yet, and "not yet" must read as no.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, photoOpens } from "@/components/avatar";

const PHOTO = "/api/avatar/11111111-1111-4111-8111-111111111111";

const allowed = { openable: true, hasPhoto: true, allowed: true, source: PHOTO };

describe("whether a face opens", () => {
    it("opens when the screen asked, there is a photo, and they allow it", () => {
        expect(photoOpens(allowed)).toBe(true);
    });

    it("stays a picture where the screen did not ask", () => {
        // A face inside a row that is already pressable - a member list that
        // opens a conversation, a table row that opens an account. Two things
        // under one press is one of them nobody finds.
        expect(photoOpens({ ...allowed, openable: false })).toBe(false);
    });

    it("offers nothing to open when there is no photo", () => {
        // Initials are not a picture, and the blank pixel served for an account
        // without one is not either.
        expect(photoOpens({ ...allowed, hasPhoto: false })).toBe(false);
        expect(photoOpens({ ...allowed, source: null })).toBe(false);
    });

    it("offers nothing where the person said no", () => {
        expect(photoOpens({ ...allowed, allowed: false })).toBe(false);
    });
});

describe("the first paint", () => {
    it("draws no press before the answer is back", () => {
        // Nothing has been asked yet at this point, and unknown has to read as
        // no: the other way round is a press that opens a photo somebody may
        // have shut, for as long as the answer takes to arrive.
        const markup = renderToStaticMarkup(
            <Avatar openable person={{ id: "11111111-1111-4111-8111-111111111111", name: "Ana" }} />
        );

        expect(markup).not.toContain("<button");
        expect(markup).toContain("AN");
    });
});
