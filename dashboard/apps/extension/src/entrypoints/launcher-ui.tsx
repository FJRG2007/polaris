/**
 * The search drawn over a page: the dashboard's own search panel
 * (`@polaris/ui/search-panel`, the component its command palette draws), in a
 * closed shadow root with the dashboard's tokens and classes inside it, so a
 * page can neither restyle nor read it and the panel looks as it does in Polaris.
 *
 * Not loaded with the page: `launcher.ts` is the one key listener every page
 * gets, and this script - React and the panel - is put into the tab by the
 * worker on the first press (`launcherShow`), then answers every press after.
 */

import styles from "virtual:search-styles";
import { createRoot } from "react-dom/client";
import { House, Compass } from "lucide-react";
import { ENGLISH_UI_STRINGS, UiStringsProvider } from "@polaris/ui/ui-strings";
import { searchTerms, stepActive } from "@polaris/ui/search-match";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LauncherEntry, LauncherWords, Reply, Request } from "@/lib/messages";
import { SearchItem, SearchMessage, SearchOption, SearchSheet, SearchSkeleton } from "@polaris/ui/search-panel";

/** What `launcher.ts` calls on a press once this script is in the page. */
declare global {
    var polarisLauncher: (() => void) | undefined;
}

/** The worker, asked without `askBackground`, whose fallback sentence would
 *  pull the whole catalog into this bundle. */
async function askBackground(request: Request): Promise<Reply> {
    try {
        const reply = (await browser.runtime.sendMessage(request)) as Reply | undefined;
        return reply && typeof reply === "object" && "ok" in reply ? reply : { ok: false, error: "" };
    } catch {
        return { ok: false, error: "" };
    }
}

/** Entries matching every word of `query`, in their order, capped. */
function matching(entries: readonly LauncherEntry[], query: string): LauncherEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return entries.slice(0, 8);
    return entries
        .filter((entry) => {
            const text = `${entry.label} ${entry.context}`.toLowerCase();
            return words.every((word) => text.includes(word));
        })
        .slice(0, 50);
}

const LIST_ID = "polaris-launcher-list";

function rowId(index: number): string {
    return `polaris-launcher-row-${index}`;
}

function Launcher({ onClose }: { onClose: () => void }) {
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const [entries, setEntries] = useState<readonly LauncherEntry[] | null>(null);
    const [words, setWords] = useState<LauncherWords | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        void askBackground({ kind: "launcherIndex" }).then((reply) => {
            if (!reply.ok || !("launcher" in reply)) {
                setFailure(reply.ok ? "" : reply.error);
                return;
            }
            setWords(reply.launcher.words);
            setEntries(reply.launcher.entries);
        });
    }, []);

    const shown = matching(entries ?? [], query);
    const current = Math.min(active, Math.max(shown.length - 1, 0));
    useEffect(() => {
        list.current?.querySelector(`#${rowId(current)}`)?.scrollIntoView({ block: "nearest" });
    }, [current]);

    const choose = (entry: LauncherEntry | undefined) => {
        if (!entry) return;
        onClose();
        void askBackground({ kind: "launcherOpen", href: entry.href });
    };
    const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
        // The page's own shortcuts never see what is typed here.
        event.stopPropagation();
        const next = stepActive(event.key, current, shown.length);
        if (next !== null) {
            event.preventDefault();
            setActive(next);
        } else if (event.key === "Enter") {
            event.preventDefault();
            choose(shown[current]);
        } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
        }
    };

    const terms = searchTerms(query);
    return (
        <UiStringsProvider strings={words ? { ...ENGLISH_UI_STRINGS, close: words.close } : ENGLISH_UI_STRINGS}>
            <SearchSheet
                title={words?.placeholder ?? ""}
                onClose={onClose}
                query={query}
                onQueryChange={(text) => {
                    setQuery(text);
                    setActive(0);
                }}
                onFieldKeyDown={onKey}
                placeholder={words?.placeholder ?? ""}
                fieldProps={{ enterKeyHint: "go" }}
                activeId={shown.length ? rowId(current) : undefined}
                listId={LIST_ID}
                listLabel={words?.results ?? ""}
                listRef={list}
                footer={
                    words ? (
                        <>
                            <span>{words.hintMove}</span>
                            <span>{words.hintClose}</span>
                        </>
                    ) : null
                }
            >
                {failure !== null ? (
                    <SearchMessage tone="danger">{failure}</SearchMessage>
                ) : entries === null ? (
                    <SearchSkeleton />
                ) : shown.length === 0 ? (
                    <SearchMessage>{words?.empty}</SearchMessage>
                ) : (
                    shown.map((entry, at) => {
                        const Icon = entry.href === "/" && !entry.context ? House : Compass;
                        return (
                            <SearchOption
                                key={`${entry.href}-${entry.label}`}
                                id={rowId(at)}
                                selected={at === current}
                                label={entry.label}
                                onSelect={() => choose(entry)}
                                onHover={() => setActive(at)}
                            >
                                <SearchItem
                                    icon={<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                                    label={entry.label}
                                    context={entry.context}
                                    terms={terms}
                                />
                            </SearchOption>
                        );
                    })
                )}
            </SearchSheet>
        </UiStringsProvider>
    );
}

function open(): void {
    const host = document.createElement("polaris-launcher");
    // The dashboard's theme follows the machine's here: dark, or light when it is.
    host.className = "system";
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = styles;
    const mount = document.createElement("div");
    // Where the dashboard's `html` and `body` rules land (search-styles' shadowRoot).
    mount.setAttribute("data-search-root", "");
    shadow.append(style, mount);
    document.documentElement.append(host);
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = createRoot(mount);
    const close = (): void => {
        root.unmount();
        host.remove();
        globalThis.polarisLauncher = open;
        before?.focus();
    };
    globalThis.polarisLauncher = close;
    root.render(<Launcher onClose={close} />);
}

export default defineUnlistedScript({
    main() {
        if (window.top !== window || globalThis.polarisLauncher) return;
        open();
    }
});
