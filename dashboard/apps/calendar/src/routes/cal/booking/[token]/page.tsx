/**
 * A booking from the links in its emails: the confirmation link and the manage
 * link both land here. Nothing changes on opening it - a mail scanner opens
 * links too - the page offers the buttons.
 */

import { notFound } from "next/navigation";
import { bookingByToken } from "../../../../lib/booking";
import { BookingManage } from "../../../../screens/public/booking-manage";

export const dynamic = "force-dynamic";

export default async function PublicBookingManagePage({ params }: { params: Promise<Record<string, string | string[]>> }) {
    const { token } = await params;
    if (typeof token !== "string") notFound();
    const booking = await bookingByToken(token);
    if (!booking) notFound();
    return <BookingManage token={token} booking={booking} />;
}
