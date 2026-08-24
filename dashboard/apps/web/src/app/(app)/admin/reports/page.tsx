/**
 * Where reported messages used to live.
 *
 * They are on the safety queue now, beside the reports about people and the
 * accounts that have shut themselves down - one screen, because "what needs
 * looking at" is one question. The address stays and forwards, because it is in
 * bookmarks and in old alerts, and a link from a notification about something
 * urgent must not land on a 404.
 *
 * Temporary on purpose: nothing here is permanently redirected, so the day this
 * moves again nobody is fighting a cached 308 in every browser that ever opened
 * it.
 */

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function ReportsPage(): never {
    redirect("/admin/safety");
}
