import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import paquets from "./blender-paquets.json" with { type: "json" };
import { t, tf } from "./langue.ts";
import { assurerPythonPrive, pythonPrive } from "./pythonPrive.ts";

/**
 * Blender, par le serveur MCP « MCP for Blender » (12/10/2026, demande de
 * Medhi : « ajoute un MCP pour Roblox et Blender, on nous le réclame »).
 *
 * Deux pièces, lues dans le code de https://github.com/ahujasid/mcp-for-blender
 * (licence MIT) à la version épinglée (2.1.9, publiée sur PyPI le 06/10/2026) :
 *  - un **module complémentaire** de Blender (`addon.py`), qui ouvre un port
 *    sur la boucle locale (9876, `localhost`, sans authentification) et y
 *    reçoit des commandes en JSON ;
 *  - un **serveur MCP** en Python (stdio), qui traduit les appels d'outils en
 *    commandes pour ce port.
 *
 * Helix pose le serveur lui-même, dans un environnement Python à lui
 * (`<données>/blender-mcp`), avec `pip --require-hashes --no-deps
 * --only-binary=:all:` et la liste figée de blender-paquets.json (version et
 * empreinte de chaque roue, dépendances comprises, refaite par
 * `node scripts/blender-empreintes.mjs`). Python : celui du système s'il est
 * en 3.10 ou plus et sait créer un environnement, sinon celui que Helix pose
 * (pythonPrive.ts). Le module complémentaire est celui que livre la roue
 * vérifiée, contrôlé une seconde fois par son empreinte, puis recopié à part
 * pour que la personne l'installe dans Blender (Helix n'écrit pas dans les
 * dossiers de Blender).
 *
 * Ce qui sortirait de la machine sans Helix (SECURITE.md § 65) :
 *  - la télémétrie du serveur (Supabase de l'auteur : nom de l'outil, durée,
 *    réussite, même sans consentement) : coupée au lancement par les trois
 *    variables que le serveur lit (`DISABLE_TELEMETRY`…), et avec elle les
 *    « trajectoires » et captures, qui passent par le même interrupteur ;
 *  - la vérification de mise à jour du module, au démarrage de Blender
 *    (raw.githubusercontent.com) : elle se lit dans l'environnement de
 *    Blender, que Helix ne lance pas ; dite à la personne, rien de la scène
 *    n'y part et rien ne s'installe sans son clic dans Blender ;
 *  - les bibliothèques (Poly Haven, Sketchfab, Poly Pizza) et les générateurs
 *    (Hyper3D, Hunyuan3D, Tripo) : éteints par défaut dans le module ; et
 *    leurs outils passent par la carte d'accord (blenderRegles.ts).
 *
 * Le port du module est sans authentification : n'importe quel programme de
 * la machine peut le prendre avant Blender et recevoir le code que l'agent
 * écrit. Comme pour Palmier Pro (palmier.ts), le programme qui écoute est
 * **reconnu** avant le lancement du serveur et avant chaque appel : macOS,
 * signature du processus (Developer ID de la Blender Foundation) ; Windows,
 * signature Authenticode valide de la Blender Foundation sur `blender.exe` ;
 * Linux, l'exécutable du processus s'appelle `blender` (pas de signature à
 * lire). Reste le délai entre la vérification et la connexion du serveur.
 */

const executer = promisify(execFile);

/** Le port du module complémentaire (`blendermcp_port`, `DEFAULT_PORT`). */
export const PORT_BLENDER = 9876;
export const VERSION_SERVEUR_BLENDER = paquets.version;
export const TELECHARGEMENT_BLENDER = "https://www.blender.org/download/";

/*
 * Signature attendue sur macOS : Developer ID d'Apple, identifiant et équipe
 * de la Stichting Blender Foundation. Identifiant `org.blenderfoundation.blender`
 * (Info.plist de Blender) ; équipe `68UA947AUU`. Ni l'un ni l'autre n'a été
 * relu sur un vrai Blender ici (PROJET.md § 3.5) : s'ils diffèrent, Helix
 * refuse de parler au port, ce qui échoue fermé.
 */
export const EXIGENCE_BLENDER = 'anchor apple generic and identifier "org.blenderfoundation.blender" and certificate leaf[subject.OU] = "68UA947AUU"';

/*
 * Pour les essais seulement (scripts/essai-roblox-blender.mjs), posées par qui
 * lance la passerelle, jamais par une requête :
 *  - `HELIX_ESSAI_BLENDER_PORT` : le port du faux module ;
 *  - `HELIX_ESSAI_BLENDER_EXECUTABLE` (chemin absolu) : l'exécutable qui doit
 *    écouter, à la place de la signature (le faux module est un script Node) ;
 *  - `HELIX_ESSAI_BLENDER_SERVEUR` (chemin absolu) : le serveur MCP à lancer à
 *    la place de celui de l'environnement de Helix (un faux, ou le vrai posé
 *    à part), sans rien installer.
 */
export function portBlender(): number {
  const essai = Number(process.env.HELIX_ESSAI_BLENDER_PORT);
  return Number.isInteger(essai) && essai >= 1024 && essai <= 65535 ? essai : PORT_BLENDER;
}
const absolu = (v: string | undefined): string | null => (v && isAbsolute(v) ? v : null);
const executableEssai = () => absolu(process.env.HELIX_ESSAI_BLENDER_EXECUTABLE);
const serveurEssai = () => absolu(process.env.HELIX_ESSAI_BLENDER_SERVEUR);

/** Blender tourne sur macOS, Windows et Linux : la fiche se montre partout. */
export const blenderProposable = (): boolean => ["darwin", "win32", "linux"].includes(process.platform);

/* ------------------------------------------------------------------ */
/* Blender est-il installé ?                                           */
/* ------------------------------------------------------------------ */

function dansLePath(nom: string): string | null {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (d && existsSync(join(d, nom))) return join(d, nom);
  }
  return null;
}

/** Le Blender installé, pour dire « introuvable » plutôt que « fermé » ; `null` s'il n'est nulle part où on le cherche. */
export function blenderInstalle(): string | null {
  if (process.platform === "darwin") {
    return ["/Applications/Blender.app", join(homedir(), "Applications", "Blender.app")].find((c) => existsSync(c)) ?? null;
  }
  if (process.platform === "win32") {
    const racines = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((r): r is string => Boolean(r));
    for (const r of racines) {
      const fondation = join(r, "Blender Foundation");
      try {
        for (const d of readdirSync(fondation)) if (existsSync(join(fondation, d, "blender.exe"))) return join(fondation, d, "blender.exe");
      } catch {
        /* pas de dossier de la Fondation ici */
      }
      const steam = join(r, "Steam", "steamapps", "common", "Blender", "blender.exe");
      if (existsSync(steam)) return steam;
    }
    return null;
  }
  return dansLePath("blender") ?? ["/snap/bin/blender", "/usr/bin/blender", "/var/lib/flatpak/exports/bin/org.blender.Blender"].find((c) => existsSync(c)) ?? null;
}

/* ------------------------------------------------------------------ */
/* L'écouteur du module complémentaire                                  */
/* ------------------------------------------------------------------ */

export type VerdictBlender = { ok: true; pid: number } | { ok: false; raison: "absent" | "autre" | "illisible"; message: string };

const reconnus = new Map<number, string>();

interface Ecouteur {
  pid: number;
  /** Chemin de l'exécutable, quand le système le donne. */
  exe: string | null;
  /** Windows : la signature Authenticode, lue par PowerShell. */
  signature?: { statut: string; sujet: string };
}

/** macOS : `lsof`, comme palmier.ts. */
async function ecouteursMac(port: number): Promise<Ecouteur[]> {
  let stdout = "";
  try {
    ({ stdout } = await executer("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 15_000 }));
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string };
    if (e.code === 1 && !String(e.stdout ?? "").trim()) return [];
    throw err;
  }
  return stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0).map((pid) => ({ pid, exe: null }));
}

/**
 * Linux : sans `lsof` (absent des installations minimales), par /proc : les
 * sockets à l'écoute sur le port (`/proc/net/tcp`, état 0A), puis le processus
 * qui tient chacune (`/proc/<pid>/fd`). Une socket dont on ne trouve pas le
 * processus (un autre compte) rend la réponse illisible : refus.
 */
async function ecouteursLinux(port: number): Promise<Ecouteur[]> {
  const inodes = new Set<string>();
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let texte = "";
    try {
      texte = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const ligne of texte.split("\n").slice(1)) {
      const champs = ligne.trim().split(/\s+/);
      if (champs.length < 10) continue;
      if (champs[1]!.split(":")[1] === portHex && champs[3] === "0A") inodes.add(champs[9]!);
    }
  }
  if (inodes.size === 0) return [];
  const trouves: Ecouteur[] = [];
  const restants = new Set(inodes);
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${d}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let lien = "";
      try {
        lien = readlinkSync(`/proc/${d}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(lien);
      if (m && restants.has(m[1]!)) {
        restants.delete(m[1]!);
        let exe: string | null = null;
        try {
          exe = readlinkSync(`/proc/${d}/exe`);
        } catch {
          exe = null;
        }
        if (!trouves.some((e) => e.pid === Number(d))) trouves.push({ pid: Number(d), exe });
      }
    }
  }
  if (restants.size > 0) throw new Error("socket sans processus lisible");
  return trouves;
}

/** Windows : PowerShell, le processus à l'écoute, son chemin et sa signature Authenticode. */
async function ecouteursWindows(port: number): Promise<Ecouteur[]> {
  const script =
    `$r = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `$p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; $s = $null; ` +
    `if ($p -and $p.Path) { $s = Get-AuthenticodeSignature -LiteralPath $p.Path }; ` +
    `[pscustomobject]@{ pid = [int]$_.OwningProcess; exe = [string]$p.Path; statut = [string]$s.Status; sujet = [string]$s.SignerCertificate.Subject } }); ` +
    `ConvertTo-Json -InputObject $r -Compress`;
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await executer(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30_000, windowsHide: true });
  const brut = JSON.parse(stdout.trim() || "[]") as { pid: number; exe: string; statut: string; sujet: string }[] | { pid: number; exe: string; statut: string; sujet: string };
  return (Array.isArray(brut) ? brut : [brut]).map((e) => ({ pid: e.pid, exe: e.exe || null, signature: { statut: e.statut, sujet: e.sujet } }));
}

async function ecouteurs(port: number): Promise<Ecouteur[]> {
  if (process.platform === "darwin") return ecouteursMac(port);
  if (process.platform === "win32") return ecouteursWindows(port);
  return ecouteursLinux(port);
}

const reel = (chemin: string): string => {
  try {
    return realpathSync(chemin);
  } catch {
    return chemin;
  }
};

/** L'exécutable d'un processus, lu par `lsof` (essais sur macOS). */
async function executableParLsof(pid: number): Promise<string | null> {
  const { stdout } = await executer("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"], { timeout: 15_000 });
  const ligne = stdout.split("\n").find((l) => l.startsWith("n"));
  return ligne ? ligne.slice(1) : null;
}

/** Ce processus est-il Blender ? Son exécutable si oui, `null` sinon. */
async function estBlender(e: Ecouteur): Promise<string | null> {
  const essai = executableEssai();
  if (essai) {
    let lu = e.exe;
    if (!lu && process.platform === "darwin") lu = await executableParLsof(e.pid).catch(() => null);
    return lu && reel(lu) === reel(essai) ? lu : null;
  }
  if (process.platform === "darwin") {
    try {
      await executer("/usr/bin/codesign", ["--verify", `-R=${EXIGENCE_BLENDER}`, String(e.pid)], { timeout: 15_000 });
      const { stderr } = await executer("/usr/bin/codesign", ["-dv", String(e.pid)], { timeout: 15_000 });
      return stderr.split("\n").find((l) => l.startsWith("Executable="))?.slice("Executable=".length).trim() ?? null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const ok = e.exe && /^blender\.exe$/i.test(basename(e.exe)) && e.signature?.statut === "Valid" && /Blender Foundation/i.test(e.signature.sujet);
    return ok ? e.exe : null;
  }
  return e.exe && /^blender(-[\w.]+)?$/.test(basename(e.exe)) ? e.exe : null;
}

/**
 * Le programme qui écoute sur le port du module est-il Blender ? Rien n'est
 * envoyé au port, ni le serveur lancé, tant que la réponse n'est pas oui.
 */
export async function ecouteurBlender(port = portBlender()): Promise<VerdictBlender> {
  let liste: Ecouteur[];
  try {
    liste = await ecouteurs(port);
  } catch {
    return { ok: false, raison: "illisible", message: tf("Impossible de savoir quel programme écoute sur le port du module MCP de Blender ({0}) : rien ne lui a été envoyé.", port) };
  }
  for (const pid of [...reconnus.keys()]) if (!liste.some((e) => e.pid === pid)) reconnus.delete(pid);
  if (liste.length === 0) {
    if (!blenderInstalle() && !executableEssai()) {
      return { ok: false, raison: "absent", message: tf("Blender est introuvable sur cette machine. Installez-le depuis {0}, ouvrez-le, puis réessayez.", TELECHARGEMENT_BLENDER) };
    }
    return { ok: false, raison: "absent", message: tf("Blender ne répond pas sur le port de son module MCP ({0}). Ouvrez Blender et vérifiez que le module « MCP for Blender » est installé et coché (Édition, Préférences, Modules complémentaires) : il démarre son serveur avec Blender. Puis réessayez.", port) };
  }
  for (const e of liste) {
    if (reconnus.has(e.pid)) continue;
    const exe = await estBlender(e);
    if (!exe) {
      return { ok: false, raison: "autre", message: tf("Un autre programme occupe le port du module MCP de Blender ({0}) sur cette machine : ce n'est pas Blender, et rien ne lui a été envoyé. Fermez ce programme, ouvrez Blender, puis réessayez.", port) };
    }
    reconnus.set(e.pid, exe);
  }
  return { ok: true, pid: liste[0]!.pid };
}

/* ------------------------------------------------------------------ */
/* Le serveur MCP, posé par Helix                                      */
/* ------------------------------------------------------------------ */

const racine = () => join(process.env.HELIX_DATA_DIR ?? join(homedir(), ".helix", "data"), "blender-mcp");
const dossierVenv = () => join(racine(), "venv");
const pythonVenv = () => (process.platform === "win32" ? join(dossierVenv(), "Scripts", "python.exe") : join(dossierVenv(), "bin", "python3"));
const marque = () => join(racine(), "version.txt");
/** Le module complémentaire vérifié, recopié pour que la personne l'installe dans Blender. */
export const fichierModuleBlender = (): string => join(racine(), "blender_mcp.py");

/** Le serveur est-il posé, à la version épinglée ? Lecture du disque seule. */
export function serveurBlenderInstalle(): boolean {
  if (serveurEssai()) return true;
  try {
    return existsSync(pythonVenv()) && readFileSync(marque(), "utf8").trim() === VERSION_SERVEUR_BLENDER && existsSync(fichierModuleBlender());
  } catch {
    return false;
  }
}

/** Un Python 3.10 ou plus, qui sait créer un environnement : celui du système, sinon celui de Helix. */
async function pythonPourVenv(): Promise<string> {
  const prive = pythonPrive();
  if (prive) return prive;
  if (process.platform !== "win32") {
    const candidats = [dansLePath("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].filter((c): c is string => Boolean(c) && existsSync(c!));
    for (const c of candidats) {
      try {
        const { stdout } = await executer(c, ["-I", "-c", "import sys, venv, ensurepip; print(sys.version_info[:2] >= (3, 10))"], { timeout: 20_000 });
        if (stdout.trim() === "True") return c;
      } catch {
        /* suivant */
      }
    }
  }
  // Ni l'un ni l'autre : Helix pose son Python (empreinte vérifiée, pythonPrive.ts).
  return assurerPythonPrive();
}

/** Les `site-packages` de l'environnement (le nom dépend de la version de Python). */
function sitePackages(): string[] {
  if (process.platform === "win32") return [join(dossierVenv(), "Lib", "site-packages")];
  try {
    return readdirSync(join(dossierVenv(), "lib"))
      .filter((n) => n.startsWith("python"))
      .map((n) => join(dossierVenv(), "lib", n, "site-packages"));
  } catch {
    return [];
  }
}

let installation: Promise<void> | null = null;

/** Pose le serveur s'il ne l'est pas (au clic sur « Brancher » seulement). Une installation à la fois. */
export function assurerServeurBlender(): Promise<void> {
  if (serveurBlenderInstalle()) return Promise.resolve();
  if (!installation) installation = installerServeur().finally(() => (installation = null));
  return installation;
}

async function installerServeur(): Promise<void> {
  mkdirSync(racine(), { recursive: true, mode: 0o700 });
  rmSync(dossierVenv(), { recursive: true, force: true });
  rmSync(marque(), { force: true });
  const python = await pythonPourVenv();
  try {
    await executer(python, ["-m", "venv", dossierVenv()], { timeout: 5 * 60_000 });
  } catch (err) {
    throw new Error(tf("L'environnement Python du serveur de Blender n'a pas pu être créé : {0}", String((err as { stderr?: string }).stderr || (err as Error).message).slice(-300)));
  }
  const exigences = join(racine(), "exigences.txt");
  writeFileSync(exigences, `${paquets.exigences.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await executer(
      pythonVenv(),
      ["-I", "-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--require-hashes", "--no-deps", "--only-binary=:all:", "-r", exigences],
      { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    rmSync(dossierVenv(), { recursive: true, force: true });
    const detail = String((err as { stderr?: string }).stderr || (err as Error).message);
    if (/hash/i.test(detail) && /mismatch|do not match|THESE PACKAGES DO NOT MATCH/i.test(detail)) {
      throw new Error(t("Un paquet du serveur de Blender ne correspond pas à son empreinte : rien n'a été installé."));
    }
    throw new Error(tf("Le serveur de Blender n'a pas pu être installé (pypi.org est-il joignable ?) : {0}", detail.trim().split("\n").slice(-3).join(" ").slice(-300)));
  }
  // Le module complémentaire, tel que la roue vérifiée le livre, contrôlé encore par son empreinte.
  const source = sitePackages().map((d) => join(d, ...paquets.module.chemin.split("/"))).find((f) => existsSync(f));
  const octets = source ? readFileSync(source) : null;
  if (!octets || createHash("sha256").update(octets).digest("hex") !== paquets.module.sha256) {
    rmSync(dossierVenv(), { recursive: true, force: true });
    throw new Error(t("Le module complémentaire de Blender livré avec le serveur ne correspond pas à son empreinte : rien n'a été installé."));
  }
  copyFileSync(source!, fichierModuleBlender());
  writeFileSync(marque(), `${VERSION_SERVEUR_BLENDER}\n`, "utf8");
  console.log(`[blender] serveur MCP ${VERSION_SERVEUR_BLENDER} posé dans ${dossierVenv()}.`);
}

/**
 * La commande du serveur, toujours la même : l'interpréteur de l'environnement
 * de Helix, en mode isolé (`-I` : ni PYTHONPATH, ni paquets de l'utilisateur,
 * ni dossier courant), qui appelle le point d'entrée du paquet. Rien ne vient
 * d'une requête ni du magasin.
 */
export function commandeBlender(): { command: string; args: string[] } {
  const essai = serveurEssai();
  if (essai) return { command: essai, args: [] };
  return { command: pythonVenv(), args: ["-I", "-c", "from blender_mcp.server import main; main()"] };
}

/**
 * L'environnement du serveur : la télémétrie coupée (les trois noms que lit
 * `telemetry.py`), pas de vérification de mise à jour, et l'adresse du module
 * écrite ici (127.0.0.1, son port).
 */
export function envBlender(): Record<string, string> {
  return {
    DISABLE_TELEMETRY: "1",
    BLENDER_MCP_DISABLE_TELEMETRY: "1",
    MCP_DISABLE_TELEMETRY: "1",
    BLENDERMCP_NO_UPDATE_CHECK: "1",
    BLENDER_HOST: "127.0.0.1",
    BLENDER_PORT: String(portBlender()),
  };
}

/** Avant de lancer le serveur, et avant chaque appel : `null` si tout va, sinon la raison, dans la langue de qui lit. */
export async function refusBlender(): Promise<string | null> {
  if (!serveurBlenderInstalle()) return t("Le serveur MCP de Blender n'est pas installé sur cette machine : cliquez « Brancher » dans Connecteurs.");
  const v = await ecouteurBlender();
  return v.ok ? null : v.message;
}

/**
 * Au clic sur « Brancher » : Blender introuvable, on le dit sans rien
 * télécharger ; sinon le serveur est posé (une fois), puis Blender doit
 * répondre sur son port. Le message d'un module absent donne le fichier à
 * installer dans Blender.
 */
export async function preparerBlender(): Promise<{ ok: true } | { ok: false; message: string }> {
  const avant = await ecouteurBlender();
  if (!avant.ok && avant.raison !== "absent") return avant;
  if (!avant.ok && !blenderInstalle() && !executableEssai()) return avant;
  try {
    await assurerServeurBlender();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (avant.ok) return { ok: true };
  const apres = await ecouteurBlender();
  if (apres.ok) return { ok: true };
  if (apres.raison !== "absent") return apres;
  return {
    ok: false,
    message: tf(
      "Blender ne répond pas sur le port de son module MCP ({0}). Ouvrez Blender. Première fois : installez le module, Édition, Préférences, Modules complémentaires, « Installer depuis le disque », choisissez le fichier {1}, puis cochez « MCP for Blender ». Il démarre son serveur avec Blender. Puis réessayez.",
      portBlender(),
      fichierModuleBlender(),
    ),
  };
}
