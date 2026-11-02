/** A game server's own screens. */

import { InstalledAppScreen } from "@/app/(app)/apps/installed/[id]/installed-screen";

export const dynamic = "force-dynamic";

export default function GameServerPage({
    params
}: {
    params: Promise<{ id: string; tab?: string[] }>;
}) {
    return <InstalledAppScreen params={params} gameRoute />;
}
