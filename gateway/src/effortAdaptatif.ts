/**
 * Le niveau de réflexion « adaptatif » (OxoAI, 26/10/2026).
 *
 * Un modèle local qui raisonne (Qwen 3.5, Qwen 3…) réfléchit à tout : mesuré
 * sur un Mac à puce Apple, Qwen 3.5 9B écrivait plus de 800 jetons de
 * réflexion pour un « salut » (plus de 16 s seul, 1 min 39 avec les consignes
 * de l'assistant), contre 0,3 s sans réflexion. Le niveau adaptatif choisit
 * donc, message par message, entre ne pas réfléchir, réfléchir un peu et
 * réfléchir vraiment.
 *
 * Le choix se fait ici, à la main, sans appeler de modèle : il doit être
 * instantané, sinon il coûterait le temps qu'il cherche à gagner. Il lit le
 * dernier message de la personne et tranche sur des signes simples :
 *
 *  - une salutation, un remerciement, un accusé de réception : aucun ;
 *  - du code, un bug, un plan, une analyse, une comparaison, une équation, une
 *    démonstration, « étape par étape », un long texte : moyen ;
 *  - une question courte, même un « pourquoi » ou un calcul simple : aucun.
 *    Mesuré avec Qwen 3.5 9B : sans réflexion, « Combien font 17 × 23 ? » et
 *    « Pourquoi le ciel est bleu ? » sont justes en 3 et 7 s ; avec, 30 s.
 *    Le niveau « faible » n'aide pas : sa durée varie de 5 à 31 s ;
 *  - une question plus longue où affleure un raisonnement (« pourquoi »,
 *    « combien », une opération) : moyen.
 *
 * Dans le doute, on réfléchit plutôt que pas : une réponse lente vaut mieux
 * qu'une réponse fausse sur une question qui le méritait.
 */
import type { ChatMessage } from "./types.ts";

export type NiveauChoisi = "aucun" | "faible" | "moyen";

/** Le texte d'un message, qu'il soit une chaîne ou une liste de parties (texte, image). */
function texteDe(contenu: unknown): { texte: string; images: number } {
  if (typeof contenu === "string") return { texte: contenu, images: 0 };
  if (!Array.isArray(contenu)) return { texte: "", images: 0 };
  let texte = "";
  let images = 0;
  for (const partie of contenu as Array<Record<string, unknown>>) {
    if (partie?.type === "text" && typeof partie.text === "string") texte += `${partie.text}\n`;
    else if (partie?.type === "image_url" || partie?.type === "image") images++;
  }
  return { texte, images };
}

/** Politesses et accusés de réception, seuls dans le message (français et anglais). */
const BANAL =
  /^(?:(?:salut|bonjour|bonsoir|coucou|hello|hey|hi|yo|re|wesh|slt|bjr|cc|merci(?: beaucoup| bien)?|thanks?(?: you)?|thx|ok(?:ay)?|d['’]accord|dac|super|g[ée]nial|parfait|top|cool|nickel|niquel|bien(?: vu| reçu)?|bonne (?:journ[ée]e|soir[ée]e|nuit)|[àa] plus|a\+|au revoir|bye|ciao|[çc]a va\s*\??|comment [çc]a va\s*\??|tu vas bien\s*\??|how are you\s*\??|oui|non|yes|no|ah|oh|haha+|lol|mdr)[\s!.,?😀-🙏👍👋🙂😊❤️]*)+$/iu;

const MOT = (motifs: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${motifs})(?![\\p{L}\\p{N}_])`, "iu");

/**
 * Ce qui demande toujours de raisonner, même en une ligne. Frontières de mot
 * en Unicode : `\b` ignore les lettres accentuées (« étape »).
 */
const EXIGEANT = [
  /```|`[^`\n]{3,}`/, // un bloc ou un extrait de code
  /(?<![\p{L}\p{N}_])(?:function|const|let|var|def|class|import|return|SELECT|FROM|WHERE)(?![\p{L}\p{N}_]).*[({=;:]/u, // du code collé
  MOT("r[ée]sou[ds]|r[ée]soudre|[ée]quations?|d[ée]montre[rz]?|prouve[rz]?|probabilit[ée]s?|statistiques?|d[ée]riv[ée]e|int[ée]grale"),
  MOT("analyse[rz]?|compare[rz]?|comparaison|[ée]value[rz]?|critique[rz]?|argumente[rz]?|justifie[rz]?|avantages? et (?:les )?inconv[ée]nients?|pour et (?:le )?contre"),
  MOT("plan|strat[ée]gie|architecture|algorithme|optimise[rz]?|refactor\\w*|d[ée]bogue[rz]?|debug\\w*|bug|erreur|exception|stack ?trace|corrige[rz]? (?:ce|mon|le|la|les)"),
  MOT("[ée]tape par [ée]tape|en d[ée]tail|en profondeur|de mani[èe]re (?:d[ée]taill[ée]e|approfondie)|r[ée]fl[ée]chis"),
  MOT("explain why|step by step|in depth|analy[sz]e|compare|prove|solve|debug|optimi[sz]e|trade-?offs?|pros and cons"),
];

/** Ce qui suggère un raisonnement, mais qu'un modèle tranche seul sur une question courte. */
const SUGGERE = [
  /\d\s*[-+*/×÷^%=]\s*\d/, // une opération
  MOT("calcule[rz]?|combien|pourquoi|en quoi|comment (?:se fait|expliquer)|diff[ée]rence|why|how many|how much|calculate"),
];

/** Une question courte : le modèle y répond juste sans réfléchir. */
const COURT = 160;

/** Le niveau à employer pour cette demande. */
export function choisirEffort(messages: ChatMessage[] | undefined): NiveauChoisi {
  const dernier = [...(messages ?? [])].reverse().find((m) => m?.role === "user");
  if (!dernier) return "faible";
  const { texte, images } = texteDe(dernier.content);
  const brut = texte.trim();
  // Une image à regarder sans question : on la décrit, sans plus.
  if (!brut) return images > 0 ? "faible" : "aucun";
  if (brut.length <= 60 && BANAL.test(brut)) return "aucun";
  if (brut.length > 1200) return "moyen";
  if (EXIGEANT.some((motif) => motif.test(brut))) return "moyen";
  if (brut.length > COURT && SUGGERE.some((motif) => motif.test(brut))) return "moyen";
  if (images > 0) return "faible";
  return brut.length <= 600 ? "aucun" : "faible";
}
