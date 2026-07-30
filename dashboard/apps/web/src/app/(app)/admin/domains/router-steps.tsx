"use client";

/**
 * The port forward, step by step, for the brand of router in the way.
 *
 * Everything here is a value the operator has to type somewhere else, so it is shown
 * as a value - the admin address, the two rules, this server's LAN address - rather
 * than described in a sentence they have to translate. The brand starts on whatever
 * answered the reachability probe and stays a picker, because a router that names
 * itself is luck, not a guarantee.
 */

import { useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";
import { Button, Select } from "@polaris/ui";
import {
    detectRouterBrand,
    likelyGateway,
    routerGuide,
    FORWARD_RULES,
    ROUTER_BRANDS,
    type RouterBrand
} from "@/lib/router-guide";

/** A value to type elsewhere: shown verbatim, copied in one click. */
function Value({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <span className="inline-flex items-center gap-1">
            <code className="text-foreground">{text}</code>
            <button
                type="button"
                aria-label={`Copy ${text}`}
                title="Copy"
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                    void navigator.clipboard.writeText(text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                }}
            >
                {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
            </button>
        </span>
    );
}

export function RouterSteps({ server, lanIp }: { server: string | null; lanIp: string | null }) {
    const [open, setOpen] = useState(false);
    const [brand, setBrand] = useState<RouterBrand>(() => detectRouterBrand(server));
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
                        onValueChange={(value) => setBrand(value as RouterBrand)}
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
                            Free up the ports: go to{" "}
                            {guide.remotePath ? <b className="font-medium text-foreground">{guide.remotePath}</b> : "the remote-management settings"}{" "}
                            and turn off management from the internet (WAN), or move it to a port such as 8443. While
                            the router answers on 80 and 443, nothing you forward can reach this server.
                        </li>
                        <li>
                            Give this server a fixed address. In the DHCP settings, reserve{" "}
                            {lanIp ? <Value text={lanIp} /> : "this server's address"} for it - a forward points at an
                            address, and a new lease would send it to another machine.
                        </li>
                        <li>
                            Create two rules in <b className="font-medium text-foreground">{guide.forwardPath}</b>, with
                            exactly these values:
                            <div className="mt-1 overflow-x-auto">
                                <table className="w-full min-w-80 border-separate border-spacing-x-3 text-left">
                                    <thead>
                                        <tr className="text-muted-foreground">
                                            <th className="font-normal">Field</th>
                                            {FORWARD_RULES.map((rule) => (
                                                <th key={rule.name} className="font-normal">
                                                    Rule {rule.port === 80 ? "1" : "2"}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="align-top">
                                        <tr>
                                            <td>Name</td>
                                            {FORWARD_RULES.map((rule) => (
                                                <td key={rule.name}>
                                                    <Value text={rule.name} />
                                                </td>
                                            ))}
                                        </tr>
                                        <tr>
                                            <td>Protocol</td>
                                            {FORWARD_RULES.map((rule) => (
                                                <td key={rule.name}>
                                                    <code className="text-foreground">{rule.protocol}</code>
                                                </td>
                                            ))}
                                        </tr>
                                        <tr>
                                            <td>External port (WAN)</td>
                                            {FORWARD_RULES.map((rule) => (
                                                <td key={rule.name}>
                                                    <code className="text-foreground">{rule.port}</code>
                                                </td>
                                            ))}
                                        </tr>
                                        <tr>
                                            <td>Internal port (LAN)</td>
                                            {FORWARD_RULES.map((rule) => (
                                                <td key={rule.name}>
                                                    <code className="text-foreground">{rule.port}</code>
                                                </td>
                                            ))}
                                        </tr>
                                        <tr>
                                            <td>Internal IP (device)</td>
                                            {FORWARD_RULES.map((rule) => (
                                                <td key={rule.name}>
                                                    {lanIp ? <Value text={lanIp} /> : "this server"}
                                                </td>
                                            ))}
                                        </tr>
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
                    </ol>

                    {guide.caution && <p className="text-foreground">{guide.caution}</p>}
                </div>
            )}
        </div>
    );
}
