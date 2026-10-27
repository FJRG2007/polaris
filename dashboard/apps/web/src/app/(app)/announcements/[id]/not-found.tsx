"use client";

/**
 * What an announcement's address answers when it is not the reader's to see -
 * outside its audience, withdrawn, or not started. Says no more than that, so
 * the address does not tell whether one exists.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { EmptyState } from "@polaris/ui";
import { ArrowLeft, SearchX } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

export default function AnnouncementNotFound() {
    const t = useTranslations("announcements");
    const common = useTranslations("common");
    return (
        <EmptyState
            icon={<SearchX />}
            title={t("details.notFound")}
            action={
                <>
                    <Button variant="ghost" onClick={() => window.history.back()}>
                        <ArrowLeft className="size-4 shrink-0" />
                        {common("pages.notFound.back")}
                    </Button>
                    <Button asChild variant="ghost">
                        <Link href="/home">{common("pages.notFound.overview")}</Link>
                    </Button>
                </>
            }
        />
    );
}
