import { describe, expect, it } from "vitest";
import { DetectionBox } from "./detection-box";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The review-fix commit stopped placing the box against the tile it was
 * dropped into and started placing it against the picture inside that tile -
 * a 4:3 doorbell still in a 16:9 tile is letterboxed, and a box drawn as a
 * percentage of the whole tile lands over the grey bars rather than the
 * person. These pin the two shapes doing that math correctly.
 */
describe("DetectionBox", () => {
    it("renders nothing without a box", () => {
        expect(renderToStaticMarkup(<DetectionBox box={null} />)).toBe("");
    });

    it("fills the whole tile when the picture's shape is not yet known", () => {
        const html = renderToStaticMarkup(
            <DetectionBox box={{ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 }} />
        );
        const outer = /<span aria-hidden="true"[^>]*style="([^"]*)"/.exec(html);
        // No picture/tile supplied: pictureFrame() returns {}, so the style
        // attribute carries neither a width nor a height override and the
        // frame is the full inset the tile already gives it.
        expect(outer?.[1] ?? "").not.toMatch(/width|height/);
    });

    it("letterboxes a 4:3 picture inside a 16:9 tile instead of stretching it", () => {
        const html = renderToStaticMarkup(
            <DetectionBox box={{ x1: 0, y1: 0, x2: 1, y2: 1 }} picture={4 / 3} tile={16 / 9} />
        );
        const outer = /<span aria-hidden="true"[^>]*style="([^"]*)"/.exec(html);
        const style = outer?.[1] ?? "";
        // picture/tile = (4/3)/(16/9) = 0.75 -> the picture only fills 75% of
        // the tile's width and the full height, with bars left over each side.
        expect(style).toContain("width:75%");
        expect(style).toContain("height:100%");
    });

    it("places the box as a percentage of the picture frame, not the tile", () => {
        const html = renderToStaticMarkup(
            <DetectionBox
                box={{ x1: 0.25, y1: 0.1, x2: 0.75, y2: 0.9 }}
                label="Somebody"
                picture={4 / 3}
                tile={16 / 9}
            />
        );
        const inner = /<span class="[^"]*rounded-\[3px\][^"]*"[^>]*style="([^"]*)"/.exec(html);
        const style = inner?.[1] ?? "";
        // The box's own left/top/width/height stay percentages of the picture
        // frame span it is nested in - the letterboxing above is what moves
        // that frame inside the tile, not this.
        expect(style).toContain("left:25%");
        expect(style).toContain("top:10%");
        expect(style).toContain("width:50%");
        expect(style).toContain("height:80%");
        expect(html).toContain("Somebody");
    });
});
