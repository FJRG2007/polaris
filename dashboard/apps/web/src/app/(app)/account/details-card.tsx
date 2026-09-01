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
                    <h2 className="text-sm font-medium">About you</h2>
                    <p className="text-muted-foreground text-xs">
                        What sits beside your name on your page, and where else you can be found.
                    </p>
                </div>

                <label className="flex flex-col gap-1 text-sm">
                    Headline
                    <Input
                        value={line}
                        placeholder="Optional"
                        maxLength={MAX_HEADLINE}
                        onChange={(event) => {
                            setDone(false);
                            setLine(event.target.value);
                        }}
                    />
                    <span className="text-muted-foreground text-xs">
                        One line, under your name. What you do, not your life story - the paragraph goes in
                        the description above.
                    </span>
                </label>

                <div className="flex flex-col gap-1 text-sm">
                    <span>Pronouns</span>
                    <Select
                        value={choice}
                        aria-label="Pronouns"
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
                            { value: UNSAID, label: "Prefer not to say" },
                            ...PRONOUN_CHOICES.map((entry) => ({ value: entry, label: entry })),
                            { value: OWN_WORDS, label: "In my own words" }
                        ]}
                    />
                    {choice === OWN_WORDS ? (
                        <Input
                            value={said.trim() === "" ? "" : said}
                            placeholder="e.g. ze/hir"
                            maxLength={MAX_PRONOUNS}
                            aria-label="Your pronouns"
                            onChange={(event) => {
                                setDone(false);
                                setSaid(event.target.value);
                            }}
                        />
                    ) : null}
                    <span className="text-muted-foreground text-xs">
                        Drawn beside your name. Nothing is drawn when you have not said.
                    </span>
                </div>

                <div className="flex flex-col gap-2 text-sm">
                    <span>Links</span>
                    {rows.map((row, index) => (
                        // Keyed by position: these are the same few fields being
                        // edited, and keying by contents would rebuild the input
                        // somebody is typing into on every keystroke.
                        <div key={index} className="flex flex-wrap items-center gap-2">
                            <Input
                                value={row.label}
                                placeholder="Name (optional)"
                                maxLength={MAX_LINK_LABEL}
                                aria-label={`Link ${index + 1} name`}
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
                                aria-label={`Link ${index + 1} address`}
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
                                aria-label={`Remove link ${index + 1}`}
                                title="Remove"
                                onClick={() => write(rows.filter((_, at) => at !== index))}
                            >
                                <X className="size-4 shrink-0" />
                            </Button>
                            {problems[index] ? (
                                <p id={`link-${index}-problem`} className="text-danger w-full text-xs">
                                    {problems[index]}
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
                            Add a link
                        </Button>
                    ) : null}
                    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <Link2 className="size-3 shrink-0" />
                        A portfolio, a site, a linktree. Typing the site is enough - https:// is added for
                        you - and an address with no name is drawn as its own host.
                    </span>
                </div>

                <div className="flex items-center justify-between gap-2">
                    {error ? <p className="text-danger text-sm">{error}</p> : null}
                    {done && !error ? <p className="text-success text-sm">Saved.</p> : null}
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
                        {busy ? "Saving..." : "Save"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
