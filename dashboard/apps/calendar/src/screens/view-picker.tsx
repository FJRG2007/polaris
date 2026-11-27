"use client";

/**
 * The view picker, Google's: one button naming the view, and a menu with every
 * view on its key and the switches for what the grid shows. It replaced a row
 * of tabs that hid the keys and could not hold the switches.
 */

import { useCalendarT } from "./i18n";
import { viewKey } from "./shortcuts";
import {
    Calendar,
    CalendarDays,
    CalendarRange,
    Check,
    ChevronDown,
    Columns3,
    LayoutList,
    RectangleVertical,
    type LucideIcon
} from "lucide-react";
import { VIEWS, type CalendarPreferences, type CalendarViewName } from "../lib/preferences";
import {
    Button,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuShortcut,
    useShortcutBindings
} from "@polaris/ui";

/** The switches the menu carries, each a setting of its own. */
export const VIEW_SWITCHES = ["showWeekends", "showDeclined", "showDoneTasks"] as const;
export type ViewSwitch = (typeof VIEW_SWITCHES)[number];

/** What the compact (phone) button draws for each view. */
const VIEW_ICONS: Record<CalendarViewName, LucideIcon> = {
    list: LayoutList,
    day: RectangleVertical,
    days: Columns3,
    week: CalendarRange,
    month: CalendarDays,
    year: Calendar
};

function ViewIcon({ view, className }: { view: CalendarViewName; className?: string }) {
    const Icon = VIEW_ICONS[view];
    return <Icon aria-hidden className={className} />;
}

export function ViewPicker({
    view,
    customDays,
    preferences,
    views = VIEWS,
    compact = false,
    onView,
    onToggle
}: {
    view: CalendarViewName;
    /** The views offered; a phone offers fewer (phone-view.ts). */
    views?: readonly CalendarViewName[];
    /** An icon in place of the name, on a phone's narrow header. */
    compact?: boolean;
    customDays: number;
    preferences: Pick<CalendarPreferences, ViewSwitch | "keyboardShortcuts" | "showTasks">;
    onView: (view: CalendarViewName) => void;
    onToggle: (name: ViewSwitch) => void;
}) {
    const t = useCalendarT();
    const bindings = useShortcutBindings();
    // A phone's list is its schedule, named the way Google's phone app names it.
    const nameOf = (entry: CalendarViewName) =>
        compact && entry === "list"
            ? t("views.schedule")
            : t(`views.${entry}`, { count: customDays });
    // Done tasks are only a choice while tasks are drawn at all.
    const switches = VIEW_SWITCHES.filter(
        (name) => name !== "showDoneTasks" || preferences.showTasks
    );
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                {compact ? (
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-11"
                        aria-label={`${t("header.view")}: ${nameOf(view)}`}
                        title={nameOf(view)}
                    >
                        <ViewIcon view={view} className="size-5" />
                    </Button>
                ) : (
                    <Button size="sm" variant="outline" aria-label={t("header.view")}>
                        <span className="min-w-0 truncate">{nameOf(view)}</span>
                        <ChevronDown className="size-3.5" />
                    </Button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                {views.map((entry) => {
                    const key = preferences.keyboardShortcuts ? viewKey(bindings, entry) : null;
                    return (
                        <DropdownMenuItem
                            key={entry}
                            role="menuitemradio"
                            aria-checked={entry === view}
                            onSelect={() => onView(entry)}
                            className={cn(entry === view && "font-medium text-primary")}
                        >
                            {compact ? <ViewIcon view={entry} /> : null}
                            {nameOf(entry)}
                            {key && !compact ? <MenuShortcut keys={key} /> : null}
                        </DropdownMenuItem>
                    );
                })}
                <DropdownMenuSeparator />
                {switches.map((name) => (
                    <DropdownMenuItem
                        key={name}
                        role="menuitemcheckbox"
                        aria-checked={preferences[name]}
                        // A switch keeps the menu open, so turning off two is two
                        // presses rather than two trips through the button.
                        onSelect={(event) => {
                            event.preventDefault();
                            onToggle(name);
                        }}
                    >
                        <Check className={cn("text-primary", !preferences[name] && "invisible")} />
                        {t(`settingsPage.${name}`)}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
