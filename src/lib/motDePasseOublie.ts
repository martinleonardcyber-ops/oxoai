import { apiFetch } from "@/lib/endpoint";
import { instance } from "@/lib/instance";
import { t } from "@/lib/i18n";

/**
 * Mot de passe oublié (23/10/2026) : les trois voies, côté poste.
 *
 *  1. un administrateur réinitialise le mot de passe d'un collègue : mot de
 *     passe provisoire, tiré par l'instance et montré une fois ;
 *  2. sur la machine de l'instance, l'application de bureau fait reconnaître
 *     la session de l'ordinateur (electron/motDePasseOublie.cjs) ;
 *  3. un code de récupération, gardé par la personne.
 *
 * L'instance décide de tout (gateway/src/accounts.ts) ; ici, on relaie. Rien
 * n'est gardé sur le poste : ni mot de passe, ni code.
 */

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

/* ---- Codes de récupération du compte connecté ---- */

export interface EtatRecuperation {
  restants: number;
  creeLe?: string;
  deuxFacteursActive: boolean;
}

export const lireEtatRecuperation = () => appeler<EtatRecuperation>("/oxoai/auth/codes-recuperation");

export const creerCodesRecuperation = (password: string, code?: string) =>
  appeler<{ codes: string[] }>("/oxoai/auth/codes-recuperation", { password, ...(code ? { code } : {}) });

/* ---- Réinitialisation par un administrateur ---- */

/** Les comptes qui administrent aussi l'instance : l'écran ne les propose pas. */
export const comptesAdministrateurs = () =>
  appeler<{ administrateurs: string[] }>("/oxoai/auth/reinitialiser").then((r) => r.administrateurs ?? []);

export const reinitialiserCollegue = (demande: {
  accountId: string;
  password: string;
  code?: string;
  retirerDeuxFacteurs: boolean;
}) => appeler<{ provisoire: string; expire: string; deuxFacteursRetire: boolean }>("/oxoai/auth/reinitialiser", demande);

/* ---- La machine de l'instance (application de bureau) ---- */

interface PontMotDePasseOublie {
  etat: () => Promise<{ disponible: boolean; moyen?: "systeme" | "fichier" }>;
  ecrireCode: (demande: { accountId: string; email: string; pour?: "repartir" }) => Promise<{ ok: boolean; fichier?: string; raison?: string }>;
  redefinir: (demande: {
    accountId: string;
    email: string;
    motDePasse: string;
    retirerDeuxFacteurs: boolean;
    code?: string;
  }) => Promise<{ ok: boolean; raison?: string }>;
  apercuRepartir?: () => Promise<{ disponible: boolean; moyen?: "systeme" | "fichier"; mot?: string; dossiers?: string[] }>;
  repartir?: (demande: { mot: string; code?: string }) => Promise<{ ok: boolean; raison?: string; dossiers?: string[] }>;
  bilanRepartir?: () => Promise<{ etat: "fait" | "echec"; dossiers: string[]; erreur?: string } | null>;
  oublierBilanRepartir?: () => Promise<boolean>;
}

/* ---- Repartir de zéro sur cet ordinateur (electron/repartirDeZero.cjs) ---- */

export interface ApercuRepartir {
  moyen: "systeme" | "fichier";
  /** Le mot à taper, dans la langue de l'écran (donné par le processus principal, qui le vérifie). */
  mot: string;
  /** Les noms exacts sous lesquels les dossiers actuels seront mis de côté. */
  dossiers: string[];
}

export async function apercuRepartir(): Promise<ApercuRepartir | null> {
  const p = pont();
  if (!p?.apercuRepartir || instance().remote) return null;
  try {
    const r = await p.apercuRepartir();
    return r.disponible && r.moyen && r.mot ? { moyen: r.moyen, mot: r.mot, dossiers: r.dossiers ?? [] } : null;
  } catch {
    return null;
  }
}

/** Code du fichier pour repartir de zéro (Windows, Linux). */
export async function ecrireCodeRepartir(): Promise<string> {
  const p = pont();
  if (!p) throw new Error(t("Cette voie n'existe que dans l'application, sur l'ordinateur qui fait tourner l'instance."));
  const r = await p.ecrireCode({ accountId: "", email: "", pour: "repartir" });
  if (!r.ok || !r.fichier) throw new Error(t("Le fichier du code n'a pas pu être écrit."));
  return r.fichier;
}

/** Met les données de côté et relance l'application. Lève une erreur lisible en cas de refus. */
export async function repartirDeZero(mot: string, code?: string): Promise<string[]> {
  const p = pont();
  if (!p?.repartir) throw new Error(t("Cette voie n'existe que dans l'application, sur l'ordinateur qui fait tourner l'instance."));
  const r = await p.repartir({ mot, ...(code ? { code } : {}) });
  if (r.ok) return r.dossiers ?? [];
  const messages: Record<string, string> = {
    mot: t("Ce n'est pas le mot demandé : rien n'a été changé."),
    refuse: t("L'ordinateur ne vous a pas reconnu : rien n'a été changé."),
    code: t("Ce n'est pas le code du fichier. Vérifiez-le et réessayez."),
    expire: t("Ce code ne vaut plus : écrivez-en un nouveau."),
    fichier: t("La demande n'a pas pu être enregistrée : rien n'a été changé."),
  };
  throw new Error(messages[r.raison ?? ""] ?? t("Cette voie n'existe que dans l'application, sur l'ordinateur qui fait tourner l'instance."));
}

/** Après un départ : les anciens dossiers, ou l'échec (rien n'a bougé). */
export async function bilanRepartir(): Promise<{ etat: "fait" | "echec"; dossiers: string[]; erreur?: string } | null> {
  try {
    return (await pont()?.bilanRepartir?.()) ?? null;
  } catch {
    return null;
  }
}

export async function oublierBilanRepartir(): Promise<void> {
  try {
    await pont()?.oublierBilanRepartir?.();
  } catch {
    /* rien à oublier */
  }
}

const pont = (): PontMotDePasseOublie | undefined =>
  (window as unknown as { oxoai?: { motDePasseOublie?: PontMotDePasseOublie } }).oxoai?.motDePasseOublie;

/**
 * La reconnaissance par l'ordinateur est-elle possible ici ? Seulement dans
 * l'application de bureau, sur un poste qui fait tourner l'instance (pas un
 * poste rattaché, pas un navigateur). Le processus principal le vérifie aussi.
 */
export async function reconnaissanceLocale(): Promise<"systeme" | "fichier" | null> {
  const p = pont();
  if (!p || instance().remote) return null;
  try {
    const e = await p.etat();
    return e.disponible && e.moyen ? e.moyen : null;
  } catch {
    return null;
  }
}

export async function ecrireCodeLocal(accountId: string, email: string): Promise<string> {
  const p = pont();
  if (!p) throw new Error(t("Cette voie n'existe que dans l'application, sur l'ordinateur qui fait tourner l'instance."));
  const r = await p.ecrireCode({ accountId, email });
  if (!r.ok || !r.fichier) throw new Error(t("Le fichier du code n'a pas pu être écrit."));
  return r.fichier;
}

/** Redéfinit le mot de passe par la machine de l'instance. Lève une erreur lisible en cas de refus. */
export async function redefinirLocalement(demande: {
  accountId: string;
  email: string;
  motDePasse: string;
  retirerDeuxFacteurs: boolean;
  code?: string;
}): Promise<void> {
  const p = pont();
  if (!p) throw new Error(t("Cette voie n'existe que dans l'application, sur l'ordinateur qui fait tourner l'instance."));
  const r = await p.redefinir(demande);
  if (r.ok) return;
  const messages: Record<string, string> = {
    indisponible: t("Cette voie n'existe que dans l'application, sur l'ordinateur qui fait tourner l'instance."),
    refuse: t("L'ordinateur ne vous a pas reconnu : rien n'a été changé."),
    code: t("Ce n'est pas le code du fichier. Vérifiez-le et réessayez."),
    expire: t("Ce code ne vaut plus : écrivez-en un nouveau."),
    passerelle: t("L'instance n'a pas répondu : rien n'a été changé. Réessayez dans un instant."),
  };
  throw new Error(messages[r.raison ?? ""] ?? r.raison ?? t("L'instance n'a pas répondu."));
}
