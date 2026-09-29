"use client";

/**
 * The three things on a profile that are not a name and not a job.
 *
 * A headline, how somebody wants to be referred to, and the addresses they want
 * handed out with them. They sit together because they are the same act - a
 * person describing themselves - and apart from the bio above them because a
 * headline is read in a list and a paragraph is not.
 *
 * The pronouns are offered as the answers people actually give plus their own
 * words. A chooser with no way out is a chooser that is wrong for somebody, and
 * "not saying" is a real answer rather than a field left blank: nothing is drawn
 * on the profile for it.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { Link2, Plus, X } from "lucide-react";
import { saveProfileDetailsAction } from "./actions";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, Input, Select } from "@polaris/ui";
import {
    linkProblem,
    MAX_HEADLINE,
    MAX_LINK_LABEL,
    MAX_PRONOUNS,
    MOST_PROFILE_LINKS,
    PRONOUN_CHOICES,
    type ProfileLink
} from "@polaris/core";

/** The value the picker holds while somebody is writing their own. Radix forbids
 *  an empty item value, and no pronoun contains a colon. */
const OWN_WORDS = "custom:";
/** And the one for having said nothing, which is what most accounts hold. */
const UNSAID = "none:";

/** What `linkProblem` in @polaris/core refuses a link with, in the reader's words. */
const LINK_PROBLEMS: Readonly<Record<string, "details.links.problems.empty" | "details.links.problems.invalid" | "details.links.problems.scheme" | "details.links.problems.noSite">> = {
    "Enter a web address": "details.links.problems.empty",
    "That is not a web address": "details.links.problems.invalid",
    "Only http:// and https:// addresses": "details.links.problems.scheme",
    "That address has no site in it": "details.links.problems.noSite"
};

function linkProblemText(problem: string, t: NamespaceTranslator<"account">): string {
    const key = LINK_PROBLEMS[problem];
    return key ? t(key) : problem;
}

function emptyLink(): ProfileLink {
    return { label: "", url: "" };
}

export function DetailsCard({
    headline,
    pronouns,
    links
}: {
    headline: string;
    pronouns: string;
    links: readonly ProfileLink[];
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [line, setLine] = useState(headline);
    const [said, setSaid] = useState(pronouns);
    const [rows, setRows] = useState<ProfileLink[]>(links.length > 0 ? [...links] : [emptyLink()]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);

    const [saved, setSaved] = useState({ headline, pronouns, links: [...links] });

    // Whichever the picker is on. Their own words are anything not in the list,
    // which is also how an account that typed one comes back to the right row.
    const listed = (PRONOUN_CHOICES as readonly string[]).includes(said);
    const choice = said === "" ? UNSAID : listed ? said : OWN_WORDS;

    const settled = rows
        .map((row) => ({ label: row.label.trim(), url: row.url.trim() }))
        .filter((row) => row.url !== "");
    // What is wrong with each row that has something in it. A row nobody has
    // filled in yet is incomplete rather than wrong, so it carries no message and
    // does not hold Save down - the same rule every other field here follows.
    const problems = rows.map((row) => (row.url.trim() ? linkProblem(row.url) : null));
    const broken = problems.some((problem) => problem !== null);
    const changed =
        line.trim() !== saved.headline.trim() ||
        said.trim() !== saved.pronouns.trim() ||
        settled.length !== saved.links.length ||
        settled.some((row, index) => row.url !== saved.links[index]?.url || row.label !== saved.links[index]?.label);

    const write = (next: ProfileLink[]) => {
        setDone(false);
        setRows(next.length > 0 ? next : [emptyLink()]);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">{t("details.title")}</h2>
                    <p className="text-muted-foreground text-xs">{t("details.description")}</p>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                    {t("details.headline")}
                    <Input
                        value={line}
                        placeholder={t("access.groups.optional")}
                        maxLength={MAX_HEADLINE}
                        onChange={(event) => {
                            setDone(false);
                            setLine(event.target.value);
                        }}
                    />
                    <span className="text-muted-foreground text-xs">{t("details.headlineHint")}</span>
                </label>

                <div className="flex flex-col gap-1 text-sm">
                    <span>{t("details.pronouns")}</span>
                    <Select
                        value={choice}
                        aria-label={t("details.pronouns")}
                        onValueChange={(value) => {
                            setDone(false);
                            if (value === UNSAID) setSaid("");
                            // Their own words start empty rather than keeping the
                            // last picked pair: choosing "in my own words" is
                            // saying the list did not have it.
                            else if (value === OWN_WORDS) setSaid(listed || said === "" ? " " : said);
                            else setSaid(value);
                        }}
                        options={[
                            { value: UNSAID, label: t("details.preferNot") },
                            ...PRONOUN_CHOICES.map((entry) => ({ value: entry, label: entry })),
                            { value: OWN_WORDS, label: t("details.ownWords") }
                        ]}
                    />
                    {choice === OWN_WORDS ? (
                        <Input
                            value={said.trim() === "" ? "" : said}
                            placeholder={t("details.pronounsPlaceholder")}
                            maxLength={MAX_PRONOUNS}
                            aria-label={t("details.yourPronouns")}
                            onChange={(event) => {
                                setDone(false);
                                setSaid(event.target.value);
                            }}
                        />
                    ) : null}
                    <span className="text-muted-foreground text-xs">{t("details.pronounsHint")}</span>
                </div>

                <div className="flex flex-col gap-2 text-sm">
                    <span>{t("details.links.title")}</span>
                    {rows.map((row, index) => (
                        // Keyed by position: these are the same few fields being
                        // edited, and keying by contents would rebuild the input
                        // somebody is typing into on every keystroke.
                        <div key={index} className="flex flex-wrap items-center gap-2">
                            <Input
                                value={row.label}
                                placeholder={t("details.links.namePlaceholder")}
                                maxLength={MAX_LINK_LABEL}
                                aria-label={t("details.links.name", { number: index + 1 })}
                                className="w-full sm:w-40"
                                onChange={(event) => {
                                    const next = [...rows];
                                    next[index] = { ...row, label: event.target.value };
                                    write(next);
                                }}
                            />
                            <Input
                                value={row.url}
                                placeholder="yoursite.com"
                                inputMode="url"
                                aria-label={t("details.links.address", { number: index + 1 })}
                                aria-invalid={problems[index] ? true : undefined}
                                aria-describedby={problems[index] ? `link-${index}-problem` : undefined}
                                className="min-w-0 flex-1"
                                onChange={(event) => {
                                    const next = [...rows];
                                    next[index] = { ...row, url: event.target.value };
                                    write(next);
                                }}
                            />
                            <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={t("details.links.remove", { number: index + 1 })}
                                title={t("emails.remove")}
                                onClick={() => write(rows.filter((_, at) => at !== index))}
                            >
                                <X className="size-4 shrink-0" />
                            </Button>
                            {problems[index] ? (
                                <p id={`link-${index}-problem`} className="text-danger w-full text-xs">
                                    {linkProblemText(problems[index] ?? "", t)}
                                </p>
                            ) : null}
                        </div>
                    ))}
                    {rows.length < MOST_PROFILE_LINKS ? (
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="self-start"
                            onClick={() => write([...rows, emptyLink()])}
                        >
                            <Plus className="size-4 shrink-0" />
                            {t("details.links.add")}
                        </Button>
                    ) : null}
                    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <Link2 className="size-3 shrink-0" />
                        {t("details.links.hint")}
                    </span>
                </div>

                <div className="flex items-center justify-between gap-2">
                    {error ? <p className="text-danger text-sm">{error}</p> : null}
                    {done && !error ? <p className="text-success text-sm">{t("appearance.saved")}</p> : null}
                    <Button
                        type="button"
                        className="ml-auto"
                        aria-disabled={busy || !changed || broken}
                        disabled={busy || !changed || broken}
                        onClick={async () => {
                            setBusy(true);
                            setError("");
                            setDone(false);
                            const payload = {
                                headline: line,
                                pronouns: said.trim(),
                                links: settled
                            };
                            const result = await runAction(
                                () => saveProfileDetailsAction(payload),
                                setError
                            );
                            setBusy(false);
                            if (!result || result.error) {
                                if (result?.error) setError(result.error);
                                return;
                            }
                            setSaved({
                                headline: payload.headline,
                                pronouns: payload.pronouns,
                                links: settled
                            });
                            setDone(true);
                        }}
                    >
                        {busy ? tc("actions.saving") : tc("actions.save")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
