/**
 * What the appearance panel is allowed to save.
 *
 * The interesting rule is that every choice is checked against the catalogue it
 * claims to come from, here, rather than being stored as whatever string
 * arrived. These values end up in a `style` attribute on a page other people
 * read, so an unchecked one is a colour somebody else picked for your name at
 * best and a way into the stylesheet at worst. Refusing anything that is not an
 * id we shipped, and any colour that is not six hex digits, is what makes the
 * rendering side able to interpolate without escaping anything.
 *
 * Null is a real answer everywhere: it is how each of the four is turned off,
 * and it is what almost every account has.
 */

import { z } from "zod";
import {
    AVATAR_DECORATIONS,
    NAMEPLATES,
    NAME_STYLES,
    PROFILE_EFFECTS,
    readAngle,
    readHex
} from "../profile-style.js";

const hexField = z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => readHex(value) !== null, "A colour has to be six hex digits, like #4f8ef7");

/** One of a catalogue's ids, or nothing. Built from the catalogue rather than
 *  written out, so an entry added or withdrawn there is added or withdrawn
 *  here without anybody remembering to. */
function idField(catalogue: readonly { readonly id: string }[], what: string) {
    const ids = catalogue.map((entry) => entry.id);
    return z
        .string()
        .nullable()
        .refine((value) => value === null || ids.includes(value), `That is not a ${what} Polaris has`);
}

export const bannerFillSchema = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("solid"), color: hexField }),
        z.object({
            kind: z.literal("gradient"),
            // Wrapped rather than bounded: a picker that drags past 360 is
            // pointing somewhere real, and refusing the number would refuse the
            // gesture.
            angle: z.number().transform(readAngle),
            from: hexField,
            to: hexField
        })
    ])
    .nullable();

export const profileStyleSchema = z.object({
    banner: bannerFillSchema,
    decoration: idField(AVATAR_DECORATIONS, "decoration"),
    nameplate: idField(NAMEPLATES, "nameplate"),
    effect: idField(PROFILE_EFFECTS, "profile effect"),
    nameStyle: idField(NAME_STYLES, "name style")
});

export type ProfileStyleInput = z.infer<typeof profileStyleSchema>;
