/**
 * Client de Codex dans l'écran Code (gateway/src/codex.ts, 27/09/2026).
 *
 * Codex tourne sur ce poste, avec le compte ChatGPT de la personne : l'écran
 * ne fait que demander à la passerelle, qui décide si Codex est proposé
 * (propriétaire du poste seulement), avec quel bac à sable, et qui lance le
 * programme. Rien ici n'a d'autorité : un poste qui appellerait ces routes en
 * direct rencontrerait les mêmes barrières.
 */
import { apiFetch } from "@/lib/endpoint";
import { t, tf } from "@/lib/i18n";
import type { CodeEvent } from "@/lib/code";

export interface EtatCodex {
  /** La passerelle propose-t-elle Codex à cette personne, sur ce poste ? */
  propose: boolean;
  refus?: { code: string; message: string };
  installe: boolean;
  chemin?: string;
  version?: string;
  connecte: boolean;
  /** Par ChatGPT (l'abonnement), par une clé d'API, ou autre, selon `codex login status`. */
  mode?: "chatgpt" | "cle" | "autre";
  detail?: string;
  connexionEnCours: boolean;
  tacheEnCours: boolean;
  niveau: "tout" | "modifications" | "chaque";
  /** Bac à sable que recevrait Codex au niveau d'approbation actuel ; `null` : pas proposé à ce niveau. */
  bac: "read-only" | "workspace-write" | null;
  installation: { commandes: string[]; source: string };
}

/** Évènements d'une tâche : ceux de l'écran Code, plus ce qui n'appartient qu'à Codex. */
export type EvenementCodex =
  | Extract<CodeEvent, { kind: "etape" | "reasoning" | "text" | "tool_start" | "tool_end" | "statut" | "error" | "fin" | "done" }>
  | { kind: "debut"; bac: "read-only" | "workspace-write"; dossier: string; reprise: boolean }
  | { kind: "session"; id: string }
  | { kind: "usage"; entree: number; sortie: number; cache: number; raisonnement: number };

const messageDe = async (res: Response, repli: string): Promise<string> => {
  const corps = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return corps.error?.message ?? repli;
};

export async function lireEtatCodex(relire = false): Promise<EtatCodex> {
  const res = await apiFetch(`/oxoai/codex${relire ? "?relire=1" : ""}`);
  if (!res.ok) throw new Error(await messageDe(res, tf("Codex indisponible ({0}).", res.status)));
  return res.json();
}

/** Lance `codex login` sur ce poste : le navigateur s'ouvre chez OpenAI. Rend le refus, ou null. */
export async function connecterCodex(): Promise<string | null> {
  const res = await apiFetch(`/oxoai/codex/connexion`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return res.ok ? null : messageDe(res, tf("Demande refusée ({0}).", res.status));
}

export async function annulerConnexionCodex(): Promise<void> {
  await apiFetch(`/oxoai/codex/connexion/annuler`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
}

/** Demande l'arrêt de la tâche en cours. `false` si l'instance ne l'a pas confirmé. */
export async function arreterTacheCodex(): Promise<boolean> {
  try {
    const res = await apiFetch(`/oxoai/codex/arreter`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Envoie une demande à Codex et suit sa réponse, servie en flux par la
 * requête elle-même (comme la préparation de l'atelier) : les jetons restent
 * en en-têtes, jamais dans une adresse.
 */
export async function lancerTacheCodex(
  texte: string,
  options: { dossier?: string; session?: string },
  surEvenement: (e: EvenementCodex) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await apiFetch(`/oxoai/codex/tache`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texte, dossier: options.dossier, session: options.session }),
    signal,
  });
  if (!res.ok) throw new Error(await messageDe(res, tf("Demande refusée ({0}).", res.status)));
  if (!res.body) throw new Error(t("La passerelle n'a envoyé aucun flux."));
  const lecteur = res.body.getReader();
  const decodeur = new TextDecoder();
  let tampon = "";
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    tampon += decodeur.decode(value, { stream: true });
    const blocs = tampon.split("\n\n");
    tampon = blocs.pop() ?? "";
    for (const bloc of blocs) {
      for (const ligne of bloc.split("\n")) {
        if (!ligne.startsWith("data:")) continue;
        try {
          surEvenement(JSON.parse(ligne.slice(5).trim()) as EvenementCodex);
        } catch {
          /* fragment illisible : le suivant fera foi */
        }
      }
    }
  }
}

/* Le moteur choisi pour l'écran Code, retenu sur ce poste seulement. */
export type MoteurCode = "opencode" | "codex";
const CLE_MOTEUR = "oxoai.code.moteur";

export function moteurRetenu(): MoteurCode {
  try {
    return localStorage.getItem(CLE_MOTEUR) === "codex" ? "codex" : "opencode";
  } catch {
    return "opencode";
  }
}

export function retenirMoteur(m: MoteurCode): void {
  try {
    localStorage.setItem(CLE_MOTEUR, m);
  } catch {
    /* stockage refusé : le choix vaut le temps de l'écran */
  }
}
