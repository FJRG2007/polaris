/**
 * The game's end of a pad: GET is the stream of the phone's controls (and
 * whether a phone holds it), POST a rumble for the phone, DELETE closes it.
 * Closing the stream closes the pad too.
 */

import * as pads from "@/lib/arcade/phone-pads";
import { padError, padReader, padStream } from "@/lib/arcade/pad-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const user = await padReader();
    if (user instanceof Response) return user;
    const { id } = await params;
    return padStream<pads.HostEvent>(request, (send) => pads.listenAsHost(id, user.id, send));
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const user = await padReader();
    if (user instanceof Response) return user;
    const { id } = await params;
    const body = pads.rumbleSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return padError("invalidRequest", 400);
    if (!pads.sendRumble(id, user.id, body.data)) return padError("notFound", 404);
    return new Response(null, { status: 204 });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await padReader();
    if (user instanceof Response) return user;
    const { id } = await params;
    if (!pads.closeOwnedPad(id, user.id)) return padError("notFound", 404);
    return new Response(null, { status: 204 });
}
