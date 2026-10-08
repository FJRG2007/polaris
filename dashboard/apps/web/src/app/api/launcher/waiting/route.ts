import { NextResponse } from "next/server";
import { backgroundUser, sessionCan } from "@/lib/session";
import { readerWords } from "@/lib/i18n/reader-words";
import { launcherWaiting } from "@/lib/launcher-waiting-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the app menu lists under its grid, for whoever is asking.
 *
 * Asked when the menu opens rather than on every page: the badges already carry
 * the numbers above every screen, and the entries behind them are only worth a
 * request once somebody is looking. Each group behind the gate its badge uses,
 * so nobody is listed what their badge would not count.
 */
export async function GET(): Promise<Response> {
    const session = await backgroundUser();
    if (!session)
        return NextResponse.json(
            { error: (await readerWords("api"))("errors.unauthorized") },
            { status: 401 }
        );
    const [chat, mail] = await Promise.all([
        sessionCan(session, "chat.use"),
        sessionCan(session, "mail.use")
    ]);
    const groups = await launcherWaiting(session.id, { chat, mail, admin: session.isAdmin });
    return NextResponse.json({ groups }, { headers: { "cache-control": "private, no-store" } });
}
