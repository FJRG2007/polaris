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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ChevronDown, ExternalLink } from "lucide-react";
import {
    detectRouterBrand,
    fitRuleNames,
    likelyGateway,
    mergeProtocolRules,
    routerGuide,
    FORWARD_RULES,
    ROUTER_BRANDS,
    type RouterBrand,
    type RouterForwardRule,
    type RouterFormField
} from "@/lib/router-guide";
import { routerGuideIn } from "./router-words";

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
function genericForwardFields(t: NamespaceTranslator<"admin">): readonly RouterFormField[] {
    return [
        { label: t("domainsRouter.fields.name"), value: "name" },
        { label: t("domainsRouter.fields.protocol"), value: "protocol" },
        { label: t("domainsRouter.fields.externalPort"), value: "port" },
        { label: t("domainsRouter.fields.internalPort"), value: "port" },
        { label: t("domainsRouter.fields.internalIp"), value: "ip" }
    ];
}

/** A value from the router's own menus, as it is shown there. */
function bold(chunks: ReactNode[]) {
    return (
        <b key="b" className="font-medium text-foreground">
            {chunks}
        </b>
    );
}

/** One cell of the forwarding table: what to put in this field for this rule. */
function ForwardValue({ field, rule, lanIp }: { field: RouterFormField; rule: RouterForwardRule; lanIp: string | null }) {
    const t = useTranslations("admin");
    switch (field.value) {
        case "name":
            return <Value text={rule.name} />;
        case "protocol":
            return <code className="text-foreground">{rule.protocol}</code>;
        case "port":
            // A range rule fills the same single field with `start-end`, which every
            // brand's form accepts - it is how a router is asked for a run of ports.
            return (
                <code className="text-foreground">
                    {rule.endPort && rule.endPort !== rule.port ? `${rule.port}-${rule.endPort}` : rule.port}
                </code>
            );
        case "portRange":
            return <code className="text-foreground">{`${rule.port} ~ ${rule.endPort ?? rule.port}`}</code>;
        case "anySource":
            // Left at zeroes on purpose: the field limits which WAN addresses may use
            // the rule, and Polaris has to answer the whole internet.
            return <code className="text-foreground">0.0.0.0 ~ 0.0.0.0</code>;
        case "ip":
            return lanIp ? <Value text={lanIp} /> : <span>{t("domainsRouter.thisServer")}</span>;
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
    const t = useTranslations("admin");
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

    const guide = routerGuideIn(t, routerGuide(brand));
    const gateway = likelyGateway(lanIp);
    const adminUrl = guide.admin ?? (gateway ? `http://${gateway}` : null);
    // Named for the form in front of the operator rather than for Polaris: a brand
    // whose Name field is too short to hold `polaris-games-tcp` gets it shortened
    // here, so what the page shows is what the router will accept.
    // Merged first, then named: a brand that can express two transports in one rule
    // needs one name, and shortening two names it will never show would be work done
    // for a table that does not exist.
    const named = fitRuleNames(mergeProtocolRules(rules, guide.combinedProtocol), guide.nameLimit);

    return (
        <div className="flex flex-col gap-3">
            {/* The brand and the way in, before the steps: both are needed to start, and
                the admin page is the one thing the operator can act on right now. */}
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-40 flex-1 flex-col gap-1">
                    {t("domainsRouter.brand")}
                    <Select
                        value={brand}
                        onValueChange={(value) => {
                            picked.current = true;
                            setBrand(value as RouterBrand);
                        }}
                        options={ROUTER_BRANDS.map((entry) => ({ value: entry.id, label: routerGuideIn(t, entry).label }))}
                    />
                </label>
                {adminUrl && (
                    <Button size="sm" variant="secondary" asChild>
                        <a href={adminUrl} target="_blank" rel="noreferrer noopener">
                            {t("domainsRouter.open")} <ExternalLink className="size-3.5" />
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
                {open ? t("domainsRouter.hideSteps") : t("domainsRouter.showSteps")}
            </button>
            {!open ? null : (
                <div className="flex flex-col gap-3">
                    <ol className="ml-4 flex list-decimal flex-col gap-2">
                        <li>
                            {t("domainsRouter.steps.openAdmin")}{" "}
                            {adminUrl
                                ? t.rich(
                                      guide.admin === null
                                          ? "domainsRouter.steps.adminGateway"
                                          : "domainsRouter.steps.adminKnown",
                                      {
                                          brand: guide.label,
                                          url: adminUrl,
                                          link: (chunks) => (
                                              <a
                                                  key="link"
                                                  href={adminUrl}
                                                  target="_blank"
                                                  rel="noreferrer noopener"
                                                  className="inline-flex items-center gap-1 text-primary hover:underline"
                                              >
                                                  {chunks} <ExternalLink className="size-3" />
                                              </a>
                                          )
                                      }
                                  )
                                : t("domainsRouter.steps.adminUnknown")}
                        </li>
                        <li>
                            {t("domainsRouter.steps.signIn")} {guide.signIn}
                        </li>
                        <li>
                            {t.rich("domainsRouter.steps.reserve", {
                                address: lanIp ? <Value key="ip" text={lanIp} /> : t("domainsRouter.itsAddress")
                            })}
                            <ol className="ml-4 mt-1 flex list-decimal flex-col gap-1">
                                <li>{t.rich("domainsRouter.steps.goTo", { path: guide.reserve.path, b: bold })}</li>
                                {guide.reserve.kind === "device" ? (
                                    <li>
                                        {t.rich("domainsRouter.steps.findDevice", {
                                            address: lanIp ? (
                                                <Value key="ip" text={lanIp} />
                                            ) : (
                                                t("domainsRouter.thisServerAddress")
                                            ),
                                            action: guide.reserve.action
                                        })}
                                    </li>
                                ) : (
                                    <>
                                        <li>
                                            {t.rich("domainsRouter.steps.press", { button: guide.reserve.add, b: bold })}
                                        </li>
                                        <li>
                                            {t.rich("domainsRouter.steps.fillIn", { button: guide.reserve.save, b: bold })}
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
                                                                            t("domainsRouter.thisServerAddress")
                                                                        )
                                                                    ) : (
                                                                        t.rich("domainsRouter.steps.mac", {
                                                                            server: lanIp ? (
                                                                                <code key="ip" className="text-foreground">
                                                                                    {lanIp}
                                                                                </code>
                                                                            ) : (
                                                                                t("domainsRouter.thisServer")
                                                                            )
                                                                        })
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
                            {guide.forwardSave
                                ? t.rich("domainsRouter.steps.createRulesSaving", {
                                      count: named.length,
                                      path: guide.forwardPath,
                                      button: guide.forwardSave,
                                      b: bold,
                                      save: (chunks) => (
                                          <b key="save" className="font-medium text-foreground">
                                              {chunks}
                                          </b>
                                      )
                                  })
                                : t.rich("domainsRouter.steps.createRules", {
                                      count: named.length,
                                      path: guide.forwardPath,
                                      b: bold
                                  })}
                            <div className="mt-1 overflow-x-auto">
                                <table className="w-full min-w-80 border-separate border-spacing-x-3 text-left">
                                    <thead>
                                        <tr className="text-muted-foreground">
                                            <th className="font-normal">{t("domainsRouter.steps.field")}</th>
                                            {named.map((rule, index) => (
                                                <th key={rule.name} className="font-normal">
                                                    {t("domainsRouter.steps.rule", { number: index + 1 })}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody className="align-top">
                                        {(guide.forwardFields ?? genericForwardFields(t)).map((field, index) => (
                                            <tr key={`${field.label}-${index}`}>
                                                <td>{field.label}</td>
                                                {named.map((rule) => (
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
                                <p className="mt-1">{t("domainsRouter.steps.noLanIp")}</p>
                            )}
                        </li>
                        {/* A rule saved but left off is the failure with nothing to see:
                            it is listed, its values are right, and no packet moves. */}
                        {guide.forwardEnable && (
                            <li>
                                {t("domainsRouter.steps.switchOn", { count: named.length })} {guide.forwardEnable}
                            </li>
                        )}
                        <li>{t("domainsRouter.steps.checkAgain")}</li>
                        <li>
                            {guide.remotePath
                                ? t.rich("domainsRouter.steps.remote", { path: guide.remotePath, b: bold })
                                : t("domainsRouter.steps.remoteGeneric")}
                        </li>
                    </ol>

                    {guide.caution && <p className="text-foreground">{guide.caution}</p>}
                </div>
            )}
        </div>
    );
}
