/**
 * What Tools does to a picture.
 *
 * Converting, resizing and making one smaller are the same operation with
 * different arguments, so they are one function rather than three: a screen that
 * offers all three at once cannot produce a request that means two of them
 * separately, and the file is only decoded once whatever was asked for.
 *
 * The engine is the one Polaris already carries for Drive's thumbnails. It is
 * the same encoders the image-optimizing websites use - mozjpeg for JPEG, the
 * reference WebP and AVIF encoders - compiled rather than run as WebAssembly,
 * which is why this can afford to re-encode on every move of a quality slider.
 *
 * **Nothing is kept.** The bytes arrive in a request, are decoded, encoded and
 * handed back; nothing is written to disk and nothing is recorded but the fact
 * that somebody used the tool. A picture is often the most private file a person
 * owns, and the reason to have this here at all rather than on a website is that
 * it does not go anywhere.
 */

export const IMAGE_FORMATS = ["jpeg", "png", "webp", "avif"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** The extension and type each format is handed back as. */
export const IMAGE_TYPES: Readonly<Record<ImageFormat, { mime: string; extension: string }>> = {
    jpeg: { mime: "image/jpeg", extension: "jpg" },
    png: { mime: "image/png", extension: "png" },
    webp: { mime: "image/webp", extension: "webp" },
    avif: { mime: "image/avif", extension: "avif" }
};

export function isImageFormat(value: string): value is ImageFormat {
    return (IMAGE_FORMATS as readonly string[]).includes(value);
}

/** What a picture says about itself, before anything is done to it. */
export interface ImageFacts {
    readonly format: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    /** Whether any pixel is see-through, which is what decides whether offering
     *  JPEG would quietly fill it with black. */
    readonly hasAlpha: boolean;
    /** What the camera and the software that touched it left behind, when there
     *  is any: the date, the camera, and whether it carries a location. */
    readonly taken?: string;
    readonly hasLocation: boolean;
}

export interface ImageJob {
    readonly format: ImageFormat;
    /** 1-100. Ignored by PNG, which is lossless - the number there would be a
     *  promise the format cannot keep. */
    readonly quality: number;
    /** Longest side in pixels, or null to leave the size alone. One number
     *  rather than two: a picture resized to a box distorts, and every caller
     *  that has ever wanted that has wanted to crop instead. */
    readonly longestSide: number | null;
    /**
     * Whether to carry the metadata over.
     *
     * Off by default, and that is a decision rather than an oversight: a photo
     * out of a phone carries where it was taken, and somebody resizing one to
     * put it on a website is not thinking about that. Keeping it is one switch
     * away; losing it silently is not something anybody can undo.
     */
    readonly keepMetadata: boolean;
}

export interface ImageResult {
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
}

/** As large a picture as this will decode. Beyond it the answer is a sentence
 *  rather than a machine spending a minute on one request. */
export const MOST_IMAGE_BYTES = 60 * 1024 * 1024;

/**
 * Read what a picture says about itself.
 *
 * Throws on anything that is not an image this engine can decode, which the
 * caller turns into a sentence - "this file is not a picture" is the only thing
 * a reader can do anything with.
 */
export async function readImageFacts(bytes: Uint8Array): Promise<ImageFacts> {
    const { default: sharp } = await import("sharp");
    const image = sharp(bytes, { failOn: "none" });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) throw new Error("not an image");

    // EXIF is a binary block; rather than parse it here, the engine's own
    // reader is asked for the few fields worth showing. Anything it cannot make
    // sense of is simply absent, which is the honest answer.
    const exif: ExifFacts = meta.exif ? readExif(meta.exif) : { hasLocation: false };

    return {
        format: meta.format ?? "unknown",
        width: meta.width,
        height: meta.height,
        bytes: bytes.byteLength,
        hasAlpha: Boolean(meta.hasAlpha),
        taken: exif.taken,
        hasLocation: exif.hasLocation
    };
}

/**
 * The handful of EXIF fields worth putting on a screen, read out of the raw
 * block without a parser.
 *
 * Deliberately shallow: the point is to tell somebody that this picture knows
 * where it was taken before they publish it, not to be an EXIF viewer. A field
 * that cannot be found is left out rather than guessed at.
 */
interface ExifFacts {
    taken?: string;
    hasLocation: boolean;
}

function readExif(block: Buffer): ExifFacts {
    const text = block.toString("latin1");
    // "YYYY:MM:DD HH:MM:SS", the one date format EXIF actually agrees on.
    const taken = /(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})/.exec(text)?.[1];
    return {
        taken: taken?.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"),
        // The GPS IFD tag. Its presence is the fact worth reporting; where it
        // says the picture was taken is not this screen's business.
        hasLocation: text.includes("GPS")
    };
}

/**
 * Convert, resize and re-encode in one pass.
 *
 * Orientation is applied rather than carried: a phone photo that is upright
 * because of a flag in its metadata is upright in the pixels afterwards, since
 * the flag may not survive a format change and a picture that arrives sideways
 * is the most common way this kind of tool is wrong.
 */
export async function transformImage(bytes: Uint8Array, job: ImageJob): Promise<ImageResult> {
    const { default: sharp } = await import("sharp");
    let image = sharp(bytes, { failOn: "none" }).rotate();

    if (job.longestSide) {
        image = image.resize({
            width: job.longestSide,
            height: job.longestSide,
            // The longest side lands on the number and the other one follows, so
            // nothing is stretched and nothing is cut off.
            fit: "inside",
            // A picture already smaller than the target is left alone: enlarging
            // it invents pixels and makes the file bigger for no gain.
            withoutEnlargement: true
        });
    }

    if (job.keepMetadata) image = image.withMetadata();

    const quality = Math.min(100, Math.max(1, Math.round(job.quality)));
    if (job.format === "jpeg") image = image.jpeg({ quality, mozjpeg: true });
    else if (job.format === "webp") image = image.webp({ quality });
    else if (job.format === "avif") image = image.avif({ quality });
    else image = image.png({ compressionLevel: 9, palette: true });

    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    return { bytes: new Uint8Array(data), width: info.width, height: info.height };
}
