/**
 * One name per verb, for every game's players screen.
 *
 * The two screens do the same handful of things to a person - let them in, take
 * them off the list, throw them out, ban them, lift it, time them out - and each
 * had invented its own words for them. Minecraft kicked and ARK "threw off";
 * Minecraft filtered on "Online" and ARK on "Playing now"; one edited a player and
 * the other edited a name. Nothing enforced any of it, so the two drifted apart
 * every time either was touched, and an operator who runs both learned the screen
 * twice.
 *
 * So the words live here and the screens spend them. A game that says something
 * the others do not - a Steam profile, a whitelist - still writes its own label;
 * what is shared is only what is genuinely the same act.
 *
 * Pure and client-safe: both players tables are browser components. The words
 * themselves are in the `games` catalog under `vocab`, so `playerWords` takes
 * the reader's translator.
 */

import type { Translator } from "@polaris/core";
import type { GameKey } from "../../messages";

/** The cuts an operator reaches for. Anything finer is what the search box is
 *  for, and a filter nobody uses is a list nobody reads to the end of. */
export interface PlayerFilterOption {
    readonly value: string;
    readonly label: string;
}

/** Every shared word, in the language of the translator given. */
export function playerWords(t: Translator<GameKey<"games">>) {
    return {
        /**
         * The filters a game offers, in one order.
         *
         * `operators` only where the game has them. Minecraft ops by name; ARK has
         * no operator command at all, but it does read a file of the Steam ids
         * allowed to run admin commands without the password - which is the same
         * idea and is what the filter cuts on there.
         */
        playerFilters(has: { operators?: boolean } = {}): PlayerFilterOption[] {
            return [
                { value: "all", label: t("vocab.filters.all") },
                { value: "online", label: t("vocab.filters.online") },
                { value: "allowed", label: t("vocab.filters.allowed") },
                ...(has.operators
                    ? [{ value: "operators", label: t("vocab.filters.operators") }]
                    : []),
                { value: "banned", label: t("vocab.filters.banned") }
            ];
        },
        /** What each verb is called, wherever it is offered. The name is in the
         *  label because these are icon buttons and menu items: the label is the
         *  only thing a screen reader reads out, and "Ban" alone does not say who. */
        playerAction: {
            add: t("vocab.action.add"),
            edit: (name: string) => t("vocab.action.edit", { name }),
            allow: (name: string) => t("vocab.action.allow", { name }),
            remove: (name: string) => t("vocab.action.remove", { name }),
            kick: (name: string) => t("vocab.action.kick", { name }),
            ban: (name: string) => t("vocab.action.ban", { name }),
            pardon: (name: string) => t("vocab.action.pardon", { name }),
            timeout: (name: string) => t("vocab.action.timeout", { name }),
            message: (name: string) => t("vocab.action.message", { name }),
            more: (name: string) => t("vocab.action.more", { name })
        },
        /** The same verbs as they read inside the row's menu, where the name is
         *  already the heading above them and repeating it in every item is noise. */
        playerMenuItem: {
            edit: t("vocab.menu.edit"),
            timeout: t("vocab.menu.timeout"),
            pardon: t("vocab.menu.pardon"),
            message: t("vocab.menu.message"),
            history: t("vocab.menu.history")
        },
        /** What a badge on a row says. Shared because the states themselves are
         *  shared, whatever each game's list is called underneath. */
        playerStanding: {
            allowed: t("vocab.standing.allowed"),
            notAllowed: t("vocab.standing.notAllowed"),
            /** On Polaris' list, and the server has not been told yet - it was
             *  down, or still installing. */
            waiting: t("vocab.standing.waiting"),
            banned: t("vocab.standing.banned"),
            operator: t("vocab.standing.operator")
        },
        /** What a presence badge says. "Never joined" is not "offline": one is
         *  somebody who has been added and has not turned up, the other is
         *  somebody who has. */
        playerPresence: {
            playing: t("vocab.presence.playing"),
            afk: t("vocab.presence.afk"),
            connecting: t("vocab.presence.connecting"),
            offline: t("vocab.presence.offline"),
            never: t("vocab.presence.never")
        },
        /** What a destructive verb asks before it happens. One wording, so the
         *  same question is not answered differently depending on which game
         *  asked it. */
        playerConfirm: {
            kick: (name: string) => ({
                title: t("vocab.confirm.kickTitle", { name }),
                description: t("vocab.confirm.kickBody")
            }),
            ban: (name: string) => ({
                title: t("vocab.confirm.banTitle", { name }),
                description: t("vocab.confirm.banBody")
            }),
            remove: (name: string) => ({
                title: t("vocab.confirm.removeTitle", { name }),
                description: t("vocab.confirm.removeBody")
            })
        }
    };
}

/** The shared words in one language. */
export type PlayerWords = ReturnType<typeof playerWords>;
