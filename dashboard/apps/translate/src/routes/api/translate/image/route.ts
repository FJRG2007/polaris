/**
 * `/api/translate/image`: the lines of text in a picture, for the screen to
 * translate - a screenshot, a photo, a frame of the camera. POST the image
 * itself (PNG, JPEG, WebP or GIF, read from its bytes, not its name or type)
 * and get `{ lines: [{ text, box }] }`, `box` being `[x, y, width, height]`
 * as fractions of the picture, or null.
 *
 * Read by the model Polar uses for pictures, on Polar's keys and limits.
 * Signed in, rate limited per person, size capped; never stored.
 */

import { translateT } from "../../../../lib/i18n";
import { readImage } from "../../../../lib/media";
import { bytes, caller } from "../../../../lib/route";
import { failureResponse } from "../../../../lib/serve";
import { IMAGE_MAX_BYTES, sniffImage } from "../../../../model/media";

export async function POST(request: Request): Promise<Response> {
    const user = await caller();
    if (user instanceof Response) return user;
    const body = await bytes(request, IMAGE_MAX_BYTES);
    if (body instanceof Response) return body;
    const type = sniffImage(body);
    if (!type) {
        const t = await translateT();
        return Response.json(
            { error: "unsupported", message: t("errors.imageType") },
            { status: 415 }
        );
    }
    const read = await readImage(user.id, body, type);
    if (!read.ok) return failureResponse(read.failure, user.isAdmin);
    return Response.json({ lines: read.lines });
}
