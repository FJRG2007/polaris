"use client";

/**
 * The provider list of "New storage connection".
 *
 * Data-driven so it keeps working as providers are added: every kind sits in one
 * group, carries its mark, and is found by a search over its name, its one-line
 * description and a few words people actually type ("nas", "aws", "ssh"). The
 * marks are the vendors' own (Simple Icons, the vendor's brand kit, or the
 * Microsoft file on Wikimedia Commons for OneDrive), drawn on a white tile so a
 * dark navy or a pale grey mark reads in either theme. Protocols with no brand
 * get a plain icon.
 */

import { cn } from "@polaris/ui";
import type { StorageProviderKind } from "@polaris/core";
import { useMemo, useState, type ComponentType } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ChevronRight, FolderTree, Globe, Network, Search, Server, Terminal } from "lucide-react";

type PickerKind = Exclude<StorageProviderKind, "personal">;
type Group = "nas" | "cloud" | "protocols" | "server";

interface ProviderEntry {
    readonly kind: PickerKind;
    readonly group: Group;
    /** A vendor file under /public/logos (storage, or the brands the store lists), or a plain icon for a protocol. */
    readonly logo?: string;
    /** Whether the mark needs the dark tile (a pale mark that vanishes on white). */
    readonly darkTile?: boolean;
    readonly icon?: ComponentType<{ className?: string }>;
    /** Words a person may search by that are not in the name or description. */
    readonly keywords: readonly string[];
}

/** Every kind the picker offers, in display order. A new provider is one row. */
export const PROVIDERS: readonly ProviderEntry[] = [
    { kind: "unifi-unas", group: "nas", logo: "/logos/storage/ubiquiti.svg", keywords: ["ubiquiti", "unifi", "unas", "nas"] },
    { kind: "synology", group: "nas", logo: "/logos/storage/synology.svg", darkTile: true, keywords: ["dsm", "nas"] },
    { kind: "qnap", group: "nas", logo: "/logos/storage/qnap.svg", keywords: ["qts", "nas"] },
    { kind: "truenas", group: "nas", logo: "/logos/storage/truenas.svg", keywords: ["freenas", "zfs", "nas"] },
    { kind: "gdrive", group: "cloud", logo: "/logos/brands/google-drive.svg", keywords: ["google", "drive", "cloud"] },
    { kind: "onedrive", group: "cloud", logo: "/logos/storage/onedrive.svg", keywords: ["microsoft", "office", "cloud"] },
    { kind: "dropbox", group: "cloud", logo: "/logos/brands/dropbox.svg", keywords: ["cloud"] },
    { kind: "s3", group: "cloud", logo: "/logos/storage/amazon-s3.svg", keywords: ["aws", "amazon", "minio", "r2", "bucket", "b2", "wasabi"] },
    { kind: "sftp", group: "protocols", icon: Terminal, keywords: ["ssh", "scp"] },
    { kind: "smb", group: "protocols", icon: Network, keywords: ["cifs", "samba", "windows", "share"] },
    { kind: "nfs", group: "protocols", icon: Server, keywords: ["export", "unix"] },
    { kind: "webdav", group: "protocols", icon: Globe, keywords: ["nextcloud", "owncloud", "dav", "http"] },
    { kind: "local", group: "server", icon: FolderTree, keywords: ["disk", "folder", "path", "server"] }
];

const GROUPS: readonly Group[] = ["nas", "cloud", "protocols", "server"];

/** Lowercased and without accents, so "unidad" finds "Unidad" and "dropbox" finds "Dropbox". */
function fold(text: string): string {
    return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The entries matching every word of the query, in display order. */
export function matchProviders(
    query: string,
    words: (kind: PickerKind) => string
): readonly ProviderEntry[] {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return PROVIDERS;
    return PROVIDERS.filter((entry) => {
        const haystack = fold(`${entry.kind} ${words(entry.kind)} ${entry.keywords.join(" ")}`);
        return terms.every((term) => haystack.includes(term));
    });
}

export function ProviderMark({ entry }: { entry: ProviderEntry }) {
    const Icon = entry.icon;
    return (
        <span
            aria-hidden="true"
            className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md",
                entry.logo
                    ? entry.darkTile
                        ? "bg-neutral-900 ring-1 ring-border"
                        : "bg-white ring-1 ring-border"
                    : "bg-muted text-muted-foreground"
            )}
        >
            {entry.logo ? (
                <img src={entry.logo} alt="" className="size-5 shrink-0 object-contain" />
            ) : Icon ? (
                <Icon className="size-4 shrink-0" />
            ) : null}
        </span>
    );
}

export function ProviderPicker({
    label,
    description,
    onChoose,
    hidden
}: {
    label: (kind: PickerKind) => string;
    description: (kind: PickerKind) => string;
    onChoose: (kind: PickerKind) => void;
    /** Kinds this reader may not connect, left out of the list. */
    hidden?: readonly PickerKind[];
}) {
    const t = useTranslations("drive");
    const [query, setQuery] = useState("");
    const shown = useMemo(
        () =>
            matchProviders(query, (kind) => `${label(kind)} ${description(kind)}`).filter(
                (entry) => !hidden?.includes(entry.kind)
            ),
        [query, label, description, hidden]
    );

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <label className="relative flex min-w-0 items-center">
                <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden />
                <input
                    type="search"
                    value={query}
                    autoFocus
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        // Enter takes the first match, so a typed name is one key away.
                        if (event.key === "Enter" && shown[0]) {
                            event.preventDefault();
                            onChoose(shown[0].kind);
                        }
                    }}
                    placeholder={t("connection.picker.search")}
                    aria-label={t("connection.picker.search")}
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
            </label>

            <div className="flex max-h-[min(26rem,55vh)] min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain pr-0.5">
                {shown.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        {t("connection.picker.none")}
                    </p>
                ) : (
                    GROUPS.map((group) => {
                        const entries = shown.filter((entry) => entry.group === group);
                        if (entries.length === 0) return null;
                        return (
                            <section key={group} className="flex min-w-0 flex-col gap-2" aria-label={t(`connection.picker.groups.${group}`)}>
                                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {t(`connection.picker.groups.${group}`)}
                                </h3>
                                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                                    {entries.map((entry) => (
                                        <button
                                            key={entry.kind}
                                            type="button"
                                            onClick={() => onChoose(entry.kind)}
                                            className={cn(
                                                "flex min-w-0 items-center gap-3 rounded-md border p-2.5 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                                entry.kind === "unifi-unas" ? "border-primary/60 bg-primary/5" : "border-border"
                                            )}
                                        >
                                            <ProviderMark entry={entry} />
                                            <span className="flex min-w-0 flex-1 flex-col">
                                                <span className="truncate text-sm font-medium">{label(entry.kind)}</span>
                                                <span className="line-clamp-2 text-xs text-muted-foreground">
                                                    {description(entry.kind)}
                                                </span>
                                            </span>
                                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                        </button>
                                    ))}
                                </div>
                            </section>
                        );
                    })
                )}
            </div>
        </div>
    );
}
