/**
 * What finishing challenges comes to, and what the in-game menu shows.
 *
 * `settle` walks a player's challenges for the ones finished since the last
 * look and works out everything they are owed - points, levels, items, the
 * sweep bonus, bingo lines, the streak, season tiers - as a list of effects the
 * service carries out. Each finished challenge is marked paid in the same step,
 * so a crash between the two never pays twice: at worst a reward goes to the
 * pending queue instead of the player.
 *
 * Pure.
 */

import * as draw from "./draw";
import * as season from "./season";
import * as catalog from "./catalog";
import * as messages from "./messages";
import * as commands from "./commands";
import type * as period from "./period";
import type { ChallengeSettings, Payout } from "./settings";
import type { GoalState, Instance, Ledger, PlayerLayer, PlayerRecord } from "./state";

export interface Context {
    readonly settings: ChallengeSettings;
    readonly language: catalog.Language;
    readonly now: number;
    readonly clock: period.Clock;
    readonly day: string;
    readonly season: period.Season;
    /** The middle tier on the server this season, for catch-up. */
    readonly medianTier: number;
    readonly spelling: commands.Spelling;
}

export type Effect =
    | { readonly kind: "tell"; readonly line: string }
    | { readonly kind: "title"; readonly title: string; readonly subtitle: string }
    | { readonly kind: "pay"; readonly payout: Pick<Payout, "levels" | "items">; readonly label: string };

export const LAYER_KEYS = ["daily", "weekly", "card"] as const;
export type LayerName = (typeof LAYER_KEYS)[number];

/** What one finished challenge pays. */
export function payoutFor(settings: ChallengeSettings, layer: LayerName, tier: catalog.Difficulty): Payout {
    if (layer === "card") return settings.rewards.square;
    return settings.rewards[layer][tier];
}

const merge = (left: Pick<Payout, "levels" | "items">, right: Pick<Payout, "levels" | "items">) => ({
    levels: left.levels + right.levels,
    items: [...left.items, ...right.items]
});

/** The title a challenge reads as, target and variant written in. */
export function titleOf(instance: Pick<Instance, "template" | "variant" | "target">, language: catalog.Language): string {
    const template = catalog.templateOf(instance.template);
    return template ? catalog.titleOf(template, instance.variant, instance.target, language) : instance.template;
}

/**
 * Everything a player is owed for what they finished since the last look.
 */
export function settle(
    record: PlayerRecord,
    ledger: Ledger,
    context: Context,
    keys: Readonly<Record<LayerName, string | null>>
): { record: PlayerRecord; ledger: Ledger; effects: Effect[] } {
    const { settings, language, now } = context;
    const effects: Effect[] = [];
    let next = record;
    let book = ledger;
    let capTold = false;
    const catchUp = season.catchUpApplies(
        settings,
        context.season,
        season.tierOf(ledger.points, settings),
        context.medianTier
    );

    const earn = (points: number): number => {
        if (!settings.layers.season || points <= 0) return 0;
        const earned = season.addPoints(book, points, context.day, settings, catchUp);
        book = earned.ledger;
        if (earned.granted < points && !capTold) {
            capTold = true;
            effects.push({ kind: "tell", line: messages.capLine(language) });
        }
        for (const tier of earned.tiers) {
            const reward = season.tierReward(tier, settings);
            effects.push({ kind: "tell", line: messages.tierLine(tier, messages.rewardText(reward, language), language) });
            if (reward.levels > 0 || reward.items.length > 0)
                effects.push({ kind: "pay", payout: reward, label: `${messages.tag(language).trim()} ${tier}` });
        }
        return earned.granted;
    };

    const finish = (instance: Instance, layer: LayerName | "backlog", label: string): Instance => {
        const payout = payoutFor(settings, layer === "backlog" ? "daily" : layer, instance.tier);
        const doneKey = `${layer === "backlog" ? `daily:${instance.day}` : `${layer}:${keys[layer]}`}:${instance.template}`;
        if (book.done.includes(doneKey)) {
            // Already done today on another server of a shared season.
            effects.push({ kind: "tell", line: messages.completedLine(label, "", language) });
            return { ...instance, paid: true };
        }
        book = { ...book, done: [...book.done, doneKey].slice(-60) };
        let bonus = 0;
        if (season.isComeback(book, now) && settings.rewards.comeback > 0) {
            bonus += settings.rewards.comeback;
            effects.push({ kind: "tell", line: messages.comebackLine(settings.rewards.comeback, language) });
        }
        book = { ...book, lastDoneAt: now };
        const granted = earn(payout.points + bonus) - bonus;
        const shown = { ...payout, points: Math.max(0, granted) };
        effects.push({ kind: "title", title: messages.completedTitle(language), subtitle: `&f${label}` });
        effects.push({
            kind: "tell",
            line: messages.completedLine(label, messages.rewardText(shown, language), language)
        });
        if (payout.levels > 0 || payout.items.length > 0) effects.push({ kind: "pay", payout, label });
        if (layer === "daily" || layer === "backlog") {
            const { streak, milestone } = season.streakAfter(book.streak, context.day, context.clock);
            book = { ...book, streak };
            if (milestone !== null) {
                const extra = season.milestoneBonus(milestone, settings);
                earn(extra);
                effects.push({ kind: "tell", line: messages.streakLine(milestone, extra, language) });
            }
        }
        return { ...instance, paid: true };
    };

    for (const layer of LAYER_KEYS) {
        const held = next[layer];
        if (!held || held.key !== keys[layer]) continue;
        let changed = false;
        const instances = held.instances.map((instance) => {
            if (instance.doneAt === null || instance.paid) return instance;
            changed = true;
            return finish(instance, layer, titleOf(instance, language));
        });
        if (!changed) continue;
        let updated: PlayerLayer = { ...held, instances };
        if (layer !== "card" && !held.swept && instances.length >= 3 && instances.every((one) => one.doneAt !== null)) {
            const sweep = layer === "daily" ? settings.rewards.dailySweep : settings.rewards.weeklySweep;
            const granted = earn(sweep.points);
            effects.push({
                kind: "tell",
                line: messages.sweepLine(layer, messages.rewardText({ ...sweep, points: granted }, language), language)
            });
            if (sweep.levels > 0 || sweep.items.length > 0) effects.push({ kind: "pay", payout: sweep, label: layer });
            updated = { ...updated, swept: true };
        }
        if (layer === "card") {
            const done = instances.map((one) => one.doneAt !== null);
            const lines = draw.completeLines(done).filter((line) => !held.lines.includes(line));
            if (lines.length > 0) {
                const reward = settings.rewards.line;
                let granted = 0;
                let pay = { levels: 0, items: [] as Payout["items"] };
                for (let index = 0; index < lines.length; index += 1) {
                    granted += earn(reward.points);
                    pay = merge(pay, reward);
                }
                effects.push({
                    kind: "tell",
                    line: messages.lineLine(lines.length, messages.rewardText({ ...pay, points: granted }, language), language)
                });
                if (pay.levels > 0 || pay.items.length > 0) effects.push({ kind: "pay", payout: pay, label: "bingo" });
                updated = { ...updated, lines: [...held.lines, ...lines] };
            }
            if (!held.full && done.length === 9 && done.every(Boolean)) {
                const reward = settings.rewards.card;
                const granted = earn(reward.points);
                effects.push({
                    kind: "tell",
                    line: messages.fullCardLine(messages.rewardText({ ...reward, points: granted }, language), language)
                });
                if (reward.levels > 0 || reward.items.length > 0) effects.push({ kind: "pay", payout: reward, label: "bingo" });
                updated = { ...updated, full: true };
            }
        }
        next = { ...next, [layer]: updated };
    }

    let backlogChanged = false;
    const backlog = next.backlog.map((instance) => {
        if (instance.doneAt === null || instance.paid) return instance;
        backlogChanged = true;
        return finish(instance, "backlog", titleOf(instance, language));
    });
    if (backlogChanged) next = { ...next, backlog };
    return { record: next, ledger: book, effects };
}

// ------------------------------------------------------------------ the daily backlog

/** How many days an unfinished daily is kept, and how many at once. */
export const BACKLOG_DAYS = 3;
export const BACKLOG_MAX = 3;

/**
 * A player's unfinished dailies of a day that ended, kept as a backlog with
 * what they had got to; anything older than three days, or past three in all,
 * is let go.
 */
export function toBacklog(record: PlayerRecord, ended: PlayerLayer, endedDay: string, today: string, dayNumber: (key: string) => number): PlayerRecord {
    const identity = (one: Instance) => `${one.day ?? endedDay}|${one.template}|${one.dealtAt}`;
    const held = new Set(record.backlog.map(identity));
    const carried = (one: Instance): Instance => ({ ...one, carry: one.progress, base: {}, last: {}, raw: 0, offset: 0, readAt: null });
    const left = ended.instances
        .filter((one) => one.doneAt === null && !one.voided && !held.has(identity(one)))
        .map((one) => carried({ ...one, day: one.day ?? endedDay }));
    const kept = [...record.backlog.filter((one) => one.doneAt === null).map(carried), ...left]
        .filter((one) => dayNumber(today) - dayNumber(one.day ?? today) <= BACKLOG_DAYS)
        .slice(-BACKLOG_MAX);
    return { ...record, backlog: kept };
}

// ------------------------------------------------------------------ the menu

export function refOf(layer: LayerName | "backlog", index: number): string {
    return `${layer}:${index}`;
}

/** The challenge a reference points at. */
export function lookup(record: PlayerRecord, ref: string | null): Instance | null {
    if (!ref) return null;
    const [layer, raw] = ref.split(":");
    const index = Number(raw);
    if (layer === "backlog") return record.backlog[index] ?? null;
    if (layer === "goal") return record.community[raw ?? ""] ?? null;
    if (layer === "daily" || layer === "weekly" || layer === "card") return record[layer]?.instances[index] ?? null;
    return null;
}

function line(template: catalog.Template, instance: Instance, language: catalog.Language): string {
    const done = instance.doneAt !== null;
    const mark = done ? "&a+ " : instance.voided ? "&c- " : "&7* ";
    const status = done
        ? `&a${messages.LABELS.done[language]}`
        : instance.voided
          ? `&c${messages.LABELS.voided[language]}`
          : `${messages.bar(instance.progress, instance.target)} &f${messages.figures(template, instance.progress, instance.target, language)}`;
    return `${mark}&f${catalog.titleOf(template, instance.variant, instance.target, language)} ${status}`;
}

/**
 * The list: today's, this week's and anything left over, each with its bar and
 * its buttons, and the season in a line underneath.
 */
export function menu(
    player: string,
    record: PlayerRecord,
    ledger: Ledger,
    context: Context,
    input: {
        dayLeft: number;
        weekLeft: number;
        rerollsLeft: { daily: number; weekly: number };
        goals: readonly GoalState[];
    }
): string[] {
    const { language, spelling, settings } = context;
    const lines: string[] = [];
    const tracked = record.tracked;
    const section = (
        layer: "daily" | "weekly" | "backlog",
        instances: readonly Instance[],
        left: number | null,
        rerollBase: number | null,
        rerolls: number
    ) => {
        if (instances.length === 0) return;
        lines.push(commands.tell(player, messages.header(layer, left, language)));
        instances.forEach((instance, index) => {
            const template = catalog.templateOf(instance.template);
            if (!template) return;
            const slot = layer === "daily" ? index : layer === "weekly" ? index + 3 : index + 6;
            const pieces: unknown[] = [
                ...commands.parts(
                    `${messages.tierLabel(layer === "weekly" ? "weekly" : "daily", instance.tier, language)} ${line(template, instance, language)} `
                )
            ];
            if (instance.doneAt === null && !instance.voided) {
                const ref = refOf(layer, index);
                pieces.push(
                    commands.button(
                        tracked === ref ? messages.LABELS.tracking[language] : messages.LABELS.track[language],
                        messages.LABELS.trackHover[language],
                        commands.PRESS.track + slot,
                        tracked === ref ? "gold" : "aqua",
                        spelling
                    )
                );
                if (rerollBase !== null && rerolls > 0) {
                    pieces.push(" ");
                    pieces.push(
                        commands.button(
                            messages.LABELS.reroll[language],
                            messages.LABELS.rerollHover[language],
                            commands.PRESS.reroll + rerollBase + index,
                            "yellow",
                            spelling
                        )
                    );
                }
            }
            lines.push(...commands.fitted(player, pieces));
        });
    };
    if (settings.layers.daily)
        section("daily", record.daily?.instances ?? [], input.dayLeft, 0, input.rerollsLeft.daily);
    if (settings.layers.weekly)
        section("weekly", record.weekly?.instances ?? [], input.weekLeft, 3, input.rerollsLeft.weekly);
    if (settings.layers.daily)
        section("backlog", record.backlog.filter((one) => one.doneAt === null), null, null, 0);
    const streak = season.streakNow(ledger.streak, context.day, context.clock);
    lines.push(
        commands.tell(
            player,
            messages.footer(streak, season.tierOf(ledger.points, settings), Math.floor(ledger.points), language)
        )
    );
    const buttons: unknown[] = [];
    const add = (label: string, hover: string, value: number) => {
        if (buttons.length > 0) buttons.push(" ");
        buttons.push(commands.button(label, hover, value, "aqua", spelling));
    };
    if (settings.layers.season) add(messages.LABELS.season[language], messages.LABELS.seasonHover[language], commands.PRESS.season);
    if (settings.layers.card) add(messages.LABELS.bingo[language], messages.LABELS.bingoHover[language], commands.PRESS.card);
    if (settings.layers.community && input.goals.length > 0)
        add(messages.LABELS.goal[language], messages.LABELS.goalHover[language], commands.PRESS.goal);
    if (tracked) add(messages.LABELS.untrack[language], messages.LABELS.untrack[language], commands.PRESS.untrack);
    if (buttons.length > 0) lines.push(...commands.fitted(player, buttons));
    return lines;
}

/** The season pass, in a few lines. */
export function seasonMenu(player: string, ledger: Ledger, context: Context): string[] {
    const { settings, language } = context;
    const tier = season.tierOf(ledger.points, settings);
    const upcoming = settings.season.milestones
        .filter((one) => one.tier > tier)
        .sort((left, right) => left.tier - right.tier)[0];
    const next = upcoming
        ? `${language === "es" ? "nivel" : "tier"} ${upcoming.tier}: ${messages.rewardText(season.tierReward(upcoming.tier, settings), language)}`
        : "";
    const lines = messages
        .seasonLines(
            {
                number: context.season.number,
                tier,
                tiers: settings.season.tiers,
                points: Math.floor(ledger.points),
                perTier: settings.season.pointsPerTier,
                daysLeft: context.season.daysLeft,
                next
            },
            language
        )
        .map((one) => commands.tell(player, one));
    if (ledger.titles.length > 0) lines.push(commands.tell(player, `&6${ledger.titles.join(", ")}`));
    lines.push(
        ...commands.fitted(player, [
            commands.button(messages.LABELS.list[language], messages.LABELS.listHover[language], commands.PRESS.list, "aqua", context.spelling)
        ])
    );
    return lines;
}

/** The month's card as three rows of three squares, each clickable to track. */
export function cardMenu(player: string, record: PlayerRecord, context: Context, left: number): string[] {
    const { language, spelling } = context;
    const squares = record.card?.instances ?? [];
    if (squares.length === 0) return [commands.tell(player, messages.nothingYet(language))];
    const lines = [
        commands.tell(
            player,
            `${messages.tag(language)}&e${messages.LABELS.card[language]} &7- ${language === "es" ? `quedan ${messages.duration(left, language)}` : `${messages.duration(left, language)} left`}`
        )
    ];
    for (let row = 0; row < 3; row += 1) {
        const pieces: unknown[] = [];
        for (let column = 0; column < 3; column += 1) {
            const index = row * 3 + column;
            const instance = squares[index];
            if (!instance) continue;
            const template = catalog.templateOf(instance.template);
            if (!template) continue;
            const done = instance.doneAt !== null;
            const hover = `&f${catalog.titleOf(template, instance.variant, instance.target, language)}&7 ${messages.figures(template, instance.progress, instance.target, language)}`;
            if (pieces.length > 0) pieces.push(" ");
            pieces.push(
                commands.button(
                    done ? "[X]" : `[${index + 1}]`,
                    hover,
                    commands.PRESS.trackSquare + index,
                    done ? "green" : instance.voided ? "red" : "gray",
                    spelling
                )
            );
        }
        lines.push(...commands.fitted(player, pieces));
    }
    squares.forEach((instance, index) => {
        const template = catalog.templateOf(instance.template);
        if (!template) return;
        lines.push(commands.tell(player, `&8${index + 1}. ${line(template, instance, language)}`));
    });
    return lines;
}

/** The community goals running now, and the player's part in each. */
export function goalMenu(player: string, record: PlayerRecord, goals: readonly GoalState[], context: Context): string[] {
    const { language, now } = context;
    const running = goals.filter((goal) => !goal.finished && goal.startedAt <= now && now < goal.endsAt);
    if (running.length === 0) return [commands.tell(player, messages.noGoal(language))];
    return running.flatMap((goal, index) => {
        const total = Object.values(goal.shares).reduce((sum, one) => sum + one.value, 0);
        const mine = record.community[goal.id]?.progress ?? 0;
        const share = total > 0 ? (mine / total) * 100 : 0;
        const title = titleOf({ template: goal.template, variant: goal.variant, target: goal.target }, language);
        return commands.fitted(player, [
            ...commands.parts(messages.goalLine(title, total, goal.target, share, goal.endsAt - now, language)),
            " ",
            commands.button(
                messages.LABELS.track[language],
                messages.LABELS.trackHover[language],
                commands.PRESS.trackGoal + index,
                "aqua",
                context.spelling
            )
        ]);
    });
}

/** The tier a goal's total has reached, 0 to 5, a fifth of the target each. */
export function goalTier(total: number, target: number): number {
    return Math.max(0, Math.min(5, Math.floor((total / Math.max(1, target)) * 5)));
}

/** Who earns a goal tier's reward: everybody whose part is at least the least
 *  share of what the tier needed. */
export function goalEarners(goal: GoalState, tier: number): string[] {
    const needed = (goal.target * tier) / 5;
    const least = (needed * goal.minShare) / 100;
    return Object.values(goal.shares)
        .filter((one) => one.value > 0 && one.value >= least)
        .map((one) => one.name);
}
