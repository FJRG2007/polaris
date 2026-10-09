/**
 * A presentation's audience window (/office/show/<id>), opened from the
 * presenter view and dragged onto the projector.
 *
 * In a route group of its own so none of the app is drawn around it: what the
 * room sees is the slide and nothing else. It reads the deck through the same
 * access check the editor does - somebody who cannot open the deck gets the
 * same not-found as for one that does not exist - and never writes to it.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AudienceShow } from "./audience-show";
import * as office from "@/lib/office/documents";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    return { title: (await getTranslations("office"))("slides.audience.title") };
}

export default async function OfficeAudiencePage({ params }: { params: Promise<{ id: string }> }) {
    const user = await requirePermission("office.use");
    const { id } = await params;
    const found = await office.readDocument({ id: user.id }, id);
    if (!found || found.view.kind !== "slides") notFound();
    return (
        <Messages namespaces={["office"]}>
            <AudienceShow
                documentId={id}
                content={found.content ? Array.from(found.content) : null}
            />
        </Messages>
    );
}
