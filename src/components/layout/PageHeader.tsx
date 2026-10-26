import type { LucideIcon } from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

interface PageHeaderProps {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  showBack?: boolean;
  /** Taille du titre. */
  size?: "md" | "lg";
  className?: string;
}

/** En-tete de page pleine (fleche retour + icone + titre/sous-titre + actions). */
export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
  showBack,
  size = "md",
  className,
}: PageHeaderProps) {
  const navigate = useNavigate();
  return (
    // Les actions passent sous le titre quand la place manque, plutôt que d'écraser le titre en colonne.
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}>
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
        {showBack && (
          <button
            type="button"
            aria-label={t("Retour")}
            onClick={() => navigate(-1)}
            className="mt-1 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft size={20} strokeWidth={1.75} />
          </button>
        )}
        {Icon && (
          <span className="mt-1 grid size-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent ring-1 ring-inset ring-accent/15">
            <Icon size={size === "lg" ? 22 : 20} strokeWidth={1.75} />
          </span>
        )}
        <div className="min-w-0">
          <h1
            className={cn(
              "titre-marque text-foreground",
              size === "lg" ? "text-[44px]" : "text-[38px]",
            )}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export default PageHeader;
