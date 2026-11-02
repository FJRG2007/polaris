/** An installed app's own page. Game servers move on to /game-servers. */

import { InstalledAppScreen } from "../installed-screen";

export const dynamic = "force-dynamic";

export default function InstalledAppPage({
    params
}: {
    params: Promise<{ id: string; tab?: string[] }>;
}) {
    return <InstalledAppScreen params={params} />;
}
