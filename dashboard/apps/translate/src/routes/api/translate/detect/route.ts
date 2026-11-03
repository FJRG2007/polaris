/**
 * `/api/translate/detect`: POST `{ text, engine? }` answers
 * `{ language, engine }`, the language as one of Translate's codes or null.
 * Same caller, rate and body rules as `/api/translate`.
 */

import { caller, body } from "../../../../lib/route";
import { detectInput } from "../../../../model/schemas";
import { detectOnServer, failureResponse } from "../../../../lib/serve";

export async function POST(request: Request): Promise<Response> {
    const user = await caller();
    if (user instanceof Response) return user;
    const input = await body(request, detectInput);
    if (input instanceof Response) return input;
    const served = await detectOnServer(user.id, input);
    if (!served.ok) return failureResponse(served.failure, user.isAdmin);
    return Response.json({ language: served.language, engine: served.engine });
}
