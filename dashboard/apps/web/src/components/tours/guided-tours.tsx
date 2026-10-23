"use client";

/**
 * The guided tours: the list a reader picks one from (opened from the account
 * menu), the `?tour=` address search uses to start one on its screen, and the
 * one-time offer of the overview to a new account.
 *
 * Mounted once in the frame. It draws nothing until asked: the highlighting
 * library is fetched the first time a tour starts, never with the page.
 */

import { Compass } from "lucide-react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { navigationEntries } from "@/lib/search/entries";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { RunningTour, TourWords } from "@/lib/tours/runtime";
import { OPEN_TOURS_EVENT, usableTarget } from "@/lib/tours/target";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { markOverviewAction } from "@/app/(app)/tour-actions";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    useToast
} from "@polaris/ui";
import {
    TOUR_PARAM,
    availableTours,
    isTourId,
    onTourScreen,
    presentSteps,
    tourHref,
    type Tour,
    type TourId,
    type TourStep
} from "@/lib/tours/registry";
import * as polls from "../shared-polls";

/** How long a freshly opened screen gets to draw what a tour points at. */
const TARGET_WAIT_MS = 4000;
const TARGET_POLL_MS = 150;
/** The offer waits for the page to settle rather than landing on the first paint. */
const OFFER_DELAY_MS = 2500;

function offeredKey(userId: string): string {
    return `polaris.tour.overview.${userId}`;
}

function readOffered(userId: string): boolean {
    try {
        return window.localStorage.getItem(offeredKey(userId)) !== null;
    } catch {
        return false;
    }
}

function writeOffered(userId: string): void {
    try {
        window.localStorage.setItem(offeredKey(userId), "1");
    } catch {
        // Private windows and blocked storage: the account's own mark still holds.
    }
}

/** Waits for the screen to draw at least one of the tour's targets, then answers
 *  the steps that are usable right now with their elements. */
async function collectSteps(tour: Tour): Promise<Array<{ step: TourStep; element: HTMLElement }>> {
    const deadline = Date.now() + TARGET_WAIT_MS;
    for (;;) {
        const found = presentSteps(tour.steps, (target) => usableTarget(target) !== null);
        if (found.length > 0 || Date.now() >= deadline) {
            return found.map((step) => ({ step, element: usableTarget(step.target)! }));
        }
        await new Promise((resolve) => setTimeout(resolve, TARGET_POLL_MS));
    }
}

/** Where tours can be launched from, in search: one entry per tour this reader can take. */
export function useTourEntries(
    reachable: ReadonlySet<string>
): Array<{ tour: Tour; label: string; href: string }> {
    const t = useTranslations("tours");
    const pathname = usePathname();
    return useMemo(
        () =>
            availableTours(reachable).map((tour) => ({
                tour,
                label: t("search.take", { name: t(`${tour.id}.name` as NamespaceKey<"tours">) }),
                href: tourHref(tour, pathname)
            })),
        [reachable, t, pathname]
    );
}

export function GuidedTours({
    userId,
    isAdmin,
    appIds,
    held,
    installed,
    canOffer
}: {
    userId: string;
    isAdmin: boolean;
    appIds: string[];
    held: string[];
    installed: string[];
    /** False while viewing as somebody: the offer belongs to them, not the viewer. */
    canOffer: boolean;
}) {
    const t = useTranslations("tours");
    const toast = useToast();
    const router = useRouter();
    const pathname = usePathname();
    const [listOpen, setListOpen] = useState(false);
    const running = useRef<RunningTour | null>(null);
    const generation = useRef(0);

    const appKey = appIds.join(",");
    const heldKey = held.join(",");
    const installedKey = installed.join(",");
    const tours = useMemo(() => {
        const split = (key: string) => (key ? key.split(",") : []);
        const reachable = new Set(
            navigationEntries(isAdmin, split(appKey), {
                held: split(heldKey),
                installed: split(installedKey)
            }).map((entry) => entry.href)
        );
        return availableTours(reachable);
    }, [isAdmin, appKey, heldKey, installedKey]);

    const words = useMemo<TourWords>(
        () => ({
            next: t("controls.next"),
            previous: t("controls.previous"),
            done: t("controls.done"),
            skip: t("controls.skip"),
            progress: t("controls.progress", { current: "{{current}}", total: "{{total}}" }),
            // Filled per tour in `run`, which knows whose words they are.
            step: () => ({ title: "", body: "" })
        }),
        [t]
    );

    /** Runs a tour on the current screen. */
    const run = useCallback(
        async (tour: Tour) => {
            running.current?.stop();
            // Only the latest request draws: one started while another was still
            // waiting for its screen replaces it.
            const mine = ++generation.current;
            const steps = await collectSteps(tour);
            if (mine !== generation.current) return;
            if (steps.length === 0) {
                toast.show({ key: "tour", title: t("empty.title"), body: t("empty.body") });
                return;
            }
            const runtime = await import("@/lib/tours/runtime");
            if (mine !== generation.current) return;
            const text = (key: string) => t(key as NamespaceKey<"tours">);
            running.current = runtime.runTour(
                steps,
                {
                    ...words,
                    step: (step) => ({
                        title: text(`${tour.id}.steps.${step.key}.title`),
                        body: text(`${tour.id}.steps.${step.key}.body`)
                    })
                },
                (finished) => {
                    running.current = null;
                    if (tour.id === "overview") {
                        void markOverviewAction(finished ? "done" : "skipped");
                    }
                }
            );
        },
        [t, toast, words]
    );

    /** Starts a tour, going to its screen first when the reader is elsewhere. */
    const start = useCallback(
        (id: TourId) => {
            const tour = tours.find((one) => one.id === id);
            if (!tour) return;
            setListOpen(false);
            if (onTourScreen(tour, pathname)) void run(tour);
            else router.push(tourHref(tour, pathname));
        },
        [tours, pathname, run, router]
    );

    useEffect(() => {
        const open = () => setListOpen(true);
        window.addEventListener(OPEN_TOURS_EVENT, open);
        return () => window.removeEventListener(OPEN_TOURS_EVENT, open);
    }, []);

    // A tour left running when the reader navigates away would point at a screen
    // that is gone.
    useEffect(() => {
        running.current?.stop();
    }, [pathname]);
    useEffect(() => () => running.current?.stop(), []);

    // The first-run offer: once per account, asked of the server only while this
    // browser has not already seen it made.
    useEffect(() => {
        if (!canOffer || readOffered(userId)) return;
        let cancelled = false;
        const timer = window.setTimeout(async () => {
            const offer = await polls.shouldOfferOverview().catch(() => false);
            writeOffered(userId);
            if (!offer || cancelled) return;
            void markOverviewAction("offered");
            toast.show({
                key: "tour-offer",
                title: t("offer.title"),
                body: t("offer.body"),
                icon: <Compass className="size-4 text-primary" />,
                life: 0,
                actions: [
                    {
                        label: t("offer.start"),
                        run: async () => {
                            start("overview");
                            return null;
                        }
                    }
                ]
            });
        }, OFFER_DELAY_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
        // Once per mount of the frame.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canOffer, userId]);

    return (
        <>
            <Suspense fallback={null}>
                <TourParam tours={tours} onStart={run} />
            </Suspense>
            <Dialog open={listOpen} onOpenChange={setListOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>{t("list.title")}</DialogTitle>
                        <DialogDescription>{t("list.description")}</DialogDescription>
                    </DialogHeader>
                    <ul className="flex flex-col gap-1">
                        {tours.map((tour) => (
                            <li key={tour.id}>
                                <button
                                    type="button"
                                    onClick={() => start(tour.id)}
                                    className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <span className="text-sm font-medium">
                                        {t(`${tour.id}.name` as NamespaceKey<"tours">)}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {t(`${tour.id}.summary` as NamespaceKey<"tours">)}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** Starts the tour an address asks for (`?tour=chat`) and takes the request out
 *  of the address, so a reload or a shared link does not start it again. */
function TourParam({ tours, onStart }: { tours: Tour[]; onStart: (tour: Tour) => void }) {
    const params = useSearchParams();
    const pathname = usePathname();
    const router = useRouter();
    const requested = params.get(TOUR_PARAM);
    // One start per request: the effect can run again before the cleaned address lands.
    const handled = useRef<string | null>(null);

    useEffect(() => {
        if (!requested) {
            handled.current = null;
            return;
        }
        if (handled.current === `${pathname}:${requested}`) return;
        handled.current = `${pathname}:${requested}`;
        const rest = new URLSearchParams(params.toString());
        rest.delete(TOUR_PARAM);
        const query = rest.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        if (!isTourId(requested)) return;
        const tour = tours.find((one) => one.id === requested);
        // A tour this reader cannot take is quietly not started: the address may
        // have come from somebody with more access.
        if (!tour) return;
        if (onTourScreen(tour, pathname)) onStart(tour);
        else router.push(tourHref(tour, pathname));
    }, [requested, params, pathname, router, tours, onStart]);

    return null;
}
