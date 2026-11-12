"use client";

/**
 * The reader's own Polaris addresses: several can be saved and named, and the
 * one in use fills every example on the site. Kept in this browser only; every
 * storage access is guarded, since a private window or blocked site data throws
 * on it, and then the list lasts for this visit.
 */

import { Check, Plus, Settings2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ImageViewer, type ViewedImage } from "@polaris/ui/image-viewer";
import { viewerLabels, type ViewerWords } from "@/components/shot-gallery";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    cn
} from "@polaris/ui";
import { HOST_LIST_MAX, HOST_NAME_MAX } from "@polaris/core";
import { EXAMPLE_HOST, withReaderOrigin } from "@/lib/example-origin";
import * as hostStore from "@/lib/host-store";
import type { HostState, SavedHost } from "@/lib/host-store";

const EVENT = "polaris-site-hosts";

function read(): HostState {
    try {
        return hostStore.loadHosts(window.localStorage);
    } catch {
        return hostStore.EMPTY_HOSTS;
    }
}

let current: HostState | undefined;

function write(next: HostState): void {
    current = next;
    try {
        hostStore.saveHosts(window.localStorage, next);
    } catch {
        // Not kept past this page; the examples still change for now.
    }
    window.dispatchEvent(new Event(EVENT));
}

function subscribe(changed: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key !== null && ![hostStore.HOSTS_KEY, hostStore.ACTIVE_KEY, hostStore.LEGACY_KEY].includes(event.key)) return;
        current = read();
        changed();
    };
    window.addEventListener(EVENT, changed);
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(EVENT, changed);
        window.removeEventListener("storage", onStorage);
    };
}

/** Every saved host and the one in use. Empty on the server and the first paint. */
export function useHostState(): HostState {
    return useSyncExternalStore(
        subscribe,
        () => (current ??= read()),
        () => hostStore.EMPTY_HOSTS
    );
}

/** The origin the examples use, or null for the placeholder. */
export function useReaderOrigin(): string | null {
    return useHostState().active;
}

/**
 * Built-at-build-time HTML with the reader's address in its examples. With
 * `viewer`, every picture in it opens in Polaris's own picture viewer, the one
 * the dashboard and the site's galleries use, and the pictures are looked
 * through in order with its arrows.
 */
export function HostedHtml({
    html,
    className,
    viewer
}: {
    html: string;
    className?: string;
    viewer?: ViewerWords;
}) {
    const origin = useReaderOrigin();
    const box = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState<ViewedImage | null>(null);
    const [gallery, setGallery] = useState<ViewedImage[]>([]);
    const shown = withReaderOrigin(html, origin, true);

    // Pictures that are a link's content keep the link; every other one opens.
    // After every commit, not once: React can write the HTML again on an update
    // (the address changing, hydration settling), which drops these attributes.
    useEffect(() => {
        if (!viewer || !box.current) return;
        for (const img of viewerPictures(box.current)) {
            img.tabIndex = 0;
            img.setAttribute("role", "button");
            img.setAttribute("aria-label", `${viewer.open}: ${img.alt}`);
            img.classList.add("cursor-zoom-in");
        }
    });

    function openFrom(target: EventTarget | null) {
        if (!viewer || !box.current || !(target instanceof HTMLImageElement)) return false;
        const pictures = viewerPictures(box.current);
        if (!pictures.includes(target)) return false;
        const all = pictures.map((img) => ({ url: img.currentSrc || img.src, name: img.alt }));
        setGallery(all);
        setOpen(all[pictures.indexOf(target)] ?? null);
        return true;
    }

    return (
        <>
            <div
                ref={box}
                className={className}
                onClick={viewer ? (event) => void openFrom(event.target) : undefined}
                onKeyDown={
                    viewer
                        ? (event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              if (openFrom(event.target)) event.preventDefault();
                          }
                        : undefined
                }
                // Rendered at build time from this repository's own text; the address is validated and escaped.
                dangerouslySetInnerHTML={{ __html: shown }}
            />
            {viewer ? (
                <ImageViewer
                    image={open}
                    onClose={() => setOpen(null)}
                    gallery={open && gallery.length > 1 ? gallery : undefined}
                    onNavigate={setOpen}
                    labels={viewerLabels(viewer)}
                />
            ) : null}
        </>
    );
}

/** The pictures worth enlarging: not a link's content, and not an icon drawn at a small fixed width. */
function viewerPictures(root: HTMLElement): HTMLImageElement[] {
    return [...root.querySelectorAll("img")].filter((img) => {
        const width = Number(img.getAttribute("width"));
        return !img.closest("a") && !(width > 0 && width < ICON_WIDTH);
    });
}

const ICON_WIDTH = 96;

export interface HostFieldWords {
    label: string;
    hint: string;
    invalid: string;
    example: string;
    add: string;
    manage: string;
    title: string;
    intro: string;
    address: string;
    name: string;
    namePlaceholder: string;
    use: string;
    inUse: string;
    removeNamed: string;
    duplicate: string;
    full: string;
    empty: string;
    done: string;
}

const NONE = "";

/** The picker beside the examples: which saved address they use, and the button to manage the list. */
export function HostField({ words, className }: { words: HostFieldWords; className?: string }) {
    const state = useHostState();
    const [open, setOpen] = useState(false);
    const options = [
        { value: NONE, label: words.example.replace("{host}", EXAMPLE_HOST) },
        ...state.hosts.map((host) => ({ value: host.origin, label: hostStore.hostLabel(host) }))
    ];
    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span className="shrink-0 text-muted-foreground">{words.label}</span>
                {state.hosts.length ? (
                    <Select
                        value={state.active ?? NONE}
                        onValueChange={(origin) => write(hostStore.pickHost(state, origin || null))}
                        options={options}
                        aria-label={words.label}
                        className="min-w-0 flex-1 sm:max-w-xs"
                    />
                ) : null}
                <Button
                    variant="outline"
                    size="md"
                    onClick={() => setOpen(true)}
                    className="shrink-0"
                >
                    {state.hosts.length ? (
                        <Settings2 className="size-4 shrink-0" aria-hidden="true" />
                    ) : (
                        <Plus className="size-4 shrink-0" aria-hidden="true" />
                    )}
                    <span className="ml-1.5">{state.hosts.length ? words.manage : words.add}</span>
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">{words.hint}</p>
            <HostsDialog open={open} onOpenChange={setOpen} state={state} words={words} />
        </div>
    );
}

function HostsDialog({
    open,
    onOpenChange,
    state,
    words
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    state: HostState;
    words: HostFieldWords;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex flex-col gap-4">
                <DialogHeader>
                    <DialogTitle>{words.title}</DialogTitle>
                    <DialogDescription>{words.intro}</DialogDescription>
                </DialogHeader>
                {state.hosts.length ? (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {state.hosts.map((host) => (
                            <HostRow
                                key={host.origin}
                                host={host}
                                active={host.origin === state.active}
                                state={state}
                                words={words}
                            />
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">{words.empty}</p>
                )}
                <AddHostForm state={state} words={words} />
                <DialogFooter>
                    <DialogClose asChild>
                        <Button variant="secondary">{words.done}</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function HostRow({
    host,
    active,
    state,
    words
}: {
    host: SavedHost;
    active: boolean;
    state: HostState;
    words: HostFieldWords;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft !== null && draft !== (host.name ?? "")) write(hostStore.renameHost(state, host.origin, draft));
        setDraft(null);
    };
    const label = hostStore.hostLabel(host);
    return (
        <li className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Input
                    value={draft ?? host.name ?? ""}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") commit();
                    }}
                    maxLength={HOST_NAME_MAX}
                    placeholder={words.namePlaceholder}
                    aria-label={`${words.name}: ${host.origin}`}
                />
                <code className="truncate text-xs text-muted-foreground" title={host.origin}>
                    {host.origin}
                </code>
            </div>
            <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                {active ? (
                    <span className="inline-flex h-7 items-center gap-1 px-2 text-xs text-success">
                        <Check className="size-3.5 shrink-0" aria-hidden="true" />
                        {words.inUse}
                    </span>
                ) : (
                    <Button size="sm" variant="outline" onClick={() => write(hostStore.pickHost(state, host.origin))}>
                        {words.use}
                    </Button>
                )}
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={words.removeNamed.replace("{label}", label)}
                    title={words.removeNamed.replace("{label}", label)}
                    onClick={() => write(hostStore.removeHost(state, host.origin))}
                >
                    <Trash2 className="size-4" />
                </Button>
            </div>
        </li>
    );
}

function AddHostForm({ state, words }: { state: HostState; words: HostFieldWords }) {
    const [address, setAddress] = useState("");
    const [name, setName] = useState("");
    const origin = hostStore.parseHostAddress(address);
    const duplicate = !!origin && state.hosts.some((host) => host.origin === origin);
    const full = state.hosts.length >= HOST_LIST_MAX;
    // An empty field is unfinished, not wrong: no message until something is typed.
    const problem =
        address.trim() === ""
            ? null
            : !origin
              ? words.invalid
              : duplicate
                ? words.duplicate
                : full
                  ? words.full
                  : null;
    const ready = !!origin && !problem;

    function submit(event: FormEvent) {
        event.preventDefault();
        if (!ready) return;
        const result = hostStore.addHost(state, address, name);
        if (!result.ok) return;
        write(result.state);
        setAddress("");
        setName("");
    }

    return (
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-2">
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[3fr_2fr]">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                    <span>
                        {words.address} <span aria-hidden="true">*</span>
                    </span>
                    <Input
                        value={address}
                        onChange={(event) => setAddress(event.target.value)}
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        required
                        placeholder={EXAMPLE_HOST}
                        aria-invalid={problem ? true : undefined}
                        aria-describedby="host-add-problem"
                        className={cn("font-mono", problem && "border-danger")}
                    />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                    <span>{words.name}</span>
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={HOST_NAME_MAX}
                        placeholder={words.namePlaceholder}
                    />
                </label>
            </div>
            <div className="flex min-w-0 items-start justify-between gap-2">
                <p
                    id="host-add-problem"
                    aria-live="polite"
                    className="min-w-0 text-xs text-danger"
                >
                    {problem}
                </p>
                <Button type="submit" size="sm" aria-disabled={!ready} className="shrink-0">
                    <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="ml-1">{words.add}</span>
                </Button>
            </div>
        </form>
    );
}
