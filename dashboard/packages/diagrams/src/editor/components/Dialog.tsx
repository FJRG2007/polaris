import clsx from "clsx";
import React, { useState } from "react";
import {
  Dialog as PolarisDialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@polaris/ui";
import { useDevice, useDiagramSetAppState } from "./App";
import "./Dialog.scss";
import { isLibraryMenuOpenAtom } from "./LibraryMenu";
import { useSetAtom } from "../editor-jotai";
import { useUIAppState } from "../context/ui-appState";
import { THEME } from "../constants";

export type DialogSize = number | "small" | "regular" | "wide" | undefined;

export interface DialogProps {
  children: React.ReactNode;
  className?: string;
  size?: DialogSize;
  onCloseRequest(): void;
  title: React.ReactNode | false;
  autofocus?: boolean;
  closeOnClickOutside?: boolean;
  /** Read out as the dialog's name when it shows no title of its own. */
  label?: string;
}

function getDialogSize(size: DialogSize): number {
  if (size && typeof size === "number") {
    return size;
  }

  switch (size) {
    case "small":
      return 550;
    case "wide":
      return 1024;
    case "regular":
    default:
      return 800;
  }
}

/**
 * Every dialog the editor opens, drawn as Polaris's own dialog: the same
 * overlay, surface, title, corner close button, focus trap and Escape as the
 * rest of the app.
 *
 * The dialog is portalled to the page body, outside the editor, so its body is
 * wrapped in an editor scope (`polaris-diagram`, plus the theme) for the
 * editor's own controls inside it to keep their styles.
 */
export const Dialog = (props: DialogProps) => {
  const [lastActiveElement] = useState(document.activeElement);
  const isMobile = useDevice().viewport.isMobile;
  const { theme } = useUIAppState();

  const setAppState = useDiagramSetAppState();
  const setIsLibraryMenuOpen = useSetAtom(isLibraryMenuOpenAtom);

  const onClose = () => {
    setAppState({ openMenu: null });
    setIsLibraryMenuOpen(false);
    (lastActiveElement as HTMLElement | null)?.focus?.();
    props.onCloseRequest();
  };

  const width = getDialogSize(props.size);

  return (
    <PolarisDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className={clsx("polaris-diagram-dialog", {
          "polaris-diagram-dialog--fullscreen": isMobile,
        })}
        style={{ maxWidth: `min(${width}px, calc(100vw - 2rem))` }}
        data-prevent-outside-click
        onInteractOutside={
          props.closeOnClickOutside === false
            ? (event) => event.preventDefault()
            : undefined
        }
        onOpenAutoFocus={
          props.autofocus === false
            ? (event) => event.preventDefault()
            : undefined
        }
        // Focus goes back to where it was by `onClose`, not to the body.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div
          className={clsx("polaris-diagram", "polaris-diagram-dialog__scope", {
            "theme--dark": theme === THEME.DARK,
          })}
        >
          <div className={clsx("Dialog", props.className)}>
            {props.title ? (
              <DialogHeader className="Dialog__header">
                <DialogTitle className="Dialog__title">{props.title}</DialogTitle>
              </DialogHeader>
            ) : (
              <DialogTitle className="polaris-diagram-dialog__hidden-title">
                {props.label ?? ""}
              </DialogTitle>
            )}
            <div className="Dialog__content">{props.children}</div>
          </div>
        </div>
      </DialogContent>
    </PolarisDialog>
  );
};
