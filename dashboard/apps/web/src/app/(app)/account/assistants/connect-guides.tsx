"use client";

/**
 * "Connect an MCP client": pick a client from its logo, then follow that
 * client's own steps with every value ready to copy in the step it is typed
 * in, or the generic steps for any client not listed.
 *
 * The chosen client lives in the address (`#connect-<id>`), so a guide can be
 * linked to and survives a reload. Nothing here carries a credential: every
 * client signs in through the consent screen.
 */

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowLeft, ExternalLink, Search, Plug } from "lucide-react";
import { ClaudeMark, CursorMark, OpenAiMark } from "@/components/model-marks";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    SegmentedControl,
    cn
} from "@polaris/ui";
import {
    CLIENT_GUIDES,
    CONNECTION_TYPES,
    matchClients,
    LABELLED_KINDS,
    type ClientGuide,
    type ClientLogo,
    type ConnectionType,
    type CopyField,
    type ServerUrls
} from "@/lib/mcp/client-guides";

/** The id the generic guide is addressed by. */
const OTHER = "other";
const HASH_PREFIX = "#connect-";

/** A value somebody copies: one line or a block, with its copy button. */
function Copyable({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-foreground">
                {value}
            </code>
            <CopyButton value={value} label={label} />
        </div>
    );
}

/** A client's mark on a light tile, so marks drawn in black read in dark mode
 *  without being recoloured. */
function LogoTile({ logo, className }: { logo: ClientLogo | null; className?: string }) {
    const mark =
        logo === null ? (
            <Plug className="size-5 text-neutral-500" aria-hidden />
        ) : "mark" in logo ? (
            logo.mark === "claude" ? (
                <ClaudeMark className="size-5" />
            ) : logo.mark === "openai" ? (
                <OpenAiMark className="size-5" />
            ) : (
                <CursorMark className="size-5" />
            )
        ) : (
            // The vendors' own files, served as they ship: their gradients and
            // clip paths carry ids that would collide inline.
            <img src={logo.src} alt="" className="size-5 object-contain" />
        );
    return (
        <span
            className={cn(
                "grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-white text-neutral-900",
                className
            )}
            aria-hidden
        >
            {mark}
        </span>
    );
}

/** Numbered steps, each with its value to copy under it. */
function Steps({ children }: { children: React.ReactNode }) {
    return <ol className="flex flex-col gap-3">{children}</ol>;
}

function Step({
    number,
    text,
    children
}: {
    number: number;
    text: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <li className="flex gap-3">
            <span
                className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground"
                aria-hidden
            >
                {number}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
                <p>{text}</p>
                {children}
            </div>
        </li>
    );
}

function OfficialLink({ href }: { href: string }) {
    const t = useTranslations("mcpConnect");
    return (
        <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
            {t("official")}
            <ExternalLink className="size-3" aria-hidden />
        </a>
    );
}

/** A value from a step, under the name of the client's field it goes in when
 *  it has one. */
function Field({ field, urls }: { field: CopyField; urls: ServerUrls }) {
    const t = useTranslations("mcpConnect");
    const copyable = <Copyable value={field.value(urls)} label={t(`copy.${field.kind}`)} />;
    if (!LABELLED_KINDS.has(field.kind)) return copyable;
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">
                {t(`fields.${field.kind}` as never)}
            </span>
            {copyable}
        </div>
    );
}

function ClientSteps({ guide, urls }: { guide: ClientGuide; urls: ServerUrls }) {
    const t = useTranslations("mcpConnect");
    // The catalog test holds every key a guide names to both locales. Steps
    // mark the labels and values to look for in the client with <b>.
    const say = (key: string) =>
        t
            .rich<ReactNode>(`clients.${guide.id}.${key}` as never, {
                b: (chunks) => <strong className="font-semibold">{chunks}</strong>
            })
            .map((part, index) => <Fragment key={index}>{part}</Fragment>);
    const label = (key: string) => t(`clients.${guide.id}.${key}` as never);

    return (
        <div className="flex flex-col gap-4">
            {guide.install || guide.open ? (
                <div className="flex flex-wrap gap-2">
                    {guide.install ? (
                        <Button asChild size="sm" className="w-fit">
                            <a href={guide.install.href(urls)}>{label(guide.install.key)}</a>
                        </Button>
                    ) : null}
                    {guide.open ? (
                        <Button asChild variant="outline" size="sm" className="w-fit">
                            <a href={guide.open.href} target="_blank" rel="noreferrer noopener">
                                {label(guide.open.key)}
                                <ExternalLink className="size-3.5" aria-hidden />
                            </a>
                        </Button>
                    ) : null}
                </div>
            ) : null}
            <Steps>
                {guide.steps.map((step, index) => (
                    <Step key={step.key} number={index + 1} text={say(step.key)}>
                        {step.copy?.map((field) => (
                            <Field key={field.kind} field={field} urls={urls} />
                        ))}
                    </Step>
                ))}
            </Steps>
            {guide.notes?.map((note) => (
                <p key={note} className="text-xs text-muted-foreground">
                    {say(note)}
                </p>
            ))}
            {guide.docs ? <OfficialLink href={guide.docs} /> : null}
        </div>
    );
}

/** The four generic steps, with the configuration for the chosen transport. */
function OtherSteps({ urls }: { urls: ServerUrls }) {
    const t = useTranslations("mcpConnect");
    const [type, setType] = useState<ConnectionType>("http");
    const chosen =
        CONNECTION_TYPES.find((candidate) => candidate.id === type) ?? CONNECTION_TYPES[0];

    return (
        <div className="flex flex-col gap-4">
            <Steps>
                <Step number={1} text={t("other.step1")} />
                <Step number={2} text={t("other.step2")}>
                    <SegmentedControl
                        value={type}
                        onValueChange={setType}
                        aria-label={t("other.step2")}
                        size="sm"
                        options={CONNECTION_TYPES.map((candidate) => ({
                            value: candidate.id,
                            label: t(`other.types.${candidate.id}.label`)
                        }))}
                    />
                    <p className="text-xs text-muted-foreground">{t(`other.types.${type}.hint`)}</p>
                </Step>
                <Step number={3} text={t("other.step3")}>
                    <Copyable value={chosen.value(urls)} label={t("copy.config")} />
                </Step>
                <Step number={4} text={t("other.step4")} />
            </Steps>
            <p className="text-xs text-muted-foreground">
                {t.rich("other.key", {
                    header: (
                        <code key="header" className="text-xs">
                            {/* i18n-ignore: an HTTP header, typed as is */}
                            {"Authorization: Bearer <key>"}
                        </code>
                    ),
                    link: (chunks) => (
                        <Link key="link" href="/account/api-keys/new" className="underline">
                            {chunks}
                        </Link>
                    )
                })}
            </p>
        </div>
    );
}

export function ConnectGuides({ urls }: { urls: ServerUrls }) {
    const t = useTranslations("mcpConnect");
    const [query, setQuery] = useState("");
    const [chosen, setChosen] = useState<string | null>(null);
    // Where focus goes after a choice, since the control that made it is gone.
    const focusNext = useRef<"back" | "search" | null>(null);
    const back = useRef<HTMLButtonElement>(null);
    const search = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const target =
            focusNext.current === "back"
                ? back.current
                : focusNext.current === "search"
                  ? search.current
                  : null;
        focusNext.current = null;
        target?.focus();
    }, [chosen]);

    // The guide in the address, once the page is on screen: reading it during
    // render would draw the server's markup and the browser's differently.
    useEffect(() => {
        const read = () => {
            const id = window.location.hash.startsWith(HASH_PREFIX)
                ? window.location.hash.slice(HASH_PREFIX.length)
                : null;
            const known = id === OTHER || CLIENT_GUIDES.some((guide) => guide.id === id);
            setChosen(known ? id : null);
            return known;
        };
        // Opened from a link to one guide: bring it into view.
        if (read()) document.getElementById("connect")?.scrollIntoView();
        window.addEventListener("hashchange", read);
        return () => window.removeEventListener("hashchange", read);
    }, []);

    const choose = (id: string | null) => {
        focusNext.current = id ? "back" : "search";
        setChosen(id);
        const { pathname, search } = window.location;
        window.history.replaceState(
            null,
            "",
            id ? `${pathname}${search}${HASH_PREFIX}${id}` : `${pathname}${search}#connect`
        );
    };

    const guide = CLIENT_GUIDES.find((candidate) => candidate.id === chosen) ?? null;
    const shown = matchClients(query);
    const name = chosen === OTHER ? t("other.name") : guide?.name;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("title")}</CardTitle>
                <p className="text-sm text-muted-foreground">{t("intro")}</p>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 text-sm">
                {name ? (
                    <section
                        className="flex flex-col gap-4"
                        aria-label={t("guideFor", { client: name })}
                    >
                        <div className="flex min-w-0 items-center gap-3">
                            <Button
                                ref={back}
                                variant="ghost"
                                size="icon"
                                onClick={() => choose(null)}
                                aria-label={t("back")}
                                title={t("back")}
                            >
                                <ArrowLeft className="size-4" aria-hidden />
                            </Button>
                            <LogoTile logo={guide?.logo ?? null} className="size-8" />
                            <h3 className="min-w-0 truncate font-medium" title={name}>
                                {name}
                            </h3>
                        </div>
                        {guide ? (
                            <ClientSteps guide={guide} urls={urls} />
                        ) : (
                            <OtherSteps urls={urls} />
                        )}
                    </section>
                ) : (
                    <div className="flex flex-col gap-3">
                        <p className="font-medium">{t("pick")}</p>
                        <span className="relative">
                            <Search
                                className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                                aria-hidden
                            />
                            <Input
                                ref={search}
                                type="search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t("search")}
                                aria-label={t("search")}
                                autoComplete="off"
                                className="pl-8"
                            />
                        </span>
                        {shown.length === 0 ? (
                            <p className="text-muted-foreground">
                                {t("noMatch", { query: query.trim() })}
                            </p>
                        ) : null}
                        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {[
                                ...shown.map((item) => ({
                                    id: item.id,
                                    name: item.name,
                                    logo: item.logo as ClientLogo | null
                                })),
                                { id: OTHER, name: t("other.name"), logo: null }
                            ].map((item) => (
                                <li key={item.id} className="min-w-0">
                                    <button
                                        type="button"
                                        onClick={() => choose(item.id)}
                                        className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-border p-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <LogoTile logo={item.logo} className="size-8" />
                                        <span
                                            className="min-w-0 flex-1 truncate font-medium"
                                            title={item.name}
                                        >
                                            {item.name}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
