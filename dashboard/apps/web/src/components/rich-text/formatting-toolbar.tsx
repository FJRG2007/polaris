"use client";

/**
 * The formatting bar along the top of a document.
 *
 * A comment gets the bar over a selection and nothing else, because a comment
 * is a few lines and a row of controls over it would be bigger than what is
 * written. A document is the opposite: somebody writes in it for an hour, and
 * the controls a word processor has always had - the font, the size, the colour,
 * the alignment, the lists, a table - have to be somewhere they can be found
 * without first selecting something.
 *
 * Every control runs an editor command and nothing else, so formatting travels
 * through the document's CRDT exactly like typing does.
 *
 * On a narrow screen the bar keeps the controls reached for most - undo, the
 * paragraph style, bold, italic, underline - and everything else moves into the
 * "More" menu, which carries the full set so nothing is out of reach at 390px.
 */

import { ToolbarButton } from "./toolbar";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useState, type ReactNode } from "react";
import { MAX_INDENT, indentLevel } from "./document-schema";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    AlignCenter,
    AlignJustify,
    AlignLeft,
    AlignRight,
    Baseline,
    Bold,
    Highlighter,
    ImagePlus,
    IndentDecrease,
    IndentIncrease,
    Italic,
    Link2,
    List,
    ListChecks,
    ListOrdered,
    MoreHorizontal,
    Redo2,
    RemoveFormatting,
    Strikethrough,
    Table2,
    Underline,
    Undo2
} from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Input,
    Select
} from "@polaris/ui";

/** The faces offered. Ones every operating system has, so a document set in one
 *  reads the same on the machine it is opened on. Proper names, never
 *  translated. */
export const FONT_FAMILIES = [
    "Arial",
    "Georgia",
    "Times New Roman",
    "Verdana",
    "Trebuchet MS",
    "Courier New"
] as const;

/** Sizes in points, the unit every word processor counts in. */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72] as const;

/** A colour on offer, and the name it is read out under. */
interface ColorChoice {
    value: string;
    label: NamespaceKey<"components">;
}

/** Text colours: a dark and a strong of each family, enough for emphasis and a
 *  colour key without a picker. */
export const TEXT_COLORS: readonly ColorChoice[] = [
    { value: "#000000", label: "editor.toolbar.colors.black" },
    { value: "#4d5561", label: "editor.toolbar.colors.darkGray" },
    { value: "#9ca3af", label: "editor.toolbar.colors.gray" },
    { value: "#dc2626", label: "editor.toolbar.colors.red" },
    { value: "#ea580c", label: "editor.toolbar.colors.orange" },
    { value: "#ca8a04", label: "editor.toolbar.colors.mustard" },
    { value: "#16a34a", label: "editor.toolbar.colors.green" },
    { value: "#0891b2", label: "editor.toolbar.colors.cyan" },
    { value: "#2563eb", label: "editor.toolbar.colors.blue" },
    { value: "#7c3aed", label: "editor.toolbar.colors.violet" },
    { value: "#db2777", label: "editor.toolbar.colors.pink" }
];

/** Highlights: light enough that black text on them still reads. */
export const HIGHLIGHT_COLORS: readonly ColorChoice[] = [
    { value: "#fef08a", label: "editor.toolbar.colors.yellow" },
    { value: "#bbf7d0", label: "editor.toolbar.colors.lightGreen" },
    { value: "#a5f3fc", label: "editor.toolbar.colors.lightCyan" },
    { value: "#bfdbfe", label: "editor.toolbar.colors.lightBlue" },
    { value: "#ddd6fe", label: "editor.toolbar.colors.lavender" },
    { value: "#fbcfe8", label: "editor.toolbar.colors.lightPink" },
    { value: "#fed7aa", label: "editor.toolbar.colors.lightOrange" },
    { value: "#e5e7eb", label: "editor.toolbar.colors.lightGray" }
];

/** What the paragraph-style picker calls each kind of block. */
type BlockStyle = "paragraph" | "h1" | "h2" | "h3";

/** A link or a picture address, accepted only as one of the schemes the
 *  renderer allows - the same allowlist the link mark itself applies. */
export function safeAddress(raw: string, kind: "link" | "image"): string | null {
    const value = raw.trim();
    if (!value) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
    let parsed: URL;
    try {
        parsed = new URL(withScheme);
    } catch {
        return null;
    }
    const allowed = kind === "link" ? ["http:", "https:", "mailto:"] : ["http:", "https:"];
    return allowed.includes(parsed.protocol) ? parsed.toString() : null;
}

/** The point size a stored `font-size` stands for, or null when it is not one
 *  this bar set. */
export function pointsOf(fontSize: unknown): number | null {
    const match = /^(\d+(?:\.\d+)?)pt$/.exec(String(fontSize ?? ""));
    return match ? Number(match[1]) : null;
}

/** Everything the bar reads off the editor, read once per transaction. */
function readState(editor: Editor) {
    const style = editor.getAttributes("textStyle");
    const block: BlockStyle = editor.isActive("heading", { level: 1 })
        ? "h1"
        : editor.isActive("heading", { level: 2 })
          ? "h2"
          : editor.isActive("heading", { level: 3 })
            ? "h3"
            : "paragraph";
    const paragraph = editor.getAttributes(editor.isActive("heading") ? "heading" : "paragraph");
    return {
        block,
        fontFamily: typeof style.fontFamily === "string" ? style.fontFamily : "",
        fontSize: pointsOf(style.fontSize),
        color: typeof style.color === "string" ? style.color : "",
        highlight: (editor.getAttributes("highlight").color as string | undefined) ?? "",
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        align: (["center", "right", "justify"] as const).find((one) =>
            editor.isActive({ textAlign: one })
        ) ?? ("left" as const),
        bullets: editor.isActive("bulletList"),
        numbered: editor.isActive("orderedList"),
        tasks: editor.isActive("taskList"),
        inList: editor.isActive("listItem") || editor.isActive("taskItem"),
        indent: indentLevel(paragraph.indent),
        link: editor.isActive("link"),
        inTable: editor.isActive("table"),
        inCode: editor.isActive("codeBlock")
    };
}

export function FormattingToolbar({
    editor,
    onUndo,
    onRedo
}: {
    editor: Editor;
    /** The document's own undo, which is the CRDT's rather than the editor's. */
    onUndo: () => void;
    onRedo: () => void;
}) {
    const t = useTranslations("components");
    const state = useEditorState({ editor, selector: ({ editor: current }) => readState(current) });
    const [asking, setAsking] = useState<"link" | "image" | null>(null);

    if (!state) return null;
    const chain = () => editor.chain().focus();
    const inert = !editor.isEditable;

    const blockOptions = [
        { value: "paragraph", label: t("editor.toolbar.paragraph") },
        { value: "h1", label: t("editor.blocks.heading") },
        { value: "h2", label: t("editor.blocks.subheading") },
        { value: "h3", label: t("editor.blocks.smallHeading") }
    ];
    const setBlock = (next: string): void => {
        if (next === "paragraph") chain().setParagraph().run();
        else chain().setHeading({ level: Number(next.slice(1)) as 1 | 2 | 3 }).run();
    };

    const familyOptions = [
        { value: "", label: t("editor.toolbar.defaultFont") },
        ...FONT_FAMILIES.map((family) => ({ value: family, label: family }))
    ];
    const setFamily = (next: string): void => {
        if (next) chain().setFontFamily(next).run();
        else chain().unsetFontFamily().run();
    };

    const sizeOptions = [
        { value: "", label: t("editor.toolbar.defaultSize") },
        ...FONT_SIZES.map((size) => ({ value: String(size), label: String(size) }))
    ];
    const setSize = (next: string): void => {
        if (next) chain().setFontSize(`${next}pt`).run();
        else chain().unsetFontSize().run();
    };

    const setColor = (next: string | null): void => {
        if (next) chain().setColor(next).run();
        else chain().unsetColor().run();
    };
    const setHighlight = (next: string | null): void => {
        if (next) chain().setHighlight({ color: next }).run();
        else chain().unsetHighlight().run();
    };
    const align = (to: "left" | "center" | "right" | "justify"): void => {
        chain().setTextAlign(to).run();
    };
    const clear = (): void => {
        chain().unsetAllMarks().unsetTextAlign().clearNodes().run();
    };

    const alignments = [
        { value: "left" as const, label: t("editor.toolbar.alignLeft"), icon: AlignLeft },
        { value: "center" as const, label: t("editor.toolbar.alignCenter"), icon: AlignCenter },
        { value: "right" as const, label: t("editor.toolbar.alignRight"), icon: AlignRight },
        { value: "justify" as const, label: t("editor.toolbar.justify"), icon: AlignJustify }
    ];

    const lists = [
        {
            key: "bullets",
            label: t("editor.blocks.bullets"),
            icon: List,
            active: state.bullets,
            run: () => chain().toggleBulletList().run()
        },
        {
            key: "numbered",
            label: t("editor.blocks.numbered"),
            icon: ListOrdered,
            active: state.numbered,
            run: () => chain().toggleOrderedList().run()
        },
        {
            key: "tasks",
            label: t("editor.blocks.checklist"),
            icon: ListChecks,
            active: state.tasks,
            run: () => chain().toggleTaskList().run()
        }
    ];

    const canIndent = state.inList || state.indent < MAX_INDENT;
    const canOutdent = state.inList || state.indent > 0;

    return (
        <div
            role="toolbar"
            aria-label={t("editor.toolbar.label")}
            className="flex min-w-0 shrink-0 items-center gap-0.5 overflow-hidden border-b border-border bg-surface px-2 py-1"
        >
            <ToolbarButton label={t("editor.toolbar.undo")} disabled={inert} onClick={onUndo}>
                <Undo2 className="size-4" />
            </ToolbarButton>
            <ToolbarButton label={t("editor.toolbar.redo")} disabled={inert} onClick={onRedo}>
                <Redo2 className="size-4" />
            </ToolbarButton>
            <Divider />

            <Select
                aria-label={t("editor.toolbar.paragraphStyle")}
                value={state.block}
                onValueChange={setBlock}
                options={blockOptions}
                disabled={inert || state.inCode}
                className="h-7 w-32 shrink-0 text-xs"
            />
            <div className="hidden items-center gap-0.5 sm:flex">
                <Select
                    aria-label={t("editor.toolbar.font")}
                    value={state.fontFamily}
                    onValueChange={setFamily}
                    options={familyOptions}
                    disabled={inert || state.inCode}
                    className="h-7 w-36 shrink-0 text-xs"
                />
                <Select
                    aria-label={t("editor.toolbar.size")}
                    value={state.fontSize === null ? "" : String(state.fontSize)}
                    onValueChange={setSize}
                    options={sizeOptions}
                    disabled={inert || state.inCode}
                    className="h-7 w-20 shrink-0 text-xs"
                />
            </div>
            <Divider />

            <ToolbarButton
                label={t("editor.bold")}
                active={state.bold}
                disabled={inert}
                onClick={() => chain().toggleBold().run()}
            >
                <Bold className="size-4" />
            </ToolbarButton>
            <ToolbarButton
                label={t("editor.italic")}
                active={state.italic}
                disabled={inert}
                onClick={() => chain().toggleItalic().run()}
            >
                <Italic className="size-4" />
            </ToolbarButton>
            <ToolbarButton
                label={t("editor.toolbar.underline")}
                active={state.underline}
                disabled={inert}
                onClick={() => chain().toggleUnderline().run()}
            >
                <Underline className="size-4" />
            </ToolbarButton>

            <div className="hidden items-center gap-0.5 md:flex">
                <ToolbarButton
                    label={t("editor.strike")}
                    active={state.strike}
                    disabled={inert}
                    onClick={() => chain().toggleStrike().run()}
                >
                    <Strikethrough className="size-4" />
                </ToolbarButton>
                <SwatchMenu
                    label={t("editor.toolbar.textColor")}
                    noneLabel={t("editor.toolbar.automatic")}
                    icon={<Baseline className="size-4" />}
                    swatches={TEXT_COLORS}
                    current={state.color}
                    disabled={inert}
                    onPick={setColor}
                />
                <SwatchMenu
                    label={t("editor.toolbar.highlight")}
                    noneLabel={t("editor.toolbar.noHighlight")}
                    icon={<Highlighter className="size-4" />}
                    swatches={HIGHLIGHT_COLORS}
                    current={state.highlight}
                    disabled={inert}
                    onPick={setHighlight}
                />
            </div>

            <div className="hidden items-center gap-0.5 lg:flex">
                <Divider />
                {alignments.map((one) => (
                    <ToolbarButton
                        key={one.value}
                        label={one.label}
                        active={state.align === one.value}
                        disabled={inert}
                        onClick={() => align(one.value)}
                    >
                        <one.icon className="size-4" />
                    </ToolbarButton>
                ))}
                <Divider />
                {lists.map((one) => (
                    <ToolbarButton
                        key={one.key}
                        label={one.label}
                        active={one.active}
                        disabled={inert}
                        onClick={one.run}
                    >
                        <one.icon className="size-4" />
                    </ToolbarButton>
                ))}
                <ToolbarButton
                    label={t("editor.toolbar.outdent")}
                    disabled={inert || !canOutdent}
                    onClick={() => chain().outdent().run()}
                >
                    <IndentDecrease className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                    label={t("editor.toolbar.indent")}
                    disabled={inert || !canIndent}
                    onClick={() => chain().indent().run()}
                >
                    <IndentIncrease className="size-4" />
                </ToolbarButton>
                <Divider />
                <ToolbarButton
                    label={state.link ? t("editor.removeLink") : t("editor.addLink")}
                    active={state.link}
                    disabled={inert}
                    onClick={() =>
                        state.link
                            ? chain().extendMarkRange("link").unsetLink().run()
                            : setAsking("link")
                    }
                >
                    <Link2 className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                    label={t("editor.toolbar.image")}
                    disabled={inert}
                    onClick={() => setAsking("image")}
                >
                    <ImagePlus className="size-4" />
                </ToolbarButton>
                <TableMenu editor={editor} inTable={state.inTable} disabled={inert} />
                <ToolbarButton
                    label={t("editor.toolbar.clear")}
                    disabled={inert}
                    onClick={clear}
                >
                    <RemoveFormatting className="size-4" />
                </ToolbarButton>
            </div>

            {/* Everything, for a screen too narrow for the row. */}
            <div className="ml-auto lg:hidden">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild disabled={inert}>
                        <button
                            type="button"
                            aria-label={t("editor.toolbar.more")}
                            title={t("editor.toolbar.more")}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <MoreHorizontal className="size-4" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>{t("editor.toolbar.font")}</DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {familyOptions.map((one) => (
                                    <Picked
                                        key={one.value || "default"}
                                        chosen={state.fontFamily === one.value}
                                        onSelect={() => setFamily(one.value)}
                                    >
                                        {one.label}
                                    </Picked>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>{t("editor.toolbar.size")}</DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                                {sizeOptions.map((one) => (
                                    <Picked
                                        key={one.value || "default"}
                                        chosen={
                                            (state.fontSize === null ? "" : String(state.fontSize)) ===
                                            one.value
                                        }
                                        onSelect={() => setSize(one.value)}
                                    >
                                        {one.label}
                                    </Picked>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                {t("editor.toolbar.textColor")}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                <Picked chosen={!state.color} onSelect={() => setColor(null)}>
                                    {t("editor.toolbar.automatic")}
                                </Picked>
                                {TEXT_COLORS.map((one) => (
                                    <Picked
                                        key={one.value}
                                        chosen={state.color === one.value}
                                        onSelect={() => setColor(one.value)}
                                    >
                                        <Swatch color={one.value} />
                                        {t(one.label)}
                                    </Picked>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                {t("editor.toolbar.highlight")}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                <Picked
                                    chosen={!state.highlight}
                                    onSelect={() => setHighlight(null)}
                                >
                                    {t("editor.toolbar.noHighlight")}
                                </Picked>
                                {HIGHLIGHT_COLORS.map((one) => (
                                    <Picked
                                        key={one.value}
                                        chosen={state.highlight === one.value}
                                        onSelect={() => setHighlight(one.value)}
                                    >
                                        <Swatch color={one.value} />
                                        {t(one.label)}
                                    </Picked>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuItem onSelect={() => chain().toggleStrike().run()}>
                            <Strikethrough className="size-4" />
                            {t("editor.strike")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {alignments.map((one) => (
                            <Picked
                                key={one.value}
                                chosen={state.align === one.value}
                                onSelect={() => align(one.value)}
                            >
                                <one.icon className="size-4" />
                                {one.label}
                            </Picked>
                        ))}
                        <DropdownMenuSeparator />
                        {lists.map((one) => (
                            <Picked key={one.key} chosen={one.active} onSelect={one.run}>
                                <one.icon className="size-4" />
                                {one.label}
                            </Picked>
                        ))}
                        <DropdownMenuItem
                            disabled={!canOutdent}
                            onSelect={() => chain().outdent().run()}
                        >
                            <IndentDecrease className="size-4" />
                            {t("editor.toolbar.outdent")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={!canIndent}
                            onSelect={() => chain().indent().run()}
                        >
                            <IndentIncrease className="size-4" />
                            {t("editor.toolbar.indent")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onSelect={() =>
                                state.link
                                    ? chain().extendMarkRange("link").unsetLink().run()
                                    : setAsking("link")
                            }
                        >
                            <Link2 className="size-4" />
                            {state.link ? t("editor.removeLink") : t("editor.addLink")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setAsking("image")}>
                            <ImagePlus className="size-4" />
                            {t("editor.toolbar.image")}
                        </DropdownMenuItem>
                        {state.inTable ? (
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <Table2 className="size-4" />
                                    {t("editor.toolbar.table")}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <TableActionItems editor={editor} />
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        ) : (
                            <DropdownMenuItem
                                onSelect={() =>
                                    chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
                                }
                            >
                                <Table2 className="size-4" />
                                {t("editor.toolbar.insertTable")}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={clear}>
                            <RemoveFormatting className="size-4" />
                            {t("editor.toolbar.clear")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <AddressDialog
                kind={asking}
                initial={asking === "link" ? (editor.getAttributes("link").href ?? "") : ""}
                onClose={() => setAsking(null)}
                onApply={(kind, address) => {
                    if (kind === "link") {
                        chain().extendMarkRange("link").setLink({ href: address }).run();
                    } else {
                        chain().setImage({ src: address }).run();
                    }
                    setAsking(null);
                }}
            />
        </div>
    );
}

function Divider() {
    return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

function Swatch({ color }: { color: string }) {
    return (
        <span
            aria-hidden
            className="size-3.5 shrink-0 rounded-sm ring-1 ring-border"
            style={{ backgroundColor: color }}
        />
    );
}

/** A menu row that says whether it is the current choice. */
function Picked({
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
            aria-checked={chosen}
            role="menuitemcheckbox"
            className={cn(chosen && "bg-muted font-medium")}
        >
            {children}
        </DropdownMenuItem>
    );
}

/** A colour, from a short palette or none at all. */
function SwatchMenu({
    label,
    noneLabel,
    icon,
    swatches,
    current,
    disabled,
    onPick
}: {
    label: string;
    noneLabel: string;
    icon: ReactNode;
    swatches: readonly ColorChoice[];
    current: string;
    disabled: boolean;
    onPick: (color: string | null) => void;
}) {
    const t = useTranslations("components");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    aria-label={label}
                    title={label}
                    className="relative shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                    {icon}
                    <span
                        aria-hidden
                        className="absolute inset-x-1.5 bottom-1 h-0.5 rounded-full"
                        style={{ backgroundColor: current || "currentColor" }}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-auto p-2">
                <div className="grid grid-cols-6 gap-1.5">
                    {swatches.map((one) => (
                        <DropdownMenuItem
                            key={one.value}
                            aria-label={t(one.label)}
                            title={t(one.label)}
                            onSelect={() => onPick(one.value)}
                            className={cn(
                                "size-6 justify-center rounded p-0",
                                current === one.value && "ring-2 ring-primary"
                            )}
                            style={{ backgroundColor: one.value }}
                        />
                    ))}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onPick(null)}>{noneLabel}</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** What can be done to a table the caret is in, as menu rows: the ones that
 *  add or switch, then the ones that remove. */
function TableActionItems({ editor }: { editor: Editor }) {
    const t = useTranslations("components");
    const chain = () => editor.chain().focus();
    const actions = [
        { key: "rowAbove", run: () => chain().addRowBefore().run() },
        { key: "rowBelow", run: () => chain().addRowAfter().run() },
        { key: "columnLeft", run: () => chain().addColumnBefore().run() },
        { key: "columnRight", run: () => chain().addColumnAfter().run() },
        { key: "headerRow", run: () => chain().toggleHeaderRow().run() },
        { key: "deleteRow", run: () => chain().deleteRow().run() },
        { key: "deleteColumn", run: () => chain().deleteColumn().run() },
        { key: "deleteTable", run: () => chain().deleteTable().run() }
    ] as const;
    return (
        <>
            {actions.map((one, index) => (
                <div key={one.key}>
                    {index === 5 ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem onSelect={one.run}>
                        {t(`editor.toolbar.tableActions.${one.key}`)}
                    </DropdownMenuItem>
                </div>
            ))}
        </>
    );
}

/** Inserting a table, and what can be done to one the caret is in. */
function TableMenu({
    editor,
    inTable,
    disabled
}: {
    editor: Editor;
    inTable: boolean;
    disabled: boolean;
}) {
    const t = useTranslations("components");
    const chain = () => editor.chain().focus();
    if (!inTable) {
        return (
            <ToolbarButton
                label={t("editor.toolbar.insertTable")}
                disabled={disabled}
                onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            >
                <Table2 className="size-4" />
            </ToolbarButton>
        );
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    aria-label={t("editor.toolbar.table")}
                    title={t("editor.toolbar.table")}
                    className="shrink-0 rounded bg-muted p-1.5 text-foreground transition-colors hover:bg-muted"
                >
                    <Table2 className="size-4" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                <TableActionItems editor={editor} />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The address of a link or a picture, asked for in the product's own dialog. */
function AddressDialog({
    kind,
    initial,
    onClose,
    onApply
}: {
    kind: "link" | "image" | null;
    initial: string;
    onClose: () => void;
    onApply: (kind: "link" | "image", address: string) => void;
}) {
    const t = useTranslations("components");
    const tc = useTranslations("common");
    const [value, setValue] = useState("");
    const [touched, setTouched] = useState(false);
    const address = kind ? safeAddress(value, kind) : null;
    const invalid = touched && value.trim() !== "" && address === null;

    return (
        <Dialog
            open={kind !== null}
            onOpenChange={(open) => {
                if (open) return;
                onClose();
                setValue("");
                setTouched(false);
            }}
        >
            <DialogContent
                className="max-w-md"
                onOpenAutoFocus={() => {
                    setValue(initial);
                    setTouched(false);
                }}
            >
                <DialogHeader>
                    <DialogTitle>
                        {kind === "image" ? t("editor.toolbar.image") : t("editor.addLink")}
                    </DialogTitle>
                    <DialogDescription>
                        {kind === "image"
                            ? t("editor.toolbar.imageHint")
                            : t("editor.toolbar.linkHint")}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setTouched(true);
                        if (kind && address) onApply(kind, address);
                    }}
                >
                    <Input
                        autoFocus
                        aria-label={kind === "image" ? t("editor.toolbar.imageAddress") : t("editor.linkAddress")}
                        aria-invalid={invalid}
                        placeholder="https://"
                        value={value}
                        onChange={(event) => {
                            setValue(event.target.value);
                            setTouched(true);
                        }}
                    />
                    {invalid ? (
                        <p role="alert" className="text-xs text-danger">
                            {t("editor.toolbar.badAddress")}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!address} disabled={!address}>
                            {t("editor.toolbar.insert")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
