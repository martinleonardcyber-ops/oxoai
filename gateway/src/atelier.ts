import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  symlink,
} from "node:fs/promises";
import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, homedir, tmpdir, totalmem } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { assurerNodePrive, nodePriveInstallable, npmPrive, npxPrive } from "./installationOpenClaw.ts";
import { arreterArbre } from "./processus.ts";
import { assurerPythonPrive, pythonPrive, pythonPriveInstallable, taillePythonPriveMo } from "./pythonPrive.ts";
import paquetsFiges from "./atelier-paquets.json" with { type: "json" };

const exec = promisify(execFile);

/**
 * Atelier bureautique de Cowork.
 *
 * Cowork ne dispose que d'outils de système de fichiers : pas de shell, pas
 * d'exécution de code. Pour qu'il sache produire et lire du Word, de l'Excel,
 * du PowerPoint et du PDF, il faut que la machine porte les bibliothèques
 * correspondantes.
 *
 * La tentation serait de demander au modèle de « préparer la machine » en
 * tapant des commandes. C'est exclu : notre modèle par défaut est un 8B local,
 * il improviserait des commandes système sur le poste de quelqu'un. La
 * préparation est donc **déterministe** et exécutée par la passerelle : la
 * liste des paquets est figée dans ce module, aucune chaîne n'est construite
 * depuis une entrée utilisateur, et tout passe par `execFile`/`spawn` avec un
 * tableau d'arguments — jamais par un shell.
 *
 * Tout est installé dans un environnement **isolé** sous `~/.helix/cowork` :
 * un venv Python et un préfixe npm. Ni les installations globales, ni le PATH
 * de l'utilisateur, ni ses projets ne sont touchés, et aucun droit
 * administrateur n'est demandé.
 */

/* --------------------------------- catalogue ---------------------------------- */

interface Paquet {
  /** Nom d'installation, tel qu'il est publié. */
  nom: string;
  /** À quoi il sert, en clair : c'est ce que l'interface affiche. */
  usage: string;
}

/**
 * Bibliothèques Python. Elles couvrent la création **et** la relecture des
 * quatre formats visés, sans compilation native sur les plateformes courantes
 * (toutes sont diffusées en roues précompilées).
 */
const PAQUETS_PYTHON: Paquet[] = [
  { nom: "python-docx", usage: "Créer et relire des documents Word" },
  { nom: "python-pptx", usage: "Créer et relire des présentations PowerPoint" },
  { nom: "openpyxl", usage: "Lire et écrire des classeurs Excel, formules comprises" },
  { nom: "XlsxWriter", usage: "Écrire des classeurs Excel mis en forme" },
  { nom: "pandas", usage: "Trier et calculer des tableaux avant export" },
  { nom: "pypdf", usage: "Assembler, découper et lire des PDF" },
  { nom: "pdfplumber", usage: "Extraire le texte et les tableaux d'un PDF" },
  { nom: "reportlab", usage: "Produire un PDF à partir de rien" },
  { nom: "Pillow", usage: "Redimensionner et convertir les images insérées" },
  { nom: "lxml", usage: "Socle XML commun aux formats bureautiques" },
];

/** Bibliothèques Node, pour les traitements que la passerelle fera elle-même. */
const PAQUETS_NODE: Paquet[] = [
  { nom: "docx", usage: "Écrire des documents Word depuis la passerelle" },
  { nom: "pptxgenjs", usage: "Écrire des présentations PowerPoint" },
  { nom: "@e965/xlsx", usage: "Lire et écrire des classeurs Excel" },
  { nom: "mammoth", usage: "Convertir un document Word en texte ou en HTML" },
  { nom: "pdf-lib", usage: "Modifier et assembler des PDF existants" },
  { nom: "pdfjs-dist", usage: "Lire le contenu d'un PDF" },
];

/*
 * Volontairement absents : matplotlib, sharp, @napi-rs/canvas, tesseract.js.
 *
 * Les deux premiers pèsent lourd et le second compile du natif à
 * l'installation — sur un poste sans chaîne de compilation, c'est l'échec
 * assuré, et c'est le genre d'échec qu'un utilisateur non technicien ne peut
 * pas dénouer. Les deux derniers relèvent du graphisme et de la reconnaissance
 * de caractères, hors du besoin bureautique de base : produire et relire un
 * document. Ils pourront s'ajouter plus tard, comme option assumée, plutôt que
 * de faire échouer la préparation de tout le monde.
 */

/**
 * Place occupée après installation, en mégaoctets, mesurée sur un poste neuf.
 * L'interface l'annonce avant d'installer : on ne remplit pas le disque de
 * quelqu'un sans le lui dire.
 */
const TAILLE_PYTHON_MO = 220;
const TAILLE_NODE_MO = 100;

/* ------------------------------- emplacements --------------------------------- */

/**
 * Racine de l'atelier. `HELIX_DATA_DIR` prime, comme pour le jeton d'instance
 * (auth.ts) : ce que Helix écrit reste sous le dossier que l'exploitant a
 * désigné, ce qui permet aussi de vérifier une installation sans toucher à
 * celle de la machine.
 */
export function racine(): string {
  const force = process.env.HELIX_DATA_DIR;
  return force ? join(force, "cowork") : join(homedir(), ".helix", "cowork");
}

const dossierPython = () => join(racine(), "python");
const dossierNode = () => join(racine(), "node");

/** Interpréteur du venv. Windows range les exécutables ailleurs. */
const pythonVenv = () =>
  process.platform === "win32"
    ? join(dossierPython(), "Scripts", "python.exe")
    : join(dossierPython(), "bin", "python3");

const pipVenv = () =>
  process.platform === "win32"
    ? join(dossierPython(), "Scripts", "pip.exe")
    : join(dossierPython(), "bin", "pip");

/*
 * Paquets Python figés, dépendances comprises, avec l'empreinte SHA-256 de
 * chacune de leurs roues (atelier-paquets.json, refait par
 * `node scripts/atelier-empreintes.mjs`). Audit de la chaîne
 * d'approvisionnement du 27/09/2026 : l'atelier installait la dernière version
 * publiée de dix noms, et de leurs dépendances, au moment du clic, sans rien
 * vérifier. pip refuse désormais tout fichier absent de la liste ou à
 * l'empreinte différente (`--require-hashes`), n'ajoute aucune dépendance de
 * lui-même (`--no-deps`) et ne compile rien (`--only-binary`).
 *
 * Résolu pour Python 3.9 à 3.14 : les roues existent pour macOS à puce Apple,
 * Linux (x64 et arm64) et Windows x64, vérifié par uv pour chaque système et
 * chaque version ; installé pour de vrai sur ce Mac (Python 3.14). Pas de roue
 * pour Windows arm64 ni Mac Intel (cryptography), que l'application ne vise pas.
 */
const OPTIONS_PIP_FIGEES = ["--require-hashes", "--no-deps", "--only-binary=:all:"];
async function exigencesFigees(liste: "bureautique" | "dictee"): Promise<string> {
  const chemin = join(racine(), `exigences-${liste}.txt`);
  await writeFile(chemin, `${paquetsFiges[liste].join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return chemin;
}

/**
 * Interpréteur de l'atelier, pour les outils bureautiques (bureau.ts) : eux
 * aussi exécutent du Python dans ce venv, et l'emplacement ne doit être déduit
 * qu'à un seul endroit.
 */
export const interpreteur = (): string => pythonVenv();

const modulesNode = () => join(dossierNode(), "node_modules");

/**
 * Dossiers `site-packages` du venv. Leur nom dépend de la version de Python
 * (`lib/python3.14/site-packages`), qu'on ne connaît pas d'avance : on les
 * cherche. Synchrone, parce que `bureau.ts` en a besoin là où il répond sans
 * attendre.
 */
function sitePackages(): string[] {
  if (process.platform === "win32") return [join(dossierPython(), "Lib", "site-packages")];
  try {
    return readdirSync(join(dossierPython(), "lib"))
      .filter((nom) => nom.startsWith("python"))
      .map((nom) => join(dossierPython(), "lib", nom, "site-packages"));
  } catch {
    return [];
  }
}

/** Le module Python `nom` est-il posé dans le venv ? Lecture du disque seule. */
const modulePresent = (nom: string) => sitePackages().some((d) => existsSync(join(d, nom)));

/**
 * Les bibliothèques qu'importent les outils bureautiques sont-elles là ?
 *
 * `bureau.ts` se contentait de l'existence de l'interpréteur du venv. Tant que
 * seul l'atelier créait ce venv, cela revenait au même. Depuis que la dictée
 * s'installe dans le **même** venv, un poste qui n'a installé que la dictée
 * aurait vu apparaître cinq outils `bureau__…` voués à l'échec, et l'écran
 * « Outils » aurait annoncé une bureautique absente. On regarde donc les
 * modules eux-mêmes : ceux que le script de `bureau.ts` importe.
 */
export function bureautiquePresente(): boolean {
  if (!existsSync(pythonVenv())) return false;
  return ["docx", "openpyxl", "pptx", "reportlab", "pdfplumber"].every(modulePresent);
}

/* ------------------------------ localisation ---------------------------------- */

async function existe(chemin: string, mode = constants.R_OK): Promise<boolean> {
  try {
    await access(chemin, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retrouve un exécutable, d'abord aux emplacements usuels puis dans le PATH.
 *
 * L'ordre compte : une application lancée depuis le Finder hérite d'un PATH
 * réduit (`/usr/bin:/bin:...`) où Homebrew n'apparaît pas. Se fier au seul PATH
 * ferait conclure « Python absent » sur une machine qui l'a. C'est la même
 * précaution que `findLms` dans backends.ts.
 */
async function localiser(nom: string, candidats: string[]): Promise<string | null> {
  for (const candidat of candidats) {
    if (await existe(candidat, constants.X_OK)) return candidat;
  }
  // Sous Windows, un programme porte son extension (`python.exe`), et le PATH n'en dit rien.
  const noms = process.platform === "win32" ? [`${nom}.exe`, nom] : [nom];
  for (const dossier of (process.env.PATH ?? "").split(delimiter)) {
    if (!dossier) continue;
    /*
     * Les alias du Microsoft Store (`WindowsApps\python.exe`) ne sont pas
     * Python : ils ouvrent le Store. Les compter faisait croire à un Python
     * présent, puis tout échouait.
     */
    if (process.platform === "win32" && /[\\/]WindowsApps[\\/]?$/i.test(dossier)) continue;
    for (const n of noms) {
      const chemin = join(dossier, n);
      if (await existe(chemin, constants.X_OK)) return chemin;
    }
  }
  return null;
}

const CANDIDATS_HOMEBREW = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const cheminsUsuels = (nom: string) => (process.platform === "win32" ? [] : CANDIDATS_HOMEBREW.map((d) => join(d, nom)));

/*
 * Windows (audit du 27/09/2026) : ni `python3` ni `npm` n'y existent sous ce
 * nom, et l'atelier disait « Python 3 est absent » sur une machine qui l'avait.
 * Python : le lanceur `py` connaît les Python installés et rend le vrai
 * chemin ; sinon `python.exe` dans le PATH. npm : un `.cmd`, que Node refuse de
 * lancer sans interpréteur de commandes ; on lance donc son script lui-même
 * (`npm-cli.js`, rangé à côté de `node.exe`), par Node.
 */
async function trouverPython(): Promise<string | null> {
  if (process.platform !== "win32") return localiser("python3", cheminsUsuels("python3"));
  const lanceurs = [join(process.env.SystemRoot ?? "C:\\Windows", "py.exe"), join(process.env.LOCALAPPDATA ?? homedir(), "Programs", "Python", "Launcher", "py.exe")];
  for (const py of lanceurs) {
    if (!(await existe(py))) continue;
    try {
      const { stdout } = await exec(py, ["-3", "-c", "import sys; print(sys.executable)"], { timeout: 20_000 });
      const chemin = String(stdout).trim();
      if (chemin && (await existe(chemin))) return chemin;
    } catch {
      /* lanceur sans Python 3 */
    }
  }
  return localiser("python", []);
}
async function trouverNpm(): Promise<string | null> {
  if (process.platform !== "win32") return (await localiser("npm", cheminsUsuels("npm"))) ?? npmPrive();
  const node = await trouverNode();
  const script = node ? join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js") : null;
  return script && (await existe(script)) ? script : npmPrive();
}
const trouverNode = () => localiser("node", cheminsUsuels("node"));

/*
 * Comment installer ce qui manque, selon le système : la commande exacte, que
 * la personne lance elle-même (Helix ne passe pas administrateur). Elle n'est
 * donnée que là où Helix ne sait pas poser Python (pythonPrive.ts) ni Node
 * (installationOpenClaw.ts) lui-même.
 */
const commentPython = (): string =>
  process.platform === "win32"
    ? t("site officiel python.org, ou dans un terminal : winget install -e --id Python.Python.3.12")
    : process.platform === "linux"
      ? t("sudo apt install python3 python3-venv (Debian, Ubuntu), ou sudo dnf install python3 (Fedora)")
      : t("site officiel python.org, ou Homebrew : brew install python");
const commentNode = (): string =>
  process.platform === "win32"
    ? t("site officiel nodejs.org, ou dans un terminal : winget install -e --id OpenJS.NodeJS.LTS")
    : process.platform === "linux"
      ? t("sudo apt install nodejs npm (Debian, Ubuntu), ou sudo dnf install nodejs npm (Fedora)")
      : t("site officiel nodejs.org, ou Homebrew : brew install node");

/*
 * Debian et Ubuntu livrent Python sans son module `venv` (paquet à part,
 * `python3-venv`) : la création de l'environnement échouait au milieu de
 * l'installation. On le vérifie avant.
 */
/*
 * Et seulement un Python pour lequel les paquets figés ont été résolus
 * (3.9 à 3.14, 64 bits, `OPTIONS_PIP_FIGEES`). Vu sur l'essai Windows du
 * 24/10/2026 : la dictée s'arrêtait sur « No matching distribution found for
 * ctranslate2==4.8.2 (from versions: none) », roue introuvable pour
 * l'interpréteur de la machine, alors que les roues Windows de 3.9 à 3.14 sont
 * toutes dans la liste. Un autre Python (3.15, sorti en octobre 2026, ou un
 * 32 bits) laisse la place à celui que Helix pose (pythonPrive.ts, 3.12).
 */
const PYTHON_PREVU = "import sys, struct, venv, ensurepip; sys.exit(0 if (3, 9) <= sys.version_info[:2] <= (3, 14) and struct.calcsize('P') == 8 else 3)";
async function pythonPrevu(python: string): Promise<boolean> {
  try {
    await exec(python, ["-c", PYTHON_PREVU], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Un environnement fait par un Python hors de la liste (ci-dessus) : retiré
 * avant l'installation, qui le recrée avec un Python prévu. Sans cela, chaque
 * nouvel essai retombait sur la même roue introuvable.
 */
async function retirerVenvImprevu(): Promise<void> {
  if (!(await existe(pythonVenv(), constants.X_OK)) || (await pythonPrevu(pythonVenv()))) return;
  console.warn("[helix] environnement Python de l'atelier fait par un Python hors des versions prévues : recréé.");
  await rm(dossierPython(), { recursive: true, force: true });
}

async function venvDisponible(python: string): Promise<boolean> {
  try {
    await exec(python, ["-c", PYTHON_PREVU], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
const obstacleVenv = (): string =>
  tf("Python est là, mais sans son module de création d'environnement (venv). Installez-le, puis réessayez : {0}.", process.platform === "linux" ? "sudo apt install python3-venv" : commentPython());

/*
 * Python pour créer l'environnement de l'atelier : celui du système s'il sait
 * en créer un, sinon celui que Helix pose lui-même (pythonPrive.ts, décidé par
 * Medhi le 27/09/2026). `installer` : le poser s'il manque (à l'installation),
 * pas au diagnostic, qui ne fait que regarder.
 */
async function pythonPourVenv(installer: boolean, avancer?: (pourcent: number) => void): Promise<string | null> {
  const systeme = await trouverPython();
  if (systeme && (await venvDisponible(systeme))) return systeme;
  const prive = pythonPrive();
  if (prive || !installer) return prive;
  return assurerPythonPrive(avancer);
}

/** Un script JavaScript (npm sous Windows) se lance par Node ; le reste, tel quel. */
/*
 * Par le Node auquel ce script appartient, s'il est là (`node.exe` à côté de
 * `node_modules` sous Windows, `bin/node` ailleurs) : npm suit les versions de
 * Node, pas celle d'Electron (audit Windows du 27/09/2026). Sinon, le Node de
 * Helix s'il est posé, et à défaut `node` du PATH.
 *
 * Plus jamais le binaire de la passerelle (28/09/2026) : dans l'application de
 * bureau, c'est celui de Helix, qui n'est plus un Node depuis que le fusible
 * RunAsNode est fermé ; le lancer ouvrirait une seconde application.
 */
function nodeDuScript(script: string): string {
  const racineNpm = dirname(dirname(dirname(script))); // …/node_modules/npm/bin/npm-cli.js → …/node_modules
  const racine = dirname(racineNpm);
  const candidats =
    process.platform === "win32"
      ? [join(racine, "node.exe")]
      : [join(racine, "bin", "node"), join(dirname(racine), "bin", "node")]; // …/lib/node_modules → …/bin/node
  return candidats.find((c) => existsSync(c)) ?? npxPrive()?.node ?? "node";
}

/**
 * Le Node qui charge les bibliothèques de l'atelier pour les vérifier : celui
 * du npm qui les a installées (le même Node, les mêmes modules natifs), sinon
 * le Node du système, sinon celui de Helix. Null s'il n'y en a aucun.
 */
async function nodeDeLAtelier(): Promise<string | null> {
  const npm = await trouverNpm();
  if (npm?.endsWith(".js")) return nodeDuScript(npm);
  if (npm) {
    const voisin = join(dirname(npm), process.platform === "win32" ? "node.exe" : "node");
    if (await existe(voisin)) return voisin;
  }
  return (await trouverNode()) ?? npxPrive()?.node ?? null;
}
const commandeDe = (commande: string, args: string[]): [string, string[]] =>
  commande.endsWith(".js") ? [nodeDuScript(commande), [commande, ...args]] : [commande, args];

/** Première ligne de `<outil> --version`, ou `null` si l'outil ne répond pas. */
async function versionDe(chemin: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const [exe, arguments_] = commandeDe(chemin, args);
    const { stdout, stderr } = await exec(exe, arguments_, { timeout: 20_000 });
    const brut = `${stdout}${stderr}`.trim();
    return brut.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/* -------------------------------- diagnostic ---------------------------------- */

export interface OutilSysteme {
  id: "python3" | "pip" | "node" | "npm";
  nom: string;
  present: boolean;
  version?: string;
  chemin?: string;
}

export interface OutilOptionnel {
  id: "libreoffice" | "poppler";
  nom: string;
  present: boolean;
  /** Ce que sa présence apporterait, en clair. */
  apport: string;
  /** Comment l'obtenir, si l'utilisateur le souhaite. */
  obtention: string;
}

export interface Bibliotheque extends Paquet {
  ecosysteme: "python" | "node";
  installee: boolean;
  version?: string;
}

export interface Diagnostic {
  racine: string;
  systeme: OutilSysteme[];
  bibliotheques: Bibliotheque[];
  optionnels: OutilOptionnel[];
  /** Toutes les bibliothèques attendues sont là. */
  pret: boolean;
  /** Python 3 et npm répondent : la préparation peut être tentée. */
  installable: boolean;
  /** Ce qui empêche d'installer, dit à quelqu'un qui n'est pas informaticien. */
  obstacles: string[];
  /** Taille approximative du téléchargement restant, en mégaoctets. */
  tailleEstimeeMo: number;
}

/** Normalisation PEP 503 : `Python-Docx`, `python_docx` et `python-docx` sont un. */
const normaliser = (nom: string) => nom.replace(/[-_.]+/g, "-").toLowerCase();

/** Distributions présentes dans le venv, par nom normalisé. */
async function pythonInstallees(): Promise<Map<string, string>> {
  const trouvees = new Map<string, string>();
  const pip = pipVenv();
  if (!(await existe(pip, constants.X_OK))) return trouvees;

  try {
    const { stdout } = await exec(
      pip,
      ["list", "--format=json", "--disable-pip-version-check"],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const liste = JSON.parse(stdout) as { name?: string; version?: string }[];
    for (const entree of liste) {
      if (entree.name) trouvees.set(normaliser(entree.name), entree.version ?? "?");
    }
  } catch {
    /* venv illisible : tout sera considéré comme absent, donc réinstallable */
  }
  return trouvees;
}

/** Version d'un paquet npm du préfixe, ou `null` s'il n'y est pas. */
async function versionNode(nom: string): Promise<string | null> {
  try {
    const manifeste = join(modulesNode(), ...nom.split("/"), "package.json");
    const brut = await readFile(manifeste, "utf8");
    return (JSON.parse(brut) as { version?: string }).version ?? "?";
  } catch {
    return null;
  }
}

/**
 * LibreOffice et Poppler ne sont **pas** installés automatiquement : ils
 * passent par Homebrew ou par un paquet système, pèsent plusieurs centaines de
 * mégaoctets et peuvent demander des droits. Les poser dans le dos de
 * quelqu'un serait une intrusion. On se contente donc de dire qu'ils existent
 * et ce qu'ils apporteraient.
 */
async function optionnels(): Promise<OutilOptionnel[]> {
  const libreoffice =
    (await existe("/Applications/LibreOffice.app")) ||
    (await existe(join(homedir(), "Applications", "LibreOffice.app"))) ||
    (await localiser("soffice", [
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      join(homedir(), "Applications", "LibreOffice.app", "Contents", "MacOS", "soffice"),
      // Windows : l'installateur de LibreOffice ne l'ajoute pas au PATH.
      ...(process.platform === "win32"
        ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((d): d is string => Boolean(d)).map((d) => join(d, "LibreOffice", "program", "soffice.exe"))
        : []),
      ...cheminsUsuels("soffice"),
    ])) !== null;

  const poppler = (
    await Promise.all(
      ["pdftotext", "pdftoppm", "pdfinfo"].map((outil) =>
        localiser(outil, cheminsUsuels(outil)),
      ),
    )
  ).every((chemin) => chemin !== null);

  return [
    {
      id: "libreoffice",
      nom: "LibreOffice",
      present: libreoffice,
      apport:
        "Convertit un document d'un format à l'autre, par exemple un Word ou un classeur Excel en PDF fidèle à la mise en page.",
      // Le texte reste en français ici : l'écran le traduit (src/i18n/instance.ts).
      obtention:
        process.platform === "darwin"
          ? "Facultatif. À installer soi-même depuis le site de LibreOffice ou avec Homebrew."
          : "Facultatif. À installer soi-même depuis le site de LibreOffice, ou par le gestionnaire de paquets du système.",
    },
    {
      id: "poppler",
      nom: "Outils Poppler",
      present: poppler,
      apport:
        "Transforme une page de PDF en image et en extrait le texte, y compris quand la mise en page est complexe.",
      obtention:
        process.platform === "darwin"
          ? "Facultatif. À installer soi-même avec Homebrew (paquet poppler)."
          : process.platform === "win32"
            ? "Facultatif. À installer soi-même (Poppler pour Windows), puis à ajouter au PATH."
            : "Facultatif. À installer soi-même par le gestionnaire de paquets (paquet poppler-utils).",
    },
  ];
}

/** Inspection en lecture seule : rien n'est installé, rien n'est modifié. */
export async function diagnostic(): Promise<Diagnostic> {
  const [cheminPython, cheminNpm, cheminNode] = await Promise.all([
    // Celui du système, sinon celui que Helix a posé (pythonPrive.ts).
    trouverPython().then((p) => p ?? pythonPrive()),
    trouverNpm(),
    trouverNode(),
  ]);

  const [versionPython, versionNpm, versionNodeSysteme, pip] = await Promise.all([
    cheminPython ? versionDe(cheminPython) : Promise.resolve(null),
    cheminNpm ? versionDe(cheminNpm) : Promise.resolve(null),
    cheminNode ? versionDe(cheminNode, ["--version"]) : Promise.resolve(null),
    (async () => {
      const chemin = pipVenv();
      return (await existe(chemin, constants.X_OK)) ? versionDe(chemin) : null;
    })(),
  ]);

  const systeme: OutilSysteme[] = [
    {
      id: "python3",
      nom: "Python 3",
      present: Boolean(cheminPython && versionPython),
      version: versionPython ?? undefined,
      chemin: cheminPython ?? undefined,
    },
    {
      id: "pip",
      nom: "pip de l'atelier",
      present: Boolean(pip),
      version: pip ?? undefined,
      chemin: pip ? pipVenv() : undefined,
    },
    {
      id: "node",
      nom: "Node",
      // La passerelle tourne elle-même sur Node : à défaut d'un binaire trouvé
      // sur le disque, sa propre version est une réponse honnête.
      present: true,
      version: versionNodeSysteme ?? `v${process.versions.node}`,
      chemin: cheminNode ?? undefined,
    },
    {
      id: "npm",
      nom: "npm",
      present: Boolean(cheminNpm && versionNpm),
      version: versionNpm ?? undefined,
      chemin: cheminNpm ?? undefined,
    },
  ];

  const python = await pythonInstallees();
  const bibliotheques: Bibliotheque[] = [
    ...PAQUETS_PYTHON.map((p) => {
      const version = python.get(normaliser(p.nom));
      return { ...p, ecosysteme: "python" as const, installee: Boolean(version), version };
    }),
    ...(await Promise.all(
      PAQUETS_NODE.map(async (p) => {
        const version = await versionNode(p.nom);
        return {
          ...p,
          ecosysteme: "node" as const,
          installee: version !== null,
          version: version ?? undefined,
        };
      }),
    )),
  ];

  const obstacles: string[] = [];
  // Sans Python qui convienne, Helix pose le sien à la préparation : ce n'est un obstacle que là où il ne sait pas le faire.
  const venvLa = await existe(pythonVenv(), constants.X_OK);
  if (!venvLa && !(await pythonPourVenv(false)) && pythonPriveInstallable() !== null) {
    obstacles.push(
      !cheminPython || !versionPython
        ? tf("Python 3 est absent de cette machine. C'est le socle qui sait écrire et relire les documents Word, Excel et PowerPoint. Installez Python 3 ({0}), puis relancez ce diagnostic.", commentPython())
        : obstacleVenv(),
    );
  }
  /*
   * Sans npm sur la machine, Helix pose son propre Node officiel (vérifié par
   * son empreinte publiée, installationOpenClaw.ts) à la préparation : ce
   * n'est un obstacle que là où il ne sait pas le faire.
   */
  if ((!cheminNpm || !versionNpm) && nodePriveInstallable() !== null) {
    obstacles.push(
      tf("npm est absent de cette machine. Il accompagne Node et sert à récupérer les bibliothèques de documents. Installez Node ({0}), puis relancez ce diagnostic.", commentNode()),
    );
  }

  const manquantesPython = bibliotheques.filter(
    (b) => b.ecosysteme === "python" && !b.installee,
  ).length;
  const manquantesNode = bibliotheques.filter(
    (b) => b.ecosysteme === "node" && !b.installee,
  ).length;

  return {
    racine: racine(),
    systeme,
    bibliotheques,
    optionnels: await optionnels(),
    pret: manquantesPython === 0 && manquantesNode === 0,
    installable: obstacles.length === 0,
    obstacles,
    // Estimation par écosystème : n'annoncer que ce qui reste réellement à
    // télécharger évite de faire peur pour une mise à jour de deux paquets.
    tailleEstimeeMo:
      (manquantesPython > 0 ? TAILLE_PYTHON_MO : 0) +
      (manquantesNode > 0 ? TAILLE_NODE_MO : 0) +
      // Python lui-même, quand Helix doit le poser.
      (!venvLa && !(await pythonPourVenv(false)) ? taillePythonPriveMo() : 0),
  };
}

/* -------------------------------- préparation --------------------------------- */

export interface Progres {
  phase: "verification" | "python" | "node" | "termine" | "erreur";
  message: string;
  /** Progression estimée, de 0 à 100. */
  percent: number;
  /** Ligne d'activité de l'outil sous-jacent, si elle éclaire l'attente. */
  detail?: string;
}

export interface Etape {
  id: "python" | "node";
  ok: boolean;
  message: string;
}

export interface Bilan {
  ok: boolean;
  /** Durée totale, en millisecondes. */
  duree: number;
  etapes: Etape[];
  /** État de la machine après coup : l'interface n'a pas à redemander. */
  diagnostic: Diagnostic;
}

/**
 * Lance un exécutable et suit sa sortie ligne à ligne.
 *
 * `spawn` sans shell : les arguments restent des arguments. Même si l'un
 * d'eux contenait un espace ou un point-virgule, rien ne serait réinterprété.
 */
function lancer(
  commande: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    onLigne?: (ligne: string) => void;
    /** Variables ajoutées à l'environnement hérité (téléchargement du modèle de dictée). */
    env?: Record<string, string>;
  } = {},
): Promise<void> {
  const { cwd, timeout = 30 * 60_000, onLigne, env } = options;

  const [exe, arguments_] = commandeDe(commande, args);
  return new Promise((resolve, reject) => {
    const enfant = spawn(exe, arguments_, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Une invite interactive bloquerait l'installation sans que personne
        // ne puisse y répondre : il n'y a pas de terminal derrière.
        PIP_NO_INPUT: "1",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        npm_config_yes: "true",
        ...env,
      },
    });

    let dernieres = "";
    const garder = (morceau: Buffer) => {
      const texte = morceau.toString("utf8");
      dernieres = (dernieres + texte).slice(-4000);
      if (!onLigne) return;
      // `\r` aussi : les barres de progression réécrivent leur ligne en place.
      for (const ligne of texte.split(/[\r\n]+/)) {
        const propre = ligne.trim();
        if (propre) onLigne(propre);
      }
    };

    enfant.stdout?.on("data", garder);
    enfant.stderr?.on("data", garder);

    /*
     * Revue du 28/09/2026 : tout l'arbre (`arreterArbre`), pas seulement le
     * processus lancé. Sous Windows, `kill()` n'arrête que lui, et ce que pip
     * ou npm avaient lancé (compilateur, script d'installation) continuait
     * seul après le délai. Messages par `tf` : ils s'affichent à l'écran de
     * préparation, et arrivaient en français dans toutes les langues.
     */
    const minuterie = setTimeout(() => {
      arreterArbre(enfant, "SIGKILL");
      reject(new Error(tf("{0} n'a pas répondu dans le temps imparti.", commande)));
    }, timeout);

    enfant.on("error", (err) => {
      clearTimeout(minuterie);
      reject(new Error(tf("{0} n'a pas pu être lancé : {1}", commande, err.message)));
    });

    enfant.on("close", (code) => {
      clearTimeout(minuterie);
      if (code === 0) return resolve();
      // Les dernières lignes valent mieux qu'un code de sortie nu : c'est là
      // que se trouve la raison réelle de l'échec.
      reject(new Error(dernieres.trim().split("\n").slice(-6).join("\n") || `Code ${code}.`));
    });
  });
}

/**
 * Une seule installation à la fois, atelier **ou** dictée : les deux écrivent
 * dans le même venv, et deux pip concurrents se marcheraient dessus.
 */
let enCours: Promise<unknown> | null = null;

export function preparationEnCours(): boolean {
  return enCours !== null;
}

async function exclusif<T>(travail: () => Promise<T>): Promise<T> {
  if (enCours) {
    throw new Error(t("Une préparation est déjà en cours. Attendez qu'elle se termine."));
  }
  const promesse = travail();
  enCours = promesse;
  try {
    return await promesse;
  } finally {
    enCours = null;
  }
}

export function preparer(onProgres: (p: Progres) => void): Promise<Bilan> {
  return exclusif(() => executerPreparation(onProgres));
}

async function executerPreparation(onProgres: (p: Progres) => void): Promise<Bilan> {
  const debut = Date.now();
  const etapes: Etape[] = [];

  onProgres({ phase: "verification", message: t("Vérification des prérequis..."), percent: 2 });
  const avant = await diagnostic();

  if (!avant.installable) {
    // Prérequis manquants : on ne tente rien. Une commande lancée dans le vide
    // produirait une erreur technique là où il faut une consigne claire.
    throw new Error(avant.obstacles.join(" "));
  }

  await mkdir(racine(), { recursive: true });

  /* ------------------------------- Python ------------------------------------ */
  try {
    await retirerVenvImprevu();
    if (!(await existe(pythonVenv(), constants.X_OK))) {
      const python = await pythonPourVenv(true, (p) =>
        onProgres({ phase: "python", message: tf("Installation de Python ({0} %)...", p), percent: 2 + Math.round(p * 0.04) }),
      );
      if (!python) throw new Error(t("Python 3 est introuvable."));
      onProgres({
        phase: "python",
        message: t("Création de l'environnement Python isolé..."),
        percent: 6,
      });
      await lancer(python, ["-m", "venv", dossierPython()], { timeout: 5 * 60_000 });
    }

    onProgres({
      phase: "python",
      message: t("Installation des bibliothèques de documents..."),
      percent: 12,
    });

    /*
     * pip ne sait pas dire où il en est. On avance donc au rythme de ses
     * lignes d'activité, en s'arrêtant avant la fin de la tranche : mieux vaut
     * une barre qui reste un peu en retrait qu'une barre qui annonce la fin
     * avant l'heure.
     */
    let lignes = 0;
    const suivre = (ligne: string) => {
      if (!/^(Collecting|Downloading|Using cached|Installing|Building|Preparing)/.test(ligne)) {
        return;
      }
      lignes += 1;
      onProgres({
        phase: "python",
        message: t("Installation des bibliothèques de documents..."),
        percent: Math.min(68, 12 + lignes * 1.2),
        detail: ligne.slice(0, 120),
      });
    };

    const pip = pipVenv();
    await lancer(
      pip,
      ["install", "--no-input", "--disable-pip-version-check", ...OPTIONS_PIP_FIGEES, "-r", await exigencesFigees("bureautique")],
      { timeout: 30 * 60_000, onLigne: suivre },
    );

    etapes.push({
      id: "python",
      ok: true,
      message: tf("{0} bibliothèques Python installées dans l'atelier.", PAQUETS_PYTHON.length),
    });
  } catch (err) {
    etapes.push({
      id: "python",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  /* -------------------------------- Node ------------------------------------- */
  try {
    let npm = await trouverNpm();
    if (!npm) {
      onProgres({ phase: "node", message: t("Installation de Node (nodejs.org, empreinte vérifiée)..."), percent: 70 });
      npm = await assurerNodePrive();
    }

    onProgres({ phase: "node", message: t("Préparation de l'espace Node isolé..."), percent: 72 });
    await mkdir(dossierNode(), { recursive: true });

    /*
     * Un manifeste ancre npm ici. Sans lui, npm remonte l'arbre des dossiers à
     * la recherche d'un `package.json` et pourrait s'installer dans un projet
     * de l'utilisateur : exactement ce que l'isolement doit empêcher.
     *
     * Avec lui, le fichier de verrouillage de npm (atelier-paquets.json, refait
     * par `node scripts/atelier-empreintes.mjs`) : les six bibliothèques à leur
     * version exacte, et chacune de leurs dépendances avec son empreinte.
     * `npm ci` n'installe que ce fichier, et refuse une archive dont
     * l'empreinte diffère ; `--ignore-scripts` : aucun script d'installation
     * d'un paquet ne tourne (audit du 27/09/2026 ; avant, `npm install` des six
     * noms, à leur dernière version, scripts compris).
     */
    await writeFile(
      join(dossierNode(), "package.json"),
      JSON.stringify(
        {
          name: "helix-atelier",
          version: "1.0.0",
          private: true,
          description: "Bibliothèques bureautiques isolées de l'atelier Cowork.",
          dependencies: paquetsFiges.node.dependances,
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(join(dossierNode(), "package-lock.json"), JSON.stringify(paquetsFiges.node.verrou, null, 2), "utf8");

    let vues = 0;
    await lancer(
      npm,
      [
        "ci",
        "--prefix",
        dossierNode(),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        /*
         * Sans cela, npm rapatrie les dépendances facultatives des paquets
         * demandés — dont @napi-rs/canvas, une trentaine de mégaoctets de
         * binaires natifs pour dessiner des pages de PDF. Nous ne lisons que
         * leur texte : c'est du poids sans usage, et c'est précisément ce
         * qu'on a choisi de ne pas installer.
         */
        "--omit=optional",
        "--loglevel",
        "http",
      ],
      {
        timeout: 20 * 60_000,
        onLigne: (ligne) => {
          if (!/^npm (http|warn|notice)/i.test(ligne)) return;
          vues += 1;
          onProgres({
            phase: "node",
            message: t("Installation des bibliothèques Node..."),
            percent: Math.min(96, 74 + vues * 0.6),
            detail: ligne.slice(0, 120),
          });
        },
      },
    );

    etapes.push({
      id: "node",
      ok: true,
      message: tf("{0} bibliothèques Node installées dans l'atelier.", PAQUETS_NODE.length),
    });
  } catch (err) {
    etapes.push({
      id: "node",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  onProgres({ phase: "termine", message: t("Vérification de l'installation..."), percent: 98 });
  const apres = await diagnostic();
  const ok = etapes.every((e) => e.ok) && apres.pret;

  onProgres({
    phase: ok ? "termine" : "erreur",
    message: ok
      ? "L'atelier est prêt."
      : "L'atelier n'est pas complet. Le détail figure dans le bilan.",
    percent: 100,
  });

  return { ok, duree: Date.now() - debut, etapes, diagnostic: apres };
}

/* ------------------------------- vérification --------------------------------- */

export interface Epreuve {
  id: string;
  libelle: string;
  ok: boolean;
  detail: string;
}

export interface Verification {
  ok: boolean;
  message: string;
  epreuves: Epreuve[];
}

/**
 * Épreuves Python. Le script est une constante de ce module : rien n'y est
 * interpolé, et il est écrit dans un dossier temporaire puis exécuté par
 * l'interpréteur du venv avec un tableau d'arguments.
 *
 * Chaque épreuve écrit un fichier puis le relit : produire sans savoir relire
 * ne prouverait qu'une moitié du chemin.
 */
const SCRIPT_PYTHON = String.raw`
import json, os, sys

dossier = os.path.dirname(os.path.abspath(__file__))
resultats = []


def epreuve(ident, libelle, fonction):
    try:
        resultats.append({"id": ident, "libelle": libelle, "ok": True, "detail": fonction()})
    except Exception as err:
        resultats.append(
            {"id": ident, "libelle": libelle, "ok": False, "detail": "%s : %s" % (type(err).__name__, err)}
        )


def docx():
    from docx import Document

    chemin = os.path.join(dossier, "essai.docx")
    document = Document()
    document.add_heading("Essai de l'atelier", level=1)
    document.add_paragraph("Ligne de controle.")
    document.save(chemin)

    relu = [p.text for p in Document(chemin).paragraphs]
    assert "Ligne de controle." in relu, "le texte ecrit n'a pas ete relu"
    return "document Word cree puis relu"


def xlsx():
    from openpyxl import Workbook, load_workbook

    chemin = os.path.join(dossier, "essai.xlsx")
    classeur = Workbook()
    feuille = classeur.active
    feuille["A1"] = 2
    feuille["A2"] = 40
    feuille["A3"] = "=SUM(A1:A2)"
    classeur.save(chemin)

    relue = load_workbook(chemin).active
    assert relue["A1"].value == 2, "valeur non relue"
    assert relue["A3"].value == "=SUM(A1:A2)", "formule non conservee"
    return "classeur Excel cree avec formule puis relu"


def pptx():
    from pptx import Presentation

    chemin = os.path.join(dossier, "essai.pptx")
    presentation = Presentation()
    diapositive = presentation.slides.add_slide(presentation.slide_layouts[5])
    diapositive.shapes.title.text = "Diapositive d'essai"
    presentation.save(chemin)

    titres = [s.shapes.title.text for s in Presentation(chemin).slides if s.shapes.title]
    assert "Diapositive d'essai" in titres, "le titre ecrit n'a pas ete relu"
    return "presentation PowerPoint creee puis relue"


def pdf():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from pypdf import PdfReader

    chemin = os.path.join(dossier, "essai.pdf")
    page = canvas.Canvas(chemin, pagesize=A4)
    page.drawString(72, 750, "Controle de l'atelier")
    page.showPage()
    page.save()

    texte = PdfReader(chemin).pages[0].extract_text() or ""
    assert "Controle" in texte, "le texte du PDF n'a pas ete relu"
    return "PDF cree puis relu"


def lecture_pdf():
    import pdfplumber

    chemin = os.path.join(dossier, "essai.pdf")
    with pdfplumber.open(chemin) as document:
        texte = document.pages[0].extract_text() or ""
    assert "Controle" in texte, "extraction vide"
    return "extraction de texte d'un PDF"


epreuve("docx", "Document Word", docx)
epreuve("xlsx", "Classeur Excel avec formule", xlsx)
epreuve("pptx", "Presentation PowerPoint", pptx)
epreuve("pdf", "Document PDF", pdf)
epreuve("pdf_lecture", "Extraction de texte d'un PDF", lecture_pdf)

sys.stdout.write(json.dumps(resultats))
`;

/**
 * Épreuve Node : les six bibliothèques se chargent-elles réellement ?
 * Le script est déposé dans le dossier temporaire, à côté d'un lien vers les
 * modules de l'atelier — c'est ce lien qui permet à `import` de les résoudre
 * sans toucher au NODE_PATH de la machine.
 */
const SCRIPT_NODE = String.raw`
const modules = ["docx", "pptxgenjs", "@e965/xlsx", "mammoth", "pdf-lib", "pdfjs-dist"];
const resultats = [];
for (const nom of modules) {
  try {
    await import(nom);
    resultats.push({ nom, ok: true });
  } catch (err) {
    resultats.push({ nom, ok: false, detail: String((err && err.message) || err) });
  }
}
process.stdout.write(JSON.stringify(resultats));
`;

/** Tests fonctionnels réels, dans un dossier temporaire effacé ensuite. */
export async function verifier(): Promise<Verification> {
  const python = pythonVenv();
  if (!(await existe(python, constants.X_OK))) {
    return {
      ok: false,
      message:
        t("L'atelier n'est pas encore installé : il n'y a rien à vérifier. Lancez d'abord la préparation."),
      epreuves: [],
    };
  }

  const travail = await mkdtemp(join(tmpdir(), "helix-atelier-"));
  const epreuves: Epreuve[] = [];

  try {
    const script = join(travail, "verification.py");
    await writeFile(script, SCRIPT_PYTHON, "utf8");

    try {
      const { stdout } = await exec(python, [script], {
        cwd: travail,
        timeout: 5 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      epreuves.push(...(JSON.parse(stdout) as Epreuve[]));
    } catch (err) {
      epreuves.push({
        id: "python",
        libelle: "Bibliothèques Python",
        ok: false,
        detail: err instanceof Error ? err.message.slice(0, 400) : String(err),
      });
    }

    /*
     * Node résout les noms de modules en remontant depuis le fichier exécuté.
     * Un lien symbolique vers les modules de l'atelier suffit donc à rendre
     * l'import résoluble depuis le dossier temporaire, sans variable
     * d'environnement ni copie.
     */
    if (await existe(modulesNode())) {
      try {
        // « junction » sous Windows : un lien de dossier ordinaire y demande les droits d'administration.
        await symlink(modulesNode(), join(travail, "node_modules"), process.platform === "win32" ? "junction" : "dir");
        const scriptNode = join(travail, "verification.mjs");
        await writeFile(scriptNode, SCRIPT_NODE, "utf8");

        // Un vrai Node (nodeDeLAtelier) : le binaire de la passerelle n'en est plus un dans l'application (28/09/2026).
        const node = await nodeDeLAtelier();
        if (!node) throw new Error(t("Node est introuvable sur cette machine : les bibliothèques Node ne peuvent pas être chargées."));
        const { stdout } = await exec(node, [scriptNode], {
          cwd: travail,
          timeout: 3 * 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const charges = JSON.parse(stdout) as { nom: string; ok: boolean; detail?: string }[];
        const echecs = charges.filter((m) => !m.ok);
        epreuves.push({
          id: "node",
          libelle: "Bibliothèques Node",
          ok: echecs.length === 0,
          detail:
            echecs.length === 0
              ? `${charges.length} bibliothèques chargées`
              : `Non chargées : ${echecs.map((m) => m.nom).join(", ")}`,
        });
      } catch (err) {
        epreuves.push({
          id: "node",
          libelle: "Bibliothèques Node",
          ok: false,
          detail: err instanceof Error ? err.message.slice(0, 400) : String(err),
        });
      }
    }

    const reussies = epreuves.filter((e) => e.ok).length;
    const ok = epreuves.length > 0 && reussies === epreuves.length;
    return {
      ok,
      message: ok
        ? `Tout fonctionne : ${reussies} épreuves sur ${epreuves.length}.`
        : `${reussies} épreuves réussies sur ${epreuves.length}. Le détail est ci-dessous.`,
      epreuves,
    };
  } finally {
    // Le dossier d'essai ne doit rien laisser derrière lui, même en cas
    // d'échec : c'est la contrepartie du droit d'écrire sur la machine.
    await rm(travail, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------------------- composant : dictée ------------------------------ */

/**
 * Dictée du composeur, entièrement locale.
 *
 * Le navigateur sait transcrire la voix (`SpeechRecognition`), mais dans
 * Chromium, donc dans Electron, cette interface envoie le son aux serveurs de
 * Google. Ce serait trahir en silence la promesse centrale du produit. La
 * transcription se fait donc ici, par Whisper exécuté sur la machine de
 * l'instance, via `faster-whisper` (licence MIT, poids Whisper sous licence MIT).
 *
 * C'est un composant **optionnel** de l'atelier : il n'est installé que sur
 * demande explicite, après que l'interface a annoncé ce qui sera téléchargé et
 * la place occupée. Il vit dans le **même** venv que l'atelier bureautique,
 * pour ne pas multiplier les environnements Python sur le poste.
 *
 * Deux téléchargements, et deux seulement, à l'installation :
 * - le paquet et ses dépendances, depuis PyPI, comme le reste de l'atelier ;
 * - le modèle, depuis Hugging Face, comme les modèles de LM Studio.
 * Ensuite, plus rien : la transcription tourne hors ligne (`HF_HUB_OFFLINE`)
 * et charge le modèle depuis un dossier local, jamais depuis un nom de dépôt.
 */

/*
 * Le paquet : faster-whisper 1.x (la borne haute protège l'appel de
 * `WhisperModel` et de `transcribe`, dictee.ts), figé avec ses dépendances et
 * leurs empreintes dans atelier-paquets.json (liste « dictee », résolue avec
 * celle de l'atelier : même environnement, mêmes versions communes). Sur Mac,
 * ses roues (onnxruntime, av) demandent macOS 14 ou plus récent.
 */

/**
 * Modèle retenu, choisi en **mesurant** sur un Apple M4 (10 cœurs, calcul sur
 * processeur, int8, 8 fils), pour une dictée française de 10,2 secondes, temps
 * total d'un appel compris (lancement de Python, chargement du modèle,
 * transcription) :
 *
 * | Modèle          | Poids   | Durée totale | Qualité mesurée                                  |
 * |-----------------|---------|--------------|--------------------------------------------------|
 * | tiny            | 75 Mo   | 0,7 à 1,8 s  | « un de vie » pour « un devis » : inutilisable   |
 * | base            | 141 Mo  | 1,0 s        | « de vie », « sur cycle » pour « sur site »      |
 * | **small**       | 464 Mo  | **2,2 s**    | juste, à des homophones près (Durand / durant)   |
 * | medium          | 1,4 Go  | 5,8 à 6,2 s  | juste                                            |
 * | large-v3-turbo  | 1,5 Go  | 5,1 à 5,6 s  | le meilleur, noms propres compris                |
 *
 * Mesures faites sur un Apple M4 d'entrée de gamme : **4 cœurs de performance**
 * et 16 Go.
 *
 * ── Le modèle s'adapte à la machine, comme le premier téléchargement ─────────
 * Sur ce poste, `small` est le seul modèle à la fois juste et sous le seuil
 * voulu (quelques secondes pour dix secondes de voix). Mais `large-v3-turbo`
 * est meilleur, et plus rapide que `medium` : dès qu'une
 * machine le fait tourner assez vite, c'est lui qu'il faut.
 *
 * Ce qui décide, ce n'est pas la mémoire — le plus gros pèse 1,5 Go — mais la
 * **vitesse du processeur** : faster-whisper tourne sur le processeur, pas sur
 * le processeur graphique. Sur Apple Silicon, ce sont les cœurs de performance
 * qui font le travail ; on les compte (`hw.perflevel0.physicalcpu`).
 *
 * Seuil retenu pour `large-v3-turbo` : **6 cœurs de performance**. C'est une
 * extrapolation, pas une mesure : 5,3 s sur 4 cœurs donnent environ 3,5 s sur 6
 * si le temps suit le nombre de cœurs, ce qui est à peu près vrai pour ce genre
 * de calcul. Elle s'ajoute à **24 Go de mémoire** : le modèle de conversation
 * occupe déjà la machine, et un poste de 16 Go qui charge 2,5 Go de plus
 * bascule en mémoire virtuelle (constaté sur ce projet avec les modèles de
 * langage). `medium` n'est jamais proposé : `large-v3-turbo` le bat en qualité
 * comme en vitesse.
 *
 * Vérifié avec la révision épinglée, hors ligne, sur ce poste : 5,6 s pour une
 * phrase courte, 5,9 s pour une longue. Il écrit « Durand » là où `small`
 * écrit « durant », mais reste faillible : « Moreau » est devenu « moraux ».
 * Aucun modèle de cette taille ne garantit les noms propres.
 *
 * Les révisions sont épinglées : le même dépôt ne peut pas changer de poids
 * dans notre dos entre deux installations. Précaution qui a déjà servi : le
 * dépôt que la bibliothèque associe à `large-v3-turbo`
 * (`mobiuslabsgmbh/…`) redirige aujourd'hui vers un autre propriétaire.
 */
export interface ModeleDictee {
  /** Clé courte : elle nomme aussi le dossier du modèle. */
  cle: "small" | "turbo";
  libelle: string;
  depot: string;
  revision: string;
  tailleMo: number;
  /** Cœurs de performance minimaux pour transcrire en quelques secondes. */
  minCoeursPerformance: number;
  /** Mémoire minimale, en Go, à côté du modèle de conversation. */
  minMemoireGo: number;
  pourquoi: string;
  /**
   * Les fichiers que faster-whisper rapatrie, avec leur empreinte SHA-256 à la
   * révision épinglée (oid LFS publié par Hugging Face pour `model.bin`,
   * calculée sur le fichier téléchargé pour les autres ; relevé le 27/09/2026,
   * audit de la chaîne d'approvisionnement). Vérifiés juste après le
   * téléchargement : un fichier différent fait effacer le modèle.
   */
  fichiers: { chemin: string; sha256: string }[];
}

/** Du plus capable au plus léger : le premier que la machine satisfait est retenu. */
export const CATALOGUE_DICTEE: ModeleDictee[] = [
  {
    cle: "turbo",
    libelle: "Whisper large-v3-turbo",
    depot: "dropbox-dash/faster-whisper-large-v3-turbo",
    revision: "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
    tailleMo: 1547,
    minCoeursPerformance: 6,
    minMemoireGo: 24,
    pourquoi: "le plus juste, et meilleur sur les noms propres",
    fichiers: [
      { chemin: "config.json", sha256: "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e" },
      { chemin: "model.bin", sha256: "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da" },
      { chemin: "preprocessor_config.json", sha256: "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711" },
      { chemin: "tokenizer.json", sha256: "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd" },
      { chemin: "vocabulary.json", sha256: "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1" },
    ],
  },
  {
    cle: "small",
    libelle: "Whisper small",
    depot: "Systran/faster-whisper-small",
    revision: "536b0662742c02347bc0e980a01041f333bce120",
    tailleMo: 464,
    minCoeursPerformance: 0,
    minMemoireGo: 0,
    pourquoi: "rapide et juste, noms propres parfois approximatifs",
    fichiers: [
      { chemin: "config.json", sha256: "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828" },
      { chemin: "model.bin", sha256: "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671" },
      { chemin: "tokenizer.json", sha256: "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab" },
      { chemin: "vocabulary.txt", sha256: "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913" },
    ],
  },
];

/**
 * Cœurs de performance de la machine.
 *
 * Sur Apple Silicon, le système les annonce à part des cœurs d'efficacité, bien
 * plus lents pour ce travail. Ailleurs, on prend la moitié des cœurs logiques :
 * l'hyperthreading les double sans doubler la puissance.
 */
export function coeursPerformance(): number {
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      const sortie = execFileSync("sysctl", ["-n", "hw.perflevel0.physicalcpu"], {
        encoding: "utf8",
        timeout: 2000,
      });
      const n = Number(sortie.trim());
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      /* ancien système : on retombe sur l'estimation générale */
    }
  }
  return Math.max(1, Math.floor(cpus().length / 2));
}

/** Modèle conseillé pour cette machine, et la raison, dite en clair. */
export function modeleDicteeRecommande(): { modele: ModeleDictee; raison: string } {
  const coeurs = coeursPerformance();
  const memoire = Math.round(totalmem() / 1024 ** 3);
  const modele =
    CATALOGUE_DICTEE.find((m) => coeurs >= m.minCoeursPerformance && memoire >= m.minMemoireGo) ??
    CATALOGUE_DICTEE[CATALOGUE_DICTEE.length - 1];
  return {
    modele,
    // Une phrase par nombre (28/09/2026) : le « s » collé restait tel quel en chinois (« 个性能核心s »).
    raison:
      coeurs > 1
        ? tf("{0} cœurs de performance et {1} Go de mémoire : {2}.", coeurs, memoire, modele.pourquoi)
        : tf("{0} cœur de performance et {1} Go de mémoire : {2}.", coeurs, memoire, modele.pourquoi),
  };
}

/**
 * Paquet et dépendances (ctranslate2, onnxruntime, PyAV, numpy, tokenizers…),
 * mesurés sur un venv neuf : 55 Mo téléchargés, 205 Mo une fois installés.
 */
const DICTEE_PAQUETS_TELECHARGES_MO = 55;
const DICTEE_PAQUETS_INSTALLES_MO = 205;

const dossierDictee = () => join(racine(), "dictee");

/** Dossier du modèle : `WhisperModel` le reçoit comme chemin, jamais comme nom de dépôt. */
export const dossierDuModele = (m: ModeleDictee): string => join(dossierDictee(), `modele-${m.cle}`);

/**
 * Modèle réellement installé, lu dans le témoin d'installation.
 *
 * La transcription utilise ce qui est **installé**, pas ce qui serait conseillé
 * aujourd'hui : une machine dont on a augmenté la mémoire ne doit pas se mettre
 * à chercher un modèle qu'elle n'a jamais téléchargé. `small` garde le dossier
 * `modele-small` : les installations existantes restent valables.
 */
export function modeleDicteeInstalle(): ModeleDictee | null {
  try {
    const temoin = JSON.parse(readFileSync(join(dossierDictee(), "pret.json"), "utf8")) as {
      modele?: string;
    };
    return CATALOGUE_DICTEE.find((m) => m.depot === temoin.modele) ?? null;
  } catch {
    return null;
  }
}

/** Le modèle en jeu : l'installé s'il existe, sinon celui qu'on installerait ici. */
export function modeleDicteeCourant(): ModeleDictee {
  return modeleDicteeInstalle() ?? modeleDicteeRecommande().modele;
}

export const dossierModeleDictee = (): string => dossierDuModele(modeleDicteeCourant());

/** Posé seulement après un essai de transcription hors ligne réussi. */
const temoinDictee = () => join(dossierDictee(), "pret.json");

/**
 * Environnement des processus Python de la dictée, après installation.
 *
 * Réduit au strict nécessaire plutôt qu'hérité : la passerelle n'a aucune
 * raison de confier ses propres variables à un interpréteur. `HF_HUB_OFFLINE`
 * interdit toute requête vers Hugging Face ; `HF_HOME` garde son éventuel cache
 * sous le dossier de Helix plutôt que dans celui de l'utilisateur.
 */
export function environnementHorsLigne(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv =
    process.platform === "win32"
      ? { ...process.env }
      : {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? homedir(),
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        };
  return {
    ...base,
    HF_HOME: join(dossierDictee(), "hf"),
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
  };
}

export interface DiagnosticDictee {
  /** Prête à transcrire : paquet, modèle, et essai hors ligne réussi. */
  installee: boolean;
  paquetInstalle: boolean;
  modeleInstalle: boolean;
  /** Nom du modèle, en clair. */
  modele: string;
  /** Pourquoi ce modèle sur cette machine : l'interface le dit avant d'installer. */
  raison: string;
  /** D'où vient le modèle : l'interface le dit avant d'installer. */
  source: string;
  installable: boolean;
  obstacles: string[];
  /** Ce qui reste à télécharger, en mégaoctets. */
  telechargementMo: number;
  /** Place occupée sur le disque une fois installé, en mégaoctets. */
  placeMo: number;
  dossier: string;
  /** Une installation (atelier ou dictée) occupe déjà le venv. */
  installationEnCours: boolean;
}

/** Inspection en lecture seule, assez rapide pour être appelée à l'ouverture du composeur. */
export async function diagnosticDictee(): Promise<DiagnosticDictee> {
  const installe = modeleDicteeInstalle();
  const conseil = modeleDicteeRecommande();
  const courant = installe ?? conseil.modele;
  const venv = await existe(pythonVenv(), constants.X_OK);
  const paquet = venv && modulePresent("faster_whisper");
  const modele = await existe(join(dossierModeleDictee(), "model.bin"));
  const temoin = await existe(temoinDictee());

  const obstacles: string[] = [];
  // Le venv existant suffit : c'est lui qui servira, pas le Python du système.
  if (!venv && !(await pythonPourVenv(false)) && pythonPriveInstallable() !== null) {
    const pythonSysteme = await trouverPython();
    obstacles.push(
      !pythonSysteme
        ? tf("Python 3 est absent de cette machine. C'est lui qui fait tourner la transcription. Installez Python 3 ({0}), puis réessayez.", commentPython())
        : obstacleVenv(),
    );
  }

  return {
    installee: venv && paquet && modele && temoin,
    paquetInstalle: paquet,
    modeleInstalle: modele,
    modele: courant.libelle,
    raison: installe
      ? `Installé sur cette machine.`
      : conseil.raison,
    source: `Hugging Face, dépôt ${courant.depot}`,
    installable: obstacles.length === 0,
    obstacles,
    telechargementMo:
      (paquet ? 0 : DICTEE_PAQUETS_TELECHARGES_MO) + (modele ? 0 : courant.tailleMo) + (!venv && !(await pythonPourVenv(false)) ? taillePythonPriveMo() : 0),
    placeMo: (paquet ? 0 : DICTEE_PAQUETS_INSTALLES_MO) + (modele ? 0 : courant.tailleMo),
    dossier: dossierDictee(),
    installationEnCours: enCours !== null,
  };
}

export interface ProgresDictee {
  phase: "verification" | "python" | "modele" | "essai" | "termine";
  message: string;
  percent: number;
  detail?: string;
}

export interface BilanDictee {
  ok: boolean;
  duree: number;
  message: string;
  diagnostic: DiagnosticDictee;
}

/**
 * Téléchargement du modèle. Constante du module, rien n'y est interpolé : le
 * dépôt, le dossier et la révision arrivent en arguments, et ce sont eux aussi
 * des constantes de ce module.
 */
const SCRIPT_TELECHARGEMENT_DICTEE = String.raw`
import sys
from faster_whisper.utils import download_model
download_model(sys.argv[1], output_dir=sys.argv[2], revision=sys.argv[3])
`;

/**
 * Essai après installation, **hors ligne** : charger le modèle depuis son
 * dossier et transcrire une seconde de silence. S'il réussit sous
 * `HF_HUB_OFFLINE`, la transcription n'aura jamais besoin du réseau.
 */
const SCRIPT_ESSAI_DICTEE = String.raw`
import json, sys
import numpy
from faster_whisper import WhisperModel
modele = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", local_files_only=True)
segments, _ = modele.transcribe(numpy.zeros(16000, dtype=numpy.float32), language="fr", vad_filter=True)
list(segments)
sys.stdout.write("@@HELIX@@" + json.dumps({"ok": True}))
`;
import { lister, t, tf } from "./langue.ts";

/** Empreinte SHA-256 d'un fichier, lu par morceaux (un modèle pèse plus d'un Go). */
async function sha256Fichier(chemin: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  await new Promise<void>((ok, ko) => createReadStream(chemin).on("data", (d) => h.update(d)).on("end", () => ok()).on("error", ko));
  return h.digest("hex");
}

/** Taille d'un dossier, sous-dossiers compris. Sert à suivre un téléchargement muet. */
async function tailleDossier(dossier: string): Promise<number> {
  try {
    const entrees = await readdir(dossier, { recursive: true, withFileTypes: true });
    let total = 0;
    for (const entree of entrees) {
      if (!entree.isFile()) continue;
      const parent = (entree as { parentPath?: string; path?: string }).parentPath ?? dossier;
      total += await stat(join(parent, entree.name))
        .then((s) => s.size)
        .catch(() => 0);
    }
    return total;
  } catch {
    return 0;
  }
}

/** Installe la dictée. Refuse si une autre installation occupe le venv. */
export function preparerDictee(onProgres: (p: ProgresDictee) => void): Promise<BilanDictee> {
  return exclusif(() => executerDictee(onProgres));
}

async function executerDictee(onProgres: (p: ProgresDictee) => void): Promise<BilanDictee> {
  const debut = Date.now();
  onProgres({ phase: "verification", message: t("Vérification des prérequis..."), percent: 2 });

  const avant = await diagnosticDictee();
  if (!avant.installable) throw new Error(avant.obstacles.join(" "));

  await mkdir(dossierDictee(), { recursive: true });
  // Une réparation repart d'un état « non prêt » : le témoin ne revient qu'après l'essai.
  await rm(temoinDictee(), { force: true });

  /* ------------------------------ venv ---------------------------------------- */
  if (!avant.paquetInstalle) await retirerVenvImprevu();
  if (!(await existe(pythonVenv(), constants.X_OK))) {
    const python = await pythonPourVenv(true, (p) => onProgres({ phase: "python", message: tf("Installation de Python ({0} %)...", p), percent: 2 }));
    if (!python) throw new Error(t("Python 3 est introuvable."));
    onProgres({ phase: "python", message: t("Création de l'environnement Python isolé..."), percent: 5 });
    await lancer(python, ["-m", "venv", dossierPython()], { timeout: 5 * 60_000 });
  }

  /* ------------------------------ paquet -------------------------------------- */
  if (!avant.paquetInstalle) {
    let lignes = 0;
    onProgres({ phase: "python", message: t("Installation du moteur de transcription..."), percent: 8 });
    await lancer(
      pipVenv(),
      ["install", "--no-input", "--disable-pip-version-check", ...OPTIONS_PIP_FIGEES, "-r", await exigencesFigees("dictee")],
      {
        timeout: 20 * 60_000,
        onLigne: (ligne) => {
          if (!/^(Collecting|Downloading|Using cached|Installing)/.test(ligne)) return;
          lignes += 1;
          onProgres({
            phase: "python",
            message: t("Installation du moteur de transcription..."),
            percent: Math.min(38, 8 + lignes * 1.2),
            detail: ligne.slice(0, 120),
          });
        },
      },
    );
  }

  /* ------------------------------ modèle -------------------------------------- */
  /*
   * Le modèle est fixé ici, une fois : le témoin vient d'être retiré, donc
   * c'est le modèle conseillé pour cette machine qui s'installe. Le relire
   * plus loin pourrait donner une autre réponse au milieu de l'opération.
   */
  const choisi = modeleDicteeRecommande().modele;
  const dossierChoisi = dossierDuModele(choisi);
  if (!(await existe(join(dossierChoisi, "model.bin")))) {
    const attendu = choisi.tailleMo * 1024 * 1024;
    const message = `Téléchargement du modèle ${choisi.libelle} (${choisi.tailleMo} Mo)...`;
    onProgres({ phase: "modele", message, percent: 40 });

    /*
     * Le téléchargeur n'affiche rien quand il n'a pas de terminal. On suit
     * donc la taille du dossier, fichiers partiels compris : c'est une mesure,
     * pas une estimation.
     */
    const suivi = setInterval(() => {
      void tailleDossier(dossierChoisi).then((octets) => {
        const part = Math.min(1, octets / attendu);
        onProgres({
          phase: "modele",
          message,
          percent: Math.round(40 + part * 50),
          detail: tf("{0} Mo sur {1} Mo", Math.round(octets / (1024 * 1024)), choisi.tailleMo),
        });
      });
    }, 1000);

    try {
      await lancer(
        pythonVenv(),
        [
          "-I",
          "-c",
          SCRIPT_TELECHARGEMENT_DICTEE,
          choisi.depot,
          dossierChoisi,
          choisi.revision,
        ],
        {
          timeout: 60 * 60_000,
          env: {
            HF_HOME: join(dossierDictee(), "hf"),
            HF_HUB_DISABLE_TELEMETRY: "1",
            HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
            /*
             * Téléchargement HTTP classique plutôt que par blocs Xet : ce
             * dernier garde un cache de blocs qui doublerait la place occupée
             * par un modèle de 464 Mo.
             */
            HF_HUB_DISABLE_XET: "1",
          },
        },
      );
    } finally {
      clearInterval(suivi);
    }
  }

  /*
   * Chaque fichier du modèle contre son empreinte écrite plus haut, avant tout
   * usage, qu'il vienne d'être téléchargé ou qu'il ait été laissé là par une
   * installation précédente : `model.bin` doit être là, les autres, s'ils y
   * sont, doivent être ceux de la révision épinglée. Sinon le modèle est effacé.
   */
  onProgres({ phase: "modele", message: t("Vérification du modèle..."), percent: 91 });
  const differents: string[] = [];
  for (const f of choisi.fichiers) {
    const chemin = join(dossierChoisi, f.chemin);
    if (!(await existe(chemin))) {
      if (f.chemin === "model.bin") differents.push(f.chemin);
      continue;
    }
    if ((await sha256Fichier(chemin)) !== f.sha256) differents.push(f.chemin);
  }
  if (differents.length) {
    await rm(dossierChoisi, { recursive: true, force: true });
    throw new Error(tf("Le modèle téléchargé ne correspond pas à la version attendue ({0}) : il a été effacé. Réessayez.", lister(differents)));
  }

  /* ------------------------------ essai --------------------------------------- */
  onProgres({ phase: "essai", message: t("Essai de transcription hors ligne..."), percent: 93 });
  const { stdout } = await exec(
    pythonVenv(),
    ["-I", "-c", SCRIPT_ESSAI_DICTEE, dossierChoisi],
    { timeout: 3 * 60_000, maxBuffer: 1024 * 1024, env: environnementHorsLigne() },
  );
  if (!stdout.includes("@@HELIX@@")) {
    throw new Error(t("L'essai de transcription n'a rien rendu. La dictée n'est pas prête."));
  }

  await writeFile(
    temoinDictee(),
    JSON.stringify(
      {
        modele: choisi.depot,
        revision: choisi.revision,
        installeLe: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  const apres = await diagnosticDictee();
  onProgres({ phase: "termine", message: t("La dictée est prête."), percent: 100 });
  return {
    ok: apres.installee,
    duree: Date.now() - debut,
    message: apres.installee
      ? "La dictée est prête. Votre voix sera transcrite sans quitter l'instance."
      : "La dictée n'est pas complète après installation.",
    diagnostic: apres,
  };
}
