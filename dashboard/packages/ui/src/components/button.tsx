/**
 * Button primitive. Variants cover the small set of intents the dashboard needs;
 * `asChild` lets a link or menu item borrow the button's styling via Radix Slot
 * without nesting an extra element.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium no-underline transition-[color,background-color,border-color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                primary: "bg-primary text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90 active:bg-primary/80",
                secondary: "bg-muted text-foreground hover:bg-card-hover active:bg-card-hover/80",
                outline: "border border-border bg-transparent hover:border-muted-foreground/40 hover:bg-muted active:bg-muted/70",
                ghost: "hover:bg-muted active:bg-muted/70",
                danger: "bg-danger text-danger-foreground shadow-sm shadow-danger/25 hover:bg-danger/90 active:bg-danger/80"
            },
            size: {
                sm: "h-8 px-3",
                md: "h-9 px-4",
                lg: "h-10 px-6",
                icon: "h-9 w-9"
            }
        },
        defaultVariants: { variant: "primary", size: "md" }
    }
);

export interface ButtonProps
    extends ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "button";
        return (
            <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
        );
    }
);
Button.displayName = "Button";

export { buttonVariants };
