"use client";

/**
 * A session's Share button: whoever steers it lets a person, a team or a role
 * read it (`agents.session`).
 */

import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ShareDialog } from "@/components/access/share-dialog";

export function SessionShareButton({ sessionId, title }: { sessionId: string; title: string }) {
    const t = useTranslations("agents");
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                size="icon"
                variant="ghost"
                aria-label={t("session.share")}
                title={t("session.share")}
                onClick={() => setOpen(true)}
            >
                <Share2 className="size-4" />
            </Button>
            {open ? (
                <ShareDialog
                    open
                    onOpenChange={setOpen}
                    subject="agents.session"
                    subjectId={sessionId}
                    name={title}
                />
            ) : null}
        </>
    );
}
