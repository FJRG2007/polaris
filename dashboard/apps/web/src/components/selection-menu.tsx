"use client";

/**
 * Polaris's own menu for a right-click on selected text, everywhere in the app.
 *
 * One listener for the whole shell. It steps in only when the click is on a
 * selection (`lib/selection-menu.ts` has the rules), and only when nothing
 * else answered the click first: a row, a file or a message with a menu of its
 * own calls `preventDefault`, and this reads that and stays out of the way.
 * Those menus get "Ask Polar" and "Copy" added at their foot instead, through
 * the menu extras every `ContextMenuContent` reads.
 */

import {
    AppWindow,
    ClipboardPaste,
    Copy,
    Scissors,
    ExternalLink,
    Languages,
    Link2,
    Search,
    TextSelect
} from "lucide-react";
import { useRouter } from "next/navigation";
import { openLink } from "@/lib/open-link";
import { desktopBridge } from "@/lib/desktop-bridge";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
    AppLogo,
    DropdownMenu,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    MenuExtrasProvider,
    MenuShortcut,
    useToast,
    type MenuExtra
} from "@polaris/ui";
import { openSearch } from "@/lib/search/open-search";
import * as selectionMenu from "@/lib/selection-menu";
import * as contextMenu from "@/lib/context-menu/target";
import { canEdit, copyText, deleteSelection, insertText, isTextField } from "@/lib/context-menu/editing";
import { usePolar } from "@/components/polar/polar-panel";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { TextTranslationOffer } from "@/lib/app-extensions/types";
import { TextTranslationProvider, useTextTranslator } from "@/components/text-translation/provider";
import {
    SelectionTranslation,
    type SelectionToTranslate
} from "@/components/text-translation/selection-translation";

type PasteState = "granted" | "prompt" | "denied" | "unsupported";

interface OpenMenu {
    readonly x: number;
    readonly y: number;
    readonly found: selectionMenu.SelectionAt;
    /** What was selected in a text field, to put back before pasting over it. */
    readonly fieldRange: readonly [number, number] | null;
    /** What was selected anywhere else, likewise. */
    readonly range: Range | null;
}

/** Whether this browser will let the page read the clipboard: granted, or it
 *  will ask. Browsers that cannot be asked about it are asked by trying. */
function usePasteState(): PasteState {
    const [state, setState] = useState<PasteState>("unsupported");
    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
            setState("denied");
            return;
        }
        let status: PermissionStatus | null = null;
        const read = () => status && setState(status.state as PasteState);
        navigator.permissions
            ?.query({ name: "clipboard-read" as PermissionName })
            .then((answer) => {
                status = answer;
                read();
                answer.addEventListener("change", read);
            })
            .catch(() => setState("unsupported"));
        return () => status?.removeEventListener("change", read);
    }, []);
    return state;
}

/** Puts back the selection the menu was opened on, in the field or the page. */
function restore(menu: OpenMenu): void {
    const field = menu.found.field;
    if (field) field.focus({ preventScroll: true });
    if (isTextField(field) && menu.fieldRange) {
        field.setSelectionRange(menu.fieldRange[0], menu.fieldRange[1]);
    } else if (menu.range) {
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(menu.range);
    }
}

/** Everything in the field, or in the page's main content or the dialog the
 *  text is in - never the rail and the header with it. */
function selectAll(menu: OpenMenu): void {
    const field = menu.found.field;
    if (isTextField(field)) {
        field.focus({ preventScroll: true });
        field.select();
        return;
    }
    const node = menu.range?.commonAncestorContainer ?? null;
    const around =
        node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
    const scope = field ?? around?.closest("main, [role=dialog]") ?? around;
    const selection = document.getSelection();
    if (!scope || !selection) return;
    if (field) field.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(scope);
    selection.removeAllRanges();
    selection.addRange(range);
}

/**
 * The menu, and the translation the reader's installed apps offer it - null
 * where they have none, and the Translate entries are not drawn.
 */
export function SelectionMenu({
    translator,
    children
}: {
    translator?: TextTranslationOffer | null;
    children: ReactNode;
}) {
    return (
        <TextTranslationProvider offer={translator ?? null}>
            <SelectionMenuFor>{children}</SelectionMenuFor>
        </TextTranslationProvider>
    );
}

function SelectionMenuFor({ children }: { children: ReactNode }) {
    const t = useTranslations("common");
    const toast = useToast();
    const polar = usePolar();
    const paste = usePasteState();
    const translates = useTextTranslator() !== null;
    const [menu, setMenu] = useState<OpenMenu | null>(null);
    /** A right-click on a link with nothing selected under it. */
    const [link, setLink] = useState<
        (selectionMenu.LinkAt & { readonly x: number; readonly y: number }) | null
    >(null);
    const router = useRouter();
    const [translating, setTranslating] = useState<SelectionToTranslate | null>(null);
    const live = useRef({ polar, toast, t, translates });
    live.current = { polar, toast, t, translates };

    useEffect(() => {
        // Captured first, before any menu of the page's own opens, so that menu
        // knows what was selected at the instant of the click.
        const record = (event: MouseEvent) =>
            selectionMenu.recordContextMenu(selectionMenu.selectionAt(event.target, document));
        // Selected text and links, before the root fallback (`lib/context-menu`):
        // this one knows Search, Translate and Polar. A single misspelled word
        // selected in a field is the fallback's, which has the suggestions.
        const onContextMenu: contextMenu.ContextLayer = (event, target) => {
            const keyboard = selectionMenu.fromKeyboard(event);
            if (target.kind === "link") {
                // A link, with nothing selected on it: opening it the way this
                // app opens things and asking Polar about it are one press away.
                // From the keyboard the menu sits under the link.
                const box = keyboard
                    ? (event.target as Element).closest("a")?.getBoundingClientRect()
                    : null;
                setLink({
                    ...target.link,
                    x: box ? box.left : event.clientX,
                    y: box ? box.bottom : event.clientY
                });
                return true;
            }
            if (target.kind !== "selection") return false;
            const found = target.found;
            const point = keyboard
                ? selectionMenu.selectionPoint(found, document)
                : { x: event.clientX, y: event.clientY };
            const field = found.field;
            const selection = document.getSelection();
            setMenu({
                ...point,
                found,
                fieldRange: isTextField(field)
                    ? [field.selectionStart ?? 0, field.selectionEnd ?? 0]
                    : null,
                range:
                    !isTextField(field) && selection && selection.rangeCount > 0
                        ? selection.getRangeAt(0).cloneRange()
                        : null
            });
            return true;
        };
        // Text selected inside a sandboxed frame (a received email): the frame's
        // own owner already checked the sender and moved the point onto this page.
        const onFramed = (event: Event) => {
            const { x, y, text } = (event as CustomEvent<selectionMenu.FramedSelection>).detail;
            setMenu({ x, y, found: { text, field: null }, fieldRange: null, range: null });
        };
        // A link inside such a frame, with nothing selected: checked the same way.
        const onFramedLink = (event: Event) =>
            setLink((event as CustomEvent<selectionMenu.FramedLink>).detail);
        window.addEventListener("contextmenu", record, true);
        const removeLayer = contextMenu.addContextLayer(10, onContextMenu);
        window.addEventListener(selectionMenu.FRAMED_SELECTION_EVENT, onFramed);
        window.addEventListener(selectionMenu.FRAMED_LINK_EVENT, onFramedLink);
        return () => {
            window.removeEventListener("contextmenu", record, true);
            removeLayer();
            window.removeEventListener(selectionMenu.FRAMED_SELECTION_EVENT, onFramed);
            window.removeEventListener(selectionMenu.FRAMED_LINK_EVENT, onFramedLink);
        };
    }, []);

    useEffect(() => {
        contextMenu.setContextMenuNotice((title) => live.current.toast.show({ title }));
        return () => contextMenu.setContextMenuNotice(null);
    }, []);

    const copy = useCallback(async (text: string) => {
        const { toast, t } = live.current;
        if (await copyText(text)) toast.show({ title: t("selectionMenu.copied") });
        else toast.show({ title: t("selectionMenu.copyFailed") });
    }, []);

    // What the page's own right-click menus add at their foot when text was
    // selected under the click.
    const extras = useCallback((): readonly MenuExtra[] => {
        const found = selectionMenu.lastSelection();
        if (!found) return [];
        const { polar, t, translates } = live.current;
        const items: MenuExtra[] = [
            {
                id: "selection-copy",
                label: t("selectionMenu.copySelection"),
                icon: <Copy />,
                onSelect: () => void copy(found.text)
            }
        ];
        if (translates) {
            const at = selectionMenu.selectionPoint(found, document);
            items.push({
                id: "selection-translate",
                label: t("textTranslation.translateSelection"),
                icon: <Languages />,
                onSelect: () => setTranslating({ ...at, text: found.text })
            });
        }
        if (polar.allowed) {
            items.push({
                id: "selection-ask-polar",
                label: t("selectionMenu.askPolarSelection"),
                icon: <AppLogo appId="polar" size={16} />,
                onSelect: () => polar.ask(found.text)
            });
        }
        return items;
    }, [copy]);

    const editable = canEdit(menu?.found.field ?? null);
    const canPaste = paste !== "denied" && editable;

    const cutHere = async () => {
        if (!menu?.found.field) return;
        const opened = menu;
        restore(opened);
        if (!(await copyText(opened.found.text))) {
            toast.show({ title: t("selectionMenu.copyFailed") });
            return;
        }
        restore(opened);
        deleteSelection(opened.found.field!);
    };

    const pasteHere = async () => {
        if (!menu?.found.field) return;
        const opened = menu;
        let text: string;
        try {
            text = await navigator.clipboard.readText();
        } catch {
            toast.show({ title: t("selectionMenu.pasteFailed") });
            return;
        }
        restore(opened);
        insertText(opened.found.field!, text);
    };

    return (
        <MenuExtrasProvider value={extras}>
            {children}
            <DropdownMenu
                open={menu !== null}
                onOpenChange={(open) => (open ? undefined : setMenu(null))}
            >
                <DropdownMenuTrigger asChild>
                    <span
                        aria-hidden
                        tabIndex={-1}
                        data-selection-menu-anchor
                        className="pointer-events-none fixed size-0"
                        style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
                    />
                </DropdownMenuTrigger>
                {menu ? (
                    <DropdownMenuContent
                        align="start"
                        sideOffset={2}
                        data-selection-menu
                        onCloseAutoFocus={(event) => {
                            // Back to the text, not to the invisible anchor.
                            event.preventDefault();
                            if (menu.found.field) restore(menu);
                        }}
                    >
                        {editable ? (
                            <DropdownMenuItem onSelect={() => void cutHere()}>
                                <Scissors />
                                {t("selectionMenu.cut")}
                                <MenuShortcut keys="Mod+X" />
                            </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onSelect={() => void copy(menu.found.text)}>
                            <Copy />
                            {t("selectionMenu.copy")}
                            <MenuShortcut keys="Mod+C" />
                        </DropdownMenuItem>
                        {canPaste ? (
                            <DropdownMenuItem onSelect={() => void pasteHere()}>
                                <ClipboardPaste />
                                {t("selectionMenu.paste")}
                                <MenuShortcut keys="Mod+V" />
                            </DropdownMenuItem>
                        ) : null}
                        {/* Text in a sandboxed frame cannot be reselected from here. */}
                        {menu.range || menu.found.field ? (
                            <DropdownMenuItem onSelect={() => selectAll(menu)}>
                                <TextSelect />
                                {t("selectionMenu.selectAll")}
                                <MenuShortcut keys="Mod+A" />
                            </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => openSearch(null, menu.found.text)}>
                            <Search />
                            {t("selectionMenu.search")}
                        </DropdownMenuItem>
                        {translates ? (
                            <DropdownMenuItem
                                data-selection-translate
                                onSelect={() =>
                                    setTranslating({ x: menu.x, y: menu.y, text: menu.found.text })
                                }
                            >
                                <Languages />
                                {t("textTranslation.translate")}
                            </DropdownMenuItem>
                        ) : null}
                        {polar.allowed ? (
                            <DropdownMenuItem
                                data-selection-ask-polar
                                onSelect={() => polar.ask(menu.found.text)}
                            >
                                <AppLogo appId="polar" size={16} />
                                {t("selectionMenu.askPolar")}
                            </DropdownMenuItem>
                        ) : null}
                    </DropdownMenuContent>
                ) : null}
            </DropdownMenu>
            <DropdownMenu
                open={link !== null}
                onOpenChange={(open) => (open ? undefined : setLink(null))}
            >
                <DropdownMenuTrigger asChild>
                    <span
                        aria-hidden
                        tabIndex={-1}
                        className="pointer-events-none fixed size-0"
                        style={{ left: link?.x ?? 0, top: link?.y ?? 0 }}
                    />
                </DropdownMenuTrigger>
                {link ? (
                    <DropdownMenuContent
                        align="start"
                        sideOffset={2}
                        data-link-menu
                        className="max-w-[min(20rem,85vw)]"
                        onCloseAutoFocus={(event) => event.preventDefault()}
                    >
                        <DropdownMenuLabel className="truncate normal-case tracking-normal">
                            {link.copyText}
                        </DropdownMenuLabel>
                        {link.internal ? (
                            <DropdownMenuItem
                                onSelect={() => {
                                    const url = new URL(link.href);
                                    router.push(`${url.pathname}${url.search}${url.hash}`);
                                }}
                            >
                                <AppWindow />
                                {t("selectionMenu.openLink")}
                            </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                            onSelect={() => void openLink(link.href)}
                        >
                            <ExternalLink />
                            {desktopBridge() && link.internal
                                ? t("selectionMenu.openNewWindow")
                                : t("selectionMenu.openNewTab")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void copy(link.copyText)}>
                            <Link2 />
                            {link.href.startsWith("mailto:")
                                ? t("selectionMenu.copyAddress")
                                : t("selectionMenu.copyLink")}
                        </DropdownMenuItem>
                        {polar.allowed ? (
                            <DropdownMenuItem
                                data-link-ask-polar
                                onSelect={() => polar.ask(link.copyText)}
                            >
                                <AppLogo appId="polar" size={16} />
                                {t("selectionMenu.askPolarLink")}
                            </DropdownMenuItem>
                        ) : null}
                    </DropdownMenuContent>
                ) : null}
            </DropdownMenu>
            <SelectionTranslation selection={translating} onClose={() => setTranslating(null)} />
        </MenuExtrasProvider>
    );
}
