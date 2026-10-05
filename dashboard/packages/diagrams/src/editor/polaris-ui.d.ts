/**
 * The part of Polaris's design system (`@polaris/ui`) the editor draws with.
 *
 * That package ships TypeScript source rather than declarations, and compiling
 * it into this package's program would put another package's files under this
 * one's `rootDir`. So the editor declares the surface it relies on here, and the
 * host - which bundles `@polaris/ui` itself - supplies the real components.
 */
declare module "@polaris/ui" {
  import type * as React from "react";

  type Div = React.HTMLAttributes<HTMLDivElement> & {
    [data: `data-${string}`]: unknown;
  };
  type Side = "top" | "right" | "bottom" | "left";
  type Align = "start" | "center" | "end";
  type FocusOutside = (event: Event) => void;

  export const DropdownMenu: React.FC<{
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    modal?: boolean;
    children?: React.ReactNode;
  }>;
  export const DropdownMenuTrigger: React.FC<{
    asChild?: boolean;
    children?: React.ReactNode;
  }>;
  export const DropdownMenuContent: React.FC<
    Div & {
      side?: Side;
      align?: Align;
      sideOffset?: number;
      collisionPadding?: number;
      onCloseAutoFocus?: FocusOutside;
      onEscapeKeyDown?: (event: KeyboardEvent) => void;
    }
  >;
  export const DropdownMenuItem: React.FC<
    Omit<Div, "onSelect"> & {
      disabled?: boolean;
      variant?: "default" | "danger";
      onSelect?: (event: Event) => void;
    }
  >;
  export const DropdownMenuSeparator: React.FC<{ className?: string }>;
  export const MenuShortcut: React.FC<{
    keys?: string;
    children?: React.ReactNode;
    className?: string;
  }>;

  export const Dialog: React.FC<{
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    modal?: boolean;
    children?: React.ReactNode;
  }>;
  export const DialogContent: React.FC<
    Div & {
      showClose?: boolean;
      onOpenAutoFocus?: FocusOutside;
      onCloseAutoFocus?: FocusOutside;
      onInteractOutside?: FocusOutside;
      onEscapeKeyDown?: (event: KeyboardEvent) => void;
    }
  >;
  export const DialogHeader: React.FC<Div>;
  export const DialogTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>>;
}
