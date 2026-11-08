/**
 * The phone controller's controls as a frame in the W3C standard gamepad
 * layout (axes: left x, left y, right x, right y; 17 buttons), kept apart from
 * the screen so the arithmetic can be tested on its own.
 */

export interface PadControls {
    /** The on-screen stick, each axis -1..1 (y down is positive, as on a pad). */
    stick: { x: number; y: number };
    /** Steering from tilting the phone, -1..1, or null when tilt is off. */
    tilt: number | null;
    /** Each button 0..1, by its standard index. */
    buttons: number[];
}

/** Degrees of roll that steer fully: enough to hold steady, little enough to reach. */
export const TILT_FULL_DEGREES = 30;

function clamp(value: number, min = -1, max = 1): number {
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : 0;
}

/** The stick's axes for a touch `dx, dy` pixels from its centre, on a stick of `radius` pixels. */
export function stickAxes(dx: number, dy: number, radius: number): { x: number; y: number } {
    if (!(radius > 0)) return { x: 0, y: 0 };
    const length = Math.hypot(dx, dy);
    const scale = length > radius ? radius / length : 1;
    return { x: clamp((dx * scale) / radius), y: clamp((dy * scale) / radius) };
}

/** Below this much of the stick's travel a thumb resting on it is not a push. */
export const STICK_DEAD_ZONE = 0.12;

/**
 * The stick past its dead zone, rescaled so the edge of the dead zone is 0 and
 * the rim is still 1: no creeping from a resting thumb, and no jump past it.
 */
export function stickDeadZone(stick: { x: number; y: number }): { x: number; y: number } {
    const length = Math.hypot(stick.x, stick.y);
    if (length <= STICK_DEAD_ZONE) return { x: 0, y: 0 };
    const scale = Math.min(1, (length - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE)) / length;
    return { x: clamp(stick.x * scale), y: clamp(stick.y * scale) };
}

/**
 * Steering from the phone's orientation: its roll across the way it is held.
 * Upright (`angle` 0 or 180) that is `gamma`; on its side (90 or 270) it is
 * `beta`, with the sign flipped between the two sides.
 */
export function tiltAxis(beta: number | null, gamma: number | null, angle: number): number {
    const turned = ((Math.round(angle) % 360) + 360) % 360;
    const roll =
        turned === 90
            ? (beta ?? 0)
            : turned === 270
              ? -(beta ?? 0)
              : turned === 180
                ? -(gamma ?? 0)
                : (gamma ?? 0);
    return clamp(roll / TILT_FULL_DEGREES);
}

/** The frame the game reads: tilt, when on, steers in place of the stick's x. */
export function padFrame(controls: PadControls): { axes: number[]; buttons: number[] } {
    const x = controls.tilt ?? controls.stick.x;
    const buttons = Array.from({ length: 17 }, (_, i) => clamp(controls.buttons[i] ?? 0, 0, 1));
    return { axes: [clamp(x), clamp(controls.stick.y), 0, 0], buttons };
}

/**
 * The link a phone opens to claim the pad with `code`: on the Polaris domain
 * (`appUrl`, what every handed-out link is built on), and on the page's own
 * origin only where no domain is configured.
 */
export function phonePadLink(appUrl: string, origin: string, code: string): string {
    const base = (appUrl.trim() || origin).replace(/\/+$/, "");
    return `${base}/games/pad?code=${code}`;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * An SVG element as an image the sandboxed game can show without markup of its
 * own. An `<svg>` drawn into an HTML page serializes without its namespace, and
 * as an image it is parsed as XML, where an `<svg>` with none is not an SVG at
 * all: the image fails to load. So the namespace is written in when it is missing.
 */
export function svgDataUrl(svg: string): string {
    const markup = /^\s*<svg\b[^>]*\sxmlns\s*=/i.test(svg)
        ? svg
        : svg.replace(/^\s*<svg\b/i, `<svg xmlns="${SVG_NAMESPACE}"`);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}
