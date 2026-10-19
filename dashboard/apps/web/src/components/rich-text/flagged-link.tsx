"use client";

/**
 * A link a reputation service flagged: marked where it sits, and asked about
 * before it opens.
 *
 * The click is stopped and a dialog says who flagged it and where it goes, with
 * going back as the default. Continuing opens it the way any outside link opens -
 * a new tab that cannot reach back into Polaris. A flag is somebody else's
 * opinion, so the reader can still follow it; what they cannot do is follow it
 * without knowing.
 */

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";
import { linkProviderName } from "./link-providers";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function FlaggedAnchor({
    href,
    provider,
    children
}: {
    href: string;
    provider: string;
    children: React.ReactNode;
}) {
    const t = useTranslations("components");
    const [open, setOpen] = useState(false);
    const name = linkProviderName(provider);

    const proceed = () => {
        setOpen(false);
        window.open(href, "_blank", "noopener,noreferrer");
    };

    return (
        <>
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                title={t("linkWarning.flaggedBy", { provider: name })}
                onClick={(event) => {
                    // Modified clicks too: a middle click or Ctrl+click is still
                    // somebody opening the link without having been told.
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(true);
                }}
                onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(true);
                }}
                className="text-danger-ink decoration-danger-edge"
            >
                <TriangleAlert
                    aria-label={t("linkWarning.flaggedBy", { provider: name })}
                    className="mr-0.5 inline size-[1em] shrink-0 align-[-0.125em]"
                />
                {children}
            </a>
            <span className="contents" onClick={(event) => event.stopPropagation()}>
                <Dialog open={open} onOpenChange={setOpen}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>{t("linkWarning.title")}</DialogTitle>
                            <DialogDescription>
                                {t("linkWarning.description", { provider: name })}
                            </DialogDescription>
                        </DialogHeader>
                        <p className="min-w-0 break-all rounded-md border border-danger-edge bg-danger-soft px-3 py-2 font-mono text-xs text-danger-ink">
                            {href}
                        </p>
                        <DialogFooter>
                            <Button variant="outline" onClick={proceed}>
                                {t("linkWarning.continue")}
                            </Button>
                            <Button autoFocus onClick={() => setOpen(false)}>
                                {t("linkWarning.goBack")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </span>
        </>
    );
}
