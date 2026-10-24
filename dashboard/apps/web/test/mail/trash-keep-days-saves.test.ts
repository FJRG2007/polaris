/**
 * The trash setting on the mailboxes screen is saved.
 *
 * The screen sends `{ trashKeepDays }` alone, through the patch schema, and the
 * patch schema did not list it - so it was stripped on the way in and the
 * mailbox kept its old value while the screen showed the new one.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";

describe("mailbox patch", () => {
    it("keeps the trash setting the screen sends", () => {
        expect(core.mailAccountPatchSchema.parse({ trashKeepDays: 7 })).toEqual({
            trashKeepDays: 7
        });
        expect(core.mailAccountPatchSchema.parse({ trashKeepDays: 0 })).toEqual({
            trashKeepDays: 0
        });
    });

    it("refuses a value the screen never offers", () => {
        expect(core.mailAccountPatchSchema.safeParse({ trashKeepDays: 400 }).success).toBe(false);
        expect(core.mailAccountPatchSchema.safeParse({ trashKeepDays: 1.5 }).success).toBe(false);
    });

    it("leaves it out when the screen did not send it", () => {
        expect(core.mailAccountPatchSchema.parse({ notify: true })).toEqual({ notify: true });
    });
});
