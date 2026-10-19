"use client";

/**
 * Every UPS Polaris watches, with what each says now, and the ones a machine
 * sees on USB that are not added yet - each one click from being watched.
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
import { UpsConnectionDialog } from "./ups-connection-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, EmptyState, PageHeader, Skeleton } from "@polaris/ui";
import { minutesLeft, rounded, upsStatus, type UpsListAnswer, type UpsMachine } from "./ups-words";

const POLL_MS = 10_000;

export function UpsListView({ machines }: { machines: UpsMachine[] }) {
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
        router.push(`/apps/servers/ups/${result.value}`);
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

            {data && data.usb.state !== "ok" ? (
                <p className="mb-4 text-sm text-muted-foreground">
                    {data.usb.state === "updateNeeded"
                        ? t("ups.found.updateNeeded")
                        : t("ups.found.fullEditionNeeded")}
                </p>
            ) : null}

            {offers.length > 0 ? (
                <section aria-label={t("ups.found.title")} className="mb-5 flex flex-col gap-2">
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
                            {t(`ups.errors.${offerError === "notFound" ? "notFound" : "failed"}`)}
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
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[36rem] text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="py-2 pr-3 font-medium">{t("ups.columns.name")}</th>
                                <th className="py-2 pr-3 font-medium">{t("ups.columns.status")}</th>
                                <th className="py-2 pr-3 text-right font-medium">
                                    {t("ups.columns.charge")}
                                </th>
                                <th className="py-2 pr-3 text-right font-medium">
                                    {t("ups.columns.runtime")}
                                </th>
                                <th className="py-2 pr-3 text-right font-medium">
                                    {t("ups.columns.load")}
                                </th>
                                <th className="py-2 font-medium">{t("ups.columns.connection")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data === null
                                ? [0, 1].map((row) => (
                                      <tr key={row} className="border-t border-border">
                                          <td colSpan={6} className="py-2.5">
                                              <Skeleton className="h-5 w-full" />
                                          </td>
                                      </tr>
                                  ))
                                : data.ups.map(({ ups, result }) => {
                                      const reading = result.ok ? result.reading : null;
                                      const status = upsStatus(reading);
                                      const charge = rounded(reading?.charge ?? null);
                                      const minutes = minutesLeft(reading?.runtimeS ?? null);
                                      const load = rounded(reading?.load ?? null);
                                      return (
                                          <tr key={ups.id} className="border-t border-border">
                                              <td className="max-w-[16rem] py-2.5 pr-3">
                                                  <Link
                                                      href={`/apps/servers/ups/${ups.id}`}
                                                      className="block truncate font-medium hover:underline"
                                                      title={ups.name}
                                                  >
                                                      {ups.name}
                                                  </Link>
                                              </td>
                                              <td className="py-2.5 pr-3">
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
                                              <td className="py-2.5 pr-3 text-right tabular-nums">
                                                  {charge === null
                                                      ? "-"
                                                      : t("ups.units.percent", { value: charge })}
                                              </td>
                                              <td className="py-2.5 pr-3 text-right tabular-nums">
                                                  {minutes === null
                                                      ? "-"
                                                      : t("ups.units.minutes", { count: minutes })}
                                              </td>
                                              <td className="py-2.5 pr-3 text-right tabular-nums">
                                                  {load === null
                                                      ? "-"
                                                      : t("ups.units.percent", { value: load })}
                                              </td>
                                              <td className="py-2.5 text-muted-foreground">
                                                  {t(`ups.connection.${ups.connection}`)}
                                              </td>
                                          </tr>
                                      );
                                  })}
                        </tbody>
                    </table>
                </div>
            )}

            {adding ? (
                <UpsConnectionDialog
                    open
                    onOpenChange={setAdding}
                    editing={null}
                    machines={machines}
                    offers={offers}
                    onSaved={(id) => router.push(`/apps/servers/ups/${id}`)}
                />
            ) : null}
        </>
    );
}
