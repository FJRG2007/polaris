"use client";

/**
 * What can be done to the chosen boxes, on the editor's toolbar.
 *
 * Contextual, as in Google Slides: words get the face, size, bold, italic,
 * underline, colour, alignment and lists; a shape adds its fill and outline; a
 * line its colour and weight; everything can be moved through the stack, lined
 * up, spaced out and grouped. A control that means nothing for what is chosen
 * is not shown, rather than shown greyed out. With several boxes chosen, a
 * control shows the first box it applies to and changes every box it applies
 * to. Every press is one step undo takes back.
 */

import * as deck from "@/lib/office/deck";
import { ToolbarButton } from "@/components/rich-text/toolbar";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    HIGHLIGHT_COLORS,
    SwatchMenu,
    TEXT_COLORS,
    type ColorChoice
} from "@/components/rich-text/formatting-toolbar";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    ShortcutHint
} from "@polaris/ui";
import {
    AArrowDown,
    AArrowUp,
    AlignCenter,
    AlignCenterHorizontal,
    AlignCenterVertical,
    AlignEndHorizontal,
    AlignEndVertical,
    AlignHorizontalDistributeCenter,
    AlignLeft,
    AlignRight,
    AlignStartHorizontal,
    AlignStartVertical,
    AlignVerticalDistributeCenter,
    AlignVerticalJustifyCenter,
    AlignVerticalJustifyEnd,
    AlignVerticalJustifyStart,
    ArrowDown,
    ArrowUp,
    Baseline,
    Bold,
    BringToFront,
    CaseSensitive,
    ChevronDown,
    Group,
    Italic,
    Layers,
    List,
    ListOrdered,
    PaintBucket,
    PenLine,
    SendToBack,
    SeparatorHorizontal,
    Underline,
    Ungroup
} from "lucide-react";
import type { ReactNode } from "react";

export type BoxPatch = Partial<Omit<deck.Box, "id" | "version" | "kind">>;

/** Which of the chosen boxes a change is for: those with words, those that
 *  are an area (a shape or a text box, which can be filled and outlined), or
 *  the lines. */
export type PatchTarget = "words" | "areas" | "lines";

/** Whether a change meant for `to` applies to `box`. */
export function patchFits(box: deck.Box, to: PatchTarget): boolean {
    if (to === "words") return deck.holdsText(box);
    if (to === "lines") return deck.isLine(box);
    return (box.kind === "shape" || box.kind === "text") && !deck.isLine(box);
}

/** What a box can be filled or outlined with: white, then the text colours and
 *  the light ones. */
export const FILL_COLORS: readonly ColorChoice[] = [
    { value: "#ffffff", label: "editor.toolbar.colors.white" },
    ...TEXT_COLORS,
    ...HIGHLIGHT_COLORS
];

const ALIGN_ICON = { left: AlignLeft, center: AlignCenter, right: AlignRight } as const;

const VALIGN_ICON = {
    top: AlignVerticalJustifyStart,
    middle: AlignVerticalJustifyCenter,
    bottom: AlignVerticalJustifyEnd
} as const;

/** The ways boxes line up: across first, then down, as the Align menu of
 *  Google Slides lists them. */
const ALIGN_BOXES_ICON = {
    left: AlignStartVertical,
    center: AlignCenterVertical,
    right: AlignEndVertical,
    top: AlignStartHorizontal,
    middle: AlignCenterHorizontal,
    bottom: AlignEndHorizontal
} as const;

const ARRANGE_ICON = {
    front: BringToFront,
    forward: ArrowUp,
    backward: ArrowDown,
    back: SendToBack
} as const;

const ARRANGE_SHORTCUT = {
    front: "office.slides.bringToFront",
    forward: "office.slides.bringForward",
    backward: "office.slides.sendBackward",
    back: "office.slides.sendToBack"
} as const;

function Divider() {
    return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

/** A toolbar button that opens a short menu, showing what is chosen now. */
export function MenuButton({
    label,
    children,
    menu,
    wide
}: {
    label: string;
    children: ReactNode;
    menu: ReactNode;
    wide?: boolean;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={label}
                    title={label}
                    className={cn(
                        "flex shrink-0 items-center gap-0.5 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                        wide &&
                            "min-w-12 justify-between px-2 text-[13px] tabular-nums text-foreground"
                    )}
                >
                    {children}
                    <ChevronDown className="size-3 shrink-0" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain">
                {menu}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function Choice({
    chosen,
    onSelect,
    children
}: {
    chosen: boolean;
    onSelect: () => void;
    children: ReactNode;
}) {
    return (
        <DropdownMenuItem
            onSelect={onSelect}
            role="menuitemradio"
            aria-checked={chosen}
            className={cn(chosen && "bg-muted font-medium")}
        >
            {children}
        </DropdownMenuItem>
    );
}

export function FormatBar({
    boxes,
    onPatch,
    onArrange,
    onAlign,
    onDistribute,
    onGroup,
    onUngroup
}: {
    /** The chosen boxes, at least one. */
    boxes: readonly deck.Box[];
    onPatch: (patch: BoxPatch, to: PatchTarget) => void;
    onArrange: (how: deck.Arrange) => void;
    onAlign: (how: deck.AlignBoxes) => void;
    onDistribute: (axis: "x" | "y") => void;
    onGroup: () => void;
    onUngroup: () => void;
}) {
    const t = useTranslations("office");
    const wordsBox = boxes.find((one) => patchFits(one, "words"));
    const areaBox = boxes.find((one) => patchFits(one, "areas"));
    // A line's own colour and weight when lines are all there is; among other
    // boxes, the outline controls are the areas'.
    const lineBox = areaBox ? undefined : boxes.find((one) => patchFits(one, "lines"));
    const canGroup = deck.canGroup(boxes);
    const canUngroup = deck.canUngroup(boxes);
    const canDistribute = deck.canDistribute(boxes);

    return (
        <>
            <Divider />
            {/* What the boxes are to each other first - their order, lining up,
                spacing, grouping - as Google Slides keeps it all under Arrange;
                their words and colours after, where a narrow window may have
                to scroll to reach them. */}
            <MenuButton
                label={t("slides.format.arrange")}
                menu={
                    <>
                        {deck.ARRANGE.map((one) => {
                            const Icon = ARRANGE_ICON[one];
                            return (
                                <DropdownMenuItem key={one} onSelect={() => onArrange(one)}>
                                    <Icon aria-hidden />
                                    {t(`slides.format.arranges.${one}`)}
                                    <ShortcutHint id={ARRANGE_SHORTCUT[one]} />
                                </DropdownMenuItem>
                            );
                        })}
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <AlignCenterVertical aria-hidden />
                                {t("slides.format.alignBoxes")}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {deck.ALIGN_BOXES.map((one) => {
                                    const Icon = ALIGN_BOXES_ICON[one];
                                    return (
                                        <div key={one}>
                                            {one === "top" ? <DropdownMenuSeparator /> : null}
                                            <DropdownMenuItem onSelect={() => onAlign(one)}>
                                                <Icon aria-hidden />
                                                {t(`slides.format.alignBoxesTo.${one}`)}
                                            </DropdownMenuItem>
                                        </div>
                                    );
                                })}
                                {canDistribute ? (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => onDistribute("x")}>
                                            <AlignHorizontalDistributeCenter aria-hidden />
                                            {t("slides.format.distributeAcross")}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => onDistribute("y")}>
                                            <AlignVerticalDistributeCenter aria-hidden />
                                            {t("slides.format.distributeDown")}
                                        </DropdownMenuItem>
                                    </>
                                ) : null}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        {canGroup ? (
                            <DropdownMenuItem onSelect={onGroup}>
                                <Group aria-hidden />
                                {t("slides.format.group")}
                                <ShortcutHint id="office.slides.group" />
                            </DropdownMenuItem>
                        ) : null}
                        {canUngroup ? (
                            <DropdownMenuItem onSelect={onUngroup}>
                                <Ungroup aria-hidden />
                                {t("slides.format.ungroup")}
                                <ShortcutHint id="office.slides.ungroup" />
                            </DropdownMenuItem>
                        ) : null}
                    </>
                }
            >
                <Layers className="size-4" />
            </MenuButton>
            {wordsBox ? (
                <WordControls box={wordsBox} onPatch={(patch) => onPatch(patch, "words")} />
            ) : null}
            {areaBox ? (
                <OutlineControls
                    box={areaBox}
                    line={false}
                    onPatch={(patch) => onPatch(patch, "areas")}
                />
            ) : lineBox ? (
                <OutlineControls box={lineBox} line onPatch={(patch) => onPatch(patch, "lines")} />
            ) : null}
        </>
    );
}

/** A box's words: face, size, emphasis, colour, alignment and lists. */
function WordControls({ box, onPatch }: { box: deck.Box; onPatch: (patch: BoxPatch) => void }) {
    const t = useTranslations("office");
    const points = deck.pointsOf(box.size);
    const AlignIcon = ALIGN_ICON[box.align];
    const ValignIcon = VALIGN_ICON[box.valign];
    return (
        <>
            <Divider />
            <MenuButton
                label={t("slides.format.font")}
                wide
                menu={["", ...deck.SLIDE_FONTS].map((one) => (
                    <Choice
                        key={one || "theme"}
                        chosen={box.font === one}
                        onSelect={() => onPatch({ font: one })}
                    >
                        <span style={one ? { fontFamily: `"${one}"` } : undefined}>
                            {one || t("slides.format.themeFont")}
                        </span>
                    </Choice>
                ))}
            >
                {/* The face by name on the widest screens; its icon elsewhere,
                    where the row needs the room. */}
                <CaseSensitive className="size-4 shrink-0 2xl:hidden" aria-hidden />
                <span className="min-w-0 max-w-24 truncate max-2xl:hidden">
                    {box.font || t("slides.format.themeFont")}
                </span>
            </MenuButton>
            <ToolbarButton
                label={t("slides.format.smaller")}
                disabled={points <= deck.FONT_POINTS_MIN}
                onClick={() => onPatch({ size: deck.stepPoints(box.size, -1) })}
            >
                <AArrowDown className="size-4" />
            </ToolbarButton>
            <MenuButton
                label={t("slides.format.fontSize")}
                wide
                menu={deck.FONT_POINTS.map((one) => (
                    <Choice
                        key={one}
                        chosen={one === points}
                        onSelect={() => onPatch({ size: deck.fractionOfPoints(one) })}
                    >
                        <span className="tabular-nums">{one}</span>
                    </Choice>
                ))}
            >
                <span>{points}</span>
            </MenuButton>
            <ToolbarButton
                label={t("slides.format.bigger")}
                disabled={points >= deck.FONT_POINTS_MAX}
                onClick={() => onPatch({ size: deck.stepPoints(box.size, 1) })}
            >
                <AArrowUp className="size-4" />
            </ToolbarButton>
            <Divider />
            <ToolbarButton
                label={t("slides.format.bold")}
                active={box.bold}
                onClick={() => onPatch({ bold: !box.bold })}
            >
                <Bold className="size-4" />
            </ToolbarButton>
            <ToolbarButton
                label={t("slides.format.italic")}
                active={box.italic}
                onClick={() => onPatch({ italic: !box.italic })}
            >
                <Italic className="size-4" />
            </ToolbarButton>
            <ToolbarButton
                label={t("slides.format.underline")}
                active={box.underline}
                onClick={() => onPatch({ underline: !box.underline })}
            >
                <Underline className="size-4" />
            </ToolbarButton>
            <SwatchMenu
                label={t("slides.format.textColor")}
                noneLabel={t("slides.format.automatic")}
                icon={<Baseline className="size-4" />}
                swatches={FILL_COLORS}
                current={box.color}
                disabled={false}
                onPick={(color) => onPatch({ color: color ?? "" })}
            />
            <Divider />
            <MenuButton
                label={t("slides.format.align")}
                menu={deck.ALIGNS.map((one) => {
                    const Icon = ALIGN_ICON[one];
                    return (
                        <Choice
                            key={one}
                            chosen={box.align === one}
                            onSelect={() => onPatch({ align: one })}
                        >
                            <Icon aria-hidden />
                            {t(`slides.format.aligns.${one}`)}
                            <ShortcutHint id={`office.slides.align.${one}`} />
                        </Choice>
                    );
                })}
            >
                <AlignIcon className="size-4" />
            </MenuButton>
            <MenuButton
                label={t("slides.format.valign")}
                menu={deck.VALIGNS.map((one) => {
                    const Icon = VALIGN_ICON[one];
                    return (
                        <Choice
                            key={one}
                            chosen={box.valign === one}
                            onSelect={() => onPatch({ valign: one })}
                        >
                            <Icon aria-hidden />
                            {t(`slides.format.valigns.${one}`)}
                        </Choice>
                    );
                })}
            >
                <ValignIcon className="size-4" />
            </MenuButton>
            <ToolbarButton
                label={t("slides.format.bulletList")}
                active={box.list === "bullet"}
                onClick={() => onPatch({ list: box.list === "bullet" ? "none" : "bullet" })}
            >
                <List className="size-4" />
            </ToolbarButton>
            <ToolbarButton
                label={t("slides.format.numberedList")}
                active={box.list === "number"}
                onClick={() => onPatch({ list: box.list === "number" ? "none" : "number" })}
            >
                <ListOrdered className="size-4" />
            </ToolbarButton>
        </>
    );
}

/** A box's fill and outline, or a line's colour and weight. */
function OutlineControls({
    box,
    line,
    onPatch
}: {
    box: deck.Box;
    line: boolean;
    onPatch: (patch: BoxPatch) => void;
}) {
    const t = useTranslations("office");
    const tc = useTranslations("components");
    const strokePoints = deck.pointsOf(box.strokeWidth);
    return (
        <>
            <Divider />
            {line ? null : (
                <SwatchMenu
                    label={t("slides.format.fill")}
                    noneLabel={t("slides.format.noFill")}
                    icon={<PaintBucket className="size-4" />}
                    swatches={FILL_COLORS}
                    current={box.fill === "transparent" ? "" : box.fill}
                    disabled={false}
                    onPick={(color) => onPatch({ fill: color ?? "transparent" })}
                />
            )}
            {line ? (
                <SwatchMenu
                    label={t("slides.format.lineColor")}
                    noneLabel={tc("editor.toolbar.automatic")}
                    icon={<PenLine className="size-4" />}
                    swatches={FILL_COLORS}
                    current={box.stroke}
                    disabled={false}
                    onPick={(color) => onPatch({ stroke: color ?? deck.LINE_STROKE })}
                />
            ) : (
                <SwatchMenu
                    label={t("slides.format.border")}
                    noneLabel={t("slides.format.noBorder")}
                    icon={<PenLine className="size-4" />}
                    swatches={FILL_COLORS}
                    current={box.stroke}
                    disabled={false}
                    onPick={(color) => onPatch({ stroke: color ?? "" })}
                />
            )}
            <MenuButton
                label={line ? t("slides.format.lineWeight") : t("slides.format.borderWeight")}
                menu={deck.STROKE_POINTS.map((one) => (
                    <Choice
                        key={one}
                        chosen={one === strokePoints}
                        onSelect={() =>
                            onPatch({
                                strokeWidth: deck.fractionOfPoints(one),
                                // A weight for an outline nobody can see is a
                                // weight that also shows it.
                                ...(box.stroke || line ? {} : { stroke: deck.LINE_STROKE })
                            })
                        }
                    >
                        <span
                            aria-hidden
                            className="w-8 shrink-0 rounded-full bg-foreground"
                            style={{ height: Math.max(1, Math.min(8, one)) }}
                        />
                        {t("slides.format.points", { points: one })}
                    </Choice>
                ))}
            >
                <SeparatorHorizontal className="size-4" />
            </MenuButton>
        </>
    );
}
