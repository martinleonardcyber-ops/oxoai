import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Largeur max du panneau. */
  size?: "sm" | "md" | "lg" | "xl";
  /** Masque le bouton de fermeture par defaut. */
  hideClose?: boolean;
  className?: string;
}

const sizeClass = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
};

/** Fenetre modale centree, fermeture au clic sur le fond, Echap et bouton X. */
export function Modal({
  open,
  onClose,
  children,
  size = "md",
  hideClose,
  className,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  /*
   * Le voile passe par le token `overlay` et non par un neutre : l'echelle de
   * neutres se retourne en theme sombre, le fond de modale y serait devenu un
   * voile clair — l'inverse de ce qu'un voile doit faire.
   */
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/45 p-4 backdrop-blur-[3px] animate-[popover-center_120ms_ease-out]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        // Plus haute que la fenêtre, elle défile : sinon ses boutons du bas deviennent inaccessibles.
        className={cn(
          "relative max-h-[calc(100vh-2rem)] w-full overflow-y-auto rounded-3xl border border-border bg-popover p-6 text-popover-foreground shadow-pop",
          sizeClass[size],
          className,
        )}
      >
        {!hideClose && (
          <button
            type="button"
            aria-label={t("Fermer")}
            onClick={onClose}
            className="absolute end-4 top-4 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export default Modal;
