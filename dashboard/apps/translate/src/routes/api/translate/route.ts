/**
 * `/api/translate`, the one way every surface translates on the server: this
 * app's screen today, Chat, Polar and the extension later.
 *
 * GET answers which server engines can answer the caller, the order the
 * administrator set, the default target language, the optional length limit
 * on one translation and whether images and audio can be read here. POST `{ texts[], from, to, engine? }` answers
 * `{ texts[], engine, detected }`: `from` "auto" has the engine detect the
 * source, and a named `engine` is used or refused, never swapped for another.
 * Signed in (session or API key), rate limited per person, body validated.
 */

import { caller, body } from "../../../lib/route";
import { translateInput } from "../../../model/schemas";
import { mediaStatus } from "../../../lib/media";
import { failureResponse, serverStatus, translateOnServer } from "../../../lib/serve";

export async function GET(): Promise<Response> {
    const user = await caller();
    if (user instanceof Response) return user;
    const status = await serverStatus(user.id);
    return Response.json({
        engines: status.engines,
        browser: status.settings.engines.browser,
        defaultTarget: status.settings.defaultTarget,
        order: status.settings.order,
        charLimit: status.settings.charLimit,
        reads: await mediaStatus(user.id)
    });
}

export async function POST(request: Request): Promise<Response> {
    const user = await caller();
    if (user instanceof Response) return user;
    const input = await body(request, translateInput);
    if (input instanceof Response) return input;
    const served = await translateOnServer(user.id, input);
    if (!served.ok) return failureResponse(served.failure, user.isAdmin, { limit: served.limit ?? 0 });
    return Response.json({ texts: served.texts, engine: served.engine, detected: served.detected });
}
