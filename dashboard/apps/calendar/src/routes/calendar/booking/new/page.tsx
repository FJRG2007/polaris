/** A new booking page, started from the calendar's card when it carries a
 *  title and the time picked on the grid. */

import { PageHeader } from "@polaris/ui";
import { calendarT } from "../../../../lib/i18n";
import { requireCalendarUser } from "../../../../lib/access";
import { seedOf } from "../../../../screens/booking/model";
import { BookingPageEditor } from "../../../../screens/booking/booking-page-editor";

export const dynamic = "force-dynamic";

export default async function NewBookingPagePage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requireCalendarUser();
    const t = await calendarT();
    const seed = seedOf(await searchParams);
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col">
            <PageHeader title={t("bookingPage.newTitle")} />
            <BookingPageEditor pageId={null} seed={seed} />
        </div>
    );
}
