import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";
import { journaliser } from "./audit.ts";

/**
 * Séances de travail, par personne et par poste.
 *
 * Le jeton d'instance dit « cette machine a le droit de parler à l'instance ».
 * Il ne dit pas *qui* parle — et sans cette information le serveur ne peut rien
 * cloisonner. La séance comble ce manque : elle est ouverte à la connexion,
 * porte l'identité de la personne, expire, et se révoque une par une.
 *
 * C'est ce qui permet d'exclure un poste perdu sans reconfigurer tout le parc.
 */

/** Durée de validité, prolongée à chaque usage. */
const DUREE_MS = 12 * 60 * 60 * 1000;
/**
 * Séance « Rester connecté sur ce poste », demandée par la personne.
 *
 * Douze heures conviennent à un poste partagé ; sur sa propre machine, se
 * reconnecter chaque matin n'apporte rien à la sécurité et fatigue. C'est donc
 * un choix explicite, à la connexion, et il se voit : la séance porte la
 * mention dans la liste des postes, où elle se révoque comme les autres.
 */
const DUREE_LONGUE_MS = 30 * 24 * 60 * 60 * 1000;
/** Au-delà, la séance meurt même si elle sert en permanence. */
const DUREE_ABSOLUE_MS = 30 * 24 * 60 * 60 * 1000;
/** Même règle pour une séance longue : un an, puis il faut se reconnecter. */
const DUREE_ABSOLUE_LONGUE_MS = 365 * 24 * 60 * 60 * 1000;

export interface StoredSession {
  /** Empreinte du jeton : le jeton lui-même n'est jamais conservé. */
  hash: string;
  accountId: string;
  /** Description du poste, pour que l'utilisateur reconnaisse ses séances. */
  poste: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** « Rester connecté » : prolongations longues, plafond absolu plus large. */
  longue?: boolean;
}

export interface PublicSession {
  id: string;
  poste: string;
  createdAt: string;
  lastSeenAt: string;
  /** La séance qui fait la demande, pour que l'interface ne l'affiche pas comme « autre ». */
  courante?: boolean;
  /** Ouverte avec « Rester connecté » : l'écran des postes doit le dire. */
  longue?: boolean;
}

/*
 * Les séances vivent en mémoire et sont recopiées sur disque : les lectures
 * sont sur le chemin de chaque requête, elles ne doivent pas toucher le disque.
 */
let cache: StoredSession[] | null = null;
/** Le stockage des séances est illisible et n'a pas pu être rangé : on ne l'écrase pas. */
let sansEcriture = false;
let chargement: Promise<StoredSession[]> | null = null;

async function charger(): Promise<StoredSession[]> {
  if (cache) return cache;
  if (!chargement) {
    chargement = (async () => {
      try {
        const value = await db().read("authSessions");
        cache = Array.isArray(value) ? (value as StoredSession[]) : [];
      } catch (err) {
        /*
         * Relecture du 27/09/2026 : un fichier de séances abîmé fermait la
         * porte à tout le monde, et pour de bon (l'échec restait en mémoire).
         * Il est rangé à côté, gardé tel quel, et chacun se reconnecte. Si le
         * stockage ne sait pas le ranger, les séances restent en mémoire
         * seulement : rien n'est écrit par-dessus ce qu'on n'a pas pu lire.
         */
        /*
         * Rangé à côté seulement s'il est vraiment abîmé (JSON illisible). Un
         * trousseau verrouillé, un antivirus qui tient le fichier, un disque
         * lent : le fichier est bon, on ne le déplace pas (revues du
         * 27/09/2026) ; les séances vivent alors en mémoire, sans rien écrire
         * par-dessus, jusqu'au prochain démarrage.
         */
        const abime = /abîmée/.test((err as Error).message);
        const garde = abime ? await Promise.resolve(db().mettreDeCote?.("authSessions")).catch(() => null) : null;
        if (!garde) sansEcriture = true;
        console.error(`[oxoai] séances de connexion illisibles (${(err as Error).message}) : ${garde ? `gardées dans ${garde}, ` : "laissées en place, "}chacun se reconnecte.`);
        cache = [];
      }
      return cache;
    })();
  }
  return chargement;
}

let ecritureEnCours: Promise<void> = Promise.resolve();

/**
 * File d'attente des modifications.
 *
 * Ouvrir et révoquer partaient toutes deux d'un instantané pris avant un
 * `await`, puis réécrivaient la liste entière : une connexion qui s'intercalait
 * **ressuscitait les séances qu'on venait de révoquer**. Sur une instance à
 * plusieurs postes, c'était le régime normal, pas une fenêtre étroite.
 *
 * Toute mutation passe désormais par ici, une à la fois, et relit l'état
 * courant au moment où elle s'exécute.
 */
let file: Promise<unknown> = Promise.resolve();

function enFile<T>(operation: () => Promise<T>): Promise<T> {
  const suivant = file.then(operation, operation);
  // La file ne doit jamais rester en échec, sinon tout se bloque derrière.
  file = suivant.catch(() => undefined);
  return suivant;
}

/** Enregistre l'état courant, sans bloquer l'appelant ni entrelacer les écritures. */
function planifierEcriture(): void {
  if (sansEcriture) return;
  ecritureEnCours = ecritureEnCours
    .then(() => db().write("authSessions", cache ?? []))
    .catch(() => {
      /* la mémoire fait foi ; un échec disque ne doit pas déconnecter tout le monde */
    });
}

const empreinte = (token: string) => createHash("sha256").update(token).digest("hex");

/** Identifiant court affiché à l'utilisateur, sans révéler le jeton. */
const identifiant = (hash: string) => hash.slice(0, 12);

function estValide(s: StoredSession, maintenant: number): boolean {
  const plafond = s.longue ? DUREE_ABSOLUE_LONGUE_MS : DUREE_ABSOLUE_MS;
  return s.expiresAt > maintenant && s.createdAt + plafond > maintenant;
}

/** Ouvre une séance et renvoie le jeton, visible une seule fois. */
export function openSession(
  accountId: string,
  poste: string,
  longue = false,
): Promise<{ token: string; expiresAt: number }> {
  return enFile(async () => {
  const sessions = await charger();
  const maintenant = Date.now();
  const token = randomBytes(32).toString("base64url");

  const session: StoredSession = {
    hash: empreinte(token),
    accountId,
    poste: poste.slice(0, 80) || "Poste inconnu",
    createdAt: maintenant,
    lastSeenAt: maintenant,
    expiresAt: maintenant + (longue ? DUREE_LONGUE_MS : DUREE_MS),
    ...(longue ? { longue: true as const } : {}),
  };

  // Ménage des séances mortes, sur l'état courant — jamais sur un instantané.
  cache = [...sessions.filter((s) => estValide(s, maintenant)), session];
  planifierEcriture();

  journaliser("seance.ouverte", accountId, {
    poste: session.poste,
    seance: identifiant(session.hash),
    ...(longue ? { longue: true } : {}),
  });
  return { token, expiresAt: session.expiresAt };
  });
}

/**
 * Retrouve le compte derrière un jeton de séance, et prolonge la séance.
 * Renvoie `null` si le jeton est inconnu, expiré ou révoqué.
 */
export async function resolveSession(
  token: string | undefined,
): Promise<{ accountId: string; hash: string } | null> {
  if (!token) return null;
  const sessions = await charger();
  const maintenant = Date.now();
  const attendu = Buffer.from(empreinte(token), "hex");

  /*
   * Comparaison à durée constante sur chaque candidat : comparer des chaînes
   * révélerait, par le temps de réponse, la longueur du préfixe correct.
   */
  const trouvee = sessions.find((s) => {
    const candidat = Buffer.from(s.hash, "hex");
    return candidat.length === attendu.length && timingSafeEqual(candidat, attendu);
  });

  if (!trouvee || !estValide(trouvee, maintenant)) return null;

  // Prolongation glissante, écrite au plus une fois par minute.
  if (maintenant - trouvee.lastSeenAt > 60_000) {
    trouvee.lastSeenAt = maintenant;
    trouvee.expiresAt = maintenant + (trouvee.longue ? DUREE_LONGUE_MS : DUREE_MS);
    planifierEcriture();
  }

  return { accountId: trouvee.accountId, hash: trouvee.hash };
}

/** Séances ouvertes d'un compte, pour que l'utilisateur puisse les fermer. */
export async function listSessions(
  accountId: string,
  couranteHash?: string,
): Promise<PublicSession[]> {
  const maintenant = Date.now();
  return (await charger())
    .filter((s) => s.accountId === accountId && estValide(s, maintenant))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((s) => ({
      id: identifiant(s.hash),
      poste: s.poste,
      ...(s.longue ? { longue: true as const } : {}),
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      courante: s.hash === couranteHash,
    }));
}

/** Ferme une séance désignée par son identifiant court. */
export function revokeSession(accountId: string, id: string): Promise<boolean> {
  return enFile(async () => {
  const sessions = await charger();
  const reste = sessions.filter(
    (s) => !(s.accountId === accountId && identifiant(s.hash) === id),
  );
  if (reste.length === sessions.length) return false;
  cache = reste;
  planifierEcriture();
  journaliser("seance.fermee", accountId, { seance: id });
  return true;
  });
}

/** Ferme toutes les séances d'un compte — poste volé, mot de passe changé. */
export function revokeAll(accountId: string): Promise<number> {
  return enFile(async () => {
  const sessions = await charger();
  const reste = sessions.filter((s) => s.accountId !== accountId);
  const fermees = sessions.length - reste.length;
  cache = reste;
  planifierEcriture();
  if (fermees > 0) journaliser("seance.fermee", accountId, { toutes: true, fermees });
  return fermees;
  });
}
