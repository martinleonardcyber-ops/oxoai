import { cn } from "@/lib/cn";
import { useUtilisateurCourant } from "@/lib/store/identity";

interface AvatarProps {
  size?: number;
  className?: string;
  /** Avatar d'une autre personne : ses initiales… */
  initials?: string;
  /** …sa photo, si son compte en a une… */
  photo?: string;
  /** …et son nom, lu par les lecteurs d'écran. */
  nom?: string;
}

/**
 * Avatar de l'utilisateur, replié sur ses initiales.
 *
 * Lit l'identité réellement connectée : le produit gère plusieurs comptes sur
 * un même poste, afficher les initiales d'un autre serait trompeur. Et il se
 * redessine quand ce compte change de nom : l'avatar de la barre latérale ne
 * se démonte jamais, il aurait sinon gardé les anciennes initiales.
 */
/**
 * Seule une image intégrée s'affiche (PNG, JPEG, WebP, GIF, en base64) : la
 * photo d'un collègue vient de l'instance, et une adresse web ferait appeler
 * n'importe quel serveur par chaque poste qui l'affiche. L'instance le vérifie
 * déjà à l'enregistrement (`photoValide`, gateway/src/accounts.ts) ; l'écran le
 * revérifie, pour une instance plus ancienne ou modifiée (27/09/2026).
 */
const IMAGE_INTEGREE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const imageSure = (src: string | undefined): string | undefined => (src && IMAGE_INTEGREE.test(src) ? src : undefined);

export function Avatar({ size = 32, className, initials, photo, nom }: AvatarProps) {
  const utilisateur = useUtilisateurCourant();
  // Sans initiales, c'est l'avatar de la personne connectée ; avec, celui d'une autre.
  const autre = initials !== undefined;
  const label = autre ? initials : utilisateur.initials;
  const image = imageSure(autre ? photo : utilisateur.photo);
  const nomLu = autre ? (nom ?? initials) : utilisateur.fullName;
  if (image) {
    return (
      <img
        src={image}
        alt={nomLu}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={cn(
        "fond-marque inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      role="img"
      aria-label={nomLu}
    >
      {label}
    </span>
  );
}

export default Avatar;
