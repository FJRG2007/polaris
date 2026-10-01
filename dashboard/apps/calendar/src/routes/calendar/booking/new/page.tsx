/** A new booking page. */

import { PageHeader } from "@polaris/ui";
import { calendarT } from "../../../../lib/i18n";
import { requireCalendarUser } from "../../../../lib/access";
import { BookingPageEditor } from "../../../../screens/booking/booking-page-editor";

export const dynamic = "force-dynamic";

export default async function NewBookingPagePage() {
    await requireCalendarUser();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col">
            <PageHeader title={t("bookingPage.newTitle")} />
            <BookingPageEditor pageId={null} />
        </div>
    );
}
