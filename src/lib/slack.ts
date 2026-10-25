import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/**
 * Connecteur Slack, côté interface.
 *
 * Le jeton part vers l'instance et n'en revient jamais : l'instance l'essaie,
 * relit ses autorisations (elle refuse un jeton qui permettrait d'écrire), et le
 * garde chiffré. Ce module n'est qu'un guichet.
 */

export interface EtatSlack {
  configure: boolean;
  espace?: string;
  /** Nom du bot dans Slack, pour « /invite @nom ». */
  application?: string;
  depuis?: string;
  /** Un jeton est enregistré, mais Slack ne l'accepte plus. */
  aReconnecter: boolean;
  /** Autorisations que le manifeste doit demander, fournies par l'instance. */
  portees: string[];
  chiffrementDonnees: boolean;
}

export interface Resultat {
  ok: boolean;
  message: string;
}

export async function etat(): Promise<EtatSlack | null> {
  try {
    const res = await apiFetch("/oxoai/slack");
    if (!res.ok) return null;
    return (await res.json()) as EtatSlack;
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
    return { ok: json.ok === true, message: json.message ?? tf("La demande a échoué ({0}).", res.status) };
  } catch {
    return {
      ok: false,
      message: t("L'instance n'a pas répondu. Vérifiez qu'elle est démarrée, puis recommencez."),
    };
  }
}

/** Essaie puis enregistre le jeton de bot. En cas d'échec, rien n'est gardé. */
export const configurer = (jeton: string) => poster("/oxoai/slack/configurer", { jeton });

/** Efface le jeton de l'instance. Il reste valable chez Slack : l'écran le dit. */
export const oublier = () => poster("/oxoai/slack/oublier");

/**
 * Nom technique du bot, tel que Slack l'accepte dans un manifeste : lettres
 * minuscules sans accent, chiffres, tiret, point et souligné, 80 au plus.
 */
export function nomDeBot(nom: string): string {
  const propre = nom
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return propre || "agents";
}

/**
 * Manifeste de l'application Slack à créer, en JSON, que Slack accepte tel
 * quel dans « Create New App », « From a manifest ». Les autorisations viennent
 * de l'instance ; la distribution publique, la rotation des jetons et le mode
 * socket restent désactivés.
 */
export function manifeste(nom: string, portees: string[]): string {
  return JSON.stringify(
    {
      display_information: {
        name: nom.slice(0, 35),
        description: tf("Lecture seule des salons où l'application est invitée, pour les agents {0}.", nom).slice(0, 140),
      },
      features: { bot_user: { display_name: nomDeBot(nom), always_online: false } },
      oauth_config: { scopes: { bot: portees } },
      settings: {
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}
