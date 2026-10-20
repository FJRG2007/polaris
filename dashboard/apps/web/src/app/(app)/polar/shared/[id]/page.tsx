/**
 * A Polar chat somebody sent the signed-in person: the snapshot they sent,
 * read-only, with the way to carry on from it in a chat of their own. Read
 * through the recipient row, so one taken back is a 404 like one never sent.
 */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { polarAccessFor } from "@/lib/polar/access";
import { homePathForUser, requireUser } from "@/lib/session";
import { ReceivedChat } from "./received-chat";
import { getTranslations } from "@/lib/i18n/request";
import { readReceivedPolarThread } from "@/lib/polar/share";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("polar");
    return { title: t("sharing.sharedWithYou") };
}

export default async function ReceivedPolarChatPage({
    params
}: {
    params: Promise<{ id: string }>;
}) {
    const user = await requireUser();
    if (!(await polarAccessFor(user.id)).use) redirect(await homePathForUser(user));
    const { id } = await params;
    const thread = await readReceivedPolarThread(user.id, id);
    if (!thread) notFound();
    return <ReceivedChat id={id} thread={thread} />;
}
