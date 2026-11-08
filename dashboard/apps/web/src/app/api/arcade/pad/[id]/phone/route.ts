/**
 * The phone's end of a pad, by the token its claim returned: GET is the
 * stream of rumbles (and the pad closing), POST a frame of its controls or,
 * with `release`, letting go of the pad. The session is checked when the phone
 * claims the pad and opens its stream; a frame, sent many times a second, is
 * accepted by the token alone.
 */

import { z } from "zod";
import * as pads from "@/lib/arcade/phone-pads";
import { padError, padReader, padStream } from "@/lib/arcade/pad-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const tokenSchema = z.string().regex(/^[0-9a-f]{32}$/);
const bodySchema = z.union([
    z.object({ token: tokenSchema, frame: pads.padFrameSchema }).strict(),
    z.object({ token: tokenSchema, release: z.literal(true) }).strict()
]);

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const user = await padReader();
    if (user instanceof Response) return user;
    const { id } = await params;
    const token = tokenSchema.safeParse(new URL(request.url).searchParams.get("token"));
    if (!token.success) return padError("invalidRequest", 400);
    return padStream<pads.PhoneEvent>(request, (send, end) =>
        pads.listenAsPhone(id, token.data, (event) => {
            send(event);
            if (event.kind === "closed") end();
        })
    );
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const { id } = await params;
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return padError("invalidRequest", 400);
    if ("release" in body.data) {
        pads.releasePad(id, body.data.token);
        return new Response(null, { status: 204 });
    }
    if (!pads.sendInput(id, body.data.token, body.data.frame)) return padError("notFound", 404);
    return new Response(null, { status: 204 });
}
