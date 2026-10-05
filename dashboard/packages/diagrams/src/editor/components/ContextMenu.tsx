import React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MenuShortcut,
} from "@polaris/ui";
import type { TranslationKeys } from "../i18n";
import { t } from "../i18n";

import type { ShortcutName } from "../actions/shortcuts";
import { getShortcutFromShortcutName } from "../actions/shortcuts";
import type { Action } from "../actions/types";
import type { ActionManager } from "../actions/manager";
import { useDiagramAppState, useDiagramElements } from "./App";
import { checkIcon } from "./icons";

import "./ContextMenu.scss";

export type ContextMenuItem = typeof CONTEXT_MENU_SEPARATOR | Action;

export type ContextMenuItems = (ContextMenuItem | false | null | undefined)[];

type ContextMenuProps = {
  actionManager: ActionManager;
  items: ContextMenuItems;
  /** Where the press was, relative to the editor's own box. */
  top: number;
  left: number;
  onClose: (callback?: () => void) => void;
};

export const CONTEXT_MENU_SEPARATOR = "separator";

/**
 * The right-click menu, drawn with Polaris's own menu rather than the editor's.
 *
 * The menu opens at a point rather than under a button, so the trigger is an
 * empty box pinned where the press was; the menu itself then flips and shifts
 * to stay on screen and scrolls when it is taller than the space left, the same
 * as every other menu in the app.
 */
export const ContextMenu = React.memo(
  ({ actionManager, items, top, left, onClose }: ContextMenuProps) => {
    const appState = useDiagramAppState();
    const elements = useDiagramElements();

    const filteredItems = items.reduce((acc: ContextMenuItem[], item) => {
      if (
        item &&
        (item === CONTEXT_MENU_SEPARATOR ||
          !item.predicate ||
          item.predicate(
            elements,
            appState,
            actionManager.app.props,
            actionManager.app,
          ))
      ) {
        acc.push(item);
      }
      return acc;
    }, []);

    return (
      <DropdownMenu
        open
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            style={{
              position: "fixed",
              top: appState.offsetTop + top,
              left: appState.offsetLeft + left,
              width: 0,
              height: 0,
              pointerEvents: "none",
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={2}
          className="polaris-diagram-context-menu"
          data-testid="context-menu"
          onContextMenu={(event) => event.preventDefault()}
          // The canvas takes the focus back itself once the menu is gone.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {filteredItems.map((item, idx) => {
            if (item === CONTEXT_MENU_SEPARATOR) {
              const previous = filteredItems[idx - 1];
              if (
                !previous ||
                previous === CONTEXT_MENU_SEPARATOR ||
                idx === filteredItems.length - 1
              ) {
                return null;
              }
              return <DropdownMenuSeparator key={idx} />;
            }

            const actionName = item.name;
            let label = "";
            if (item.label) {
              if (typeof item.label === "function") {
                label = t(
                  item.label(
                    elements,
                    appState,
                    actionManager.app,
                  ) as unknown as TranslationKeys,
                );
              } else {
                label = t(item.label as unknown as TranslationKeys);
              }
            }
            const shortcut = actionName
              ? getShortcutFromShortcutName(actionName as ShortcutName)
              : "";
            const checked = item.checked?.(appState) ?? false;

            return (
              <DropdownMenuItem
                key={idx}
                data-testid={actionName}
                variant={
                  actionName === "deleteSelectedElements" ? "danger" : "default"
                }
                onSelect={() => {
                  // State has to settle before the action runs, in case the
                  // action reads the appState it is handed (which still holds
                  // the open menu) to work out the next one.
                  onClose(() => {
                    actionManager.executeAction(item, "contextMenu");
                  });
                }}
              >
                <span
                  className="polaris-diagram-context-menu__check"
                  aria-hidden
                >
                  {checked ? checkIcon : null}
                </span>
                <span className="polaris-diagram-context-menu__label" title={label}>{label}</span>
                {shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
);
