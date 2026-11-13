/**
 * One alert, as the notification that announced it opens it: severity, topic,
 * tags, the message (Markdown rendered and sanitized when the sender asked for
 * it) and the sender's links, which were kept only when http or https.
 */

import { notFound } from "next/navigation";
import { prisma } from "@polaris/db";
import type { AlertPriority } from "@polaris/core";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { canManage, recipientsOf } from "@/lib/alerts/topics";
import { Badge, cn } from "@polaris/ui";
import { ExternalLink } from "lucide-react";
import { AlertBody } from "./alert-body";

export const dynamic = "force-dynamic";

const TONE: Record<number, string> = {
    1: "text-muted-foreground",
    2: "text-muted-foreground",
    3: "text-foreground",
    4: "text-warning-ink",
    5: "text-danger-ink"
};

export default async function AlertDeliveryPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
    const user = await requireUser();
    const delivery = await prisma.alertDelivery.findUnique({
        where: { id },
        include: { topic: true }
    });
    if (!delivery) notFound();
    const allowed =
        (await canManage(user.id, delivery.topic)) ||
        (await recipientsOf(delivery.topic)).includes(user.id);
    if (!allowed) notFound();
    const t = await getTranslations("account");
    const actions = Array.isArray(delivery.actions)
        ? (delivery.actions as Array<{ label?: unknown; url?: unknown }>).filter(
              (action): action is { label: string; url: string } =>
                  typeof action.label === "string" && typeof action.url === "string" && /^https?:\/\//.test(action.url)
          )
        : [];
    const links = [
        ...(delivery.click && /^https?:\/\//.test(delivery.click) ? [{ label: t("alerts.openLink"), url: delivery.click }] : []),
        ...actions
    ];
    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-1">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className={cn("font-medium", TONE[delivery.priority])}>
                        {t(`alerts.severity.${delivery.priority as AlertPriority}`)}
                    </span>
                    <span className="truncate" title={delivery.topic.name}>
                        {delivery.topic.name}
                    </span>
                    <time dateTime={delivery.createdAt.toISOString()}>{delivery.createdAt.toISOString().slice(0, 16).replace("T", " ")}</time>
                </p>
                <h1 className="break-words text-[1.0625rem] font-semibold tracking-tight">
                    {delivery.title || delivery.topic.name}
                </h1>
            </div>
            {delivery.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {delivery.tags.map((tag) => (
                        <Badge key={tag} className="max-w-48 truncate" title={tag}>
                            {tag}
                        </Badge>
                    ))}
                </div>
            )}
            <AlertBody message={delivery.message} markdown={delivery.markdown} />
            {links.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {links.map((link) => (
                        <a
                            key={`${link.label}:${link.url}`}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                            title={link.url}
                        >
                            <ExternalLink className="size-4 shrink-0" />
                            <span className="truncate">{link.label}</span>
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}
