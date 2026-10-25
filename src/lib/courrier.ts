import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Connecteur courrier, côté interface.
 *
 * L'interface ne parle jamais IMAP : tout se passe dans l'instance, qui essaie
 * la connexion avant d'enregistrer quoi que ce soit et qui garde le mot de
 * passe chiffré. Ce module n'est qu'un guichet, et il applique une règle
 * simple : le mot de passe part vers l'instance et n'en revient jamais.
 *
 * Aucun réglage de fournisseur n'est recopié ici. Les serveurs et les ports
 * changent — un hébergeur renomme un serveur, un autre bascule un port — et
 * une valeur figée dans le paquet du poste ne se corrigerait qu'en
 * réempaquetant l'application. C'est donc l'instance qui les fournit.
 */

export type Chiffrement = "tls" | "starttls";

/** Serveur d'envoi (SMTP). Il se connecte avec les identifiants de la boîte. */
export interface ServeurEnvoi {
  serveur: string;
  port: number;
  chiffrement: Chiffrement;
}

export interface ReglageFournisseur {
  nom: string;
  serveur: string;
  port: number;
  chiffrement: Chiffrement;
  /** Serveur d'envoi du même fournisseur. */
  smtp?: ServeurEnvoi;
  domaines: string[];
  /** Consigne à montrer avant que l'utilisateur ne cherche son mot de passe. */
  conseil: string;
}

export interface EtatCourrier {
  configure: boolean;
  adresse?: string;
  serveur?: string;
  port?: number;
  chiffrement?: Chiffrement;
  /** Horodatage ISO de l'enregistrement. */
  depuis?: string;
  /** Présent quand les agents peuvent envoyer. */
  envoi?: ServeurEnvoi;
  /** Envoi sans carte à chaque mail : au niveau « Tout approuver » et pour un agent autonome. */
  envoiSansAccord?: boolean;
  /** Le magasin chiffre-t-il réellement au repos sur cette instance ? */
  chiffrementDonnees: boolean;
  fournisseurs: ReglageFournisseur[];
  /** Réglages devinés à partir de l'adresse envoyée en paramètre. */
  suggestion: ReglageFournisseur | null;
  /**
   * « Se connecter avec Google / Microsoft » (28/09/2026) : les applications de
   * l'instance qu'on peut reprendre (identifiants seulement), l'adresse de
   * retour à déclarer telle que la passerelle l'enverra, et l'issue du dernier
   * retour par la boucle locale (Gmail). Absent d'une instance plus ancienne.
   */
  oauth?: {
    google: { disponible: boolean; identifiant?: string; source?: "config" | "ecran"; boucle: boolean; retour?: string };
    microsoft: { disponible: boolean; identifiant?: string; annuaire?: string; avecSecret?: boolean; retour?: string };
    attente: boolean;
    issue?: { ok: boolean; message: string; quand: string };
  };
}

/** Ce que le formulaire envoie. Le mot de passe ne repart jamais dans l'autre sens. */
export interface CompteASoumettre {
  serveur: string;
  port: number;
  chiffrement: Chiffrement;
  identifiant: string;
  motDePasse: string;
  adresse: string;
}

export interface Resultat {
  ok: boolean;
  message: string;
  etat?: Omit<EtatCourrier, "fournisseurs" | "suggestion">;
}

/**
 * État du connecteur, et table des fournisseurs pour remplir le formulaire.
 * `null` si la passerelle ne répond pas : l'écran le dit plutôt que d'afficher
 * un formulaire qui échouerait à la première touche.
 */
export async function etat(adresse?: string): Promise<EtatCourrier | null> {
  try {
    const requete = adresse ? `?adresse=${encodeURIComponent(adresse)}` : "";
    const res = await apiFetch(`/oxoai/courrier${requete}`);
    if (!res.ok) return null;
    return (await res.json()) as EtatCourrier;
  } catch {
    return null;
  }
}

/**
 * Enregistre un compte.
 *
 * L'instance essaie la connexion avant d'écrire : un refus n'a donc laissé
 * aucune trace, et le message rendu est celui du serveur de courrier traduit
 * en français, pas un code d'erreur.
 */
export async function configurer(compte: CompteASoumettre): Promise<Resultat> {
  try {
    const res = await apiFetch("/oxoai/courrier/configurer", {
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

/**
 * Active (serveur donné) ou coupe (`null`) l'envoi de mails par les agents.
 * Le mot de passe est celui de la boîte, déjà sur l'instance : il ne repart
 * pas. L'instance essaie le serveur d'envoi avant de le retenir.
 */
export async function reglerEnvoi(smtp: ServeurEnvoi | null): Promise<Resultat> {
  try {
    const res = await apiFetch("/oxoai/courrier/envoi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ smtp }),
    });
    const corps = (await res.json().catch(() => ({}))) as Partial<Resultat> & {
      error?: { message?: string };
    };
    if (corps.error?.message) return { ok: false, message: corps.error.message };
    return {
      ok: corps.ok === true,
      message: corps.message ?? tf("Le réglage a échoué ({0}).", res.status),
      etat: corps.etat,
    };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu.") };
  }
}

/** Demander à chaque envoi (par défaut), ou envoyer sans confirmation là où les règles le permettent. */
export async function reglerConfirmation(sansAccord: boolean): Promise<Resultat> {
  try {
    const res = await apiFetch("/oxoai/courrier/confirmation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sansAccord }),
    });
    const corps = (await res.json().catch(() => ({}))) as Partial<Resultat> & { error?: { message?: string } };
    if (corps.error?.message) return { ok: false, message: corps.error.message };
    return { ok: corps.ok === true, message: corps.message ?? tf("Le réglage a échoué ({0}).", res.status), etat: corps.etat };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu.") };
  }
}

/** Retire le compte de l'instance. Les agents perdent aussitôt l'accès à la boîte. */
export async function oublier(): Promise<Resultat> {
  try {
    const res = await apiFetch("/oxoai/courrier/oublier", { method: "POST" });
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
 * laisse alors l'utilisateur saisir son serveur.
 */
export function deviner(
  adresse: string,
  fournisseurs: ReglageFournisseur[],
): ReglageFournisseur | null {
  const brut = adresse.trim().toLowerCase();
  if (!brut.includes("@")) return null;
  const domaine = brut.slice(brut.lastIndexOf("@") + 1);
  if (!domaine) return null;
  return fournisseurs.find((f) => f.domaines.includes(domaine)) ?? null;
}

/**
 * Lance « Se connecter avec Google / Microsoft ».
 *
 * L'instance rend l'adresse à ouvrir ; c'est le navigateur de la personne qui
 * l'ouvre, et c'est chez son fournisseur, jamais ici, qu'elle saisit son mot
 * de passe. Au retour, l'instance branche la boîte toute seule : cet écran n'a
 * plus qu'à relire son état.
 */
export async function connecterAvec(
  adresse: string,
  reglage:
    | {
        fournisseur: "google" | "microsoft";
        clientId: string;
        clientSecret?: string;
        tenant?: string;
      }
    /** L'application déjà enregistrée sur l'instance (Google : celle de Drive et d'Agenda ; Microsoft : celle de Microsoft 365). */
    | { fournisseur: "google" | "microsoft"; application: "instance" },
): Promise<{ ok: true; url: string; redirection: string } | { ok: false; message: string }> {
  try {
    const res = await apiFetch("/oxoai/courrier/oauth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adresse, reglage }),
    });
    const corps = (await res.json().catch(() => ({}))) as {
      url?: string;
      redirection?: string;
      error?: { message?: string };
    };
    if (!res.ok || !corps.url) {
      return { ok: false, message: corps.error?.message ?? t("L'autorisation n'a pas pu démarrer.") };
    }
    return { ok: true, url: corps.url, redirection: corps.redirection ?? "" };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu.") };
  }
}

/**
 * L'instance est sur une autre machine : l'adresse affichée par le navigateur
 * après l'accord chez Google (http://127.0.0.1:…), collée à l'écran, termine
 * la connexion de la boîte (28/09/2026).
 */
export async function collerRetourCourrier(adresse: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await apiFetch("/oxoai/courrier/oauth/coller", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adresse }),
    });
    const corps = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: { message?: string } };
    return { ok: res.ok && corps.ok !== false, message: corps.message ?? corps.error?.message ?? t("L'instance n'a pas répondu.") };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu.") };
  }
}
