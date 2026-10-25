import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { t, tf } from "./langue.ts";

const exec = promisify(execFile);

/**
 * La machine de l'agent en version macOS : un Mac virtuel, sur un Mac bien
 * doté, par Lume (le moteur de machines virtuelles de cua, fondé sur la
 * virtualisation d'Apple). Même rôle que le bureau Linux de machine.ts : un
 * ordinateur à part, où l'agent clique et tape, relié à la personne par un
 * seul dossier, `~/OxoAI/Machine`.
 *
 * **Jamais éprouvée de bout en bout** (24/09/2026) : le Mac de développement a
 * 16 Go de mémoire, il en faut 32. Chaque pièce vient de la documentation et
 * du code de cua, vérifiés ce jour-là : commandes de Lume 0.5.3 (`pull`, `run
 * --detach --display none --shared-dir`, `get -f json` qui donne `status` et
 * `ipAddress`), images `trycua/macos-*-cua` (écran 1024x768, 8 Go, 4 cœurs,
 * serveur cua sur le port 8000 de la machine, comme le fait la bibliothèque
 * de cua), dossier partagé vu dans la machine sous `/Volumes/My Shared Files`.
 * Le diagnostic le dit à la personne, et conseille le bureau Linux quand il
 * est possible.
 *
 * Rien n'est pris « à la dernière version » : Lume et LibreOffice sont
 * épinglés, et leurs archives vérifiées par empreinte avant usage
 * (revérifiées le 27/09/2026 contre la publication GitHub de Lume et les
 * fichiers `.sha256` de The Document Foundation). L'image macOS, elle, n'est
 * épinglée que par son étiquette (`macos-tahoe-cua:26.5.2`, voir `imagePour`) :
 * aucune empreinte n'est écrite ici, et c'est Lume qui la télécharge du
 * registre de cua (audit de la chaîne d'approvisionnement du 27/09/2026).
 */

/* ------------------------------------------------------------------ */
/* Versions épinglées                                                  */
/* ------------------------------------------------------------------ */

const VERSION_LUME = "0.5.3";
const ARCHIVE_LUME = `https://github.com/trycua/cua/releases/download/lume-v${VERSION_LUME}/lume.tar.gz`;
/** Empreinte de l'archive, relevée le 24/09/2026 ; application signée et notarisée par Cua AI, Inc. */
const EMPREINTE_LUME = "af5d0556763a7f0116153c220aaabe44974e775091ac57e38da2abb2959c63e8";
const EQUIPE_LUME = "YCK386LBJ7";

/** Nom de la machine dans Lume. */
export const VM = "oxoai-machine-macos";
/** Port du serveur cua, dans la machine. */
const PORT_CUA = 8000;
/** Le dossier d'échange, vu de l'intérieur du Mac virtuel. */
export const ECHANGE_MACOS = "/Volumes/My Shared Files";

/*
 * LibreOffice pour la bureautique : macOS n'en fournit pas qui sache écrire
 * du Word ou de l'Excel sans intervention. Version et empreintes relevées sur
 * les archives de The Document Foundation (adresses permanentes).
 */
const VERSION_LO = "25.8.6.2";
const BASE_LO = `https://downloadarchive.documentfoundation.org/libreoffice/old/${VERSION_LO}/mac/aarch64`;
const LO = { url: `${BASE_LO}/LibreOffice_${VERSION_LO}_MacOS_aarch64.dmg`, sha: "57ddee0f8ef2d06fd7a9b0e3cf191107e6cb97ec03f0a7f6b137f732e251fde2" };
const LO_FR = { url: `${BASE_LO}/LibreOffice_${VERSION_LO}_MacOS_aarch64_langpack_fr.dmg`, sha: "d7d48d859c5f645b2a9a15ff32d9fe853788e8ebc33f9fd869272d31ad3da96f" };
/** Changer le numéro réinstalle la bureautique au prochain démarrage. */
const MARQUE_BUREAUTIQUE = "~/.oxoai-bureautique-1";

/*
 * Préréglages propres au Mac, en plus de ceux du bureau Linux (machine.ts) :
 * les boîtes d'enregistrement de LibreOffice plutôt que celles de macOS, où
 * taper un chemin complet dans le nom ne marche pas (il faut Cmd+Maj+G).
 */
const XCD_MACOS = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<oor:data xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:oor="http://openoffice.org/2001/registry">\n' +
    '<dependency file="main"/>\n' +
    '<oor:component-data oor:name="Common" oor:package="org.openoffice.Office">\n' +
    '<node oor:name="Misc"><prop oor:name="UseSystemFileDialog" oor:op="fuse"><value>false</value></prop></node>\n' +
    "</oor:component-data>\n" +
    "</oor:data>\n",
).toString("base64");

/** Mémoire donnée à la machine, dans ce que l'image prévoit déjà. */
export const MEMOIRE_MACOS_GO = 8;
/** Place à prévoir : image d'environ 23 Go, disque de la machine qui grandit à l'usage. */
export const DISQUE_MACOS_GO = 60;

const env = () => ({ ...process.env, LUME_TELEMETRY_ENABLED: "false" });
const dossierLume = () => process.env.OXOAI_LUME_DIR ?? join(homedir(), ".oxoai", "lume");
const binaireOxoAI = () => join(dossierLume(), "lume.app", "Contents", "MacOS", "lume");

/* ------------------------------------------------------------------ */
/* Ce que ce Mac peut porter                                           */
/* ------------------------------------------------------------------ */

/** Version de macOS du poste, ou null hors Mac. */
export async function versionMacos(): Promise<[number, number] | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await exec("sw_vers", ["-productVersion"], { timeout: 5000 });
    const [maj, min] = stdout.trim().split(".").map((n) => Number(n) || 0);
    return [maj ?? 0, min ?? 0];
  } catch {
    return null;
  }
}

/**
 * L'image qui convient à ce Mac. La virtualisation d'Apple ne fait pas tourner
 * un macOS plus récent que celui du poste : on prend la plus récente qui
 * reste en dessous.
 */
export function imagePour(v: [number, number] | null): string | null {
  if (!v) return null;
  const [maj, min] = v;
  if (maj > 26 || (maj === 26 && min >= 5)) return "macos-tahoe-cua:26.5.2";
  if (maj === 26) return "macos-tahoe-cua:26.2";
  if (maj === 15 && min >= 3) return "macos-sequoia-cua:15.3";
  return null;
}

/* ------------------------------------------------------------------ */
/* Lume                                                                */
/* ------------------------------------------------------------------ */

const CANDIDATS = () => [binaireOxoAI(), join(homedir(), ".local", "bin", "lume"), "/opt/homebrew/bin/lume", "/usr/local/bin/lume"];

export async function trouverLume(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  for (const c of CANDIDATS()) {
    if (!existsSync(c)) continue;
    try {
      await exec(c, ["--version"], { timeout: 10_000, env: env() });
      return c;
    } catch {
      /* suivant */
    }
  }
  return null;
}

/**
 * Installe Lume pour OxoAI, dans ~/.oxoai/lume : l'archive publiée, vérifiée
 * par empreinte, puis par sa signature (l'équipe de Cua AI). Rien n'est
 * installé ailleurs, aucun service n'est ajouté au démarrage du Mac.
 */
export async function installerLume(): Promise<string> {
  const res = await fetch(ARCHIVE_LUME, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(tf("Téléchargement de Lume impossible ({0}).", res.status));
  const archive = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== EMPREINTE_LUME) {
    throw new Error(t("L'archive de Lume ne correspond pas à la version attendue : installation refusée."));
  }
  const tmp = join(tmpdir(), `oxoai-lume-${process.pid}.tar.gz`);
  writeFileSync(tmp, archive, { mode: 0o600 });
  try {
    rmSync(join(dossierLume(), "lume.app"), { recursive: true, force: true });
    mkdirSync(dossierLume(), { recursive: true, mode: 0o700 });
    await exec("tar", ["-xzf", tmp, "-C", dossierLume()], { timeout: 60_000 });
  } finally {
    rmSync(tmp, { force: true });
  }
  const app = join(dossierLume(), "lume.app");
  await exec("codesign", ["--verify", "--strict", app], { timeout: 30_000 });
  const { stderr } = await exec("codesign", ["-dv", app], { timeout: 30_000 });
  if (!stderr.includes(`TeamIdentifier=${EQUIPE_LUME}`)) {
    rmSync(app, { recursive: true, force: true });
    throw new Error(t("Lume n'est pas signé par son éditeur : installation refusée."));
  }
  return binaireOxoAI();
}

interface InfoVm {
  status: string;
  ipAddress: string | null;
  downloadProgress: number | null;
}

async function infoVm(lume: string): Promise<InfoVm | null> {
  try {
    const { stdout } = await exec(lume, ["get", VM, "-f", "json"], { timeout: 20_000, env: env() });
    const brut = JSON.parse(stdout) as unknown;
    const d = (Array.isArray(brut) ? brut[0] : brut) as Record<string, unknown> | undefined;
    if (!d) return null;
    const ip = typeof d.ipAddress === "string" && d.ipAddress && d.ipAddress !== "0.0.0.0" ? d.ipAddress : null;
    return {
      status: String(d.status ?? ""),
      ipAddress: ip,
      downloadProgress: typeof d.downloadProgress === "number" ? d.downloadProgress : null,
    };
  } catch {
    return null;
  }
}

/** La machine macOS existe-t-elle déjà sur ce Mac ? */
export async function machineMacosPresente(): Promise<boolean> {
  const lume = await trouverLume();
  return lume ? (await infoVm(lume)) !== null : false;
}

/* ------------------------------------------------------------------ */
/* Le serveur cua de la machine                                        */
/* ------------------------------------------------------------------ */

let adresse: string | null = null;

/** Adresse du serveur cua de la machine macOS, une fois qu'elle a démarré. */
export function adresseMacos(): string | null {
  return adresse;
}

async function repond(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Une commande du shell de la machine, par cua. Même protocole que computer.ts. */
async function commande(url: string, cmd: string, delaiMs = 30_000): Promise<{ ok: boolean; stdout: string }> {
  try {
    const res = await fetch(`${url}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "run_command", params: { command: cmd } }),
      signal: AbortSignal.timeout(delaiMs),
    });
    let dernier: Record<string, unknown> | null = null;
    for (const l of (await res.text()).split("\n")) {
      if (!l.trim().startsWith("data:")) continue;
      try {
        dernier = JSON.parse(l.trim().slice(5)) as Record<string, unknown>;
      } catch {
        /* trame partielle */
      }
    }
    return { ok: res.ok && dernier?.success !== false, stdout: String(dernier?.stdout ?? "") };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Le script d'installation de la bureautique, lancé dans la machine. Chaque
 * archive est vérifiée par empreinte ; le module de langue française est un
 * bonus (s'il manque, LibreOffice reste en anglais, et fonctionne).
 */
function scriptBureautique(xcdCommun: string): string {
  return [
    "set -e",
    "cd /tmp",
    `curl -fsSL -o oxoai-lo.dmg '${LO.url}'`,
    `echo '${LO.sha}  oxoai-lo.dmg' | shasum -a 256 -c -`,
    'M=$(mktemp -d)',
    'hdiutil attach -nobrowse -readonly -mountpoint "$M" oxoai-lo.dmg',
    "rm -rf /Applications/LibreOffice.app",
    'cp -R "$M/LibreOffice.app" /Applications/',
    'hdiutil detach "$M" || true',
    "R=/Applications/LibreOffice.app/Contents/Resources/registry",
    `echo '${xcdCommun}' | base64 -D > "$R/oxoai.xcd"`,
    `echo '${XCD_MACOS}' | base64 -D > "$R/oxoai-macos.xcd"`,
    "set +e",
    `curl -fsSL -o oxoai-fr.dmg '${LO_FR.url}' && echo '${LO_FR.sha}  oxoai-fr.dmg' | shasum -a 256 -c - && {`,
    '  F=$(mktemp -d); hdiutil attach -nobrowse -readonly -mountpoint "$F" oxoai-fr.dmg',
    '  T=$(find "$F" -name tarball.tar.bz2 | head -1)',
    '  [ -n "$T" ] && tar -xjf "$T" -C /Applications/LibreOffice.app',
    '  hdiutil detach "$F"',
    "}",
    "xattr -dr com.apple.quarantine /Applications/LibreOffice.app 2>/dev/null",
    "rm -f oxoai-lo.dmg oxoai-fr.dmg",
    `touch ${MARQUE_BUREAUTIQUE}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Démarrer, arrêter, effacer                                          */
/* ------------------------------------------------------------------ */

type Avancement = (etape: string, message: string) => void;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lancer(lume: string, args: string[]): Promise<void> {
  return new Promise((ok, ko) => {
    const p = spawn(lume, args, { stdio: ["ignore", "ignore", "pipe"], env: env() });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    p.on("close", (code) => (code === 0 ? ok() : ko(new Error(err.trim().split("\n").slice(-3).join(" ") || `code ${code}`))));
    p.on("error", ko);
  });
}

export async function demarrerMacos(dossierEchange: string, xcdCommun: string, avancer: Avancement): Promise<void> {
  const image = imagePour(await versionMacos());
  if (!image) throw new Error(t("Cette version de macOS ne peut pas faire tourner la machine macOS de l'agent."));

  let lume = await trouverLume();
  if (!lume) {
    avancer("installation", t("Installation de Lume, le moteur de la machine macOS..."));
    lume = await installerLume();
  }

  if (!(await infoVm(lume))) {
    avancer("telechargement", t("Téléchargement de la machine macOS (environ 23 Go, souvent plus d'une heure)..."));
    const suivi = setInterval(() => {
      void infoVm(lume!).then((i) => {
        if (i?.downloadProgress != null) {
          avancer("telechargement", tf("Téléchargement de la machine macOS : {0} %", Math.round(i.downloadProgress * (i.downloadProgress <= 1 ? 100 : 1))));
        }
      });
    }, 5000);
    try {
      await lancer(lume, ["pull", image, VM]);
    } finally {
      clearInterval(suivi);
    }
    // L'image gardée en cache doublerait la place prise : la machine a tout ce qu'il lui faut.
    await lancer(lume, ["prune"]).catch(() => undefined);
  }

  const info = await infoVm(lume);
  if (info?.status !== "running") {
    avancer("demarrage", t("Démarrage de la machine macOS..."));
    mkdirSync(dossierEchange, { recursive: true });
    await lancer(lume, ["run", VM, "--detach", "--display", "none", "--shared-dir", `${dossierEchange}:rw`]);
  }

  avancer("attente", t("La machine macOS démarre (une à deux minutes)..."));
  let url: string | null = null;
  for (let i = 0; i < 150 && !url; i++) {
    const ip = (await infoVm(lume))?.ipAddress;
    if (ip && (await repond(`http://${ip}:${PORT_CUA}`))) url = `http://${ip}:${PORT_CUA}`;
    else await pause(2000);
  }
  if (!url) throw new Error(t("La machine macOS a démarré, mais son serveur de pilotage ne répond pas."));
  adresse = url;

  const installee = await commande(url, `test -f ${MARQUE_BUREAUTIQUE} && echo oui`);
  if (!installee.stdout.includes("oui")) {
    avancer("construction", t("Installation de la bureautique dans la machine (environ 300 Mo)..."));
    const script = Buffer.from(scriptBureautique(xcdCommun)).toString("base64");
    await commande(url, `echo '${script}' | base64 -D > /tmp/oxoai-bureautique.sh && (nohup bash /tmp/oxoai-bureautique.sh > /tmp/oxoai-bureautique.log 2>&1 &)`);
    let fini = false;
    for (let i = 0; i < 180 && !fini; i++) {
      await pause(5000);
      fini = (await commande(url, `test -f ${MARQUE_BUREAUTIQUE} && echo oui`)).stdout.includes("oui");
    }
    if (!fini) {
      const journal = (await commande(url, "tail -3 /tmp/oxoai-bureautique.log")).stdout.trim();
      throw new Error(tf("La bureautique n'a pas pu s'installer dans la machine. {0}", journal));
    }
  }
}

export async function arreterMacos(): Promise<void> {
  const lume = await trouverLume();
  adresse = null;
  if (!lume) return;
  await exec(lume, ["stop", VM], { timeout: 60_000, env: env() }).catch(() => undefined);
}

/** À la fermeture de l'instance : détaché, la passerelle n'attend pas. */
export function arreterMacosEnPartant(): void {
  for (const c of CANDIDATS()) {
    if (!existsSync(c)) continue;
    spawn(c, ["stop", VM], { detached: true, stdio: "ignore", env: env() }).unref();
    return;
  }
}

/** Efface la machine macOS et rend sa place sur le disque. */
export async function effacerMacos(): Promise<void> {
  const lume = await trouverLume();
  adresse = null;
  if (!lume) return;
  await exec(lume, ["stop", VM], { timeout: 60_000, env: env() }).catch(() => undefined);
  await exec(lume, ["delete", VM, "--force"], { timeout: 120_000, env: env() }).catch(() => undefined);
  await exec(lume, ["prune"], { timeout: 120_000, env: env() }).catch(() => undefined);
}

/**
 * Applications de la machine macOS, et la commande exacte. Liste fermée,
 * comme pour le bureau Linux : le nom venu du modèle choisit une entrée.
 */
const SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
export const APPLICATIONS_MACOS: { noms: RegExp; commande: string; libelle: string }[] = [
  { noms: /safari|firefox|navigateur|browser|web|internet|chrome/i, commande: "open -a Safari", libelle: "Safari" },
  { noms: /writer|word|texte|document|traitement/i, commande: `nohup ${SOFFICE} --writer >/dev/null 2>&1 &`, libelle: "LibreOffice Writer" },
  { noms: /calc|excel|tableur|feuille|classeur|spreadsheet/i, commande: `nohup ${SOFFICE} --calc >/dev/null 2>&1 &`, libelle: "LibreOffice Calc" },
  { noms: /impress|powerpoint|pr[ée]sentation|diapo|slides/i, commande: `nohup ${SOFFICE} --impress >/dev/null 2>&1 &`, libelle: "LibreOffice Impress" },
  { noms: /fichiers|finder|explorateur|files|dossier/i, commande: `open '${ECHANGE_MACOS}'`, libelle: "Finder" },
  { noms: /terminal|console/i, commande: "open -a Terminal", libelle: "Terminal" },
];
