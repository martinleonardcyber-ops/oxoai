import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { t, tf } from "./langue.ts";
import { nomProduit } from "./marque.ts";
import { workspaces } from "./mcp.ts";
import { cheminReel, contientUneZone, estProtege } from "./zonesProtegees.ts";
import {
  dossierLmStudio,
  dossierLmStudioHabituel,
  dossierTelechargementsLmStudio,
  fichierPointeurLmStudio,
  incoherenceEmplacement,
  installationDans,
  lmStudioEnPlace,
  placeMoteurLlmster,
  pointeurLmStudio,
  pointeurNonSuivi,
} from "./engine.ts";
import { SOUS_DOSSIER_LLAMA, dossierModelesLlama, dossierModelesParDefaut, emplacementLlamaChoisi, ecrireEmplacementLlama } from "./llamaCppBase.ts";
import { deplacerModelesLlama, deplacementLlamaEnCours, octetsModelesLlama, telechargementLlamaEnCours } from "./llamaCpp.ts";

/**
 * Où vont le moteur et les modèles : le choix de l'administrateur.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────────
 *
 * Demandé par Medhi le 28/09/2026 : « pour installer son modèle etc. il
 * faudrait pouvoir choisir où on l'installe avec LM Studio, car il y a des
 * gens dont le disque principal n'a pas la place (ils ont un disque D: par
 * exemple) ». Un modèle pèse de 2 à 18 Go, le moteur de LM Studio jusqu'à
 * 1,3 Go de paquet : sur un PC au disque système plein, l'installation
 * échouait au milieu, sans que rien ne propose d'aller ailleurs.
 *
 * ── Comment ─────────────────────────────────────────────────────────────────
 *
 *  - LM Studio, avant la première installation (ni moteur, ni modèle, ni
 *    téléchargement commencé, nulle part) : OxoAI écrit
 *    `~/.lmstudio-home-pointer` vers `<dossier choisi>/LM Studio`. C'est le
 *    fichier par lequel LM Studio trouve son dossier tout entier (engine.ts,
 *    code ouvert lu le 28/09/2026) : moteur, téléchargements en cours et
 *    modèles vont alors sur ce disque. Jamais après : déplacer le dossier
 *    d'un LM Studio qui tourne peut abîmer ce qu'il écrit. L'écran dit
 *    alors comment faire soi-même, OxoAI fermé.
 *  - llama.cpp (Mac Intel) : les modèles vont dans
 *    `<dossier choisi>/modeles-llamacpp` (llamaCppBase.ts). Après coup, OxoAI
 *    les déplace lui-même (llamaCpp.ts, `deplacerModelesLlama`) : le moteur
 *    est à lui, il sait l'arrêter.
 *
 * ── Ce qui est refusé ───────────────────────────────────────────────────────
 *
 * Même règle que le pointeur suivi par `dossierLmStudio` (faille « Élevé » du
 * 27/09/2026, SECURITE.md) : c'est de ce dossier que la passerelle lance
 * `lms`. Donc un chemin absolu, sur un disque de cette machine (pas un
 * partage réseau : sous Windows, un chemin `\\serveur` enverrait les
 * identifiants du compte à ce serveur), créable, inscriptible et à ce compte,
 * hors de l'espace de travail des agents et des zones protégées. Et hors du
 * dossier personnel : en « Tout mon poste », il devient l'espace des agents,
 * et `dossierLmStudio` cesserait alors de suivre le pointeur (le moteur
 * paraîtrait disparu). L'emplacement habituel y est déjà, de toute façon.
 * Le sous-dossier choisi devient une zone protégée (zonesProtegees.ts).
 */

export type MoteurLocal = "lmstudio" | "llamacpp";

/** Le sous-dossier créé dans le dossier choisi : les données de OxoAI n'y sont jamais mêlées à ce qui s'y trouve. */
export const sousDossier = (moteur: MoteurLocal): string => (moteur === "lmstudio" ? "LM Studio" : SOUS_DOSSIER_LLAMA);

/** Forme de comparaison : macOS et Windows ignorent la casse. */
const replier = (c: string) => resolve(c).normalize("NFC").toLowerCase();
const dedans = (chemin: string, parent: string) => {
  const a = replier(chemin);
  const b = replier(parent);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** Le parent existant le plus proche (le dossier choisi peut ne pas exister encore). */
function ancetreExistant(chemin: string): string {
  let c = resolve(chemin);
  while (!existsSync(c)) {
    const parent = dirname(c);
    if (parent === c) break;
    c = parent;
  }
  return c;
}

/** Ce chemin est-il un lien symbolique (ou une jonction sous Windows) ? Absent : non. */
function estUnLien(chemin: string): boolean {
  try {
    return lstatSync(chemin).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Place libre sur le disque de ce chemin, en octets (null si illisible). */
export function placeLibre(chemin: string): number | null {
  try {
    const s = statfsSync(ancetreExistant(chemin));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/* ── Disque de la machine, ou partage réseau ? ─────────────────────────── */

/** Systèmes de fichiers réseau sous Linux (`/proc/self/mounts`). */
const RESEAU_LINUX = new Set([
  "nfs", "nfs4", "cifs", "smb3", "smbfs", "sshfs", "fuse.sshfs", "9p", "afs", "ncpfs", "davfs", "fuse.davfs2",
  "glusterfs", "fuse.glusterfs", "ceph", "fuse.ceph", "fuse.rclone", "fuse.s3fs", "lustre", "gpfs", "fuse.smbnetfs",
]);

/**
 * Le point de montage le plus proche de ce chemin est-il un partage réseau ?
 * macOS : `mount` marque « local » ce qui est sur la machine (disque interne,
 * disque externe, clé USB) ; un partage SMB, AFP, NFS ou WebDAV ne l'est pas.
 * Linux : le type de système de fichiers. Illisible : refusé (on ne sait pas).
 */
function surPartageReseau(chemin: string): boolean {
  if (process.platform === "win32") return lecteurReseauWindows(chemin);
  let montages: { point: string; local: boolean }[] = [];
  try {
    if (process.platform === "darwin") {
      const sortie = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
      for (const ligne of sortie.split("\n")) {
        const m = /^(.+?) on (.+) \(([^)]*)\)$/.exec(ligne);
        if (m) montages.push({ point: m[2]!, local: m[3]!.split(",").map((s) => s.trim()).includes("local") });
      }
    } else {
      const decoder = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
      for (const ligne of readFileSync("/proc/self/mounts", "utf8").split("\n")) {
        const [source, point, type] = ligne.split(" ");
        if (!source || !point || !type) continue;
        montages.push({ point: decoder(point), local: !RESEAU_LINUX.has(type) && !source.startsWith("//") && !/^[^/\s]+:\//.test(source) });
      }
    }
  } catch {
    return true;
  }
  montages = montages.filter((m) => chemin === m.point || chemin.startsWith(m.point.endsWith("/") ? m.point : `${m.point}/`));
  const plusProche = montages.sort((a, b) => b.point.length - a.point.length)[0];
  return plusProche ? !plusProche.local : false;
}

/**
 * Windows : le type du lecteur (`DriveInfo.DriveType`, « Network » pour un
 * lecteur réseau comme Z:). Un chemin `\\serveur` est refusé avant d'arriver
 * ici. Si PowerShell ne répond pas, le lecteur est accepté : la lettre a été
 * choisie par l'administrateur dans le sélecteur du système, et le refus du
 * chemin réseau, qui est le vrai danger (identifiants envoyés à un serveur),
 * ne dépend pas de ce contrôle. Écrit pour Windows, pas essayé sur un PC.
 */
function lecteurReseauWindows(chemin: string): boolean {
  const lettre = /^([A-Za-z]):/.exec(chemin)?.[1];
  if (!lettre) return true;
  try {
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const sortie = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command", `[System.IO.DriveInfo]::new('${lettre}').DriveType`], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return sortie.trim() === "Network";
  } catch {
    return false;
  }
}

/* ── Validation d'un dossier ───────────────────────────────────────────── */

export type Validation =
  | { ok: true; choisi: string; dossier: string; libre: number | null; cree?: string }
  | { ok: false; message: string };

const refus = (message: string): Validation => ({ ok: false, message });
const messagePartage = () => t("Un partage réseau ne convient pas : choisissez un disque de cette machine (les modèles s'y lisent en continu, et un chemin réseau enverrait les identifiants de ce compte au serveur).");

/**
 * Juge le dossier saisi ou choisi. Avec `creer`, crée aussi le sous-dossier
 * (`LM Studio` ou `modeles-llamacpp`) et y écrit un fichier d'essai, effacé
 * aussitôt : un disque en lecture seule ou plein se voit tout de suite, pas
 * au milieu d'un téléchargement de 5 Go.
 */
export function validerEmplacement(brut: unknown, moteur: MoteurLocal, creer: boolean): Validation {
  if (typeof brut !== "string") return refus(t("Indiquez un dossier."));
  const saisi = brut.trim();
  // eslint-disable-next-line no-control-regex
  if (!saisi || saisi.length > 1000 || /[\u0000-\u001f]/.test(saisi)) return refus(t("Ce chemin n'est pas valable."));
  if (/^[\\/]{2}/.test(saisi)) return refus(messagePartage());
  const absolu = process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(saisi) && !saisi.slice(2).includes(":") : saisi.startsWith("/");
  if (!absolu) return refus(t("Indiquez un chemin complet, par exemple D:\\Modeles sous Windows ou /Volumes/Disque sous macOS."));

  // Le chemin réel : un lien symbolique vers une zone protégée est jugé comme sa cible.
  const choisi = cheminReel(resolve(saisi));
  // Sous Windows, un lecteur réseau (Z:) se résout parfois en `\\serveur\partage`.
  if (/^[\\/]{2}/.test(choisi) || surPartageReseau(choisi)) return refus(messagePartage());
  const maison = cheminReel(homedir());
  if (dedans(choisi, maison)) {
    return refus(t("Choisissez un dossier hors de votre dossier personnel, sur un autre disque de préférence : l'emplacement habituel y est déjà, et ce dossier peut être ouvert aux agents."));
  }
  /*
   * L'espace des agents. En « Tout mon poste », il comprend le dossier
   * personnel (refusé plus haut) puis les autres disques entiers (D: à Z:,
   * /Volumes) : un autre disque doit alors rester possible, c'est tout
   * l'objet de ce réglage. Le sous-dossier choisi y devient une zone
   * protégée, comme `~/.lmstudio` l'est dans le dossier personnel.
   */
  const espaces = workspaces();
  const toutLePoste = espaces.length > 1 && replier(espaces[0]!) === replier(homedir());
  for (const w of toutLePoste ? espaces.slice(0, 1) : espaces) {
    const reel = cheminReel(w);
    if (dedans(choisi, reel) || dedans(reel, choisi)) {
      return refus(t("Ce dossier est dans l'espace de travail des agents, ou le contient : les agents pourraient y écrire. Choisissez-en un autre."));
    }
  }
  if (estProtege(choisi) || contientUneZone(choisi)) {
    return refus(t("Ce dossier est protégé (données de l'instance, clés, réglages d'autres logiciels), ou en contient : choisissez-en un autre."));
  }

  const dossier = join(choisi, sousDossier(moteur));
  const existant = ancetreExistant(choisi);
  /*
   * Le sous-dossier lui-même ne doit pas être un lien (test d'intrusion du
   * 28/09/2026, SECURITE.md § 58). Les contrôles ci-dessus portent sur le
   * chemin réel du dossier choisi ; un `LM Studio` ou `modeles-llamacpp` déjà
   * posé là en lien symbolique menait ailleurs sans repasser par eux : essayé,
   * le pointeur était écrit vers un lien qui aboutissait dans l'espace des
   * agents (d'où la passerelle aurait lancé `bin/lms`), et les modèles du
   * moteur ouvert allaient dans les données de l'instance. Un lien ne sert à
   * rien ici : refusé, avant et après la création.
   */
  if (estUnLien(dossier)) return refus(tf("{0} est un lien symbolique : choisissez un dossier où il n'y en a pas.", dossier));
  try {
    if (!statSync(existant).isDirectory()) return refus(t("Ce chemin mène à un fichier, pas à un dossier."));
    if (existsSync(dossier) && !statSync(dossier).isDirectory()) return refus(tf("{0} existe déjà et n'est pas un dossier.", dossier));
    // Le moteur ouvert range ses modèles dans un sous-dossier neuf : rien de ce qui y serait déjà ne risque d'être pris pour un reste.
    if (moteur === "llamacpp" && existsSync(dossier) && readdirSync(dossier).length > 0) {
      return refus(tf("Le dossier {0} existe déjà et n'est pas vide : choisissez un autre emplacement.", dossier));
    }
  } catch {
    return refus(t("Ce dossier n'est pas lisible."));
  }

  if (!creer) {
    try {
      accessSync(existsSync(dossier) ? dossier : existant, constants.W_OK);
    } catch {
      return refus(t("Ce compte n'a pas le droit d'écrire dans ce dossier."));
    }
    return { ok: true, choisi, dossier, libre: placeLibre(existant) };
  }

  let cree: string | undefined;
  try {
    cree = mkdirSync(dossier, { recursive: true, mode: 0o700 });
  } catch (err) {
    return refus(tf("Le dossier n'a pas pu être créé ({0}).", (err as NodeJS.ErrnoException).code ?? String(err)));
  }
  const annuler = () => retirerCrees(dossier, cree);
  // Un lien posé entre le contrôle et la création, ou un chemin réel qui n'est plus le chemin écrit : rien n'est retenu.
  if (estUnLien(dossier) || replier(cheminReel(dossier)) !== replier(dossier)) {
    annuler();
    return refus(tf("{0} est un lien symbolique : choisissez un dossier où il n'y en a pas.", dossier));
  }
  try {
    const st = statSync(dossier);
    // Comme `dossierLmStudio` (engine.ts) : un dossier d'un autre compte n'est pas suivi.
    if (process.platform !== "win32" && typeof process.getuid === "function" && st.uid !== process.getuid()) {
      annuler();
      return refus(t("Ce dossier appartient à un autre compte de la machine : choisissez-en un à vous."));
    }
    const sonde = join(dossier, `.oxoai-essai-${randomBytes(4).toString("hex")}`);
    writeFileSync(sonde, "essai", { flag: "wx" });
    rmSync(sonde, { force: true });
  } catch (err) {
    annuler();
    return refus(tf("Impossible d'écrire dans ce dossier ({0}).", (err as NodeJS.ErrnoException).code ?? String(err)));
  }
  return { ok: true, choisi, dossier, libre: placeLibre(dossier), cree };
}

/**
 * Le dossier saisi est-il celui déjà retenu pour ce moteur ? Rend alors
 * l'emplacement retenu (le sous-dossier), sinon null.
 *
 * Revue du 28/09/2026 : rechoisi (un second clic sur « Changer », le même
 * disque), il était refusé par `validerEmplacement`, puisque son
 * sous-dossier est devenu une zone protégée (« Ce dossier est protégé… »),
 * et que celui du moteur ouvert n'est plus vide une fois un modèle posé.
 * Rien ne change dans ce cas : il n'y a rien à juger ni à écrire.
 */
function dejaRetenu(brut: unknown, moteur: MoteurLocal): string | null {
  if (typeof brut !== "string" || !brut.trim()) return null;
  // LM Studio : seulement un pointeur suivi (un pointeur vers un dossier disparu se rechoisit pour être recréé).
  const actuel = moteur === "llamacpp" ? emplacementLlamaChoisi() : pointeurNonSuivi() ? null : pointeurLmStudio();
  if (!actuel) return null;
  const dossier = join(cheminReel(resolve(brut.trim())), sousDossier(moteur));
  return replier(dossier) === replier(actuel) ? actuel : null;
}

/** Retire les dossiers vides créés par `mkdirSync` (du plus profond jusqu'au premier créé), jamais un dossier plein. */
function retirerCrees(dossier: string, premierCree: string | undefined): void {
  if (!premierCree) return;
  let c = resolve(dossier);
  const fin = resolve(premierCree);
  for (;;) {
    try {
      rmdirSync(c);
    } catch {
      return;
    }
    if (c === fin) return;
    const parent = dirname(c);
    if (parent === c) return;
    c = parent;
  }
}

/* ── L'état, pour l'écran ──────────────────────────────────────────────── */

export interface EtatDeplacement {
  phase: "en-cours" | "fini" | "erreur";
  message: string;
  percent?: number;
  erreur?: string;
}

let deplacement: EtatDeplacement | null = null;

export interface EtatEmplacement {
  /** Le moteur local de cette instance, ou null s'il n'y en a pas (LM Studio coupé, intégrateur). */
  moteur: MoteurLocal | null;
  /** Où vont (ou sont) le moteur et les modèles : le dossier de LM Studio, ou celui des modèles du moteur ouvert. */
  dossier: string;
  /** L'emplacement habituel. */
  habituel: string;
  parDefaut: boolean;
  /** Place libre sur ce disque (octets), null si illisible ou disque absent. */
  libre: number | null;
  /** Le dossier choisi a disparu (disque débranché) : rien ne s'y pose. */
  introuvable: boolean;
  /**
   * Ce que l'écran peut proposer : choisir librement (rien d'installé),
   * déplacer (modèles du moteur ouvert), expliquer (LM Studio déjà en place),
   * ou rien.
   */
  changement: "libre" | "deplacement" | "manuel" | "aucun";
  /** Octets déjà posés à cet emplacement (modèles du moteur ouvert). */
  occupe?: number;
  /** LM Studio déjà en place : de quoi écrire la marche à suivre. */
  manuel?: { dossier: string; pointeur: string; lms: string; modeles: string | null };
  /** Une incohérence à dire (emplacement introuvable, moteur posé ailleurs). */
  alerte?: string;
  /** « Revenir à l'emplacement habituel » est-il possible sans rien perdre ni déplacer ? */
  revenir?: boolean;
  deplacement: EtatDeplacement | null;
}

/** Le moteur local de l'instance (null : aucun à régler d'ici). */
export function moteurLocal(lmStudioActif: boolean, ouvert: boolean): MoteurLocal | null {
  if (ouvert) return "llamacpp";
  return lmStudioActif ? "lmstudio" : null;
}

export function etatEmplacement(moteur: MoteurLocal | null): EtatEmplacement {
  if (moteur === "llamacpp") {
    const dossier = dossierModelesLlama();
    const choisi = emplacementLlamaChoisi();
    const introuvable = Boolean(choisi && !existsSync(dirname(choisi)));
    const occupe = octetsModelesLlama();
    return {
      moteur,
      dossier,
      habituel: dossierModelesParDefaut(),
      parDefaut: choisi === null,
      libre: introuvable ? null : placeLibre(dossier),
      introuvable,
      changement: deplacementLlamaEnCours() ? "aucun" : occupe > 0 ? "deplacement" : "libre",
      occupe,
      // Retour à l'emplacement habituel : un déplacement comme un autre (les modèles reviennent avec).
      revenir: choisi !== null && !deplacementLlamaEnCours(),
      ...(introuvable ? { alerte: tf("L'emplacement choisi pour les modèles est introuvable ({0}) : branchez le disque, ou changez d'emplacement.", dirname(choisi!)) } : {}),
      deplacement,
    };
  }
  if (moteur === "lmstudio") {
    const dossier = dossierLmStudio();
    const habituel = dossierLmStudioHabituel();
    const nonSuivi = pointeurNonSuivi();
    const enPlace = lmStudioEnPlace();
    const alerte = incoherenceEmplacement() ?? undefined;
    return {
      moteur,
      dossier: nonSuivi ?? dossier,
      habituel,
      parDefaut: !nonSuivi && replier(dossier) === replier(habituel),
      libre: nonSuivi ? null : placeLibre(dossier),
      introuvable: Boolean(nonSuivi),
      changement: enPlace && !nonSuivi ? "manuel" : "libre",
      ...(enPlace && !nonSuivi
        ? {
            manuel: {
              dossier: enPlace,
              pointeur: fichierPointeurLmStudio(),
              lms: join(enPlace, "bin", process.platform === "win32" ? "lms.exe" : "lms"),
              modeles: dossierTelechargementsLmStudio(enPlace),
            },
          }
        : {}),
      // Revenir à l'emplacement habituel ne perd rien tant que le dossier choisi ne porte pas d'installation.
      revenir: Boolean(nonSuivi) || (replier(dossier) !== replier(habituel) && !installationDans(dossier)),
      ...(alerte ? { alerte } : {}),
      deplacement: null,
    };
  }
  return { moteur: null, dossier: "", habituel: "", parDefaut: true, libre: null, introuvable: false, changement: "aucun", deplacement: null };
}

/** Place nécessaire, en octets : moteur (LM Studio, s'il n'est pas posé) et modèle conseillé, plus 1 Go de marge. */
export function placeNecessaire(moteur: MoteurLocal | null, moteurInstalle: boolean, modeleGo: number): number {
  const pourMoteur = moteur === "lmstudio" && !moteurInstalle ? placeMoteurLlmster() : 0;
  return pourMoteur + Math.round(modeleGo * 1e9) + 1e9;
}

/* ── Choisir ───────────────────────────────────────────────────────────── */

export type Issue = { statut: number; corps: Record<string, unknown>; journal?: Record<string, unknown> };

/**
 * Choisit l'emplacement (`brut` : le dossier choisi ; null : l'emplacement
 * habituel). `occupe` : une installation du moteur ou une mise en route
 * tourne, rien ne change pendant ce temps.
 */
export function choisirEmplacement(moteur: MoteurLocal | null, brut: unknown, occupe: boolean): Issue {
  if (!moteur) return { statut: 409, corps: { error: { message: t("Aucun moteur de modèles local sur cette instance : il n'y a pas d'emplacement à choisir.") } } };
  if (occupe) return { statut: 409, corps: { error: { message: t("Une installation est en cours : attendez qu'elle se termine, puis changez d'emplacement.") } } };
  return moteur === "lmstudio" ? choisirLmStudio(brut) : choisirLlama(brut);
}

/**
 * LM Studio : le pointeur, seulement tant que rien n'est installé. Revenir à
 * l'emplacement habituel retire le pointeur, seulement s'il désigne un
 * dossier où rien n'est installé (ou introuvable : son contenu reste sur le
 * disque débranché, rien n'est effacé).
 */
function choisirLmStudio(brut: unknown): Issue {
  const avant = pointeurLmStudio();
  const suiviAvant = dossierLmStudio();
  const nonSuivi = pointeurNonSuivi();

  if (brut === null) {
    if (replier(suiviAvant) === replier(dossierLmStudioHabituel()) && !nonSuivi) return { statut: 200, corps: { ok: true } };
    if (!nonSuivi && installationDans(suiviAvant)) {
      return { statut: 409, corps: { error: { message: tf("LM Studio est déjà installé à cet emplacement : {0} ne le déplace pas. Voyez la marche à suivre dans les réglages, Modèles locaux.", nomProduit()) } } };
    }
    rmSync(fichierPointeurLmStudio(), { force: true });
    if (!nonSuivi && basename(suiviAvant) === "LM Studio") {
      try {
        rmdirSync(suiviAvant);
      } catch {
        /* pas vide : laissé tel quel */
      }
    }
    return { statut: 200, corps: { ok: true }, journal: { moteur: "lmstudio", dossier: dossierLmStudioHabituel(), avant } };
  }

  const retenu = dejaRetenu(brut, "lmstudio");
  if (retenu) return { statut: 200, corps: { ok: true, dossier: retenu, libre: placeLibre(retenu) } };
  const deja = lmStudioEnPlace();
  if (deja) {
    return {
      statut: 409,
      corps: { error: { message: tf("LM Studio est déjà installé ({0}) : son emplacement ne se change plus d'ici. Voyez la marche à suivre dans les réglages, Modèles locaux.", deja) } },
    };
  }
  const v = validerEmplacement(brut, "lmstudio", true);
  if (!v.ok) return { statut: 400, corps: { error: { message: v.message } } };
  if (replier(v.dossier) === replier(suiviAvant) && !nonSuivi) return { statut: 200, corps: { ok: true, dossier: v.dossier, libre: v.libre } };

  // Écrit à côté puis renommé : un pointeur à moitié écrit enverrait LM Studio n'importe où.
  const provisoire = `${fichierPointeurLmStudio()}.${process.pid}.tmp`;
  try {
    writeFileSync(provisoire, v.dossier, { mode: 0o644 });
    renameSync(provisoire, fichierPointeurLmStudio());
  } catch (err) {
    rmSync(provisoire, { force: true });
    retirerCrees(v.dossier, v.cree);
    return { statut: 500, corps: { error: { message: tf("Le choix n'a pas pu être enregistré ({0}).", (err as NodeJS.ErrnoException).code ?? String(err)) } } };
  }
  // Suivi par la passerelle ? Sinon (dossier refusé par `dossierLmStudio`), l'ancien pointeur revient.
  if (replier(dossierLmStudio()) !== replier(v.dossier)) {
    if (avant === null) rmSync(fichierPointeurLmStudio(), { force: true });
    else writeFileSync(fichierPointeurLmStudio(), avant);
    retirerCrees(v.dossier, v.cree);
    return { statut: 400, corps: { error: { message: t("Ce dossier ne peut pas servir à LM Studio sur cette machine. Choisissez-en un autre.") } } };
  }
  // L'ancien dossier choisi, s'il est vide (un premier choix changé avant l'installation).
  if (!nonSuivi && replier(suiviAvant) !== replier(dossierLmStudioHabituel()) && basename(suiviAvant) === "LM Studio") {
    try {
      rmdirSync(suiviAvant);
    } catch {
      /* pas vide */
    }
  }
  return { statut: 200, corps: { ok: true, dossier: v.dossier, libre: v.libre }, journal: { moteur: "lmstudio", dossier: v.dossier, avant } };
}

/** llama.cpp : sans modèle, le choix est retenu tout de suite ; avec, les modèles sont déplacés (202, progression dans l'état). */
function choisirLlama(brut: unknown): Issue {
  if (deplacementLlamaEnCours()) return { statut: 409, corps: { error: { message: t("Un déplacement des modèles est déjà en cours.") } } };
  if (telechargementLlamaEnCours()) return { statut: 409, corps: { error: { message: t("Un téléchargement est en cours : attendez qu'il se termine, puis changez d'emplacement.") } } };
  const avant = emplacementLlamaChoisi();
  let cible: string | null = null;
  let cree: string | undefined;
  if (brut !== null) {
    const retenu = dejaRetenu(brut, "llamacpp");
    if (retenu) return { statut: 200, corps: { ok: true, dossier: retenu, libre: placeLibre(retenu) } };
    const v = validerEmplacement(brut, "llamacpp", true);
    if (!v.ok) return { statut: 400, corps: { error: { message: v.message } } };
    cible = v.dossier;
    cree = v.cree;
  } else if (avant === null) {
    return { statut: 200, corps: { ok: true } };
  }

  const aDeplacer = octetsModelesLlama();
  if (aDeplacer === 0) {
    ecrireEmplacementLlama(cible);
    if (avant && basename(avant) === SOUS_DOSSIER_LLAMA) {
      try {
        rmdirSync(avant);
      } catch {
        /* pas vide */
      }
    }
    return { statut: 200, corps: { ok: true, dossier: dossierModelesLlama() }, journal: { moteur: "llamacpp", dossier: dossierModelesLlama(), avant } };
  }

  deplacement = { phase: "en-cours", message: t("Préparation du déplacement..."), percent: 0 };
  void deplacerModelesLlama(cible, (a) => {
    deplacement = { phase: "en-cours", message: a.message, percent: a.percent };
  })
    .then(() => {
      deplacement = { phase: "fini", message: t("Modèles déplacés."), percent: 100 };
      console.log(`[oxoai] modèles du moteur ouvert déplacés vers ${dossierModelesLlama()}.`);
    })
    .catch((err: unknown) => {
      retirerCrees(cible ?? dossierModelesParDefaut(), cree);
      deplacement = { phase: "erreur", message: t("Le déplacement des modèles a échoué."), erreur: err instanceof Error ? err.message : String(err) };
    });
  return {
    statut: 202,
    corps: { ok: true, deplacement: true, dossier: cible ?? dossierModelesParDefaut(), octets: aDeplacer },
    journal: { moteur: "llamacpp", dossier: cible ?? dossierModelesParDefaut(), avant, deplacement: aDeplacer },
  };
}

/** Juge un dossier sans rien créer : la place libre, avant de confirmer un déplacement. */
export function verifierEmplacement(moteur: MoteurLocal | null, brut: unknown): Issue {
  if (!moteur) return { statut: 409, corps: { error: { message: t("Aucun moteur de modèles local sur cette instance : il n'y a pas d'emplacement à choisir.") } } };
  const retenu = dejaRetenu(brut, moteur);
  if (retenu) return { statut: 200, corps: { ok: true, dossier: retenu, libre: placeLibre(retenu), actuel: true } };
  const v = validerEmplacement(brut, moteur, false);
  if (!v.ok) return { statut: 400, corps: { error: { message: v.message } } };
  return { statut: 200, corps: { ok: true, dossier: v.dossier, libre: v.libre } };
}
