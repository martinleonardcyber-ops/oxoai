import { jetonsDesMessages, jetonsDunMessage, margeDeContexte, reservePourLaReponse } from "./documentsJoints.ts";

/**
 * Une conversation qui tient dans la place du modèle, coupée par Helix et
 * jamais par le moteur (27/09/2026).
 *
 * Vu par Medhi sur un PC Windows sans carte graphique (Ministral 3B, llmster) :
 * « le modèle des fois répondait bien et des fois un truc qui n'a rien à
 * voir ». Seuls les documents joints étaient mesurés contre la taille de
 * conversation chargée (documentsJoints.ts) ; l'historique, les consignes et
 * les outils partaient en entier, quelle que soit cette taille. Au-delà, c'est
 * LM Studio qui coupe, selon sa politique de dépassement (garder le début et
 * couper le milieu, faire glisser une fenêtre, ou s'arrêter), sans que Helix
 * ni la personne sachent ce que le modèle a encore sous les yeux : la consigne
 * système ou la question peuvent disparaître.
 *
 * Ici, quand l'estimation dépasse la place (la taille chargée, moins la
 * réponse, une marge et les outils) :
 *  1. les plus anciens échanges avant la question partent, un tour entier à la
 *     fois, pour que la conversation reprenne toujours sur un message de la
 *     personne (le gabarit de Mistral exige l'alternance) et qu'aucun résultat
 *     d'outil ne reste sans son appel ;
 *  2. puis, dans une boucle d'outils, les plus anciens résultats d'outils de la
 *     demande en cours sont abrégés (le plus récent reste entier) ;
 *  3. jamais la consigne système, ni la question, ni rien après elle. Ce qui a
 *     été retiré est dit au modèle, dans la consigne système, et à la personne
 *     par l'appelant.
 * Si cela ne suffit pas (une question énorme), rien de plus n'est retiré : les
 * documents ont leur propre lecture en parties, et le reste est dit au journal.
 */

type Message = { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };

export interface Ajustement {
  messages: unknown[];
  /** Messages retirés du début de la conversation. */
  retires: number;
  /** Résultats d'outils abrégés dans la demande en cours. */
  abreges: number;
  avant: number;
  apres: number;
  budget: number;
  /** Index de la question dans `messages` après l'ajustement (les retraits la font remonter). */
  question: number;
  /** Le dernier résultat d'outil, trop grand à lui seul, a été coupé (16/10/2026). */
  dernierCoupe: boolean;
  /**
   * Ce qui est sorti de la place, tel quel, pour la mémoire de la conversation
   * (memoireConversation.ts, 16/10/2026) : les messages retirés du début, et
   * les résultats d'outils avant qu'ils ne soient abrégés.
   */
  partis: unknown[];
  resultatsAbreges: { outil: string; contenu: string }[];
}

/** Ce que la conversation peut occuper : la taille chargée moins la réponse, la marge et les outils. */
export function placeDeLaConversation(contexte: number, reflechit: boolean, jetonsOutils: number): number {
  return contexte - reservePourLaReponse(contexte, reflechit) - margeDeContexte(contexte) - jetonsOutils;
}

/** Index de la dernière question de la personne (un message `user`), ou -1. */
export function indexDeLaQuestion(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if ((messages[i] as Message)?.role === "user") return i;
  return -1;
}

const NOTE_RESULTAT = "[Résultat plus ancien retiré faute de place dans la conversation. Refais l'appel si tu en as encore besoin.]";

/**
 * @param question index du message de la personne à garder avec tout ce qui
 *   suit ; par défaut, la dernière question. Une boucle d'outils (chat.ts)
 *   passe le premier message après la consigne : l'historique y a déjà été
 *   raccourci avant la boucle, et ses relances (« Tu as décrit l'action… »)
 *   sont elles aussi des messages `user`, qui feraient passer la vraie
 *   question pour ancienne. Seuls les résultats d'outils y sont alors abrégés.
 */
export function tenirDansLaPlace(
  messages: unknown[],
  budget: number,
  question = indexDeLaQuestion(messages),
  /** La conversation a une mémoire (memoireConversation.ts) : la note au modèle dit que des extraits lui en sont rendus. */
  options: { memoire?: boolean } = {},
): Ajustement {
  const avant = jetonsDesMessages(messages);
  if (avant <= budget || question < 0) {
    return { messages, retires: 0, abreges: 0, avant, apres: avant, budget, question, dernierCoupe: false, partis: [], resultatsAbreges: [] };
  }
  const copie = [...messages] as Message[];
  /*
   * Le total est tenu au fil des retraits, jamais recalculé sur toute la
   * conversation à chaque tour : sur une conversation énorme, un recalcul par
   * message retiré était en n² et bloquait la boucle d'événements de l'instance
   * pour tout le monde (audit du 28/09/2026, § 36 ; 80 000 messages = 26 s).
   * Le coût d'un message est indépendant des autres (jetonsDunMessage), donc
   * retirer un message revient à soustraire son coût.
   */
  let total = avant;
  const debut = copie[0]?.role === "system" ? 1 : 0;
  let q = question;
  let retires = 0;
  const tousPartis: Message[] = [];

  // 1. Les plus anciens tours, entiers : jusqu'au message de la personne suivant.
  while (total > budget && debut < q) {
    let fin = debut + 1;
    while (fin < q && copie[fin]?.role !== "user") fin++;
    const partis = copie.splice(debut, fin - debut);
    for (const m of partis) total -= jetonsDunMessage(m);
    tousPartis.push(...partis);
    retires += partis.length;
    q -= partis.length;
  }

  // 2. Les résultats d'outils de la demande en cours, du plus ancien au plus récent, sauf le dernier.
  let abreges = 0;
  const resultatsAbreges: { outil: string; contenu: string }[] = [];
  /** Le nom de l'outil d'un résultat, lu dans l'appel qui le précède. */
  const nomOutil = (id: unknown): string => {
    for (const m of copie) {
      const appel = Array.isArray(m?.tool_calls) ? (m.tool_calls as { id?: unknown; function?: { name?: unknown } }[]).find((c) => c?.id === id) : undefined;
      if (appel) return String(appel.function?.name ?? "");
    }
    return "";
  };
  if (total > budget) {
    const coutNote = jetonsDunMessage({ role: "tool", content: NOTE_RESULTAT });
    const resultats = copie.map((m, i) => ({ m, i })).filter(({ m, i }) => i > q && m.role === "tool" && typeof m.content === "string" && m.content !== NOTE_RESULTAT);
    for (const { i } of resultats.slice(0, -1)) {
      if (total <= budget) break;
      total -= jetonsDunMessage(copie[i]) - coutNote;
      resultatsAbreges.push({ outil: nomOutil(copie[i]!.tool_call_id), contenu: copie[i]!.content as string });
      copie[i] = { ...copie[i]!, content: NOTE_RESULTAT };
      abreges++;
    }
  }

  /*
   * 2 bis. Le dernier résultat d'outil, s'il ne tient pas à lui seul
   * (16/10/2026) : une page lue, un long fichier, jusqu'à 20 000 caractères,
   * soit près de 7 000 jetons, dans une conversation chargée à 4 096. Il
   * restait entier, et le moteur refusait la demande ou la coupait. On garde
   * son début, ce qui tient, avec une note qui le dit au modèle.
   */
  let dernierCoupe = false;
  if (total > budget) {
    let i = -1;
    for (let k = copie.length - 1; k > q; k--) {
      if (copie[k]?.role === "tool" && typeof copie[k]!.content === "string" && copie[k]!.content !== NOTE_RESULTAT) {
        i = k;
        break;
      }
    }
    if (i > 0) {
      const contenu = copie[i]!.content as string;
      const cout = jetonsDunMessage(copie[i]);
      const reste = Math.max(150, cout - (total - budget));
      const garde = Math.max(450, reste * 3 - 200);
      if (garde < contenu.length) {
        const coupe = `${contenu.slice(0, garde)}\n[… ${contenu.length - garde} caractères de plus retirés faute de place dans la conversation. Demande une partie précise si tu en as besoin.]`;
        copie[i] = { ...copie[i]!, content: coupe };
        total += jetonsDunMessage(copie[i]) - cout;
        dernierCoupe = true;
      }
    }
  }

  // 3. Dit au modèle, pour qu'il ne fasse pas semblant de se souvenir.
  if (retires > 0) {
    const note = options.memoire
      ? `Les ${retires} premiers messages de cette conversation ne te sont plus donnés en entier, faute de place. ` +
        "Ceux qui se rapportent à la dernière question te sont rendus plus bas, en « extraits plus anciens de cette conversation », quand il y en a. " +
        "Si la personne fait référence à autre chose, dis-lui que tu ne le vois plus et demande-lui de le rappeler."
      : `Les ${retires} premiers messages de cette conversation ne te sont plus donnés, faute de place. ` +
        "Si la personne y fait référence, dis-lui que tu ne les vois plus et demande-lui de rappeler ce qu'il faut.";
    const systeme = copie[0];
    if (systeme?.role === "system" && typeof systeme.content === "string") copie[0] = { ...systeme, content: `${systeme.content}\n\n${note}` };
    else if (systeme?.role !== "system") {
      copie.unshift({ role: "system", content: note });
      q++;
    }
    total = jetonsDesMessages(copie);
  }
  return { messages: copie, retires, abreges, avant, apres: total, budget, question: q, dernierCoupe, partis: tousPartis, resultatsAbreges };
}

/**
 * Le moteur a refusé la demande, trop longue pour sa place (16/10/2026) :
 * l'estimation de Helix (3 caractères par jeton) s'est trompée, ou la taille
 * n'était pas connue (un modèle cloud, un serveur qui ne la publie pas). On
 * raccourcit à 60 % de l'estimation, avec les mêmes règles que
 * `tenirDansLaPlace` (consigne et question gardées, tours entiers, résultats
 * d'outils abrégés), pour un nouvel essai. `null` : rien à retirer, un nouvel
 * essai échouerait de même.
 */
export function raccourcirApresRefus(messages: unknown[], question = indexDeLaQuestion(messages)): Ajustement | null {
  const estime = jetonsDesMessages(messages);
  const r = tenirDansLaPlace(messages, Math.floor(estime * 0.6), question);
  return r.retires > 0 || r.abreges > 0 || r.dernierCoupe ? r : null;
}

/**
 * Les derniers échanges avant la question, pour une étape de plan qui repart
 * d'un fil neuf (chat.ts, `fondation`) : messages de la personne et réponses,
 * en texte, sans appels ni résultats d'outils, du plus récent au plus ancien
 * tant qu'ils tiennent dans `maxJetons`, et toujours ouverts par un message de
 * la personne et fermés par une réponse (l'étape ajoute sa consigne, un
 * message de la personne, juste après).
 */
export function derniersEchanges(messages: unknown[], question: number, maxJetons: number, maxMessages = 6): unknown[] {
  const pris: { role: string; content: string }[] = [];
  let jetons = 0;
  for (let i = question - 1; i >= 0 && pris.length < maxMessages; i--) {
    const m = messages[i] as Message;
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    if (m.role === "assistant" && m.tool_calls) continue;
    const texte =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as { type?: string; text?: string }[]).filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ")
          : "";
    if (!texte.trim()) continue;
    const court = texte.length > 3000 ? `${texte.slice(0, 3000)} […]` : texte;
    const cout = jetonsDesMessages([{ content: court }]);
    if (jetons + cout > maxJetons) break;
    jetons += cout;
    pris.unshift({ role: m.role, content: court });
  }
  while (pris[0] && pris[0].role !== "user") pris.shift();
  while (pris.length > 0 && pris[pris.length - 1]!.role !== "assistant") pris.pop();
  return pris;
}
