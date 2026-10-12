/**
 * Roblox Studio : ce que ses outils font, d'après la documentation de Roblox
 * (12/10/2026, demande de Medhi : « un MCP pour Roblox et Blender »).
 *
 * Module sans dépendance, pour que la barrière d'approbation (approbation.ts)
 * se charge seule, comme l'exige la batterie de sécurité. Le lancement du
 * serveur et la reconnaissance de Roblox Studio sont dans roblox.ts.
 *
 * D'où vient la liste : https://create.roblox.com/docs/studio/mcp, lue le
 * 12/10/2026 (serveur MCP intégré à Roblox Studio ; l'ancien dépôt
 * `Roblox/studio-rust-mcp-server` est archivé depuis avril 2026). Roblox
 * Studio est un logiciel propriétaire : Helix n'en distribue rien et n'en lit
 * aucun code, il lance le serveur que la personne a installé avec Studio.
 * Un outil qu'une version de Studio ajouterait, ou renommerait, n'est pas
 * dans ces listes : il est traité comme une écriture (carte à chaque appel).
 */

/** Identifiant du connecteur, et préfixe de ses outils (`roblox__script_read`). */
export const ID_ROBLOX = "roblox";

/**
 * Lectures : elles ne changent ni la place ouverte, ni ses scripts, ni le
 * compte. Relevé du 12/10/2026 :
 *  - `script_read`, `script_search`, `script_grep` : les scripts de la place ;
 *  - `search_game_tree`, `inspect_instance` : l'arbre des instances ;
 *  - `get_studio_state`, `get_console_output`, `list_roblox_studios` : l'état
 *    de Studio, sa console, les Studio ouverts ;
 *  - `screen_capture` : une image de la vue ;
 *  - `skill` : des fiches de bonnes pratiques livrées avec Studio ;
 *  - `wait_job_finished` : attend la fin d'une génération déjà acceptée ;
 *  - `search_asset` et `http_get` : une recherche dans le Creator Store et une
 *    page de la documentation de Roblox (adresses permises par Studio). Elles
 *    partent chez Roblox, comme tout ce que fait Studio, connecté au compte
 *    Roblox de la personne ; rien de la place n'y est joint par l'outil
 *    lui-même (SECURITE.md § 65).
 *
 * Écartés, bien qu'ils semblent lire : `store_image` (charge **un fichier de
 * la machine**, hors du dossier de travail) et `subagent` (un « playtest »
 * agit sur la place). Ils passent par la carte, comme tout le reste.
 */
export const LECTURES_ROBLOX = new Set([
  "script_read",
  "script_search",
  "script_grep",
  "search_game_tree",
  "inspect_instance",
  "get_studio_state",
  "get_console_output",
  "screen_capture",
  "list_roblox_studios",
  "search_asset",
  "http_get",
  "skill",
  "wait_job_finished",
]);

/** Générations par l'IA de Roblox : chez Roblox, hors de la machine, au nom du compte. */
export const GENERATIONS_ROBLOX = new Set(["generate_mesh", "generate_material", "generate_procedural_model"]);

/** Ce qui envoie une image vers les serveurs de Roblox (téléversement au compte). */
const TELEVERSEMENTS_ROBLOX = new Set(["upload_image"]);

function court(outil: string): string | null {
  return outil.startsWith(`${ID_ROBLOX}__`) ? outil.slice(ID_ROBLOX.length + 2) : null;
}

/** Un outil de Roblox Studio qui ne fait que lire. */
export const estLectureRoblox = (outil: string): boolean => {
  const nom = court(outil);
  return nom !== null && LECTURES_ROBLOX.has(nom);
};

/** Un outil de Roblox Studio qui n'est pas une lecture reconnue : il modifie, exécute, génère, ou on ne le connaît pas. */
export const estEcritureRoblox = (outil: string): boolean => court(outil) !== null && !estLectureRoblox(outil);

/** Ce qui sort de la machine avec cet appel, pour que la carte le dise dans la langue de l'écran (ToolApproval.tsx). */
export function horsMachineRoblox(outil: string): "roblox-generation" | "roblox-televersement" | null {
  const nom = court(outil);
  if (nom === null) return null;
  if (GENERATIONS_ROBLOX.has(nom)) return "roblox-generation";
  if (TELEVERSEMENTS_ROBLOX.has(nom)) return "roblox-televersement";
  return null;
}

/** La phrase de la carte d'accord (en français, comme les autres : approbation.ts). */
export function resumeRoblox(outil: string, args: Record<string, unknown>): string | null {
  const nom = court(outil);
  if (nom === null) return null;
  const texte = (v: unknown, n = 160) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, n) + (v.trim().length > n ? " …" : "") : "");
  const invite = texte(args.prompt) ? ` : « ${texte(args.prompt)} »` : "";
  const chemin = texte(args.path ?? args.script_path ?? args.file_path, 120);
  switch (nom) {
    case "execute_luau":
      return "exécuter du code Luau dans Roblox Studio, sur la place ouverte";
    case "multi_edit":
      return `modifier un script dans Roblox Studio${chemin ? ` (« ${chemin} »)` : ""}`;
    case "insert_asset":
      return "insérer un élément du Creator Store dans la place ouverte de Roblox Studio";
    case "generate_mesh":
      return `générer un objet 3D par l'IA de Roblox${invite} ; la demande part chez Roblox, hors de cette machine, au nom du compte Roblox ouvert dans Studio`;
    case "generate_material":
      return `générer un matériau par l'IA de Roblox${invite} ; la demande part chez Roblox, hors de cette machine, au nom du compte Roblox ouvert dans Studio`;
    case "generate_procedural_model":
      return `construire un modèle par l'IA de Roblox${invite} ; la demande part chez Roblox, hors de cette machine, au nom du compte Roblox ouvert dans Studio`;
    case "upload_image":
      return "téléverser une image sur les serveurs de Roblox, au nom du compte Roblox ouvert dans Studio";
    case "store_image":
      return `faire lire un fichier image de cette machine par Roblox Studio${chemin ? ` (« ${chemin} »)` : ""}`;
    case "start_stop_play":
      return "lancer ou arrêter un essai de jeu dans Roblox Studio";
    case "character_navigation":
      return "déplacer le personnage dans l'essai de jeu de Roblox Studio";
    case "user_keyboard_input":
      return "envoyer des touches du clavier à l'essai de jeu de Roblox Studio";
    case "user_mouse_input":
      return "envoyer des gestes de la souris à l'essai de jeu de Roblox Studio";
    case "subagent":
      return "lancer un sous-agent de Roblox Studio (exploration ou essai de jeu) sur la place ouverte";
  }
  if (LECTURES_ROBLOX.has(nom)) return `lire la place ouverte dans Roblox Studio (outil « ${nom} »)`;
  return `agir dans Roblox Studio (outil « ${nom} »)`;
}
