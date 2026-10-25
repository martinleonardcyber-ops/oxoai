/**
 * Instance OxoAI à laquelle ce poste est rattaché.
 *
 * Deux façons d'utiliser le logiciel :
 *
 * - **Poste autonome** : tout tourne sur la machine (modèle local compris).
 * - **Poste rattaché** : la machine se connecte à l'instance de l'entreprise
 *   (cluster, serveur on-premise). Elle n'a alors **aucun modèle à installer** :
 *   données et inférence viennent de l'instance. C'est le mode d'un collègue
 *   invité sur un projet depuis son propre PC.
 *
 * Ce réglage est propre au poste : il n'est jamais synchronisé. Il porte le
 * jeton d'instance quand le poste est rattaché, donc il va au coffre du
 * système (`lib/coffre.ts`), pas dans le stockage du navigateur.
 */

import { branding } from "@/config/branding";
import { ecrireSecret, lireSecret } from "./coffre";
import { t, tf } from "@/lib/i18n";

const KEY = "oxoai:instance";
const LOCAL = "http://localhost:8787";

export interface InstanceConfig {
  /** Adresse de la passerelle : locale, ou celle de l'instance d'entreprise. */
  url: string;
  /** Nom affiché, pour que l'utilisateur sache à quoi il est rattaché. */
  label?: string;
  /** `true` quand le poste dépend d'une instance distante. */
  remote: boolean;
  /**
   * Jeton d'instance. Sans lui, la passerelle refuse tout : elle donne accès
   * aux données de l'entreprise et à l'exécution d'outils.
   * L'application de bureau le récupère seule ; un poste rattaché le reçoit de
   * l'administrateur.
   */
  token?: string;
}

const DEFAULT: InstanceConfig = { url: LOCAL, remote: false };

/**
 * Jeton transmis par l'application de bureau au chargement, le cas échéant.
 *
 * Retenu à la première lecture, et plus jamais relu dans l'adresse. Celle-ci
 * peut changer — une navigation, un paramètre ajouté par un écran — et le
 * jeton disparaîtrait avec elle : toutes les requêtes repartiraient sans
 * autorisation, et l'application se croirait déconnectée. C'est arrivé
 * (0.23.0, voir le commentaire du routeur dans App.tsx) ; la ceinture est ici,
 * les bretelles là-bas.
 */
let jetonDuLanceur: string | undefined;
let jetonLu = false;

function tokenFromLauncher(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (!jetonLu) {
    jetonDuLanceur = new URLSearchParams(window.location.search).get("token") ?? undefined;
    jetonLu = true;
  }
  return jetonDuLanceur;
}

export function instance(): InstanceConfig {
  const launcherToken = tokenFromLauncher();

  // Une adresse imposée à la construction prime (déploiement piloté).
  const forced = import.meta.env.VITE_GATEWAY_URL;
  if (forced) {
    return { url: forced, remote: true, label: t("Instance configurée"), token: launcherToken };
  }

  try {
    const raw = lireSecret(KEY);
    const stored = raw ? (JSON.parse(raw) as InstanceConfig) : DEFAULT;
    /*
     * Le jeton du lanceur ne vaut que pour un poste **autonome**.
     *
     * Sur un poste autonome, la passerelle tourne sur cette machine et
     * l'application lui remet son jeton : rien n'est conservé sur le poste.
     * Sur un poste **rattaché**, le jeton est celui de l'instance de
     * l'entreprise, donné par son administrateur — et le jeton local, s'il
     * existait, désignerait une tout autre passerelle. L'appliquer écrasait le
     * bon : chaque requête partait avec un jeton que l'instance ne connaît
     * pas, et répondait 401.
     */
    if (stored.remote) return stored;
    return launcherToken ? { ...stored, token: launcherToken } : stored;
  } catch {
    return DEFAULT;
  }
}

export function setInstance(config: InstanceConfig): void {
  ecrireSecret(KEY, JSON.stringify(config));
}

export function clearInstance(): void {
  ecrireSecret(KEY, null);
}

/** Le poste a-t-il déjà été configuré ? */
/**
 * L'interface tourne-t-elle dans l'application de bureau ?
 *
 * Sert à choisir quoi dire en cas de panne : un client qui a installé le
 * paquet n'a ni terminal ni dépôt, lui parler de commandes n'aide personne.
 */
export function isDesktopApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    document.documentElement.dataset.desktop === "1" ||
    new URLSearchParams(window.location.search).has("desktop")
  );
}

export function isConfigured(): boolean {
  if (import.meta.env.VITE_GATEWAY_URL) return true;
  return lireSecret(KEY) !== undefined;
}

/** Une adresse qui ne quitte pas la machine : le chiffrement n'y ajoute rien. */
export function estLocale(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Normalise une adresse saisie par l'utilisateur.
 *
 * Sans schéma, on suppose **HTTPS**, et non HTTP. Le champ demande « l'adresse
 * de l'instance » : personne ne tape `https://` à la main, et une adresse
 * complétée en clair envoyait le jeton d'instance et le jeton de séance en
 * clair sur le réseau, à chaque requête, dans l'en-tête `Authorization`.
 * Seule la boucle locale garde HTTP : rien n'y sort de la machine.
 */
export function normaliseUrl(input: string): string {
  const url = input.trim().replace(/\/+$/, "");
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const hote = url.split("/")[0]?.split(":")[0]?.toLowerCase() ?? "";
  const locale = hote === "localhost" || hote === "127.0.0.1" || hote === "::1";
  return `${locale ? "http" : "https"}://${url}`;
}

/** Vérifie qu'une instance répond bien à cette adresse. */
/** Vérifie l'adresse, puis le jeton s'il est fourni. */
export async function probeInstance(
  url: string,
  token?: string,
): Promise<{ ok: boolean; models?: number; reason?: string }> {
  /*
   * Une instance distante en clair est refusée, et non simplement signalée :
   * chaque requête porterait le jeton d'instance et le jeton de séance en
   * clair, lisibles par n'importe qui sur le chemin. Un poste rattaché de
   * cette façon n'est pas « moins sûr », il est ouvert.
   */
  if (/^http:\/\//i.test(url) && !estLocale(url)) {
    return {
      ok: false,
      reason:
        t("Adresse en clair (http). Les jetons d'accès partiraient lisibles sur le réseau : ") +
        t("utilisez https, ou une adresse locale."),
    };
  }
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, reason: tf("L'instance a répondu {0}.", res.status) };
    const payload = (await res.json()) as { modelCount?: number };

    // Une instance protégée n'accepte rien sans jeton : autant le vérifier
    // maintenant plutôt que de laisser le poste échouer plus tard.
    if (token) {
      const check = await fetch(`${url}/oxoai/data`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(6000),
      });
      if (check.status === 401) {
        return { ok: false, reason: t("Jeton d'instance refusé.") };
      }
      if (!check.ok) return { ok: false, reason: tf("L'instance a répondu {0}.", check.status) };
    }

    return { ok: true, models: payload.modelCount ?? 0 };
  } catch {
    return {
      ok: false,
      reason: tf("Aucune instance {0} ne répond à cette adresse.", branding.name),
    };
  }
}
