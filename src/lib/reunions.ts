import { apiFetch, authToken, sessionToken } from "./endpoint";
import { instance } from "./instance";
import { t, tf } from "@/lib/i18n";

/**
 * Réunions (gateway/src/reunions.ts) : enregistrer au micro, importer un
 * fichier, ou envoyer le bot à une réunion Google Meet, puis lire la
 * transcription et le compte rendu faits sur la machine.
 */

export type Statut =
  | "enregistrement"
  | "bot-connexion"
  | "bot-attente"
  | "bot-en-cours"
  | "file"
  | "transcription"
  | "resume"
  | "prete"
  | "erreur";
export type Langue = "fr" | "en" | "auto";
export type Visibilite = "prive" | "groupes" | "organisation";

export interface Action {
  tache: string;
  qui?: string;
  echeance?: string;
}

export interface CompteRendu {
  resume: string;
  points: string[];
  decisions: string[];
  actions: Action[];
  modele: string;
  origine: "local" | "agence";
  pays?: string;
  redigeLe: string;
}

export interface Reunion {
  id: string;
  titre: string;
  ownerId: string;
  source: "micro" | "import" | "bot";
  lien?: string;
  evenement?: string;
  statut: Statut;
  message?: string;
  progression?: number;
  langue: Langue;
  createdAt: string;
  updatedAt: string;
  dureeSecondes?: number;
  audio: { morceaux: number; octets: number; conserve: boolean };
  aTranscription: boolean;
  compteRendu?: CompteRendu;
  visibilite: Visibilite;
  groupes: string[];
  estProprietaire?: boolean;
}

export interface Segment {
  debut: number;
  fin: number;
  texte: string;
}

export interface Reglages {
  nomBot: string;
  langue: Langue;
  conserverAudio: boolean;
  compteRenduAuto: boolean;
  botAuto: boolean;
}

export interface EtatReunions {
  reunions: Reunion[];
  reglages: Reglages;
  transcription: { installee: boolean; modele: string };
  agenda: boolean;
}

async function lire<T>(res: Response): Promise<T> {
  const corps = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  return corps;
}

const poster = (chemin: string, corps: unknown = {}) =>
  apiFetch(chemin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });
const chemin = (id: string, action = "") => `/oxoai/reunions/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

export const chargerReunions = async (): Promise<EtatReunions> => lire(await apiFetch("/oxoai/reunions"));
export const lireReunion = async (id: string): Promise<{ reunion: Reunion; segments: Segment[] }> => lire(await apiFetch(chemin(id)));
export const creerReunion = async (d: { titre?: string; source: Reunion["source"]; lien?: string; langue?: Langue }): Promise<Reunion> =>
  (await lire<{ reunion: Reunion }>(await poster("/oxoai/reunions", d))).reunion;
export const modifierReunion = async (id: string, d: { titre?: string; visibilite?: Visibilite; groupes?: string[] }): Promise<Reunion> =>
  (await lire<{ reunion: Reunion }>(await poster(chemin(id), d))).reunion;
export const terminerReunion = async (id: string): Promise<Reunion> =>
  (await lire<{ reunion: Reunion }>(await poster(chemin(id, "terminer")))).reunion;
export const resumerReunion = async (id: string): Promise<Reunion> =>
  (await lire<{ reunion: Reunion }>(await poster(chemin(id, "resumer")))).reunion;
export const relancerReunion = async (id: string): Promise<Reunion> =>
  (await lire<{ reunion: Reunion }>(await poster(chemin(id, "relancer")))).reunion;
export const supprimerReunion = async (id: string): Promise<void> => {
  await lire(await poster(chemin(id, "supprimer")));
};
export const lireReglages = async (): Promise<Reglages> => (await lire<{ reglages: Reglages }>(await apiFetch("/oxoai/reunions/reglages"))).reglages;
export const modifierReglages = async (d: Partial<Reglages>): Promise<Reglages> =>
  (await lire<{ reglages: Reglages }>(await poster("/oxoai/reunions/reglages", d))).reglages;

/** Envoie du son brut à une réunion en cours d'enregistrement (ou un fichier importé, d'un bloc). */
export async function envoyerSon(id: string, son: Blob): Promise<void> {
  await lire(await apiFetch(chemin(id, "audio"), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: son }));
}

/** L'audio conservé d'une réunion, pour l'écouter. */
export async function lireAudio(id: string): Promise<Blob> {
  const r = await apiFetch(chemin(id, "audio"));
  if (!r.ok) {
    const corps = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(corps.error?.message ?? t("Audio indisponible."));
  }
  return new Blob([await r.arrayBuffer()], { type: "audio/webm" });
}

/** Formats acceptés à l'import : audio, et vidéo dont on garde le son. */
export const ACCEPT_AUDIO = ".mp3,.m4a,.mp4,.wav,.webm,.ogg,.oga,.opus,.aiff,.aif,.flac,.mov";
export const IMPORT_MAX = 2 * 1024 * 1024 * 1024;

export const LEGENDE_STATUT: Record<Statut, string> = {
  enregistrement: "Enregistrement",
  "bot-connexion": t("Le bot rejoint la réunion"),
  "bot-attente": "En attente d'admission",
  "bot-en-cours": t("Le bot enregistre"),
  file: t("En attente de transcription"),
  transcription: t("Transcription"),
  resume: t("Rédaction du compte rendu"),
  prete: "Prête",
  erreur: "Erreur",
};

/** « 1 h 05 », « 12 min ». */
export function dureePlaisante(secondes?: number): string {
  if (!secondes) return "";
  const h = Math.floor(secondes / 3600);
  const m = Math.round((secondes % 3600) / 60);
  return h > 0 ? tf("{0} h {1}", h, String(m).padStart(2, "0")) : tf("{0} min", Math.max(1, m));
}

export function horodatage(secondes: number): string {
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  const s = Math.floor(secondes % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/* ---- Enregistrement au micro ---------------------------------------------- */

/**
 * Enregistre une réunion au micro du poste. Le son part par morceaux de dix
 * secondes, l'un après l'autre : si l'application se ferme, seules les
 * dernières secondes manquent, et l'instance transcrit ce qu'elle a reçu.
 */
export class EnregistreurReunion {
  private flux: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private envois: Promise<void> = Promise.resolve();
  private contexte: AudioContext | null = null;
  private analyseur: AnalyserNode | null = null;
  private echec: string | null = null;
  readonly reunionId: string;

  constructor(reunionId: string) {
    this.reunionId = reunionId;
  }

  async demarrer(): Promise<void> {
    this.flux = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((f) => MediaRecorder.isTypeSupported(f));
    this.recorder = new MediaRecorder(this.flux, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32_000 });
    this.recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size === 0) return;
      const morceau = e.data;
      this.envois = this.envois.then(() =>
        envoyerSon(this.reunionId, morceau).catch((err) => {
          this.echec = err instanceof Error ? err.message : String(err);
        }),
      );
    });
    this.recorder.start(10_000);
    // Niveau du son, pour montrer que le micro entend quelque chose.
    this.contexte = new AudioContext();
    this.analyseur = this.contexte.createAnalyser();
    this.analyseur.fftSize = 512;
    this.contexte.createMediaStreamSource(this.flux).connect(this.analyseur);
  }

  /** Niveau de 0 à 1. */
  niveau(): number {
    if (!this.analyseur) return 0;
    const donnees = new Uint8Array(this.analyseur.fftSize);
    this.analyseur.getByteTimeDomainData(donnees);
    let max = 0;
    for (const v of donnees) max = Math.max(max, Math.abs(v - 128));
    return Math.min(1, max / 64);
  }

  get enPause(): boolean {
    return this.recorder?.state === "paused";
  }

  pause(): void {
    if (this.recorder?.state === "recording") this.recorder.pause();
  }

  reprendre(): void {
    if (this.recorder?.state === "paused") this.recorder.resume();
  }

  /** Dernière erreur d'envoi, s'il y en a eu une. */
  get erreur(): string | null {
    return this.echec;
  }

  /** Arrête, attend que tout le son soit parti, et lance la transcription. */
  async terminer(): Promise<Reunion> {
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((ok) => {
        recorder.addEventListener("stop", () => ok(), { once: true });
        recorder.stop();
      });
    }
    this.relacher();
    await this.envois;
    return terminerReunion(this.reunionId);
  }

  /** Arrête sans rien garder de plus que ce qui est déjà parti. */
  abandonner(): void {
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      /* déjà arrêté */
    }
    this.relacher();
  }

  private relacher(): void {
    this.flux?.getTracks().forEach((p) => p.stop());
    this.flux = null;
    void this.contexte?.close().catch(() => undefined);
    this.contexte = null;
    this.analyseur = null;
  }
}

/*
 * L'enregistrement en cours vit ici, pas dans l'écran : on peut aller voir
 * ses tâches pendant la réunion, l'enregistrement continue, et l'écran des
 * réunions le retrouve au retour.
 */
let courant: EnregistreurReunion | null = null;
export const ENREGISTREMENT_CHANGE = "oxoai:enregistrement-reunion";

export function enregistrementCourant(): EnregistreurReunion | null {
  return courant;
}

export function retenirEnregistrement(e: EnregistreurReunion | null): void {
  courant = e;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ENREGISTREMENT_CHANGE));
}

/* ---- Bot de réunion (application de bureau) --------------------------------- */

export interface BotEnCours {
  reunionId: string;
  titre: string;
  phase: "connexion" | "attente" | "enregistrement" | "fin" | "erreur";
  message: string | null;
  depuis: string | null;
  visible: boolean;
}

interface PontBot {
  envoyer: (d: { reunionId: string; lien: string; titre: string; nom: string; passerelle: Passerelle }) => Promise<BotEnCours[]>;
  arreter: (reunionId: string) => Promise<BotEnCours[]>;
  afficher: (reunionId: string) => Promise<BotEnCours[]>;
  liste: () => Promise<BotEnCours[]>;
  automatique: (a: { passerelle: Passerelle; nom: string } | null) => Promise<boolean>;
  compte: (action: "etat" | "connecter" | "oublier") => Promise<{ connecte: boolean }>;
  surChangement: (rappel: (bots: BotEnCours[]) => void) => () => void;
}

interface Passerelle {
  url: string;
  jeton: string;
  seance: string;
}

/** Le pont du bot, présent seulement dans l'application de bureau. */
export function pontBot(): PontBot | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { oxoai?: { bot?: PontBot } }).oxoai?.bot ?? null;
}

/** Ce que le processus principal doit savoir pour envoyer le son à l'instance : jamais écrit sur le disque. */
export function passerelle(): Passerelle | null {
  const jeton = authToken();
  const seance = sessionToken();
  if (!jeton || !seance) return null;
  return { url: instance().url, jeton, seance };
}

/** Nom affiché du bot : celui des réglages, sinon « Prise de notes <produit> ». */
export const nomDuBot = (reglages: Reglages, produit: string) => reglages.nomBot.trim() || tf("Prise de notes {0}", produit);
