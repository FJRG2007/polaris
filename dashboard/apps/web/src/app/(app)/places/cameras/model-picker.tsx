"use client";

/**
 * Picking the camera by name.
 *
 * The form used to ask for a make and then explain, in a paragraph, which of
 * three TP-Link profiles the reader's camera was - a question they could only
 * answer by knowing the thing the profile exists to tell them. The model is what
 * is on the box, and everything else follows from it.
 *
 * A list of fifty-odd is a list nobody scrolls, so it is typed into. What is
 * typed is matched against the name on the box AND the name on the invoice:
 * "tplink" has to find Tapo, because nobody buying one of these thinks of Tapo
 * as the manufacturer.
 *
 * Built from the menu primitives rather than a new control: the search field
 * inside a menu is a solved problem here, down to the focus it would otherwise
 * lose the moment the menu opens.
 */

import { Camera, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { TpLinkMark } from "@/components/brand-icons";
import {
    CAMERA_MODELS,
    cameraModel,
    modelsOfBrand,
    searchBrands,
    searchModels,
    type CameraModel
} from "@/lib/home/camera-models";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    MenuSearch
} from "@polaris/ui";

/** The shell every picker here is: a field that opens a menu with a search box
 *  at the top of it. Written once because the make and the model are the same
 *  control over different lists, and two of them would drift. */
function PickerMenu({
    query,
    onQuery,
    placeholder,
    label,
    empty,
    value,
    children
}: {
    query: string;
    onQuery: (value: string) => void;
    placeholder: string;
    label: string;
    empty: string;
    value: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <DropdownMenu onOpenChange={(open) => (open ? onQuery("") : undefined)}>
            <DropdownMenuTrigger
                className="group flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-field px-2.5 text-[0.8125rem] transition-colors duration-fast hover:border-border-strong data-[state=open]:border-border-strong"
                aria-label={label}
            >
                {value}
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-80 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto">
                <MenuSearch value={query} onChange={onQuery} placeholder={placeholder} />
                {children ? (
                    children
                ) : (
                    <p className="px-2 py-3 text-[0.75rem] text-muted-foreground">{empty}</p>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * The brand's own mark, where there is one to use.
 *
 * Only marks the vendor actually publishes appear here. A logo drawn to look
 * like somebody's is worse than no logo - it is unrecognisable and it is their
 * trademark either way - so every other brand gets the same neutral camera and
 * is told apart by its name, which is what the reader was reading anyway.
 */
export function BrandMark({ brand, className }: { brand: string; className?: string }) {
    if (brand === "Tapo" || brand === "VIGI") {
        return <TpLinkMark className={cn("size-4 text-foreground", className)} />;
    }
    return <Camera className={cn("size-4 text-muted-foreground", className)} />;
}

/** What one entry reads as: the brand, then the model. The brand repeats down
 *  the list on purpose - it is what somebody scanning for "Reolink" is looking
 *  for, and the model alone is a part number. */
function ModelLabel({ model }: { model: CameraModel }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <BrandMark brand={model.brand} />
            <span className="truncate">
                <span className="text-muted-foreground">{model.brand}</span> {model.name}
            </span>
        </span>
    );
}

/**
 * Which make it is.
 *
 * It was a plain select labelled "Make", which is a word half the people setting
 * up a camera do not use, with no mark to recognise a brand by and no way to
 * type. Typing matters more here than it looks: the list is short, but somebody
 * who knows they own a C410 and not what TP-Link calls its camera brand can type
 * the model and get the make that sells it.
 */
export function BrandPicker({
    value,
    onChange
}: {
    value: string;
    onChange: (brand: string) => void;
}) {
    const [query, setQuery] = useState("");
    const matches = useMemo(() => searchBrands(query), [query]);

    return (
        <PickerMenu
            query={query}
            onQuery={setQuery}
            label="Camera brand"
            placeholder="Tapo, TP-Link, Reolink"
            empty="No make by that name. Pick Other and Polaris asks the camera the rest."
            value={
                value ? (
                    <span className="flex min-w-0 items-center gap-2">
                        <BrandMark brand={value} />
                        <span className="truncate">{value}</span>
                    </span>
                ) : (
                    <span className="truncate text-foreground-subtle">Who makes it</span>
                )
            }
        >
            {matches.length === 0
                ? null
                : matches.map((entry) => (
                      <DropdownMenuItem key={entry.brand} onSelect={() => onChange(entry.brand)}>
                          <span className="flex min-w-0 items-center gap-2">
                              <BrandMark brand={entry.brand} />
                              <span className="truncate">{entry.brand}</span>
                              <span className="ml-auto shrink-0 text-[0.6875rem] text-foreground-subtle">
                                  {entry.count}
                              </span>
                          </span>
                      </DropdownMenuItem>
                  ))}
        </PickerMenu>
    );
}

export function ModelPicker({
    value,
    brand,
    onChange,
    /** What to show when nothing is picked - which is every camera added before
     *  this list existed, and they must not read as broken. */
    placeholder = "Choose the camera"
}: {
    value: string;
    /** The make already chosen, which is what this is listing. Empty lists every
     *  camera, which is what a search across makes needs. */
    brand: string;
    onChange: (modelId: string) => void;
    placeholder?: string;
}) {
    const [query, setQuery] = useState("");
    // Narrowed to the make first, because a list of every camera anybody makes
    // is a list nobody reads - and then searched inside it, because a make with
    // fifty models is still fifty. A search that finds nothing in this make
    // falls back to every make: somebody typing "c410" under Reolink has picked
    // the wrong make, and showing them nothing tells them nothing.
    const matches = useMemo(() => {
        const within = brand ? modelsOfBrand(brand) : CAMERA_MODELS;
        const found = searchModels(query).filter((model) =>
            within.some((entry) => entry.id === model.id)
        );
        return found.length > 0 || !query.trim() ? found : searchModels(query);
    }, [brand, query]);
    const chosen = cameraModel(value);

    return (
        <PickerMenu
            query={query}
            onQuery={setQuery}
            label="Camera model"
            placeholder="C410, tapo c200, tplink"
            empty={'No camera by that name. Pick the closest one, or "Something else".'}
            value={
                chosen ? (
                    <ModelLabel model={chosen} />
                ) : (
                    <span className="truncate text-foreground-subtle">{placeholder}</span>
                )
            }
        >
            {matches.length === 0
                ? null
                : matches.map((model) => (
                      <DropdownMenuItem key={model.id} onSelect={() => onChange(model.id)}>
                          <ModelLabel model={model} />
                      </DropdownMenuItem>
                  ))}
        </PickerMenu>
    );

}
