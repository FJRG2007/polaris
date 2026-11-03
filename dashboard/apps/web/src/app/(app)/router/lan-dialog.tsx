"use client";

/** One network behind the router, added to the draft: nothing reaches the machine
 *  until Apply. A private network from the VPN fills in its own subnet. */

import { useState } from "react";
import * as ui from "@polaris/ui";
import { Field, HelpNote, VlanField } from "./router-field";
import {
    hostCount,
    nextFreeVlan,
    vlanError,
    vlanTakenBy,
    type PortLink
} from "@/lib/router/assist";
import { Plus, Trash2 } from "lucide-react";
import type { MachinesAnswer } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    lanSchema,
    newLanId,
    reservationFits,
    reservationSchema,
    wifiSchema,
    type RouterLan
} from "@/lib/router/plan";
import {
    cidrsOverlap,
    dhcpRange,
    firstHost,
    isHostOf,
    isUsableCidr,
    normalizeCidr,
    suggestCidr
} from "@/lib/vpn/networks";

/** The browser's region, the likeliest place the radio is in. Blank when it has none. */
function defaultCountry(): string {
    if (typeof navigator === "undefined") return "";
    return /-([A-Z]{2})$/.exec(navigator.language)?.[1] ?? "";
}

/** Where a new network starts: a port nothing rides untagged, or else the first port
 *  on its next free VLAN, so a one-port machine is offered a VLAN from the start. */
function placeFor(
    links: readonly PortLink[],
    ports: readonly string[]
): { interface: string; vlan: number | null } {
    const free = ports.find(
        (port) => !links.some((link) => link.port === port && link.vlan === null)
    );
    if (free) return { interface: free, vlan: null };
    const port = ports[0] ?? "";
    return { interface: port, vlan: port ? nextFreeVlan(links, port) : null };
}

function Heading({ children }: { children: React.ReactNode }) {
    return (
        <h3 className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            {children}
        </h3>
    );
}

export function LanDialog({
    lan,
    taken,
    links,
    ports,
    radios,
    wired,
    privateNetworks,
    onClose,
    onSave
}: {
    lan: RouterLan | null;
    taken: readonly RouterLan[];
    /** Every line and network of the draft, to name a port clash and offer a free tag. */
    links: readonly PortLink[];
    ports: readonly string[];
    /** The ports that can run an access point. */
    radios: readonly string[];
    /** The ports the machine shows that have no radio. */
    wired: readonly string[];
    privateNetworks: MachinesAnswer["privateNetworks"];
    onClose: () => void;
    onSave: (lan: RouterLan) => void;
}) {
    const t = useTranslations("router");
    const [id] = useState(() => lan?.id ?? newLanId());
    const others = taken.filter(({ id }) => id !== lan?.id).map(({ cidr }) => cidr);
    const suggested = lan?.cidr ?? suggestCidr(others);
    const [name, setName] = useState(lan?.name ?? "");
    const self = { kind: "network" as const, key: id };
    const [start] = useState(() => lan ?? placeFor(links, ports));
    const [port, setPort] = useState(start.interface);
    const [vlan, setVlan] = useState(start.vlan);
    const [cidr, setCidr] = useState(suggested);
    const [address, setAddress] = useState(lan?.address ?? firstHost(suggested));
    const [touched, setTouched] = useState(lan !== null);
    const [internet, setInternet] = useState(lan?.internet ?? true);
    const [isolated, setIsolated] = useState(lan?.isolated ?? false);
    const [reservations, setReservations] = useState(lan?.reservations ?? []);
    const [ipv6, setIpv6] = useState(lan?.ipv6 ?? false);
    const [broadcast, setBroadcast] = useState(lan?.wifi !== undefined);
    const [ssid, setSsid] = useState(lan?.wifi?.ssid ?? "");
    const [wifiPassword, setWifiPassword] = useState("");
    const [band, setBand] = useState<"2.4" | "5">(lan?.wifi?.band ?? "5");
    const [country, setCountry] = useState(lan?.wifi?.country ?? defaultCountry());

    const clean = normalizeCidr(cidr);
    const subnetBad = cidr.trim() !== "" && !isUsableCidr(clean);
    const subnetTaken = !subnetBad && others.some((other) => cidrsOverlap(clean, other));
    const addressBad =
        address.trim() !== "" && isUsableCidr(clean) && !isHostOf(clean, address.trim());
    const unseenRadio = lan?.wifi !== undefined && !wired.includes(port);
    const isRadio = radios.includes(port) || unseenRadio;
    const airing = isRadio && broadcast;
    const keptPassword = lan?.wifi?.password;
    const typedPassword = wifiPassword || keptPassword;
    const hasPassword = lan?.wifi !== undefined;
    const wifi = airing
        ? { ssid, country, band, ...(typedPassword ? { password: typedPassword } : {}) }
        : undefined;
    const wifiBad = airing && wifi !== undefined && !wifiSchema.safeParse(wifi).success;
    const candidate = {
        id,
        name,
        interface: port,
        vlan,
        cidr,
        address,
        internet,
        isolated,
        reservations,
        ...(ipv6 ? { ipv6 } : {}),
        ...(wifi ? { wifi } : {})
    };
    const parsed = lanSchema.safeParse(candidate);
    const clash = vlanTakenBy(links, self, port, vlan) !== null;
    const room = hostCount(clean);
    const pool = isUsableCidr(clean) ? dhcpRange(clean) : null;
    const wifiComplete =
        !airing || (ssid.trim() !== "" && (hasPassword || wifiPassword !== "") && vlan === null);
    const valid =
        parsed.success && !subnetTaken && wifiComplete && !clash && vlanError(vlan) === null;

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
                    <Field id="lan-name" label={`${t("name")} *`} hint={t("nameHint")}>
                        <ui.Input
                            id="lan-name"
                            placeholder={t("namePlaceholder")}
                            value={name}
                            maxLength={40}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>
                    <Heading>{t("whereTitle")}</Heading>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field id="lan-port" label={`${t("port")} *`} hint={t("lanPortHint")}>
                            <ui.Select
                                id="lan-port"
                                aria-label={t("port")}
                                value={port}
                                onValueChange={setPort}
                                options={ports.map((one) => ({ value: one, label: one }))}
                            />
                        </Field>
                        <VlanField
                            id="lan-vlan"
                            port={port}
                            value={vlan}
                            links={links}
                            self={self}
                            hint={t("lanVlanHint")}
                            onChange={setVlan}
                        />
                    </div>
                    <Heading>{t("addressesTitle")}</Heading>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field
                            id="lan-subnet"
                            label={`${t("subnet")} *`}
                            hint={
                                room === null ? t("subnetHint") : t("subnetRoom", { count: room })
                            }
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
                                placeholder="10.77.1.0/24"
                                value={cidr}
                                onChange={(event) => changeCidr(event.target.value)}
                            />
                        </Field>
                        <Field
                            id="lan-address"
                            label={`${t("routerAddress")} *`}
                            hint={t("routerAddressHint")}
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
                    {pool ? (
                        <p className="text-xs text-muted-foreground">
                            {t("dhcpSummary", { first: pool.first, last: pool.last })}
                        </p>
                    ) : null}
                    <HelpNote title={t("subnetHelpTitle")}>
                        <p>{t("subnetHelp")}</p>
                    </HelpNote>
                    <Heading>{t("rulesTitle")}</Heading>
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
                    <Toggle
                        label={t("ipv6")}
                        hint={t("ipv6Hint")}
                        value={ipv6}
                        onChange={setIpv6}
                    />
                    {isRadio ? (
                        <Toggle
                            label={t("wifi")}
                            hint={vlan === null ? t("wifiHint") : t("problems.wifiVlan")}
                            value={broadcast}
                            onChange={setBroadcast}
                        />
                    ) : null}
                    {airing ? (
                        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field id="lan-ssid" label={`${t("wifiName")} *`}>
                                <ui.Input
                                    id="lan-ssid"
                                    value={ssid}
                                    onChange={(event) => setSsid(event.target.value)}
                                />
                            </Field>
                            <Field
                                id="lan-wifi-password"
                                label={hasPassword ? t("wifiPassword") : `${t("wifiPassword")} *`}
                            >
                                <ui.Input
                                    id="lan-wifi-password"
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder={hasPassword ? t("keepPassword") : undefined}
                                    value={wifiPassword}
                                    onChange={(event) => setWifiPassword(event.target.value)}
                                />
                            </Field>
                            <Field id="lan-band" label={t("wifiBand")}>
                                <ui.Select
                                    id="lan-band"
                                    aria-label={t("wifiBand")}
                                    value={band}
                                    onValueChange={(next) => setBand(next as "2.4" | "5")}
                                    options={[
                                        { value: "5", label: t("wifiBand5") },
                                        { value: "2.4", label: t("wifiBand24") }
                                    ]}
                                />
                            </Field>
                            <Field
                                id="lan-country"
                                label={`${t("wifiCountry")} *`}
                                hint={t("wifiCountryHint")}
                            >
                                <ui.Input
                                    id="lan-country"
                                    className="font-mono uppercase"
                                    maxLength={2}
                                    value={country}
                                    onChange={(event) => setCountry(event.target.value)}
                                />
                            </Field>
                            {wifiBad && (ssid !== "" || wifiPassword !== "") ? (
                                <p role="alert" className="text-xs text-danger sm:col-span-2">
                                    {t("problems.badWifi")}
                                </p>
                            ) : null}
                        </div>
                    ) : null}
                    <div className="flex min-w-0 flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-sm font-medium">{t("reservations")}</p>
                                <p className="text-xs text-muted-foreground">
                                    {t("reservationsHint")}
                                </p>
                            </div>
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
                                    reservationFits({ cidr: clean, address }, reservations, one)
                                );
                            return (
                                <div key={at} className="flex min-w-0 flex-col gap-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <ui.Input
                                            className="min-w-0 flex-1 font-mono"
                                            aria-label={t("mac")}
                                            placeholder="aa:bb:cc:dd:ee:ff"
                                            aria-invalid={bad}
                                            value={one.mac}
                                            onChange={(event) =>
                                                update({ mac: event.target.value })
                                            }
                                        />
                                        <ui.Input
                                            className="min-w-0 flex-1 font-mono"
                                            aria-label={t("reservedAddress")}
                                            placeholder={pool?.first ?? ""}
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
