/** Rooms and equipment people invite to events. */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PageHeader } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { RoomsView } from "../../../screens/rooms/rooms-view";

export const dynamic = "force-dynamic";

export default async function CalendarRoomsPage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
            <PageHeader
                title={t("rooms.pageTitle")}
                description={t("rooms.pageDescription")}
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/calendar" aria-label={t("rooms.back")} title={t("rooms.back")}>
                            <ArrowLeft />
                            <span className="hidden sm:inline">{t("rooms.back")}</span>
                        </Link>
                    </Button>
                }
            />
            <RoomsView />
        </div>
    );
}
