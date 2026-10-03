/**
 * What players read about their challenges, in the language the server chose.
 *
 * Written with `&` colour codes, which the announcement writer turns into the
 * game's own formatting. No braces anywhere: `{player}` and its kind are game
 * variables to that writer.
 */

import { formatDuration } from "../../figures";
import * as catalog from "./catalog";
import type { Language } from "./catalog";
import { PALETTE, mark } from "../events/messages";

const { bad: BAD, reason: REASON, good: GOOD, warn: WARN, info: INFO } = PALETTE;

type Text = catalog.Text;

const pick = (text: Text, language: Language) => text[language];
const t = (en: string, es: string): Text => ({ en, es });

export const TAG: Text = t(`${PALETTE.tag}[Challenges]&r `, `${PALETTE.tag}[Retos]&r `);
export const MENU_BUTTON: Text = t("[Challenges]", "[Retos]");

export function tag(language: Language): string {
    return pick(TAG, language);
}

/** How long, short (`figures.formatDuration`): `12 min`, `3.2 h`, `2.2 d`; never under a minute. */
export function duration(ms: number, language: Language): string {
    return formatDuration(Math.max(60_000, ms), language);
}

export const LABELS = {
    daily: t("Daily", "Diarios"),
    weekly: t("Weekly", "Semanales"),
    backlog: t("Left over", "Pendientes"),
    card: t("Bingo card", "Cartón de bingo"),
    community: t("Community goal", "Objetivo de la comunidad"),
    track: t("[Track]", "[Seguir]"),
    tracking: t("[Tracking]", "[Siguiendo]"),
    reroll: t("[Change]", "[Cambiar]"),
    season: t("[Season]", "[Temporada]"),
    bingo: t("[Bingo]", "[Bingo]"),
    goal: t("[Community]", "[Comunidad]"),
    list: t("[Challenges]", "[Retos]"),
    untrack: t("[Stop tracking]", "[Dejar de seguir]"),
    trackHover: t(
        "Show it on a bar at the top of your screen",
        "Mostrarlo en una barra arriba de tu pantalla"
    ),
    rerollHover: t(
        "Swap it for another of the same difficulty",
        "Cambiarlo por otro de la misma dificultad"
    ),
    listHover: t("Your challenges", "Tus retos"),
    seasonHover: t("Your season pass", "Tu pase de temporada"),
    bingoHover: t("This month's card", "El cartón de este mes"),
    goalHover: t("What the whole server is working on", "En qué trabaja todo el servidor"),
    done: t("done", "hecho"),
    voided: t("lost to Anti X-Ray", "perdido por el Anti X-Ray")
} as const;

export function header(
    layer: "daily" | "weekly" | "backlog",
    left: number | null,
    language: Language
): string {
    const name = pick(LABELS[layer], language);
    if (left === null) return `${tag(language)}&e${name}`;
    const when = duration(left, language);
    return `${tag(language)}&e${name} &7- ${language === "es" ? `cambian en ${when}` : `new ones in ${when}`}`;
}

/** A text progress bar: `[||||||....]` in green and grey. */
export function bar(progress: number, target: number, width = 10): string {
    const filled = target > 0 ? Math.min(width, Math.floor((progress / target) * width)) : 0;
    return `&8[&a${"|".repeat(filled)}&7${".".repeat(width - filled)}&8]`;
}

export function tierLabel(
    layer: "daily" | "weekly" | "card",
    tier: catalog.Difficulty,
    language: Language
): string {
    const labels = layer === "weekly" ? catalog.WEEKLY_LABELS : catalog.DIFFICULTY_LABELS;
    const colour = tier === "easy" ? "&a" : tier === "medium" ? "&e" : "&c";
    return `${colour}${pick(labels[tier], language)}`;
}

/** `12/32`, in the template's unit. */
export function figures(
    template: catalog.Template,
    progress: number,
    target: number,
    language: Language
): string {
    return `${catalog.formatNumber(catalog.inUnit(template, progress), language)}/${catalog.formatNumber(
        catalog.inUnit(template, target),
        language
    )}`;
}

export function footer(streak: number, tier: number, points: number, language: Language): string {
    return language === "es"
        ? `&7Racha: &f${streak} ${streak === 1 ? "día" : "días"} &8| &7Temporada: &fnivel ${tier} &7(${points} pts)`
        : `&7Streak: &f${streak} ${streak === 1 ? "day" : "days"} &8| &7Season: &ftier ${tier} &7(${points} pts)`;
}

export function locked(minutes: number, language: Language): string {
    return language === "es"
        ? `${tag(language)}${WARN}Tus retos se desbloquean tras ${mark(`${minutes} min`, WARN)} de juego en este servidor.`
        : `${tag(language)}${WARN}Your challenges unlock after ${mark(`${minutes} min`, WARN)} of play on this server.`;
}

export function notLinked(language: Language): string {
    return language === "es"
        ? `${tag(language)}${WARN}Los retos son para jugadores con una cuenta de Polaris vinculada.`
        : `${tag(language)}${WARN}Challenges are for players linked to a Polaris account.`;
}

export function nothingYet(language: Language): string {
    return language === "es"
        ? `${tag(language)}${INFO}Los retos de hoy aún se están preparando. Prueba en un minuto.`
        : `${tag(language)}${INFO}Today's challenges are still being set up. Try again in a minute.`;
}

export function joinLine(left: number, language: Language): string {
    if (left === 0)
        return language === "es"
            ? `${tag(language)}${GOOD}Has completado los retos de hoy.`
            : `${tag(language)}${GOOD}You have done today's challenges.`;
    return language === "es"
        ? `${tag(language)}${INFO}Te ${left === 1 ? `queda ${mark("1 reto", INFO)}` : `quedan ${mark(`${left} retos`, INFO)}`} hoy.`
        : `${tag(language)}${INFO}You have ${mark(`${left} ${left === 1 ? "challenge" : "challenges"}`, INFO)} left today.`;
}

export function completedTitle(language: Language): string {
    return language === "es" ? "&6¡Reto completado!" : "&6Challenge complete!";
}

export function completedLine(title: string, reward: string, language: Language): string {
    return language === "es"
        ? `${tag(language)}${GOOD}¡Completado! ${mark(title, GOOD)}${reward ? ` - ${mark(reward, GOOD)}` : ""}`
        : `${tag(language)}${GOOD}Done! ${mark(title, GOOD)}${reward ? ` - ${mark(reward, GOOD)}` : ""}`;
}

/** `+20 pts, 2 levels, 3 diamond`. */
export function rewardText(
    payout: { points?: number; levels: number; items: readonly { id: string; count: number }[] },
    language: Language
): string {
    const parts: string[] = [];
    if (payout.points && payout.points > 0) parts.push(`+${payout.points} pts`);
    if (payout.levels > 0)
        parts.push(
            language === "es"
                ? `${payout.levels} ${payout.levels === 1 ? "nivel" : "niveles"}`
                : `${payout.levels} ${payout.levels === 1 ? "level" : "levels"}`
        );
    for (const item of payout.items)
        parts.push(`${item.count} ${item.id.replace(/^[a-z0-9_.-]+:/, "").replace(/_/g, " ")}`);
    return parts.join(", ");
}

export function rerolled(title: string, language: Language): string {
    return language === "es"
        ? `${tag(language)}${INFO}Cambiado por: ${mark(title, INFO)}`
        : `${tag(language)}${INFO}Swapped for: ${mark(title, INFO)}`;
}

export function noReroll(language: Language): string {
    return language === "es"
        ? `${tag(language)}${BAD}No se puede cambiar: ${REASON}no te quedan cambios en este periodo, o no hay otro reto de esa dificultad.`
        : `${tag(language)}${BAD}Cannot swap: ${REASON}no swaps left this period, or no other challenge of that difficulty.`;
}

export function tracking(title: string, language: Language): string {
    return language === "es"
        ? `${tag(language)}${INFO}Siguiendo: ${mark(title, INFO)}`
        : `${tag(language)}${INFO}Tracking: ${mark(title, INFO)}`;
}

export function untracked(language: Language): string {
    return language === "es"
        ? `${tag(language)}${INFO}Ya no sigues ningún reto.`
        : `${tag(language)}${INFO}Not tracking a challenge any more.`;
}

export function sweepLine(layer: "daily" | "weekly", reward: string, language: Language): string {
    if (layer === "daily")
        return language === "es"
            ? `${tag(language)}${GOOD}¡Pleno diario! Los tres retos de hoy${reward ? ` - ${mark(reward, GOOD)}` : ""}`
            : `${tag(language)}${GOOD}Clean sweep! All three of today's${reward ? ` - ${mark(reward, GOOD)}` : ""}`;
    return language === "es"
        ? `${tag(language)}${GOOD}¡Pleno semanal! Los tres retos de la semana${reward ? ` - ${mark(reward, GOOD)}` : ""}`
        : `${tag(language)}${GOOD}Weekly sweep! All three of this week's${reward ? ` - ${mark(reward, GOOD)}` : ""}`;
}

export function streakLine(days: number, bonus: number, language: Language): string {
    return language === "es"
        ? `${tag(language)}${GOOD}¡Racha de ${mark(`${days} días`, GOOD)}!${bonus > 0 ? ` ${mark(`+${bonus} pts`, GOOD)}` : ""}`
        : `${tag(language)}${GOOD}${mark(`${days}-day`, GOOD)} streak!${bonus > 0 ? ` ${mark(`+${bonus} pts`, GOOD)}` : ""}`;
}

export function comebackLine(bonus: number, language: Language): string {
    return language === "es"
        ? `${tag(language)}${GOOD}¡Bienvenido de vuelta! ${mark(`+${bonus} pts`, GOOD)}`
        : `${tag(language)}${GOOD}Welcome back! ${mark(`+${bonus} pts`, GOOD)}`;
}

export function tierLine(tier: number, reward: string, language: Language): string {
    return language === "es"
        ? `${tag(language)}${GOOD}Nivel de temporada ${mark(tier, GOOD)}${reward ? ` - ${mark(reward, GOOD)}` : ""}`
        : `${tag(language)}${GOOD}Season tier ${mark(tier, GOOD)}${reward ? ` - ${mark(reward, GOOD)}` : ""}`;
}

export function lineLine(lines: number, reward: string, language: Language): string {
    return language === "es"
        ? `${tag(language)}${GOOD}¡Línea de bingo!${lines > 1 ? ` (${lines})` : ""}${reward ? ` - ${mark(reward, GOOD)}` : ""}`
        : `${tag(language)}${GOOD}Bingo line!${lines > 1 ? ` (${lines})` : ""}${reward ? ` - ${mark(reward, GOOD)}` : ""}`;
}

export function fullCardLine(reward: string, language: Language): string {
    return language === "es"
        ? `${tag(language)}${GOOD}&l¡Cartón completo!${GOOD}${reward ? ` - ${mark(reward, GOOD)}` : ""}`
        : `${tag(language)}${GOOD}&lFull card!${GOOD}${reward ? ` - ${mark(reward, GOOD)}` : ""}`;
}

export function capLine(language: Language): string {
    return language === "es"
        ? `${tag(language)}${WARN}Has llegado al máximo de puntos de temporada de hoy. ${INFO}Los retos siguen dando niveles.`
        : `${tag(language)}${WARN}You have reached today's most season points. ${INFO}Challenges still give levels.`;
}

export function seasonLines(
    input: {
        number: number;
        tier: number;
        tiers: number;
        points: number;
        perTier: number;
        daysLeft: number;
        next: string;
    },
    language: Language
): string[] {
    const toNext = input.perTier - (input.points % input.perTier);
    return language === "es"
        ? [
              `${tag(language)}&bTemporada ${input.number} &7- quedan ${input.daysLeft} días`,
              `&7Nivel &f${input.tier}&7/${input.tiers} &7- &f${input.points} pts &7- ${input.tier >= input.tiers ? "pase completo" : `${toNext} pts para el siguiente`}`,
              ...(input.next ? [`&7Próxima recompensa: &f${input.next}`] : [])
          ]
        : [
              `${tag(language)}&bSeason ${input.number} &7- ${input.daysLeft} days left`,
              `&7Tier &f${input.tier}&7/${input.tiers} &7- &f${input.points} pts &7- ${input.tier >= input.tiers ? "pass complete" : `${toNext} pts to the next`}`,
              ...(input.next ? [`&7Next reward: &f${input.next}`] : [])
          ];
}

export function goalLine(
    title: string,
    total: number,
    target: number,
    share: number,
    left: number,
    language: Language
): string {
    return language === "es"
        ? `${tag(language)}&d${title} &7- ${Math.floor((total / Math.max(1, target)) * 100)}% &7- tu parte ${share.toFixed(1)}% &7- quedan ${duration(left, language)}`
        : `${tag(language)}&d${title} &7- ${Math.floor((total / Math.max(1, target)) * 100)}% &7- your share ${share.toFixed(1)}% &7- ${duration(left, language)} left`;
}

export function noGoal(language: Language): string {
    return language === "es"
        ? `${tag(language)}&7No hay ningún objetivo de la comunidad ahora mismo.`
        : `${tag(language)}&7There is no community goal right now.`;
}

export function goalBar(title: string, tier: number, language: Language): string {
    const roman = ["", " I", " II", " III", " IV", " V"][tier] ?? "";
    return language === "es"
        ? `&dComunidad:&f ${title}${roman ? ` &7- nivel${roman}` : ""}`
        : `&dCommunity:&f ${title}${roman ? ` &7- tier${roman}` : ""}`;
}

export function goalTierLine(title: string, tier: number, language: Language): string {
    const roman = ["", "I", "II", "III", "IV", "V"][tier] ?? String(tier);
    return language === "es"
        ? `${tag(language)}&d¡El servidor ha alcanzado el nivel ${roman} de ${title}!`
        : `${tag(language)}&dThe server reached tier ${roman} of ${title}!`;
}

export function goalRewardLine(reward: string, language: Language): string {
    return language === "es"
        ? `${tag(language)}${GOOD}Por tu aportación: ${mark(reward, GOOD)}`
        : `${tag(language)}${GOOD}For your part in it: ${mark(reward, GOOD)}`;
}

export function rewardWaiting(language: Language): string {
    return language === "es"
        ? `${tag(language)}${INFO}Lo que no ha cabido te llegará la próxima vez que entres.`
        : `${tag(language)}${INFO}Whatever did not arrive comes the next time you join.`;
}

export function seasonEnded(
    number: number,
    champions: readonly string[],
    language: Language
): string {
    const names = champions.join(", ");
    return language === "es"
        ? `${tag(language)}${WARN}Termina la temporada ${mark(number, WARN)}.${names ? ` Campeones: ${mark(names, WARN)}` : ""}`
        : `${tag(language)}${WARN}Season ${mark(number, WARN)} is over.${names ? ` Champions: ${mark(names, WARN)}` : ""}`;
}

export function championTitle(number: number, language: Language): string {
    return language === "es" ? `Campeón de la temporada ${number}` : `Season ${number} champion`;
}

/** A title a player holds, in the reader's language whichever one it was won in. */
export function titleIn(title: string, language: Language): string {
    const season = catalog.championSeason(title);
    return season === null ? title : championTitle(season, language);
}

export function trackedName(title: string, progress: string): string {
    return `&e${title} &7${progress}`;
}

export function actionBar(title: string, progress: string): string {
    return `&e${title} &8| &a${progress}`;
}
