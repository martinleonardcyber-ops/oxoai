import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { db } from "./db.ts";
import { journaliser } from "./audit.ts";
import { t, tf } from "./langue.ts";

/**
 * Clés d'API personnelles (Paramètres → API développeur).
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────────
 *
 * Demandé par Medhi le 26/09/2026 : l'écran « API développeur » annonçait des
 * clés « bientôt ». Un script, un tableur ou un logiciel tiers qui parle
 * l'API compatible OpenAI devait jusqu'ici porter le jeton d'instance (commun
 * à tout le parc, il ne nomme personne) et une séance (qui expire en douze
 * heures et ne se donne pas à un programme). Une clé nomme la personne, dure
 * le temps qu'elle choisit, et se révoque seule.
 *
 * ── Ce qu'une clé ouvre, et rien d'autre ────────────────────────────────────
 *
 * `GET /v1/models` et `POST /v1/chat/completions`, au nom de sa titulaire :
 * ses modèles, ses bases de connaissances, sa consommation, son journal. Aucune
 * route `/oxoai/*` (comptes, données, fichiers, agents, réglages, Code), aucun
 * outil que l'instance exécuterait (`tools: true`), et pas de quoi créer une
 * autre clé. La barrière est dans index.ts (`ROUTES_CLE`), posée avant le
 * routage comme `EXECUTION`.
 *
 * ── Ce que l'instance en garde ──────────────────────────────────────────────
 *
 * Une empreinte SHA-256 salée (sel de 16 octets propre à chaque clé), le nom,
 * les quatre derniers caractères, les dates et la portée. La clé elle-même est
 * rendue une seule fois, à la création, et n'est écrite nulle part : ni dans
 * le magasin, ni dans le journal d'audit, ni sur la sortie du serveur.
 * Collection interne (db.ts) : jamais distribuée aux postes.
 */

/** Préfixe lisible : on reconnaît une clé d'un coup d'œil, et un scanner de secrets aussi. */
export const PREFIXE = "hlx_";

/** Au-delà, une personne retire une clé avant d'en créer une autre. */
export const CLES_PAR_PERSONNE_MAX = 20;

/** Durées proposées à l'écran, en jours ; `null` : jamais. */
export const DUREES_JOURS = [30, 90, 365] as const;

/**
 * Requêtes admises par clé et par minute. Une personne qui travaille ne
 * l'atteint pas ; une clé fuitée qui tourne en boucle, si, et elle ne peut
 * alors plus occuper la machine au détriment des autres.
 */
export const PAR_MINUTE = Math.max(1, Number(process.env.OXOAI_CLE_API_PAR_MINUTE ?? 60) || 60);

const NOM_MAX = 60;
const COLLECTION = "clesApi";

/** Ce que la clé ouvre. Une seule portée aujourd'hui : l'API compatible OpenAI. */
export type Portee = "modeles";

interface CleStockee {
  id: string;
  userId: string;
  nom: string;
  /** Sel propre à la clé, en hexadécimal. */
  sel: string;
  /** SHA-256 de sel + clé, en hexadécimal. La clé n'est jamais écrite. */
  empreinte: string;
  /** Quatre derniers caractères, pour que la personne reconnaisse la sienne. */
  fin: string;
  portee: Portee;
  creee: string;
  derniereUtilisation: string | null;
  /** Date d'expiration, ou `null` : jamais. */
  expire: string | null;
}

/** Ce que l'écran et l'export voient : tout sauf le sel et l'empreinte. */
export interface ClePublique {
  id: string;
  nom: string;
  fin: string;
  portee: Portee;
  creee: string;
  derniereUtilisation: string | null;
  expire: string | null;
  expiree: boolean;
}

export type Resultat<T> = { ok: true; valeur: T } | { ok: false; statut: number; message: string };

/*
 * En mémoire, avec la révision du magasin qui l'a produit : la vérification
 * d'une clé est sur le chemin de chaque appel à l'API, elle ne déchiffre le
 * registre que s'il a changé. Relire la révision à chaque fois plutôt que de
 * se fier au seul cache : une écriture faite ailleurs (une seconde passerelle
 * sur le même PostgreSQL, un outil de récupération) vaut aussitôt, révocation
 * comprise. Les écritures d'ici passent une à une (`enFile`) et ne mettent le
 * cache à jour que si elles ont réussi.
 */
let cache: CleStockee[] | null = null;
let revisionDuCache = -1;

/**
 * Lecture du registre. Une valeur illisible **lève** : sans cela, la première
 * création remplacerait par une liste d'une clé les clés qu'on n'a pas pu lire
 * (règle du projet, pertes du 20/09 et du 24/09).
 */
async function charger(): Promise<CleStockee[]> {
  const revision = await db().revision(COLLECTION);
  if (cache && revision === revisionDuCache) return cache;
  const v = await db().read(COLLECTION);
  if (v !== undefined && v !== null && !Array.isArray(v)) throw new Error("Registre des clés d'API illisible.");
  cache = Array.isArray(v) ? (v as CleStockee[]) : [];
  revisionDuCache = revision;
  return cache;
}

async function ecrire(liste: CleStockee[]): Promise<void> {
  await db().write(COLLECTION, liste);
  cache = liste;
  revisionDuCache = await db().revision(COLLECTION);
}

let file: Promise<unknown> = Promise.resolve();
function enFile<T>(travail: () => Promise<T>): Promise<T> {
  const suite = file.then(travail, travail);
  file = suite.catch(() => undefined);
  return suite;
}

const empreinteDe = (sel: string, cle: string) => createHash("sha256").update(sel).update(cle).digest("hex");

const expiree = (c: CleStockee, maintenant = Date.now()) => c.expire !== null && Date.parse(c.expire) <= maintenant;

const publique = (c: CleStockee): ClePublique => ({
  id: c.id,
  nom: c.nom,
  fin: c.fin,
  portee: c.portee,
  creee: c.creee,
  derniereUtilisation: c.derniereUtilisation,
  expire: c.expire,
  expiree: expiree(c),
});

function nomValide(brut: unknown): string | null {
  if (typeof brut !== "string") return null;
  // Caractères de contrôle : invisibles à l'écran, ils feraient d'un nom un piège.
  const nom = brut.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return nom && nom.length <= NOM_MAX ? nom : null;
}

/** Les clés d'une personne, la plus récente d'abord. Jamais celles d'un collègue. */
export async function clesDe(userId: string): Promise<ClePublique[]> {
  return (await charger())
    .filter((c) => c.userId === userId)
    .sort((a, b) => b.creee.localeCompare(a.creee))
    .map(publique);
}

/**
 * Crée une clé. La valeur rendue est la seule copie qui existera jamais :
 * l'instance n'en garde que l'empreinte.
 */
export function creerCle(
  userId: string,
  corps: { nom?: unknown; jours?: unknown },
): Promise<Resultat<{ cle: ClePublique; secret: string }>> {
  return enFile(async () => {
    const nom = nomValide(corps.nom);
    if (!nom) return { ok: false, statut: 400, message: tf("Donnez un nom à la clé ({0} caractères au plus).", NOM_MAX) };
    const jours = corps.jours === null || corps.jours === undefined ? null : Number(corps.jours);
    if (jours !== null && !(DUREES_JOURS as readonly number[]).includes(jours)) {
      return { ok: false, statut: 400, message: t("Durée de validité inconnue : 30, 90 ou 365 jours, ou sans expiration.") };
    }
    const liste = await charger();
    if (liste.filter((c) => c.userId === userId).length >= CLES_PAR_PERSONNE_MAX) {
      return {
        ok: false,
        statut: 409,
        message: tf("Vous avez déjà {0} clés : révoquez-en une avant d'en créer une autre.", CLES_PAR_PERSONNE_MAX),
      };
    }
    const secret = PREFIXE + randomBytes(32).toString("base64url");
    const sel = randomBytes(16).toString("hex");
    const maintenant = new Date();
    const cle: CleStockee = {
      id: `cle_${randomBytes(9).toString("base64url")}`,
      userId,
      nom,
      sel,
      empreinte: empreinteDe(sel, secret),
      fin: secret.slice(-4),
      portee: "modeles",
      creee: maintenant.toISOString(),
      derniereUtilisation: null,
      expire: jours === null ? null : new Date(maintenant.getTime() + jours * 86_400_000).toISOString(),
    };
    await ecrire([...liste, cle]);
    // Le nom et la fin, pour s'y retrouver ; jamais la clé.
    journaliser("cleapi.creee", userId, { cle: cle.id, nom, fin: cle.fin, expire: cle.expire });
    return { ok: true, valeur: { cle: publique(cle), secret } };
  });
}

export function renommerCle(userId: string, id: string, brut: unknown): Promise<Resultat<ClePublique>> {
  return enFile(async () => {
    const nom = nomValide(brut);
    if (!nom) return { ok: false, statut: 400, message: tf("Donnez un nom à la clé ({0} caractères au plus).", NOM_MAX) };
    const liste = await charger();
    const i = liste.findIndex((c) => c.id === id && c.userId === userId);
    // Celle d'un collègue répond comme une clé inconnue : on ne confirme pas qu'elle existe.
    if (i < 0) return { ok: false, statut: 404, message: t("Clé introuvable.") };
    const copie = [...liste];
    copie[i] = { ...liste[i]!, nom };
    await ecrire(copie);
    journaliser("cleapi.renommee", userId, { cle: id, nom });
    return { ok: true, valeur: publique(copie[i]!) };
  });
}

/** Révocation : la clé disparaît du registre, et le prochain appel qui la porte reçoit 401. */
export function revoquerCle(userId: string, id: string): Promise<Resultat<true>> {
  return enFile(async () => {
    const liste = await charger();
    const cle = liste.find((c) => c.id === id && c.userId === userId);
    if (!cle) return { ok: false, statut: 404, message: t("Clé introuvable.") };
    await ecrire(liste.filter((c) => c !== cle));
    journaliser("cleapi.revoquee", userId, { cle: id, nom: cle.nom, fin: cle.fin });
    return { ok: true, valeur: true };
  });
}

/** Effacement d'un compte (effacement.ts) : ses clés partent avec lui. Rend combien. */
export function oublierClesDe(userId: string): Promise<number> {
  return enFile(async () => {
    const liste = await charger();
    const reste = liste.filter((c) => c.userId !== userId);
    if (reste.length !== liste.length) await ecrire(reste);
    return liste.length - reste.length;
  });
}

/* --------------------------- présentation d'une clé --------------------------- */

/**
 * La requête porte-t-elle une clé d'API dans `Authorization: Bearer` ? Rend la
 * clé, ou null. C'est le seul endroit où une clé est acceptée.
 */
export function clePresentee(req: http.IncomingMessage): string | null {
  const entete = req.headers.authorization;
  if (!entete?.startsWith("Bearer ")) return null;
  const valeur = entete.slice(7).trim();
  return valeur.startsWith(PREFIXE) ? valeur : null;
}

/**
 * Une clé glissée ailleurs que dans l'en-tête `Authorization` : dans l'adresse
 * (où elle finit dans l'historique, les journaux d'un proxy, l'en-tête
 * `Referer`), ou dans l'en-tête de séance. Refusée, même valide, pour qu'un
 * script qui le fait l'apprenne tout de suite plutôt qu'après la fuite.
 */
export function cleMalPlacee(req: http.IncomingMessage, url: URL): boolean {
  /*
   * La forme exacte d'une clé (préfixe et 43 caractères), pas le seul préfixe :
   * un fichier nommé « hlx_notes.txt » passé en paramètre n'est pas une clé.
   */
  for (const valeur of url.searchParams.values()) {
    if (FORME.test(valeur.trim())) return true;
  }
  const seance = req.headers["x-oxoai-session"];
  const valeurs = Array.isArray(seance) ? seance : seance ? [seance] : [];
  return valeurs.some((v) => FORME.test(v.trim()));
}

/** 32 octets en base64url : 43 caractères, après le préfixe. */
const FORME = new RegExp(`^${PREFIXE}[A-Za-z0-9_-]{43}$`);

/**
 * Retrouve la clé présentée. Rend sa titulaire et son identifiant, ou null si
 * elle est inconnue, révoquée ou expirée. Comparaison à durée constante sur
 * chaque candidat, comme pour les séances.
 */
export async function verifierCle(secret: string): Promise<{ id: string; userId: string } | null> {
  if (!secret.startsWith(PREFIXE) || secret.length > 200) return null;
  const liste = await charger();
  const maintenant = Date.now();
  let trouvee: CleStockee | undefined;
  for (const c of liste) {
    const attendu = Buffer.from(c.empreinte, "hex");
    const calcule = Buffer.from(empreinteDe(c.sel, secret), "hex");
    if (attendu.length === calcule.length && timingSafeEqual(attendu, calcule)) trouvee = c;
  }
  if (!trouvee || expiree(trouvee, maintenant)) return null;

  // Dernière utilisation, écrite au plus une fois par minute : la vérification est sur le chemin de chaque appel.
  const derniere = trouvee.derniereUtilisation ? Date.parse(trouvee.derniereUtilisation) : 0;
  if (maintenant - derniere > 60_000) {
    const id = trouvee.id;
    void enFile(async () => {
      const courante = await charger();
      const i = courante.findIndex((c) => c.id === id);
      if (i < 0) return; // révoquée entre-temps : rien à noter
      const copie = [...courante];
      copie[i] = { ...courante[i]!, derniereUtilisation: new Date(maintenant).toISOString() };
      await ecrire(copie);
    }).catch(() => {
      /* la date d'usage n'est qu'une indication ; son échec ne coupe pas l'appel */
    });
  }
  return { id: trouvee.id, userId: trouvee.userId };
}
