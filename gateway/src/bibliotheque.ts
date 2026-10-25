import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "./db.ts";
import { journaliser } from "./audit.ts";
import { chiffrerOctets, dechiffrerOctets, ecrireEnFlux, lireEnFlux } from "./secret.ts";
import { DOCUMENT_MAX, LIBELLE_DOCUMENT_MAX, MESSAGE_DISQUE_PLEIN, placeSuffisante } from "./televersement.ts";
import { listerGroupes } from "./groupes.ts";
import { t, tf } from "./langue.ts";

/**
 * Bibliothèque : les documents de l'équipe, rangés en dossiers, gardés par
 * l'instance.
 *
 * Chaque élément (dossier ou document) a sa visibilité :
 *  - `prive` : son propriétaire seul ;
 *  - `groupes` : les membres des groupes choisis (groupes.ts) ;
 *  - `organisation` : toute l'instance.
 * Voir n'est pas modifier : seul le propriétaire renomme, déplace, change la
 * visibilité ou supprime. Qui voit un dossier peut y déposer ses propres
 * documents (ils restent à lui) : c'est ce qui fait d'un dossier partagé un
 * lieu de travail commun.
 *
 * Le contenu vit sur le disque de l'instance, chiffré par la clé des données
 * (`chiffrerOctets`), lié à son identifiant ; le texte extrait sur le poste
 * (PDF, Word, Excel…) est gardé à côté, chiffré lui aussi, pour la recherche
 * et pour les agents. Les métadonnées sont une collection interne : elles ne
 * partent jamais par la synchronisation, seulement par ces routes, filtrées
 * pour la personne qui demande.
 */

export type Visibilite = "prive" | "groupes" | "organisation";
export const VISIBILITES: Visibilite[] = ["prive", "groupes", "organisation"];
export type Couleur = "vert" | "bleu" | "orange" | "rouge";
const COULEURS: Couleur[] = ["vert", "bleu", "orange", "rouge"];

export interface Element {
  id: string;
  type: "dossier" | "document";
  nom: string;
  parentId: string | null;
  ownerId: string;
  visibilite: Visibilite;
  groupes: string[];
  /** Dossiers : un emoji et une couleur, pour s'y retrouver d'un coup d'œil. */
  emoji?: string;
  couleur?: Couleur;
  /** Documents : taille, type, et si un texte a pu en être extrait. */
  taille?: number;
  typeMime?: string;
  aTexte?: boolean;
  /** Qui l'a mis en favori. */
  favoris: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Qui {
  userId: string;
  groupes: string[];
}

type Resultat<T> = { ok: true; valeur: T } | { ok: false; statut: number; message: string };

const COLLECTION = "bibliotheque";
export const TAILLE_MAX = DOCUMENT_MAX;
const TEXTE_MAX = 2_000_000;
const NOM_MAX = 120;
const ELEMENTS_MAX = 20_000;

const dossierFichiers = () =>
  join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "bibliotheque");
const cheminContenu = (id: string) => join(dossierFichiers(), id);
const cheminTexte = (id: string) => join(dossierFichiers(), `${id}.texte`);

async function charger(): Promise<Element[]> {
  const v = await db().read(COLLECTION);
  return Array.isArray(v) ? (v as Element[]) : [];
}

async function enregistrer(liste: Element[]): Promise<void> {
  await db().write(COLLECTION, liste);
}

let file: Promise<unknown> = Promise.resolve();
function enFile<T>(travail: () => Promise<T>): Promise<T> {
  const suite = file.then(travail, travail);
  file = suite.catch(() => undefined);
  return suite;
}

/** Ce qu'une personne a le droit de voir. */
export function peutVoir(e: Element, qui: Qui): boolean {
  if (e.ownerId === qui.userId) return true;
  if (e.visibilite === "organisation") return true;
  return e.visibilite === "groupes" && e.groupes.some((g) => qui.groupes.includes(g));
}

/** Nom affichable et sûr : pas de chemin, pas de caractère de contrôle. */
function nomSur(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u001f\u007f/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOM_MAX);
}

/** Groupes existants parmi ceux demandés ; seulement ceux dont la personne est membre. */
async function groupesAdmis(v: unknown, qui: Qui): Promise<string[]> {
  if (!Array.isArray(v)) return [];
  const existants = new Set((await listerGroupes()).map((g) => g.id));
  return [...new Set(v.filter((x): x is string => typeof x === "string" && existants.has(x) && qui.groupes.includes(x)))];
}

function visibilite(v: unknown): Visibilite {
  return VISIBILITES.includes(v as Visibilite) ? (v as Visibilite) : "prive";
}

/** Emoji : un seul symbole, rien d'autre (il finit dans une page). */
function emojiSur(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const t = v.trim();
  return [...t].length <= 2 && /\p{Extended_Pictographic}/u.test(t) ? t : undefined;
}

function vue(e: Element, qui: Qui) {
  const { favoris, ...reste } = e;
  return { ...reste, favori: favoris.includes(qui.userId), estProprietaire: e.ownerId === qui.userId };
}
export type VueElement = ReturnType<typeof vue>;

/** Dossier parent valable pour y déposer : visible de la personne, et bien un dossier. */
function parentAdmis(liste: Element[], parentId: unknown, qui: Qui): Resultat<string | null> {
  if (parentId === null || parentId === undefined || parentId === "") return { ok: true, valeur: null };
  const p = liste.find((x) => x.id === parentId);
  if (!p || p.type !== "dossier" || !peutVoir(p, qui)) return { ok: false, statut: 404, message: t("Dossier introuvable.") };
  return { ok: true, valeur: p.id };
}

const replier = (t: string) => t.toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export interface Listage {
  dossier: { id: string; nom: string; estProprietaire: boolean; visibilite: Visibilite } | null;
  chemin: { id: string; nom: string }[];
  elements: VueElement[];
}

/**
 * Ce qu'une personne voit.
 *  - `tous` : le contenu d'un dossier (ou de la racine). À la racine
 *    apparaissent aussi les éléments qu'on lui a partagés depuis un dossier
 *    qu'elle ne voit pas : sans cela, ils seraient inatteignables.
 *  - `favoris`, `prives`, `groupes` : listes à plat.
 *  - `q` : recherche dans les noms et le texte des documents visibles.
 */
export async function lister(qui: Qui, options: { vue?: string; dossier?: string | null; q?: string }): Promise<Resultat<Listage>> {
  const liste = await charger();
  const visibles = liste.filter((e) => peutVoir(e, qui));
  const parId = new Map(liste.map((e) => [e.id, e]));
  const trier = (a: Element, b: Element) =>
    Number(b.type === "dossier") - Number(a.type === "dossier") || a.nom.localeCompare(b.nom, "fr", { numeric: true });

  const q = (options.q ?? "").trim();
  if (q) {
    const terme = replier(q).slice(0, 200);
    const trouves: Element[] = [];
    for (const e of visibles) {
      if (trouves.length >= 200) break;
      if (replier(e.nom).includes(terme)) trouves.push(e);
      else if (e.aTexte && replier(lireTexteBrut(e.id).slice(0, TEXTE_MAX)).includes(terme)) trouves.push(e);
    }
    return { ok: true, valeur: { dossier: null, chemin: [], elements: trouves.sort(trier).map((e) => vue(e, qui)) } };
  }

  if (options.vue === "favoris") {
    return { ok: true, valeur: { dossier: null, chemin: [], elements: visibles.filter((e) => e.favoris.includes(qui.userId)).sort(trier).map((e) => vue(e, qui)) } };
  }
  if (options.vue === "prives") {
    return {
      ok: true,
      valeur: { dossier: null, chemin: [], elements: visibles.filter((e) => e.ownerId === qui.userId && e.visibilite === "prive").sort(trier).map((e) => vue(e, qui)) },
    };
  }
  if (options.vue === "groupes") {
    return {
      ok: true,
      valeur: {
        dossier: null,
        chemin: [],
        elements: visibles.filter((e) => e.visibilite === "groupes" && e.groupes.some((g) => qui.groupes.includes(g))).sort(trier).map((e) => vue(e, qui)),
      },
    };
  }

  const dossierId = options.dossier || null;
  if (dossierId) {
    const d = parId.get(dossierId);
    if (!d || d.type !== "dossier" || !peutVoir(d, qui)) return { ok: false, statut: 404, message: t("Dossier introuvable.") };
    // Fil d'Ariane : on remonte tant que les dossiers sont visibles.
    const chemin: { id: string; nom: string }[] = [];
    for (let p: Element | undefined = d; p && peutVoir(p, qui) && chemin.length < 50; p = p.parentId ? parId.get(p.parentId) : undefined) {
      chemin.unshift({ id: p.id, nom: p.nom });
    }
    return {
      ok: true,
      valeur: {
        dossier: { id: d.id, nom: d.nom, estProprietaire: d.ownerId === qui.userId, visibilite: d.visibilite },
        chemin,
        elements: visibles.filter((e) => e.parentId === d.id).sort(trier).map((e) => vue(e, qui)),
      },
    };
  }
  const aLaRacine = visibles.filter((e) => {
    if (!e.parentId) return true;
    const p = parId.get(e.parentId);
    return !p || !peutVoir(p, qui);
  });
  return { ok: true, valeur: { dossier: null, chemin: [], elements: aLaRacine.sort(trier).map((e) => vue(e, qui)) } };
}

export function creerDossier(brut: Record<string, unknown>, qui: Qui): Promise<Resultat<VueElement>> {
  return enFile(async () => {
    const nom = nomSur(brut.nom);
    if (!nom) return { ok: false, statut: 400, message: t("Donnez un nom au dossier.") };
    const liste = await charger();
    if (liste.length >= ELEMENTS_MAX) return { ok: false, statut: 409, message: t("La bibliothèque est pleine.") };
    const parent = parentAdmis(liste, brut.parentId, qui);
    if (!parent.ok) return parent;
    const vis = visibilite(brut.visibilite);
    const groupes = vis === "groupes" ? await groupesAdmis(brut.groupes, qui) : [];
    if (vis === "groupes" && groupes.length === 0) return { ok: false, statut: 400, message: t("Choisissez au moins un de vos groupes.") };
    const couleur = COULEURS.includes(brut.couleur as Couleur) ? (brut.couleur as Couleur) : undefined;
    const emoji = emojiSur(brut.emoji);
    const maintenant = new Date().toISOString();
    const e: Element = {
      id: `bib_${randomBytes(9).toString("base64url")}`,
      type: "dossier",
      nom,
      parentId: parent.valeur,
      ownerId: qui.userId,
      visibilite: vis,
      groupes,
      ...(emoji ? { emoji } : {}),
      ...(couleur ? { couleur } : {}),
      favoris: [],
      createdAt: maintenant,
      updatedAt: maintenant,
    };
    await enregistrer([...liste, e]);
    journaliser("bibliotheque.dossier_cree", qui.userId, { element: e.id, visibilite: vis, groupes: groupes.length });
    return { ok: true, valeur: vue(e, qui) };
  });
}

/** Types reconnus aux premiers octets, pour ne pas croire l'extension sur parole à la relecture. */
function typeDe(nom: string, octets: Buffer): string {
  const ext = nom.split(".").pop()?.toLowerCase() ?? "";
  const debut = octets.subarray(0, 8).toString("latin1");
  if (debut.startsWith("%PDF")) return "application/pdf";
  if (octets[0] === 0x50 && octets[1] === 0x4b) {
    const office: Record<string, string> = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      odt: "application/vnd.oasis.opendocument.text",
      ods: "application/vnd.oasis.opendocument.spreadsheet",
      odp: "application/vnd.oasis.opendocument.presentation",
    };
    return office[ext] ?? "application/zip";
  }
  if (debut.startsWith("PNG")) return "image/png";
  if (octets[0] === 0xff && octets[1] === 0xd8) return "image/jpeg";
  const texte: Record<string, string> = { txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json" };
  return texte[ext] ?? "application/octet-stream";
}

/** Ancien format d'envoi (base64 dans un JSON), gardé pour un poste d'une version antérieure. */
export function importerDocument(brut: Record<string, unknown>, qui: Qui): Promise<Resultat<VueElement>> {
  const octets = typeof brut.contenu === "string" ? Buffer.from(brut.contenu, "base64") : Buffer.alloc(0);
  return importerDocumentEnFlux({ ...brut, taille: octets.length }, (async function* () {
    if (octets.length > 0) yield octets;
  })(), qui);
}

/**
 * Dépose un document reçu en flux (televersement.ts). Les droits sont vérifiés
 * avant de lire un seul octet du fichier ; l'écriture se fait hors de la file
 * d'attente de la bibliothèque, pour qu'un envoi d'un gigaoctet ne bloque pas
 * les autres pendant des minutes ; l'élément n'est inscrit qu'une fois le
 * contenu complet sur le disque, après une seconde vérification.
 */
export async function importerDocumentEnFlux(
  entete: Record<string, unknown>,
  fichier: AsyncIterable<Buffer>,
  qui: Qui,
): Promise<Resultat<VueElement>> {
  const nom = nomSur(entete.nom);
  if (!nom) return { ok: false, statut: 400, message: t("Nom de fichier invalide.") };
  const annonce = Number(entete.taille);
  if (Number.isFinite(annonce) && annonce > TAILLE_MAX) {
    return { ok: false, statut: 413, message: tf("« {0} » est trop lourd ({1} au plus).", nom, LIBELLE_DOCUMENT_MAX) };
  }
  const vis = visibilite(entete.visibilite);
  const groupes = vis === "groupes" ? await groupesAdmis(entete.groupes, qui) : [];
  if (vis === "groupes" && groupes.length === 0) return { ok: false, statut: 400, message: t("Choisissez au moins un de vos groupes.") };
  const verifier = async (): Promise<Resultat<string | null>> => {
    const liste = await charger();
    if (liste.length >= ELEMENTS_MAX) return { ok: false, statut: 409, message: t("La bibliothèque est pleine.") };
    return parentAdmis(liste, entete.parentId, qui);
  };
  const avant = await enFile(verifier);
  if (!avant.ok) return avant;
  mkdirSync(dossierFichiers(), { recursive: true, mode: 0o700 });
  if (!(await placeSuffisante(dossierFichiers(), Number.isFinite(annonce) && annonce > 0 ? annonce : 0))) {
    return { ok: false, statut: 507, message: MESSAGE_DISQUE_PLEIN };
  }

  const id = `bib_${randomBytes(9).toString("base64url")}`;
  // Les premiers octets disent le type réel du fichier ; on les garde au passage.
  let premiers = Buffer.alloc(0);
  async function* observe(): AsyncGenerator<Buffer> {
    for await (const b of fichier) {
      if (premiers.length < 16) premiers = Buffer.concat([premiers, b.subarray(0, 16 - premiers.length)]);
      yield b;
    }
  }
  const ecrit = await ecrireEnFlux(observe(), cheminContenu(id), `bibliotheque:${id}`, TAILLE_MAX);
  if (!ecrit.ok) return { ok: false, statut: 413, message: tf("« {0} » est trop lourd ({1} au plus).", nom, LIBELLE_DOCUMENT_MAX) };
  if (ecrit.octets === 0) {
    effacerContenu(id);
    return { ok: false, statut: 400, message: t("Document vide.") };
  }
  const texte = typeof entete.texte === "string" ? entete.texte.slice(0, TEXTE_MAX) : "";
  if (texte.trim()) {
    writeFileSync(cheminTexte(id), chiffrerOctets(Buffer.from(texte, "utf8"), `bibliotheque:${id}:texte`), { mode: 0o600, flag: "wx" });
  }

  return enFile(async () => {
    // Le dossier a pu disparaître, ou cesser d'être visible, pendant l'envoi.
    const apres = await verifier();
    if (!apres.ok) {
      effacerContenu(id);
      return apres;
    }
    const maintenant = new Date().toISOString();
    const e: Element = {
      id,
      type: "document",
      nom,
      parentId: apres.valeur,
      ownerId: qui.userId,
      visibilite: vis,
      groupes,
      taille: ecrit.octets,
      typeMime: typeDe(nom, premiers),
      aTexte: Boolean(texte.trim()),
      favoris: [],
      createdAt: maintenant,
      updatedAt: maintenant,
    };
    await enregistrer([...(await charger()), e]);
    journaliser("bibliotheque.importe", qui.userId, { element: id, octets: ecrit.octets, visibilite: vis });
    return { ok: true, valeur: vue(e, qui) };
  });
}

/** Un dossier ne peut pas devenir son propre descendant. */
function descendants(liste: Element[], id: string): Set<string> {
  const trouves = new Set<string>();
  const pile = [id];
  while (pile.length > 0) {
    const courant = pile.pop()!;
    for (const e of liste) {
      if (e.parentId === courant && !trouves.has(e.id)) {
        trouves.add(e.id);
        pile.push(e.id);
      }
    }
  }
  return trouves;
}

export function modifierElement(id: string, brut: Record<string, unknown>, qui: Qui): Promise<Resultat<VueElement>> {
  return enFile(async () => {
    const liste = await charger();
    const e = liste.find((x) => x.id === id);
    if (!e || !peutVoir(e, qui)) return { ok: false, statut: 404, message: t("Élément introuvable.") };
    if (e.ownerId !== qui.userId) return { ok: false, statut: 403, message: t("Seul son propriétaire peut le modifier.") };
    if (brut.nom !== undefined) {
      const nom = nomSur(brut.nom);
      if (!nom) return { ok: false, statut: 400, message: t("Donnez-lui un nom.") };
      e.nom = nom;
    }
    if (brut.parentId !== undefined) {
      const parent = parentAdmis(liste, brut.parentId, qui);
      if (!parent.ok) return parent;
      if (parent.valeur && (parent.valeur === e.id || descendants(liste, e.id).has(parent.valeur))) {
        return { ok: false, statut: 400, message: t("Un dossier ne peut pas aller dans lui-même.") };
      }
      e.parentId = parent.valeur;
    }
    const avant = e.visibilite;
    if (brut.visibilite !== undefined) {
      e.visibilite = visibilite(brut.visibilite);
      e.groupes = e.visibilite === "groupes" ? await groupesAdmis(brut.groupes, qui) : [];
      if (e.visibilite === "groupes" && e.groupes.length === 0) {
        return { ok: false, statut: 400, message: t("Choisissez au moins un de vos groupes.") };
      }
    }
    if (e.type === "dossier") {
      if (brut.emoji !== undefined) e.emoji = emojiSur(brut.emoji);
      if (brut.couleur !== undefined) e.couleur = COULEURS.includes(brut.couleur as Couleur) ? (brut.couleur as Couleur) : undefined;
    }
    e.updatedAt = new Date().toISOString();
    await enregistrer(liste);
    journaliser("bibliotheque.modifie", qui.userId, {
      element: id,
      ...(avant !== e.visibilite || brut.groupes !== undefined ? { visibilite: e.visibilite, groupes: e.groupes.length } : {}),
    });
    return { ok: true, valeur: vue(e, qui) };
  });
}

export function marquerFavori(id: string, favori: boolean, qui: Qui): Promise<Resultat<null>> {
  return enFile(async () => {
    const liste = await charger();
    const e = liste.find((x) => x.id === id);
    if (!e || !peutVoir(e, qui)) return { ok: false, statut: 404, message: t("Élément introuvable.") };
    e.favoris = favori ? [...new Set([...e.favoris, qui.userId])] : e.favoris.filter((f) => f !== qui.userId);
    await enregistrer(liste);
    return { ok: true, valeur: null };
  });
}

function effacerContenu(id: string): void {
  rmSync(cheminContenu(id), { force: true });
  rmSync(cheminTexte(id), { force: true });
}

/**
 * Supprime un élément, et le contenu d'un dossier avec lui. Un dossier qui
 * contient des documents de collègues ne se supprime pas d'un bloc : ce
 * n'est pas à son propriétaire de faire disparaître le travail des autres.
 */
export function supprimerElement(id: string, qui: Qui): Promise<Resultat<{ supprimes: number; documents: string[] }>> {
  return enFile(async () => {
    const liste = await charger();
    const e = liste.find((x) => x.id === id);
    if (!e || !peutVoir(e, qui)) return { ok: false, statut: 404, message: t("Élément introuvable.") };
    if (e.ownerId !== qui.userId) return { ok: false, statut: 403, message: t("Seul son propriétaire peut le supprimer.") };
    const sous = descendants(liste, id);
    const autrui = liste.filter((x) => sous.has(x.id) && x.ownerId !== qui.userId).length;
    if (autrui > 0) {
      return {
        ok: false,
        statut: 409,
        message:
          autrui > 1
            ? tf("Ce dossier contient {0} éléments déposés par des collègues : demandez-leur de les déplacer, ou videz-le d'abord.", autrui)
            : tf("Ce dossier contient {0} élément déposé par un collègue : demandez-lui de le déplacer, ou videz-le d'abord.", autrui),
      };
    }
    const partent = new Set([id, ...sous]);
    for (const x of partent) effacerContenu(x);
    await enregistrer(liste.filter((x) => !partent.has(x.id)));
    journaliser("bibliotheque.supprime", qui.userId, { element: id, supprimes: partent.size });
    // Les documents partis : l'appelant les retire des bases de connaissances (index.ts), qui les indexaient.
    const documents = liste.filter((x) => partent.has(x.id) && x.type === "document").map((x) => x.id);
    return { ok: true, valeur: { supprimes: partent.size, documents } };
  });
}

function lireTexteBrut(id: string): string {
  try {
    return existsSync(cheminTexte(id)) ? dechiffrerOctets(readFileSync(cheminTexte(id)), `bibliotheque:${id}:texte`).toString("utf8") : "";
  } catch {
    return "";
  }
}

/**
 * Le document tel qu'il a été déposé, en flux : il est déchiffré tranche par
 * tranche pendant qu'il part, sans jamais être tenu en entier en mémoire.
 */
export async function lireContenu(
  id: string,
  qui: Qui,
): Promise<Resultat<{ nom: string; type: string; taille: number; flux: AsyncGenerator<Buffer> }>> {
  const e = (await charger()).find((x) => x.id === id);
  if (!e || e.type !== "document" || !peutVoir(e, qui)) return { ok: false, statut: 404, message: t("Document introuvable.") };
  if (!existsSync(cheminContenu(id))) return { ok: false, statut: 410, message: t("Le contenu de ce document a disparu du disque de l'instance.") };
  const flux = lireEnFlux(cheminContenu(id), `bibliotheque:${id}`);
  // La première tranche est lue avant de répondre : une clé perdue ou un fichier abîmé se disent par une erreur, pas par un téléchargement coupé.
  let premiere: IteratorResult<Buffer>;
  try {
    premiere = await flux.next();
  } catch (err) {
    return { ok: false, statut: 500, message: err instanceof Error ? err.message : String(err) };
  }
  async function* suite(): AsyncGenerator<Buffer> {
    if (!premiere.done) yield premiere.value;
    yield* flux;
  }
  if (e.ownerId !== qui.userId) journaliser("bibliotheque.consulte", qui.userId, { element: id });
  return { ok: true, valeur: { nom: e.nom, type: e.typeMime ?? "application/octet-stream", taille: e.taille ?? 0, flux: suite() } };
}

/** Texte d'un document visible, pour un agent ou la recherche ; `null` sinon. */
export async function lireTexte(id: string, qui: Qui): Promise<{ nom: string; texte: string } | null> {
  const e = (await charger()).find((x) => x.id === id);
  if (!e || e.type !== "document" || !peutVoir(e, qui)) return null;
  return { nom: e.nom, texte: lireTexteBrut(id) };
}

/** Documents visibles d'une personne, pour les outils des agents. */
export async function documentsVisibles(qui: Qui): Promise<Element[]> {
  return (await charger()).filter((e) => e.type === "document" && peutVoir(e, qui));
}

/**
 * Identifiants de tous les documents, sans rien d'autre : une base de
 * connaissances (connaissances.ts) distingue ainsi un document supprimé d'un
 * document seulement caché à la personne qui regarde.
 */
export async function idsDocuments(): Promise<string[]> {
  return (await charger()).filter((e) => e.type === "document").map((e) => e.id);
}

/** Chemin lisible d'un élément (« Clients / Dupont »), pour les agents. */
/**
 * Le chemin d'un élément, tel que `qui` peut le voir : on s'arrête au premier
 * dossier qu'il ne voit pas (revue du 26/09/2026 : le nom de dossiers privés
 * d'un collègue sortait par la recherche et par la liste des documents des
 * bases de connaissances). Au-delà, « … ».
 */
export async function cheminDe(id: string, qui: Qui): Promise<string> {
  const liste = await charger();
  const parId = new Map(liste.map((e) => [e.id, e]));
  const noms: string[] = [];
  for (let p = parId.get(id)?.parentId ? parId.get(parId.get(id)!.parentId!) : undefined; p && noms.length < 20; p = p.parentId ? parId.get(p.parentId) : undefined) {
    if (!peutVoir(p, qui)) {
      noms.unshift("…");
      break;
    }
    noms.unshift(p.nom);
  }
  return noms.join(" / ");
}

/* ---- Effacement et export d'un compte ------------------------------ */

export async function elementsDe(userId: string): Promise<Element[]> {
  return (await charger()).filter((e) => e.ownerId === userId);
}

/**
 * Effacement d'un compte : ses documents et ses dossiers partent, contenus
 * compris. Ce que des collègues avaient déposé dans ses dossiers revient à la
 * racine, chez eux : ce n'était pas à lui.
 */
export function oublierPersonneBibliotheque(userId: string): Promise<number> {
  return enFile(async () => {
    const liste = await charger();
    const siens = new Set(liste.filter((e) => e.ownerId === userId).map((e) => e.id));
    if (siens.size === 0) {
      // Ses favoris seulement.
      if (liste.some((e) => e.favoris.includes(userId))) {
        await enregistrer(liste.map((e) => ({ ...e, favoris: e.favoris.filter((f) => f !== userId) })));
      }
      return 0;
    }
    for (const id of siens) effacerContenu(id);
    const reste = liste
      .filter((e) => !siens.has(e.id))
      .map((e) => ({
        ...e,
        parentId: e.parentId && siens.has(e.parentId) ? null : e.parentId,
        favoris: e.favoris.filter((f) => f !== userId),
      }));
    await enregistrer(reste);
    return siens.size;
  });
}

/* ---- Outils des agents --------------------------------------------- */

/**
 * La bibliothèque vue d'un agent : chercher, puis lire. En lecture seule.
 * L'agent du Chat voit ce que voit la personne qui lui parle ; un agent
 * toujours actif (employé OpenClaw) ne voit que ce qui est ouvert à toute
 * l'équipe, puisque plusieurs personnes lui parlent.
 */
export function toolsForModel(): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  return [
    {
      type: "function",
      function: {
        name: "bibliotheque__chercher",
        description:
          "Cherche des documents dans la bibliothèque de l'équipe, par leur nom ou leur contenu. Rend pour chacun son " +
          "identifiant, son nom, son dossier et un extrait. Pour lire un document, rappelle « bibliotheque__lire ».",
        parameters: {
          type: "object",
          properties: {
            texte: { type: "string", description: "Mots à chercher, dans le nom ou dans le texte des documents." },
            nombre: { type: "number", description: "Nombre de documents, 10 par défaut, 30 au plus." },
          },
          required: ["texte"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "bibliotheque__lire",
        description:
          "Rend le texte d'un document de la bibliothèque, à partir de l'identifiant donné par « bibliotheque__chercher », " +
          "par passages de 15 000 caractères. Un long document se lit en plusieurs appels : la réponse dit où reprendre. " +
          "Pour aller droit à un passage trouvé par la recherche, donne sa position dans « depuis ».",
        parameters: {
          type: "object",
          properties: {
            identifiant: { type: "string", description: "Identifiant du document (bib_…)." },
            depuis: { type: "number", description: "Position (en caractères) où commencer la lecture. 0 par défaut." },
          },
          required: ["identifiant"],
        },
      },
    },
  ];
}

/** Un passage tient sous la coupe des résultats d'outil de la boucle du Chat (20 000, chat.ts). */
const LECTURE_MAX = 15_000;

/**
 * Minuscules sans accents, caractère pour caractère : la position d'un mot
 * trouvé dans le texte replié est aussi sa position dans le texte d'origine.
 * `replier` (NFD) allonge le texte à chaque accent, et l'extrait rendu par la
 * recherche glissait d'autant de caractères que de lettres accentuées avant lui.
 */
const plier = (t: string) =>
  t
    .split("")
    .map((c) => c.toLocaleLowerCase("fr").normalize("NFD")[0] ?? c)
    .join("");

export async function callTool(nom: string, args: Record<string, unknown>, qui: Qui): Promise<{ ok: boolean; content: string }> {
  if (nom === "bibliotheque__chercher") {
    const texte = typeof args.texte === "string" ? args.texte.trim().slice(0, 200) : "";
    if (!texte) return { ok: false, content: "Donne les mots à chercher dans « texte »." };
    const combien = Math.min(30, Math.max(1, Math.trunc(Number(args.nombre)) || 10));
    const terme = replier(texte);
    const mots = terme.split(/\s+/).filter(Boolean);
    const trouves: { e: Element; extrait: string; score: number; position: number; longueur: number }[] = [];
    for (const e of await documentsVisibles(qui)) {
      const nomReplie = replier(e.nom);
      const corps = e.aTexte ? lireTexteBrut(e.id) : "";
      const corpsReplie = plier(corps);
      const score = mots.reduce((n, m) => n + (nomReplie.includes(m) ? 3 : 0) + (corpsReplie.includes(m) ? 1 : 0), 0);
      if (score === 0) continue;
      const i = corpsReplie.indexOf(mots[0]!);
      const extrait = i >= 0 ? corps.slice(Math.max(0, i - 120), i + 240).replace(/\s+/g, " ").trim() : "";
      trouves.push({ e, extrait, score, position: i, longueur: corps.length });
    }
    trouves.sort((a, b) => b.score - a.score);
    /*
     * Rien trouvé : le dire, et dire quoi faire ensuite.
     *
     * « Aucun document ne parle de X », seul, un petit modèle le lit comme
     * « l'information n'existe pas ». Cas réel : une question générale sur la
     * batterie d'un iPhone, quatre recherches dans la bibliothèque de
     * l'équipe, puis « je n'ai pas cette information » — alors que le modèle,
     * interrogé sans outils, y répondait très bien. La suite est donc écrite
     * noir sur blanc : ne pas relancer, répondre avec ce qu'il sait.
     */
    if (trouves.length === 0) {
      return {
        ok: true,
        content:
          `Aucun document de la bibliothèque ne parle de « ${texte} ». Ne relance pas de recherche. ` +
          "Si la question est générale, réponds directement avec tes propres connaissances ; " +
          "sinon, dis simplement que l'équipe n'a pas de document sur ce sujet.",
      };
    }
    const lignes = await Promise.all(
      trouves.slice(0, combien).map(async ({ e, extrait, position, longueur }) => {
        const ou = await cheminDe(e.id, qui);
        return [
          `Identifiant : ${e.id}`,
          `Nom : ${e.nom}`,
          `Dossier : ${ou || "racine"}`,
          extrait ? `Extrait : …${extrait}…` : "Extrait : (pas de texte lisible)",
          ...(position >= 0 && longueur > LECTURE_MAX
            ? [`Position de l'extrait : ${position} sur ${longueur} caractères (pour y lire, depuis = ${Math.max(0, position - 2000)})`]
            : []),
        ].join("\n");
      }),
    );
    return { ok: true, content: `${lignes.length} document(s) sur ${trouves.length} trouvé(s) :\n\n${lignes.join("\n\n---\n\n")}` };
  }
  if (nom === "bibliotheque__lire") {
    const id = typeof args.identifiant === "string" ? args.identifiant.trim() : "";
    const doc = id ? await lireTexte(id, qui) : null;
    if (!doc) return { ok: false, content: "Aucun document de la bibliothèque ne porte cet identifiant, ou il ne t'est pas accessible." };
    if (!doc.texte.trim()) {
      return { ok: true, content: `« ${doc.nom} » n'a pas de texte lisible (image, PDF scanné, ou format sans texte). Dis-le à l'utilisateur.` };
    }
    const total = doc.texte.length;
    const depuis = Math.max(0, Math.trunc(Number(args.depuis)) || 0);
    if (depuis >= total) return { ok: true, content: `Fin de « ${doc.nom} » : le document fait ${total} caractères.` };
    const fin = Math.min(total, depuis + LECTURE_MAX);
    const entier = depuis === 0 && fin === total;
    const repere = entier
      ? ""
      : fin < total
        ? `\n\n[Caractères ${depuis} à ${fin} sur ${total}. Pour la suite, rappelle « bibliotheque__lire » avec depuis = ${fin}.]`
        : `\n\n[Caractères ${depuis} à ${fin} sur ${total} : fin du document.]`;
    return {
      ok: true,
      content: `Document « ${doc.nom} »${entier ? "" : ` (passage de ${depuis} à ${fin} sur ${total} caractères)`} :\n\n${doc.texte.slice(depuis, fin)}${repere}`,
    };
  }
  return { ok: false, content: `Outil inconnu : ${nom}.` };
}
