import { ilFaitNuit, prochaineBascule } from "@/lib/soleil";
import { t } from "@/lib/i18n";

/**
 * Apparence de l'application : clair, sombre, ou décidé tout seul.
 *
 * Le réglage est propre au **poste**, pas au compte. Deux raisons : l'écran de
 * connexion s'affiche avant qu'on sache qui est là, et la bonne apparence
 * dépend de la pièce et de l'heure, pas de la personne. Un même collaborateur
 * veut le thème sombre sur son portable le soir et le thème clair sur le poste
 * de l'atelier.
 */

const CLE = "oxoai:apparence";
/** Dernier thème réellement appliqué : sert à peindre juste avant le premier rendu. */
const CLE_RESOLU = "oxoai:apparence-resolue";

export type ModeApparence = "clair" | "sombre" | "soleil" | "systeme";
export type Theme = "clair" | "sombre";

export const MODES: { valeur: ModeApparence; nom: string; detail: string }[] = [
  { valeur: "soleil", nom: t("Au coucher du soleil"), detail: t("Sombre la nuit, clair le jour") },
  { valeur: "clair", nom: t("Clair"), detail: t("Toujours clair") },
  { valeur: "sombre", nom: t("Sombre"), detail: t("Toujours sombre") },
  { valeur: "systeme", nom: t("Réglage du système"), detail: t("Suit l'apparence de l'ordinateur") },
];

export function lireMode(): ModeApparence {
  try {
    const brut = localStorage.getItem(CLE);
    if (brut === "clair" || brut === "sombre" || brut === "soleil" || brut === "systeme") {
      return brut;
    }
  } catch {
    /* stockage indisponible : on retombe sur le défaut */
  }
  return "soleil";
}

export function ecrireMode(mode: ModeApparence): void {
  try {
    localStorage.setItem(CLE, mode);
  } catch {
    /* sans persistance, le choix ne vaut que pour cette fenêtre */
  }
}

function themeDuSysteme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "sombre" : "clair";
  } catch {
    return "clair";
  }
}

/**
 * Thème à appliquer pour un mode donné.
 *
 * Le mode « soleil » se rabat sur le système quand la position est inconnue —
 * fuseau absent de la table, ou latitude polaire où le soleil ne se couche pas.
 * Mieux vaut suivre le système que d'inventer une heure de crépuscule.
 */
export function resoudre(mode: ModeApparence = lireMode()): Theme {
  if (mode === "clair" || mode === "sombre") return mode;
  if (mode === "systeme") return themeDuSysteme();

  const nuit = ilFaitNuit();
  return nuit === null ? themeDuSysteme() : nuit ? "sombre" : "clair";
}

/** Pose le thème sur le document et retient ce qui a été posé. */
export function appliquer(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(CLE_RESOLU, theme);
  } catch {
    /* sans mémoire, le prochain démarrage repartira du calcul */
  }
}

/**
 * Programme le prochain changement et renvoie de quoi l'annuler.
 *
 * En mode « soleil », on vise l'instant exact du lever ou du coucher plutôt que
 * d'interroger l'horloge en boucle. Les autres modes n'ont rien à programmer :
 * le système prévient de lui-même par `matchMedia`.
 */
export function programmer(mode: ModeApparence, quand: () => void): () => void {
  if (mode === "clair" || mode === "sombre") return () => {};

  if (mode === "systeme") {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", quand);
    return () => media.removeEventListener("change", quand);
  }

  const cible = prochaineBascule();
  if (!cible) {
    // Position inconnue : le mode suit alors le système, donc on écoute celui-ci.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", quand);
    return () => media.removeEventListener("change", quand);
  }

  /*
   * `setTimeout` plafonne à ~24,8 jours et, surtout, ne rattrape pas une mise
   * en veille : au réveil, le délai restant est faux. On ne programme donc
   * jamais plus d'une heure à l'avance, quitte à se reprogrammer — le calcul
   * est de toute façon instantané.
   */
  const HEURE = 3_600_000;
  const attente = Math.min(Math.max(cible.getTime() - Date.now(), 1_000), HEURE);
  const minuteur = setTimeout(quand, attente);
  return () => clearTimeout(minuteur);
}
