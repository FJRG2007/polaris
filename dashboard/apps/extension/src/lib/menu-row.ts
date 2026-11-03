/**
 * One row of the menu the content script drops down under a box.
 *
 * Every row leads with the same square - the initials of a login in its
 * colour, or a glyph for an identity, a new password or the unlock - so the
 * text of every row starts on the same edge and each square sits in the
 * middle of its two lines. A row whose glyph was drawn at its own size and
 * hung from the top of the row read as indented and off-centre next to the
 * others.
 *
 * Apart from the entrypoint so a test can draw it in a DOM of its own.
 */

import { initials, initialsInk, tintFor } from "@polaris/core/faces";

/** What a row leads with. */
export type Face =
    | { readonly kind: "initials"; readonly name: string }
    | { readonly kind: "glyph"; readonly glyph: Glyph };

/** The outline glyphs a row can lead with. */
export type Glyph = "identity" | "key" | "lock";

/** The side of the square, in pixels. */
export const FACE_SIZE = 32;

/** Outline paths on a 24-unit grid, stroked in the text colour. */
const GLYPHS: Readonly<Record<Glyph, readonly string[]>> = {
    identity: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"],
    key: ["M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M10.8 12.2 20 3", "M16 7l3 3"],
    lock: ["M6 11h12v10H6Z", "M8 11V7a4 4 0 0 1 8 0v4"]
};

const SVG = "http://www.w3.org/2000/svg";

/** The square a row leads with. */
export function drawFace(doc: Document, face: Face): HTMLElement {
    const tile = doc.createElement("span");
    tile.setAttribute("aria-hidden", "true");
    tile.dataset.face = face.kind;
    tile.style.cssText = `
        flex: none;
        display: flex;
        align-items: center;
        justify-content: center;
        width: ${FACE_SIZE}px;
        height: ${FACE_SIZE}px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
    `;
    if (face.kind === "initials") {
        const fill = tintFor(face.name);
        tile.style.background = fill;
        tile.style.color = initialsInk(fill);
        tile.textContent = initials(face.name);
        return tile;
    }
    tile.style.background = "hsl(225 12% 16%)";
    tile.style.color = "hsl(220 14% 96%)";
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.display = "block";
    for (const d of GLYPHS[face.glyph]) {
        const path = doc.createElementNS(SVG, "path");
        path.setAttribute("d", d);
        svg.append(path);
    }
    tile.append(svg);
    return tile;
}

/**
 * A row: the square, then the label over the detail. Long text is cut with an
 * ellipsis and kept whole in the row's title, so an email or a street that does
 * not fit is still readable.
 */
export function drawRow(doc: Document, label: string, detail: string, face: Face): HTMLButtonElement {
    const row = doc.createElement("button");
    row.type = "button";
    row.title = [label, detail].filter(Boolean).join("\n");
    row.style.cssText = `
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        padding: 8px 12px;
        cursor: pointer;
    `;
    const text = doc.createElement("span");
    text.style.cssText = "flex:1;min-width:0;";
    const clip = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const name = doc.createElement("span");
    name.textContent = label;
    name.style.cssText = clip;
    text.append(name);
    if (detail !== "") {
        const who = doc.createElement("span");
        who.textContent = detail;
        who.style.cssText = `${clip}font-size:12px;color:hsl(222 10% 66%);`;
        text.append(who);
    }
    row.append(drawFace(doc, face), text);
    return row;
}
