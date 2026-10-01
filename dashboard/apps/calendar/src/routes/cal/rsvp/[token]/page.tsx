/**
 * Answering an invitation from the link in its email. No session: the token
 * answers for the one address it was sent to, and the page shows that address
 * masked so a forwarded link is recognisable without publishing it.
 */

import { notFound } from "next/navigation";
import { maskedAddress, rsvpView } from "../../../../lib/rsvp";
import { RsvpForm } from "../../../../screens/public/rsvp-form";

export const dynamic = "force-dynamic";

export default async function RsvpPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const { token } = await params;
    if (typeof token !== "string") notFound();
    const view = await rsvpView(token);
    if (!view) notFound();
    const { email, ...shown } = view;
    return <RsvpForm token={token} view={{ ...shown, email: "" }} address={maskedAddress(email)} />;
}
