/**
 * The signed-in person's own Polar "/" commands: GET lists them for the "/"
 * list and the settings, POST adds one. The body is the shared schema, so a
 * shortcut is normalized and checked here exactly as the form checks it.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCommandInputSchema } from "@/lib/polar/shared";
import { createPolarCommand, listPolarCommands } from "@/lib/polar/commands";
import { userHasManage } from "@/lib/session";
import { NO_ENIGMA_COMMANDS } from "@/lib/polar/enigma-slash";
import { enigmaSlashLists } from "@/lib/polar/skills/enigma-commands";

export const dynamic = "force-dynamic";

const STATUS = { too_many: 409, taken: 409, unknown_model: 409, not_found: 404 } as const;

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    // Enigma's commands ride along: unreadable settings or package is simply none.
    const [commands, enigma] = await Promise.all([
        listPolarCommands(user.id),
        userHasManage(user, "agents.manage")
            .then((canCode) => enigmaSlashLists(user.id, canCode))
            .catch((error: unknown) => {
                console.error("polar: could not list Enigma's commands", error);
                return NO_ENIGMA_COMMANDS;
            })
    ]);
    return NextResponse.json({ commands, enigma });
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const body = polarCommandInputSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const command = await createPolarCommand(user.id, body.data);
    return typeof command === "string"
        ? NextResponse.json({ error: command }, { status: STATUS[command] })
        : NextResponse.json({ command });
}
