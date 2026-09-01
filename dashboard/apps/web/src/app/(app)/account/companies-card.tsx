"use client";

/**
 * Where somebody works, on their own profile.
 *
 * Two different claims, and the screen is honest about which is which. The
 * organizations on this Polaris are the ones it can actually vouch for - it
 * holds the roster and this account is on it - so they carry a tick on the
 * profile and are picked here rather than typed. Anything else is a line
 * somebody wrote about themselves, which is what the free field is for and why
 * it is drawn plainly.
 *
 * Nothing is shown until it is marked. Being on a roster is a fact about an
 * organization rather than a statement somebody made about themselves, and an
 * account that joined a company's Polaris did not thereby publish where it
 * works - which is exactly the disclosure a default of "show them all" would
 * have made on everybody's behalf.
 *
 * A person can be in several at once and show any subset - that is what the
 * checkboxes are - and can type several more. Both halves are lists for the same
 * reason: somebody who has worked in two places has worked in two places, and a
 * single field made them pick one.
 */

import Link from "next/link";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { saveCompaniesAction } from "./actions";
import { OrgAvatar } from "@/components/avatar";
import { MAX_COMPANY_LENGTH, MOST_COMPANIES } from "@polaris/core";
import { BadgeCheck, ExternalLink, Plus, X } from "lucide-react";
import { Button, Card, CardBody, Checkbox, Input } from "@polaris/ui";
import type { ProfileCompany } from "@/lib/profile-service";

export function CompaniesCard({
    companies,
    organizations,
    shown,
    username
}: {
    /** The places they typed, which Polaris knows nothing about. */
    companies: readonly string[];
    /** Every organization here they belong to, owned or joined. */
    organizations: readonly ProfileCompany[];
    /** The ids of the ones they have chosen to show. */
    shown: readonly string[];
    /** Their handle, for the link to the page all of this ends up on. Empty for
     *  an account that has not taken one, and then there is no page to link to. */
    username: string;
}) {
    // Always one empty row at the end, so adding a second place is typing into
    // the field that is already there rather than finding a button first.
    const [typed, setTyped] = useState<string[]>([...companies, ""]);
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(shown));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);

    const [savedTyped, setSavedTyped] = useState<readonly string[]>(companies);
    const [savedPicked, setSavedPicked] = useState<readonly string[]>(shown);

    /** What would actually be stored: trimmed, empty rows dropped, no repeats. */
    const settled = typed
        .map((entry) => entry.trim())
        .filter((entry, index, all) => entry !== "" && all.indexOf(entry) === index);
    const changed =
        settled.length !== savedTyped.length ||
        settled.some((entry, index) => entry !== savedTyped[index]) ||
        picked.size !== savedPicked.length ||
        savedPicked.some((id) => !picked.has(id));

    /** Keep exactly one empty row at the end, however the list was edited. */
    const write = (next: string[]) => {
        setDone(false);
        const trimmedTail = next.filter((entry, index) => entry !== "" || index === next.length - 1);
        setTyped(trimmedTail.at(-1) === "" ? trimmedTail : [...trimmedTail, ""]);
    };

    const toggle = (id: string) => {
        setDone(false);
        setPicked((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-sm font-medium">Where you work</h2>
                        {username ? (
                            <Link
                                href={`/u/${username}`}
                                className="text-primary flex items-center gap-1 text-xs hover:underline"
                            >
                                See your page
                                <ExternalLink className="size-3 shrink-0" />
                            </Link>
                        ) : null}
                    </div>
                    <p className="text-muted-foreground text-xs">
                        Who sees any of this is one setting on your privacy screen. Nothing here is shown until
                        you tick it.
                    </p>
                </div>

                {organizations.length > 0 ? (
                    <fieldset className="flex flex-col gap-2">
                        <legend className="text-muted-foreground mb-1 text-xs">
                            Organizations here. These carry a tick on your page: Polaris holds the roster and
                            you are on it.
                        </legend>
                        {organizations.map((org) => (
                            <label key={org.id} className="flex items-center gap-2 text-sm">
                                <Checkbox checked={picked.has(org.id)} onChange={() => toggle(org.id)} />
                                {/* Its own mark, the way an organization is drawn
                                    everywhere else here and on the page this
                                    decides the contents of. */}
                                <OrgAvatar org={org} size={20} />
                                <span className="min-w-0 flex-1 truncate" title={org.name}>{org.name}</span>
                                {picked.has(org.id) ? (
                                    <BadgeCheck className="text-primary size-3.5 shrink-0" aria-hidden />
                                ) : null}
                            </label>
                        ))}
                    </fieldset>
                ) : null}

                <div className="flex flex-col gap-2 text-sm">
                    <span>Somewhere else</span>
                    {typed.map((entry, index) => (
                        // Keyed by position, deliberately: these are the same few
                        // fields being edited, and keying by their contents would
                        // rebuild the input somebody is typing into on every
                        // keystroke.
                        <div key={index} className="flex items-center gap-2">
                            <Input
                                value={entry}
                                placeholder={index === 0 ? "Optional" : "Add another"}
                                maxLength={MAX_COMPANY_LENGTH}
                                autoComplete="organization"
                                aria-label={`Company ${index + 1}`}
                                onChange={(event) => {
                                    const next = [...typed];
                                    next[index] = event.target.value;
                                    write(next);
                                }}
                            />
                            {entry.trim() ? (
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`Remove ${entry.trim()}`}
                                    title="Remove"
                                    onClick={() => write(typed.filter((_, at) => at !== index))}
                                >
                                    <X className="size-4 shrink-0" />
                                </Button>
                            ) : (
                                // A spacer, so the fields line up whether or not
                                // the row has anything to remove.
                                <span className="size-8 shrink-0" />
                            )}
                        </div>
                    ))}
                    {settled.length < MOST_COMPANIES && typed.at(-1)?.trim() ? (
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="self-start"
                            onClick={() => write([...typed, ""])}
                        >
                            <Plus className="size-4 shrink-0" />
                            Add another
                        </Button>
                    ) : null}
                    <span className="text-muted-foreground text-xs">
                        Drawn without a tick, because Polaris knows nothing about these beyond that you typed
                        them.
                    </span>
                </div>

                <div className="flex items-center justify-between gap-2">
                    {error ? <p className="text-danger text-sm">{error}</p> : null}
                    {done && !error ? <p className="text-success text-sm">Saved.</p> : null}
                    <Button
                        type="button"
                        className="ml-auto"
                        disabled={busy || !changed}
                        onClick={async () => {
                            setBusy(true);
                            setError("");
                            setDone(false);
                            const ids = [...picked];
                            const result = await runAction(
                                () => saveCompaniesAction({ companies: settled, organizationIds: ids }),
                                setError
                            );
                            setBusy(false);
                            if (!result || result.error) {
                                if (result?.error) setError(result.error);
                                return;
                            }
                            setSavedTyped(settled);
                            setTyped([...settled, ""]);
                            setSavedPicked(ids);
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
