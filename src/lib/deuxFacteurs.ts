import { apiFetch } from "@/lib/endpoint";
import { branding } from "@/config/branding";
import { t } from "@/lib/i18n";

/**
 * Second facteur du compte connecté.
 *
 * Tout se décide dans l'instance (`gateway/src/accounts.ts`) : le poste relaie
 * et affiche. Le secret ne transite ici que le temps de l'afficher en QR code ;
 * il n'est ni enregistré sur le poste ni journalisé.
 */

export interface EtatDeuxFacteurs {
  active: boolean;
  /** Imposée par l'instance : elle ne se retire pas depuis l'interface. */
  obligatoire: boolean;
  activeLe?: string;
  codesDeSecoursRestants?: number;
}

async function appeler<T>(chemin: string, corps?: unknown): Promise<T> {
  const res = await apiFetch(chemin, {
    method: corps === undefined ? "GET" : "POST",
    headers: corps === undefined ? undefined : { "Content-Type": "application/json" },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const donnees = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(donnees.error?.message ?? t("L'instance n'a pas répondu."));
  return donnees;
}

export const lireEtat = () => appeler<EtatDeuxFacteurs>("/oxoai/auth/deux-facteurs/etat");

export const preparer = (password: string) =>
  appeler<{ secret: string }>("/oxoai/auth/deux-facteurs/preparer", { password });

export const activer = (code: string) =>
  appeler<{ codesDeSecours: string[] }>("/oxoai/auth/deux-facteurs/activer", { code });

export const desactiver = (password: string, code: string) =>
  appeler<unknown>("/oxoai/auth/deux-facteurs/desactiver", { password, code });

export const regenererCodes = (password: string, code: string) =>
  appeler<{ codesDeSecours: string[] }>("/oxoai/auth/deux-facteurs/codes", { password, code });

/**
 * Adresse `otpauth://` que lisent les applications d'authentification
 * (format « Key Uri » de Google Authenticator, devenu l'usage commun). Le nom
 * affiché dans l'application est celui de la marque, pas un nom en dur.
 */
export function adresseOtpauth(secret: string, email: string): string {
  const emetteur = branding.name;
  const libelle = `${encodeURIComponent(emetteur)}:${encodeURIComponent(email)}`;
  const params = new URLSearchParams({
    secret,
    issuer: emetteur,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${libelle}?${params.toString()}`;
}

/** Le secret par groupes de quatre, pour la saisie à la main. */
export const secretLisible = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();
