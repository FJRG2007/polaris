"use client";

/**
 * Where a VPN server is, set by hand: a town found by name, a pair of coordinates,
 * or a country pressed on the map. "Use its address" goes back to reading it from
 * the server's own address, which is what happens until somebody sets one.
 */

import * as ui from "@polaris/ui";
import * as actions from "./connect-actions";
import { useState, useTransition } from "react";
import { countryName, WorldMap } from "./world-map";
import { parseCoordinates } from "@/lib/vpn/wireguard";
import type { PlaceMatch } from "@/lib/vpn/place-search";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

interface PlacedNode {
    readonly id: string;
    readonly name: string;
    readonly country: string | null;
    readonly city: string | null;
    readonly placedBy: string | null;
}

export function NodePlaceDialog({
    node,
    onClose,
    onDone
}: {
    node: PlacedNode;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("vpn");
    const locale = useLocale();
    const [query, setQuery] = useState("");
    const [matches, setMatches] = useState<PlaceMatch[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [searching, startSearch] = useTransition();
    const [saving, startSave] = useTransition();
    const busy = searching || saving;
    const typed = query.trim();
    const point = parseCoordinates(typed);

    function find(): void {
        if (typed.length < 2 || busy) return;
        setError(null);
        startSearch(async () => {
            const result = await actions.findVpnPlaceAction(point ?? { query: typed });
            if (result.error !== undefined) {
                setError(result.error);
                setMatches(null);
                return;
            }
            setMatches(result.matches);
        });
    }

    function save(place: Parameters<typeof actions.placeVpnNodeAction>[0]): void {
        setError(null);
        startSave(async () => {
            const result = await actions.placeVpnNodeAction(place);
            if (result.error !== undefined) setError(result.error);
            else onDone();
        });
    }

    function pick(match: PlaceMatch): void {
        save({
            id: node.id,
            place: {
                country: match.country,
                city: match.city,
                latitude: match.latitude,
                longitude: match.longitude
            }
        });
    }

    const where = [node.city, node.country ? countryName(node.country, locale) : null]
        .filter(Boolean)
        .join(", ");

    return (
        <ui.Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{t("place.title", { name: node.name })}</ui.DialogTitle>
                    <ui.DialogDescription>
                        {where
                            ? t(`place.now.${node.placedBy === "manual" ? "manual" : "auto"}`, {
                                  place: where
                              })
                            : t("place.now.none")}
                    </ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <form
                        className="flex min-w-0 gap-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            find();
                        }}
                    >
                        <ui.Input
                            className="min-w-0 flex-1"
                            aria-label={t("place.search")}
                            placeholder={t("place.searchHint")}
                            value={query}
                            maxLength={80}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                        <ui.Button
                            type="submit"
                            size="sm"
                            variant="secondary"
                            aria-disabled={typed.length < 2 || busy}
                        >
                            {searching ? t("place.finding") : t("place.find")}
                        </ui.Button>
                    </form>
                    {matches?.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("place.noMatch")}</p>
                    ) : null}
                    {matches && matches.length > 0 ? (
                        <ul className="flex max-h-48 min-w-0 flex-col overflow-y-auto">
                            {matches.map((match) => {
                                const label = [
                                    match.city,
                                    match.region,
                                    countryName(match.country, locale)
                                ]
                                    .filter(Boolean)
                                    .join(", ");
                                return (
                                    <li key={`${match.latitude},${match.longitude}`}>
                                        <button
                                            type="button"
                                            disabled={busy}
                                            className="w-full min-w-0 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                                            title={label}
                                            onClick={() => pick(match)}
                                        >
                                            {label}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : null}
                    <p className="text-xs text-muted-foreground">{t("place.mapHint")}</p>
                    <WorldMap
                        places={
                            node.country
                                ? [{ id: node.id, country: node.country, label: node.name }]
                                : []
                        }
                        selected={node.id}
                        active={null}
                        onSelect={() => undefined}
                        onPickCountry={(country) =>
                            busy
                                ? undefined
                                : save({
                                      id: node.id,
                                      place: {
                                          country,
                                          city: null,
                                          latitude: null,
                                          longitude: null
                                      }
                                  })
                        }
                    />
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <ui.DialogFooter>
                    {node.placedBy === "manual" ? (
                        <ui.Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => save({ id: node.id, place: null })}
                        >
                            {t("place.automatic")}
                        </ui.Button>
                    ) : null}
                    <ui.Button variant="secondary" size="sm" disabled={saving} onClick={onClose}>
                        {t("place.close")}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}
