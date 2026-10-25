import { apiFetch } from "./endpoint";
import { locale, t } from "@/lib/i18n";

/**
 * Consommation mesurée par l'instance, côté interface.
 *
 * Les chiffres viennent tous de la passerelle, qui lit les jetons dans la
 * réponse de chaque moteur. Rien ici ne calcule, n'estime ni ne complète :
 * cet écran affichait autrefois des montants inventés, et c'est précisément ce
 * qu'on ne refait pas.
 */

export type Periode = "jour" | "semaine" | "mois" | "tout";

export const PERIODES: { valeur: Periode; nom: string }[] = [
  { valeur: "jour", nom: t("Aujourd'hui") },
  { valeur: "semaine", nom: t("7 jours") },
  { valeur: "mois", nom: t("30 jours") },
  { valeur: "tout", nom: t("Tout") },
];

/** Aucune conversion entre les deux : chaque montant garde la devise de son tarif. */
export type Devise = "EUR" | "USD";

/** Un prix publié par le fournisseur, avec de quoi le citer (gateway/src/prixPublies.ts). */
export interface PrixCite {
  entree: number;
  sortie: number;
  devise: Devise;
  fournisseur: string;
  page: string;
  releveLe: string;
}

export type Cout =
  | { statut: "gratuit" }
  | { statut: "non-renseigne" }
  | {
      statut: "calcule";
      montant: number;
      devise: Devise;
      estime: boolean;
      source: "saisi" | "publie";
      publie?: { fournisseur: string; page: string; releveLe: string };
    };

export interface Compteurs {
  requetes: number;
  entree: number;
  sortie: number;
  raisonnement: number;
  requetesEstimees: number;
}

export interface LigneModele extends Compteurs {
  uid: string;
  /** Son nom, sans l'identifiant de la clé ou du service (absent d'une instance plus ancienne). */
  nom?: string;
  /** Le service qui le sert, tel que nommé dans OxoAI. */
  service?: string;
  backend: string;
  local: boolean;
  cout: Cout;
}

export interface ModeleDistant {
  uid: string;
  nom?: string;
  service?: string;
  backend: string;
  tarif: { entree: number; sortie: number; devise: Devise; depuis: string } | null;
  /** Le prix publié par son fournisseur, appliqué tant qu'aucun tarif n'est saisi. */
  publie: PrixCite | null;
}

export interface Rapport {
  periode: Periode;
  du: string;
  au: string;
  totaux: Compteurs & { couts: { devise: Devise; montant: number }[]; coutEstime: boolean; sansTarif: number };
  modeles: LigneModele[];
  jours: { jour: string; entree: number; sortie: number; requetes: number }[];
  distants: ModeleDistant[];
  tarifsIllisibles: boolean;
  conservationJours: number;
}

export async function lireRapport(periode: Periode): Promise<Rapport | null> {
  try {
    const res = await apiFetch(`/oxoai/usage?periode=${periode}`);
    return res.ok ? ((await res.json()) as Rapport) : null;
  } catch {
    return null;
  }
}

/**
 * Enregistre le tarif d'un modèle distant, par million de jetons, dans sa
 * devise. `null` pour les deux prix retire le tarif.
 */
export async function definirTarif(
  modele: string,
  entree: number | null,
  sortie: number | null,
  devise: Devise = "EUR",
): Promise<{ ok: boolean; raison?: string }> {
  try {
    const res = await apiFetch("/oxoai/usage/tarif", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modele, entree, sortie, devise }),
    });
    const corps = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      raison?: string;
      error?: { message?: string };
    };
    if (res.ok && corps.ok !== false) return { ok: true };
    return { ok: false, raison: corps.raison ?? corps.error?.message ?? t("Tarif refusé.") };
  } catch {
    return { ok: false, raison: t("Instance injoignable.") };
  }
}

/** Nombre de jetons lisible : 1 234 · 12,3 k · 1,2 M. */
export function jetons(n: number): string {
  if (n < 10_000) return n.toLocaleString(locale());
  if (n < 1_000_000) return `${(n / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 })} k`;
  return `${(n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 2 })} M`;
}

/** Montant dans sa devise, avec assez de décimales pour les petites sommes. */
export function montant(valeur: number, devise: Devise = "EUR"): string {
  const decimales = valeur > 0 && valeur < 1 ? 4 : 2;
  return valeur.toLocaleString(locale(), {
    style: "currency",
    currency: devise,
    minimumFractionDigits: 2,
    maximumFractionDigits: decimales,
  });
}

/** Des totaux par devise, sans conversion : « 1,20 $ + 0,30 € ». */
export function montants(couts: { devise: Devise; montant: number }[]): string {
  return couts.map((c) => montant(c.montant, c.devise)).join(" + ");
}
