/**
 * A profile photo redrawn for a reader that cannot decode the stored format.
 *
 * Photos are kept as uploaded - PNG, JPEG, WebP or GIF - and a browser reads all
 * four. The desktop app's notices do not: the system draws only PNG and JPEG, so
 * it asks for those in `Accept` and a WebP or GIF face is answered as a PNG of
 * its first frame instead of the app's mark.
 */

/** Side of the square a converted face is drawn at: a notice icon, not a poster. */
const RENDITION_SIDE = 256;

/** Anything this many pixels or more is not a profile photo. */
const RENDITION_MAX_PIXELS = 64 * 1024 * 1024;

export interface AvatarRendition {
    readonly mime: "image/png";
    readonly suffix: "png";
    readonly convert: (bytes: Uint8Array) => Promise<Uint8Array | null>;
}

/** The media types an `Accept` header names, without the ones it refuses (`q=0`). */
function acceptedTypes(accept: string): string[] {
    return accept
        .split(",")
        .map((part) => part.split(";").map((piece) => piece.trim().toLowerCase()))
        .filter(([type, ...params]) => type && !params.some((param) => /^q=0(\.0*)?$/.test(param)))
        .map(([type]) => type as string);
}

async function toPng(bytes: Uint8Array): Promise<Uint8Array | null> {
    try {
        const { default: sharp } = await import("sharp");
        return await sharp(bytes, { limitInputPixels: RENDITION_MAX_PIXELS })
            .resize(RENDITION_SIDE, RENDITION_SIDE, { fit: "cover", withoutEnlargement: true })
            .png()
            .toBuffer();
    } catch {
        return null;
    }
}

/**
 * The rendition to answer with, or null to serve the stored bytes. Only when
 * the reader named the formats it takes and the stored one is not among them;
 * a browser's `image/*` or `*\/*`, or no header at all, gets the photo as kept.
 */
export function avatarRendition(accept: string | null, storedMime: string): AvatarRendition | null {
    if (!accept) return null;
    const types = acceptedTypes(accept);
    if (types.some((type) => type === storedMime || type === "image/*" || type === "*/*")) return null;
    if (!types.includes("image/png")) return null;
    return { mime: "image/png", suffix: "png", convert: toPng };
}
