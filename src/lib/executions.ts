import { runTask } from "./taskRunner";
import { etatPrerequis, getTask, suitesDe, visibleTo, type Task } from "./store/tasks";
import { currentUser } from "./store/identity";
import { t, tf, lister } from "@/lib/i18n";

/**
 * Exécutions des tâches déléguées, tenues pour toute l'application.
 *
 * Elles vivaient dans l'écran Tâches : quitter l'écran perdait le bouton
 * « Interrompre », et une chaîne de cartes se serait arrêtée au premier
 * changement de page. Tenues ici, elles continuent pendant qu'on travaille
 * ailleurs, et une carte terminée lance d'elle-même les cartes qui
 * l'attendaient.
 *
 * Limite assumée : elles tournent dans la fenêtre de l'application. La
 * fermer les interrompt ; les agents OpenClaw, eux, travaillent dans la
 * passerelle, fenêtre fermée.
 */

export const TACHES_CHANGEES = "oxoai:tasks-changed";

const enCours = new Map<string, AbortController>();
const abonnes = new Set<() => void>();

function prevenir(): void {
  window.dispatchEvent(new Event(TACHES_CHANGEES));
  for (const f of abonnes) f();
}

export function abonnerExecutions(f: () => void): () => void {
  abonnes.add(f);
  return () => abonnes.delete(f);
}

export const executionsEnCours = (): string[] => [...enCours.keys()];

/*
 * Les cartes lancées d'elles-mêmes passent une à une. Sur un poste qui fait
 * tourner un modèle local, trois agents à la fois se partageraient la même
 * carte graphique et finiraient tous en retard, voire en échec.
 */
const fileAuto: string[] = [];
let fileOccupee = false;

async function viderFile(): Promise<void> {
  if (fileOccupee) return;
  fileOccupee = true;
  try {
    while (fileAuto.length > 0) {
      const id = fileAuto.shift()!;
      const t = getTask(id);
      // Entre-temps, elle a pu être lancée à la main, modifiée ou supprimée.
      if (!t || t.status !== "a-faire" || enCours.has(id) || !etatPrerequis(t).pret) continue;
      await executer(t);
    }
  } finally {
    fileOccupee = false;
  }
}

/**
 * Les cartes qui attendaient `faite` et peuvent maintenant partir. Appelé
 * quand un agent termine une carte, et quand une personne passe elle-même
 * une carte en « Terminée » : une étape faite à la main lance aussi la suite.
 */
export function lancerLesSuites(faite: Task): void {
  const mes = visibleTo(currentUser());
  for (const suite of suitesDe(faite.id, mes)) {
    if (suite.autoStart && suite.status === "a-faire" && !enCours.has(suite.id) && etatPrerequis(suite, mes).pret) {
      if (!fileAuto.includes(suite.id)) fileAuto.push(suite.id);
    }
  }
  void viderFile();
}

async function executer(task: Task, modelUid?: string): Promise<Task> {
  const controleur = new AbortController();
  enCours.set(task.id, controleur);
  prevenir();
  let fin: Task = task;
  try {
    fin = await runTask(task, { modelUid, signal: controleur.signal }, { onStart: prevenir, onProgress: prevenir, onTool: prevenir, onDone: prevenir });
  } finally {
    enCours.delete(task.id);
    prevenir();
  }
  if (fin.status === "terminee") lancerLesSuites(fin);
  return fin;
}

/**
 * Délègue une tâche à son agent. Refusé tant que ses prérequis ne sont pas
 * terminés : elle travaillerait sans ce qu'ils devaient lui apporter.
 */
export async function lancerTache(task: Task, modelUid?: string): Promise<{ ok: boolean; message?: string }> {
  if (enCours.has(task.id)) return { ok: false, message: t("Elle est déjà en cours.") };
  const etat = etatPrerequis(task, visibleTo(currentUser()));
  if (!etat.pret) {
    const noms = lister([...etat.bloque, ...etat.attend].map((t) => `« ${t.title} »`));
    return { ok: false, message: tf("Elle attend {0}.", noms) };
  }
  await executer(task, modelUid);
  return { ok: true };
}

export function interrompreTache(id: string): void {
  enCours.get(id)?.abort();
  const i = fileAuto.indexOf(id);
  if (i >= 0) fileAuto.splice(i, 1);
}
