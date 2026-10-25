/*
 * Préchargement de la fenêtre du bot de réunion (voir botReunion.cjs).
 *
 * Il tourne AVANT les scripts de Google Meet, dans le même monde qu'eux
 * (isolation de contexte coupée pour cette seule fenêtre) : c'est la seule
 * façon de voir passer les pistes audio des participants. Chaque connexion
 * WebRTC créée par la page est observée ; ses pistes audio entrantes sont
 * mêlées dans un graphe Web Audio, et un enregistreur en tire des morceaux
 * Opus toutes les dix secondes, envoyés au processus principal.
 *
 * Rien n'est exposé à la page : `ipcRenderer` reste dans cette fermeture, et
 * le seul canal ouvert transporte du son vers la réunion que ce bot enregistre.
 * La fenêtre ne charge que meet.google.com et accounts.google.com.
 *
 * ── Pourquoi l'isolation est coupée, et ce qui la remplace ──────────────────
 *
 * Partager le monde de la page est ce qui permet de voir ses connexions
 * WebRTC. L'API qui ferait les deux — isolation active *et* exécution d'un
 * correctif dans le monde principal — est `contextBridge.executeInMainWorld`,
 * présente depuis Electron 35 (nous sommes en 44). Elle n'a pas été reprise :
 * voir ce qu'elle apporterait, plus bas.
 *
 * Ce qui tient : pas d'accès à Node (`nodeIntegration` coupé, `sandbox`
 * actif, rien sur `window`), et la page ne peut parler au processus principal
 * que par les deux canaux de ce bot (`oxoai:bot-morceau`, `oxoai:bot-fini`),
 * que botReunion.cjs n'accepte que de la fenêtre de ce bot ; les autres
 * canaux `oxoai:*` vérifient qu'ils viennent de la fenêtre principale.
 *
 * Ce qui ne tient pas, dit comme tel (seconde tournée du test d'intrusion,
 * 28/09/2026). Les références d'origine capturées ici ne protègent pas le son
 * d'une page hostile : ce sont les mêmes objets que ceux de la page, qu'elle
 * peut modifier (`EventTarget.prototype.addEventListener`, le prototype de
 * `MediaRecorder`, `Blob[Symbol.hasInstance]`, `Promise.prototype.then`…).
 * Essayé sur Electron 44.4.5 : une page qui remplace `addEventListener`
 * récupère notre écouteur de `dataavailable` et lui passe un `Blob` à elle ;
 * le contrôle `instanceof` le laisse passer, et ce son part à l'instance. De
 * toute façon, c'est la page qui fournit le son de la réunion : un Google
 * Meet hostile pourrait aussi bien jouer un faux participant par WebRTC.
 * Aucune isolation ne rend un compte rendu plus vrai que la page d'où il
 * vient. L'isolation retirerait seulement à la page la main sur ce fichier et
 * sur le code interne d'Electron de la fenêtre ; il faudrait, pour la
 * reprendre, installer l'enregistreur dans le monde de la page et lui exposer
 * une fonction d'envoi, que la page pourrait appeler tout autant. Non fait :
 * cela ne s'essaie que sur une vraie réunion.
 *
 * On garde donc les références capturées (elles écartent un script de la page
 * qui remplacerait simplement `MediaRecorder` ou `AudioContext`), sans leur
 * prêter plus.
 */
const { ipcRenderer } = require("electron");

(() => {
  const Origine = window.RTCPeerConnection;
  if (!Origine) return;

  /*
   * Références d'origine, prises avant que la page n'ait pu s'exécuter. Tout
   * le reste du fichier passe par elles, jamais par `window.…` relu plus tard.
   */
  const Enregistreur = window.MediaRecorder;
  const Contexte = window.AudioContext || window.webkitAudioContext;
  const Flux = window.MediaStream;
  const BlobOrigine = window.Blob;
  const enTableau = BlobOrigine && BlobOrigine.prototype.arrayBuffer;
  const typeSupporte = Enregistreur && Enregistreur.isTypeSupported;
  if (!Enregistreur || !Contexte || !Flux || !enTableau) return;

  let contexte = null;
  let destination = null;
  let enregistreur = null;
  const pistes = new Set();
  const enAttente = [];

  function graphe() {
    if (!contexte) {
      contexte = new Contexte({ sampleRate: 48000 });
      destination = contexte.createMediaStreamDestination();
      // Un signal nul maintient le flux ouvert même quand personne ne parle.
      const silence = contexte.createConstantSource();
      silence.offset.value = 0;
      silence.connect(destination);
      silence.start();
    }
    return contexte;
  }

  function brancher(piste) {
    if (!piste || piste.kind !== "audio" || pistes.has(piste.id)) return;
    pistes.add(piste.id);
    if (!contexte) {
      enAttente.push(piste);
      return;
    }
    try {
      contexte.createMediaStreamSource(new Flux([piste])).connect(destination);
    } catch {
      /* piste déjà terminée : rien à capter */
    }
  }

  function Connexion(...args) {
    const pc = new Origine(...args);
    pc.addEventListener("track", (e) => brancher(e.track));
    return pc;
  }
  Connexion.prototype = Origine.prototype;
  Object.setPrototypeOf(Connexion, Origine);
  window.RTCPeerConnection = Connexion;
  window.webkitRTCPeerConnection = Connexion;

  function demarrer() {
    if (enregistreur) return;
    graphe();
    void contexte.resume();
    for (const p of enAttente.splice(0)) {
      pistes.delete(p.id);
      brancher(p);
    }
    const opus = "audio/webm;codecs=opus";
    const type = typeSupporte && typeSupporte.call(Enregistreur, opus) ? opus : "audio/webm";
    enregistreur = new Enregistreur(destination.stream, { mimeType: type, audioBitsPerSecond: 32000 });
    enregistreur.addEventListener("dataavailable", (e) => {
      /*
       * Un `Blob` non vide, converti par la méthode d'origine. Ce n'est pas
       * une garantie contre la page : un `Blob` qu'elle fabrique passe ce
       * contrôle (voir en tête de fichier) ; il écarte seulement un événement
       * mal formé.
       */
      const donnees = e && e.data;
      if (!(donnees instanceof BlobOrigine) || donnees.size <= 0) return;
      void enTableau.call(donnees).then((b) => ipcRenderer.send("oxoai:bot-morceau", b));
    });
    enregistreur.addEventListener("stop", () => {
      // Le dernier morceau part avant ce signal : le processus principal peut conclure.
      setTimeout(() => ipcRenderer.send("oxoai:bot-fini"), 300);
    });
    enregistreur.start(10_000);
  }

  function arreter() {
    if (enregistreur && enregistreur.state !== "inactive") enregistreur.stop();
    else ipcRenderer.send("oxoai:bot-fini");
  }

  ipcRenderer.on("oxoai:bot-demarrer", demarrer);
  ipcRenderer.on("oxoai:bot-arreter", arreter);
})();
