/**
 * What a photograph of somebody may be.
 *
 * Its own module because both ends need it: the picker in the browser, which
 * decides what a file dialog will even offer, and the server, which decides what
 * the recognizer is told it has been handed. `people.ts` cannot be that module -
 * it talks to the database, and importing it from a screen would pull Prisma into
 * the browser bundle.
 *
 * Three formats: JPEG and PNG from a camera roll, and WebP from anything saved
 * off a web page - which is most of what people actually have to hand, and which
 * the picker used to refuse for no reason anybody could see. The recognizer reads
 * all three.
 */

export const FACE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type FaceImageType = (typeof FACE_IMAGE_TYPES)[number];

/** The name a photograph is sent under, which has to agree with its type. */
export const FACE_EXTENSION: Record<FaceImageType, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp"
};

/**
 * A content type from a browser, narrowed to one of those.
 *
 * Anything else - absent, invented, or a format nothing here reads - is treated
 * as a JPEG, which is what every photograph was sent as before this existed. What
 * the recognizer can actually decode is its own decision; this only decides what
 * it is told, and a made-up type must never be passed on as fact.
 */
export function faceImageType(contentType: string | undefined): FaceImageType {
    const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    return FACE_IMAGE_TYPES.includes(base as FaceImageType) ? (base as FaceImageType) : "image/jpeg";
}
