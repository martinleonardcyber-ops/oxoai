import { apiFetch } from "./endpoint";
import { t } from "@/lib/i18n";

/**
 * Clés de fournisseurs de modèles cloud (gateway/src/fournisseurs.ts). La clé
 * part une fois vers l'instance, à l'essai puis à l'ajout, et n'en revient
 * jamais : l'écran n'en voit que les quatre derniers caractères.
 */

export interface Fournisseur {
  id: string;
  nom: string;
  baseUrl: string;
  pays: string;
  cles: string;
  adresseLibre?: boolean;
}

export interface CleModele {
  id: string;
  fournisseur: string;
  nom: string;
  pays: string;
  portee: "moi" | "equipe";
  fin: string;
  modeles: string[];
  estProprietaire: boolean;
  createdAt: string;
}

async function lire<T>(res: Response): Promise<T> {
  const corps = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  return corps;
}

const poster = (chemin: string, corps: unknown) =>
  apiFetch(chemin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });

export async function chargerFournisseurs(): Promise<{ catalogue: Fournisseur[]; cles: CleModele[] }> {
  return lire(await apiFetch("/oxoai/fournisseurs"));
}

export async function essayerCle(fournisseur: string, cle: string, adresse?: string): Promise<string[]> {
  return (await lire<{ modeles: string[] }>(await poster("/oxoai/fournisseurs/essayer", { fournisseur, cle, adresse })))
    .modeles;
}

export async function ajouterCle(donnees: {
  fournisseur: string;
  cle: string;
  adresse?: string;
  nom?: string;
  pays?: string;
  portee: "moi" | "equipe";
  modeles: string[];
}): Promise<CleModele> {
  return (await lire<{ cle: CleModele }>(await poster("/oxoai/fournisseurs", donnees))).cle;
}

export async function modifierCle(id: string, changements: { modeles?: string[]; portee?: "moi" | "equipe" }): Promise<void> {
  await lire(await poster(`/oxoai/fournisseurs/${encodeURIComponent(id)}`, changements));
}

export async function retirerCle(id: string): Promise<void> {
  await lire(await poster(`/oxoai/fournisseurs/${encodeURIComponent(id)}/supprimer`, {}));
}

/*
 * Le pays d'un modèle cloud arrive de l'instance en français (catalogue de
 * gateway/src/fournisseurs.ts, profil de déploiement) : relevé le 27/09/2026,
 * un écran anglais ou chinois affichait « États-Unis », « Chine » ou « Non
 * précisé ». Traduit à l'affichage ; un pays saisi par la personne (fournisseur
 * « compatible ») reste tel qu'elle l'a écrit.
 */
const PAYS: Record<string, string> = {
  France: t("France"),
  Allemagne: t("Allemagne"),
  Belgique: t("Belgique"),
  Suisse: t("Suisse"),
  "Pays-Bas": t("Pays-Bas"),
  Irlande: t("Irlande"),
  Italie: t("Italie"),
  Espagne: t("Espagne"),
  Suède: t("Suède"),
  Finlande: t("Finlande"),
  "Royaume-Uni": t("Royaume-Uni"),
  "États-Unis": t("États-Unis"),
  Chine: t("Chine"),
  "Non précisé": t("Non précisé"),
};

/** Le nom d'un pays venu de l'instance, dans la langue de l'écran. */
export const nomDuPays = (pays: string): string => PAYS[pays] ?? pays;

/** « Cloud · France », « Cloud · États-Unis », ou rien pour un modèle de la machine. */
export function lieuDuModele(m: { origine?: string; pays?: string }): string | null {
  if (m.origine !== "cle" && m.origine !== "agence") return null;
  return m.pays ? `Cloud · ${nomDuPays(m.pays)}` : "Cloud";
}
