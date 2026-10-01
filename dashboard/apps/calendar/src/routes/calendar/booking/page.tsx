/**
 * Booking pages: the addresses people outside Polaris book time with the reader on.
 */

import { PageHeader } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { BookingPagesView } from "../../../screens/booking/booking-pages-view";

export const dynamic = "force-dynamic";

export default async function BookingPagesPage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col">
            <PageHeader title={t("bookingPage.pageTitle")} description={t("bookingPage.pageDescription")} />
            <BookingPagesView />
        </div>
    );
}
