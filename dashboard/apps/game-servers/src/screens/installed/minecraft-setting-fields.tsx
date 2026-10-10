"use client";

/**
 * The two settings of a Java server that are picked from long lists: the
 * software it runs and the release it runs.
 *
 * Both are the same searchable select the create dialog uses, so a server is
 * changed the way it was made. The release list is Minecraft's own; when it
 * cannot be read the field goes back to taking a typed release, which is what it
 * was before there was a list, rather than leaving nothing to choose from.
 */

import { useGameText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useMemo, useState } from "react";
import { minecraftReleasesAction } from "../actions";
import { SoftwareLogo } from "../../components/software-logo";
import { Input, SearchableSelect, Skeleton } from "@polaris/ui";

const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;

/** Minecraft ships a release every few weeks; a day-old list is still right. */
const KEPT_RELEASES_MS = 24 * 3_600_000;
const RELEASES_KEY = "minecraft-releases";

/** What the image reads as "whatever is newest". */
const LATEST = "LATEST";

export function SoftwareField({
    value,
    options,
    onChange
}: {
    value: string;
    options: readonly { value: string; label: string }[];
    onChange: (value: string) => void;
}) {
    const t = useGameText("games");
    return (
        <SearchableSelect
            value={value}
            onValueChange={onChange}
            searchPlaceholder={t("blueprint.searchSoftware")}
            emptyText={t("blueprint.nothingHereIsCalledThat")}
            options={options.map((option) => ({
                value: option.value,
                label: option.label,
                icon: <SoftwareLogo type={option.value} className="size-4" />
            }))}
        />
    );
}

export function ReleaseField({
    value,
    onChange
}: {
    value: string;
    onChange: (value: string) => void;
}) {
    const t = useGameText("games");
    const [releases, setReleases] = useState<string[] | null>(null);
    useKeptSnapshot<string[]>(RELEASES_KEY, KEPT_RELEASES_MS, (kept) =>
        setReleases((current) => current ?? kept.value)
    );

    useEffect(() => {
        let live = true;
        void minecraftReleasesAction()
            .catch(() => [])
            .then((found) => {
                if (!live) return;
                if (found.length > 0) writeSnapshot(RELEASES_KEY, found);
                // A failed read keeps a kept list rather than replacing it with none.
                setReleases((current) =>
                    found.length > 0 ? found : current && current.length > 0 ? current : []
                );
            });
        return () => {
            live = false;
        };
    }, []);

    const options = useMemo(() => {
        const list = releases ?? [];
        const latest = list[0];
        const entries = [
            {
                value: LATEST,
                label: latest ? t("blueprint.latestIs", { version: latest }) : t("blueprint.latest")
            },
            ...list.map((release) => ({ value: release, label: release }))
        ];
        // What the server is set to stays choosable even when it is not a release
        // on the list: a snapshot, an old beta, a value typed before there was a
        // list. Dropping it would draw a blank field over a server that runs.
        const current = value.trim();
        if (current.length > 0 && !entries.some((entry) => entry.value === current)) {
            entries.splice(1, 0, { value: current, label: current });
        }
        return entries;
    }, [releases, value, t]);

    if (releases === null) return <Skeleton className="h-8 w-full" />;
    if (releases.length === 0) {
        return <Input value={value} onChange={(event) => onChange(event.target.value)} />;
    }
    return (
        <SearchableSelect
            value={value.trim().toUpperCase() === LATEST ? LATEST : value.trim()}
            onValueChange={onChange}
            searchPlaceholder={t("blueprint.searchVersions")}
            emptyText={t("blueprint.noVersionMatches")}
            options={options}
        />
    );
}
