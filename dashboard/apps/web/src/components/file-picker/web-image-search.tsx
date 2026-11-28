"use client";

/**
 * The picker's "Search the web" tab: type, see a grid of openly licensed
 * images, choose, and the choice comes back as an ordinary file.
 *
 * Every byte comes through this server (`/api/picker/web-images`): the grid's
 * thumbnails and the chosen image alike, so the host an image lives on never
 * sees the reader's address. A chosen image is handed back as an upload - a
 * `File` with its credit beside it - so whatever the screen does with a file
 * from the machine (upload it to Drive, crop it into an avatar, keep it on the
 * device) it does with this one, and no screen has to learn a new kind.
 */

import { moveFocus } from "./grid-keys";
import type { PickedFile } from "./picked-file";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Check, Globe, ImageOff, Loader2, Search } from "lucide-react";
import { cn, Button, EmptyState, Input, Skeleton, Switch } from "@polaris/ui";
import {
    normalizeWebImageQuery,
    webImageAddress,
    WEB_IMAGE_QUERY_MAX,
    type WebImage,
    type WebImagePage
} from "@/lib/web-images/shape";

/** How long typing settles before it is a search. */
export const WEB_SEARCH_DEBOUNCE_MS = 300;

/** Pages already seen in this tab's lifetime, so typing back to a word, or
 *  reopening the picker, paints at once. Bounded and short-lived. */
const seen = new Map<string, { at: number; page: WebImagePage }>();
const SEEN_MS = 5 * 60 * 1000;
const SEEN_MAX = 100;

function remembered(key: string): WebImagePage | null {
    const known = seen.get(key);
    if (!known || Date.now() - known.at > SEEN_MS) return null;
    return known.page;
}

function remember(key: string, page: WebImagePage): void {
    seen.delete(key);
    seen.set(key, { at: Date.now(), page });
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
}

type Problem = "" | "failed" | "busy";

export function WebImageSearch({
    types,
    multiple,
    onPick,
    onCancel
}: {
    /** The image types the screen takes. */
    types: readonly string[];
    multiple: boolean;
    onPick: (files: PickedFile[]) => void;
    onCancel: () => void;
}) {
    const t = useTranslations("components");
    const [typed, setTyped] = useState("");
    const [query, setQuery] = useState("");
    const [safe, setSafe] = useState(true);
    const [results, setResults] = useState<WebImage[]>([]);
    const [page, setPage] = useState(1);
    const [more, setMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [problem, setProblem] = useState<Problem>("");
    const [chosen, setChosen] = useState<WebImage[]>([]);
    const [fetching, setFetching] = useState(false);
    const [pickProblem, setPickProblem] = useState("");
    const grid = useRef<HTMLUListElement | null>(null);
    const end = useRef<HTMLLIElement | null>(null);
    const inFlight = useRef<AbortController | null>(null);

    // Typing settles before it is a search; the field itself answers at once.
    useEffect(() => {
        const timer = setTimeout(() => setQuery(normalizeWebImageQuery(typed)), WEB_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [typed]);

    const load = useCallback(
        async (wanted: number) => {
            inFlight.current?.abort();
            if (!query) {
                setResults([]);
                setMore(false);
                setLoading(false);
                setProblem("");
                return;
            }
            const key = `${safe ? 1 : 0}:${wanted}:${query}`;
            const known = remembered(key);
            if (known) {
                setResults((held) => (wanted === 1 ? [...known.results] : merge(held, known.results)));
                setMore(known.more);
                setPage(wanted);
                setProblem("");
                setLoading(false);
                return;
            }
            const controller = new AbortController();
            inFlight.current = controller;
            setLoading(true);
            setProblem("");
            if (wanted === 1) setResults([]);
            try {
                const answer = await fetch(
                    `/api/picker/web-images?q=${encodeURIComponent(query)}&page=${wanted}&safe=${safe ? 1 : 0}`,
                    { signal: controller.signal }
                );
                if (!answer.ok) {
                    setProblem(answer.status === 429 ? "busy" : "failed");
                    setMore(false);
                    return;
                }
                const body = (await answer.json()) as WebImagePage;
                remember(key, body);
                setResults((held) => (wanted === 1 ? [...body.results] : merge(held, body.results)));
                setMore(body.more);
                setPage(wanted);
            } catch (caught) {
                if ((caught as { name?: string }).name === "AbortError") return;
                setProblem("failed");
                setMore(false);
            } finally {
                if (inFlight.current === controller) {
                    inFlight.current = null;
                    setLoading(false);
                }
            }
        },
        [query, safe]
    );

    useEffect(() => {
        setChosen([]);
        void load(1);
        return () => inFlight.current?.abort();
    }, [load]);

    // The next page loads as the end of the grid comes into view.
    useEffect(() => {
        const target = end.current;
        if (!target || !more || loading || problem || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (seenNow) => {
                if (seenNow.some((one) => one.isIntersecting)) void load(page + 1);
            },
            { root: grid.current, rootMargin: "200px" }
        );
        observer.observe(target);
        return () => observer.disconnect();
    }, [more, loading, problem, page, load, results.length]);

    function toggle(image: WebImage): void {
        setPickProblem("");
        setChosen((held) =>
            held.some((one) => one.id === image.id)
                ? held.filter((one) => one.id !== image.id)
                : multiple
                  ? [...held, image]
                  : [image]
        );
    }

    async function attach(list: readonly WebImage[] = chosen): Promise<void> {
        if (list.length === 0 || fetching) return;
        setFetching(true);
        setPickProblem("");
        try {
            const picks: PickedFile[] = [];
            for (const image of list) {
                const answer = await fetch(webImageAddress(image.id, "full"));
                if (!answer.ok) throw new Error("unfetched");
                const named = answer.headers.get("x-polaris-filename");
                const bytes = await answer.blob();
                if (!types.includes(bytes.type)) {
                    setPickProblem(t("files.web.wrongType"));
                    return;
                }
                const name = named ? decodeURIComponent(named) : "image";
                picks.push({ kind: "upload", file: new File([bytes], name, { type: bytes.type }), credit: image.credit });
            }
            onPick(picks);
        } catch {
            setPickProblem(t("files.web.fetchFailed"));
        } finally {
            setFetching(false);
        }
    }

    const first = loading && results.length === 0;
    const last = chosen.at(-1);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2">
                <div className="relative min-w-0 flex-1 basis-40">
                    <Search
                        className="pointer-events-none absolute start-2 top-1/2 size-3.5 shrink-0 -translate-y-1/2 text-foreground-subtle"
                        aria-hidden
                    />
                    <Input
                        type="search"
                        value={typed}
                        maxLength={WEB_IMAGE_QUERY_MAX}
                        placeholder={t("files.web.search")}
                        aria-label={t("files.web.search")}
                        enterKeyHint="search"
                        autoCapitalize="none"
                        autoFocus
                        className="h-7 ps-7 text-[12px]"
                        onChange={(event) => setTyped(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") setQuery(normalizeWebImageQuery(typed));
                            if (event.key === "ArrowDown") {
                                const tile = grid.current?.querySelector<HTMLElement>("[data-web-image]");
                                if (tile) {
                                    event.preventDefault();
                                    tile.focus();
                                }
                            }
                        }}
                    />
                </div>
                <label className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
                    <Switch checked={safe} onChange={setSafe} aria-label={t("files.web.safe")} />
                    <span>{t("files.web.safe")}</span>
                </label>
            </div>

            <ul
                ref={grid}
                aria-label={t("files.web.results")}
                aria-busy={loading}
                onKeyDown={(event) => {
                    moveFocus(event, grid.current, "[data-web-image]", true);
                }}
                className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] content-start gap-1 overflow-y-auto overflow-x-hidden overscroll-contain p-1"
            >
                {results.map((image) => {
                    const isChosen = chosen.some((one) => one.id === image.id);
                    const title = image.title || t("files.web.untitled");
                    return (
                        <li key={image.id} className="min-w-0">
                            <button
                                type="button"
                                data-web-image=""
                                aria-pressed={isChosen}
                                aria-label={t("files.web.result", { title, license: image.credit.license })}
                                title={title}
                                onClick={() => toggle(image)}
                                onDoubleClick={() => {
                                    if (!multiple) {
                                        setChosen([image]);
                                        void attach([image]);
                                    }
                                }}
                                className={cn(
                                    "relative block aspect-square w-full overflow-hidden rounded-md border bg-muted",
                                    isChosen ? "border-primary ring-2 ring-primary/40" : "border-transparent"
                                )}
                            >
                                <img
                                    src={webImageAddress(image.id, "thumb")}
                                    alt=""
                                    loading="lazy"
                                    decoding="async"
                                    className="size-full object-cover"
                                />
                                {isChosen ? (
                                    <Check
                                        className="absolute end-1.5 top-1.5 size-4 shrink-0 rounded-full bg-primary p-0.5 text-primary-foreground"
                                        aria-hidden
                                    />
                                ) : null}
                            </button>
                        </li>
                    );
                })}
                {loading
                    ? Array.from({ length: first ? 12 : 4 }, (_, index) => (
                          <li key={`skeleton-${index}`} aria-hidden data-testid="web-image-skeleton">
                              <Skeleton className="aspect-square w-full" />
                          </li>
                      ))
                    : null}
                {!loading && results.length === 0 ? (
                    <li className="col-span-full p-6">
                        {problem ? (
                            <EmptyState
                                icon={<ImageOff className="size-5 shrink-0" aria-hidden />}
                                title={problem === "busy" ? t("files.web.busy") : t("files.web.failed")}
                                description={t("files.web.failedHint")}
                                action={
                                    <Button variant="ghost" onClick={() => void load(1)}>
                                        {t("files.web.retry")}
                                    </Button>
                                }
                            />
                        ) : query ? (
                            <EmptyState
                                icon={<ImageOff className="size-5 shrink-0" aria-hidden />}
                                title={t("files.web.none", { query })}
                                description={t("files.web.noneHint")}
                            />
                        ) : (
                            <EmptyState
                                icon={<Globe className="size-5 shrink-0" aria-hidden />}
                                title={t("files.web.start")}
                                description={t("files.web.startHint")}
                            />
                        )}
                    </li>
                ) : null}
                {problem && results.length > 0 && !loading ? (
                    <li className="col-span-full flex items-center justify-center gap-2 p-3 text-[12px] text-muted-foreground">
                        {problem === "busy" ? t("files.web.busy") : t("files.web.failed")}
                        <Button variant="ghost" onClick={() => void load(page + 1)}>
                            {t("files.web.retry")}
                        </Button>
                    </li>
                ) : null}
                {more && !loading && !problem ? <li ref={end} className="col-span-full h-px" aria-hidden /> : null}
            </ul>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border p-2">
                <p className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" aria-live="polite">
                    {pickProblem ? (
                        <span className="text-destructive">{pickProblem}</span>
                    ) : last ? (
                        <Credit image={last} />
                    ) : (
                        t("files.noneChosen")
                    )}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                    <Button variant="ghost" onClick={onCancel}>
                        {t("ui.cancel")}
                    </Button>
                    <Button aria-disabled={chosen.length === 0 || fetching} onClick={() => void attach()}>
                        {fetching ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : null}
                        {fetching ? t("files.web.fetching") : t("files.attach")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

/** Who made it and on what license, linked to where it is published. */
function Credit({ image }: { image: WebImage }) {
    const t = useTranslations("components");
    const { credit } = image;
    const title = image.title || t("files.web.untitled");
    const link = (href: string, label: string) =>
        href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                {label}
            </a>
        ) : (
            label
        );
    return (
        <span title={[title, credit.creator, credit.license].filter(Boolean).join(" - ")}>
            {link(credit.sourceUrl, title)}
            {credit.creator ? ` ${t("files.web.by", { creator: credit.creator })}` : null}
            {credit.license ? <> - {link(credit.licenseUrl, credit.license)}</> : null}
        </span>
    );
}

/** A next page appended, without repeating one already on screen. */
function merge(held: readonly WebImage[], next: readonly WebImage[]): WebImage[] {
    const ids = new Set(held.map((one) => one.id));
    return [...held, ...next.filter((one) => !ids.has(one.id))];
}
