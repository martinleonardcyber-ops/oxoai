import { createHash } from "node:crypto";
import { lister, t, tf } from "./langue.ts";
import { phraseLangue } from "./plan.ts";

/**
 * Documents joints à une question du Chat : ce que le modèle en reçoit.
 *
 * Vu par Medhi le 27/09/2026 sur un PC Windows (processeur seul, 16 Go,
 * Ministral 3B) : « il est incapable de lire et traiter un document », quel
 * que soit le fichier. Relu de bout en bout, le chemin perdait le document à
 * trois endroits, sur toute machine et avec tout modèle local de moins de
 * 45 milliards de paramètres :
 *
 *  1. **Le découpage des tâches** (plan.ts) : le texte du fichier, collé
 *     devant la question, en faisait une « demande longue » que le modèle
 *     découpait volontiers (« lire le document », « résumer ») ; chaque étape
 *     repart d'une reformulation de 4 000 caractères au plus, sans le
 *     fichier. Le modèle répondait donc sur un document qu'il ne voyait plus,
 *     ou cherchait à l'ouvrir avec un outil.
 *  2. **La place** : jusqu'à 200 000 caractères par fichier partaient tels
 *     quels, quelle que soit la taille de conversation du modèle chargé
 *     (32 768 jetons sur un poste de 16 Go, 4 096 chez LM Studio pour un
 *     modèle chargé sans OxoAI). Au-delà, le moteur refusait, ou coupait
 *     lui-même au milieu, en silence.
 *  3. **La question suivante** : le texte ne partait qu'avec la question qui
 *     portait le fichier ; « et la page 3 ? » arrivait sans lui.
 *
 * L'écran enveloppe désormais chaque document dans une balise dont la
 * longueur est écrite (`<document nom="…" caracteres="…">`) : une instance
 * d'une version antérieure le transmet tel quel au modèle, lisible ; celle-ci
 * le reconnaît sans ambiguïté, même si le fichier contient lui-même
 * « </document> », mesure la place qu'il prendra, et décide :
 *  - il tient : il part en entier, balisé, avec son nom et une consigne claire
 *    (le lire directement, ne pas chercher à l'ouvrir avec un outil) ;
 *  - il ne tient pas : il est lu **en parties**, chacune dans une demande à
 *    part, et le modèle répond sur les notes prises partie par partie. C'est
 *    plus lent, mais le contenu n'est pas perdu, et l'écran le dit.
 *
 * Les jetons sont estimés, pas comptés : trois caractères par jeton pour
 * l'alphabet latin (un modèle en fait plutôt quatre en français : l'erreur
 * se fait du côté de la place), un par idéogramme.
 */

/** Balise posée par l'écran (src/lib/attachments.ts, `enveloppe`). */
const OUVERTURE = /<document nom="([^"\n]{0,300})" caracteres="(\d{1,9})"(?: coupe="(oui|non)")?>\n/g;
const FERMETURE = "\n</document>";

export interface DocumentJoint {
  nom: string;
  contenu: string;
  /** Coupé dès le poste (fichier plus long que ce que l'écran lit) : seul le début est là. */
  coupe: boolean;
}

/** Un message de la personne, séparé en documents et en question. */
export interface MessageAvecDocuments {
  index: number;
  documents: DocumentJoint[];
  /** Ce que la personne a écrit, sans les documents. */
  question: string;
  /** Le message portait-il des images (contenu en fragments) ? Elles restent à leur place. */
  fragments: unknown[] | null;
}

/**
 * Sépare les documents du reste d'un texte. Une balise dont la longueur
 * annoncée ne tombe pas sur la fermeture n'est pas un document de l'écran :
 * le texte reste tel quel.
 */
export function extraireDocuments(texte: string): { documents: DocumentJoint[]; reste: string } {
  const documents: DocumentJoint[] = [];
  let reste = "";
  let curseur = 0;
  OUVERTURE.lastIndex = 0;
  for (let m = OUVERTURE.exec(texte); m; m = OUVERTURE.exec(texte)) {
    const debut = m.index + m[0].length;
    const longueur = Number(m[2]);
    const fin = debut + longueur;
    if (texte.slice(fin, fin + FERMETURE.length) !== FERMETURE) continue;
    reste += texte.slice(curseur, m.index);
    documents.push({ nom: m[1] || "document", contenu: texte.slice(debut, fin), coupe: m[3] === "oui" });
    curseur = fin + FERMETURE.length;
    OUVERTURE.lastIndex = curseur;
  }
  reste += texte.slice(curseur);
  return { documents, reste: reste.trim() };
}

function texteDe(contenu: unknown): { texte: string; fragments: unknown[] | null } {
  if (typeof contenu === "string") return { texte: contenu, fragments: null };
  if (Array.isArray(contenu)) {
    const textes = (contenu as { type?: string; text?: string }[]).filter((p) => p?.type === "text").map((p) => p.text ?? "");
    return { texte: textes.join("\n\n"), fragments: contenu };
  }
  return { texte: "", fragments: null };
}

/** Les messages de la personne qui portent des documents, dans l'ordre. */
export function messagesAvecDocuments(messages: unknown[]): MessageAvecDocuments[] {
  const trouves: MessageAvecDocuments[] = [];
  messages.forEach((m, index) => {
    const message = m as { role?: string; content?: unknown };
    if (message?.role !== "user") return;
    const { texte, fragments } = texteDe(message.content);
    if (!texte.includes("<document ")) return;
    const { documents, reste } = extraireDocuments(texte);
    if (documents.length > 0) trouves.push({ index, documents, question: reste, fragments });
  });
  return trouves;
}

/* ------------------------------------------------------------------------- */
/* Place                                                                      */
/* ------------------------------------------------------------------------- */

/** Jetons estimés d'un texte (voir l'en-tête : l'erreur se fait du côté de la place). */
export function jetonsEstimes(texte: string): number {
  const ideogrammes = (texte.match(/[぀-ヿ㐀-鿿가-힯豈-﫿]/g) ?? []).length;
  return Math.ceil((texte.length - ideogrammes) / 3 + ideogrammes * 1.1);
}

/** Une image, telle qu'un encodeur de vision la compte à peu près (une capture de 1 000 à 2 000 jetons). */
const JETONS_PAR_IMAGE = 1800;

/** Jetons estimés d'un seul message (le coût par message est indépendant des autres). */
export function jetonsDunMessage(m: unknown): number {
  const msg = m as { content?: unknown; tool_calls?: unknown };
  let total = 8;
  if (typeof msg?.content === "string") total += jetonsEstimes(msg.content);
  else if (Array.isArray(msg?.content)) {
    for (const p of msg.content as { type?: string; text?: string }[]) {
      total += p?.type === "image_url" ? JETONS_PAR_IMAGE : jetonsEstimes(p?.text ?? "");
    }
  }
  if (msg?.tool_calls) total += jetonsEstimes(JSON.stringify(msg.tool_calls));
  return total;
}

/** Jetons estimés d'une conversation : textes, appels d'outils, images. */
export function jetonsDesMessages(messages: unknown[]): number {
  let total = 0;
  for (const m of messages) total += jetonsDunMessage(m);
  return total;
}

/**
 * Ce que la réponse doit pouvoir occuper : un cinquième de la conversation,
 * entre 1 024 et 4 096 jetons (8 192 pour un modèle qui réfléchit avant
 * d'écrire, sa réflexion compte dans la même place).
 */
export function reservePourLaReponse(contexte: number, reflechit: boolean): number {
  return Math.min(Math.max(1024, Math.floor(contexte * 0.2)), reflechit ? 8192 : 4096);
}

/** Marge pour ce que l'estimation ne voit pas (gabarit du modèle, consignes ajoutées en route). */
const marge = (contexte: number) => 256 + Math.floor(contexte * 0.05);
/** La même marge, pour la conversation entière (historique.ts). */
export const margeDeContexte = marge;

/** Au-delà, un document est trop grand pour être lu en parties : la suite n'est pas lue, et c'est dit. */
export const PARTIES_MAX = 24;
/** Notes prises sur une partie : jamais moins, sinon elles ne disent plus rien. */
const NOTES_MIN = 120;

/* ------------------------------------------------------------------------- */
/* Découpage en parties                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Découpe un texte en parties d'au plus `taille` caractères, de préférence à
 * un saut de page (« ## Page 4 », posé par la lecture des PDF), de feuille ou
 * de diapositive, sinon à un paragraphe, sinon à une ligne, sinon à un blanc.
 */
export function decouper(texte: string, taille: number): string[] {
  const parties: string[] = [];
  let reste = texte;
  const minimum = Math.floor(taille * 0.5);
  while (reste.length > taille) {
    const fenetre = reste.slice(0, taille);
    let coupe = -1;
    for (const motif of [/\n(?=## (?:Page|Feuille|Diapositive) )/g, /\n\s*\n/g, /\n/g, /\s/g]) {
      let dernier = -1;
      for (const m of fenetre.matchAll(motif)) if (m.index !== undefined && m.index >= minimum) dernier = m.index;
      if (dernier >= minimum) {
        coupe = dernier;
        break;
      }
    }
    if (coupe < 0) coupe = taille;
    parties.push(reste.slice(0, coupe).trim());
    reste = reste.slice(coupe);
  }
  if (reste.trim()) parties.push(reste.trim());
  return parties.filter(Boolean);
}

/** « pages 3 à 7 » quand la partie porte les repères de page de la lecture des PDF. */
function reperes(partie: string): string {
  const pages = [...partie.matchAll(/^## Page (\d+)/gm)].map((m) => m[1]);
  if (pages.length === 1) return ` (page ${pages[0]})`;
  if (pages.length > 1) return ` (pages ${pages[0]} à ${pages.at(-1)})`;
  return "";
}

/* ------------------------------------------------------------------------- */
/* Ce que le modèle lit                                                      */
/* ------------------------------------------------------------------------- */

const nomSur = (nom: string) => nom.replace(/["<>\n\r]/g, "'").slice(0, 200);

function blocEntier(d: DocumentJoint): string {
  const note = d.coupe ? ` note="seul le début du fichier a pu être lu : la suite manque"` : "";
  return `<document nom="${nomSur(d.nom)}"${note}>\n${d.contenu}\n</document>`;
}

function blocNotes(d: DocumentJoint, notes: string[], total: number, lues: number, jetons: number, contexte: number): string {
  const entete =
    `Ce document était trop long pour être lu d'un coup (environ ${jetons} jetons, pour une conversation de ${contexte}) : ` +
    `l'instance l'a lu en ${total} parties, et voici les notes prises sur chacune, dans l'ordre. ` +
    (lues < total ? `Seules les ${lues} premières parties ont pu être lues : la fin du document manque. ` : "") +
    (d.coupe ? "Le fichier lui-même n'a été lu que jusqu'à une certaine longueur : la suite manque. " : "") +
    "Appuie-toi sur ces notes ; si elles ne suffisent pas pour répondre, dis-le.";
  return `<document nom="${nomSur(d.nom)}" lecture="en ${total} parties">\n${entete}\n\n${notes.join("\n\n")}\n</document>`;
}

/**
 * Le message de la personne, reconstruit : consigne, documents, puis sa demande.
 *
 * Toujours le même texte pour les mêmes documents, qu'il s'agisse de la
 * question du moment ou d'une question d'avant : un moteur local garde en
 * mémoire le début de la conversation déjà lu (llama.cpp, MLX) et ne relit
 * que ce qui a changé. Mesuré par Medhi le 27/09/2026 sur un PC sans carte
 * graphique : la lecture d'un document y prend l'essentiel du temps ; la
 * relire à chaque question parce qu'une phrase avait bougé devant lui la
 * ferait payer à chaque tour. Ce qui ne vaut que pour cette réponse (« tu
 * n'as pas d'outil ») va donc à la fin de la dernière question, jamais ici.
 */
function messageReconstruit(blocs: string[], question: string, fragments: unknown[] | null): unknown {
  const demande = question || t("Lis ce document et dis en quelques lignes ce qu'il contient, puis demande ce que je veux en faire.");
  const texte = [
    blocs.length > 1
      ? `La personne a joint ${blocs.length} documents à sa demande. Leur contenu est reproduit ci-dessous, entre les balises <document> : lis-le directement, ne cherche pas à ouvrir ces fichiers avec un outil.`
      : "La personne a joint un document à sa demande. Son contenu est reproduit ci-dessous, entre les balises <document> : lis-le directement, ne cherche pas à ouvrir ce fichier avec un outil.",
    ...blocs,
    `Demande de la personne :\n${demande}`,
    phraseLangue(demande),
  ].join("\n\n");
  if (!fragments) return texte;
  // Les images de la même question restent après le texte, à leur place.
  return [{ type: "text", text: texte }, ...fragments.filter((p) => (p as { type?: string })?.type !== "text")];
}

/** Ajoute une phrase à la fin d'un message (texte, ou fragments avec images). */
function avecNoteFinale(message: unknown, note: string): unknown {
  const m = message as { content?: unknown };
  if (typeof m.content === "string") return { ...(message as object), content: `${m.content}\n\n${note}` };
  if (Array.isArray(m.content)) return { ...(message as object), content: [...m.content, { type: "text", text: note }] };
  return message;
}

/** Une question aux documents d'avant, quand il n'y a plus de place pour eux. */
function messageSansDocuments(ancien: MessageAvecDocuments): unknown {
  const noms = ancien.documents.map((d) => `« ${nomSur(d.nom)} »`).join(", ");
  const note = `[${ancien.documents.length > 1 ? "Documents joints" : "Document joint"} ici : ${noms}. Son contenu n'est plus repris dans cette conversation, faute de place ; ce qui en a été dit plus haut reste valable.]`;
  const texte = [note, ancien.question].filter(Boolean).join("\n\n");
  if (!ancien.fragments) return texte;
  return [{ type: "text", text: texte }, ...ancien.fragments.filter((p) => (p as { type?: string })?.type !== "text")];
}

/*
 * Notes d'un document lu en parties, gardées le temps que la passerelle tourne
 * (seize documents au plus) : à la question suivante, le même document repart
 * avec les mêmes notes, sans être relu partie par partie. Relire un document
 * de 60 000 jetons à chaque question coûterait, sur un processeur seul, de
 * longues minutes à chaque tour, pour des notes presque identiques.
 */
const NOTES_GARDEES = new Map<string, string>();
const NOTES_GARDEES_MAX = 16;
const cleDesNotes = (d: DocumentJoint, contexte: number) =>
  createHash("sha256").update(`${contexte}\n${d.nom}\n${d.coupe}\n${d.contenu}`).digest("hex");
function garderNotes(cle: string, bloc: string): void {
  NOTES_GARDEES.delete(cle);
  NOTES_GARDEES.set(cle, bloc);
  while (NOTES_GARDEES.size > NOTES_GARDEES_MAX) NOTES_GARDEES.delete(NOTES_GARDEES.keys().next().value!);
}

/* ------------------------------------------------------------------------- */
/* L'ensemble                                                                */
/* ------------------------------------------------------------------------- */

export interface Integration {
  messages: unknown[];
  /**
   * La conversation porte des documents (à la dernière question ou avant) :
   * pas de découpage en étapes, qui repartiraient sans eux (chat.ts).
   */
  avecDocuments: boolean;
  /** Ce qui est dit à la personne, dans sa langue (lu en parties, coupé, repris sans outils…). */
  annonces: string[];
  /** Les outils ont été retirés pour laisser la place aux documents. */
  sansOutils: boolean;
  /** Une ligne pour le journal, sans contenu. */
  journal: string;
}

export interface Contexte {
  /** Taille de conversation du modèle, en jetons. */
  contexte: number;
  /** Le modèle réfléchit avant d'écrire : sa réflexion prend de la place. */
  reflechit: boolean;
  /** Jetons que prendront les outils proposés (0 sans outils). */
  jetonsOutils: number;
  /** Nom du modèle, pour les annonces. */
  modele: string;
  /**
   * Lit une partie : la consigne complète, et les jetons de notes permis.
   * Rend les notes, ou `null` si le moteur n'a pas répondu.
   */
  lirePartie: (consigne: string, jetonsNotes: number) => Promise<string | null>;
  /** Où en est la lecture, pour l'écran (vide : fini). */
  progression?: (message: string) => void;
  /**
   * Les anciens échanges seront raccourcis ensuite pour tenir dans la place
   * (historique.ts, `tenirDansLaPlace`) : le document de la question n'a pas
   * à leur céder la place. Faux quand rien ne coupe après (relais d'un client,
   * taille de conversation supposée) : tout ce qui part compte alors.
   */
  historiqueCoupe?: boolean;
}

/**
 * Remplace les documents des messages par ce que le modèle peut lire, dans la
 * place qu'il a. Sans document, rend les messages tels quels.
 */
export async function integrerDocuments(messages: unknown[], c: Contexte): Promise<Integration> {
  const porteurs = messagesAvecDocuments(messages);
  const derniereQuestion = [...messages].map((m, i) => ({ m: m as { role?: string }, i })).reverse().find((x) => x.m?.role === "user")?.i;
  const actuel = porteurs.find((p) => p.index === derniereQuestion);
  const anciens = porteurs.filter((p) => p !== actuel);
  if (porteurs.length === 0) return { messages, avecDocuments: false, annonces: [], sansOutils: false, journal: "" };

  const copie = [...messages];
  const annonces: string[] = [];
  const journal: string[] = [];

  /*
   * La place des documents : la conversation moins la réponse, la marge, et
   * tout ce qui part de toute façon (consignes, historique, outils).
   */
  const sansAucunDocument = copie.map((m, i) => {
    const p = porteurs.find((x) => x.index === i);
    return p ? { role: "user", content: p === actuel ? p.question : messageSansDocuments(p) } : m;
  });
  const reserve = reservePourLaReponse(c.contexte, c.reflechit) + marge(c.contexte) + 200;
  const fixe = jetonsDesMessages(sansAucunDocument) + reserve;
  const placeAvec = c.contexte - fixe - c.jetonsOutils;
  const placeSans = c.contexte - fixe;
  /*
   * La place du document de la question, quand l'historique est raccourci
   * ensuite (28/09/2026) : seuls restent sûrement la consigne système, la
   * question et ce qui la suit. Mesuré avant ce jour sur un contexte de 8 192
   * jetons : un document de 2 200 jetons, joint à la neuvième question d'un
   * Chat, passait pour trop long à cause des huit échanges d'avant, et était
   * lu en une seule partie sur plusieurs (le reste perdu) ; puis
   * `tenirDansLaPlace` retirait justement ces échanges. Les documents des
   * questions d'avant, eux, ne sont repris que si tout l'historique tient.
   */
  const debutGarde = derniereQuestion ?? sansAucunDocument.length;
  const garde = sansAucunDocument.filter((m, i) => i >= debutGarde || (i === 0 && (m as { role?: string })?.role === "system"));
  const fixeQuestion = jetonsDesMessages(garde) + reserve;
  const placeAvecQuestion = c.historiqueCoupe ? c.contexte - fixeQuestion - c.jetonsOutils : placeAvec;
  const placeSansQuestion = c.historiqueCoupe ? c.contexte - fixeQuestion : placeSans;

  /** Ce qu'un document d'avant occupera : ses notes s'il a été lu en parties, sinon son texte. */
  const blocAncien = (d: DocumentJoint) => NOTES_GARDEES.get(cleDesNotes(d, c.contexte)) ?? blocEntier(d);
  const besoinActuel = (actuel?.documents ?? []).reduce((s, d) => s + jetonsEstimes(d.contenu) + 40, 0);
  const besoinAnciens = anciens.reduce((s, a) => s + a.documents.reduce((t2, d) => t2 + jetonsEstimes(blocAncien(d)), 0), 0);

  /*
   * Des documents qui ne tiennent pas avec les outils : on les retire pour
   * cette réponse. Lire le fichier (en entier, ou en notes plus complètes)
   * vaut mieux que garder des outils dont une question sur un document se
   * passe presque toujours ; sur un petit contexte, leurs descriptions
   * prennent à elles seules des milliers de jetons. Les documents d'avant
   * comptent aussi : « et la page 3 ? » s'adresse encore au fichier.
   */
  let sansOutils = false;
  let place = placeAvecQuestion;
  /** Ce qui reste pour les documents d'avant : tout l'historique doit tenir avec eux. */
  let placeAnciens = placeAvec;
  const besoinTotal = besoinActuel + besoinAnciens;
  const tropAvecOutils = c.historiqueCoupe
    ? besoinActuel > placeAvecQuestion || (besoinAnciens > 0 && besoinTotal > placeAvec && besoinTotal <= placeSans)
    : besoinTotal > placeAvec;
  if (tropAvecOutils && c.jetonsOutils > 0) {
    sansOutils = true;
    place = placeSansQuestion;
    placeAnciens = placeSans;
    const noms = [...(actuel?.documents ?? []), ...anciens.flatMap((a) => a.documents)].map((d) => d.nom);
    annonces.push(tf("Pour lire « {0} », {1} répond cette fois sans outils : ils prenaient la place du document.", lister([...new Set(noms)]), c.modele));
  }

  if (actuel) {
    if (besoinActuel <= place) {
      copie[actuel.index] = { ...(copie[actuel.index] as object), content: messageReconstruit(actuel.documents.map(blocEntier), actuel.question, actuel.fragments) };
      place -= besoinActuel;
      placeAnciens -= besoinActuel;
      journal.push(`${actuel.documents.length} document(s) en entier, ~${besoinActuel} jetons sur ${c.contexte}`);
    } else {
      /*
       * Trop long. Les petits documents (un quart de la place au plus)
       * restent entiers ; les autres sont lus en parties.
       */
      const blocs: string[] = [];
      let reste = Math.max(0, place);
      const entiers = new Set<DocumentJoint>();
      for (const d of [...actuel.documents].sort((a, b) => a.contenu.length - b.contenu.length)) {
        const j = jetonsEstimes(d.contenu) + 40;
        if (j <= place * 0.25 && j <= reste) {
          entiers.add(d);
          reste -= j;
        }
      }
      const longs = actuel.documents.filter((d) => !entiers.has(d));
      /*
       * Une partie : toute la conversation moins les notes qu'elle rendra, la
       * consigne de lecture et la question. Les notes de toutes les parties
       * doivent ensuite tenir ensemble dans la place qui reste.
       */
      const notesMax = Math.max(NOTES_MIN, Math.min(1024, Math.floor(c.contexte / 6)));
      const consigneJetons = 450 + jetonsEstimes(actuel.question);
      const partieJetons = Math.max(500, c.contexte - notesMax - consigneJetons - marge(c.contexte));
      const decoupes = longs.map((d) => decouper(d.contenu, partieJetons * 3));
      const totalParties = decoupes.reduce((s, p) => s + p.length, 0);
      /*
       * Les notes n'occupent que les trois quarts de la place : à la question
       * suivante, la réponse d'avant et la nouvelle question s'ajoutent, et
       * les mêmes notes doivent encore tenir (`NOTES_GARDEES`).
       */
      const placeNotes = Math.floor(reste * 0.75);
      const partiesPossibles = Math.max(1, Math.min(PARTIES_MAX, Math.floor(placeNotes / NOTES_MIN)));
      const jetonsNotes = Math.max(NOTES_MIN, Math.min(notesMax, Math.floor(placeNotes / Math.min(totalParties, partiesPossibles))));
      let lues = 0;
      const notesParDocument = new Map<DocumentJoint, { notes: string[]; lues: number; total: number; echecs: number }>();
      for (let k = 0; k < longs.length; k++) {
        const d = longs[k]!;
        const parties = decoupes[k]!;
        const suivi = { notes: [] as string[], lues: 0, total: parties.length, echecs: 0 };
        notesParDocument.set(d, suivi);
        for (let i = 0; i < parties.length && lues < partiesPossibles; i++) {
          c.progression?.(tf("Lecture de « {0} » : partie {1} sur {2}...", d.nom, i + 1, parties.length));
          const consigne = consigneDePartie(d.nom, parties[i]!, i, parties.length, actuel.question, jetonsNotes);
          const notes = await c.lirePartie(consigne, jetonsNotes);
          lues++;
          suivi.lues++;
          if (notes === null || !notes.trim()) suivi.echecs++;
          suivi.notes.push(`## Partie ${i + 1} sur ${parties.length}${reperes(parties[i]!)}\n${notes?.trim() || "(cette partie n'a pas pu être lue : le moteur n'a pas répondu)"}`);
        }
      }
      c.progression?.("");
      for (const d of actuel.documents) {
        if (entiers.has(d)) {
          blocs.push(blocEntier(d));
          continue;
        }
        const s = notesParDocument.get(d)!;
        const bloc = blocNotes(d, s.notes, s.total, s.lues, jetonsEstimes(d.contenu), c.contexte);
        blocs.push(bloc);
        // Des notes complètes seulement : une partie ratée se relira à la question suivante.
        if (s.lues > 0 && s.echecs === 0) garderNotes(cleDesNotes(d, c.contexte), bloc);
        if (s.lues === 0) {
          annonces.push(tf("« {0} » n'a pas pu être lu : la place de {1} était prise par les autres documents. Joignez-le seul.", d.nom, c.modele));
        } else if (s.lues < s.total) {
          annonces.push(
            tf(
              "« {0} » est trop long pour {1} : il a été lu en parties, et seules les {2} premières sur {3} ont pu l'être (environ {4} % du document). Pour la suite, déposez-le dans la Bibliothèque, où il se lit par passages.",
              d.nom,
              c.modele,
              s.lues,
              s.total,
              Math.round((100 * s.lues) / s.total),
            ),
          );
        } else {
          annonces.push(
            tf(
              "« {0} » est trop long pour être lu d'un coup par {1} (environ {2} jetons, pour {3}) : il a été lu en {4} parties, et la réponse s'appuie sur les notes prises sur chacune.",
              d.nom,
              c.modele,
              jetonsEstimes(d.contenu),
              c.contexte,
              s.total,
            ),
          );
        }
        if (s.echecs > 0) annonces.push(tf("{0} partie(s) de « {1} » n'ont pas pu être lues : le moteur n'a pas répondu.", s.echecs, d.nom));
        journal.push(`document de ${d.contenu.length} caractères lu en ${s.lues}/${s.total} parties de ~${partieJetons} jetons (${s.echecs} échec(s)), notes de ${jetonsNotes} jetons, contexte ${c.contexte}`);
      }
      copie[actuel.index] = { ...(copie[actuel.index] as object), content: messageReconstruit(blocs, actuel.question, actuel.fragments) };
      place = 0;
      placeAnciens = 0;
    }
  }

  /*
   * Les documents des questions d'avant : repris tant qu'il reste de la place,
   * du plus récent au plus ancien, avec leurs notes s'ils ont été lus en
   * parties ; sinon une note le dit au modèle.
   */
  const repris: string[] = [];
  const oublies: string[] = [];
  for (const ancien of [...anciens].reverse()) {
    const blocs = ancien.documents.map(blocAncien);
    const besoin = blocs.reduce((s, b) => s + jetonsEstimes(b), 0);
    if (besoin <= placeAnciens) {
      copie[ancien.index] = { ...(copie[ancien.index] as object), content: messageReconstruit(blocs, ancien.question, ancien.fragments) };
      placeAnciens -= besoin;
      repris.push(...ancien.documents.map((d) => d.nom));
    } else {
      copie[ancien.index] = { ...(copie[ancien.index] as object), content: messageSansDocuments(ancien) };
      oublies.push(...ancien.documents.map((d) => d.nom));
    }
  }
  if (oublies.length > 0) {
    annonces.push(tf("Faute de place, {0} ne relit pas {1}, joint plus haut : joignez-le de nouveau pour une question qui en dépend.", c.modele, lister(oublies.map((n) => `« ${n} »`))));
    journal.push(`${oublies.length} document(s) d'avant non repris`);
  }
  if (repris.length > 0) journal.push(`${repris.length} document(s) d'avant repris`);

  if (sansOutils && derniereQuestion !== undefined) {
    copie[derniereQuestion] = avecNoteFinale(copie[derniereQuestion], "Pour cette réponse, tu n'as pas d'outil : réponds à partir des documents.");
  }

  return { messages: copie, avecDocuments: true, annonces, sansOutils, journal: journal.join(" ; ") };
}


/** La demande faite au modèle pour une partie d'un long document. */
export function consigneDePartie(nom: string, partie: string, index: number, total: number, question: string, jetonsNotes: number): string {
  const demande = question || "Dire ce que contient le document.";
  const mots = Math.max(60, Math.floor(jetonsNotes * 0.6));
  return [
    `Tu lis un long document, une partie à la fois, pour aider à répondre à une demande. Voici la partie ${index + 1} sur ${total} du document « ${nomSur(nom)} ».`,
    "",
    `<partie>\n${partie}\n</partie>`,
    "",
    `Demande de la personne : ${demande}`,
    "",
    "Relève dans cette partie tout ce qui sert à répondre à la demande : faits, chiffres, noms, dates, courtes citations exactes, avec la page, la feuille ou la diapositive quand elle est indiquée.",
    "Si la demande porte sur l'ensemble du document (résumer, analyser, traduire, corriger), résume cette partie en gardant l'essentiel et tous les chiffres.",
    "Si rien dans cette partie ne sert, réponds seulement : « Rien d'utile dans cette partie. »",
    `N'invente rien, ne réponds pas encore à la demande : tu prends des notes. ${mots} mots au plus.`,
    phraseLangue(demande, "Écris"),
  ].join("\n");
}
