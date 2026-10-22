"use client";

/**
 * The AI assistants card on the downloads screen: the clients most people
 * connect, each with its own mark, opening that client's guide on the AI
 * assistants screen - where the steps, the values to copy and the connected
 * assistants already live, so they are linked rather than drawn twice.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { ArrowRight, Plug } from "lucide-react";
import { AssistantPreview } from "./download-previews";
import { CLIENT_GUIDES } from "@/lib/mcp/client-guides";
import { LogoTile } from "@/components/client-logo-tile";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DownloadCard, DownloadRow, DownloadRows } from "./download-card";

/** The clients shown here, in this order; the rest are one link away. */
export const FEATURED_ASSISTANTS = ["claude", "chatgpt", "cursor", "vscode"] as const;

/** Where one client's guide opens, or the list of them all. */
export const assistantGuideHref = (id?: string) =>
    `/account/assistants#connect${id ? `-${id}` : ""}`;

export function AssistantsCard() {
    const t = useTranslations("account");
    const featured = FEATURED_ASSISTANTS.map((id) =>
        CLIENT_GUIDES.find((guide) => guide.id === id)
    ).filter((guide) => guide !== undefined);
    return (
        <DownloadCard
            id="assistants"
            tint="violet"
            icon={<Plug className="size-4 shrink-0" />}
            title={t("downloads.assistants.title")}
            description={t("downloads.assistants.description")}
            preview={<AssistantPreview />}
        >
            <DownloadRows>
                {featured.map((guide) => (
                    <DownloadRow
                        key={guide.id}
                        tile={false}
                        mark={<LogoTile logo={guide.logo} className="size-8 rounded-md" />}
                        name={guide.name}
                        action={
                            <Button asChild variant="secondary" size="sm">
                                <Link
                                    href={assistantGuideHref(guide.id)}
                                    aria-label={t("downloads.assistants.setUpIn", {
                                        name: guide.name
                                    })}
                                    title={t("downloads.assistants.setUpIn", { name: guide.name })}
                                >
                                    {t("downloads.assistants.setUp")}
                                    <ArrowRight className="size-4" />
                                </Link>
                            </Button>
                        }
                    />
                ))}
            </DownloadRows>
            <Link className="w-fit text-muted-foreground underline" href={assistantGuideHref()}>
                {t("downloads.assistants.all", { count: CLIENT_GUIDES.length })}
            </Link>
        </DownloadCard>
    );
}
