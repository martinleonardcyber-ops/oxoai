import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, release } from "node:os";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { t, tf } from "./langue.ts";

/**
 * Palmier Pro, monteur vidéo pour macOS (29/09/2026, demande de Medhi).
 *
 * Quand l'application est ouverte, elle sert un serveur MCP en HTTP sur
 * `http://127.0.0.1:19789/mcp`, sans authentification (README du dépôt
 * https://github.com/palmier-io/palmier-pro ; `MCPService.swift` et
 * `MCPHTTPServer.swift` de la branche `last-gpl-source`, lus le 29/09/2026 :
 * écoute sur 127.0.0.1 seulement, et refus d'un en-tête `Origin` qui ne
 * serait pas local). OxoAI ne l'installe pas et ne distribue rien d'elle : il
 * parle à l'application que la personne a installée elle-même.
 *
 * Un serveur sans authentification sur un port connu, c'est un port que
 * n'importe quel programme de la machine peut prendre avant Palmier Pro. Les
 * demandes des agents (et le contenu du projet qui revient) ne partent donc
 * que vers un écouteur **reconnu** : le processus qui tient le port doit être
 * l'application signée par son éditeur. Même principe qu'`ecouteurReconnu`
 * (llamaCpp.ts, test d'intrusion du 28/09/2026) : on ne demande pas au
 * programme qui il est, on le lit au système.
 *
 *  1. `lsof` donne le ou les processus qui écoutent sur le port ;
 *  2. `codesign --verify -R=<exigence> <pid>` vérifie la signature du
 *     processus **en cours d'exécution** (validation dynamique, par le noyau)
 *     contre l'exigence : signé par un certificat Developer ID d'Apple, pour
 *     l'identifiant `io.palmier.pro`, et l'équipe `MMFLRC7562` (« Developer
 *     ID Application: Palmier, Inc. (MMFLRC7562) », `scripts/bundle.sh` du
 *     dépôt ; identifiant dans `Info.plist`). Un programme ne choisit ni sa
 *     signature ni son équipe ;
 *  3. `codesign -dv <pid>` donne le chemin de l'exécutable : il doit être
 *     dans /Applications ou ~/Applications (une copie lancée depuis
 *     Téléchargements ou depuis l'image disque est refusée, avec un mot pour
 *     la déplacer).
 *
 * Refait avant **chaque** requête HTTP vers le port (mcp.ts, `fetchLocal`) :
 * Palmier Pro fermé, un autre programme peut prendre le port entre deux
 * appels. La signature d'un processus reconnu est gardée tant qu'il est le
 * même (même numéro), pour ne pas relancer `codesign` à chaque appel.
 *
 * Ce qui reste (SECURITE.md § 63) : entre la lecture de `lsof` et la
 * connexion, quelques millisecondes pendant lesquelles Palmier Pro pourrait se
 * fermer et un autre programme prendre le port. Le fermer demanderait de
 * connaître le processus au bout d'une connexion déjà ouverte, ce que Node ne
 * donne pas.
 */

const executer = promisify(execFile);

/** Le port que Palmier Pro écoute (`MCPService.port`). */
export const PORT_PALMIER = 19789;

/** Page de téléchargement officielle : l'écran y renvoie, OxoAI ne télécharge rien. */
export const TELECHARGEMENT_PALMIER = "https://github.com/palmier-io/palmier-pro/releases/latest";

/** Signature attendue : Developer ID d'Apple, identifiant et équipe de Palmier, Inc. */
export const EXIGENCE_PALMIER = 'anchor apple generic and identifier "io.palmier.pro" and certificate leaf[subject.OU] = "MMFLRC7562"';

/*
 * Pour les essais seulement (scripts/essai-palmier.mjs, SECURITE.md § 63) :
 *  - `OXOAI_ESSAI_PALMIER_PORT` remplace le port (un vrai Palmier Pro ouvert
 *    sur la machine d'essai n'est jamais touché) ;
 *  - `OXOAI_ESSAI_PALMIER_EXECUTABLE` (chemin absolu) remplace la signature
 *    par le chemin de l'exécutable qui doit écouter, lu par `lsof` : le faux
 *    serveur des essais est un script Node, qui ne porte pas la signature de
 *    Palmier. Posées par qui lance la passerelle, jamais par une requête.
 */
export function portPalmier(): number {
  const essai = Number(process.env.OXOAI_ESSAI_PALMIER_PORT);
  return Number.isInteger(essai) && essai >= 1024 && essai <= 65535 ? essai : PORT_PALMIER;
}
const executableEssai = (): string | null => {
  const brut = process.env.OXOAI_ESSAI_PALMIER_EXECUTABLE;
  return brut && isAbsolute(brut) ? brut : null;
};

/* ------------------------------------------------------------------ */
/* La machine                                                          */
/* ------------------------------------------------------------------ */

export type Plateforme = "ok" | "autre-systeme" | "macos-ancien";

let arm64Materiel: boolean | null = null;
/** Puce Apple, y compris quand la passerelle tourne sous Rosetta (`hw.optional.arm64`). */
function pucesApple(): boolean {
  if (process.arch === "arm64") return true;
  if (arm64Materiel === null) {
    try {
      arm64Materiel = execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "1";
    } catch {
      arm64Materiel = false;
    }
  }
  return arm64Materiel;
}

/**
 * Palmier Pro peut-il tourner sur la machine de cette instance ? Il demande
 * macOS 26 (Tahoe) sur puce Apple (README, `LSMinimumSystemVersion` 26.0).
 * macOS 26 est Darwin 25 : le noyau suffit, sans lancer `sw_vers`.
 * Entrées injectables pour les essais.
 */
export function plateformePalmier(
  m: { systeme: string; appleSilicon: boolean; noyau: string } = { systeme: process.platform, appleSilicon: process.platform === "darwin" && pucesApple(), noyau: release() },
): Plateforme {
  if (m.systeme !== "darwin" || !m.appleSilicon) return "autre-systeme";
  const majeur = Number(m.noyau.split(".")[0]);
  return Number.isFinite(majeur) && majeur >= 25 ? "ok" : "macos-ancien";
}

/** La fiche se montre sur un Mac à puce Apple, même trop ancien : elle dit alors ce qu'il faut. */
export const palmierProposable = (): boolean => plateformePalmier() !== "autre-systeme";

/* ------------------------------------------------------------------ */
/* L'écouteur                                                          */
/* ------------------------------------------------------------------ */

export type VerdictEcouteur =
  | { ok: true; pid: number }
  | { ok: false; raison: "plateforme" | "absent" | "autre" | "emplacement" | "illisible"; message: string };

/** Processus reconnus, par numéro, avec l'exécutable lu à la reconnaissance. */
const reconnus = new Map<number, string>();

async function pidsALEcoute(port: number): Promise<number[]> {
  try {
    const { stdout } = await executer("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 15_000 });
    return stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch (err) {
    // `lsof` rend 1, sans rien écrire, quand personne n'écoute.
    const e = err as { code?: unknown; stdout?: string };
    if (e.code === 1 && !String(e.stdout ?? "").trim()) return [];
    throw err;
  }
}

/** L'exécutable d'un processus, lu par `lsof` (premier fichier « txt » : le programme lui-même). */
async function executableParLsof(pid: number): Promise<string | null> {
  const { stdout } = await executer("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"], { timeout: 15_000 });
  const ligne = stdout.split("\n").find((l) => l.startsWith("n"));
  return ligne ? ligne.slice(1) : null;
}

const reel = (chemin: string): string => {
  try {
    return realpathSync(chemin);
  } catch {
    return chemin;
  }
};

/** Dans /Applications ou ~/Applications, à l'intérieur d'un paquet d'application. */
function dansApplications(executable: string): boolean {
  const racines = ["/Applications/", `${homedir()}/Applications/`];
  return racines.some((r) => executable.startsWith(r)) && /\.app\/Contents\/MacOS\/[^/]+$/.test(executable) && !executable.includes("/../");
}

/** Signature du processus vérifiée, puis l'exécutable qu'elle couvre ; `null` si elle ne convient pas. */
async function signaturePalmier(pid: number): Promise<string | null> {
  try {
    await executer("/usr/bin/codesign", ["--verify", `-R=${EXIGENCE_PALMIER}`, String(pid)], { timeout: 15_000 });
  } catch {
    return null;
  }
  try {
    // `codesign -d` écrit sur la sortie d'erreur.
    const { stderr } = await executer("/usr/bin/codesign", ["-dv", String(pid)], { timeout: 15_000 });
    const ligne = stderr.split("\n").find((l) => l.startsWith("Executable="));
    return ligne ? ligne.slice("Executable=".length).trim() : null;
  } catch {
    return null;
  }
}

/**
 * Le programme qui écoute sur le port de Palmier Pro est-il Palmier Pro ?
 * Rien n'est envoyé au port tant que la réponse n'est pas oui.
 */
export async function ecouteurPalmier(port = portPalmier()): Promise<VerdictEcouteur> {
  const plateforme = plateformePalmier();
  if (plateforme === "autre-systeme") {
    return { ok: false, raison: "plateforme", message: t("Palmier Pro ne fonctionne que sur un Mac à puce Apple : il ne peut pas tourner sur la machine de cette instance.") };
  }
  if (plateforme === "macos-ancien") {
    return { ok: false, raison: "plateforme", message: t("Palmier Pro demande macOS 26 (Tahoe) ou plus récent : mettez à jour macOS sur cette machine, puis réessayez.") };
  }
  let pids: number[];
  try {
    pids = await pidsALEcoute(port);
  } catch {
    return { ok: false, raison: "illisible", message: tf("Impossible de savoir quel programme écoute sur le port de Palmier Pro ({0}) : rien ne lui a été envoyé.", port) };
  }
  for (const pid of [...reconnus.keys()]) if (!pids.includes(pid)) reconnus.delete(pid);
  if (pids.length === 0) {
    return { ok: false, raison: "absent", message: tf("Palmier Pro n'est pas ouvert sur cette machine. Ouvrez Palmier Pro, puis réessayez. Pas encore installé ? Il se télécharge sur {0}.", TELECHARGEMENT_PALMIER) };
  }
  const autre = { ok: false as const, raison: "autre" as const, message: tf("Un autre programme occupe le port de Palmier Pro ({0}) sur cette machine : ce n'est pas l'application Palmier Pro signée par son éditeur, et rien ne lui a été envoyé. Fermez ce programme, ouvrez Palmier Pro, puis réessayez.", port) };
  // Tous les processus à l'écoute doivent être reconnus : un seul inconnu suffit à refuser.
  for (const pid of pids) {
    if (reconnus.has(pid)) continue;
    const essai = executableEssai();
    if (essai) {
      let lu: string | null = null;
      try {
        lu = await executableParLsof(pid);
      } catch {
        lu = null;
      }
      if (!lu || reel(lu) !== reel(essai)) return autre;
      reconnus.set(pid, lu);
      continue;
    }
    const executable = await signaturePalmier(pid);
    if (!executable) return autre;
    if (!dansApplications(executable)) {
      return { ok: false, raison: "emplacement", message: t("Palmier Pro est ouvert, mais pas depuis le dossier Applications : glissez-le dans Applications, rouvrez-le depuis là, puis réessayez.") };
    }
    reconnus.set(pid, executable);
  }
  return { ok: true, pid: pids[0]! };
}

/** Pour mcp.ts : `null` si l'écouteur est reconnu, sinon la raison du refus. */
export async function refusEcouteurPalmier(port: number): Promise<string | null> {
  const v = await ecouteurPalmier(port);
  return v.ok ? null : v.message;
}
