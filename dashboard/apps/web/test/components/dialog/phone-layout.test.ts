import { describe, expect, it } from "vitest";
import { phoneLayout } from "@polaris/ui";
import { PHONE_FULL } from "../../../../../packages/ui/src/components/dialog-surface";

describe("phoneLayout", () => {
    it("keeps a small dialog a sheet from the bottom", () => {
        expect(phoneLayout("max-w-md")).toBe("sheet");
        expect(phoneLayout(undefined)).toBe("sheet");
    });

    it("gives a wide dialog the whole screen", () => {
        expect(phoneLayout("max-w-3xl")).toBe("full");
        expect(phoneLayout("sm:max-w-screen-lg")).toBe("full");
        expect(phoneLayout("max-w-[48rem]")).toBe("full");
        expect(phoneLayout("max-w-[30rem]")).toBe("sheet");
    });

    it("leaves a dialog that places itself where it is", () => {
        expect(phoneLayout("left-0 translate-x-0 max-w-sm")).toBe("keep");
    });

    it("takes the layout a caller asks for over the guess", () => {
        expect(phoneLayout("max-w-md", "full")).toBe("full");
        expect(phoneLayout("max-w-5xl", "keep")).toBe("keep");
    });
});

describe("a full-screen dialog on a phone", () => {
    it("wears the page background, not the raised dialog tone", () => {
        expect(PHONE_FULL.split(" ")).toContain("max-sm:bg-background");
    });
});
