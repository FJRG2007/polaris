/**
 * A booking page, as anybody with its address sees it. No session: the page
 * shows only what its owner chose to publish and the times on offer.
 */

import { notFound } from "next/navigation";
import { publicBookingPage } from "../../../../lib/booking";
import { BookingFlow } from "../../../../screens/public/booking-flow";

export const dynamic = "force-dynamic";

export default async function PublicBookingPagePage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { slug } = await params;
    if (typeof slug !== "string") notFound();
    const page = await publicBookingPage(slug);
    if (!page) notFound();
    return <BookingFlow page={page} />;
}
