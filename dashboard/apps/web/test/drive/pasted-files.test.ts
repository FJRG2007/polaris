/**
 * Names for what is pasted into the explorer.
 *
 * Browsers hand every copied picture over as `image.png`, so two pastes in a
 * row clashed on the name. Those get a dated one; a file copied in the system's
 * file manager keeps its own.
 */

import { describe, expect, it } from "vitest";
import { pastedItems } from "../../src/app/(app)/drive/pasted-files";

const AT = new Date(2026, 9, 29, 15, 4, 9);

function file(name: string, type = "") {
    return new File(["x"], name, { type });
}

describe("pastedItems", () => {
    it("dates a copied picture, without colons", () => {
        const [item] = pastedItems([file("image.png", "image/png")], "Pasted image", AT);
        expect(item?.relPath).toBe("Pasted image 2026-10-29 15.04.09.png");
    });

    it("keeps the name of a file copied in the file manager", () => {
        const [item] = pastedItems([file("holiday.JPG", "image/jpeg")], "Pasted image", AT);
        expect(item?.relPath).toBe("holiday.JPG");
    });

    it("numbers several unnamed pictures and leaves named ones alone", () => {
        const names = pastedItems(
            [file("image.png"), file("report.pdf"), file("image.jpeg")],
            "Pasted image",
            AT
        ).map((item) => item.relPath);
        expect(names).toEqual([
            "Pasted image 2026-10-29 15.04.09 (1).png",
            "report.pdf",
            "Pasted image 2026-10-29 15.04.09 (2).jpeg"
        ]);
    });

    it("takes the extension from the type when there is no name", () => {
        const [jpeg] = pastedItems([file("", "image/jpeg")], "Pasted image", AT);
        const [odd] = pastedItems([file("", "")], "Pasted image", AT);
        expect(jpeg?.relPath).toBe("Pasted image 2026-10-29 15.04.09.jpg");
        expect(odd?.relPath).toBe("Pasted image 2026-10-29 15.04.09.bin");
    });
});
