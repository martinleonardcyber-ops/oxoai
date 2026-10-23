import { db } from "./db.ts";
import { journaliser } from "./audit.ts";
import { applicationDeclaree, choixMoteurLmStudio, llmsterDeclare, retenirChoixMoteur, seuleApplicationDeclaree, type ChoixMoteurLmStudio } from "./engine.ts";

/**
 * Quel moteur de LM Studio Helix a le droit de démarrer (23/10/2026) : voir
 * engine.ts, « L'application LM Studio de la personne, et Bionic ».
 *
 * Le choix est rangé dans la collection interne `reglages` (comme le mode de
 * l'écran, reglagesEcran.ts), sous `moteurLmStudio`. Seul l'administrateur le
 * change : c'est la machine de l'instance qui démarre, ou non, un logiciel.
 */

/*
 * Les ports où `lms` cherche un service déjà à l'écoute avant d'en lancer un
 * (lmstudio-js, `lms-common/src/apiServerPorts.ts`, lu le 23/10/2026), et le
 * chemin qu'il interroge (`/lms-status`, réponse avec `package` et `version`).
 * `HELIX_PORTS_SERVICE_LMSTUDIO` (liste séparée par des virgules) les remplace
 * pour les essais : jamais le LM Studio de la machine qui les fait tourner.
 */
const PORTS_SERVICE = [41343, 52993, 16141, 39414, 22931];

function portsDuService(): number[] {
  const force = process.env.HELIX_PORTS_SERVICE_LMSTUDIO;
  if (force === undefined) return PORTS_SERVICE;
  return force
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

/**
 * Un service de LM Studio (application ou llmster) répond-il déjà ? C'est la
 * même question que pose `lms` avant de lancer quoi que ce soit : s'il répond,
 * aucune commande `lms` ne démarre rien. Une lecture, rien n'est démarré.
 * Sans mémoire : une réponse gardée quelques secondes laisserait passer une
 * commande juste après que la personne a quitté LM Studio (essai du
 * 23/10/2026), et la sonde ne coûte qu'une connexion locale.
 */
export async function serviceLmStudioEcoute(): Promise<boolean> {
  const essais = portsDuService().map(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/lms-status`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!r.ok) throw new Error(String(r.status));
    const corps = (await r.json()) as { package?: unknown; version?: unknown };
    if (typeof corps.package !== "string" || typeof corps.version !== "string") throw new Error("réponse inattendue");
    return true;
  });
  if (essais.length === 0) return false;
  return Promise.any(essais).catch(() => false);
}

/**
 * Helix peut-il lancer une commande `lms` qui démarrerait un moteur ?
 *  - llmster déclaré, ou aucune application déclarée : oui (rien ne s'ouvre ;
 *    sans rien de déclaré, `lms` ne démarre rien du tout) ;
 *  - seule l'application de bureau est déclarée : si son service tourne déjà
 *    (rien ne sera démarré), ou si la personne a choisi « application ».
 */
export async function reveilPermis(): Promise<boolean> {
  if (!seuleApplicationDeclaree()) return true;
  if (choixMoteurLmStudio() === "application") return true;
  return serviceLmStudioEcoute();
}

/** L'application LM Studio est fermée, et Helix attend que la personne choisisse : l'écran le dit. */
export async function applicationEnAttenteDeChoix(): Promise<boolean> {
  return seuleApplicationDeclaree() && choixMoteurLmStudio() === null && !(await serviceLmStudioEcoute());
}

/** Relit le choix enregistré. Appelé une fois, avant que l'instance n'écoute. */
export async function chargerChoixMoteur(): Promise<void> {
  try {
    const brut = (await db().read("reglages")) as { moteurLmStudio?: { choix?: unknown } } | null;
    const c = brut?.moteurLmStudio?.choix;
    retenirChoixMoteur(c === "application" || c === "sansFenetre" ? c : null);
  } catch {
    retenirChoixMoteur(null);
  }
}

export async function definirChoixMoteur(choix: ChoixMoteurLmStudio, qui: string): Promise<void> {
  const avant = choixMoteurLmStudio();
  // Lu avant d'écrire : une lecture en échec lève, et rien n'est écrit par-dessus (PROJET.md, pertes du 20/09 et du 24/09).
  const brut = ((await db().read("reglages")) as Record<string, unknown> | null) ?? {};
  await db().write("reglages", { ...brut, moteurLmStudio: { choix, par: qui, le: new Date().toISOString() } });
  retenirChoixMoteur(choix);
  journaliser("moteur.choix_lmstudio", qui, { avant, apres: choix });
}

/** Ce que l'écran montre : le choix, ce qui est déclaré sur la machine, et si un service tourne. */
export async function etatChoixMoteur(): Promise<{
  choix: ChoixMoteurLmStudio | null;
  applicationDeclaree: boolean;
  llmsterDeclare: boolean;
  serviceEcoute: boolean;
}> {
  const llmster = llmsterDeclare();
  return {
    choix: choixMoteurLmStudio(),
    applicationDeclaree: applicationDeclaree(),
    llmsterDeclare: llmster,
    serviceEcoute: await serviceLmStudioEcoute(),
  };
}
