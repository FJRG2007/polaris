/**
 * What an avatar route answers when there is no photo.
 *
 * It used to be a 404, which is honest HTTP and a poor answer for an `<img>`:
 * every account without a picture - which is most of them on a fresh instance -
 * produced a failed request per place their face appears, so the dashboard
 * looked like it was permanently trying to load images that are not there. The
 * component underneath was already drawing initials and hiding the image on
 * error, so nothing was ever visibly broken; it just read as broken to anybody
 * with a network panel open, and a browser is entitled to paint its
 * broken-image glyph in the moment before the error handler runs.
 *
 * So the route answers with a picture, and the picture is one transparent pixel.
 * The initials underneath show through it, the request succeeds, and it caches
 * like any other image. "There is no photo" and "here is a photo of nothing" are
 * the same thing on screen; only one of them makes a browser complain.
 *
 * A 404 is still the right answer to a request for somebody who does not exist -
 * that is a different question, and it is answered before this.
 */

/** A 1x1 fully transparent PNG, 68 bytes. Small enough that serving it costs
 *  less than the failed request it replaces. */
const TRANSPARENT_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Stable, so a browser that already has the blank pixel is answered with a 304
 *  rather than the bytes. It is also the only thing that tells this answer apart
 *  from a real picture once it is bytes in a browser, so it is read on the client
 *  too - hence the decoding below happening inside the function rather than at
 *  module scope, where importing this constant would drag `Buffer` into a bundle
 *  that has none. */
export const BLANK_AVATAR_ETAG = '"blank"';

export function blankAvatarResponse(cacheControl: string): Response {
    const blank = Buffer.from(TRANSPARENT_PNG_BASE64, "base64");
    return new Response(blank as unknown as BodyInit, {
        headers: {
            "Content-Type": "image/png",
            "Content-Length": String(blank.length),
            ETag: BLANK_AVATAR_ETAG,
            "Cache-Control": cacheControl,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline"
        }
    });
}
