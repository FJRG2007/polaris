"use client";
/**
 * The venue's linked handhelds, tills and kitchen screens: link one with the
 * code it shows, rename it, or unlink it (it stops working at once). A device
 * acts for this venue only and never with the session of whoever linked it.
 */
import { TOUCH } from "./touch";
import type { DeviceView } from "../lib/devices";
import { hostUi } from "@polaris/app-host/client";
import { readMenuAction } from "../actions/catalog";
import { Link2, Pencil, Unlink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { readCache, unwrap, useHospitalityT } from "./i18n";
import { approveDeviceAction, listDevicesAction, renameDeviceAction, revokeDeviceAction } from "../actions/devices";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, EmptyState, Input, Skeleton, useToast } from "@polaris/ui";

export function DevicesScreen() {
    const t = useHospitalityT();
    const toast = useToast();
    const locale = hostUi.i18nProvider.useLocale();
    const [venueId, setVenueId] = useState<string | null | undefined>(undefined);
    const [devices, setDevices] = useState<DeviceView[] | undefined>(undefined);
    const [code, setCode] = useState("");
    const [name, setName] = useState("");
    const [linking, setLinking] = useState(false);
    const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
    const [revoking, setRevoking] = useState<DeviceView | null>(null);
    const fail = (caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message });

    const load = useCallback(() => {
        unwrap(() => readMenuAction({ venueId: readCache<string>("venue") }), t("errors.loadFailed"))
            .then((answer) => {
                setVenueId(answer.menu.venueId);
                if (!answer.menu.venueId) return setDevices([]);
                return unwrap(() => listDevicesAction({ venueId: answer.menu.venueId }), t("errors.loadFailed")).then((x) => setDevices(x.devices));
            })
            .catch((caught: Error) => toast.show({ title: t("errors.loadFailed"), body: caught.message }));
    }, [t, toast]);
    useEffect(load, [load]);

    const seen = (at: string | null) =>
        at ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at)) : t("devices.neverSeen");
    const ready = code.trim().length > 0 && name.trim().length > 0 && !linking;

    const link = () => {
        if (!ready || !venueId) return;
        setLinking(true);
        unwrap(() => approveDeviceAction({ userCode: code.trim(), venueId, name: name.trim() }), t("errors.saveFailed"))
            .then(() => {
                toast.show({ title: t("devices.linked", { name: name.trim() }) });
                setCode("");
                setName("");
                load();
            })
            .catch(fail)
            .finally(() => setLinking(false));
    };

    if (venueId === undefined) return <Skeleton className="m-4 h-48" />;
    if (!venueId) return <EmptyState title={t("service.noFloor")} description={t("service.noFloorHint")} />;

    return (
        <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-4 p-4">
            <section className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
                <h2 className="text-base font-semibold">{t("devices.linkTitle")}</h2>
                <p className="text-sm text-muted-foreground">{t("devices.linkHint")}</p>
                <div className="flex min-w-0 flex-wrap gap-2">
                    <Input
                        className="min-w-0 flex-1 font-mono uppercase"
                        aria-label={t("devices.code")}
                        placeholder={t("devices.code")}
                        value={code}
                        maxLength={20}
                        autoComplete="off"
                        onChange={(e) => setCode(e.target.value.toUpperCase())}
                    />
                    <Input
                        className="min-w-0 flex-1"
                        aria-label={t("devices.name")}
                        placeholder={t("devices.namePlaceholder")}
                        value={name}
                        maxLength={60}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && link()}
                    />
                    <Button className={TOUCH} size="lg" disabled={!ready} onClick={link}>
                        <Link2 aria-hidden /> {t("devices.link")}
                    </Button>
                </div>
            </section>
            {devices === undefined ? (
                <Skeleton className="h-32" />
            ) : devices.length === 0 ? (
                <EmptyState title={t("devices.none")} description={t("devices.noneHint")} />
            ) : (
                <ul className="flex min-w-0 flex-col divide-y rounded-lg border">
                    {devices.map((d) => (
                        <li key={d.id} className="flex min-w-0 flex-wrap items-center gap-2 p-3">
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate font-medium" title={d.name}>{d.name}</span>
                                <span className="truncate text-xs text-muted-foreground">{t("devices.lastSeen", { when: seen(d.lastSeenAt) })}</span>
                            </div>
                            <Button className={TOUCH} variant="outline" onClick={() => setRenaming({ id: d.id, name: d.name })}>
                                <Pencil aria-hidden /> {t("devices.rename")}
                            </Button>
                            <Button className={TOUCH} variant="outline" onClick={() => setRevoking(d)}>
                                <Unlink aria-hidden /> {t("devices.unlink")}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {renaming ? (
                <Dialog open onOpenChange={(open) => !open && setRenaming(null)}>
                    <DialogContent className="sm:max-w-sm">
                        <DialogHeader>
                            <DialogTitle>{t("devices.rename")}</DialogTitle>
                        </DialogHeader>
                        <div className="flex flex-col gap-3">
                            <Input aria-label={t("devices.name")} value={renaming.name} maxLength={60} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                            <Button
                                className={TOUCH}
                                disabled={!renaming.name.trim() || renaming.name.trim() === devices?.find((d) => d.id === renaming.id)?.name}
                                onClick={() =>
                                    unwrap(() => renameDeviceAction({ id: renaming.id, name: renaming.name.trim() }), t("errors.saveFailed"))
                                        .then(() => {
                                            setRenaming(null);
                                            load();
                                        })
                                        .catch(fail)
                                }
                            >
                                {t("devices.save")}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            ) : null}
            {revoking ? (
                <Dialog open onOpenChange={(open) => !open && setRevoking(null)}>
                    <DialogContent className="sm:max-w-sm">
                        <DialogHeader>
                            <DialogTitle>{t("devices.unlinkTitle", { name: revoking.name })}</DialogTitle>
                        </DialogHeader>
                        <div className="flex flex-col gap-3">
                            <p className="text-sm text-muted-foreground">{t("devices.unlinkHint")}</p>
                            <div className="flex gap-2">
                                <Button className={`flex-1 ${TOUCH}`} variant="outline" onClick={() => setRevoking(null)}>
                                    {t("devices.cancel")}
                                </Button>
                                <Button
                                    className={`flex-1 ${TOUCH}`}
                                    variant="danger"
                                    onClick={() =>
                                        unwrap(() => revokeDeviceAction({ id: revoking.id }), t("errors.saveFailed"))
                                            .then(() => {
                                                setRevoking(null);
                                                load();
                                            })
                                            .catch(fail)
                                    }
                                >
                                    {t("devices.unlink")}
                                </Button>
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
            ) : null}
        </div>
    );
}
