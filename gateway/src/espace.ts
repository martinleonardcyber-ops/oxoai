import { closeSync, constants, createReadStream, fstatSync, openSync, readdirSync, realpathSync, statSync } from "node:fs";
import { DOCUMENT_MAX, LIBELLE_DOCUMENT_MAX } from "./televersement.ts";
import { join, relative, isAbsolute, sep } from "node:path";
import { workspace } from "./mcp.ts";
import { t } from "./langue.ts";
import { estProtege } from "./zonesProtegees.ts";

/**
 * Parcourir le dossier de travail de l'équipe, et en relire un fichier.
 *
 * Sert au bouton « Depuis OxoAI » : confier à un agent un document qui est
 * déjà dans le dossier de l'équipe, sans passer par le Finder. Le périmètre est
 * celui que les agents ont déjà (le serveur de fichiers MCP, `mcp.ts`) : rien
 * hors du dossier de travail. Chaque chemin est résolu par `realpath` (liens
 * symboliques compris) puis comparé à la racine réelle, comme dans `bureau.ts`.
 */

const TAILLE_MAX = DOCUMENT_MAX;

export interface EntreeEspace {
  nom: string;
  /** Chemin relatif au dossier de travail. */
  chemin: string;
  dossier: boolean;
  taille?: number;
}

type Resultat<T> = { ok: true; valeur: T } | { ok: false; statut: number; message: string };

/** Chemin réel sous la racine du dossier de travail, ou refus. */
function resoudre(relatif: string): Resultat<{ racine: string; reel: string }> {
  let racine: string;
  try {
    racine = realpathSync(workspace());
  } catch {
    return { ok: false, statut: 404, message: t("Le dossier de travail de l'équipe est introuvable.") };
  }
  const demande = (relatif || "").replace(/^[/\\]+/, "");
  const segments = demande.split(/[/\\]/);
  if (isAbsolute(demande) || segments.includes("..")) {
    return { ok: false, statut: 400, message: t("Chemin refusé.") };
  }
  /*
   * Aucun segment en point (revue du 25/09/2026). La liste les cachait déjà ;
   * la lecture ne les refusait pas, et avec « Tout mon poste » le dossier de
   * l'équipe est le dossier personnel : `.oxoai/data/instance-token` se lisait
   * en 200 par n'importe quelle personne connectée. Un dossier caché n'est pas
   * un document d'équipe.
   */
  if (segments.some((s) => s.startsWith("."))) {
    return { ok: false, statut: 403, message: t("Chemin refusé.") };
  }
  let reel: string;
  try {
    reel = realpathSync(join(racine, demande));
  } catch {
    return { ok: false, statut: 404, message: t("Élément introuvable.") };
  }
  if (reel !== racine && !reel.startsWith(racine + sep)) {
    return { ok: false, statut: 403, message: t("Hors du dossier de travail.") };
  }
  // Chemin réel, liens résolus : un lien anodin vers les données de l'instance
  // ou vers ~/.ssh est refusé comme sa cible (zonesProtegees.ts).
  if (estProtege(reel)) {
    return { ok: false, statut: 403, message: t("Cet emplacement est protégé : ni l'équipe ni les agents n'y ont accès.") };
  }
  return { ok: true, valeur: { racine, reel } };
}

export function listerEspace(relatif: string): Resultat<{ chemin: string; entrees: EntreeEspace[] }> {
  const r = resoudre(relatif);
  if (!r.ok) return r;
  const { racine, reel } = r.valeur;
  let noms: string[];
  try {
    noms = readdirSync(reel);
  } catch {
    return { ok: false, statut: 400, message: t("Ce n'est pas un dossier.") };
  }
  const entrees: EntreeEspace[] = [];
  for (const nom of noms) {
    if (nom.startsWith(".")) continue;
    try {
      // Un lien qui sort du dossier n'est même pas montré (sa taille trahirait déjà la cible).
      const cible = realpathSync(join(reel, nom));
      if (cible !== racine && !cible.startsWith(racine + sep)) continue;
      // Les données de l'instance, les clés, les réglages : pas même le nom.
      if (estProtege(cible)) continue;
      const s = statSync(cible);
      entrees.push({
        nom,
        chemin: relative(racine, join(reel, nom)),
        dossier: s.isDirectory(),
        ...(s.isFile() ? { taille: s.size } : {}),
      });
    } catch {
      /* lien cassé : ignoré */
    }
  }
  entrees.sort((a, b) => Number(b.dossier) - Number(a.dossier) || a.nom.localeCompare(b.nom));
  return { ok: true, valeur: { chemin: relative(racine, reel), entrees: entrees.slice(0, 500) } };
}

/** Un fichier du dossier de l'équipe, en flux : il part tel quel, sans être tenu en mémoire. */
export function lireFichierEspace(relatif: string): Resultat<{ nom: string; taille: number; flux: AsyncIterable<Buffer> }> {
  const r = resoudre(relatif);
  if (!r.ok) return r;
  /*
   * Ouvert sans suivre de lien, puis mesuré sur le descripteur : un fichier
   * remplacé par un lien entre la vérification et la lecture n'emmène pas
   * hors du dossier, et la taille annoncée est celle de ce qui sera lu.
   */
  let fd: number;
  try {
    /*
     * O_NONBLOCK (tournée de la 2026.928.3, SECURITE.md § 43) : un tube nommé
     * (FIFO) du dossier faisait attendre `openSync` un écrivain, et avec lui
     * toute la passerelle, qui ne répondait plus à rien (essayé : /health muet).
     * Il s'ouvre maintenant tout de suite, et `isFile` le refuse. Sans effet sur
     * un fichier ordinaire ; absent sous Windows (0).
     */
    fd = openSync(r.valeur.reel, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { ok: false, statut: 404, message: t("Fichier introuvable.") };
  }
  const s = fstatSync(fd);
  const refus = (statut: number, message: string) => {
    closeSync(fd);
    return { ok: false as const, statut, message };
  };
  if (!s.isFile()) return refus(400, "Ce n'est pas un fichier.");
  if (s.size > TAILLE_MAX) return refus(413, `Fichier trop lourd (${LIBELLE_DOCUMENT_MAX} au plus).`);
  const nom = r.valeur.reel.split(sep).pop() ?? "document";
  if (s.size === 0) {
    closeSync(fd);
    return { ok: true, valeur: { nom, taille: 0, flux: (async function* () {})() } };
  }
  const flux = createReadStream("", { fd, start: 0, end: s.size - 1, highWaterMark: 1024 * 1024 });
  return { ok: true, valeur: { nom, taille: s.size, flux: flux as AsyncIterable<Buffer> } };
}
