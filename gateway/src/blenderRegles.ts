/**
 * Blender : ce que font les outils du serveur MCP « MCP for Blender »
 * (https://github.com/ahujasid/mcp-for-blender, licence MIT), lus dans son
 * code à la version épinglée (2.1.9, `blender_mcp/server.py`, 12/10/2026).
 *
 * Module sans dépendance, pour que la barrière d'approbation (approbation.ts)
 * se charge seule, comme l'exige la batterie de sécurité. L'installation du
 * serveur et la reconnaissance de Blender sont dans blender.ts.
 *
 * Le serveur sert aussi des outils réservés aux clients qui affichent des
 * « applications » (`viewport_*`, `open_viewport`, `search_mentions`) : il ne
 * les liste pas à un client qui ne le déclare pas, ce qui est le cas de
 * Helix. S'ils apparaissaient, ils ne sont dans aucune liste ci-dessous, donc
 * traités comme des écritures. De même pour tout outil d'une version future.
 */

/** Identifiant du connecteur, et préfixe de ses outils (`blender__get_scene_info`). */
export const ID_BLENDER = "blender";

/**
 * Lectures : elles ne changent pas la scène et rien ne sort de la machine.
 *  - `get_addon_status` : versions de Blender et du module, réglages ;
 *  - `get_scene_info` : la scène en texte ;
 *  - `look` : une image de la scène (« Every setting changed to take the
 *    picture is restored afterwards »). Son champ `image` peut aussi désigner
 *    un fichier de la machine : Helix refuse un chemin de fichier dans ce
 *    champ (`refusArgumentsBlender`), la lecture reste celle de la scène.
 *
 * Écartés : `search_assets` (une recherche chez Poly Haven, Sketchfab ou
 * Poly Pizza, hors de la machine), `import_asset` (télécharge et ajoute à la
 * scène), `generate_3d` (génération chez Hyper3D, Hunyuan3D ou Tripo, payante),
 * `execute_blender_code` (du Python exécuté dans Blender, sur cette machine),
 * `disable_telemetry` et `record_trajectory_feedback` (réglage et retour à
 * l'auteur du module ; la télémétrie est de toute façon coupée par Helix au
 * lancement, blender.ts). Ils passent par la carte, à chaque appel.
 */
export const LECTURES_BLENDER = new Set(["get_addon_status", "get_scene_info", "look"]);

/** Ce qui part vers un service extérieur, si la personne l'a allumé dans le module de Blender (éteint par défaut). */
const BIBLIOTHEQUES_BLENDER = new Set(["search_assets", "import_asset"]);
const GENERATIONS_BLENDER = new Set(["generate_3d"]);

function court(outil: string): string | null {
  return outil.startsWith(`${ID_BLENDER}__`) ? outil.slice(ID_BLENDER.length + 2) : null;
}

export const estLectureBlender = (outil: string): boolean => {
  const nom = court(outil);
  return nom !== null && LECTURES_BLENDER.has(nom);
};

/** Un outil de Blender qui n'est pas une lecture reconnue : il modifie, exécute, télécharge, génère, ou on ne le connaît pas. */
export const estEcritureBlender = (outil: string): boolean => court(outil) !== null && !estLectureBlender(outil);

export function horsMachineBlender(outil: string): "blender-bibliotheque" | "blender-generation" | null {
  const nom = court(outil);
  if (nom === null) return null;
  if (BIBLIOTHEQUES_BLENDER.has(nom)) return "blender-bibliotheque";
  if (GENERATIONS_BLENDER.has(nom)) return "blender-generation";
  return null;
}

/**
 * Un argument que Helix refuse avant tout appel, `null` sinon : le champ
 * `image` de `look` désigne une image de Blender (« Render Result », une image
 * du fichier) ou **un fichier de la machine**. Un chemin, Helix ne le passe
 * pas : ce serait lire hors du dossier de travail, sans les zones protégées
 * du serveur de fichiers (zonesProtegees.ts).
 */
export function refusArgumentsBlender(outil: string, args: Record<string, unknown>): string | null {
  if (court(outil) !== "look") return null;
  const image = args.image;
  if (typeof image === "string" && /[\\/]|^~|^[A-Za-z]:|\.(png|jpe?g|exr|hdr|tiff?|bmp|webp|tga)$/i.test(image.trim())) {
    return "Refusé : l'outil « look » de Blender ne lit pas un fichier de la machine par ce chemin. Montre la scène, ou une image déjà ouverte dans Blender (« Render Result »). Rien n'a été fait.";
  }
  return null;
}

/** La phrase de la carte d'accord (en français, comme les autres : approbation.ts). */
export function resumeBlender(outil: string, args: Record<string, unknown>): string | null {
  const nom = court(outil);
  if (nom === null) return null;
  const texte = (v: unknown, n = 160) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, n) + (v.trim().length > n ? " …" : "") : "");
  switch (nom) {
    case "execute_blender_code":
      return "exécuter du code Python dans Blender, sur cette machine";
    case "generate_3d":
      return `générer un objet 3D${texte(args.prompt) ? ` : « ${texte(args.prompt)} »` : ""} ; la demande part vers le service de génération réglé dans Blender (Hyper3D, Hunyuan3D ou Tripo), hors de cette machine, sur votre compte ou vos crédits chez lui`;
    case "search_assets":
      return `chercher des modèles ou des textures${texte(args.source, 40) ? ` chez ${texte(args.source, 40)}` : ""}${texte(args.query, 80) ? ` (« ${texte(args.query, 80)} »)` : ""} ; la recherche part hors de cette machine`;
    case "import_asset":
      return `télécharger un élément${texte(args.source, 40) ? ` de ${texte(args.source, 40)}` : ""} et l'ajouter à la scène de Blender`;
    case "disable_telemetry":
      return "couper la collecte de données dans le module de Blender";
    case "record_trajectory_feedback":
      return "noter un retour sur le dernier résultat dans le module de Blender";
  }
  if (LECTURES_BLENDER.has(nom)) return `lire la scène ouverte dans Blender (outil « ${nom} »)`;
  return `agir dans Blender (outil « ${nom} »)`;
}
