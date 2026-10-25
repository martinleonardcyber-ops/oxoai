import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import {
  diagnosticDictee,
  dossierModeleDictee,
  environnementHorsLigne,
  interpreteur,
  modeleDicteeCourant,
} from "./atelier.ts";

/**
 * Dictée : transcription locale de la voix, pour le bouton micro du composeur.
 *
 * Pourquoi pas la reconnaissance vocale du navigateur : dans Chromium, donc
 * dans Electron, `SpeechRecognition` envoie le son aux serveurs de Google. Le
 * produit promet que rien ne sort vers un fournisseur américain ; une dictée
 * qui ferait l'inverse en silence ruinerait toutes les autres promesses. Le son
 * est donc transcrit ici, par Whisper (faster-whisper), dans le venv isolé de
 * l'atelier, sans réseau.
 *
 * Garde-fous, dans l'ordre où ils s'appliquent :
 * - la route exige une séance (tableau `EXECUTION` de index.ts) ;
 * - la taille du son est bornée, annoncée comme lue ;
 * - seuls quelques conteneurs audio sont acceptés, reconnus à leurs premiers
 *   octets : le décodeur (FFmpeg, via PyAV) n'ouvre que ce qu'on lui destine ;
 * - le son est posé dans un fichier temporaire du dossier de données, lisible
 *   par ce seul compte, **toujours supprimé** ensuite, succès comme échec ;
 * - le script Python est une constante de ce module, lancé par `execFile` avec
 *   un tableau d'arguments, jamais par un shell ; les arguments sont le chemin
 *   du fichier (tiré au sort ici), le dossier du modèle et une langue prise
 *   dans une liste fermée ;
 * - l'interpréteur tourne hors ligne (`HF_HUB_OFFLINE`), en mode isolé (`-I`),
 *   avec un environnement réduit.
 */

/**
 * Taille maximale d'un enregistrement.
 *
 * L'interface enregistre en Opus à 32 kbit/s et coupe à cinq minutes, soit
 * environ 1,2 Mo. 8 Mo laissent de la marge à un navigateur qui ignorerait le
 * débit demandé, sans laisser une requête occuper la mémoire de la passerelle.
 */
export const AUDIO_MAX = 8 * 1024 * 1024;

/** Cinq minutes de voix se transcrivent en moins d'une minute avec `small`. */
const DELAI = 3 * 60_000;

/**
 * Deux transcriptions simultanées au plus : chacune charge un modèle
 * d'environ 500 Mo en mémoire. Au-delà, on répond « occupé » plutôt que de
 * laisser une instance partagée s'effondrer sous les dictées de toute l'équipe.
 */
const SIMULTANEES_MAX = 2;
let actives = 0;

/** Langues admises. Liste fermée : la valeur finit en argument d'un processus. */
const LANGUES = new Set(["fr", "en", "de", "es", "it", "nl", "pt"]);

/** Fils de calcul : 8 au plus, mesuré comme le meilleur réglage sur un M4. */
const FILS = Math.max(1, Math.min(8, availableParallelism()));

/** Dossier des fichiers temporaires, sous le dossier de données de l'instance. */
export const dossierTemporaire = (): string =>
  join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "dictee");

/** Erreur destinée à l'utilisateur, avec le code HTTP qui la porte. */
export class ErreurDictee extends Error {
  readonly statut: number;
  constructor(statut: number, message: string) {
    super(message);
    this.statut = statut;
  }
}

/**
 * Lit le corps audio de la requête, en s'arrêtant **dès** le dépassement.
 *
 * La taille annoncée est vérifiée avant de lire quoi que ce soit ; la taille
 * réelle ensuite, morceau par morceau, parce qu'un en-tête peut mentir ou
 * manquer (envoi par morceaux).
 */
export async function lireAudio(req: http.IncomingMessage): Promise<Buffer> {
  const trop = new ErreurDictee(
    413,
    `Enregistrement trop volumineux (limite : ${AUDIO_MAX / (1024 * 1024)} Mo). Dictez en plusieurs fois.`,
  );
  const annonce = Number(req.headers["content-length"]);
  if (Number.isFinite(annonce) && annonce > AUDIO_MAX) throw trop;

  const morceaux: Buffer[] = [];
  let taille = 0;
  for await (const morceau of req) {
    taille += (morceau as Buffer).length;
    if (taille > AUDIO_MAX) throw trop;
    morceaux.push(morceau as Buffer);
  }
  if (taille === 0) throw new ErreurDictee(400, "Aucun son reçu.");
  return Buffer.concat(morceaux);
}

/**
 * Conteneur audio reconnu à ses premiers octets, ou `null`.
 *
 * FFmpeg sait ouvrir des centaines de formats, et chaque démultiplexeur est
 * une surface d'attaque. On n'en laisse passer que cinq : ceux que produisent
 * les navigateurs (WebM, Ogg, MP4) et ceux qui servent aux essais (WAV, AIFF).
 */
function conteneur(son: Buffer): string | null {
  if (son.length < 12) return null;
  const texte = (debut: number, fin: number) => son.subarray(debut, fin).toString("latin1");
  if (son.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (texte(0, 4) === "OggS") return "ogg";
  if (texte(0, 4) === "RIFF" && texte(8, 12) === "WAVE") return "wav";
  if (texte(4, 8) === "ftyp") return "m4a";
  if (texte(0, 4) === "FORM" && (texte(8, 12) === "AIFF" || texte(8, 12) === "AIFC")) return "aiff";
  return null;
}

/**
 * Script de transcription. Constante du module : rien n'y est interpolé.
 *
 * - Le modèle est chargé depuis son **dossier**, jamais depuis un nom de
 *   dépôt : faster-whisper n'appelle alors pas le téléchargeur du tout, et
 *   `local_files_only` double la précaution.
 * - `vad_filter` retire les silences avant transcription : un blanc ne produit
 *   rien, au lieu d'une phrase inventée.
 * - L'invite initiale est une phrase française ordinaire avec un nom propre.
 *   Mesuré sur la phrase d'essai : « la société durant » devient « la société
 *   Durand », sans rien changer au reste. Sur trois secondes de silence, la
 *   sortie reste vide (le filtre de silence passe avant).
 * - La réponse est du JSON en ASCII après un marqueur : un avertissement
 *   imprimé par une bibliothèque ne peut pas la corrompre, et l'encodage de la
 *   sortie standard ne joue plus aucun rôle.
 */
const SCRIPT_TRANSCRIPTION = String.raw`
import json, sys
from faster_whisper import WhisperModel

fichier, modele, langue, fils = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
invite = "Bonjour Madame Martin, voici ma demande." if langue == "fr" else None

whisper = WhisperModel(modele, device="cpu", compute_type="int8", cpu_threads=fils, local_files_only=True)
segments, info = whisper.transcribe(
    fichier,
    language=langue,
    beam_size=5,
    vad_filter=True,
    condition_on_previous_text=False,
    initial_prompt=invite,
)
texte = " ".join(s.text.strip() for s in segments if s.text.strip())
sys.stdout.write("@@OXOAI@@" + json.dumps({"texte": texte, "duree_audio": info.duration}))
`;

const MARQUEUR = "@@OXOAI@@";

export interface Transcription {
  texte: string;
  langue: string;
  modele: string;
  /** Durée du son, en secondes. */
  dureeAudio: number;
  /** Temps de traitement, en millisecondes. */
  dureeMs: number;
}

/**
 * Fichiers laissés par un arrêt brutal (processus tué en pleine
 * transcription). Purgés une fois, avant la première écriture de ce
 * processus : rien de ce qu'il a lui-même posé ne peut donc être emporté.
 */
let purge: Promise<void> | null = null;
async function purgerRestes(dossier: string): Promise<void> {
  const noms = await readdir(dossier).catch(() => [] as string[]);
  await Promise.all(noms.map((nom) => rm(join(dossier, nom), { force: true }).catch(() => {})));
}

function executer(args: string[]): Promise<string> {
  return new Promise((resoudre, rejeter) => {
    execFile(
      interpreteur(),
      args,
      {
        timeout: DELAI,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        env: environnementHorsLigne(),
        windowsHide: true,
      },
      (err, sortie, erreur) => {
        if (err) {
          const detail = String(erreur).trim().split("\n").slice(-4).join(" | ");
          return rejeter(new Error(err.killed ? "délai dépassé" : detail || err.message));
        }
        resoudre(String(sortie));
      },
    );
  });
}

/** Transcrit un enregistrement. Le fichier temporaire ne survit pas à l'appel. */
export async function transcrire(son: Buffer, langue = "fr"): Promise<Transcription> {
  if (!LANGUES.has(langue)) throw new ErreurDictee(400, "Langue de dictée non prise en charge.");

  const format = conteneur(son);
  if (!format) {
    throw new ErreurDictee(415, "Format audio non reconnu. Attendu : WebM, Ogg, MP4, WAV ou AIFF.");
  }

  const etat = await diagnosticDictee();
  if (!etat.installee) {
    throw new ErreurDictee(
      409,
      "La dictée n'est pas installée sur cette instance. Installez-la depuis le bouton micro.",
    );
  }

  // Vérifié et incrémenté sans attente entre les deux : pas de course possible.
  if (actives >= SIMULTANEES_MAX) {
    throw new ErreurDictee(429, "Trop de dictées en cours de transcription. Réessayez dans un instant.");
  }
  actives += 1;

  const dossier = dossierTemporaire();
  const fichier = join(dossier, `${randomBytes(16).toString("hex")}.${format}`);
  const debut = Date.now();

  try {
    await mkdir(dossier, { recursive: true, mode: 0o700 });
    purge ??= purgerRestes(dossier);
    await purge;

    // `wx` : jamais d'écriture dans un fichier qui existerait déjà.
    await writeFile(fichier, son, { mode: 0o600, flag: "wx" });

    let sortie: string;
    try {
      sortie = await executer(["-I", "-c", SCRIPT_TRANSCRIPTION, fichier, dossierModeleDictee(), langue, String(FILS)]);
    } catch (err) {
      // Le détail technique va au journal du serveur, pas à l'écran.
      console.error("[dictee] transcription échouée :", err instanceof Error ? err.message : err);
      throw new ErreurDictee(
        422,
        "La transcription a échoué. L'enregistrement était peut-être vide ou illisible.",
      );
    }

    const rang = sortie.lastIndexOf(MARQUEUR);
    if (rang < 0) throw new ErreurDictee(500, "La transcription n'a rien rendu.");
    const brut = JSON.parse(sortie.slice(rang + MARQUEUR.length)) as {
      texte?: string;
      duree_audio?: number;
    };

    return {
      texte: (brut.texte ?? "").trim(),
      langue,
      modele: modeleDicteeCourant().libelle,
      dureeAudio: Math.round((brut.duree_audio ?? 0) * 10) / 10,
      dureeMs: Date.now() - debut,
    };
  } finally {
    actives -= 1;
    // Toujours, quel que soit le résultat : le son dicté ne reste pas sur disque.
    await rm(fichier, { force: true }).catch(() => {});
  }
}
