import { describe, expect, it } from "vitest";
import { previewRows } from "@/app/(app)/account/app/[category]/voice-widget-preview";

describe("the voice widget preview", () => {
    it("draws up to the chosen number and counts the rest, Off drawing everybody", () => {
        expect(previewRows(6, 8)).toEqual({ shown: 6, more: 0 });
        expect(previewRows(6, 5)).toEqual({ shown: 5, more: 1 });
        expect(previewRows(6, 0)).toEqual({ shown: 6, more: 0 });
        expect(previewRows(0, 5)).toEqual({ shown: 0, more: 0 });
    });
});
