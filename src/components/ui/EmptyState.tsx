import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
}

/** Etat vide centre : icone dans un cercle, titre, description. */
export function EmptyState({ icon: Icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="relative mb-2 flex h-16 w-16 items-center justify-center rounded-[20px] bg-card text-accent shadow-lg ring-1 ring-inset ring-border">
        <span aria-hidden className="absolute -inset-6 -z-10 rounded-full bg-[radial-gradient(closest-side,hsl(var(--accent)/0.22),transparent)]" />
        <Icon size={28} strokeWidth={1.5} />
      </span>
      <h2 className="titre-marque text-[28px] text-foreground">{title}</h2>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

export default EmptyState;
