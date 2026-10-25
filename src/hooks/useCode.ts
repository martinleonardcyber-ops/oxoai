import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchCodeStatus,
  createCodeSession,
  sendCodePrompt,
  interruptCode,
  translate,
  nomOutil,
  argumentsOutil,
  actionOutil,
  texteAttente,
  historiqueSessionCode,
  signalerSessionsCode,
  type CodeEvent,
  type CodeStatus,
  type HistoriqueCode,
  type ReglagesCode,
} from "@/lib/code";
import type { Message, ToolTrace } from "./useChat";
import { appliquerSuivi, suiviNeuf, terminerSuivi, type ActionCode, type SuiviCode } from "@/lib/suiviCode";

import { ouvrirFlux } from "@/lib/flux";
import { t } from "@/lib/i18n";
import { currentUser } from "@/lib/store/identity";
import { aleatoire } from "@/lib/store/storage";

/** Au-delà de ce silence, l'écran Code le signale. */
const SILENCE_MAX_MS = 90_000;
/** Réabonnements tentés quand le flux tombe en plein travail. */
const REABONNEMENTS_MAX = 3;
const newId = () => aleatoire(11);

/**
 * Une demande en cours, et de quoi reconnaître ce qui lui appartient.
 *
 * Le flux d'une session OpenCode mélange tout : l'historique rejoué à chaque
 * ouverture (vérifié le 23/09/2026 : sans `after`, tout revient depuis le
 * premier événement), les derniers échos d'un tour qu'on vient d'arrêter, puis
 * la demande en cours. Tout appliquer à « la réponse affichée » faisait
 * atterrir la fin d'un ancien tour sur la nouvelle réponse — un « stop »
 * d'avant la terminait avant qu'elle commence. On ne retient donc que ce qui
 * suit l'événement `prompted` portant l'identifiant de NOTRE message, rendu
 * par l'envoi.
 */
interface Tour {
  replyId: string;
  sessionID: string;
  /** Identifiant du message envoyé ; inconnu tant que l'envoi n'a pas répondu. */
  messageID?: string;
  /** Notre `prompted` est passé : les événements suivants sont les nôtres. */
  actif: boolean;
  /** Événements arrivés avant de connaître `messageID`, rejoués ensuite. */
  /**
   * Événements arrivés avant de connaître `messageID`, rejoués ensuite, avec
   * leur heure d'arrivée : la durée d'un outil se compte depuis là, pas
   * depuis le rejeu (27/09/2026).
   */
  enAttente: { event: CodeEvent; recu: number }[];
  /** Le tour s'est terminé (normalement ou non). */
  fini: boolean;
  /** Quand il s'est terminé : une relance du contrôle automatique peut encore le rouvrir un moment. */
  finiLe?: number;
  /** Position de chaque outil dans la liste affichée, par identifiant d'appel. */
  outils: Map<string, number>;
  /**
   * Tour repris à la réouverture d'une session où l'agent travaillait : un
   * texte déjà relu dans l'historique peut revenir une fois par le flux (lu
   * dans l'intervalle entre les deux) ; il n'est pas ajouté deux fois.
   */
  repris?: boolean;
}

/**
 * Une conversation de l'écran Code : une session, ce qui s'y affiche, son
 * flux et le tour en cours.
 *
 * Vu par Medhi le 27/09/2026 : « quand on quitte la conversation, le message
 * se retire, donc on a l'impression qu'il ne travaille plus ». L'écran n'avait
 * qu'une conversation : passer à une autre session ou à une nouvelle la
 * vidait, flux fermé, pendant que l'agent continuait chez OpenCode ; y revenir
 * relisait l'historique, où la demande n'était pas encore (OxoAI prépare
 * l'application ou le plan avant de l'envoyer) et où OpenCode se disait au
 * repos (OxoAI contrôle le code écrit entre deux tours). Comme le Chat depuis
 * le 26/09 (`reponsesEnCours`, useChat.ts), une conversation qui travaille
 * vit maintenant hors de l'écran (`enFond`), flux ouvert, et continue de se
 * remplir ; l'écran s'y rebranche en revenant, sans rien relire ni rejouer.
 * Finie hors de l'écran, elle s'oublie : y revenir relit son historique
 * complet chez OpenCode. Seul « Arrêter » arrête l'agent.
 */
interface ConversationCode {
  session: string | null;
  /** Dossier du projet, pour montrer des chemins relatifs dans le suivi. */
  dossier?: string;
  messages: Message[];
  busy: boolean;
  tour: Tour | null;
  /** Où en est l'agent sur la dernière demande : le panneau de suivi (lib/suiviCode.ts). */
  suivi: SuiviCode | null;
  /** Flux ouvert : sa session et de quoi le fermer (lib/flux.ts). */
  flux: { sessionID: string; fermer: () => void } | null;
  reabonnements: number;
  /** Dernier signe de vie de l'agent : voir le guet plus bas. */
  dernierSigne: number;
  /** La dernière demande a été arrêtée : le prochain envoi le dit au modèle. */
  arretee: boolean;
  /*
   * Génération de la conversation. `stop` et `reset` la font avancer : un
   * envoi encore en route (ouverture de session, démarrage à froid du moteur)
   * voit alors qu'il n'a plus rien à faire, au lieu de peupler la réponse
   * arrêtée. Quitter la conversation, lui, ne la fait plus avancer.
   */
  generation: number;
}

const conversationNeuve = (): ConversationCode => ({
  session: null,
  messages: [],
  busy: false,
  tour: null,
  suivi: null,
  flux: null,
  reabonnements: 0,
  dernierSigne: 0,
  arretee: false,
  generation: 0,
});

/**
 * Les conversations de l'écran Code vivent ici, hors du composant, qui
 * disparaît dès qu'on ouvre une autre page : aller voir le Chat pendant que
 * l'agent travaillait, c'était revenir sur un écran Code vide.
 *
 * Elles appartiennent à la personne connectée : une autre personne qui se
 * connecte sur le poste repart d'un écran vierge (`proprietaire`).
 */
const memoire = {
  proprietaire: undefined as string | undefined,
  /** Celle que l'écran montre (éventuellement l'accueil, sans session). */
  affichee: conversationNeuve(),
  /** Celles qu'on a quittées pendant que l'agent y travaillait. */
  enFond: new Set<ConversationCode>(),
  /** Dernier numéro d'événement reçu, par session : pour se réabonner sans rejeu. */
  dernierSeq: new Map<string, number>(),
  /** Écrans abonnés, prévenus à chaque changement. */
  abonnes: new Set<() => void>(),
};

const prevenir = () => memoire.abonnes.forEach((f) => f());

/** Évènement de fenêtre : une session de Code a commencé ou fini de travailler (liste des sessions). */
export const CODE_EN_COURS = "oxoai:code-en-cours";

/** L'agent travaille-t-il sur cette session, vu de cet écran (affichée ou quittée en plein travail) ? */
export function sessionCodeEnCours(id: string): boolean {
  if (memoire.affichee.session === id && memoire.affichee.busy) return true;
  for (const c of memoire.enFond) if (c.session === id && c.busy) return true;
  return false;
}

const toutes = () => [memoire.affichee, ...memoire.enFond];

function commit(conv: ConversationCode, next: Message[]) {
  conv.messages = next;
  prevenir();
}

function patch(conv: ConversationCode, id: string, changes: Partial<Message>) {
  commit(conv, conv.messages.map((m) => (m.id === id ? { ...m, ...changes } : m)));
}

function fermerFlux(conv: ConversationCode) {
  conv.flux?.fermer();
  conv.flux = null;
}

/*
 * Le guet du silence.
 *
 * OpenCode peut accepter une demande puis ne plus jamais rien émettre : un
 * modèle qu'il ne connaît pas, un moteur tombé en route, un fournisseur qui
 * coupe sa réponse sans la conclure (vérifié : aucun événement de fin ne
 * vient alors). Après 90 secondes sans le moindre signe, on le dit, avec ce
 * qu'on peut y faire. On n'interrompt rien : un gros modèle qui se charge
 * peut légitimement se taire un moment, et c'est la personne qui décide.
 * Il veille sur toutes les conversations au travail, même quittées : on
 * retrouve l'avertissement en revenant.
 */
let guet: ReturnType<typeof setInterval> | null = null;
function assurerGuet() {
  if (guet) return;
  guet = setInterval(() => {
    const auTravail = toutes().filter((c) => c.busy && c.tour);
    if (auTravail.length === 0) {
      clearInterval(guet!);
      guet = null;
      return;
    }
    for (const conv of auTravail) {
      if (Date.now() - conv.dernierSigne < SILENCE_MAX_MS) continue;
      patch(conv, conv.tour!.replyId, {
        statut: t(
          "Aucun signe de l'agent de code depuis 90 secondes. Il charge peut-être un modèle ; sinon, arrêtez et réessayez, ou choisissez un autre modèle.",
        ),
      });
    }
  }, 5000);
}

function marquerOccupe(conv: ConversationCode, valeur: boolean) {
  const avant = conv.busy;
  conv.busy = valeur;
  if (valeur) assurerGuet();
  /*
   * Finie hors de l'écran : plus rien à suivre ici. Y revenir relit son
   * historique chez OpenCode ; une relance du contrôle automatique, elle, se
   * voit dans la liste (l'instance dit la session en cours) et se suit en la
   * rouvrant.
   */
  if (!valeur && memoire.enFond.has(conv)) {
    memoire.enFond.delete(conv);
    fermerFlux(conv);
  }
  if (avant !== valeur && typeof window !== "undefined") window.dispatchEvent(new Event(CODE_EN_COURS));
  prevenir();
}

/**
 * L'écran quitte cette conversation. Au travail, elle continue hors de
 * l'écran, flux ouvert ; au repos, son flux se ferme.
 */
function detacher(conv: ConversationCode) {
  if (conv.busy) {
    memoire.enFond.add(conv);
    return;
  }
  fermerFlux(conv);
  conv.tour = null;
}

/**
 * Termine la réponse du tour : plus de curseur, la main rendue.
 *
 * `note` : pourquoi le tour s'arrête, quand ce n'est pas une fin normale.
 * Ce qui a déjà été écrit reste visible, la note s'ajoute dessous ; sans
 * rien d'écrit, elle devient le message d'erreur. (Posée en `error`, elle
 * cachait tout le texte de la réponse : l'affichage ne montre que l'erreur.)
 */
function terminer(conv: ConversationCode, tour: Tour, note?: string, issue: "fini" | "echec" = note ? "echec" : "fini") {
  tour.fini = true;
  tour.finiLe = Date.now();
  if (conv.suivi) conv.suivi = terminerSuivi(conv.suivi, issue);
  const current = conv.messages.find((m) => m.id === tour.replyId);
  if (current) {
    // Un outil encore « en cours » quand le tour s'arrête ne se terminera plus.
    const tools = current.tools?.map((trace) =>
      trace.running ? { ...trace, running: false, ok: false, preview: trace.preview ?? note } : trace,
    );
    const changes: Partial<Message> = { streaming: false, statut: undefined, tools };
    /*
     * La durée de la demande entière (27/09/2026), de l'envoi à la fin
     * normale du tour. Une réponse rouverte en cours de route n'a pas
     * d'heure d'envoi connue : pas de durée plutôt qu'une durée fausse.
     */
    if (!note && current.durees?.debut !== undefined && tour.finiLe !== undefined) {
      changes.durees = { ...current.durees, reponse: tour.finiLe - current.durees.debut };
    }
    if (note) {
      if (current.content) changes.content = `${current.content}\n\n*${note}*`;
      else changes.error = note;
    } else if (!current.content && !current.tools?.length) {
      // Rien écrit, rien fait : le dire plutôt que laisser une bulle vide.
      changes.content = t("L'agent a terminé sans réponse écrite.");
    }
    patch(conv, tour.replyId, changes);
  }
  marquerOccupe(conv, false);
}

/** Le tour rendu se rouvre : l'agent continue (relance du contrôle, nouvelle étape). */
function rouvrir(conv: ConversationCode, tour: Tour) {
  tour.fini = false;
  if (conv.suivi) conv.suivi = { ...conv.suivi, fin: undefined, issue: undefined };
  patch(conv, tour.replyId, { streaming: true, error: undefined });
  marquerOccupe(conv, true);
}

/** Applique à la conversation un événement du tour en cours. */
/** `recu` : l'heure d'arrivée de l'évènement sur cet écran, pour les durées. */
function appliquer(conv: ConversationCode, tour: Tour, event: CodeEvent, recu = Date.now()) {
  if (event.kind === "demande") {
    /*
     * Une relance du contrôle automatique de OxoAI est la suite de notre
     * demande : même bulle, et le tour rendu se rouvre. Sans cela, l'écran
     * disait « terminé » pendant que l'agent corrigeait derrière.
     */
    if (event.relance) {
      tour.actif = true;
      if (tour.fini) rouvrir(conv, tour);
      return;
    }
    // Sans identifiant rendu par l'envoi, on ne peut pas trier : tout est pris.
    if (tour.messageID !== undefined) tour.actif = event.messageID === tour.messageID;
    return;
  }
  if (!tour.actif) return;
  // Le bilan du contrôle automatique arrive après la fin du tour : il s'ajoute à la réponse.
  if (tour.fini && event.kind === "statut" && event.controle) {
    const actuel = conv.messages.find((m) => m.id === tour.replyId);
    if (actuel && event.text) patch(conv, tour.replyId, { content: actuel.content ? `${actuel.content}\n\n*${event.text}*` : `*${event.text}*`, statut: undefined });
    return;
  }
  // Tour déjà terminé : seule une nouvelle étape le rouvre (voir « etape »).
  if (tour.fini && event.kind !== "etape") return;
  const current = conv.messages.find((m) => m.id === tour.replyId);
  if (!current) return;
  // L'agent reparle : l'avertissement de silence n'a plus lieu d'être.
  if (current.statut && event.kind !== "statut") patch(conv, tour.replyId, { statut: undefined });
  // Le panneau de suivi : les écrans ne sont prévenus que si quelque chose a changé.
  if (conv.suivi) {
    const avant = conv.suivi;
    const apres = appliquerSuivi(avant, event, conv.dossier);
    if (apres !== avant) {
      conv.suivi = apres;
      prevenir();
    }
  }

  switch (event.kind) {
    case "etape":
      /*
       * Une étape qui commence après une fin annoncée : l'agent continue.
       * On le montre au lieu de le laisser travailler derrière un écran
       * qui a rendu la main.
       */
      if (tour.fini) rouvrir(conv, tour);
      break;
    case "attente":
      // Le modèle n'a encore rien rendu : on dit pourquoi, au lieu d'annoncer une panne.
      patch(conv, tour.replyId, { statut: event.etat === "fin" ? undefined : texteAttente(event) });
      break;
    case "statut":
      patch(conv, tour.replyId, { statut: event.text });
      break;
    case "reasoning":
      if (tour.repris && current.reasoning?.endsWith(event.text)) break;
      patch(conv, tour.replyId, {
        reasoning: current.reasoning ? `${current.reasoning}\n\n${event.text}` : event.text,
      });
      break;
    case "text":
      if (tour.repris && current.content.endsWith(event.text)) break;
      patch(conv, tour.replyId, {
        content: current.content ? `${current.content}\n\n${event.text}` : event.text,
      });
      break;
    case "tool_start": {
      // Repris : un outil déjà relu dans l'historique garde sa ligne.
      if (tour.outils.has(event.callID)) break;
      const { libelle, cible } = actionOutil(event.tool, event.input, conv.dossier);
      const traces: ToolTrace[] = [
        ...(current.tools ?? []),
        { name: nomOutil(event.tool), args: argumentsOutil(event.input), running: true, libelle, cible, debut: recu },
      ];
      tour.outils.set(event.callID, traces.length - 1);
      patch(conv, tour.replyId, { tools: traces });
      break;
    }
    case "tool_end": {
      const position = tour.outils.get(event.callID);
      if (position === undefined) break;
      const traces = (current.tools ?? []).map((trace, i) =>
        i === position
          ? {
              ...trace,
              running: false,
              ok: event.ok,
              preview: event.preview,
              ...(trace.debut !== undefined ? { duree: Math.max(0, recu - trace.debut) } : {}),
            }
          : trace,
      );
      patch(conv, tour.replyId, { tools: traces });
      break;
    }
    case "error":
      /*
       * L'échec doit rendre la main : afficher le motif, arrêter le
       * défilement, et surtout libérer `busy`. Sans ce dernier point, la
       * conversation se croit occupée pour toujours et ignore
       * silencieusement tout ce que l'utilisateur tape ensuite.
       */
      terminer(conv, tour, event.message);
      break;
    case "fin":
      // Fin sans « stop » (longueur, filtre) : ce qui est écrit reste une réponse.
      terminer(conv, tour, event.note, "fini");
      break;
    case "done":
      terminer(conv, tour);
      break;
  }
}

/** Abonne la conversation au flux d'événements d'une session. */
function listen(conv: ConversationCode, sessionID: string) {
  fermerFlux(conv);
  /*
   * `after` : le dernier événement déjà reçu de cette session. Sans lui,
   * OpenCode rejoue toute l'histoire de la session à chaque abonnement.
   */
  const dernier = memoire.dernierSeq.get(sessionID);
  const suite = dernier !== undefined ? `&after=${dernier}` : "";
  /*
   * `sessionID` désigne la session OpenCode ; l'authentification, elle,
   * passe par un billet à usage unique ajouté par `ouvrirFlux` sous le nom
   * `flux` (lib/flux.ts). Deux paramètres du même nom auraient donné le
   * premier des deux à la passerelle.
   */
  const fermer = ouvrirFlux(
    `/oxoai/code/events?sessionID=${encodeURIComponent(sessionID)}${suite}`,
    (donnees) => {
      let parsed: { durable?: { seq?: unknown } };
      try {
        parsed = JSON.parse(donnees);
      } catch {
        return;
      }
      const seq = parsed?.durable?.seq;
      if (typeof seq === "number") {
        const vu = memoire.dernierSeq.get(sessionID);
        if (vu === undefined || seq > vu) memoire.dernierSeq.set(sessionID, seq);
      }
      // Tout ce qui arrive, même un événement qu'on n'affiche pas, prouve que l'agent vit.
      conv.dernierSigne = Date.now();
      const event = translate(parsed);
      if (!event) return;
      const tour = conv.tour;
      if (!tour || tour.sessionID !== sessionID) return;
      /*
       * OxoAI prépare une application avant d'envoyer la demande (plusieurs
       * minutes avec un petit modèle) : l'étape en cours s'affiche tout de
       * suite, sans attendre l'identifiant de la demande.
       */
      if (event.kind === "statut" && event.preparation && !tour.fini) {
        patch(conv, tour.replyId, { statut: event.text });
        return;
      }
      // L'envoi n'a pas encore dit quel est notre message : on garde pour plus tard.
      if (tour.messageID === undefined && !tour.actif) {
        tour.enAttente.push({ event, recu: Date.now() });
        return;
      }
      appliquer(conv, tour, event);
    },
    {
      /*
       * La reprise est faite ici plutôt que par `ouvrirFlux` : elle doit
       * repartir du dernier événement reçu (`after`), pas de l'adresse
       * d'origine.
       */
      reprendre: false,
      onOuvert: () => {
        conv.reabonnements = 0;
      },
      onErreur: () => {
        if (conv.flux?.fermer !== fermer) return;
        conv.flux = null;
        const tour = conv.tour;
        /*
         * Au repos, rien à faire : l'envoi suivant se réabonnera. Sauf juste
         * après un tour : le contrôle automatique de OxoAI peut encore relancer
         * l'agent (gateway/src/controleCode.ts). Vu le 26/09/2026 : le flux
         * tombé entre deux corrections, l'écran ratait toutes les suivantes.
         */
        const relancePossible = tour?.fini && tour.finiLe !== undefined && Date.now() - tour.finiLe < 15 * 60_000;
        if (!tour || tour.sessionID !== sessionID || (tour.fini && !relancePossible)) return;
        if (tour.fini) {
          setTimeout(() => {
            if (conv.tour === tour && !conv.flux && memoire.affichee === conv) listen(conv, sessionID);
          }, 2000);
          return;
        }
        /*
         * En plein travail : on se réabonne, sans rien perdre ni rien
         * rejouer. Le flux pouvait tomber sans prévenir (délai
         * d'inactivité de la passerelle, redémarrage du moteur) ; l'écran
         * libérait alors la conversation sans un mot, et la réponse
         * n'arrivait jamais.
         */
        if (conv.reabonnements < REABONNEMENTS_MAX) {
          conv.reabonnements += 1;
          const generation = conv.generation;
          setTimeout(() => {
            if (conv.generation === generation && conv.tour === tour && !tour.fini) listen(conv, sessionID);
          }, 1000 * conv.reabonnements);
          return;
        }
        terminer(
          conv,
          tour,
          t("La connexion avec l'agent de code a été perdue : la suite de sa réponse n'a pas pu être affichée. Ses modifications de fichiers, elles, ont pu continuer."),
        );
      },
    },
  );
  conv.flux = { sessionID, fermer };
}

/**
 * Session de travail de l'écran Code, adossée à OpenCode.
 * Les événements du moteur sont traduits dans le même format de message que le
 * Chat, si bien que l'affichage est partagé.
 *
 * @param dossier Dossier de travail choisi. Transmis à l'ouverture de la
 * session : le moteur y ancre le projet, comme un éditeur qu'on ouvre sur un
 * répertoire.
 * @param reglages Modèle et niveau de raisonnement choisis à l'écran. Ils
 * partent avec chaque demande : l'instance les applique à la session s'ils ont
 * changé. Ils n'étaient transmis nulle part — les sélecteurs de l'écran Code
 * étaient décoratifs.
 */
export function useCode(dossier?: string, reglages: ReglagesCode = {}) {
  /*
   * Une autre personne connectée : les conversations précédentes ne sont pas
   * les siennes. Leurs sessions d'agent sont arrêtées, pas seulement cachées.
   */
  const moi = currentUser().id;
  if (memoire.proprietaire !== moi) {
    for (const conv of toutes()) {
      if (conv.busy && conv.tour) void interruptCode(conv.tour.sessionID);
      fermerFlux(conv);
      conv.generation += 1;
      conv.tour = null;
    }
    memoire.proprietaire = moi;
    memoire.enFond.clear();
    memoire.affichee = conversationNeuve();
  }

  const [status, setStatus] = useState<CodeStatus | null>(null);
  const lire = () => memoire.affichee;
  const [messages, setMessages] = useState<Message[]>(lire().messages);
  const [busy, setBusy] = useState(lire().busy);
  const [suivi, setSuivi] = useState<SuiviCode | null>(lire().suivi);
  /** Session affichée (celle que l'adresse `/code?s=` désigne une fois ouverte). */
  const [sessionId, setSessionId] = useState<string | null>(lire().session);
  const [error, setError] = useState<string | undefined>();

  const reglagesRef = useRef(reglages);
  reglagesRef.current = reglages;
  /** Dossier d'une nouvelle session : le choisi, sinon celui que l'instance propose. */
  const dossierRef = useRef<string | undefined>(dossier);
  dossierRef.current = dossier ?? status?.projectDir;

  // Cet écran suit la conversation affichée, qu'elle change par lui ou pendant son absence.
  useEffect(() => {
    const suivre = () => {
      const conv = memoire.affichee;
      setMessages(conv.messages);
      setBusy(conv.busy);
      setSuivi(conv.suivi);
      setSessionId(conv.session);
    };
    memoire.abonnes.add(suivre);
    suivre();
    return () => {
      memoire.abonnes.delete(suivre);
    };
  }, []);

  useEffect(() => {
    fetchCodeStatus()
      .then(setStatus)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      // Au repos, le flux peut se fermer ; en plein travail, il continue de
      // remplir la conversation pour le retour de la personne.
      const conv = memoire.affichee;
      if (!conv.tour || conv.tour.fini) fermerFlux(conv);
    };
  }, []);

  const send = useCallback(
    async (text: string) => {
      // La conversation affichée au moment de l'envoi : la réponse lui reste, même si l'écran en change.
      const conv = memoire.affichee;
      const prompt = text.trim();
      if (!prompt || conv.busy) return;
      setError(undefined);
      const generation = conv.generation;
      const reglagesEnvoi = { ...reglagesRef.current };
      if (!conv.session) conv.dossier = dossierRef.current;

      /*
       * La demande s'affiche et la conversation est occupée AVANT d'ouvrir la
       * session. L'ouverture peut prendre plusieurs secondes (démarrage du
       * moteur, chauffe) : l'écran restait vide pendant ce temps, la saisie
       * effacée, et un second clic ouvrait une seconde session.
       */
      const replyId = newId();
      commit(conv, [
        ...conv.messages,
        { id: newId(), role: "user", content: prompt },
        {
          id: replyId,
          role: "assistant",
          content: "",
          streaming: true,
          statut: conv.session ? undefined : t("Démarrage de l'agent de code..."),
          durees: { debut: Date.now() },
        },
      ]);
      conv.suivi = suiviNeuf();
      conv.dernierSigne = Date.now();
      marquerOccupe(conv, true);

      try {
        if (!conv.session) {
          const ouverte = await createCodeSession(reglagesEnvoi, dossier);
          if (conv.generation !== generation) return;
          conv.session = ouverte;
          prevenir();
          // La session entre dans la liste tout de suite, avec son indicateur « en cours ».
          signalerSessionsCode();
        }
      } catch (err) {
        if (conv.generation !== generation) return;
        patch(conv, replyId, {
          streaming: false,
          statut: undefined,
          error: err instanceof Error ? err.message : String(err),
        });
        if (conv.suivi) conv.suivi = terminerSuivi(conv.suivi, "echec");
        marquerOccupe(conv, false);
        return;
      }

      const sessionID = conv.session!;
      const tour: Tour = {
        replyId,
        sessionID,
        actif: false,
        enAttente: [],
        fini: false,
        outils: new Map(),
      };
      conv.tour = tour;
      conv.reabonnements = 0;
      // Flux absent (première demande, ou tombé pendant le repos) : on s'abonne.
      if (conv.flux?.sessionID !== sessionID) listen(conv, sessionID);

      /*
       * Une demande arrêtée reste dans l'historique de la session : OpenCode
       * ne sait pas l'en retirer (essayé : `revert` la marque, le modèle la
       * reçoit encore). Vu le 23/09/2026 : arrêtée avant d'avoir commencé,
       * elle était exécutée à la demande suivante (« réponds OK » a créé les
       * fichiers de la demande arrêtée). On le dit donc au modèle, sans
       * l'afficher : l'écran montre ce que la personne a écrit.
       */
      const texte = conv.arretee
        ? `[La demande précédente a été arrêtée par la personne : ne la réalise pas, sauf si elle la redemande.]\n\n${prompt}`
        : prompt;
      conv.arretee = false;

      try {
        const { relance, messageID } = await sendCodePrompt(sessionID, texte, reglagesEnvoi);
        if (conv.generation !== generation) {
          // Arrêté pendant l'envoi : la session relancée travaille peut-être déjà.
          if (relance) void interruptCode(relance);
          return;
        }
        /*
         * Si l'instance a dû relancer la demande dans une session neuve (la
         * première était perdue), on suit la nouvelle : c'est elle qui répond.
         */
        if (relance) {
          conv.session = relance;
          tour.sessionID = relance;
          tour.enAttente = [];
          listen(conv, relance);
          prevenir();
        }
        // La liste des sessions de Code : titre (la première demande) et date viennent de changer.
        signalerSessionsCode();
        if (messageID === undefined) {
          // Réponse sans identifiant : on ne peut pas trier, on prend tout.
          tour.actif = true;
        }
        tour.messageID = messageID;
        const enAttente = tour.enAttente;
        tour.enAttente = [];
        for (const { event, recu } of enAttente) appliquer(conv, tour, event, recu);
      } catch (err) {
        if (conv.generation !== generation) return;
        terminer(conv, tour, err instanceof Error ? err.message : String(err));
      }
    },
    [dossier],
  );

  const stop = useCallback(() => {
    const conv = memoire.affichee;
    conv.generation += 1;
    const tour = conv.tour;
    // Plus rien de ce tour ne doit toucher l'écran : ses derniers échos arrivent après.
    conv.tour = null;
    const session = tour?.sessionID ?? conv.session;
    if (session) conv.arretee = true;
    if (conv.suivi) conv.suivi = terminerSuivi(conv.suivi, "arrete");
    if (tour && !tour.fini) {
      tour.fini = true;
      const current = conv.messages.find((m) => m.id === tour.replyId);
      const note = t("Arrêté à votre demande.");
      patch(conv, tour.replyId, {
        streaming: false,
        statut: undefined,
        tools: current?.tools?.map((trace) =>
          trace.running ? { ...trace, running: false, ok: false, preview: note } : trace,
        ),
        content: current?.content ? `${current.content}\n\n*${note}*` : note,
      });
    } else {
      // Arrêt pendant l'ouverture de la session : la réponse attendait encore.
      const enCours = conv.messages.find((m) => m.role === "assistant" && m.streaming);
      if (enCours) patch(conv, enCours.id, { streaming: false, statut: undefined, content: t("Arrêté à votre demande.") });
    }
    marquerOccupe(conv, false);
    if (session) {
      void interruptCode(session).then((ok) => {
        if (!ok) {
          setError(t("L'arrêt n'a pas été confirmé par l'agent de code : il travaille peut-être encore."));
        }
      });
    }
  }, []);

  /*
   * Arrêter une seule tâche du panneau de suivi (demandé par Medhi le
   * 26/09/2026, comme « Tâches en arrière-plan » de Claude Code). Une
   * sous-tâche a sa propre session chez OpenCode : on n'arrête qu'elle, et
   * l'agent principal lit l'échec de sa sous-tâche puis continue. Une commande
   * n'a pas de session à elle : OpenCode ne sait arrêter une commande qu'en
   * arrêtant le tour entier, et c'est ce que fait le bouton (il le dit).
   */
  const arreterAction = useCallback(
    (action: ActionCode) => {
      if (action.tool === "task" && action.sousSession) {
        void interruptCode(action.sousSession).then((ok) => {
          if (!ok) setError(t("L'arrêt de la sous-tâche n'a pas été confirmé par l'agent de code."));
        });
        return;
      }
      stop();
    },
    [stop],
  );

  const reset = useCallback(() => {
    // Repartir de zéro ne doit pas laisser l'agent travailler en arrière-plan, sans écran.
    const conv = memoire.affichee;
    if (conv.busy && conv.tour) void interruptCode(conv.tour.sessionID);
    conv.generation += 1;
    fermerFlux(conv);
    conv.tour = null;
    if (conv.busy) marquerOccupe(conv, false);
    memoire.affichee = conversationNeuve();
    setError(undefined);
    prevenir();
  }, []);

  /**
   * Revenir à l'accueil de Code pour une nouvelle session, **sans arrêter**
   * celle qui travaille : comme dans Claude Code, elle continue hors de
   * l'écran, et se retrouve dans la liste des sessions (indicateur « en
   * cours »), où on la rouvre pour voir la suite (`ouvrir`).
   */
  const nouvelle = useCallback(() => {
    detacher(memoire.affichee);
    memoire.affichee = conversationNeuve();
    setError(undefined);
    prevenir();
  }, []);

  /**
   * Rouvre une session de la liste. Quittée pendant que l'agent y
   * travaillait, elle est encore ici, flux ouvert : l'écran la reprend telle
   * quelle, sans rien relire ni rejouer. Sinon, son historique est relu chez
   * OpenCode par l'instance (rien n'est gardé en double ici) ; si l'agent ou
   * OxoAI y travaille encore (ouverte ailleurs, page rechargée), l'écran se
   * rebranche sur son flux à partir du dernier évènement vu par l'instance.
   * La session déjà affichée (retour depuis une autre page) n'est pas relue.
   *
   * Rend le dossier de la session, quand il est connu.
   */
  const ouvrir = useCallback(
    async (id: string): Promise<string | undefined> => {
      if (memoire.affichee.session === id) return memoire.affichee.dossier;
      const gardee = [...memoire.enFond].find((c) => c.session === id);
      detacher(memoire.affichee);
      setError(undefined);
      if (gardee) {
        memoire.enFond.delete(gardee);
        memoire.affichee = gardee;
        prevenir();
        return gardee.dossier;
      }
      const conv = conversationNeuve();
      memoire.affichee = conv;
      prevenir();
      let h: HistoriqueCode;
      try {
        h = await historiqueSessionCode(id);
      } catch (err) {
        if (memoire.affichee === conv) setError(err instanceof Error ? err.message : String(err));
        return undefined;
      }
      // Une autre session a été ouverte entre-temps : celle-ci n'a plus rien à afficher.
      if (memoire.affichee !== conv) return undefined;
      const dossierSession = h.session.dossier;
      const liste: Message[] = h.messages.map((m) =>
        m.role === "user"
          ? { id: newId(), role: "user", content: m.texte }
          : {
              id: newId(),
              role: "assistant",
              content: m.texte,
              ...(m.raisonnement ? { reasoning: m.raisonnement } : {}),
              tools: m.outils.map((o) => ({
                name: nomOutil(o.tool),
                args: argumentsOutil(o.input),
                running: o.etat === "encours",
                ok: o.etat === "fini",
                preview: o.apercu,
                ...actionOutil(o.tool, o.input, dossierSession),
              })),
            },
      );
      conv.session = id;
      conv.dossier = dossierSession;
      memoire.dernierSeq.set(id, h.dernier);
      if (h.enCours) {
        /*
         * L'agent travaille encore : sa réponse commencée (le dernier message,
         * s'il est de lui) reçoit la suite du flux, outils en cours compris,
         * au lieu d'une seconde bulle qui répéterait le début. Le dernier
         * message est celui de la personne quand OxoAI prépare encore la
         * demande : une bulle attend alors la suite.
         */
        const derniere = liste[liste.length - 1];
        const outils = new Map<string, number>();
        let replyId: string;
        if (derniere?.role === "assistant") {
          replyId = derniere.id;
          const brut = h.messages[h.messages.length - 1]!;
          brut.outils.forEach((o, i) => o.callID && outils.set(o.callID, i));
          liste[liste.length - 1] = { ...derniere, streaming: true, statut: t("L'agent travaille encore sur cette session...") };
        } else {
          replyId = newId();
          liste.push({ id: replyId, role: "assistant", content: "", streaming: true, statut: t("L'agent travaille encore sur cette session...") });
        }
        conv.tour = { replyId, sessionID: id, actif: true, enAttente: [], fini: false, outils, repris: true };
        conv.suivi = suiviNeuf();
        conv.dernierSigne = Date.now();
        commit(conv, liste);
        marquerOccupe(conv, true);
        listen(conv, id);
      } else {
        commit(conv, liste);
      }
      return dossierSession;
    },
    [],
  );

  /** Relit l'état du moteur de code (après son installation par OxoAI). */
  const rafraichirStatut = useCallback(() => fetchCodeStatus().then(setStatus), []);

  return { status, messages, busy, error, send, stop, arreterAction, reset, suivi, sessionId, nouvelle, ouvrir, rafraichirStatut };
}
