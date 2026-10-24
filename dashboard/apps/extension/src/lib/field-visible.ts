/**
 * Whether somebody can actually see a box, so a mark is only put on one they can.
 *
 * A size check alone let the Polaris mark float over nothing: a sign-in form kept
 * on the page but faded out (opacity 0) or hidden (visibility hidden), a field
 * scrolled inside a panel past its edge, one pushed off the screen for later, or
 * one sitting under a cookie wall or a modal. Each of those has a box with a
 * size, and each drew a mark the reader could not tie to any field.
 *
 * Checked on every placement, so a field that comes into view gets its mark back.
 */

/** The smallest box worth a mark: anything smaller is a decoy or a hidden
 *  autofill trap, and a mark would cover it whole. */
const MIN_WIDTH = 60;
const MIN_HEIGHT = 16;

/** Where along the field's middle row it is sampled for something on top of it:
 *  more than one point, so a floating label over one end does not hide it. */
const SAMPLES = [0.25, 0.5, 0.75] as const;

export function fieldVisible(
    field: HTMLElement,
    box: DOMRect,
    /** Elements of ours on the page (the marks themselves), never "covering". */
    ours: (node: Node) => boolean = () => false
): boolean {
    if (box.width < MIN_WIDTH || box.height < MIN_HEIGHT) return false;

    const view = field.ownerDocument.defaultView;
    if (!view) return false;

    // CSS hiding the box or a parent of it: display, visibility, content-visibility, opacity.
    if (typeof field.checkVisibility === "function") {
        if (!field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
        for (let node: HTMLElement | null = field; node; node = node.parentElement) {
            const style = view.getComputedStyle(node);
            if (style.display === "none" || Number(style.opacity) === 0) return false;
            if (node === field && style.visibility !== "visible") return false;
        }
    }

    // Off the screen (in the field's own document - a frame's box is its own).
    const visible = clippedBox(field, box, view);
    if (!visible) return false;

    // Under something else: a modal, a cookie wall, a panel drawn on top.
    const root = field.getRootNode() as Document | ShadowRoot;
    if (typeof root.elementFromPoint !== "function") return true;
    const y = visible.top + visible.height / 2;
    return SAMPLES.some((at) => {
        const x = box.left + box.width * at;
        if (x < visible.left || x > visible.right) return false;
        const top = root.elementFromPoint(x, y);
        return !top || reaches(top, field, ours);
    });
}

/** The part of the box left after the viewport and every clipping parent, or
 *  null when nothing worth a mark is left. */
function clippedBox(field: HTMLElement, box: DOMRect, view: Window): DOMRect | null {
    let left = Math.max(box.left, 0);
    let top = Math.max(box.top, 0);
    let right = Math.min(box.right, view.innerWidth);
    let bottom = Math.min(box.bottom, view.innerHeight);
    for (let node = field.parentElement; node; node = node.parentElement) {
        const style = view.getComputedStyle(node);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const clip = node.getBoundingClientRect();
        if (style.overflowX !== "visible") {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
        }
        if (style.overflowY !== "visible") {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
        }
    }
    // Most of the field's height has to show, or the mark sits on its edge.
    if (right - left < MIN_WIDTH / 2 || bottom - top < Math.min(MIN_HEIGHT, box.height * 0.6)) {
        return null;
    }
    return new DOMRect(left, top, right - left, bottom - top);
}

/** Whether what is on top at a point is the field, part of it, its own label,
 *  or something of ours. */
function reaches(top: Element, field: HTMLElement, ours: (node: Node) => boolean): boolean {
    if (top === field || field.contains(top) || ours(top)) return true;
    const labels = (field as HTMLInputElement).labels;
    if (labels && [...labels].some((label) => label === top || label.contains(top))) return true;
    // A design system's wrapper drawn around its own input.
    return top.contains(field);
}
