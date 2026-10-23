import { streamChat } from "./gateway";
import { getTask, updateTask, type Task, type TaskToolTrace } from "./store/tasks";
import { buildSystemPrompt, loadProfile } from "./store/profile";
import { currentUser } from "./store/identity";
import { getAgent, DEFAULT_AGENT, instructionsPourLeChat, type Agent } from "./store/agents";
import { branding } from "@/config/branding";
import { t, tf } from "@/lib/i18n";

/**
 * Exécution d'une tâche par un agent.
 *
 * C'est le même runtime que le Chat : même passerelle, même boucle d'outils.
 * Seule la surface change — ici, l'avancement s'écrit dans la carte.
 */

export interface RunHandlers {
  /** Émis dès que la carte passe « en cours », avant tout échange réseau. */
  onStart?: () => void;
  onProgress?: (partial: string) => void;
  onTool?: (trace: TaskToolTrace) => void;
  onDone?: (task: Task) => void;
}

/** Construit la consigne envoyée à l'agent à partir de la carte. */
/** Ce qu'une tâche précédente de la chaîne transmet : son compte rendu, borné. */
const RESULTAT_TRANSMIS_MAX = 6000;

function buildInstruction(task: Task): string {
  const parts = [tf("Tâche à réaliser : {0}", task.title)];
  if (task.description.trim()) {
    parts.push(tf("Détails :\n{0}", task.description.trim()));
  }
  /*
   * Une tâche qui en suit d'autres reçoit ce qu'elles ont produit. Sans cela,
   * « Rédiger le devis » après « Relever les besoins du client » repartirait
   * de zéro : l'ordre des cartes ne servirait qu'à l'affichage.
   */
  const precedentes = (task.dependsOn ?? [])
    .map((id) => getTask(id))
    .filter((t): t is Task => Boolean(t && t.status === "terminee"));
  if (precedentes.length > 0) {
    parts.push(
      t("Cette tâche fait suite à d'autres, déjà terminées. Voici ce qu'elles ont produit ; appuie-toi dessus, ") +
        "sans refaire leur travail :\n\n" +
        precedentes
          .map((tache) => {
            const r = (tache.result ?? "").trim() || t("(pas de compte rendu)");
            return `--- « ${tache.title} » ---\n${r.length > RESULTAT_TRANSMIS_MAX ? tf("{0}\n[…compte rendu coupé]", r.slice(0, RESULTAT_TRANSMIS_MAX)) : r}`;
          })
          .join("\n\n"),
    );
  }
  parts.push(
    t("Réalise cette tâche maintenant. Si tu disposes d'outils, utilise-les pour agir ") +
      t("réellement plutôt que de décrire ce qu'il faudrait faire. ") +
      t("Termine par un compte rendu court de ce que tu as fait."),
  );
  return parts.join("\n\n");
}

export async function runTask(
  task: Task,
  options: { modelUid?: string; signal?: AbortSignal } = {},
  handlers: RunHandlers = {},
): Promise<Task> {
  const agent: Agent = (task.agentId ? getAgent(task.agentId) : undefined) ?? DEFAULT_AGENT;
  const profile = loadProfile(currentUser().id);
  const systemPrompt = buildSystemPrompt(profile, branding.name, instructionsPourLeChat(agent));

  updateTask(task.id, {
    status: "en-cours",
    startedAt: new Date().toISOString(),
    error: undefined,
    result: undefined,
    toolLog: [],
  });
  // La carte doit migrer de colonne immédiatement, sans attendre le premier
  // fragment de réponse (un modèle à raisonnement peut réfléchir longtemps).
  handlers.onStart?.();

  let content = "";
  const toolLog: TaskToolTrace[] = [];
  /*
   * Erreur signalée par la passerelle au milieu du flux. Elle était levée
   * depuis `onEvent`, mais `streamChat` avale toute exception de lecture d'un
   * fragment (« fragment non parsable ») : la carte finissait « Terminée »,
   * avec pour compte rendu le début de réponse coupé (reproduit avec un flux
   * qui signale « Erreur du backend »). On la retient, et on conclut après.
   */
  let erreurFlux: string | null = null;

  try {
    await streamChat(
      {
        messages: [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          { role: "user" as const, content: buildInstruction(task) },
        ],
        model: options.modelUid ?? agent.modelUid,
        effort: "moyen",
        tools: agent.toolsEnabled,
        /*
         * Une tâche s'exécute sans personne devant l'écran : raison de plus pour
         * qu'elle suive les compétences de la maison. L'instance les ajoute au
         * nom de la personne de la séance (gateway/src/competences.ts).
         */
        competences: true,
        ...(agent.id !== DEFAULT_AGENT.id ? { agent: agent.id } : {}),
        signal: options.signal,
      },
      {
        onContent: (chunk) => {
          content += chunk;
          handlers.onProgress?.(content);
        },
        onEvent: (event) => {
          if (event.type === "tool_end") {
            const trace: TaskToolTrace = {
              name: event.name,
              ok: event.ok,
              detail: event.preview.slice(0, 200),
            };
            toolLog.push(trace);
            updateTask(task.id, { toolLog: [...toolLog] });
            handlers.onTool?.(trace);
          } else if (event.type === "error") {
            erreurFlux ??= event.message;
          }
        },
      },
    );
    if (erreurFlux) throw new Error(erreurFlux);
    // Rien à montrer n'est pas un travail fait : la carte ne passe pas « Terminée » sur une réponse vide.
    if (!content.trim()) throw new Error(t("L'agent n'a rien répondu. Relancez la tâche, ou choisissez un autre modèle."));

    updateTask(task.id, {
      status: "terminee",
      result: content.trim(),
      toolLog,
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    const aborted = options.signal?.aborted;
    updateTask(task.id, {
      status: aborted ? "a-faire" : "annulee",
      error: aborted ? undefined : err instanceof Error ? err.message : String(err),
      result: content.trim() || undefined,
      toolLog,
      finishedAt: new Date().toISOString(),
    });
  }

  const { getTask } = await import("./store/tasks");
  const updated = getTask(task.id)!;
  handlers.onDone?.(updated);
  return updated;
}
