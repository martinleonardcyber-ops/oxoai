import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Connecteur Google Drive, côté interface.
 *
 * L'interface ne parle jamais à Google : c'est l'instance qui ouvre la boucle
 * locale, échange le code, vérifie la portée accordée et garde le jeton
 * chiffré. Ce module n'est qu'un guichet, et il applique une règle simple :
 * aucun jeton ne passe par lui, dans un sens ou dans l'autre. Le seul élément
 * sensible qu'il voit est l'adresse d'autorisation, qu'il ouvre dans le
 * navigateur de la personne, et qui n'arrive que par une route à séance.
 */

export interface EtatDrive {
  /** Le client OAuth Google de l'entreprise est-il renseigné sur l'instance ? */
  disponible: boolean;
  manque?: "identifiant" | "identifiant-invalide";
  /** Un compte est branché et utilisable. */
  configure: boolean;
  compte?: string;
  nom?: string;
  depuis?: string;
  /** Un compte est enregistré, mais Google ne l'accepte plus. */
  aReconnecter: boolean;
  /** Une autorisation attend la réponse de Google. */
  attente: boolean;
  issue?: { ok: boolean; message: string; quand: string };
  portee: string;
  chiffrementDonnees: boolean;
}

export interface Resultat {
  ok: boolean;
  message: string;
  /** Adresse de consentement Google, rendue par `connecter`. */
  url?: string;
}

/** `null` si la passerelle ne répond pas : l'écran le dit. */
export async function etat(): Promise<EtatDrive | null> {
  try {
    const res = await apiFetch("/oxoai/drive");
    if (!res.ok) return null;
    return (await res.json()) as EtatDrive;
  } catch {
    return null;
  }
}

async function poster(chemin: string, corps?: unknown): Promise<Resultat> {
  try {
    const res = await apiFetch(chemin, {
      method: "POST",
      ...(corps !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) }
        : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<Resultat> & {
      error?: { message?: string };
    };
    if (json.error?.message) return { ok: false, message: json.error.message };
    return {
      ok: json.ok === true,
      message: json.message ?? tf("La demande a échoué ({0}).", res.status),
      url: typeof json.url === "string" ? json.url : undefined,
    };
  } catch {
    return {
      ok: false,
      message: t("L'instance n'a pas répondu. Vérifiez qu'elle est démarrée, puis recommencez."),
    };
  }
}

/** Lance l'autorisation : l'instance rend l'adresse de consentement de Google. */
export const connecter = () => poster("/oxoai/drive/connecter");

/** Achève une autorisation dont la redirection n'a pas atteint l'instance. */
export const collerAdresse = (adresse: string) => poster("/oxoai/drive/code", { adresse });

/** Débranche le Drive, et révoque l'accès chez Google. */
export const oublier = () => poster("/oxoai/drive/oublier");
