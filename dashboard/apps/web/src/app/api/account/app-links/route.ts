import { prisma } from "@polaris/db";
import { NextResponse } from "next/server";
import { backgroundUser } from "@/lib/session";
import { clientFromUserAgent } from "@polaris/core";
import { isIphoneApp } from "@/lib/open-in-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** More live sessions than anybody holds; the read stays bounded whatever happens. */
const SESSIONS_READ = 100;

/**
 * Whether a link followed in a browser should be handed to a Polaris app
 * (`lib/open-in-app`), and which apps this account is signed in to.
 *
 * Asked once per tab, and only when a page was reached from outside Polaris, so
 * it costs one indexed read of the account's own sessions at most.
 */
export async function GET(): Promise<Response> {
    const session = await backgroundUser();
    // i18n-ignore: a status body nothing shows
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const [user, sessions] = await Promise.all([
        prisma.user.findUnique({ where: { id: session.id }, select: { openLinksInApp: true } }),
        prisma.session.findMany({
            where: { userId: session.id, expiresAt: { gt: new Date() } },
            select: { userAgent: true },
            orderBy: { updatedAt: "desc" },
            take: SESSIONS_READ
        })
    ]);
    const clients = new Set(sessions.map((row) => clientFromUserAgent(row.userAgent)));
    return NextResponse.json(
        {
            open: user?.openLinksInApp ?? true,
            phone: sessions.some(
                (row) => clientFromUserAgent(row.userAgent) === "phone" && !isIphoneApp(row.userAgent)
            ),
            iphone: sessions.some((row) => isIphoneApp(row.userAgent)),
            desktop: clients.has("desktop")
        },
        { headers: { "cache-control": "private, no-store" } }
    );
}
