/**
 * One person's public booking pages (Nextcloud's per-user overview): the pages
 * they chose to list, each linking to its own booking page.
 */

import { notFound } from "next/navigation";
import { calendarT } from "../../../../lib/i18n";
import { publicPagesOf } from "../../../../lib/booking";
import { BookingOverview } from "../../../../screens/public/booking-overview";

export const dynamic = "force-dynamic";

export default async function PublicBookingOverviewPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { userId } = await params;
    if (typeof userId !== "string") notFound();
    const found = await publicPagesOf(userId);
    if (!found) notFound();
    const t = await calendarT();
    return (
        <BookingOverview
            title={t("booking.overviewTitle", { name: found.ownerName })}
            pages={found.pages}
        />
    );
}
