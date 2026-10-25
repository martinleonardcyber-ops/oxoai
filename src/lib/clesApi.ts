import { apiFetch } from "./endpoint";
import { t } from "@/lib/i18n";

/**
 * Clés d'API personnelles (gateway/src/clesApi.ts). La clé n'arrive à l'écran
 * qu'une fois, dans la réponse à sa création ; l'instance n'en garde qu'une
 * empreinte, et la liste n'en montre que les quatre derniers caractères.
 */

export interface CleApi {
  id: string;
  nom: string;
  fin: string;
  portee: "modeles";
  creee: string;
  derniereUtilisation: string | null;
  expire: string | null;
  expiree: boolean;
}

export interface AdressesApi {
  /** Sur la machine de l'instance. */
  locale: string;
  /** Depuis une autre machine : vide tant que l'instance n'est pas ouverte aux collègues. */
  reseau: { url: string; genre: "local" | "prive" }[];
  /** L'instance chiffre (ouverte au réseau) : certificat qu'elle a signé elle-même. */
  chiffre: boolean;
}

export interface EtatClesApi {
  cles: CleApi[];
  limite: number;
  parMinute: number;
  adresses: AdressesApi;
}

/** Durées proposées, en jours ; `null` : sans expiration. */
export const DUREES: (number | null)[] = [30, 90, 365, null];

async function lire<T>(res: Response): Promise<T> {
  const corps = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  return corps;
}

const poster = (chemin: string, corps: unknown) =>
  apiFetch(chemin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });

export async function chargerClesApi(): Promise<EtatClesApi> {
  return lire(await apiFetch("/oxoai/cles-api"));
}

/** Rend la clé en clair : c'est la seule fois qu'elle existe hors du programme qui la recevra. */
export async function creerCleApi(nom: string, jours: number | null, motDePasse: string, code?: string): Promise<{ cle: CleApi; secret: string }> {
  return lire(await poster("/oxoai/cles-api", { nom, jours, motDePasse, ...(code ? { code } : {}) }));
}

export async function renommerCleApi(id: string, nom: string): Promise<CleApi> {
  return (await lire<{ cle: CleApi }>(await poster(`/oxoai/cles-api/${encodeURIComponent(id)}`, { nom }))).cle;
}

export async function revoquerCleApi(id: string): Promise<void> {
  await lire(await poster(`/oxoai/cles-api/${encodeURIComponent(id)}/revoquer`, {}));
}
