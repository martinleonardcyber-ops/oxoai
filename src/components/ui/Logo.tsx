import { Link } from "react-router-dom";
import { branding } from "@/config/branding";
import { cn } from "@/lib/cn";
import { t, tf } from "@/lib/i18n";

/**
 * Logos OxoAI (assets pilotes par branding.ts — rebrander = changer branding.ts).
 * Le mark est la tuile en dégradé d'OxoAI (scripts/marque/oxoai_marque.py) :
 * en couleur, il se lit sur les deux thèmes et n'est donc jamais inversé.
 */

interface LogoMarkProps {
  size?: number;
  className?: string;
  /** Anime doucement l'helice (float + leger balancement). */
  animated?: boolean;
}

/** Mark seul (sans texte) — centre de l'ecran d'accueil, en-tete de marque. */
export function LogoMark({ size = 40, className, animated }: LogoMarkProps) {
  return (
    <img
      src={branding.logo.mark}
      alt={branding.logo.alt}
      width={size}
      height={size}
      draggable={false}
      className={cn(
        "select-none object-contain",
        animated && "animate-logo",
        className,
      )}
      style={{ height: size, width: "auto" }}
    />
  );
}

interface LogoProps {
  /** Hauteur du mark en px. */
  height?: number;
  /** Affiche le mot-repere « OxoAI » a cote du mark. */
  withWordmark?: boolean;
  className?: string;
}

/**
 * Logo complet : mark (helice) bien visible + mot-repere en texte.
 * Composer mark + texte (plutot que le PNG wordmark) garde l'helice lisible
 * meme en petit et rend le nom pilotable depuis branding.ts.
 */
export function Logo({ height = 28, withWordmark = true, className }: LogoProps) {
  if (!withWordmark) return <LogoMark size={height} className={className} />;
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={height} />
      <span className="font-display text-[19px] font-bold leading-none tracking-tight text-foreground">
        {branding.name}
      </span>
    </span>
  );
}

/**
 * Marque cliquable : ramène au Chat, quelle que soit la page.
 * C'est le geste attendu d'un logo d'application ; sans lien, l'utilisateur
 * clique et rien ne se passe.
 */
export function LogoHome({
  height = 28,
  withWordmark = true,
  className,
}: LogoProps) {
  return (
    <Link
      to="/"
      aria-label={tf("{0} — revenir au Chat", branding.name)}
      title={t("Revenir au Chat")}
      /*
        Aucun effet au survol : un logo n'est pas un bouton. Le fond arrondi
        qui apparaissait lui donnait l'air d'une pastille cliquable de plus,
        au milieu d'une barre qui en compte déjà. Il reste un lien — le
        curseur et le libellé le disent — mais il ne s'allume pas.
      */
      className={cn("inline-flex items-center", className)}
    >
      <Logo height={height} withWordmark={withWordmark} />
    </Link>
  );
}

export default Logo;
