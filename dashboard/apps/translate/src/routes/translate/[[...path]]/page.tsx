/**
 * Translate at `/translate`, for anybody signed in. The server hands over the
 * frame and whether the reader may change the app's settings; the screen asks
 * for the engines and the history in the browser, so the panes are on screen
 * before any request has left.
 */

import { host } from "@polaris/app-host";
import { notFound } from "next/navigation";
import { TranslateScreen } from "../../../screens/translate-screen";

export const dynamic = "force-dynamic";

export default async function TranslatePage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const [user, raw] = await Promise.all([
        host.session.requirePermission("translate.use"),
        params.then((all) => all.path)
    ]);
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > 0)) notFound();
    return <TranslateScreen manager={user.isAdmin} />;
}
