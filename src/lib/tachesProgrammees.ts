import { apiFetch } from "./endpoint";
import { t, tf } from "@/lib/i18n";

/** Les tâches programmées de la personne (gateway/src/tachesProgrammees.ts). */

export type Rythme = { type: "jour" } | { type: "jours-ouvres" } | { type: "semaine"; jour: number } | { type: "mois"; jour: number };

export interface Execution {
  quand: string;
  ok: boolean;
  resultat: string;
  dureeMs: number;
  /** L'agent qui l'a faite, s'il y en avait un. */
  agent?: string;
}

export interface TacheProgrammee {
  id: string;
  titre: string;
  consigne: string;
  rythme: Rythme;
  heure: string;
  outils: boolean;
  /** L'agent personnalisé chargé de la tâche ; sans lui, l'agent du Chat. */
  agentId?: string;
  active: boolean;
  creeLe: string;
  prochaine: string;
  enCours?: boolean;
  executions: Execution[];
}

async function appel<T>(chemin: string, init?: RequestInit): Promise<{ ok: true; valeur: T } | { ok: false; message: string }> {
  try {
    const res = await apiFetch(chemin, init);
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) return { ok: false, message: json.error?.message ?? tf("La demande a échoué ({0}).", res.status) };
    return { ok: true, valeur: json };
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu. Vérifiez qu'elle est démarrée, puis recommencez.") };
  }
}
const json = (corps: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });

/** Ce qu'on envoie : `agentId: null` rend la tâche à l'agent du Chat. */
type Envoi = Partial<Omit<TacheProgrammee, "agentId">> & { agentId?: string | null };

/** Les agents que la personne peut charger d'une tâche, tels que l'instance les voit. */
export interface AgentPossible {
  id: string;
  nom: string;
}
export const listerAgentsPossibles = () => appel<{ agents: AgentPossible[] }>("/oxoai/taches-programmees/agents");

export const listerTaches = () => appel<{ taches: TacheProgrammee[] }>("/oxoai/taches-programmees");
export const creerTache = (x: Envoi) => appel<{ tache: TacheProgrammee }>("/oxoai/taches-programmees", json(x));
export const modifierTache = (id: string, x: Envoi) => appel<{ tache: TacheProgrammee }>(`/oxoai/taches-programmees/${encodeURIComponent(id)}`, json(x));
export const supprimerTache = (id: string) => appel<{ supprimee: null }>(`/oxoai/taches-programmees/${encodeURIComponent(id)}`, { method: "DELETE" });
export const lancerTache = (id: string) => appel<{ execution: Execution }>(`/oxoai/taches-programmees/${encodeURIComponent(id)}/lancer`, json({}));

const JOURS = () => [t("dimanche"), t("lundi"), t("mardi"), t("mercredi"), t("jeudi"), t("vendredi"), t("samedi")];
export const joursSemaine = JOURS;

export function decrireRythme(r: Rythme, heure: string): string {
  const a = heure.replace(":", " h ").replace(/ h 00$/, " h");
  switch (r.type) {
    case "jour":
      return tf("Chaque jour à {0}", a);
    case "jours-ouvres":
      return tf("Du lundi au vendredi à {0}", a);
    case "semaine":
      return tf("Chaque {0} à {1}", JOURS()[r.jour] ?? "", a);
    case "mois":
      return r.jour === -1 ? tf("Le dernier jour de chaque mois à {0}", a) : tf("Le {0} de chaque mois à {1}", String(r.jour), a);
  }
}
