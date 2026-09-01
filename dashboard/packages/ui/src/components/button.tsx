/**
 * Button primitive. Variants cover the small set of intents the dashboard needs;
 * `asChild` lets a link or menu item borrow the button's styling via Radix Slot
 * without nesting an extra element.
 *
 * Two things it deliberately does not do. It does not scale on press: a control
 * plane is clicked hundreds of times an hour and a button that shrinks under the
 * cursor turns each one into an animation. And it does not carry a coloured
 * shadow: the glow under a primary button is decoration that says nothing the
 * colour has not already said. What it does carry is a hairline top edge on the
 * filled variants, which is what keeps a solid fill from reading as a flat
 * rectangle pasted onto the surface.
 *
 * The focus ring is the application's one ring, defined in tokens.css - nothing
 * here restates it.
 */

import { cn } from "../lib/cn";
import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium no-underline transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                primary: "border border-white/10 bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
                secondary: "border border-white/[0.06] bg-muted text-foreground hover:bg-card-hover active:bg-card-hover/80",
                outline: "border border-border bg-transparent text-foreground hover:border-border-strong hover:bg-card-hover active:bg-muted",
                ghost: "text-muted-foreground hover:bg-card-hover hover:text-foreground active:bg-muted",
                danger: "border border-white/10 bg-danger text-danger-foreground hover:bg-danger/90 active:bg-danger/80"
            },
            size: {
                xs: "h-6 gap-1 rounded px-1.5 text-xs [&_svg]:size-3.5",
                sm: "h-7 px-2.5 text-[0.8125rem]",
                md: "h-8 px-3 text-[0.8125rem]",
                lg: "h-9 px-4 text-sm",
                icon: "h-8 w-8",
                "icon-sm": "h-7 w-7 rounded",
                "icon-xs": "h-6 w-6 rounded [&_svg]:size-3.5"
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
