"use client";

/**
 * Polaris's right-click menu for everything no screen has a menu for, on every
 * page: a text field, a picture, a link and selected text. Empty space and an
 * open menu get nothing - never the browser's menu (`lib/context-menu/target.ts`
 * has the rules and the order the menus are asked in).
 *
 * Inside the app's shell the selection menu answers selected text and links
 * first, with its Search, Translate and Ask Polar; this one is what is left,
 * and the whole of it on pages outside the shell (sign-in, public pages).
 */

import {
    BookPlus,
    Copy,
    Download,
    ExternalLink,
    Image as ImageIcon,
    Link2,
    Redo2,
    Scissors,
    SpellCheck,
    TextSelect,
    Undo2
} from "lucide-react";
import { openLink } from "@/lib/open-link";
import { useEffect, useState } from "react";
import * as selectionMenu from "@/lib/selection-menu";
import { desktopBridge } from "@/lib/desktop-bridge";
import * as editing from "@/lib/context-menu/editing";
import * as contextMenu from "@/lib/context-menu/target";
import { PasteItems } from "@/components/context-menu-paste-items";
import { useMenuPaste, type MenuPaste } from "@/lib/context-menu/use-menu-paste";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    DropdownMenu,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    MenuShortcut
} from "@polaris/ui";

interface OpenMenu {
    readonly x: number;
    readonly y: number;
    readonly target: contextMenu.ContextTarget;
    /** Spelling suggestions for the word under the caret, when it is misspelled. */
    readonly suggestions: readonly string[] | null;
    /** The field's selection when the menu opened, to put back before acting. */
    readonly fieldRange: readonly [number, number] | null;
    readonly range: Range | null;
}

/** The menu a target gets here, or null for none. Pure, for the tests. */
export type FallbackMenu = "field" | "selection" | "link" | "media" | null;

export function fallbackMenuFor(target: contextMenu.ContextTarget): FallbackMenu {
    switch (target.kind) {
        case "field":
        case "selection":
        case "link":
            return target.kind;
        case "media":
            return target.image || target.link ? "media" : null;
        default:
            return null;
    }
}

function fieldOf(target: contextMenu.ContextTarget): Element | null {
    if (target.kind === "field") return target.field;
    if (target.kind === "selection") return target.found.field;
    return null;
}

/** Puts back the selection the menu was opened on. */
function restore(menu: OpenMenu): void {
    const field = fieldOf(menu.target);
    if (field) (field as HTMLElement).focus({ preventScroll: true });
    if (editing.isTextField(field) && menu.fieldRange) {
        field.setSelectionRange(menu.fieldRange[0], menu.fieldRange[1]);
    } else if (menu.range) {
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(menu.range);
    }
}

export function ContextMenuFallback() {
    const t = useTranslations("common");
    const menuPaste = useMenuPaste();
    const [menu, setMenu] = useState<OpenMenu | null>(null);

    useEffect(() => {
        const bridge = desktopBridge()?.editing;
        if (bridge) contextMenu.setSpellingCheck((word) => bridge.spelling(word).misspelled);
        const remove = contextMenu.addContextLayer(0, (event, target) => {
            if (fallbackMenuFor(target) === null) return true;
            const field = fieldOf(target);
            const selection = document.getSelection();
            const word = target.kind === "field" ? target.word : null;
            const keyboard = selectionMenu.fromKeyboard(event);
            const box = keyboard ? (event.target as Element | null)?.getBoundingClientRect?.() : null;
            setMenu({
                x: box ? box.left : event.clientX,
                y: box ? box.bottom : event.clientY,
                target,
                suggestions: word && bridge ? spellingOf(bridge, word.text) : null,
                fieldRange: editing.isTextField(field)
                    ? [field.selectionStart ?? 0, field.selectionEnd ?? 0]
                    : null,
                range:
                    !editing.isTextField(field) && selection && selection.rangeCount > 0
                        ? selection.getRangeAt(0).cloneRange()
                        : null
            });
            return true;
        });
        // A picture inside a sandboxed frame (a received email): its owner has
        // already checked the sender and moved the point onto this page.
        const onFramedMedia = (event: Event) => {
            const found = (event as CustomEvent<selectionMenu.FramedMedia>).detail;
            setMenu({
                x: found.x,
                y: found.y,
                target: { kind: "media", image: { src: found.src, web: true }, link: found.link },
                suggestions: null,
                fieldRange: null,
                range: null
            });
        };
        window.addEventListener(selectionMenu.FRAMED_MEDIA_EVENT, onFramedMedia);
        return () => {
            window.removeEventListener(selectionMenu.FRAMED_MEDIA_EVENT, onFramedMedia);
            remove();
            contextMenu.setSpellingCheck(null);
        };
    }, []);

    const copy = async (text: string) =>
        contextMenu.contextMenuNotice(
            (await editing.copyText(text)) ? t("selectionMenu.copied") : t("selectionMenu.copyFailed")
        );

    const paste = async (opened: OpenMenu, plain: boolean) => {
        const field = fieldOf(opened.target);
        if (field) await menuPaste.paste(field, { plain, restore: () => restore(opened) });
    };

    const cut = async (opened: OpenMenu, text: string) => {
        const field = fieldOf(opened.target);
        if (!field) return;
        restore(opened);
        if (!(await editing.copyText(text))) {
            contextMenu.contextMenuNotice(t("selectionMenu.copyFailed"));
            return;
        }
        restore(opened);
        editing.deleteSelection(field);
    };

    const target = menu?.target ?? null;
    const kind = target ? fallbackMenuFor(target) : null;

    return (
        <DropdownMenu open={menu !== null && kind !== null} onOpenChange={(open) => (open ? undefined : setMenu(null))}>
            <DropdownMenuTrigger asChild>
                <span
                    aria-hidden
                    tabIndex={-1}
                    className="pointer-events-none fixed size-0"
                    style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
                />
            </DropdownMenuTrigger>
            {menu && target && kind ? (
                <DropdownMenuContent
                    align="start"
                    sideOffset={2}
                    data-context-menu-fallback={kind}
                    className="max-w-[min(20rem,85vw)]"
                    onCloseAutoFocus={(event) => {
                        // Back to the text, not to the invisible anchor.
                        event.preventDefault();
                        if (fieldOf(target)) restore(menu);
                    }}
                >
                    {target.kind === "field" ? (
                        <FieldItems
                            menu={menu}
                            target={target}
                            menuPaste={menuPaste}
                            onCut={(text) => void cut(menu, text)}
                            onCopy={(text) => void copy(text)}
                            onPaste={(plain) => void paste(menu, plain)}
                        />
                    ) : null}
                    {target.kind === "selection" ? (
                        <>
                            {editing.canEdit(target.found.field) ? (
                                <DropdownMenuItem onSelect={() => void cut(menu, target.found.text)}>
                                    <Scissors />
                                    {t("selectionMenu.cut")}
                                    <MenuShortcut keys="Mod+X" />
                                </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem onSelect={() => void copy(target.found.text)}>
                                <Copy />
                                {t("selectionMenu.copy")}
                                <MenuShortcut keys="Mod+C" />
                            </DropdownMenuItem>
                            {editing.canEdit(target.found.field) ? (
                                <PasteItems menuPaste={menuPaste} rich={false} onPaste={(plain) => void paste(menu, plain)} />
                            ) : null}
                        </>
                    ) : null}
                    {target.kind === "link" || (target.kind === "media" && target.link) ? (
                        <LinkItems
                            link={target.kind === "link" ? target.link : target.link!}
                            onCopy={(text) => void copy(text)}
                        />
                    ) : null}
                    {target.kind === "media" && target.image ? (
                        <>
                            {target.link ? <DropdownMenuSeparator /> : null}
                            {target.image.web ? (
                                <DropdownMenuItem onSelect={() => openLink(target.image!.src)}>
                                    <ImageIcon />
                                    {t("contextMenu.openImage")}
                                </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                                onSelect={async () =>
                                    contextMenu.contextMenuNotice(
                                        (await editing.copyImage(target.image!.src, menu))
                                            ? t("contextMenu.imageCopied")
                                            : t("contextMenu.imageCopyFailed")
                                    )
                                }
                            >
                                <Copy />
                                {t("contextMenu.copyImage")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={async () => {
                                    if (!(await editing.saveImage(target.image!.src))) {
                                        contextMenu.contextMenuNotice(t("contextMenu.imageSaveFailed"));
                                    }
                                }}
                            >
                                <Download />
                                {t("contextMenu.saveImage")}
                            </DropdownMenuItem>
                            {target.image.web ? (
                                <DropdownMenuItem onSelect={() => void copy(target.image!.src)}>
                                    <Link2 />
                                    {t("contextMenu.copyImageAddress")}
                                </DropdownMenuItem>
                            ) : null}
                        </>
                    ) : null}
                </DropdownMenuContent>
            ) : null}
        </DropdownMenu>
    );
}

function spellingOf(
    bridge: NonNullable<NonNullable<ReturnType<typeof desktopBridge>>["editing"]>,
    word: string
): readonly string[] | null {
    try {
        const check = bridge.spelling(word);
        return check.misspelled ? check.suggestions.slice(0, 5) : null;
    } catch {
        return null;
    }
}

function FieldItems({
    menu,
    target,
    menuPaste,
    onCut,
    onCopy,
    onPaste
}: {
    menu: OpenMenu;
    target: Extract<contextMenu.ContextTarget, { kind: "field" }>;
    menuPaste: MenuPaste;
    onCut: (text: string) => void;
    onCopy: (text: string) => void;
    onPaste: (plain: boolean) => void;
}) {
    const t = useTranslations("common");
    const field = target.field;
    const editable = editing.canEdit(field);
    const rich = !editing.isTextField(field);
    const word = target.word;
    const replace = (suggestion: string) => {
        if (!word) return;
        restore(menu);
        editing.selectRange(field, word.start, word.end, word.node ?? null);
        editing.insertText(field, suggestion);
    };
    return (
        <>
            {menu.suggestions && word && editable ? (
                <>
                    {menu.suggestions.length > 0 ? (
                        menu.suggestions.map((suggestion) => (
                            <DropdownMenuItem key={suggestion} onSelect={() => replace(suggestion)}>
                                <SpellCheck />
                                <span className="min-w-0 truncate" title={suggestion}>{suggestion}</span>
                            </DropdownMenuItem>
                        ))
                    ) : (
                        <DropdownMenuLabel className="normal-case tracking-normal">
                            {t("contextMenu.noSuggestions")}
                        </DropdownMenuLabel>
                    )}
                    <DropdownMenuItem
                        onSelect={() => void desktopBridge()?.editing?.addToDictionary(word.text)}
                    >
                        <BookPlus />
                        {t("contextMenu.addToDictionary")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                </>
            ) : null}
            {editable ? (
                <>
                    <DropdownMenuItem onSelect={() => editing.history(field, "undo")}>
                        <Undo2 />
                        {t("contextMenu.undo")}
                        <MenuShortcut keys="Mod+Z" />
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => editing.history(field, "redo")}>
                        <Redo2 />
                        {t("contextMenu.redo")}
                        <MenuShortcut keys="Mod+Shift+Z" />
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                </>
            ) : null}
            {editable && target.selected ? (
                <DropdownMenuItem onSelect={() => onCut(target.selected)}>
                    <Scissors />
                    {t("selectionMenu.cut")}
                    <MenuShortcut keys="Mod+X" />
                </DropdownMenuItem>
            ) : null}
            {target.selected ? (
                <DropdownMenuItem onSelect={() => onCopy(target.selected)}>
                    <Copy />
                    {t("selectionMenu.copy")}
                    <MenuShortcut keys="Mod+C" />
                </DropdownMenuItem>
            ) : null}
            {editable ? <PasteItems menuPaste={menuPaste} rich={rich} onPaste={onPaste} /> : null}
            <DropdownMenuItem onSelect={() => editing.selectAllIn(field)}>
                <TextSelect />
                {t("selectionMenu.selectAll")}
                <MenuShortcut keys="Mod+A" />
            </DropdownMenuItem>
        </>
    );
}

function LinkItems({ link, onCopy }: { link: selectionMenu.LinkAt; onCopy: (text: string) => void }) {
    const t = useTranslations("common");
    return (
        <>
            <DropdownMenuLabel className="truncate normal-case tracking-normal">{link.copyText}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openLink(link.href)}>
                <ExternalLink />
                {desktopBridge() && link.internal ? t("selectionMenu.openNewWindow") : t("selectionMenu.openNewTab", { surface: desktopBridge() ? "app" : "browser" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCopy(link.copyText)}>
                <Link2 />
                {link.href.startsWith("mailto:") ? t("selectionMenu.copyAddress") : t("selectionMenu.copyLink")}
            </DropdownMenuItem>
        </>
    );
}
