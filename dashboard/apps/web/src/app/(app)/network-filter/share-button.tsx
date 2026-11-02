"use client";

/**
 * The Network filter's Share button: an administrator hands the long-term
 * statistics to a person, a team or a role (`dns.filter`).
 */

import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@polaris/ui";
import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ShareDialog } from "@/components/access/share-dialog";

export function DnsShareButton() {
    const t = useTranslations("dnsBlocker");
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                size="icon"
                variant="ghost"
                aria-label={t("shared.share")}
                title={t("shared.share")}
                onClick={() => setOpen(true)}
            >
                <Share2 className="size-4" />
            </Button>
            {open ? (
                <ShareDialog
                    open
                    onOpenChange={setOpen}
                    subject="dns.filter"
                    subjectId={core.DNS_FILTER_ID}
                    name={t("page.title")}
                />
            ) : null}
        </>
    );
}
