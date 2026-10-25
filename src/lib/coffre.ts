/**
 * Coffre des secrets du poste, côté interface.
 *
 * Deux valeurs méritent ce nom : le **jeton de séance** (il porte votre
 * identité sur chaque requête) et, pour un poste rattaché à une instance
 * d'entreprise, le **jeton d'instance**. Elles vivaient dans le stockage local
 * du navigateur, en clair : un poste volé, ou une sauvegarde du profil
 * recopiée ailleurs, les livrait telles quelles.
 *
 * Dans l'application de bureau, elles passent désormais par le trousseau du
 * système (`electron/coffre.cjs`, `safeStorage`). Hors application — un
 * navigateur, un essai — il n'y a pas de trousseau : on retombe sur le
 * stockage local, comme avant, et c'est dit dans `SECURITE.md`.
 *
 * Les lectures restent **synchrones** : le pont fournit les valeurs au
 * chargement, avant le premier script de la page. Aucun appel existant n'a eu
 * à devenir asynchrone.
 */

interface PontCoffre {
  disponible: boolean;
  valeurs: Record<string, string>;
  /** Préférences de l'ancienne origine, à appliquer une fois. */
  reprise?: Record<string, string>;
  poser: (cle: string, valeur: string | null) => Promise<boolean>;
  vider: () => Promise<boolean>;
}

function pont(): PontCoffre | undefined {
  if (typeof window === "undefined") return undefined;
  const p = (window as unknown as { oxoai?: { coffre?: PontCoffre } }).oxoai?.coffre;
  return p?.disponible ? p : undefined;
}

/** Copie de travail : le pont ne rend l'état du disque qu'au démarrage. */
const valeurs: Record<string, string> = { ...(pont()?.valeurs ?? {}) };

/** Le trousseau du système est-il réellement utilisé sur ce poste ? */
export const coffreSysteme = (): boolean => pont() !== undefined;

export function lireSecret(cle: string): string | undefined {
  if (pont()) {
    const v = valeurs[cle];
    if (v !== undefined) return v;
    /*
     * Rien dans le coffre, mais peut-être dans l'ancien stockage : c'est le
     * cas d'un poste qui tourne depuis une version antérieure. On le reprend,
     * et `ecrireSecret` le déplacera au premier passage (voir `reprendre`).
     */
    return lireLocal(cle);
  }
  return lireLocal(cle);
}

/**
 * Écritures en cours vers le coffre.
 *
 * La lecture est immédiate (tout est en mémoire), l'écriture traverse le pont.
 * Un rechargement de page qui doublerait cette écriture repartirait sur
 * l'ancienne valeur : `secretsEcrits()` permet de l'attendre là où c'est
 * important — le changement d'instance, qui recharge aussitôt après.
 */
let ecritures: Promise<unknown> = Promise.resolve();

export const secretsEcrits = (): Promise<unknown> => ecritures;

export function ecrireSecret(cle: string, valeur: string | null): void {
  const p = pont();
  if (p) {
    if (valeur === null) delete valeurs[cle];
    else valeurs[cle] = valeur;
    ecritures = ecritures.then(() => p.poser(cle, valeur)).catch(() => undefined);
    // Le secret ne doit plus exister en clair à côté du coffre.
    effacerLocal(cle);
    return;
  }
  if (valeur === null) effacerLocal(cle);
  else ecrireLocal(cle, valeur);
}

/**
 * Déplace dans le coffre ce qu'une version antérieure avait laissé en clair.
 *
 * Appelée une fois au démarrage. Sans elle, une personne déjà connectée
 * garderait son jeton dans le stockage du navigateur jusqu'à sa prochaine
 * connexion : la correction n'aurait rien corrigé pour elle.
 */
export function reprendreAnciensSecrets(cles: string[]): void {
  const p = pont();
  if (!p) return;
  for (const cle of cles) {
    if (valeurs[cle] !== undefined) {
      effacerLocal(cle);
      continue;
    }
    const ancien = lireLocal(cle);
    if (ancien !== undefined) ecrireSecret(cle, ancien);
  }
}

/**
 * Applique, une seule fois, les préférences de l'ancienne origine.
 *
 * Jusqu'à la 0.22.0 l'interface était servie depuis le disque ; elle l'est
 * désormais sous `oxoai://app`. Une origine, c'est un stockage : le nouveau
 * est vide. L'application relit l'ancien au premier démarrage
 * (electron/reprise.cjs) et le passe ici. Ce qui existe déjà n'est pas écrasé :
 * on complète, on ne remplace pas.
 */
export function appliquerReprise(): number {
  const ancien = pont()?.reprise;
  if (!ancien) return 0;
  let reprises = 0;
  for (const [cle, valeur] of Object.entries(ancien)) {
    if (typeof valeur !== "string") continue;
    if (lireLocal(cle) !== undefined) continue;
    ecrireLocal(cle, valeur);
    reprises += 1;
  }
  return reprises;
}

/** Vide le coffre : déconnexion complète, ou effacement des données du poste. */
export function viderCoffre(): void {
  const p = pont();
  for (const cle of Object.keys(valeurs)) delete valeurs[cle];
  if (p) void p.vider().catch(() => undefined);
}

/* ----------------------------- repli local ----------------------------- */

function lireLocal(cle: string): string | undefined {
  try {
    return localStorage.getItem(cle) ?? undefined;
  } catch {
    return undefined;
  }
}

function ecrireLocal(cle: string, valeur: string): void {
  try {
    localStorage.setItem(cle, valeur);
  } catch {
    /* stockage indisponible : la valeur ne survivra pas au rechargement */
  }
}

function effacerLocal(cle: string): void {
  try {
    localStorage.removeItem(cle);
  } catch {
    /* stockage indisponible */
  }
}
