import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { publicAccounts } from "./accounts.ts";
import { journaliser } from "./audit.ts";
import { t, tf } from "./langue.ts";

/**
 * Groupes de l'équipe : des personnes réunies sous un nom (« Comptabilité »,
 * « Direction »), à qui l'on partage d'un geste une conversation ou un dossier
 * de la bibliothèque.
 *
 * Tenus par l'instance, pas par les postes : qui appartient à quel groupe
 * décide de ce que chacun voit (`authz.ts`, `bibliotheque.ts`), c'est donc
 * l'instance qui fait foi, et ses routes qui vérifient qui a le droit de
 * changer quoi.
 *
 * Règles :
 *  - chacun voit la liste des groupes et de leurs membres : c'est l'annuaire
 *    de l'équipe, comme la liste des comptes à l'écran de connexion ;
 *  - chacun peut créer un groupe, dont il devient responsable ;
 *  - seuls les responsables renomment, ajoutent ou retirent des membres,
 *    nomment d'autres responsables, suppriment ;
 *  - un membre peut toujours quitter un groupe. Le dernier responsable ne le
 *    peut qu'après en avoir nommé un autre, pour qu'aucun groupe ne reste sans
 *    personne pour le gérer.
 */

export interface Groupe {
  id: string;
  nom: string;
  description: string;
  membres: string[];
  responsables: string[];
  creePar: string;
  createdAt: string;
  updatedAt: string;
}

type Resultat<T> = { ok: true; valeur: T } | { ok: false; statut: number; message: string };

const COLLECTION = "groupes";
const NOM_MAX = 60;
const DESCRIPTION_MAX = 500;
const MEMBRES_MAX = 500;

async function charger(): Promise<Groupe[]> {
  const v = await db().read(COLLECTION);
  return Array.isArray(v) ? (v as Groupe[]) : [];
}

async function enregistrer(liste: Groupe[]): Promise<void> {
  await db().write(COLLECTION, liste);
}

/** Même file que les comptes : deux modifications simultanées ne s'écrasent pas. */
let file: Promise<unknown> = Promise.resolve();
function enFile<T>(travail: () => Promise<T>): Promise<T> {
  const suite = file.then(travail, travail);
  file = suite.catch(() => undefined);
  return suite;
}

export async function listerGroupes(): Promise<Groupe[]> {
  return charger();
}

/** Groupes dont une personne est membre : ce qu'on lui a partagé « par groupe », elle le voit. */
export async function groupesDe(qui: string): Promise<string[]> {
  /*
   * Groupes illisibles : la personne n'est d'aucun groupe le temps que ça dure
   * (relecture du 27/09/2026). Elle voit moins, jamais plus ; avant, chaque
   * requête échouait, pour tout le monde.
   */
  try {
    return (await charger()).filter((g) => g.membres.includes(qui)).map((g) => g.id);
  } catch (err) {
    console.error(`[oxoai] groupes illisibles, ignorés pour les droits : ${(err as Error).message}`);
    return [];
  }
}

const texte = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Identifiants de comptes existants, sans doublon. */
async function comptesValides(v: unknown): Promise<string[]> {
  if (!Array.isArray(v)) return [];
  const existants = new Set((await publicAccounts()).map((c) => c.id));
  return [...new Set(v.filter((x): x is string => typeof x === "string" && existants.has(x)))].slice(0, MEMBRES_MAX);
}

const nomPris = (liste: Groupe[], nom: string, sauf?: string) =>
  liste.some((g) => g.id !== sauf && g.nom.toLocaleLowerCase("fr") === nom.toLocaleLowerCase("fr"));

export function creerGroupe(brut: Record<string, unknown>, qui: string): Promise<Resultat<Groupe>> {
  return enFile(async () => {
    const nom = texte(brut.nom, NOM_MAX);
    if (!nom) return { ok: false, statut: 400, message: t("Donnez un nom au groupe.") };
    const liste = await charger();
    if (nomPris(liste, nom)) return { ok: false, statut: 409, message: tf("Un groupe s'appelle déjà « {0} ».", nom) };
    const maintenant = new Date().toISOString();
    const g: Groupe = {
      id: `grp_${randomBytes(8).toString("base64url")}`,
      nom,
      description: texte(brut.description, DESCRIPTION_MAX),
      membres: [...new Set([qui, ...(await comptesValides(brut.membres))])],
      responsables: [qui],
      creePar: qui,
      createdAt: maintenant,
      updatedAt: maintenant,
    };
    await enregistrer([...liste, g]);
    journaliser("groupe.cree", qui, { groupe: g.id, membres: g.membres.length });
    return { ok: true, valeur: g };
  });
}

/**
 * Modifie un groupe : nom, description, membres, responsables. Réservé à ses
 * responsables. Un responsable est forcément membre, et il en reste toujours un.
 */
export function modifierGroupe(id: string, brut: Record<string, unknown>, qui: string): Promise<Resultat<Groupe>> {
  return enFile(async () => {
    const liste = await charger();
    const g = liste.find((x) => x.id === id);
    if (!g) return { ok: false, statut: 404, message: t("Groupe introuvable.") };
    if (!g.responsables.includes(qui)) {
      return { ok: false, statut: 403, message: t("Seuls les responsables du groupe peuvent le modifier.") };
    }
    if (brut.nom !== undefined) {
      const nom = texte(brut.nom, NOM_MAX);
      if (!nom) return { ok: false, statut: 400, message: t("Donnez un nom au groupe.") };
      if (nomPris(liste, nom, id)) return { ok: false, statut: 409, message: tf("Un groupe s'appelle déjà « {0} ».", nom) };
      g.nom = nom;
    }
    if (brut.description !== undefined) g.description = texte(brut.description, DESCRIPTION_MAX);
    const avant = new Set(g.membres);
    if (brut.membres !== undefined) g.membres = await comptesValides(brut.membres);
    if (brut.responsables !== undefined) g.responsables = await comptesValides(brut.responsables);
    g.responsables = g.responsables.filter((r) => g.membres.includes(r));
    if (g.responsables.length === 0) {
      return { ok: false, statut: 400, message: t("Un groupe garde au moins un responsable parmi ses membres.") };
    }
    g.updatedAt = new Date().toISOString();
    await enregistrer(liste);
    const ajoutes = g.membres.filter((m) => !avant.has(m)).length;
    const retires = [...avant].filter((m) => !g.membres.includes(m)).length;
    journaliser("groupe.modifie", qui, { groupe: id, ajoutes, retires, responsables: g.responsables.length });
    return { ok: true, valeur: g };
  });
}

export function quitterGroupe(id: string, qui: string): Promise<Resultat<null>> {
  return enFile(async () => {
    const liste = await charger();
    const g = liste.find((x) => x.id === id);
    if (!g || !g.membres.includes(qui)) return { ok: false, statut: 404, message: t("Vous n'êtes pas membre de ce groupe.") };
    const autres = g.membres.filter((m) => m !== qui);
    if (autres.length > 0 && g.responsables.length === 1 && g.responsables[0] === qui) {
      return {
        ok: false,
        statut: 409,
        message: t("Vous êtes son seul responsable : nommez-en un autre avant de partir, ou supprimez le groupe."),
      };
    }
    const reste = autres.length === 0 ? liste.filter((x) => x.id !== id) : liste;
    if (autres.length > 0) {
      g.membres = autres;
      g.responsables = g.responsables.filter((r) => r !== qui);
      g.updatedAt = new Date().toISOString();
    }
    await enregistrer(reste);
    journaliser("groupe.quitte", qui, { groupe: id, supprime: autres.length === 0 });
    return { ok: true, valeur: null };
  });
}

export function supprimerGroupe(id: string, qui: string): Promise<Resultat<null>> {
  return enFile(async () => {
    const liste = await charger();
    const g = liste.find((x) => x.id === id);
    if (!g) return { ok: false, statut: 404, message: t("Groupe introuvable.") };
    if (!g.responsables.includes(qui)) {
      return { ok: false, statut: 403, message: t("Seuls les responsables du groupe peuvent le supprimer.") };
    }
    await enregistrer(liste.filter((x) => x.id !== id));
    journaliser("groupe.supprime", qui, { groupe: id, membres: g.membres.length });
    return { ok: true, valeur: null };
  });
}

/**
 * Effacement d'un compte : il sort de tous ses groupes. Un groupe resté sans
 * responsable en reçoit un (son plus ancien membre, le premier de la liste) ;
 * un groupe resté vide disparaît.
 */
export function oublierPersonneGroupes(qui: string): Promise<number> {
  return enFile(async () => {
    const liste = await charger();
    let touches = 0;
    const reste: Groupe[] = [];
    for (const g of liste) {
      if (!g.membres.includes(qui) && !g.responsables.includes(qui) && g.creePar !== qui) {
        reste.push(g);
        continue;
      }
      touches += 1;
      g.membres = g.membres.filter((m) => m !== qui);
      g.responsables = g.responsables.filter((r) => r !== qui);
      if (g.creePar === qui) g.creePar = "";
      if (g.membres.length === 0) continue;
      if (g.responsables.length === 0) g.responsables = [g.membres[0]!];
      reste.push(g);
    }
    if (touches > 0) await enregistrer(reste);
    return touches;
  });
}
