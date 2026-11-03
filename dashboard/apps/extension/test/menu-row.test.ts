// @vitest-environment jsdom
/**
 * Every row of the menu under a box leads with the same square, centred on its
 * two lines, so an identity row lines up with the logins under it.
 */
import { describe, expect, it } from "vitest";
import { drawRow, FACE_SIZE } from "../src/lib/menu-row";

function faceOf(row: HTMLElement): HTMLElement {
    const face = row.firstElementChild as HTMLElement | null;
    if (!face) throw new Error("no face");
    return face;
}

describe("a menu row", () => {
    const login = drawRow(document, "GitHub", "ada", { kind: "initials", name: "GitHub" });
    const identity = drawRow(document, "Javier Romero González", "Identity", {
        kind: "glyph",
        glyph: "identity"
    });

    it("leads every kind of row with a square of the same size", () => {
        for (const row of [login, identity]) {
            const face = faceOf(row);
            expect(face.style.width).toBe(`${FACE_SIZE}px`);
            expect(face.style.height).toBe(`${FACE_SIZE}px`);
            // `flex: none`, as the DOM spells it out.
            expect(face.style.flex).toBe("0 0 auto");
        }
        expect(FACE_SIZE).toBe(32);
    });

    it("centres the square on the two lines, and its glyph inside it", () => {
        for (const row of [login, identity]) {
            expect(row.style.display).toBe("flex");
            expect(row.style.alignItems).toBe("center");
            expect(faceOf(row).style.alignItems).toBe("center");
            expect(faceOf(row).style.justifyContent).toBe("center");
        }
        expect(login.style.padding).toBe(identity.style.padding);
    });

    it("draws initials for a login and an outline glyph for an identity", () => {
        expect(faceOf(login).textContent).toBe("GI".slice(0, faceOf(login).textContent?.length));
        expect(faceOf(identity).querySelector("svg")).not.toBeNull();
    });

    it("cuts long text with the whole of it in the title", () => {
        const text = identity.lastElementChild as HTMLElement;
        expect(text.style.minWidth).toBe("0px");
        expect(identity.title).toBe("Javier Romero González\nIdentity");
    });

    it("leaves out an empty second line", () => {
        const row = drawRow(document, "Only", "", { kind: "glyph", glyph: "lock" });
        expect((row.lastElementChild as HTMLElement).children).toHaveLength(1);
    });
});
