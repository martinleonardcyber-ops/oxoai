import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import paquets from "./blender-paquets.json" with { type: "json" };
import { t, tf } from "./langue.ts";
import { assurerPythonPrive, pythonPrive, taillePythonPriveMo } from "./pythonPrive.ts";
import { ecouteurs, executableParLsof, identite, reel, type Ecouteur } from "./ecouteurs.ts";

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
 * en 3.10 à 3.14 et sait créer un environnement, sinon celui que Helix pose
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
 * et équipe `68UA947AUU` relus le 12/10/2026 sur le vrai Blender 5.2.2
 * (`codesign -dv`, essai de bout en bout noté dans PROJET.md). Une autre
 * signature : Helix refuse de parler au port, ce qui échoue fermé.
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

/** Les entrées d'un dossier dont le nom commence par `prefixe` (sans casse), chemins complets ; rien si le dossier est illisible. */
function entreesCommencantPar(dossier: string, prefixe: RegExp): string[] {
  try {
    return readdirSync(dossier)
      .filter((n) => prefixe.test(n))
      .sort()
      .reverse()
      .map((n) => join(dossier, n));
  } catch {
    return [];
  }
}

/**
 * Le Blender installé, `null` s'il n'est nulle part où on le cherche. Ne sert
 * qu'à formuler le message (« introuvable » ou « fermé ») : Blender peut être
 * ailleurs, et rien n'est refusé faute de le trouver ici (relecture du
 * 12/10/2026). Cherché : macOS, `Blender*.app` dans /Applications et
 * ~/Applications (« Blender 4.2.app »…) ; Windows, toutes les versions sous
 * `Program Files\Blender Foundation\Blender *`, et Steam ; Linux, le PATH,
 * snap, flatpak, et les archives décompressées dans `~/blender*` ou
 * `/opt/blender*`.
 */
export function blenderInstalle(): string | null {
  if (process.platform === "darwin") {
    for (const d of ["/Applications", join(homedir(), "Applications")]) {
      const app = entreesCommencantPar(d, /^blender.*\.app$/i).find((c) => existsSync(join(c, "Contents", "MacOS")));
      if (app) return app;
    }
    return null;
  }
  if (process.platform === "win32") {
    const racines = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter((r): r is string => Boolean(r));
    for (const r of racines) {
      const exe = entreesCommencantPar(join(r, "Blender Foundation"), /^blender/i)
        .map((d) => join(d, "blender.exe"))
        .find((f) => existsSync(f));
      if (exe) return exe;
      const steam = join(r, "Steam", "steamapps", "common", "Blender", "blender.exe");
      if (existsSync(steam)) return steam;
    }
    return null;
  }
  const archives = [homedir(), "/opt"].flatMap((d) => entreesCommencantPar(d, /^blender/i)).map((d) => join(d, "blender"));
  return dansLePath("blender") ?? ["/snap/bin/blender", "/usr/bin/blender", "/var/lib/flatpak/exports/bin/org.blender.Blender", ...archives].find((c) => existsSync(c)) ?? null;
}

/* ------------------------------------------------------------------ */
/* L'écouteur du module complémentaire                                  */
/* ------------------------------------------------------------------ */

export type VerdictBlender = { ok: true; pid: number } | { ok: false; raison: "absent" | "autre" | "illisible" | "muet"; message: string };

/**
 * Les processus déjà reconnus, par numéro, avec leur identité (numéro,
 * exécutable, heure de départ) : un numéro réattribué à un autre programme
 * après la fermeture de Blender n'hérite pas de la reconnaissance (relecture
 * du 12/10/2026). Sans identité lisible, rien n'est gardé : la signature est
 * relue à chaque fois. La lecture des écouteurs est dans ecouteurs.ts (sortie
 * d'ici le 16/10/2026 pour Unreal Editor).
 */
const reconnus = new Map<number, string>();

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
      return { ok: false, raison: "absent", message: tf("Blender ne répond pas sur le port de son module MCP ({0}), et il n'a pas été trouvé à ses emplacements habituels. S'il n'est pas installé, installez-le depuis {1} ; sinon, ouvrez-le et vérifiez que le module « MCP for Blender » est installé et coché (Édition, Préférences, Modules complémentaires). Puis réessayez.", port, TELECHARGEMENT_BLENDER) };
    }
    // 16/10/2026 : le bouton du panneau, dit par son nom réel (« Connect to MCP server », addon.py 2.1.9), quand le démarrage automatique a été coupé.
    return { ok: false, raison: "absent", message: tf("Blender ne répond pas sur le port de son module MCP ({0}). Ouvrez Blender et vérifiez que le module « MCP for Blender » est installé et coché (Édition, Préférences, Modules complémentaires). Il démarre son serveur avec Blender ; sinon, dans la vue 3D, touche N, onglet « MCP for Blender », cliquez « Connect to MCP server ». Puis réessayez.", port) };
  }
  for (const e of liste) {
    const qui = await identite(e);
    if (qui && reconnus.get(e.pid) === qui) continue;
    reconnus.delete(e.pid);
    const exe = await estBlender(e);
    if (!exe) {
      return { ok: false, raison: "autre", message: tf("Un autre programme occupe le port du module MCP de Blender ({0}) sur cette machine : ce n'est pas Blender, et rien ne lui a été envoyé. Fermez ce programme, ouvrez Blender, puis réessayez.", port) };
    }
    if (qui) reconnus.set(e.pid, qui);
  }
  return { ok: true, pid: liste[0]!.pid };
}

/**
 * Délai de la sonde (16/10/2026). Le module traite chaque commande sur le fil
 * principal de Blender, par une minuterie de 50 ms (`_drain_command_queue`,
 * addon.py 2.1.9) : un module qui marche répond à `ping` en quelques
 * dizaines de millisecondes. Réglable pour les essais.
 */
const DELAI_SONDE_MS = Number(process.env.HELIX_ESSAI_BLENDER_SONDE_MS) > 0 ? Number(process.env.HELIX_ESSAI_BLENDER_SONDE_MS) : 4_000;

/**
 * Le module répond-il ? (16/10/2026, bogue signalé par Medhi : « bouge le
 * cube sur blender », trois `get_addon_status` d'une minute chacun.)
 *
 * Mesuré le 16/10/2026 (faux module muet, port ouvert sans réponse) : Helix
 * reconnaissait Blender sur le port, lançait l'appel, et le serveur « MCP for
 * Blender » attendait la réponse du module jusqu'à 180 s (`sock.settimeout`
 * de server.py), bien après les 60 s du délai MCP de Helix. D'où 60,8 s par
 * appel sur ce Mac, et 1 min 02 sous Windows, où PowerShell s'ajoute. Un
 * module muet, c'est un port ouvert par Blender dont le fil principal ne
 * traite plus rien : une boîte de dialogue ou une fenêtre de fichier ouverte,
 * un rendu, un script en cours, ou un module d'une autre version.
 *
 * La sonde envoie `ping` (la commande de vie du module, qui ne touche à aucune
 * donnée de la scène) directement au port, **après** la reconnaissance de
 * Blender, et attend une réponse JSON quelconque : un module plus ancien qui
 * ne connaît pas `ping` répond une erreur, ce qui prouve aussi qu'il traite.
 */
export function sondeBlender(port = portBlender(), delai = DELAI_SONDE_MS): Promise<boolean> {
  return new Promise((fin) => {
    let recu = "";
    let fini = false;
    const finir = (ok: boolean) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuterie);
      socket.destroy();
      fin(ok);
    };
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(JSON.stringify({ type: "ping", params: {} })));
    const minuterie = setTimeout(() => finir(false), delai);
    socket.on("data", (morceau) => {
      recu += morceau.toString("utf8");
      try {
        JSON.parse(recu);
        finir(true);
      } catch {
        /* réponse incomplète */
      }
    });
    socket.on("error", () => finir(false));
    socket.on("close", () => finir(false));
  });
}

/** Le message d'un module muet, dans la langue de qui lit. */
export const messageBlenderMuet = (port = portBlender()): string =>
  tf(
    "Blender a ouvert le port de son module MCP ({0}), mais le module ne répond pas, pas même au simple signal de vie : la demande ne lui a pas été envoyée. Blender est sans doute occupé : fermez la fenêtre ou la boîte de dialogue ouverte dans Blender, ou attendez la fin d'un rendu ou d'un script. Si cela continue, dans la vue 3D, touche N, onglet « MCP for Blender », cliquez « Disconnect » puis « Connect to MCP server ». En dernier recours, décochez puis recochez le module (Édition, Préférences, Modules complémentaires), en installant le fichier {1}. Puis réessayez.",
    port,
    fichierModuleBlender(),
  );

/** L'écouteur est-il Blender, et son module répond-il ? Une seule question pour le lancement et pour chaque appel. */
export async function blenderJoignable(port = portBlender()): Promise<VerdictBlender> {
  const v = await ecouteurBlender(port);
  if (!v.ok) return v;
  if (await sondeBlender(port)) return v;
  return { ok: false, raison: "muet", message: messageBlenderMuet(port) };
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

/**
 * Les versions de Python pour lesquelles blender-paquets.json a des roues :
 * 3.10 à 3.14 (`paquets.python`). Un Python 3.15 trouvé sur la machine
 * créerait un environnement où pip ne trouve aucune roue de pydantic-core
 * (relecture du 12/10/2026) : on prend alors celui de Helix.
 */
export const versionPythonAcceptee = (majeure: number, mineure: number): boolean => majeure === 3 && mineure >= 10 && mineure <= 14;

/** Un Python 3.10 à 3.14 qui sait créer un environnement : celui de Helix s'il est posé, sinon celui du système, sinon Helix pose le sien. */
async function pythonPourVenv(): Promise<string> {
  const prive = pythonPrive();
  if (prive) return prive;
  if (process.platform !== "win32") {
    const candidats = [dansLePath("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].filter((c): c is string => Boolean(c) && existsSync(c!));
    for (const c of candidats) {
      try {
        const { stdout } = await executer(c, ["-I", "-c", "import sys, venv, ensurepip; print(sys.version_info[0], sys.version_info[1])"], { timeout: 20_000 });
        const [maj, min] = stdout.trim().split(/\s+/).map(Number);
        if (versionPythonAcceptee(maj!, min!)) return c;
      } catch {
        /* suivant */
      }
    }
  }
  // Ni l'un ni l'autre : Helix pose son Python 3.12 (github.com, empreinte vérifiée, pythonPrive.ts).
  console.log(`[blender] pas de Python 3.10 à 3.14 sur cette machine : Python privé posé d'abord (${taillePythonPriveMo()} Mo).`);
  return assurerPythonPrive();
}

/**
 * Le message d'un échec de pip, dans la langue de qui lit : empreinte
 * différente, ou aucune roue pour ce Python ou ce système (« No matching
 * distribution », « is not a supported wheel »), ou le reste.
 */
export function messageEchecPip(detail: string): string {
  if (/hash/i.test(detail) && /mismatch|do not match|THESE PACKAGES DO NOT MATCH/i.test(detail)) {
    return t("Un paquet du serveur de Blender ne correspond pas à son empreinte : rien n'a été installé.");
  }
  if (/No matching distribution|Could not find a version that satisfies|is not a supported wheel|no matching wheel/i.test(detail)) {
    return tf("Le serveur de Blender n'existe pas en paquet tout prêt pour ce Python ou ce système : rien n'a été installé. Il faut Python 3.10 à 3.14 sur macOS, Windows ou Linux (Intel ou ARM). Détail : {0}", detail.trim().split("\n").slice(-2).join(" ").slice(-200));
  }
  return tf("Le serveur de Blender n'a pas pu être installé (pypi.org est-il joignable ?) : {0}", detail.trim().split("\n").slice(-3).join(" ").slice(-300));
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
  /*
   * L'ancien environnement est effacé avant d'en poser un neuf. Le serveur qui
   * tourne dessus a été arrêté par l'appelant (brancherLocal, connecteurs.ts) :
   * sous Windows, un python.exe en marche bloque l'effacement. Un échec est dit,
   * traduit, au lieu d'une exception brute (relecture du 12/10/2026). La marque
   * d'abord : un environnement à moitié effacé n'est jamais pris pour posé.
   */
  try {
    mkdirSync(racine(), { recursive: true, mode: 0o700 });
    rmSync(marque(), { force: true });
    rmSync(dossierVenv(), { recursive: true, force: true });
  } catch (err) {
    throw new Error(tf("L'ancien serveur de Blender n'a pas pu être effacé avant sa mise à jour ({0}) : fermez ce qui l'utilise encore, puis réessayez.", (err as Error).message.slice(-200)));
  }
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
    throw new Error(messageEchecPip(String((err as { stderr?: string }).stderr || (err as Error).message)));
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

/** Le dernier verdict, ou celui qui se calcule, pour que l'écran ne relance pas PowerShell à chaque rafraîchissement. */
let dernierVerdict: { quand: number; verdict: Promise<string | null> } | null = null;

/**
 * Avant de lancer le serveur, et avant chaque appel : `null` si tout va, sinon
 * la raison, dans la langue de qui lit. Depuis le 16/10/2026, le module doit
 * aussi **répondre** (`sondeBlender`) : un module muet faisait attendre chaque
 * appel une minute (mesuré : 60,8 s ; avec la sonde, le refus arrive en
 * quelques secondes, et rien n'est envoyé au serveur de Blender).
 */
export function refusBlender(): Promise<string | null> {
  const verdict = (async () => {
    if (!serveurBlenderInstalle()) return t("Le serveur MCP de Blender n'est pas installé sur cette machine : cliquez « Brancher » dans Connecteurs.");
    const v = await blenderJoignable();
    return v.ok ? null : v.message;
  })();
  dernierVerdict = { quand: Date.now(), verdict };
  return verdict;
}

/**
 * Pour l'écran des connecteurs seulement (`etat`, connecteurs.ts) : le verdict
 * de moins de cinq secondes, ou celui qui se calcule déjà (la relance de
 * `relancerLocaux` part en même temps). Le lancement et chaque appel, eux,
 * appellent `refusBlender` et relisent tout (relecture du 12/10/2026 : deux
 * PowerShell par rafraîchissement sous Windows).
 */
export function refusBlenderRecent(): Promise<string | null> {
  if (dernierVerdict && Date.now() - dernierVerdict.quand < 5_000) return dernierVerdict.verdict;
  return refusBlender();
}

/** Faut-il (re)poser le serveur ? L'appelant arrête d'abord celui qui tourne (brancherLocal). */
export const serveurBlenderAPoser = (): boolean => !serveurBlenderInstalle();

/**
 * Au retrait du connecteur : l'environnement de Helix (`<données>/blender-mcp`)
 * est effacé, après la fin d'une installation en cours. Le module coché dans
 * Blender, Helix n'y touche pas : la personne le décoche (l'écran le dit).
 */
export async function effacerServeurBlender(): Promise<void> {
  await installation?.catch(() => undefined);
  rmSync(racine(), { recursive: true, force: true });
}

/**
 * Au clic sur « Brancher » : le serveur est posé (une fois), puis Blender doit
 * répondre sur son port. Blender introuvable à ses emplacements habituels ne
 * bloque rien : il peut être installé ailleurs (relecture du 12/10/2026), la
 * détection ne sert qu'au message. Le message d'un module absent donne le
 * fichier à installer dans Blender.
 */
export async function preparerBlender(): Promise<{ ok: true } | { ok: false; message: string }> {
  const avant = await ecouteurBlender();
  if (!avant.ok && avant.raison !== "absent") return avant;
  try {
    await assurerServeurBlender();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (avant.ok) return { ok: true };
  const apres = await ecouteurBlender();
  if (apres.ok) return { ok: true };
  if (apres.raison !== "absent") return apres;
  const introuvable = !blenderInstalle() && !executableEssai();
  return {
    ok: false,
    message: introuvable
      ? tf(
          "Blender ne répond pas sur le port de son module MCP ({0}), et il n'a pas été trouvé à ses emplacements habituels. S'il n'est pas installé, installez-le depuis {1}. Puis ouvrez-le et, la première fois, installez le module : Édition, Préférences, Modules complémentaires, « Installer depuis le disque », choisissez le fichier {2}, puis cochez « MCP for Blender ». Puis réessayez.",
          portBlender(),
          TELECHARGEMENT_BLENDER,
          fichierModuleBlender(),
        )
      : tf(
          "Blender ne répond pas sur le port de son module MCP ({0}). Ouvrez Blender. Première fois : installez le module, Édition, Préférences, Modules complémentaires, « Installer depuis le disque », choisissez le fichier {1}, puis cochez « MCP for Blender ». Il démarre son serveur avec Blender. Puis réessayez.",
          portBlender(),
          fichierModuleBlender(),
        ),
  };
}
