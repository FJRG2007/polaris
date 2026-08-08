"use client";

/**
 * The port forward, step by step, for the brand of router in the way.
 *
 * Everything here is a value the operator has to type somewhere else, so it is shown
 * as a value - the admin address, the two rules, this server's LAN address - rather
 * than described in a sentence they have to translate. The brand starts on whatever
 * answered the reachability probe and stays a picker, because a router that names
 * itself is luck, not a guarantee.
 *
 * The rules come first and remote management last. Both can be why the router is
 * answering instead of Polaris, but only one can be told apart from here: the probe
 * leaves this server, so a router bouncing its own public address back inward looks
 * exactly like one publishing its admin page to the internet - and the first is far
 * the commoner. Leading with remote management sent operators to turn off a setting
 * that was never on.
 */

import { Button, Select } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { ChevronDown, ExternalLink } from "lucide-react";
import {
    detectRouterBrand,
    likelyGateway,
    routerGuide,
    FORWARD_RULES,
    ROUTER_BRANDS,
    type RouterBrand,
    type RouterForwardRule,
    type RouterFormField
} from "@/lib/router-guide";

/** A value to type elsewhere: shown verbatim, copied in one click. */
function Value({ text }: { text: string }) {
    return (
        <span className="inline-flex items-center gap-1">
            <code className="text-foreground">{text}</code>
            <CopyButton value={text} className="[&_svg]:size-3" />
        </span>
    );
}

/** The generic labels, for the brands whose form asks for the usual five things. */
const GENERIC_FORWARD_FIELDS: readonly RouterFormField[] = [
    { label: "Name", value: "name" },
    { label: "Protocol", value: "protocol" },
    { label: "External port (WAN)", value: "port" },
    { label: "Internal port (LAN)", value: "port" },
    { label: "Internal IP (device)", value: "ip" }
];

/** One cell of the forwarding table: what to put in this field for this rule. */
function ForwardValue({ field, rule, lanIp }: { field: RouterFormField; rule: RouterForwardRule; lanIp: string | null }) {
    switch (field.value) {
        case "name":
            return <Value text={rule.name} />;
        case "protocol":
            return <code className="text-foreground">{rule.protocol}</code>;
        case "port":
            return <code className="text-foreground">{rule.port}</code>;
        case "portRange":
            return <code className="text-foreground">{`${rule.port} ~ ${rule.port}`}</code>;
        case "anySource":
            // Left at zeroes on purpose: the field limits which WAN addresses may use
            // the rule, and Polaris has to answer the whole internet.
            return <code className="text-foreground">0.0.0.0 ~ 0.0.0.0</code>;
        case "ip":
            return lanIp ? <Value text={lanIp} /> : <span>this server</span>;
    }
}

export function RouterSteps({
    server,
    lanIp,
    rules = FORWARD_RULES
}: {
    server: string | null;
    lanIp: string | null;
    /** The rules to create. Defaults to the two Polaris itself needs; a deployment
     *  running game servers adds one per published game port, because nothing else
     *  in the setup ever asks for those. */
    rules?: readonly RouterForwardRule[];
}) {
    const [open, setOpen] = useState(false);
    const [brand, setBrand] = useState<RouterBrand>(() => detectRouterBrand(server));
    // A brand the operator chose outranks anything a later probe recognizes. They
    // may well be reading their own router's menus while the check runs again, and
    // swapping the instructions underneath them is worse than being wrong quietly.
    const picked = useRef(false);
    const detected = detectRouterBrand(server);

    useEffect(() => {
        if (!picked.current && detected !== "other") setBrand(detected);
    }, [detected]);

    const guide = routerGuide(brand);
    const gateway = likelyGateway(lanIp);
    const adminUrl = guide.admin ?? (gateway ? `http://${gateway}` : null);

    return (
        <div className="flex flex-col gap-3">
            {/* The brand and the way in, before the steps: both are needed to start, and
                the admin page is the one thing the operator can act on right now. */}
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-40 flex-1 flex-col gap-1">
                    Router brand
                    <Select
                        value={brand}
                        onValueChange={(value) => {
                            picked.current = true;
                            setBrand(value as RouterBrand);
                        }}
                        options={ROUTER_BRANDS.map((entry) => ({ value: entry.id, label: entry.label }))}
                    />
                </label>
                {adminUrl && (
                    <Button size="sm" variant="secondary" asChild>
                        <a href={adminUrl} target="_blank" rel="noreferrer noopener">
                            Open the router <ExternalLink className="size-3.5" />
                        </a>
                    </Button>
                )}
            </div>
            <button
                type="button"
                className="flex w-fit items-center gap-1 font-medium text-foreground hover:underline"
                onClick={() => setOpen((value) => !value)}
            >
                <ChevronDown className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
                {open ? "Hide the steps" : "Show me exactly what to do in the router"}
            </button>
            {!open ? null : (
                <div className="flex flex-col gap-3">
                    <ol className="ml-4 flex list-decimal flex-col gap-2">
                        <li>
                            Open the router&apos;s admin page.{" "}
                            {adminUrl ? (
                                <>
                                    On {guide.label} this is{" "}
                                    <a
                                        href={adminUrl}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                    >
                                        {adminUrl} <ExternalLink className="size-3" />
                                    </a>
                                    {guide.admin === null
                                        ? " - the gateway address for this network."
                                        : ", or the gateway address your devices use."}
                                </>
                            ) : (
                                <>It answers on the gateway address your devices use, usually ending in .1.</>
                            )}
                        </li>
                        <li>Sign in. {guide.signIn}</li>
                        <li>
                            Give this server a fixed address, so the forward keeps pointing at it - a new lease would
                            otherwise hand {lanIp ? <Value text={lanIp} /> : "its address"} to another machine.
                            <ol className="ml-4 mt-1 flex list-decimal flex-col gap-1">
                                <li>
                                    Go to <b className="font-medium text-foreground">{guide.reserve.path}</b>.
                                </li>
                                {guide.reserve.kind === "device" ? (
                                    <li>
                                        Find this server in the list - it is the one holding{" "}
                                        {lanIp ? <Value text={lanIp} /> : "this server's address"} - then{" "}
                                        {guide.reserve.action}.
                                    </li>
                                ) : (
                                    <>
                                        <li>
                                            Press <b className="font-medium text-foreground">{guide.reserve.add}</b>.
                                        </li>
                                        <li>
                                            Fill it in and save with{" "}
                                            <b className="font-medium text-foreground">{guide.reserve.save}</b>:
                                            <div className="mt-1 overflow-x-auto">
                                                <table className="w-full min-w-72 border-separate border-spacing-x-3 text-left">
                                                    <tbody className="align-top">
                                                        {guide.reserve.fields.map((field) => (
                                                            <tr key={field.label}>
                                                                <td className="text-muted-foreground">{field.label}</td>
                                                                <td>
                                                                    {field.value === "name" ? (
                                                                        <Value text="polaris" />
                                                                    ) : field.value === "ip" ? (
                                                                        lanIp ? (
                                                                            <Value text={lanIp} />
                                                                        ) : (
                                                                            "this server's address"
                                                                        )
                                                                    ) : (
                                                                        <>
                                                                            the MAC shown next to{" "}
                                                                            {lanIp ? (
                                                                                <code className="text-foreground">
                                                                                    {lanIp}
                                                                                </code>
                                                                            ) : (
                                                                                "this server"
                                                                            )}{" "}
                                                                            in the router&apos;s own device list
                                                                        </>
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </li>
                                    </>
                                )}
                            </ol>
                        </li>
                        <li>
                            Create {rules.length === 1 ? "one rule" : `these ${rules.length} rules`} in{" "}
                            <b className="font-medium text-foreground">{guide.forwardPath}</b>, with exactly these
                            values
                            {guide.forwardSave ? (
                                <>
                                    {" "}
                                    (saving each with{" "}
                                    <b className="font-medium text-foreground">{guide.forwardSave}</b>)
                                </>
                            ) : null}
                            :
                            <div className="mt-1 overflow-x-auto">
                                <table className="w-full min-w-80 border-separate border-spacing-x-3 text-left">
                                    <thead>
                                        <tr className="text-muted-foreground">
                                            <th className="font-normal">Field</th>
                                            {rules.map((rule, index) => (
                                                <th key={rule.name} className="font-normal">
                                                    Rule {index + 1}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="align-top">
                                        {(guide.forwardFields ?? GENERIC_FORWARD_FIELDS).map((field, index) => (
                                            <tr key={`${field.label}-${index}`}>
                                                <td>{field.label}</td>
                                                {rules.map((rule) => (
                                                    <td key={rule.name}>
                                                        <ForwardValue field={field} rule={rule} lanIp={lanIp} />
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {!lanIp && (
                                <p className="mt-1">
                                    Polaris cannot see its own LAN address on this install. Pick this server from the
                                    router&apos;s device list, or read the address from the machine itself.
                                </p>
                            )}
                        </li>
                        <li>Save, then run the DNS check again - it reports the moment the ports reach Polaris.</li>
                        <li>
                            Only if the router still answers after that: it is keeping the ports for its own admin
                            page. Go to{" "}
                            {guide.remotePath ? (
                                <b className="font-medium text-foreground">{guide.remotePath}</b>
                            ) : (
                                "the remote-management settings"
                            )}{" "}
                            and turn off management from the internet (WAN), or move it to a port such as 8443.
                        </li>
                    </ol>

                    {guide.caution && <p className="text-foreground">{guide.caution}</p>}
                </div>
            )}
        </div>
    );
}
