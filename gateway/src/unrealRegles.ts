/**
 * Unreal Editor : ce que font les outils de son serveur MCP officiel
 * (16/10/2026, demande de Medhi : un connecteur Unreal Engine).
 *
 * Module sans dépendance, pour que la barrière d'approbation (approbation.ts)
 * se charge seule, comme l'exige la batterie de sécurité. La reconnaissance
 * de l'éditeur est dans unreal.ts.
 *
 * D'où vient la liste : la page « Unreal MCP in Unreal Editor » d'Epic
 * (https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor,
 * lue le 16/10/2026). Le plugin `ModelContextProtocol` (« Unreal MCP »,
 * expérimental, Unreal Engine 5.8) sert, avec « Enable Tool Search » (allumé
 * par défaut), trois outils :
 *  - `list_toolsets` : les noms et descriptions des jeux d'outils ;
 *  - `describe_toolset` : les schémas d'un jeu d'outils ;
 *  - `call_tool` : exécute un outil d'un jeu (créer des acteurs, régler la
 *    lumière, des matériaux, lancer des tests d'automatisation…).
 * Les deux premiers ne font que lire. La page ne donne ni le nom des outils
 * de chaque jeu (ActorTools, SceneTools, MaterialInstanceTools, ObjectTools…)
 * ni lesquels modifient : `call_tool` passe donc par la carte **à chaque
 * appel**, quel qu'il soit, et l'administrateur seul l'accepte. Réglage
 * « Enable Tool Search » éteint, l'éditeur annonce chaque outil sous son
 * propre nom : aucun n'est dans la liste des lectures, tous passent par la
 * carte. De même pour tout outil d'une version future.
 */

/** Identifiant du connecteur, et préfixe de ses outils (`unreal__list_toolsets`). */
export const ID_UNREAL = "unreal";

/** Lectures : elles ne changent ni le projet ni l'éditeur. */
export const LECTURES_UNREAL = new Set(["list_toolsets", "describe_toolset"]);

function court(outil: string): string | null {
  return outil.startsWith(`${ID_UNREAL}__`) ? outil.slice(ID_UNREAL.length + 2) : null;
}

export const estLectureUnreal = (outil: string): boolean => {
  const nom = court(outil);
  return nom !== null && LECTURES_UNREAL.has(nom);
};

/** Un outil d'Unreal Editor qui n'est pas une lecture reconnue : `call_tool`, ou un outil qu'on ne connaît pas. */
export const estEcritureUnreal = (outil: string): boolean => court(outil) !== null && !estLectureUnreal(outil);

/** Le premier texte non vide parmi ces champs (la page d'Epic ne donne pas leurs noms : on lit les plus probables). */
function champ(args: Record<string, unknown>, noms: string[], n = 80): string {
  for (const nom of noms) {
    const v = args[nom];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/\s+/g, " ").slice(0, n);
  }
  return "";
}

/** La phrase de la carte d'accord (en français, comme les autres : approbation.ts). Les arguments sont montrés en entier dessous. */
export function resumeUnreal(outil: string, args: Record<string, unknown>): string | null {
  const nom = court(outil);
  if (nom === null) return null;
  if (nom === "list_toolsets") return "lister les jeux d'outils d'Unreal Editor";
  if (nom === "describe_toolset") {
    const jeu = champ(args, ["toolset", "toolset_name", "toolsetName", "name"]);
    return `lire la description d'un jeu d'outils d'Unreal Editor${jeu ? ` (« ${jeu} »)` : ""}`;
  }
  if (nom === "call_tool") {
    const jeu = champ(args, ["toolset", "toolset_name", "toolsetName"]);
    const outilAppele = champ(args, ["tool", "tool_name", "toolName", "name"]);
    return `faire agir Unreal Editor sur le projet ouvert${outilAppele ? ` : outil « ${outilAppele} »` : ""}${jeu ? ` du jeu « ${jeu} »` : ""} (créer, modifier, exécuter ou lancer des tests, selon l'outil)`;
  }
  return `agir dans Unreal Editor (outil « ${nom} »)`;
}
