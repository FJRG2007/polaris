"use client";

/**
 * Every UPS Polaris watches, with what each says now. One a machine sees on USB
 * is watched by itself; one somebody removed is offered here, one click back.
 *
 * The heading, the Add button and the table's headings paint at once; only
 * the rows wait on `/api/servers/ups`, which is read again every few seconds
 * while the tab is visible and painted from what this tab kept of it first.
 */

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createUpsAction } from "./actions";
import type { UsbOffer } from "@/lib/ups/ups-service";
import { BatteryCharging, Plus, Usb } from "lucide-react";
import { UpsAnalytics } from "./ups-analytics";
import { UpsConnectionDialog } from "./ups-connection-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, EmptyState, LanDetails, PageHeader, Skeleton } from "@polaris/ui";
import { minutesLeft, rounded, upsStatus, type UpsListAnswer, type UpsMachine } from "./ups-words";

const POLL_MS = 10_000;

export function UpsListView({
    machines,
    places
}: {
    machines: UpsMachine[];
    places: { id: string; name: string }[];
}) {
    const t = useTranslations("servers");
    const router = useRouter();
    const [adding, setAdding] = useState(false);
    const [addingOffer, setAddingOffer] = useState<string | null>(null);
    const [offerError, setOfferError] = useState<string | null>(null);
    const live = useLiveResource<UpsListAnswer>({
        url: "/api/servers/ups",
        cacheKey: "ups:list",
        intervalMs: POLL_MS,
        select: (body) => body as UpsListAnswer
    });
    const data = live.data;
    const offers: UsbOffer[] = data?.usb.offers ?? [];
    const machineName = (id: string | null) =>
        machines.find((machine) => machine.id === id)?.name ?? "";

    const placeName = (id: string | null) => places.find((place) => place.id === id)?.name ?? "";

    async function addOffer(offer: UsbOffer) {
        const key = `${offer.machineId}/${offer.deviceId}`;
        setAddingOffer(key);
        setOfferError(null);
        const result = await createUpsAction({
            connection: "usb",
            name: offer.name,
            machineId: offer.machineId,
            deviceId: offer.deviceId
        });
        setAddingOffer(null);
        if (!result.ok) {
            setOfferError(result.error);
            return;
        }
        router.push(`/places/ups/${result.value}`);
    }

    return (
        <>
            <PageHeader
                title={t("ups.heading")}
                description={t("ups.description")}
                actions={
                    <Button onClick={() => setAdding(true)}>
                        <Plus className="size-4 shrink-0" aria-hidden />
                        {t("ups.add")}
                    </Button>
                }
            />

            <div className="flex flex-col gap-4">
                {data && data.usb.state !== "ok" ? (
                    <p className="text-sm text-muted-foreground">
                        {data.usb.state === "updateNeeded"
                            ? t("ups.found.updateNeeded")
                            : t("ups.found.fullEditionNeeded")}
                    </p>
                ) : null}

                {offers.length > 0 ? (
                    <section aria-label={t("ups.found.title")} className="flex flex-col gap-2">
                        <h2 className="text-sm font-medium">{t("ups.found.title")}</h2>
                        <ul className="flex flex-col gap-2">
                            {offers.map((offer) => {
                                const key = `${offer.machineId}/${offer.deviceId}`;
                                return (
                                    <li
                                        key={key}
                                        className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2"
                                    >
                                        <Usb
                                            className="size-4 shrink-0 text-muted-foreground"
                                            aria-hidden
                                        />
                                        <span
                                            className="min-w-0 flex-1 truncate text-sm"
                                            title={offer.name}
                                        >
                                            {offer.name}{" "}
                                            <span className="text-muted-foreground">
                                                {t("ups.found.on", {
                                                    machine: machineName(offer.machineId)
                                                })}
                                            </span>
                                        </span>
                                        <Button
                                            size="sm"
                                            disabled={addingOffer !== null}
                                            onClick={() => void addOffer(offer)}
                                        >
                                            {t("ups.found.add")}
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                        {offerError ? (
                            <p role="alert" className="text-sm text-danger-ink">
                                {t(
                                    `ups.errors.${offerError === "notFound" ? "notFound" : "failed"}`
                                )}
                            </p>
                        ) : null}
                    </section>
                ) : null}

                {data && data.ups.length === 0 ? (
                    <EmptyState
                        icon={<BatteryCharging className="size-5" aria-hidden />}
                        title={t("ups.empty.title")}
                        description={t("ups.empty.body")}
                    />
                ) : (
                    <div className="rounded-lg border border-border">
                        <table className="w-full table-auto text-sm">
                            <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="w-full max-w-0 px-3 py-2 font-medium">
                                        {t("ups.columns.name")}
                                    </th>
                                    <th className="px-3 py-2 font-medium">
                                        {t("ups.columns.status")}
                                    </th>
                                    <th className="px-3 py-2 text-right font-medium">
                                        {t("ups.columns.charge")}
                                    </th>
                                    <th className="hidden px-3 py-2 text-right font-medium lg:table-cell">
                                        {t("ups.columns.load")}
                                    </th>
                                    <th className="hidden px-3 py-2 text-right font-medium lg:table-cell">
                                        {t("ups.columns.runtime")}
                                    </th>
                                    <th className="hidden px-3 py-2 font-medium xl:table-cell">
                                        {t("ups.columns.place")}
                                    </th>
                                    <th className="hidden px-3 py-2 font-medium xl:table-cell">
                                        {t("ups.columns.connection")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {live.error && data === null ? (
                                    <tr className="border-t border-border">
                                        <td colSpan={7} className="px-3 py-2.5">
                                            <p role="alert" className="text-sm text-danger-ink">
                                                {t("ups.errors.failed")}
                                            </p>
                                        </td>
                                    </tr>
                                ) : data === null ? (
                                    [0, 1].map((row) => (
                                        <tr key={row} className="border-t border-border">
                                            <td colSpan={7} className="px-3 py-2.5">
                                                <Skeleton className="h-5 w-full" />
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    data.ups.map(({ ups, result }) => {
                                        const reading = result.ok ? result.reading : null;
                                        const status = upsStatus(reading);
                                        const charge = rounded(reading?.charge ?? null);
                                        const minutes = minutesLeft(reading?.runtimeS ?? null);
                                        const load = rounded(reading?.load ?? null);
                                        const href = `/places/ups/${ups.id}`;
                                        const runtimeText =
                                            minutes === null
                                                ? "-"
                                                : t("ups.units.minutes", { count: minutes });
                                        const loadText =
                                            load === null
                                                ? "-"
                                                : t("ups.units.percent", { value: load });
                                        const place = placeName(ups.placeId);
                                        const connection = t(`ups.connection.${ups.connection}`);
                                        const network = data.network?.[ups.id] ?? null;
                                        return (
                                            <tr
                                                key={ups.id}
                                                onClick={() => router.push(href)}
                                                className="cursor-pointer border-t border-border hover:bg-muted/50"
                                            >
                                                <td className="w-full max-w-0 px-3 py-2.5">
                                                    <Link
                                                        href={href}
                                                        onClick={(event) => event.stopPropagation()}
                                                        className="block truncate font-medium hover:underline"
                                                        title={ups.name}
                                                    >
                                                        {ups.name}
                                                    </Link>
                                                    <span className="block truncate text-xs text-muted-foreground lg:hidden">
                                                        {[loadText, runtimeText]
                                                            .filter((value) => value !== "-")
                                                            .join(" / ")}
                                                    </span>
                                                    <span className="block truncate text-xs text-muted-foreground xl:hidden">
                                                        {[place, connection, network?.address]
                                                            .filter(Boolean)
                                                            .join(" / ")}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2.5">
                                                    <Badge
                                                        variant={status.tone}
                                                        title={
                                                            result.ok
                                                                ? undefined
                                                                : t(
                                                                      `ups.unreachable.${result.reason}`
                                                                  )
                                                        }
                                                    >
                                                        {t(`ups.status.${status.key}`)}
                                                    </Badge>
                                                </td>
                                                <td className="px-3 py-2.5 text-right tabular-nums">
                                                    {charge === null
                                                        ? "-"
                                                        : t("ups.units.percent", { value: charge })}
                                                </td>
                                                <td className="hidden px-3 py-2.5 text-right tabular-nums lg:table-cell">
                                                    {loadText}
                                                </td>
                                                <td className="hidden whitespace-nowrap px-3 py-2.5 text-right tabular-nums lg:table-cell">
                                                    {runtimeText}
                                                </td>
                                                <td className="hidden max-w-[10rem] truncate px-3 py-2.5 text-muted-foreground xl:table-cell">
                                                    {place || "-"}
                                                </td>
                                                <td className="hidden max-w-[13rem] px-3 py-2.5 text-muted-foreground xl:table-cell">
                                                    <span className="block truncate">
                                                        {connection}
                                                    </span>
                                                    {network ? (
                                                        <div
                                                            onClick={(event) =>
                                                                event.stopPropagation()
                                                            }
                                                        >
                                                            <LanDetails
                                                                compact
                                                                details={network}
                                                                labels={{
                                                                    address: t("network.address"),
                                                                    mac: t("network.mac")
                                                                }}
                                                            />
                                                        </div>
                                                    ) : null}
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                )}

                {data && data.ups.length > 1 ? <UpsAnalytics /> : null}
                {adding ? (
                    <UpsConnectionDialog
                        open
                        onOpenChange={setAdding}
                        editing={null}
                        machines={machines}
                        offers={offers}
                        onSaved={(id) => router.push(`/places/ups/${id}`)}
                    />
                ) : null}
            </div>
        </>
    );
}
