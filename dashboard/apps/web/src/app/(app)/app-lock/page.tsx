/**
 * What a PIN-locked app shows instead of itself (see `app-lock-service`). The
 * session guard sends every screen of a locked app here until this session
 * unlocks it; anything that is not, or is no longer, locked goes straight back.
 */

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { POLARIS_APPS } from "@/lib/apps";
import { getAppLocks } from "@/lib/app-lock-service";
import { appIdSchema, safeReturnPath } from "@/lib/app-locks";
import { Messages } from "@/components/i18n/messages";
import { AppUnlockView } from "./unlock-view";

export default async function AppLockPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requireUser();
    const params = await searchParams;
    const id = appIdSchema.safeParse(params.app);
    const app = id.success ? POLARIS_APPS.find((entry) => entry.id === id.data) : undefined;
    if (!app) redirect("/");
    const next = safeReturnPath(params.next, app.href);
    const { locked, hasPin } = await getAppLocks(user.viewingAs?.actorId ?? user.id);
    if (!hasPin || !locked.includes(app.id)) redirect(next);
    return (
        <Messages namespaces={["auth"]}>
            <AppUnlockView appId={app.id} label={app.label} next={next} />
        </Messages>
    );
}
