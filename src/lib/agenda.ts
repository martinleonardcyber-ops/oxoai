import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Connecteur agenda, côté interface.
 *
 * L'interface ne parle jamais CalDAV : tout se passe dans l'instance, qui
 * essaie la connexion et découvre les agendas avant d'enregistrer quoi que ce
 * soit, et qui garde le mot de passe chiffré. Ce module n'est qu'un guichet, et
 * il applique une règle simple : le mot de passe part vers l'instance et n'en
 * revient jamais.
 *
 * Aucune adresse de serveur n'est recopiée ici. Les chemins CalDAV changent, et
 * une valeur figée dans le paquet du poste ne se corrigerait qu'en réempaquetant
 * l'application. C'est donc l'instance qui les fournit.
 */

export interface ServeurConnu {
  nom: string;
  /** Adresse utilisable telle quelle. Vide quand elle n'a pas pu être vérifiée. */
  url: string;
  /** Gabarit à compléter, avec `{adresse}`. Vide quand il n'y en a pas. */
  gabarit: string;
  domaines: string[];
  /** Consigne à montrer avant que l'utilisateur ne cherche son mot de passe. */
  conseil: string;
}

export interface Calendrier {
  nom: string;
  url: string;
  couleur: string;
}

export interface EtatAgenda {
  /** Un compte CalDAV est enregistré. */
  configure: boolean;
  /** Un agenda est branché, par CalDAV ou par la connexion Google. */
  branche?: boolean;
  url?: string;
  identifiant?: string;
  /** Horodatage ISO de l'enregistrement. */
  depuis?: string;
  calendriers?: Calendrier[];
  /** Agendas retenus. Vide : tous. */
  retenus?: string[];
  /** Le magasin chiffre-t-il réellement au repos sur cette instance ? */
  chiffrementDonnees: boolean;
  serveurs: ServeurConnu[];
  /** Réglages devinés à partir de l'adresse envoyée en paramètre. */
  suggestion: ServeurConnu | null;
}

/** Ce que le formulaire envoie. Le mot de passe ne repart jamais dans l'autre sens. */
export interface AgendaASoumettre {
  url: string;
  identifiant: string;
  motDePasse: string;
  retenus: string[];
}

export interface Resultat {
  ok: boolean;
  message: string;
  etat?: Omit<EtatAgenda, "serveurs" | "suggestion">;
}

/**
 * État du connecteur, et table des serveurs pour remplir le formulaire.
 * `null` si la passerelle ne répond pas : l'écran le dit plutôt que d'afficher
 * un formulaire qui échouerait à la première touche.
 */
export async function etat(adresse?: string): Promise<EtatAgenda | null> {
  try {
    const requete = adresse ? `?adresse=${encodeURIComponent(adresse)}` : "";
    const res = await apiFetch(`/oxoai/agenda${requete}`);
    if (!res.ok) return null;
    return (await res.json()) as EtatAgenda;
  } catch {
    return null;
  }
}

/**
 * Enregistre un agenda.
 *
 * L'instance essaie la connexion et découvre les calendriers avant d'écrire :
 * un refus n'a donc laissé aucune trace, et le message rendu est celui du
 * serveur CalDAV traduit en français, pas un code d'erreur.
 */
export async function configurer(compte: AgendaASoumettre): Promise<Resultat> {
  try {
    const res = await apiFetch("/oxoai/agenda/configurer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compte),
    });
    const corps = (await res.json().catch(() => ({}))) as Partial<Resultat> & {
      error?: { message?: string };
    };
    if (corps.error?.message) return { ok: false, message: corps.error.message };
    return {
      ok: corps.ok === true,
      message: corps.message ?? tf("La connexion a échoué ({0}).", res.status),
      etat: corps.etat,
    };
  } catch {
    return {
      ok: false,
      message: t("L'instance n'a pas répondu. Vérifiez qu'elle est démarrée, puis recommencez."),
    };
  }
}

/** Retire l'agenda de l'instance. Les agents perdent aussitôt l'accès. */
export async function oublier(): Promise<Resultat> {
  try {
    const res = await apiFetch("/oxoai/agenda/oublier", { method: "POST" });
    const corps = (await res.json().catch(() => ({}))) as Partial<Resultat> & {
      error?: { message?: string };
    };
    if (corps.error?.message) return { ok: false, message: corps.error.message };
    return {
      ok: corps.ok === true,
      message: corps.message ?? tf("Le retrait a échoué ({0}).", res.status),
      etat: corps.etat,
    };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu.") };
  }
}

/**
 * Réglages devinés depuis le domaine de l'adresse, sans appeler l'instance.
 *
 * La table vient de l'instance ; la reconnaissance du domaine se fait ici, à
 * chaque frappe, parce qu'une requête par caractère saisi serait absurde.
 * `null` sur un domaine d'entreprise : c'est le cas ordinaire, et le formulaire
 * laisse alors l'utilisateur saisir son adresse CalDAV.
 */
export function deviner(adresse: string, serveurs: ServeurConnu[]): ServeurConnu | null {
  const brut = adresse.trim().toLowerCase();
  if (!brut.includes("@")) return null;
  const domaine = brut.slice(brut.lastIndexOf("@") + 1);
  if (!domaine) return null;
  return serveurs.find((s) => s.domaines.includes(domaine)) ?? null;
}

/**
 * Adresse CalDAV proposée pour un serveur connu.
 *
 * Chez Google, l'adresse contient l'identifiant de l'agenda, qui est l'adresse
 * de la personne : le gabarit est complété ici. Chaîne vide quand le serveur
 * n'a pas d'adresse vérifiée, auquel cas le formulaire laisse le champ libre
 * plutôt que d'y écrire une valeur dont on n'est pas sûr.
 */
export function adresseProposee(serveur: ServeurConnu, adresse: string): string {
  if (serveur.gabarit && adresse.includes("@")) {
    /*
     * L'adresse entre dans un chemin d'URL : elle est encodée. Le « @ » est
     * ensuite rétabli, parce que c'est la forme que Google publie dans sa
     * documentation et celle que reconnaissent les autres clients CalDAV.
     */
    const propre = encodeURIComponent(adresse.trim()).replace(/%40/g, "@");
    return serveur.gabarit.replace("{adresse}", propre);
  }
  if (serveur.gabarit && !serveur.gabarit.includes("{adresse}")) return serveur.gabarit;
  return serveur.url;
}
