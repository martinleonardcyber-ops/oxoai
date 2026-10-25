/**
 * Grand stockage du poste, côté interface (electron/grandStockage.cjs).
 *
 * Dans l'application de bureau, les Chats sont rangés dans un fichier chiffré
 * plutôt que dans `localStorage`, dont la limite (quelques Mo) arrêtait sans
 * le dire un import ChatGPT ou Claude. Lecture synchrone : le préchargement
 * fournit les valeurs avant le premier script, comme pour le coffre. Hors
 * application (navigateur, essai), on garde `localStorage`, et sa limite.
 */

/** Pourquoi le fichier n'a pas été lu au démarrage (voir electron/grandStockage.cjs). */
export type RaisonIllisible = "chiffrement" | "dechiffrement" | "lecture";

/** Un fichier trouvé illisible pendant cette séance de l'application, pour le bandeau (AvisChatsIllisibles). */
export interface IncidentGrand {
  raison: RaisonIllisible;
  /** Le fichier d'origine. */
  fichier: string;
  /** Sa copie mise de côté ; null si elle n'a pas pu être faite (le fichier d'origine est alors laissé tel quel). */
  copie: string | null;
  /** L'instance a rendu la collection depuis. */
  relue: boolean;
}

interface PontGrand {
  disponible: boolean;
  cles: string[];
  valeurs: Record<string, string>;
  poser: (cle: string, valeur: string | null) => Promise<boolean>;
  illisibles?: unknown;
  incidents?: unknown;
  relu?: (cle: string) => Promise<unknown>;
}

/**
 * Où la dernière écriture a abouti.
 *  - `fichier` : dans le fichier chiffré du poste ;
 *  - `navigateur` : le fichier a refusé (processus principal sans ce canal,
 *    disque plein), la valeur est passée dans le stockage du navigateur, qui
 *    prend le relais pour le reste de la séance ;
 *  - `memoire` : le navigateur l'a refusée aussi (quota) : elle n'est qu'en
 *    mémoire, et perdue à la fermeture sauf ce que l'instance en a reçu.
 */
export type IssueEcriture = "fichier" | "navigateur" | "memoire";

/*
 * `memoire` garde le grand stockage comme source de lecture : c'est là
 * qu'est la seule copie entière. Passer alors au navigateur, comme on le
 * faisait, rendait la liste d'avant l'écriture (ou aucune, si elle avait déjà
 * été rangée dans le fichier), et la poussée suivante l'aurait envoyée à
 * l'instance comme si les autres Chats avaient été supprimés.
 */
let mode: IssueEcriture = "fichier";

function brutPont(): PontGrand | undefined {
  if (typeof window === "undefined") return undefined;
  const p = (window as unknown as { oxoai?: { grand?: PontGrand } }).oxoai?.grand;
  return p?.disponible && Array.isArray(p.cles) ? p : undefined;
}

function pont(): PontGrand | undefined {
  return mode === "navigateur" ? undefined : brutPont();
}

const PREFIX = "oxoai:";
const valeurs: Record<string, string> = { ...(pont()?.valeurs ?? {}) };

/** Lu même sans chiffrement disponible : c'est justement le cas où le fichier est là et illisible. */
function lirePreload(champ: "illisibles" | "incidents"): unknown {
  try {
    return (window as unknown as { oxoai?: { grand?: Record<string, unknown> } }).oxoai?.grand?.[champ];
  } catch {
    return undefined;
  }
}

/*
 * Collections dont le fichier existe sur ce poste mais n'a pas pu être lu au
 * démarrage (trousseau refusé, par exemple). Tant que l'instance n'a pas
 * rendu la collection, ce poste n'a qu'une liste vide ou partielle, qu'il ne
 * doit pas pousser (sync.ts) : pour l'instance, une liste vide venue du
 * propriétaire est une suppression de tous ses Chats.
 */
const illisibles = new Set<string>(
  (() => {
    const l = lirePreload("illisibles");
    return Array.isArray(l) ? l.filter((c): c is string => typeof c === "string") : [];
  })(),
);

const incidents = new Map<string, IncidentGrand>(
  (() => {
    const brut = lirePreload("incidents");
    if (!brut || typeof brut !== "object") return [];
    return Object.entries(brut as Record<string, Partial<IncidentGrand>>)
      .filter(([, v]) => v && typeof v === "object")
      .map(([cle, v]): [string, IncidentGrand] => [
        cle,
        {
          raison: v.raison === "chiffrement" || v.raison === "dechiffrement" ? v.raison : "lecture",
          fichier: typeof v.fichier === "string" ? v.fichier : "",
          copie: typeof v.copie === "string" ? v.copie : null,
          relue: v.relue === true && !illisibles.has(cle),
        },
      ]);
  })(),
);
// Un ancien processus principal ne donne que la liste : le bandeau s'affiche quand même, sans détail.
for (const cle of illisibles) {
  if (!incidents.has(cle)) incidents.set(cle, { raison: "lecture", fichier: "", copie: null, relue: false });
}

/**
 * Où en est la relecture depuis l'instance, telle que sync.ts l'a constatée :
 * `attente` (pas encore demandé), `relue`, `absente` (l'instance n'a pas cette
 * collection), `echec` (elle a refusé ou n'a pas répondu), `hors-ligne` (pas
 * d'instance joignable au démarrage), `place` (elle l'a rendue, mais ce poste
 * n'a pas pu la garder).
 */
export type EtatReleve = "attente" | "relue" | "absente" | "echec" | "hors-ligne" | "place";
const releves = new Map<string, { etat: EtatReleve; nombre?: number }>();

/** Émis quand un incident ou sa relève change : le bandeau se redessine. */
export const GRAND_CHANGE = "oxoai:grand-change";
const annoncer = () => {
  try {
    window.dispatchEvent(new Event(GRAND_CHANGE));
  } catch {
    /* hors navigateur */
  }
};

/** Le fichier de cette collection était-il illisible au démarrage, sans relève de l'instance depuis ? */
export const grandIllisible = (cle: string): boolean => illisibles.has(cle);

/** Les incidents de cette séance, avec l'état de leur relève. */
export function incidentsGrand(): { cle: string; incident: IncidentGrand; releve: { etat: EtatReleve; nombre?: number } }[] {
  return [...incidents.entries()].map(([cle, incident]) => ({
    cle,
    incident,
    releve: releves.get(cle) ?? (incident.relue ? { etat: "relue" } : { etat: "attente" }),
  }));
}

/** sync.ts : ce que l'instance a répondu pour une collection dont le fichier était illisible. */
export function noterReleve(cle: string, etat: Exclude<EtatReleve, "relue">): void {
  if (!incidents.has(cle) || incidents.get(cle)!.relue) return;
  releves.set(cle, { etat });
  annoncer();
}

/** L'instance a rendu la collection (`nombre` éléments) : ce poste en a de nouveau une copie sûre. */
export function grandRelu(cle: string, nombre?: number): void {
  illisibles.delete(cle);
  const incident = incidents.get(cle);
  if (!incident || incident.relue) return;
  incident.relue = true;
  releves.set(cle, { etat: "relue", ...(nombre !== undefined ? { nombre } : {}) });
  // Le processus principal le retient : une fenêtre rechargée ne rebloque pas, et ne débloque pas avant.
  void brutPont()?.relu?.(cle)?.catch?.(() => undefined);
  annoncer();
}

/** Cette clé (sans préfixe) passe-t-elle par le grand stockage sur ce poste ? */
export function auGrand(cle: string): boolean {
  return Boolean(pont()?.cles.includes(cle));
}

/** Le poste a-t-il un grand stockage (application de bureau) ? */
export const grandStockageDisponible = (): boolean => pont() !== undefined;

/** Application de bureau dont le fichier a refusé une écriture plus tôt : le stockage du navigateur a pris le relais. */
export const grandEnRepli = (): boolean => mode === "navigateur" && brutPont() !== undefined;

export function lireGrand(cle: string): string | null {
  const v = valeurs[cle];
  if (v !== undefined) return v;
  /*
   * Rien encore dans le fichier : un poste qui vient d'une version où les
   * Chats étaient dans localStorage. On les reprend et on les range. La copie
   * du navigateur n'est libérée qu'une fois le fichier écrit, confirmé par le
   * processus principal : l'effacer avant, c'était parier les Chats sur une
   * écriture pas encore faite.
   */
  try {
    const ancien = localStorage.getItem(PREFIX + cle);
    if (ancien !== null) {
      valeurs[cle] = ancien;
      void ecrire(cle, ancien).then((issue) => {
        // Libérée seulement si personne n'a écrit entre-temps : sinon la copie du navigateur reste, par prudence.
        if (issue === "fichier" && valeurs[cle] === ancien) localStorage.removeItem(PREFIX + cle);
      });
      return ancien;
    }
  } catch {
    /* stockage local indisponible */
  }
  return null;
}

/** Dernière écriture demandée pour chaque clé, et où elle a abouti. */
const ecritures = new Map<string, Promise<IssueEcriture>>();

async function ecrire(cle: string, json: string | null): Promise<IssueEcriture> {
  const p = pont();
  if (!p) return "navigateur";
  try {
    if (await p.poser(cle, json)) {
      // Le fichier reprend : ce qui n'était qu'en mémoire y est de nouveau.
      mode = "fichier";
      return "fichier";
    }
  } catch {
    /* canal absent ou écriture impossible */
  }
  return basculerVersLeNavigateur(cle);
}

/** Le fichier ne prend plus : la valeur retourne dans le stockage du navigateur, s'il la prend. */
function basculerVersLeNavigateur(cle: string): IssueEcriture {
  const v = valeurs[cle];
  try {
    if (v !== undefined) localStorage.setItem(PREFIX + cle, v);
    else localStorage.removeItem(PREFIX + cle);
    mode = "navigateur";
    return "navigateur";
  } catch {
    // Quota : la valeur reste en mémoire, qui reste la source de lecture ; la prochaine écriture réessaie le fichier.
    mode = "memoire";
    return "memoire";
  }
}

export function ecrireGrand(cle: string, json: string | null): void {
  if (json === null) delete valeurs[cle];
  else valeurs[cle] = json;
  ecritures.set(cle, ecrire(cle, json));
}

/**
 * Où a abouti la dernière écriture de cette clé, une fois faite. Pour le
 * bilan d'un import (ImporterChats) : relire la liste ne dit que ce qui est en
 * mémoire, pas ce qui a été écrit. Sans grand stockage : null (le navigateur
 * seul, qu'on relit).
 */
export async function issueDerniereEcriture(cle: string): Promise<IssueEcriture | null> {
  const e = ecritures.get(cle);
  return e ? e : null;
}
