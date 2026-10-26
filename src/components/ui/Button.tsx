import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  block?: boolean;
}

const variantClass: Record<Variant, string> = {
  primary: "fond-marque",
  secondary: "border border-border bg-card text-foreground hover:bg-muted",
  ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
  destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
};

const sizeClass: Record<Size, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

/** Bouton pilule (variantes primaire / secondaire / ghost / destructive). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", icon: Icon, block, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded-full font-medium transition-[color,background-color,box-shadow,filter]",
        // Un bouton desactive doit se voir : sans cela il garde l'aspect d'un
        // bouton actif, et l'utilisateur clique en boucle sans rien obtenir.
        "disabled:cursor-not-allowed disabled:opacity-45",
        variantClass[variant],
        sizeClass[size],
        block && "w-full",
        className,
      )}
      {...props}
    >
      {Icon && <Icon size={size === "sm" ? 15 : 17} strokeWidth={1.75} />}
      {children}
    </button>
  );
});

export default Button;
