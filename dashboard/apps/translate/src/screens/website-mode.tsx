"use client";

/**
 * A web page translated, the way Google Translate's Websites mode reads one:
 * Polaris fetches it, the screen keeps its readable text and structure, and
 * the page is drawn again here in the target language - headings, paragraphs,
 * lists, quotes, code - block by block as the translation arrives. Nothing of
 * the page runs, and every link opens the original site.
 */

import type { Translate } from "./run";
import { useTranslateT } from "./i18n";
import { websiteUrl } from "../model/input";
import { ExternalLink, Globe, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { readHtml, type PageBlock, type ReadPage } from "./website";
import { Button, Input, SegmentedControl, Skeleton, cn } from "@polaris/ui";

/** Blocks sent in one request. */
const BATCH = 40;

type Shown = "translation" | "original";

function Block({ block, text }: { block: PageBlock; text: string }) {
    const body: ReactNode = block.href ? (
        <a
            href={block.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline-offset-2 hover:underline"
        >
            {text}
        </a>
    ) : (
        text
    );
    const base = "min-w-0 [overflow-wrap:anywhere]";
    switch (block.tag) {
        case "h1":
            return <h2 className={cn(base, "text-xl font-semibold")}>{body}</h2>;
        case "h2":
            return <h3 className={cn(base, "text-lg font-semibold")}>{body}</h3>;
        case "h3":
        case "h4":
            return <h4 className={cn(base, "text-base font-semibold")}>{body}</h4>;
        case "li":
            return (
                <p
                    className={cn(
                        base,
                        "relative pl-5 before:absolute before:left-1.5 before:content-['-']"
                    )}
                >
                    {body}
                </p>
            );
        case "quote":
            return (
                <blockquote
                    className={cn(base, "border-l-2 border-border pl-3 text-muted-foreground")}
                >
                    {body}
                </blockquote>
            );
        case "pre":
            return (
                <pre
                    className={cn(
                        base,
                        "whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-sm"
                    )}
                >
                    {body}
                </pre>
            );
        default:
            return <p className={base}>{body}</p>;
    }
}

export function WebsiteMode({
    translate,
    charLimit,
    url: initialUrl,
    onClose
}: {
    translate: Translate;
    charLimit: number | null;
    url: string;
    onClose: () => void;
}) {
    const t = useTranslateT();
    const [address, setAddress] = useState(initialUrl);
    const [asked, setAsked] = useState(initialUrl);
    const [page, setPage] = useState<ReadPage | null>(null);
    const [translated, setTranslated] = useState<(string | null)[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [shown, setShown] = useState<Shown>("translation");
    const ticket = useRef(0);

    const parsed = websiteUrl.safeParse(address);

    // Fetch the page when an address is asked for.
    useEffect(() => {
        if (!asked) return;
        const mine = ++ticket.current;
        const controller = new AbortController();
        setPage(null);
        setTranslated([]);
        setError(null);
        setLoading(true);
        void (async () => {
            try {
                const response = await fetch("/api/translate/website", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ url: asked }),
                    signal: controller.signal
                });
                const answer = (await response.json().catch(() => ({}))) as {
                    url?: string;
                    html?: string;
                    message?: string;
                };
                if (!response.ok || typeof answer.html !== "string") {
                    throw new Error(answer.message || t("website.unreachable"));
                }
                const read = readHtml(answer.html, answer.url ?? asked);
                if (mine !== ticket.current) return;
                if (read.blocks.length === 0) throw new Error(t("website.empty"));
                setPage(read);
            } catch (caught) {
                if (controller.signal.aborted || mine !== ticket.current) return;
                setError((caught as Error).message);
                setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [asked, t]);

    // Translated in bounded batches, again whenever the languages change.
    useEffect(() => {
        if (!page) return;
        const controller = new AbortController();
        const texts = page.blocks.map((block) => block.text);
        const total = texts.reduce((sum, text) => sum + text.length, 0);
        if (charLimit !== null && total > charLimit) {
            setError(t("errors.overLimit", { limit: charLimit }));
            setLoading(false);
            return;
        }
        setTranslated(texts.map(() => null));
        setLoading(true);
        void (async () => {
            try {
                for (let at = 0; at < texts.length; at += BATCH) {
                    const answer = await translate(texts.slice(at, at + BATCH), controller.signal);
                    if (controller.signal.aborted) return;
                    setTranslated((now) => {
                        const next = [...now];
                        answer.texts.forEach((text, index) => (next[at + index] = text));
                        return next;
                    });
                }
                setError(null);
            } catch (caught) {
                if (!controller.signal.aborted) setError((caught as Error).message);
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [page, translate, charLimit, t]);

    const done = translated.filter((text) => text !== null).length;

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <form
                className="flex min-w-0 items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!parsed.success) return;
                    setAddress(parsed.data);
                    setAsked(parsed.data);
                }}
            >
                <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                    className="min-w-0 flex-1"
                    value={address}
                    inputMode="url"
                    aria-label={t("website.address")}
                    placeholder={t("website.placeholder")}
                    aria-invalid={address.trim() !== "" && !parsed.success}
                    onChange={(event) => setAddress(event.target.value)}
                />
                <Button type="submit" size="sm" disabled={!parsed.success}>
                    {t("website.translate")}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={onClose}
                    aria-label={t("website.close")}
                    title={t("website.close")}
                >
                    <X className="size-4 shrink-0" aria-hidden />
                </Button>
            </form>
            {address.trim() !== "" && !parsed.success ? (
                <p className="text-xs text-destructive">{t("website.invalid")}</p>
            ) : null}

            {page ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <SegmentedControl
                        aria-label={t("website.view")}
                        value={shown}
                        onValueChange={setShown}
                        options={[
                            { value: "translation", label: t("website.translation") },
                            { value: "original", label: t("website.original") }
                        ]}
                    />
                    <span
                        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                        role="status"
                    >
                        {error ? (
                            <span className="text-destructive">{error}</span>
                        ) : loading ? (
                            t("website.progress", { done, total: page.blocks.length })
                        ) : null}
                    </span>
                    <Button asChild variant="outline" size="sm">
                        <a href={asked} target="_blank" rel="noopener noreferrer nofollow">
                            <ExternalLink className="size-4 shrink-0" aria-hidden />
                            {t("website.openOriginal")}
                        </a>
                    </Button>
                </div>
            ) : null}

            <article className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-base">
                {page ? (
                    <>
                        {page.title ? (
                            <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">
                                {page.title}
                            </h1>
                        ) : null}
                        {page.blocks.map((block, index) => (
                            <Block
                                key={index}
                                block={block}
                                text={
                                    shown === "original"
                                        ? block.text
                                        : (translated[index] ?? block.text)
                                }
                            />
                        ))}
                    </>
                ) : loading ? (
                    <div className="space-y-2" role="status" aria-label={t("website.fetching")}>
                        <Skeleton className="h-6 w-1/2" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">{error ?? t("website.hint")}</p>
                )}
            </article>
        </div>
    );
}
