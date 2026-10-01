/** One booking page: its settings and the bookings made on it. */

import { PageHeader } from "@polaris/ui";
import { notFound } from "next/navigation";
import { calendarT } from "../../../../lib/i18n";
import { uuidSchema } from "../../../../lib/schemas";
import { requireCalendarUser } from "../../../../lib/access";
import { BookingPageEditor } from "../../../../screens/booking/booking-page-editor";

export const dynamic = "force-dynamic";

export default async function BookingPageEditPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    await requireCalendarUser();
    const { id } = await params;
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) notFound();
    const t = await calendarT();
    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col">
            <PageHeader title={t("bookingPage.editTitle")} />
            <BookingPageEditor pageId={parsed.data} />
        </div>
    );
}
