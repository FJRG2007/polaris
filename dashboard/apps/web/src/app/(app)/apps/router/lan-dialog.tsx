"use client";

/** One network behind the router, added to the draft: nothing reaches the machine
 *  until Apply. A private network from the VPN fills in its own subnet. */

import { useState } from "react";
import * as ui from "@polaris/ui";
import { VlanInput } from "./router-view";
import { Plus, Trash2 } from "lucide-react";
import type { MachinesAnswer } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { lanSchema, newLanId, reservationSchema, type RouterLan } from "@/lib/router/plan";
import {
    cidrsOverlap,
    firstHost,
    isHostOf,
    isUsableCidr,
    normalizeCidr,
    suggestCidr
} from "@/lib/vpn/networks";

export function LanDialog({
    lan,
    taken,
    ports,
    privateNetworks,
    onClose,
    onSave
}: {
    lan: RouterLan | null;
    taken: readonly RouterLan[];
    ports: readonly string[];
    privateNetworks: MachinesAnswer["privateNetworks"];
    onClose: () => void;
    onSave: (lan: RouterLan) => void;
}) {
    const t = useTranslations("router");
    const [id] = useState(() => lan?.id ?? newLanId());
    const others = taken.filter(({ id }) => id !== lan?.id).map(({ cidr }) => cidr);
    const suggested = lan?.cidr ?? suggestCidr(others);
    const [name, setName] = useState(lan?.name ?? "");
    const [port, setPort] = useState(lan?.interface ?? ports[0] ?? "");
    const [vlan, setVlan] = useState(lan?.vlan ?? null);
    const [cidr, setCidr] = useState(suggested);
    const [address, setAddress] = useState(lan?.address ?? firstHost(suggested));
    const [touched, setTouched] = useState(lan !== null);
    const [internet, setInternet] = useState(lan?.internet ?? true);
    const [isolated, setIsolated] = useState(lan?.isolated ?? false);
    const [reservations, setReservations] = useState(lan?.reservations ?? []);

    const clean = normalizeCidr(cidr);
    const subnetBad = cidr.trim() !== "" && !isUsableCidr(clean);
    const subnetTaken = !subnetBad && others.some((other) => cidrsOverlap(clean, other));
    const addressBad =
        address.trim() !== "" && isUsableCidr(clean) && !isHostOf(clean, address.trim());
    const candidate = {
        id,
        name,
        interface: port,
        vlan,
        cidr,
        address,
        internet,
        isolated,
        reservations
    };
    const parsed = lanSchema.safeParse(candidate);
    const vlanBad = vlan !== null && (vlan < 2 || vlan > 4094);
    const valid = parsed.success && !subnetTaken;

    function changeCidr(next: string): void {
        setCidr(next);
        const normal = normalizeCidr(next);
        if (!touched && isUsableCidr(normal)) setAddress(firstHost(normal));
    }

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{lan ? t("editNetwork") : t("addNetwork")}</ui.DialogTitle>
                    <ui.DialogDescription>{t("networkBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    {privateNetworks.length > 0 && !lan ? (
                        <ui.Select
                            aria-label={t("usePrivate")}
                            value=""
                            placeholder={t("usePrivate")}
                            options={privateNetworks.map((network) => ({
                                value: network.cidr,
                                label: network.name
                            }))}
                            onValueChange={(value) => {
                                const network = privateNetworks.find((one) => one.cidr === value);
                                if (!network) return;
                                setName(network.name);
                                setCidr(network.cidr);
                                setAddress(network.routerAddress);
                                setTouched(true);
                            }}
                        />
                    ) : null}
                    <Field id="lan-name" label={`${t("name")} *`}>
                        <ui.Input
                            id="lan-name"
                            value={name}
                            maxLength={40}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field id="lan-port" label={`${t("port")} *`}>
                            <ui.Select
                                aria-label={t("port")}
                                value={port}
                                onValueChange={setPort}
                                options={ports.map((one) => ({ value: one, label: one }))}
                            />
                        </Field>
                        <Field
                            id="lan-vlan"
                            label={t("vlan")}
                            hint={t("vlanHint")}
                            error={vlanBad ? t("problems.badVlan") : null}
                        >
                            <VlanInput t={t} value={vlan} onChange={setVlan} />
                        </Field>
                        <Field
                            id="lan-subnet"
                            label={`${t("subnet")} *`}
                            error={
                                subnetBad
                                    ? t("badSubnet")
                                    : subnetTaken
                                      ? t("problems.overlap")
                                      : null
                            }
                        >
                            <ui.Input
                                id="lan-subnet"
                                className="font-mono"
                                value={cidr}
                                onChange={(event) => changeCidr(event.target.value)}
                            />
                        </Field>
                        <Field
                            id="lan-address"
                            label={`${t("routerAddress")} *`}
                            error={addressBad ? t("badAddress") : null}
                        >
                            <ui.Input
                                id="lan-address"
                                className="font-mono"
                                value={address}
                                onChange={(event) => {
                                    setTouched(true);
                                    setAddress(event.target.value);
                                }}
                            />
                        </Field>
                    </div>
                    <Toggle
                        label={t("internet")}
                        hint={t("internetHint")}
                        value={internet}
                        onChange={setInternet}
                    />
                    <Toggle
                        label={t("isolate")}
                        hint={t("isolateHint")}
                        value={isolated}
                        onChange={setIsolated}
                    />
                    <div className="flex min-w-0 flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium">{t("reservations")}</span>
                            <ui.Button
                                size="icon"
                                variant="ghost"
                                aria-label={t("addReservation")}
                                title={t("addReservation")}
                                onClick={() =>
                                    setReservations([...reservations, { mac: "", address: "" }])
                                }
                            >
                                <Plus />
                            </ui.Button>
                        </div>
                        {reservations.map((one, at) => {
                            const update = (next: Partial<typeof one>) =>
                                setReservations(
                                    reservations.map((entry, index) =>
                                        index === at ? { ...entry, ...next } : entry
                                    )
                                );
                            const bad =
                                one.mac !== "" &&
                                one.address !== "" &&
                                !(
                                    reservationSchema.safeParse(one).success &&
                                    isHostOf(clean, one.address.trim())
                                );
                            return (
                                <div key={at} className="flex min-w-0 flex-col gap-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <ui.Input
                                            className="min-w-0 flex-1 font-mono"
                                            aria-label={t("mac")}
                                            placeholder={`${t("mac")} *`}
                                            aria-invalid={bad}
                                            value={one.mac}
                                            onChange={(event) =>
                                                update({ mac: event.target.value })
                                            }
                                        />
                                        <ui.Input
                                            className="min-w-0 flex-1 font-mono"
                                            aria-label={t("reservedAddress")}
                                            placeholder={`${t("reservedAddress")} *`}
                                            aria-invalid={bad}
                                            value={one.address}
                                            onChange={(event) =>
                                                update({ address: event.target.value })
                                            }
                                        />
                                        <ui.Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t("remove")}
                                            title={t("remove")}
                                            onClick={() =>
                                                setReservations(
                                                    reservations.filter((_, index) => index !== at)
                                                )
                                            }
                                        >
                                            <Trash2 />
                                        </ui.Button>
                                    </div>
                                    {bad ? (
                                        <p role="alert" className="text-xs text-danger">
                                            {t("badReservation")}
                                        </p>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                </div>
                <ui.DialogFooter>
                    <ui.Button variant="ghost" size="sm" onClick={onClose}>
                        {t("cancel")}
                    </ui.Button>
                    <ui.Button
                        size="sm"
                        aria-disabled={!valid}
                        onClick={() => parsed.success && valid && onSave(parsed.data)}
                    >
                        {t("save")}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}

function Field({
    id,
    label,
    error,
    hint,
    children
}: {
    id: string;
    label: string;
    error?: string | null;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={id} className="text-sm font-medium">
                {label}
            </label>
            {children}
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

function Toggle({
    label,
    hint,
    value,
    onChange
}: {
    label: string;
    hint: string;
    value: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <ui.Switch checked={value} onChange={onChange} aria-label={label} />
        </div>
    );
}
