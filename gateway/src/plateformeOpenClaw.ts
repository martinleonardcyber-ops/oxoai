import { posix, win32 } from "node:path";
import { t, tf } from "./langue.ts";
import { nomProduit } from "./marque.ts";

/**
 * Ce qui change d'un système à l'autre pour l'OpenClaw de OxoAI : l'archive
 * de Node, la disposition des fichiers qu'elle pose, la façon de lancer
 * OpenClaw, le PATH, l'arrêt d'un arbre de processus.
 *
 * Pourquoi un module à part (28/09/2026) : sous Windows, OxoAI refusait
 * OpenClaw (« OpenClaw demande WSL »). La documentation d'OpenClaw, relue ce
 * jour-là (docs.openclaw.ai/platforms/windows), dit le contraire : « OpenClaw
 * ships a native Windows Hub companion app plus Windows CLI support », WSL2
 * seulement recommandé. Installer WSL pour la personne n'était pas possible
 * (droits d'administrateur, redémarrage) : OxoAI pose donc un OpenClaw natif,
 * comme sur macOS et Linux. Aucune de ces fonctions ne lit `process.platform` :
 * le système leur est passé, pour qu'un Mac puisse les essayer telles que
 * Windows les verra (scripts/essai-openclaw-windows.mjs, avec `path.win32`).
 *
 * Ce qu'on sait de Windows natif, lu dans le paquet `openclaw@2026.9.4`
 * (28/09/2026), et qui décide de ce qui suit :
 *  - le lanceur est `openclaw.mjs` (champ `bin`), lancé par Node. npm pose à
 *    côté un `openclaw.cmd`, qu'on ne lance pas : Node refuse d'exécuter un
 *    `.cmd` sans passer par `cmd.exe` (CVE-2024-27980), et `cmd.exe` couperait
 *    les chemins qui ont des espaces ou des accents. OxoAI lance donc
 *    `node.exe openclaw.mjs …` lui-même, sans interpréteur de commandes ;
 *  - ses commandes (`exec`, palier Libre) passent par PowerShell sous Windows
 *    (`getShellConfig` : PowerShell 7 s'il est là, sinon Windows PowerShell
 *    5.1), pas par un shell Unix ;
 *  - ses modules natifs ont leur version Windows x64 et arm64 (koffi,
 *    node-pty) ; `sqlite-vec` n'a pas d'arm64 sous Windows, mais il ne sert
 *    qu'aux embeddings de la mémoire, que OxoAI ne règle pas (la recherche se
 *    fait par mots, partout) ;
 *  - les messageries que OxoAI propose sont en JavaScript ou en WebAssembly
 *    (Baileys et whatsapp-rust-bridge, grammY, discord.js et libopus-wasm,
 *    Bolt) : rien à compiler.
 */

export interface Machine {
  platform: NodeJS.Platform;
  arch: string;
  /** `os.release()` : la version du noyau (Darwin 22.6 pour macOS 13.5). */
  release: string;
}

/** Variables d'environnement, telles que `process.env` ou une copie. */
export type Env = Record<string, string | undefined>;

const chemins = (p: NodeJS.Platform) => (p === "win32" ? win32 : posix);
const separateur = (p: NodeJS.Platform) => (p === "win32" ? ";" : ":");

/**
 * Une variable, lue comme le système la lit : sous Windows, les noms ne
 * tiennent pas compte de la casse (`Path`, `SystemRoot`), et une copie de
 * `process.env` n'est plus qu'un objet ordinaire, qui en tient compte.
 */
export function lireVariable(env: Env, nom: string, p: NodeJS.Platform): string | undefined {
  if (p !== "win32") return env[nom];
  const bas = nom.toLowerCase();
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === bas && v !== undefined) return v;
  return undefined;
}

/** Retire une variable sous tous ses noms (sous Windows, `Path` et `PATH` sont la même). */
export function retirerVariable(env: Env, nom: string, p: NodeJS.Platform): void {
  for (const k of Object.keys(env)) if (p === "win32" ? k.toLowerCase() === nom.toLowerCase() : k === nom) delete env[k];
}

/**
 * Pose le PATH. Sous Windows, un `{ ...process.env, PATH }` gardait aussi le
 * `Path` d'origine : deux variables pour une, et le processus lancé lisait
 * l'une ou l'autre selon l'ordre du bloc d'environnement.
 */
export function poserPath(env: Env, valeur: string, p: NodeJS.Platform): Env {
  retirerVariable(env, "PATH", p);
  env.PATH = valeur;
  return env;
}

/** Des dossiers, en un PATH : `;` sous Windows, `:` ailleurs ; vides et doublons retirés. */
export function joindrePath(dossiers: (string | undefined | null)[], p: NodeJS.Platform): string {
  const vus = new Set<string>();
  const garde: string[] = [];
  for (const d of dossiers.flatMap((x) => (x ? x.split(separateur(p)) : []))) {
    const propre = d.trim();
    const cle = p === "win32" ? propre.toLowerCase() : propre;
    if (!propre || vus.has(cle)) continue;
    vus.add(cle);
    garde.push(propre);
  }
  return garde.join(separateur(p));
}

/** Le dossier du système (`C:\Windows`), tel que Windows le déclare. */
const racineWindows = (env: Env) => lireVariable(env, "SystemRoot", "win32") ?? lireVariable(env, "windir", "win32") ?? "C:\\Windows";

/**
 * Le PATH minimal du système : ce qu'un npm ou un OpenClaw lancé avec un
 * environnement réduit doit encore trouver. Sous Windows, `System32` (où
 * sont `cmd.exe`, qui fait tourner les scripts d'installation de npm, et
 * `taskkill.exe`) et Windows PowerShell (les commandes d'un employé Libre).
 */
export function pathSysteme(p: NodeJS.Platform, env: Env): string {
  if (p !== "win32") return "/usr/bin:/bin:/usr/sbin:/sbin";
  const w = win32;
  const r = racineWindows(env);
  return joindrePath([w.join(r, "System32"), r, w.join(r, "System32", "Wbem"), w.join(r, "System32", "WindowsPowerShell", "v1.0")], "win32");
}

/**
 * Ne garde que les variables nommées (et celles qui commencent par l'un des
 * préfixes). Sous Windows, sans tenir compte de la casse : `ComSpec`,
 * `SYSTEMROOT` ou `Temp` varient d'une machine à l'autre, et une variable
 * écartée pour une majuscule empêchait un processus de démarrer.
 */
export function garderVariables(source: Env, noms: readonly string[], prefixes: readonly string[], p: NodeJS.Platform): Env {
  const env: Env = {};
  const plier = (s: string) => (p === "win32" ? s.toLowerCase() : s);
  const admis = new Set(noms.map(plier));
  const prefixesPlies = prefixes.map(plier);
  for (const [nom, valeur] of Object.entries(source)) {
    if (valeur === undefined) continue;
    const n = plier(nom);
    if (admis.has(n) || prefixesPlies.some((x) => n.startsWith(x))) env[nom] = valeur;
  }
  return env;
}

/* ---- Archive officielle de Node ---------------------------------------- */

export type ArchiveNode = { dossier: string; cleIndex: string; extension: ".tar.gz" | ".zip" };

/**
 * L'archive de Node pour cette machine, ou la raison pour laquelle il n'y en
 * a pas. La même pour OpenClaw et pour l'atelier : depuis le 28/09/2026,
 * OpenClaw s'installe aussi sous Windows (x64 et arm64), avec l'archive
 * `.zip` officielle.
 */
export function archiveNode(m: Machine): ArchiveNode | { erreur: string } {
  const a = m.arch === "arm64" ? "arm64" : m.arch === "x64" ? "x64" : null;
  if (!a) return { erreur: tf("Processeur non pris en charge ({0}).", m.arch) };
  if (m.platform === "win32") return { dossier: `win-${a}`, cleIndex: `win-${a}-zip`, extension: ".zip" };
  if (m.platform === "darwin") {
    // Node 24 exige macOS 13.5 ou plus récent (Darwin 22.6).
    const [maj = 0, min = 0] = m.release.split(".").map(Number);
    if (maj < 22 || (maj === 22 && min < 6)) {
      return { erreur: t("OpenClaw demande macOS 13.5 ou plus récent sur cette machine.") };
    }
    return { dossier: `darwin-${a}`, cleIndex: `osx-${a}-tar`, extension: ".tar.gz" };
  }
  if (m.platform === "linux") return { dossier: `linux-${a}`, cleIndex: `linux-${a}`, extension: ".tar.gz" };
  return { erreur: t("L'installation automatique d'OpenClaw existe pour macOS, Windows et Linux, pas pour ce système.") };
}

/**
 * L'extraction de l'archive : le `tar` du système. Sous Windows, celui de
 * Windows (`System32\tar.exe`, bsdtar, livré depuis Windows 10 1803), qui
 * ouvre aussi les `.zip` ; celui de Git, s'il passe avant dans le PATH, ne
 * sait pas lire `C:`.
 */
export function commandeExtraction(archive: string, destination: string, extension: ArchiveNode["extension"], p: NodeJS.Platform, env: Env): { fichier: string; args: string[] } {
  const tar = p === "win32" ? win32.join(racineWindows(env), "System32", "tar.exe") : "/usr/bin/tar";
  return { fichier: tar, args: [extension === ".zip" ? "-xf" : "-xzf", archive, "-C", destination] };
}

/* ---- Ce que l'archive pose ----------------------------------------------- */

export interface DispositionNode {
  /** L'exécutable de Node. */
  node: string;
  /** Le script de npm, lancé par ce Node (jamais `npm.cmd` ni `bin/npm`, qui passe par `env node`). */
  npmCli: string;
  npxCli: string;
  /** Le dossier à mettre en tête du PATH pour que les programmes lancés trouvent `node`. */
  dossierBin: string;
  /** Les paquets installés en global par ce npm (`-g --prefix <dossier>`). */
  paquets: string;
  /** Le lanceur que npm pose pour la commande `openclaw`. */
  lanceurOpenClaw: string;
}

/**
 * Disposition d'un Node officiel dans `dossier`, qui sert aussi de préfixe
 * global à son npm. Windows : tout à la racine (`node.exe`, `openclaw.cmd`,
 * `node_modules\`) ; ailleurs, `bin/` et `lib/node_modules/`. Relevé dans
 * l'archive `node-v24.21.0-win-x64.zip` le 28/09/2026 (son `.npmrc` intégré
 * est vide : aucun préfixe imposé, npm prend le dossier de `node.exe`).
 */
export function dispositionNode(dossier: string, p: NodeJS.Platform): DispositionNode {
  const c = chemins(p);
  if (p === "win32") {
    const paquets = c.join(dossier, "node_modules");
    return {
      node: c.join(dossier, "node.exe"),
      npmCli: c.join(paquets, "npm", "bin", "npm-cli.js"),
      npxCli: c.join(paquets, "npm", "bin", "npx-cli.js"),
      dossierBin: dossier,
      paquets,
      lanceurOpenClaw: c.join(dossier, "openclaw.cmd"),
    };
  }
  const paquets = c.join(dossier, "lib", "node_modules");
  return {
    node: c.join(dossier, "bin", "node"),
    npmCli: c.join(paquets, "npm", "bin", "npm-cli.js"),
    npxCli: c.join(paquets, "npm", "bin", "npx-cli.js"),
    dossierBin: c.join(dossier, "bin"),
    paquets,
    lanceurOpenClaw: c.join(dossier, "bin", "openclaw"),
  };
}

/**
 * L'environnement de l'installation par npm : celui de la passerelle, moins
 * ce qui la regarde (`OXOAI_*`, `ELECTRON_*`) et ce qui réglerait npm à notre
 * insu (`npm_config_prefix`, un registre…), sans tenir compte de la casse
 * (npm lit `NPM_CONFIG_PREFIX` comme `npm_config_prefix`). PATH : le Node
 * privé, puis le minimum du système.
 */
export function envInstallation(source: Env, dossierBin: string, p: NodeJS.Platform): Env {
  const env: Env = { ...source };
  for (const k of Object.keys(env)) if (/^(oxoai_|electron_|npm_)/i.test(k)) delete env[k];
  return poserPath(env, joindrePath([dossierBin, pathSysteme(p, source)], p), p);
}

/**
 * Les arguments de `npm install` pour OpenClaw : préfixe explicite, pour
 * qu'aucun `.npmrc` de la personne ne l'envoie ailleurs, et aucun script
 * d'installation (`--ignore-scripts`) : ceux d'OpenClaw lui-même sont lancés
 * ensuite par OxoAI (`scriptsOpenClaw`), par Node, sans interpréteur.
 *
 * Pourquoi plus `--allow-scripts=openclaw` (29/09/2026) : on le croyait
 * suffisant pour ne laisser tourner que les scripts d'OpenClaw. Le journal de
 * npm 11.19.0 (celui du Node 24.21.0 épinglé), relevé sur le Windows de
 * GitHub, dit autre chose : « 4 packages have install scripts not yet
 * covered by allowScripts », et ceux de `@google/genai`, `koffi`,
 * `tree-sitter-bash` et `protobufjs` ont tourné quand même, par `cmd.exe`.
 * En npm 11.19, un paquet non approuvé n'est qu'un avertissement
 * (`strict-allow-scripts`, éteint d'office, en ferait une erreur, et aucune
 * option de la ligne de commande ne sait refuser un paquet). Ces quatre
 * scripts ne servent à rien quand le binaire précompilé se charge (vérifié :
 * chaque module natif a le sien pour Windows x64 et arm64) ; quand il ne se
 * charge pas, ceux de `koffi` et `tree-sitter-bash` se rabattent sur une
 * compilation, qui échoue sur un poste sans outils : c'est l'une des voies
 * vers le « npm a échoué (code 1) » vu par Medhi.
 */
export function argumentsInstallation(version: string, prefixe: string, options: { avant?: string }): string[] {
  const args = ["install", "-g", "--prefix", prefixe, `openclaw@${version}`, "--no-fund", "--no-audit", "--loglevel=error", "--ignore-scripts"];
  if (options.avant) args.push(`--before=${options.avant}`);
  return args;
}

/** Un script d'installation d'OpenClaw, tel que OxoAI le lance : `node <fichier>`, dans le dossier du paquet. */
export interface ScriptOpenClaw {
  etape: "preinstall" | "install" | "postinstall";
  fichier: string;
}

/**
 * Les scripts d'installation qu'OpenClaw déclare (`package.json`), dans
 * l'ordre où npm les aurait lancés, à lancer par le Node privé après
 * `npm install --ignore-scripts`. OpenClaw 2026.9.4 en a deux : `preinstall`
 * (`node scripts/preinstall-package-manager-warning.mjs` : vérifie la version
 * de Node, retire la sentinelle d'une ancienne version) et `postinstall`
 * (`node scripts/postinstall-bundled-plugins.mjs` : range `dist`, puis retire
 * la marque « installation en cours » sans laquelle OpenClaw se sait
 * inachevé). Lu dans le paquet le 29/09/2026.
 *
 * Seule la forme `node <chemin relatif .mjs/.js/.cjs>` est acceptée, et le
 * chemin doit rester dans le paquet : tout autre script (une commande pour
 * un interpréteur, un `&&`, un chemin qui sort) est refusé avec sa raison
 * plutôt que confié à `cmd.exe` ou à `sh`.
 */
export function scriptsOpenClaw(manifeste: unknown, dossierPaquet: string, p: NodeJS.Platform): ScriptOpenClaw[] | { erreur: string } {
  const c = chemins(p);
  const declares = (manifeste as { scripts?: Record<string, unknown> } | null)?.scripts ?? {};
  const liste: ScriptOpenClaw[] = [];
  for (const etape of ["preinstall", "install", "postinstall"] as const) {
    const brut = declares[etape];
    if (brut === undefined) continue;
    const m = typeof brut === "string" ? /^node\s+([\w@./-]+\.[cm]?js)$/.exec(brut.trim()) : null;
    const relatif = m?.[1];
    const fichier = relatif ? c.resolve(dossierPaquet, relatif) : "";
    const dedans = relatif && !relatif.split(/[\\/]/).includes("..") && !c.isAbsolute(relatif) && c.relative(dossierPaquet, fichier).split(/[\\/]/)[0] !== "..";
    if (!dedans) return { erreur: tf("OpenClaw déclare un script d'installation ({0}) que {1} ne lance pas sans interpréteur de commandes : {2}", etape, nomProduit(), String(brut).slice(0, 120)) };
    liste.push({ etape, fichier });
  }
  return liste;
}

/* ---- Trouver et lancer OpenClaw ------------------------------------------ */

/**
 * Où chercher un OpenClaw : celui imposé par le profil, celui de OxoAI, puis
 * ceux du PATH et des emplacements usuels. Sous Windows, le lanceur de npm
 * (`openclaw.cmd`) : dans le PATH, et dans le préfixe global par défaut de
 * npm (`%APPDATA%\npm`), qu'une application ouverte depuis le menu Démarrer
 * n'a pas toujours dans son PATH.
 */
export function candidatsOpenClaw(o: {
  platform: NodeJS.Platform;
  env: Env;
  maison: string;
  impose?: string;
  gere: string;
  /** Versions de Node posées par nvm (macOS, Linux). */
  versionsNvm: () => string[];
}): string[] {
  const c = chemins(o.platform);
  const liste: string[] = [];
  if (o.impose) liste.push(o.impose);
  // Celui qu'OxoAI a installé passe avant tout autre : c'est la version éprouvée.
  liste.push(o.gere);
  const dossiersPath = (lireVariable(o.env, "PATH", o.platform) ?? "")
    .split(separateur(o.platform))
    // Windows : un dossier du PATH peut être écrit entre guillemets.
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  if (o.platform === "win32") {
    for (const d of dossiersPath) liste.push(c.join(d, "openclaw.cmd"));
    const appdata = lireVariable(o.env, "APPDATA", "win32");
    if (appdata) liste.push(c.join(appdata, "npm", "openclaw.cmd"));
  } else {
    for (const d of dossiersPath) liste.push(c.join(d, "openclaw"));
    // L'application lancée depuis le Finder n'hérite pas du PATH du terminal.
    const nvm = c.join(o.maison, ".nvm", "versions", "node");
    for (const v of o.versionsNvm()) liste.push(c.join(nvm, v, "bin", "openclaw"));
    liste.push("/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw", c.join(o.maison, ".local", "bin", "openclaw"));
  }
  const vus = new Set<string>();
  return liste.filter((x) => {
    const cle = o.platform === "win32" ? x.toLowerCase() : x;
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });
}

/** Un programme dans le PATH, par son nom (Windows : avec `.exe`), hors des alias du Microsoft Store. */
export function chercherDansPath(nom: string, env: Env, p: NodeJS.Platform, existe: (f: string) => boolean): string | null {
  const c = chemins(p);
  const noms = p === "win32" && !c.extname(nom) ? [`${nom}.exe`] : [nom];
  for (const brut of (lireVariable(env, "PATH", p) ?? "").split(separateur(p))) {
    const d = brut.trim().replace(/^"(.*)"$/, "$1");
    if (!d) continue;
    // `WindowsApps\node.exe` n'est pas Node : c'est un raccourci qui ouvre le Store.
    if (p === "win32" && /[\\/]WindowsApps[\\/]?$/i.test(d)) continue;
    for (const n of noms) if (existe(c.join(d, n))) return c.join(d, n);
  }
  return null;
}

/**
 * Windows : le paquet derrière un lanceur de npm (`openclaw.cmd`, `.ps1`,
 * `.bat` ou sans extension), dans `node_modules\openclaw` à côté. Null
 * ailleurs, et pour un script : sur macOS et Linux, le paquet se trouve en
 * suivant le lien.
 */
export function paquetDerriereLanceur(bin: string, p: NodeJS.Platform): string | null {
  if (p !== "win32") return null;
  const c = chemins(p);
  return ["", ".cmd", ".bat", ".ps1"].includes(c.extname(bin).toLowerCase()) ? c.join(c.dirname(bin), "node_modules", "openclaw") : null;
}

export interface Lancement {
  /** Le programme à lancer. */
  fichier: string;
  /** Ce qui précède les arguments d'OpenClaw (sous Windows, le script `openclaw.mjs`). */
  prefixe: string[];
  /** Le Node qui fait tourner cet OpenClaw (pour lire sa version, ouvrir sa base). */
  node: string;
  /** Le dossier du paquet, quand on le connaît sans suivre de lien (Windows). */
  paquet: string | null;
}

/**
 * Comment lancer un OpenClaw trouvé à `bin`, ou `null` s'il ne se lance pas
 * d'ici.
 *
 *  - macOS, Linux : `bin` lui-même (le lien que npm pose vers `openclaw.mjs`,
 *    qui passe par `env node`) ; le Node est celui posé à côté, sinon celui du
 *    PATH.
 *  - Windows : jamais le `.cmd` (voir l'en-tête). Derrière un lanceur de npm
 *    (`openclaw.cmd`, `openclaw.ps1`, ou `openclaw` sans extension), le paquet
 *    est dans `node_modules\openclaw` à côté ; derrière un script (`.mjs`,
 *    `.js`), c'est lui. Le Node : `node.exe` à côté du lanceur (le Node privé
 *    de OxoAI, ou un Node installé sans préfixe à part), sinon celui du PATH,
 *    comme le fait le `.cmd` de npm lui-même.
 */
export function lancementOpenClaw(bin: string, p: NodeJS.Platform, existe: (f: string) => boolean, nodeDuPath: () => string | null, entree = "openclaw.mjs"): Lancement | null {
  const c = chemins(p);
  if (p !== "win32") {
    const voisin = c.join(c.dirname(bin), "node");
    return { fichier: bin, prefixe: [], node: existe(voisin) ? voisin : "node", paquet: null };
  }
  const ext = c.extname(bin).toLowerCase();
  const paquet = paquetDerriereLanceur(bin, p);
  let script: string;
  if ([".mjs", ".js", ".cjs"].includes(ext)) script = bin;
  else if (paquet) script = c.join(paquet, entree);
  else return null;
  if (!existe(script)) return null;
  const voisin = c.join(c.dirname(bin), "node.exe");
  const node = existe(voisin) ? voisin : nodeDuPath();
  if (!node) return null;
  return { fichier: node, prefixe: [script], node, paquet };
}

/**
 * Les dossiers à mettre en tête du PATH d'OpenClaw : celui de son Node (qu'il
 * relance pour ses propres sous-processus, et où il trouve npm pour ses
 * extensions), puis celui de son lanceur.
 */
export function dossiersDuLancement(bin: string, l: Lancement, p: NodeJS.Platform): string[] {
  const c = chemins(p);
  if (p !== "win32") return [c.dirname(bin)];
  return [c.isAbsolute(l.node) ? c.dirname(l.node) : null, c.dirname(bin)].filter((d): d is string => Boolean(d));
}

/* ---- Processus -------------------------------------------------------------- */

/**
 * Lire la ligne de commande d'un processus par son numéro, pour ne jamais
 * arrêter un programme qu'on n'a pas lancé (un numéro se réutilise).
 *
 * Windows n'a pas de `ps` : PowerShell (CIM, `Win32_Process`), présent sur
 * toute machine Windows 10 et 11. `wmic`, l'ancienne voie, est retiré de
 * Windows 11 24H2. Le script passe encodé (`-EncodedCommand`, UTF-16LE en
 * base64) : aucun guillemet à échapper, et il ne porte qu'un nombre entier.
 */
export function commandeLigneDeProcessus(pid: number, p: NodeJS.Platform, env: Env): { fichier: string; args: string[] } {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("numéro de processus invalide");
  if (p !== "win32") return { fichier: "/bin/ps", args: ["-p", String(pid), "-o", "command="] };
  const script = `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
  return {
    fichier: win32.join(racineWindows(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}

/**
 * Cette ligne de commande est-elle celle d'une passerelle OpenClaw ? macOS et
 * Linux : OpenClaw se renomme « openclaw-gateway », sa ligne ne porte plus ses
 * arguments ; Windows ne renomme pas un processus, la ligne reste
 * `node.exe …\openclaw.mjs gateway run --port …`.
 */
export function estPasserelleOpenClaw(ligne: string, p: NodeJS.Platform, port?: number): boolean {
  if (p !== "win32") return ligne.includes("openclaw");
  if (!/openclaw/i.test(ligne) || !/\bgateway\b/i.test(ligne)) return false;
  /*
   * Et sur le port de OxoAI, quand on le connaît (test d'intrusion du
   * 28/09/2026, SECURITE.md § 58) : l'OpenClaw personnel de la personne
   * (`gateway run --port 18789`) a la même ligne, et un numéro de processus
   * noté par OxoAI, puis réutilisé par lui après un redémarrage, l'aurait fait
   * arrêter. Sous Windows la ligne garde ses arguments : on peut le distinguer.
   */
  return port === undefined || new RegExp(`--port[=\\s]+"?${port}"?(\\s|$)`).test(ligne);
}

/**
 * Arrêter un processus et tout ce qu'il a lancé, sous Windows : `taskkill`
 * par son numéro (`/PID`, jamais `/IM` par le nom : ce serait tous les
 * `node.exe` de la machine, l'OpenClaw personnel compris), `/T` pour l'arbre
 * (le lanceur d'OpenClaw relance Node pour lui-même), `/F` parce qu'une
 * application console sans fenêtre n'a pas d'autre arrêt. C'est ce que fait
 * OpenClaw lui-même quand on arrête sa tâche planifiée (« terminates the
 * Gateway and its descendants »). Par son chemin dans `System32`, pas par le
 * PATH.
 */
export function commandeArretArbre(pid: number, env: Env): { fichier: string; args: string[] } {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("numéro de processus invalide");
  return { fichier: win32.join(racineWindows(env), "System32", "taskkill.exe"), args: ["/PID", String(pid), "/T", "/F"] };
}

/**
 * Ce que npm a dit, en une phrase : ses messages bruts portent des chemins de
 * la machine et un jargon qui n'apprend rien à qui installe.
 *
 * 29/09/2026 : sous Windows, Medhi ne voyait que « npm a échoué (code 1) ».
 * Quand le script d'installation d'un paquet échoue, npm écrit d'abord
 * `code 1`, `path <dossier du paquet>`, `command failed`, `command <la
 * commande>`, puis ce que le script a dit, et enfin le chemin de son journal :
 * on gardait la première ligne, la seule qui ne dit rien. On nomme maintenant
 * le paquet et la cause (la première ligne du script qui l'explique), ou ce
 * qui manque à la machine (outils de compilation, git), toujours sans
 * chemins. La sortie entière va dans le journal de la passerelle
 * (installationOpenClaw.ts, `journaliserNpm`).
 */
export function raisonNpm(sortie: string, version: string, origine: "npm" | "script" = "npm"): string {
  if (/notarget|No matching version/i.test(sortie)) return tf("la version {0} d'OpenClaw n'est pas publiée", version);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_/i.test(sortie)) {
    if (/UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_/i.test(sortie)) {
      return t("le registre npm répond avec un certificat que Node ne reconnaît pas (proxy ou antivirus qui inspecte les connexions) : autorisez registry.npmjs.org, ou demandez le certificat de votre proxy à votre service informatique");
    }
    return t("le registre npm est injoignable : vérifiez l'accès à internet de cette machine");
  }
  if (/ENOSPC/i.test(sortie)) return t("il n'y a plus assez de place sur le disque");
  // Windows : un fichier tenu par un autre programme, le plus souvent l'antivirus qui analyse ce que npm vient d'écrire.
  if (/EBUSY|EPERM[^\n]*(rename|unlink|rmdir)|operation not permitted, (rename|unlink|rmdir)/i.test(sortie)) {
    return tf("un fichier du dossier d'installation est tenu par un autre programme (souvent l'antivirus) : réessayez dans un instant, ou excluez le dossier de données de {0} de l'analyse", nomProduit());
  }
  if (/EACCES|EPERM/i.test(sortie)) return t("le dossier d'installation n'est pas accessible en écriture");
  // Windows : un chemin trop long pour l'outil qui l'ouvre.
  if (/ENAMETOOLONG/i.test(sortie)) return t("un chemin du dossier d'installation est trop long pour cette machine");

  const lignes = sortie
    .split(/\r?\n/)
    .map((l) => l.replace(/^npm (error|ERR!)\s?/i, "").trim())
    .filter(Boolean);
  // Le paquet dont le script a échoué : `path …\node_modules\<paquet>` (ou `@portée\paquet`).
  const chemin = lignes.find((l) => /^path\s/i.test(l)) ?? "";
  const paquet = /node_modules[\\/]((?:@[^\\/\s]+[\\/])?[^\\/\s]+)[\\/]?\s*$/.exec(chemin)?.[1]?.replace(/\\/g, "/");
  // Ce qu'a dit le script lui-même : les lignes après `command …` (la commande nomme parfois node-gyp sans rien compiler).
  const apres = lignes.findIndex((l) => /^command\s+(?!failed\b)/i.test(l));
  const duScript = apres >= 0 ? lignes.slice(apres + 1) : lignes;
  /*
   * Windows 11 : Smart App Control (ou une stratégie de l'entreprise, WDAC)
   * refuse de charger un module natif non signé. Le binaire précompilé ne se
   * charge pas, et le script du paquet se rabat sur une compilation, qui
   * échoue à son tour : c'est le refus qu'il faut dire, pas la compilation.
   */
  if (/Application Control policy has blocked|stratégie de contrôle d'application|a bloqué ce fichier|blocked this file/i.test(sortie)) {
    return t("Windows a refusé de charger un module d'OpenClaw (Smart App Control ou une stratégie de l'entreprise) : tant que ce contrôle le refuse, OpenClaw ne peut pas tourner sur ce poste ; voyez avec la personne qui gère ce poste");
  }
  const compilation = /gyp ERR!|node-gyp rebuild|Visual Studio|find Python|MSBuild|cl\.exe|CMake|make: /i;
  if (compilation.test(duScript.join("\n"))) {
    // Ne devrait pas arriver : chaque module natif d'OpenClaw 2026.9.4 a son binaire précompilé pour Windows x64 et arm64, et il se charge sans Visual C++ (vu sur GitHub le 29/09/2026).
    return paquet
      ? tf("le module « {0} » n'a pas pu utiliser son binaire précompilé et a voulu se compiler sur cette machine, sans outils de compilation", paquet)
      : t("un module n'a pas pu utiliser son binaire précompilé et a voulu se compiler sur cette machine, sans outils de compilation");
  }
  if (/spawn git ENOENT|'git' n'est pas reconnu|'git' is not recognized|git: (command )?not found|not found: git/i.test(sortie)) {
    return t("npm a besoin de git pour une dépendance, et git n'est pas installé sur cette machine");
  }
  const bruit = (l: string) =>
    /^(code|errno|syscall|signal)\s+\S+$|^path\s|^command( failed)?(\s|$)|^cwd\s|complete log of this run|log of this run|[\\/]_logs[\\/]|^at\s|^node:internal|^\^+$|^Node\.js v\d/i.test(l);
  /*
   * La cause : parmi ce qu'a dit le script (après `command …`), la première
   * ligne qui ressemble à une erreur, sinon la première tout court ; hors
   * script, la première ligne qui n'est pas du bruit.
   */
  const candidates = duScript.filter((l) => !bruit(l));
  const erreur = /\b(error|erreur|ERR_[A-Z_]+|E[A-Z]{3,}|cannot|failed|échou|not found|introuvable|refus|denied|unsupported)\b/i;
  const ligne = candidates.find((l) => erreur.test(l)) ?? candidates[0];
  const propre = ligne ? sansChemins(ligne).replace(/\s+/g, " ").slice(0, 200) : "";
  if (paquet && apres >= 0) {
    return propre
      ? tf("le script d'installation du paquet « {0} » a échoué ({1})", paquet, propre)
      : tf("le script d'installation du paquet « {0} » a échoué", paquet);
  }
  // Un script d'OpenClaw lancé par OxoAI (installationOpenClaw.ts) : sa sortie brute, la cause suffit.
  if (origine === "script") return propre || t("il s'est arrêté sans rien dire");
  if (propre) return tf("npm a échoué ({0})", propre);
  // Rien d'autre que le code : on le dit, la sortie entière est dans le journal (journaliserNpm).
  const code = /^code\s+(\S+)$/im.exec(lignes.join("\n"))?.[1];
  return code ? tf("npm a échoué (code {0}) sans en dire plus", code) : t("npm a échoué");
}

/**
 * Un message de npm sans les chemins de la machine : ceux d'Unix (`/Users/…`)
 * et ceux de Windows (`C:\Users\…`, `\\serveur\partage`).
 */
export function sansChemins(texte: string): string {
  /*
   * Un dossier du chemin peut contenir des espaces (`C:\Users\Jean Dupont\…`,
   * le cas ordinaire sous Windows) : on avale chaque dossier suivi d'un
   * séparateur, espaces compris, et le dernier morceau jusqu'au premier blanc
   * (29/09/2026 ; avant, « Dupont\.oxoai\… » restait à l'écran). Quitte à
   * avaler quelques mots de plus : mieux vaut perdre un mot qu'un nom. Un
   * dossier ne contient jamais `:`, ce qui arrête le chemin avant une adresse
   * (`https://registry.npmjs.org/…`, gardée).
   */
  return texte
    .replace(/\b[A-Za-z]:[\\/](?:[^\\/"'\n:<>|?*]*\\)*[^\s"'<>|?*]*/g, "…")
    .replace(/\\\\(?:[^\\/"'\n:<>|?*]*\\)*[^\s"'<>|?*]*/g, "…")
    .replace(/(^|[\s"'(=])\/(?:[^/"'\n:)]*\/)*[^\s"'):]*/g, "$1…");
}
