import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { detectHardware, type Hardware } from "./provision.ts";
import { journaliser } from "./audit.ts";
import { t, tf } from "./langue.ts";
import {
  APPLICATIONS_MACOS,
  DISQUE_MACOS_GO,
  ECHANGE_MACOS,
  adresseMacos,
  arreterMacos,
  arreterMacosEnPartant,
  demarrerMacos,
  effacerMacos,
  imagePour,
  machineMacosPresente,
  trouverLume,
  versionMacos,
} from "./machineMacos.ts";

const exec = promisify(execFile);

/**
 * La machine de l'agent : un ordinateur à part, où Cowork clique et tape.
 *
 * C'était la décision de départ (ADR-005) : l'agent travaille sur SON
 * ordinateur, pas sur celui de la personne. Une erreur (mauvais clic, fichier
 * effacé, mauvaise page) y reste enfermée, et la personne continue de
 * travailler sur le sien pendant ce temps. Le code qui parle au serveur cua
 * existait, mais rien ne fabriquait ni ne démarrait la machine : le mode
 * n'avait jamais fonctionné.
 *
 * Ce module choisit l'environnement que l'ordinateur peut porter, le prépare,
 * le démarre et l'arrête. Aujourd'hui : un bureau Ubuntu isolé dans un
 * conteneur (image cua, plus LibreOffice), avec Firefox et la bureautique.
 * Sur un Mac Apple Silicon de 32 Go, une machine macOS est aussi possible
 * (Lume, machineMacos.ts) : la personne choisit. Elle n'a pas pu être éprouvée
 * de bout en bout, et le diagnostic le dit.
 *
 * Isolation : ports ouverts sur 127.0.0.1 seulement (jamais sur le réseau),
 * mémoire plafonnée, un seul dossier partagé avec l'ordinateur de la
 * personne : `~/OxoAI/Machine`, par où les documents reviennent.
 */

/** Image de base de cua, épinglée : une nouvelle version ne s'impose pas sans essai. */
const IMAGE_BASE = "trycua/cua-ubuntu@sha256:e2a800152d7d0a2a43b1f7f715f964ecb4a7501b262f3ca626f15a9e6b083e32";
/** Image OxoAI : la base, plus la bureautique en français. Changer le numéro force une reconstruction. */
const IMAGE = "oxoai-machine:3";
const CONTENEUR = "oxoai-machine";
/** Port du serveur de pilotage sur le poste. Pas 8000, trop souvent pris par un autre logiciel. */
export const PORT_MACHINE = Number(process.env.OXOAI_MACHINE_PORT) || 18910;
const MEMOIRE = "3g";

/*
 * La recette de l'image, embarquée : pas de fichier à empaqueter à part.
 *  - LibreOffice Writer, Calc, Impress, en français, avec correcteur ;
 *  - le démarrage de cua tentait une mise à jour sur internet à chaque fois
 *    (deux minutes perdues, et un code qui change sans essai) : retirée ;
 *  - statistiques d'usage de cua coupées ;
 *  - LibreOffice préréglé (fichier oxoai.xcd, encodé ci-dessous) : pas de
 *    fenêtre de récupération (mesuré le 24/09/2026 : après un redémarrage,
 *    elle bloquait tout, et le modèle relançait Writer sept fois), pas
 *    d'astuce du jour, formats Microsoft par défaut et sans question sur le
 *    format ; les sauvegardes de récupération sont effacées au démarrage ;
 *    saisie automatique de Calc coupée (elle complète un mot à la place de
 *    celui qu'on tape, et la tabulation valide la complétion).
 */
const LIBREOFFICE_XCD = "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPG9vcjpkYXRhIHhtbG5zOnhzPSJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYSIgeG1sbnM6eHNpPSJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYS1pbnN0YW5jZSIgeG1sbnM6b29yPSJodHRwOi8vb3Blbm9mZmljZS5vcmcvMjAwMS9yZWdpc3RyeSI+CjxkZXBlbmRlbmN5IGZpbGU9Im1haW4iLz4KPG9vcjpjb21wb25lbnQtZGF0YSBvb3I6bmFtZT0iUmVjb3ZlcnkiIG9vcjpwYWNrYWdlPSJvcmcub3Blbm9mZmljZS5PZmZpY2UiPgo8bm9kZSBvb3I6bmFtZT0iUmVjb3ZlcnlJbmZvIj48cHJvcCBvb3I6bmFtZT0iRW5hYmxlZCIgb29yOm9wPSJmdXNlIj48dmFsdWU+ZmFsc2U8L3ZhbHVlPjwvcHJvcD48L25vZGU+Cjxub2RlIG9vcjpuYW1lPSJBdXRvU2F2ZSI+PHByb3Agb29yOm5hbWU9IkVuYWJsZWQiIG9vcjpvcD0iZnVzZSI+PHZhbHVlPmZhbHNlPC92YWx1ZT48L3Byb3A+PC9ub2RlPgo8L29vcjpjb21wb25lbnQtZGF0YT4KPG9vcjpjb21wb25lbnQtZGF0YSBvb3I6bmFtZT0iQ29tbW9uIiBvb3I6cGFja2FnZT0ib3JnLm9wZW5vZmZpY2UuT2ZmaWNlIj4KPG5vZGUgb29yOm5hbWU9Ik1pc2MiPjxwcm9wIG9vcjpuYW1lPSJTaG93VGlwT2ZUaGVEYXkiIG9vcjpvcD0iZnVzZSI+PHZhbHVlPmZhbHNlPC92YWx1ZT48L3Byb3A+PHByb3Agb29yOm5hbWU9IkZpcnN0UnVuIiBvb3I6b3A9ImZ1c2UiPjx2YWx1ZT5mYWxzZTwvdmFsdWU+PC9wcm9wPjwvbm9kZT4KPG5vZGUgb29yOm5hbWU9IlNhdmUiPjxub2RlIG9vcjpuYW1lPSJEb2N1bWVudCI+PHByb3Agb29yOm5hbWU9Ildhcm5BbGllbkZvcm1hdCIgb29yOm9wPSJmdXNlIj48dmFsdWU+ZmFsc2U8L3ZhbHVlPjwvcHJvcD48L25vZGU+PC9ub2RlPgo8L29vcjpjb21wb25lbnQtZGF0YT4KPG9vcjpjb21wb25lbnQtZGF0YSBvb3I6bmFtZT0iU2V0dXAiIG9vcjpwYWNrYWdlPSJvcmcub3Blbm9mZmljZSI+Cjxub2RlIG9vcjpuYW1lPSJPZmZpY2UiPjxub2RlIG9vcjpuYW1lPSJGYWN0b3JpZXMiPgo8bm9kZSBvb3I6bmFtZT0iY29tLnN1bi5zdGFyLnRleHQuVGV4dERvY3VtZW50Ij48cHJvcCBvb3I6bmFtZT0ib29TZXR1cEZhY3RvcnlEZWZhdWx0RmlsdGVyIiBvb3I6b3A9ImZ1c2UiPjx2YWx1ZT5NUyBXb3JkIDIwMDcgWE1MPC92YWx1ZT48L3Byb3A+PC9ub2RlPgo8bm9kZSBvb3I6bmFtZT0iY29tLnN1bi5zdGFyLnNoZWV0LlNwcmVhZHNoZWV0RG9jdW1lbnQiPjxwcm9wIG9vcjpuYW1lPSJvb1NldHVwRmFjdG9yeURlZmF1bHRGaWx0ZXIiIG9vcjpvcD0iZnVzZSI+PHZhbHVlPkNhbGMgTVMgRXhjZWwgMjAwNyBYTUw8L3ZhbHVlPjwvcHJvcD48L25vZGU+Cjxub2RlIG9vcjpuYW1lPSJjb20uc3VuLnN0YXIucHJlc2VudGF0aW9uLlByZXNlbnRhdGlvbkRvY3VtZW50Ij48cHJvcCBvb3I6bmFtZT0ib29TZXR1cEZhY3RvcnlEZWZhdWx0RmlsdGVyIiBvb3I6b3A9ImZ1c2UiPjx2YWx1ZT5JbXByZXNzIE1TIFBvd2VyUG9pbnQgMjAwNyBYTUw8L3ZhbHVlPjwvcHJvcD48L25vZGU+Cjwvbm9kZT48L25vZGU+Cjwvb29yOmNvbXBvbmVudC1kYXRhPgo8b29yOmNvbXBvbmVudC1kYXRhIG9vcjpuYW1lPSJDYWxjIiBvb3I6cGFja2FnZT0ib3JnLm9wZW5vZmZpY2UuT2ZmaWNlIj4KPG5vZGUgb29yOm5hbWU9IklucHV0Ij48cHJvcCBvb3I6bmFtZT0iQXV0b0lucHV0IiBvb3I6b3A9ImZ1c2UiPjx2YWx1ZT5mYWxzZTwvdmFsdWU+PC9wcm9wPjwvbm9kZT4KPC9vb3I6Y29tcG9uZW50LWRhdGE+Cjwvb29yOmRhdGE+Cg==";
const RECETTE = `FROM ${IMAGE_BASE}
USER root
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 \\
      libreoffice-l10n-fr hunspell-fr fonts-dejavu fonts-liberation2 language-pack-fr \\
    && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN echo ${LIBREOFFICE_XCD} | base64 -d > /usr/lib/libreoffice/share/registry/oxoai.xcd
RUN printf '#!/bin/bash\\nrm -rf /home/kasm-user/.config/libreoffice/4/user/backup\\n/usr/bin/python3 -m computer_server\\n' > /dockerstartup/custom_startup.sh && chmod 755 /dockerstartup/custom_startup.sh
ENV CUA_TELEMETRY=off CUA_TELEMETRY_ENABLED=false LANG=fr_FR.UTF-8 LANGUAGE=fr_FR:fr LC_ALL=fr_FR.UTF-8
USER 1000
`;

/** Dossier partagé entre la machine et l'ordinateur de la personne. */
export function dossierEchange(): string {
  return process.env.OXOAI_MACHINE_ECHANGE ?? join(homedir(), "OxoAI", "Machine");
}
/** Le même, vu de l'intérieur de la machine. */
export const ECHANGE_DANS_LA_MACHINE = "/home/kasm-user/Echanges";

const racineDonnees = () => process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data");

/* ------------------------------------------------------------------ */
/* Le système de la machine : Linux ou macOS                           */
/* ------------------------------------------------------------------ */

export type Systeme = "linux" | "macos";

const fichierSysteme = () => join(racineDonnees(), "machine-systeme");
let systemeRetenu: Systeme | null = null;

/** Le système choisi pour la machine. Linux tant que la personne n'a pas choisi macOS. */
export function systemeMachine(): Systeme {
  if (systemeRetenu) return systemeRetenu;
  try {
    systemeRetenu = readFileSync(fichierSysteme(), "utf8").trim() === "macos" ? "macos" : "linux";
  } catch {
    systemeRetenu = "linux";
  }
  return systemeRetenu;
}

export function choisirSysteme(s: Systeme): void {
  systemeRetenu = s;
  mkdirSync(racineDonnees(), { recursive: true, mode: 0o700 });
  writeFileSync(fichierSysteme(), s, { mode: 0o600 });
}

/** Le dossier d'échange vu de l'intérieur de la machine en service. */
export function echangeDansLaMachine(): string {
  return systemeMachine() === "macos" ? ECHANGE_MACOS : ECHANGE_DANS_LA_MACHINE;
}

/**
 * Adresse du serveur cua de la machine. Linux : le port publié sur
 * 127.0.0.1. macOS : l'adresse que la virtualisation d'Apple lui donne, sur un
 * réseau que seul ce Mac voit ; connue une fois la machine démarrée.
 */
export function adresseMachine(): string {
  if (systemeMachine() === "macos") return adresseMacos() ?? "http://127.0.0.1:1";
  return `http://127.0.0.1:${PORT_MACHINE}`;
}

/* ------------------------------------------------------------------ */
/* Docker                                                              */
/* ------------------------------------------------------------------ */

const CANDIDATS_DOCKER = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker", "docker"];

async function trouverDocker(): Promise<string | null> {
  for (const c of CANDIDATS_DOCKER) {
    if (c.includes("/") && !existsSync(c)) continue;
    try {
      await exec(c, ["--version"], { timeout: 5000 });
      return c;
    } catch {
      /* suivant */
    }
  }
  return null;
}

async function dockerRepond(docker: string): Promise<boolean> {
  try {
    await exec(docker, ["info", "--format", "{{.ServerVersion}}"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Sur Mac, Docker Desktop installé mais éteint : on l'allume, et on attend qu'il réponde. */
async function allumerDocker(docker: string): Promise<boolean> {
  if (await dockerRepond(docker)) return true;
  if (process.platform === "darwin" && existsSync("/Applications/Docker.app")) {
    spawn("open", ["-g", "-a", "Docker"], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await dockerRepond(docker)) return true;
    }
  }
  return false;
}

async function imagePresente(docker: string, image: string): Promise<boolean> {
  try {
    await exec(docker, ["image", "inspect", image], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function etatConteneur(docker: string): Promise<"absent" | "arrete" | "en_marche"> {
  try {
    const { stdout } = await exec(docker, ["inspect", "-f", "{{.State.Running}}", CONTENEUR], { timeout: 8000 });
    return stdout.trim() === "true" ? "en_marche" : "arrete";
  } catch {
    return "absent";
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostic : ce que l'ordinateur peut porter                        */
/* ------------------------------------------------------------------ */

export type Environnement = "linux" | "macos" | "aucun";

export interface DiagnosticMachine {
  /** Ce que OxoAI conseille pour cet ordinateur. */
  conseil: Environnement;
  /** Pourquoi, en une phrase, dans la langue de la personne. */
  raison: string;
  /** Ce qui manque pour le bureau Linux (vide s'il est possible). */
  obstacles: string[];
  memoireGo: number;
  disqueLibreGo: number;
  docker: "absent" | "eteint" | "pret";
  imagePrete: boolean;
  etat: "absent" | "arrete" | "en_marche";
  /** Le serveur de pilotage répond-il ? */
  pret: boolean;
  preparationEnCours: boolean;
  dossierEchange: string;
  /** Le système retenu pour la machine. */
  systeme: Systeme;
  /** La machine macOS : possible sur ce Mac, et sinon pourquoi. */
  macos: { possible: boolean; obstacles: string[]; presente: boolean; lume: boolean };
}

function disqueLibreGo(): number {
  try {
    const s = statfsSync(homedir());
    return Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * Le choix, machine par machine.
 *
 *  - Bureau Linux isolé : 12 Go de mémoire au moins (3 Go pour la machine,
 *    le modèle de vision et le système à côté), 12 Go libres sur le disque
 *    (l'image en fait 7,6), et un moteur de conteneurs (Docker).
 *  - Machine macOS : pour un Mac Apple Silicon de 32 Go et 80 Go libres ; pas
 *    encore faite. On le dit, et on propose le bureau Linux en attendant.
 *  - Sinon, pas de machine à part : on dit pourquoi.
 */
/** Installer Docker, selon le système : sous Linux, le paquet du système plutôt que Docker Desktop (revue du 27/09/2026). */
const conseilDocker = (): string =>
  process.platform === "linux"
    ? t("Docker n'est pas installé : c'est lui qui fait tourner la machine. Installez-le (sudo apt install docker.io, ou sudo dnf install docker), ajoutez votre compte au groupe docker, puis revenez ici.")
    : t("Docker n'est pas installé : c'est lui qui fait tourner la machine. Installez Docker Desktop (docker.com), puis revenez ici.");

function conseiller(hw: Hardware, disque: number, docker: DiagnosticMachine["docker"], installee: boolean): Pick<DiagnosticMachine, "conseil" | "raison" | "obstacles"> {
  const obstacles: string[] = [];
  if (hw.totalMemoryGb < 12) obstacles.push(tf("{0} Go de mémoire : il en faut 12 au moins pour faire tourner la machine à côté du modèle.", hw.totalMemoryGb));
  // Déjà installée : elle n'a plus besoin que d'un peu de marge pour travailler.
  if (!installee && disque < 12) obstacles.push(tf("{0} Go libres sur le disque : il en faut 12 (la machine en occupe environ 8).", disque));
  if (installee && disque < 2) obstacles.push(tf("{0} Go libres sur le disque : la machine a besoin d'un peu de place pour travailler. Libérez de l'espace.", disque));
  if (docker === "absent") obstacles.push(conseilDocker());

  if (obstacles.length > 0) {
    return {
      conseil: "aucun",
      raison: t("Cet ordinateur ne peut pas faire tourner une machine à part pour l'agent. Cowork garde les fichiers et la bureautique ; le contrôle de votre propre écran reste possible, avec votre accord à chaque action."),
      obstacles,
    };
  }
  if (hw.appleSilicon && hw.totalMemoryGb >= 32 && disque >= DISQUE_MACOS_GO) {
    return {
      conseil: "linux",
      raison: tf("{0} Go de mémoire : un bureau Linux isolé, avec Firefox et LibreOffice. Une machine macOS est aussi possible sur ce Mac.", hw.totalMemoryGb),
      obstacles,
    };
  }
  return {
    conseil: "linux",
    raison: tf("{0} Go de mémoire, {1} Go libres : un bureau Linux isolé, avec Firefox et LibreOffice, limité à 3 Go de mémoire.", hw.totalMemoryGb, disque),
    obstacles,
  };
}

let preparation: Promise<void> | null = null;
let progression: { etape: string; message: string; erreur?: string } | null = null;

export function progressionMachine() {
  return progression;
}

/** Une préparation (téléchargement, construction, démarrage) est-elle en cours ? */
export const preparationMachineEnCours = (): boolean => preparation !== null;

/**
 * Ce qui empêche la machine macOS sur ce poste (vide : elle est possible).
 * Mac Apple Silicon, 32 Go (8 pour la machine, le modèle et le système à
 * côté), un macOS assez récent pour une image publiée, et la place.
 */
async function obstaclesMacos(hw: Hardware, disque: number, presente: boolean): Promise<string[]> {
  const obstacles: string[] = [];
  if (process.platform !== "darwin" || !hw.appleSilicon) {
    obstacles.push(t("La machine macOS demande un Mac à puce Apple."));
    return obstacles;
  }
  if (hw.totalMemoryGb < 32) obstacles.push(tf("{0} Go de mémoire : la machine macOS en demande 32 (elle en garde 8 pour elle).", hw.totalMemoryGb));
  if (!imagePour(await versionMacos())) obstacles.push(t("macOS 15.3 ou plus récent est nécessaire pour la machine macOS."));
  if (!presente && disque < DISQUE_MACOS_GO) obstacles.push(tf("{0} Go libres sur le disque : la machine macOS en demande {1} (téléchargement d'environ 23 Go).", disque, DISQUE_MACOS_GO));
  return obstacles;
}

async function serveurRepond(): Promise<boolean> {
  if (systemeMachine() === "macos") {
    const url = adresseMacos();
    if (!url) return false;
    try {
      return (await fetch(`${url}/status`, { signal: AbortSignal.timeout(2500) })).ok;
    } catch {
      return false;
    }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT_MACHINE}/status`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function diagnosticMachine(): Promise<DiagnosticMachine> {
  const hw = detectHardware();
  const disque = disqueLibreGo();
  const docker = await trouverDocker();
  const etatDocker: DiagnosticMachine["docker"] = !docker ? "absent" : (await dockerRepond(docker)) ? "pret" : "eteint";
  const prete = docker && etatDocker === "pret" ? await imagePresente(docker, IMAGE) : false;
  const etatLinux = docker && etatDocker === "pret" ? await etatConteneur(docker) : "absent";
  const presente = await machineMacosPresente();
  const obstaclesMac = await obstaclesMacos(hw, disque, presente);
  const macos = { possible: obstaclesMac.length === 0, obstacles: obstaclesMac, presente, lume: (await trouverLume()) !== null };
  const systeme = systemeMachine();
  const pret = await serveurRepond();
  // L'état de la machine macOS se lit sur son serveur : démarrée, elle répond.
  const etat = systeme === "macos" ? (pret ? "en_marche" : presente ? "arrete" : "absent") : etatLinux;
  let avis = conseiller(hw, disque, etatDocker, prete);
  // Pas de bureau Linux possible (Docker absent, par exemple), mais un Mac bien doté : la machine macOS.
  if (avis.conseil === "aucun" && macos.possible) {
    avis = {
      conseil: "macos",
      raison: tf("{0} Go de mémoire : une machine macOS isolée, avec Safari et LibreOffice. La première mise en route télécharge environ 23 Go.", hw.totalMemoryGb),
      obstacles: avis.obstacles,
    };
  }
  return {
    ...avis,
    systeme,
    macos,
    memoireGo: hw.totalMemoryGb,
    disqueLibreGo: disque,
    docker: etatDocker,
    imagePrete: prete,
    etat,
    pret: etat === "en_marche" && pret,
    preparationEnCours: preparation !== null,
    dossierEchange: dossierEchange(),
  };
}

/* ------------------------------------------------------------------ */
/* Préparer, démarrer, arrêter                                         */
/* ------------------------------------------------------------------ */

/** Mot de passe de l'affichage VNC de la machine, tiré une fois, gardé à côté des données. */
function motDePasseAffichage(): string {
  const f = join(racineDonnees(), "machine-affichage");
  try {
    const lu = readFileSync(f, "utf8").trim();
    if (lu) return lu;
  } catch {
    /* à créer */
  }
  const mdp = randomBytes(18).toString("base64url");
  mkdirSync(racineDonnees(), { recursive: true, mode: 0o700 });
  writeFileSync(f, mdp, { mode: 0o600 });
  return mdp;
}

function lancer(docker: string, args: string[], etape: string, message: string): Promise<void> {
  progression = { etape, message };
  return new Promise((ok, ko) => {
    const p = spawn(docker, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    if (etape === "construction") p.stdin.end(RECETTE);
    else p.stdin.end();
    p.on("close", (code) => (code === 0 ? ok() : ko(new Error(err.trim().split("\n").slice(-3).join(" ") || `code ${code}`))));
    p.on("error", ko);
  });
}

/**
 * Après une nouvelle version de l'image, les précédentes ne servent plus :
 * chacune garde plusieurs Go sur le disque (constaté : trois versions côte à
 * côte). Un conteneur d'une ancienne version est retiré d'abord, sinon Docker
 * refuse d'effacer son image ; il est recréé depuis la nouvelle au démarrage.
 */
async function effacerAnciennesImages(docker: string): Promise<void> {
  try {
    const { stdout } = await exec(docker, ["images", "oxoai-machine", "--format", "{{.Repository}}:{{.Tag}}"], { timeout: 10_000 });
    const anciennes = stdout.split("\n").map((l) => l.trim()).filter((l) => l && l !== IMAGE);
    if (anciennes.length === 0) return;
    const { stdout: sa } = await exec(docker, ["inspect", "-f", "{{.Config.Image}}", CONTENEUR], { timeout: 8000 }).catch(() => ({ stdout: "" }));
    if (sa.trim() && sa.trim() !== IMAGE) await exec(docker, ["rm", "-f", CONTENEUR], { timeout: 20_000 }).catch(() => undefined);
    await exec(docker, ["rmi", ...anciennes], { timeout: 60_000 }).catch(() => undefined);
  } catch {
    /* rien à effacer */
  }
}

/**
 * Prépare puis démarre la machine. Idempotent : ce qui est déjà fait est sauté.
 * Une seule préparation à la fois ; les appels suivants attendent la même.
 */
export function demarrerMachine(qui = "systeme"): Promise<void> {
  if (preparation) return preparation;
  preparation = (async () => {
    if (systemeMachine() === "macos") {
      await demarrerMacos(dossierEchange(), LIBREOFFICE_XCD, (etape, message) => (progression = { etape, message }));
      progression = { etape: "prete", message: t("La machine est prête.") };
      journaliser("machine.demarree", qui, { image: "macos" });
      return;
    }
    const docker = await trouverDocker();
    if (!docker) throw new Error(conseilDocker());
    progression = { etape: "docker", message: t("Démarrage de Docker...") };
    if (!(await allumerDocker(docker))) {
      throw new Error(
        process.platform === "linux"
          ? t("Docker ne répond pas. Démarrez son service (sudo systemctl start docker) ; si c'est un refus d'accès, ajoutez votre compte au groupe docker (sudo usermod -aG docker $USER), puis fermez et rouvrez la session.")
          : t("Docker ne répond pas. Ouvrez Docker Desktop, attendez qu'il soit prêt, puis réessayez."),
      );
    }

    if (!(await imagePresente(docker, IMAGE))) {
      if (!(await imagePresente(docker, IMAGE_BASE))) {
        await lancer(docker, ["pull", IMAGE_BASE], "telechargement", t("Téléchargement de la machine (environ 2 Go)..."));
      }
      await lancer(docker, ["build", "-t", IMAGE, "-"], "construction", t("Installation de la bureautique dans la machine..."));
      await effacerAnciennesImages(docker);
    }

    const etat = await etatConteneur(docker);
    if (etat === "absent") {
      mkdirSync(dossierEchange(), { recursive: true });
      await lancer(
        docker,
        [
          "run", "-d", "--name", CONTENEUR,
          "--memory", MEMOIRE, "--shm-size", "512m",
          // Sur 127.0.0.1 seulement : la machine n'est jamais joignable depuis le réseau.
          "-p", `127.0.0.1:${PORT_MACHINE}:8000`,
          "-e", `VNC_PW=${motDePasseAffichage()}`,
          "-v", `${dossierEchange()}:${ECHANGE_DANS_LA_MACHINE}`,
          IMAGE,
        ],
        "demarrage",
        t("Démarrage de la machine..."),
      );
    } else if (etat === "arrete") {
      await lancer(docker, ["start", CONTENEUR], "demarrage", t("Démarrage de la machine..."));
    }

    progression = { etape: "attente", message: t("La machine démarre...") };
    for (let i = 0; i < 90; i++) {
      if (await serveurRepond()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!(await serveurRepond())) throw new Error(t("La machine a démarré, mais son serveur de pilotage ne répond pas."));
    progression = { etape: "prete", message: t("La machine est prête.") };
    journaliser("machine.demarree", qui, { image: IMAGE });
  })()
    .catch((err: unknown) => {
      progression = { etape: "erreur", message: t("La machine n'a pas pu démarrer."), erreur: err instanceof Error ? err.message : String(err) };
      throw err;
    })
    .finally(() => {
      preparation = null;
    });
  return preparation;
}

/** Arrête la machine (sans l'effacer : elle repart en quelques secondes). */
export async function arreterMachine(qui = "systeme"): Promise<void> {
  if (systemeMachine() === "macos") {
    await arreterMacos();
    journaliser("machine.arretee", qui, {});
    progression = null;
    return;
  }
  const docker = await trouverDocker();
  if (!docker) return;
  try {
    await exec(docker, ["stop", "-t", "3", CONTENEUR], { timeout: 20_000 });
    journaliser("machine.arretee", qui, {});
  } catch {
    /* déjà arrêtée */
  }
  progression = null;
}

/**
 * Arrêt à la fermeture de l'instance : une machine oubliée garderait 3 Go de
 * mémoire. Lancé détaché, la passerelle n'attend pas.
 */
export function arreterMachineEnPartant(): void {
  if (systemeMachine() === "macos") return arreterMacosEnPartant();
  for (const c of CANDIDATS_DOCKER) {
    if (c.includes("/") && !existsSync(c)) continue;
    try {
      spawn(c, ["stop", "-t", "2", CONTENEUR], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* rien à arrêter */
    }
    return;
  }
}

/**
 * Applications que l'agent peut ouvrir dans la machine, et la commande exacte.
 * Une liste fermée : le nom venu du modèle choisit une entrée, il n'entre
 * jamais tel quel dans une commande.
 */
const APPLICATIONS: { noms: RegExp; commande: string; libelle: string }[] = [
  { noms: /firefox|navigateur|browser|web|internet|chrome|safari/i, commande: "firefox", libelle: "Firefox" },
  { noms: /writer|word|texte|document|traitement/i, commande: "libreoffice --writer", libelle: "LibreOffice Writer" },
  { noms: /calc|excel|tableur|feuille|classeur|spreadsheet/i, commande: "libreoffice --calc", libelle: "LibreOffice Calc" },
  { noms: /impress|powerpoint|pr[ée]sentation|diapo|slides/i, commande: "libreoffice --impress", libelle: "LibreOffice Impress" },
  { noms: /fichiers|finder|explorateur|files|thunar|dossier/i, commande: `thunar ${ECHANGE_DANS_LA_MACHINE}`, libelle: "Fichiers" },
  { noms: /terminal|console/i, commande: "xfce4-terminal", libelle: "Terminal" },
];

export function applicationLinux(nom: string): { commande: string; libelle: string } | null {
  const trouvee = APPLICATIONS.find((a) => a.noms.test(nom));
  return trouvee ? { commande: `nohup ${trouvee.commande} >/dev/null 2>&1 &`, libelle: trouvee.libelle } : null;
}

/** L'application demandée, dans la machine en service (Linux ou macOS). */
export function applicationMachine(nom: string): { commande: string; libelle: string } | null {
  if (systemeMachine() === "linux") return applicationLinux(nom);
  const trouvee = APPLICATIONS_MACOS.find((a) => a.noms.test(nom));
  return trouvee ? { commande: trouvee.commande, libelle: trouvee.libelle } : null;
}

export const applicationsDisponibles = (): string[] =>
  (systemeMachine() === "macos" ? APPLICATIONS_MACOS : APPLICATIONS).map((a) => a.libelle);

/**
 * Efface la machine et rend sa place sur le disque : le conteneur et les
 * images pour Linux (celle de base de cua aussi), le Mac virtuel pour macOS.
 * Les deux, si les deux existent : on efface pour libérer le disque, pas pour
 * en garder la moitié. Elle se reconstruit au prochain choix.
 */
export async function effacerMachine(qui = "systeme"): Promise<void> {
  if (preparation) throw new Error(t("La machine est en cours de préparation : attendez qu'elle ait fini."));
  if (await machineMacosPresente()) await effacerMacos();
  const docker = await trouverDocker();
  if (docker && (await dockerRepond(docker))) {
    await exec(docker, ["rm", "-f", CONTENEUR], { timeout: 60_000 }).catch(() => undefined);
    await exec(docker, ["rmi", IMAGE, IMAGE_BASE], { timeout: 120_000 }).catch(() => undefined);
  }
  progression = null;
  journaliser("machine.effacee", qui, {});
}
