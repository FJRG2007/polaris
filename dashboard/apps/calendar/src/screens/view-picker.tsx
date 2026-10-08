"use client";

/**
 * The view picker, Google's: one button naming the view, and a menu with every
 * view on its key and the switches for what the grid shows. It replaced a row
 * of tabs that hid the keys and could not hold the switches.
 */

import { useCalendarT } from "./i18n";
import { VIEW_KEYS } from "./shortcuts";
import { Check, ChevronDown } from "lucide-react";
import { VIEWS, type CalendarPreferences, type CalendarViewName } from "../lib/preferences";
import {
    Button,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuShortcut
} from "@polaris/ui";

/** The switches the menu carries, each a setting of its own. */
export const VIEW_SWITCHES = ["showWeekends", "showDeclined", "showDoneTasks"] as const;
export type ViewSwitch = (typeof VIEW_SWITCHES)[number];

export function ViewPicker({
    view,
    customDays,
    preferences,
    onView,
    onToggle
}: {
    view: CalendarViewName;
    customDays: number;
    preferences: Pick<CalendarPreferences, ViewSwitch | "keyboardShortcuts" | "showTasks">;
    onView: (view: CalendarViewName) => void;
    onToggle: (name: ViewSwitch) => void;
}) {
    const t = useCalendarT();
    const nameOf = (entry: CalendarViewName) => t(`views.${entry}`, { count: customDays });
    // Done tasks are only a choice while tasks are drawn at all.
    const switches = VIEW_SWITCHES.filter(
        (name) => name !== "showDoneTasks" || preferences.showTasks
    );
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" aria-label={t("header.view")}>
                    <span className="min-w-0 truncate">{nameOf(view)}</span>
                    <ChevronDown className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                {VIEWS.map((entry) => (
                    <DropdownMenuItem
                        key={entry}
                        role="menuitemradio"
                        aria-checked={entry === view}
                        onSelect={() => onView(entry)}
                        className={cn(entry === view && "font-medium text-primary")}
                    >
                        {nameOf(entry)}
                        {preferences.keyboardShortcuts ? (
                            <MenuShortcut>{VIEW_KEYS[entry].toUpperCase()}</MenuShortcut>
                        ) : null}
                    </DropdownMenuItem>
                ))}
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
