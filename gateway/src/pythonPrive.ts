import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { t, tf } from "./langue.ts";
import { renommer } from "./processus.ts";

/**
 * Le Python que OxoAI pose lui-même, quand la machine n'en a pas un qui
 * convient.
 *
 * Décidé par Medhi le 27/09/2026 (« Python doit s'installer ») : exception à la
 * règle des licences (Python est sous licence PSF, permissive, hors de la liste
 * Apache/MIT), comme Unsloth avant lui (PROJET.md § 3.12). Sans lui, sur un PC
 * Windows ou un Linux minimal, la dictée, la transcription des réunions, les
 * documents Word, Excel et PowerPoint et l'entraînement restaient fermés
 * derrière « installez Python vous-même ».
 *
 * La construction autonome de CPython publiée par Astral
 * (github.com/astral-sh/python-build-standalone, celle qu'utilise `uv`) : un
 * Python complet (venv, pip, ssl) qui tient dans un dossier, sans droits
 * d'administration, sans toucher au Python du système, pour les trois
 * systèmes. Publication **épinglée** et empreintes SHA-256 **écrites ici**,
 * relevées le 27/09/2026 dans son `SHA256SUMS` et égales à celles que publie
 * GitHub pour chaque fichier. Un fichier qui n'a pas l'empreinte attendue est
 * effacé sans être ouvert.
 *
 * Tout vit dans `<données>/python-moteur`. Le retirer, c'est supprimer ce
 * dossier (les environnements de l'atelier et de l'entraînement, créés à partir
 * de lui, seraient alors à refaire).
 */

const PUBLICATION = "20260901";
const VERSION = "3.12.14";

/** Par cible : empreinte SHA-256 et taille en octets de l'archive `install_only`. */
const ARCHIVES: Record<string, { sha256: string; octets: number }> = {
  "x86_64-pc-windows-msvc": { sha256: "e90c1b6419da3bd812dd73bb3de40287a21abf153438147639ec5e20375ea93f", octets: 46_184_075 },
  "aarch64-pc-windows-msvc": { sha256: "4e852236277eb8f7105cbe0f5adf45592f521af238bc0f700c351856e2c2e41a", octets: 42_877_617 },
  "x86_64-unknown-linux-gnu": { sha256: "936c246dfdbbfa7cb22dd01814a21f582a892689fae96b06071a5e433baffa22", octets: 111_368_545 },
  "aarch64-unknown-linux-gnu": { sha256: "b61b856c3e1a4fc65b8f6e6b0495ef975dd0924f90c59f3ea61b38a079173b84", octets: 83_541_077 },
  "aarch64-apple-darwin": { sha256: "3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76", octets: 25_135_464 },
  "x86_64-apple-darwin": { sha256: "2e31b23f3f1319f707d0e620b48847a0046577541d357276821f9f1b5492e0ba", octets: 24_826_296 },
};

function cible(): string | null {
  const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null;
  if (!arch) return null;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return null;
}

/**
 * Le `tar` du système, par son chemin : sous Windows celui de Windows (celui de
 * Git ne sait pas lire `C:`), ailleurs `/usr/bin/tar` ou `/bin/tar`, pas le
 * premier `tar` venu du PATH.
 */
export function tarDuSysteme(): string {
  if (process.platform === "win32") {
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    // Livré avec Windows 10 depuis la version 1803 : avant, une erreur claire plutôt qu'un ENOENT (revue du 27/09/2026).
    if (!existsSync(tar)) throw new Error(t("Windows 10 version 1803 ou plus récent est nécessaire : l'outil tar de Windows est absent."));
    return tar;
  }
  return ["/usr/bin/tar", "/bin/tar"].find((c) => existsSync(c)) ?? "tar";
}

const racine = () => join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "python-moteur");
const dossierVersion = () => join(racine(), `${VERSION}+${PUBLICATION}`);
const executable = (dossier: string) =>
  process.platform === "win32" ? join(dossier, "python", "python.exe") : join(dossier, "python", "bin", "python3");

/** Le Python posé par OxoAI, s'il l'est. */
export function pythonPrive(): string | null {
  const exe = executable(dossierVersion());
  return existsSync(exe) ? exe : null;
}

/** OxoAI sait-il poser Python ici ? La raison sinon. */
export function pythonPriveInstallable(): string | null {
  const c = cible();
  return c && ARCHIVES[c] ? null : tf("Pas de Python autonome pour ce système ({0}, {1}).", process.platform, process.arch);
}

/** Taille du téléchargement, en mégaoctets (pour l'écran, avant d'installer). */
export function taillePythonPriveMo(): number {
  const c = cible();
  return c && ARCHIVES[c] ? Math.round(ARCHIVES[c].octets / 1e6) : 0;
}

let enCours: Promise<string> | null = null;

/**
 * Pose Python s'il ne l'est pas, et rend son exécutable. Une seule installation
 * à la fois : l'atelier, la dictée et l'entraînement peuvent le demander
 * ensemble.
 */
export function assurerPythonPrive(avancer?: (pourcent: number) => void): Promise<string> {
  const deja = pythonPrive();
  if (deja) return Promise.resolve(deja);
  if (!enCours) enCours = installer(avancer).finally(() => (enCours = null));
  return enCours;
}

async function installer(avancer?: (pourcent: number) => void): Promise<string> {
  const c = cible();
  const attendu = c ? ARCHIVES[c] : undefined;
  if (!c || !attendu) throw new Error(pythonPriveInstallable() ?? t("Pas de Python autonome pour ce système."));
  const nom = `cpython-${VERSION}+${PUBLICATION}-${c}-install_only.tar.gz`;
  const adresse = `https://github.com/astral-sh/python-build-standalone/releases/download/${PUBLICATION}/${encodeURIComponent(nom)}`;

  let reponse: Response;
  try {
    reponse = await fetch(adresse, { signal: AbortSignal.timeout(30 * 60_000) });
  } catch {
    throw new Error(t("github.com est injoignable : vérifiez l'accès à internet de cette machine, puis réessayez."));
  }
  if (!reponse.ok || !reponse.body) throw new Error(tf("Téléchargement de Python impossible (HTTP {0}).", reponse.status));

  mkdirSync(racine(), { recursive: true, mode: 0o700 });
  /*
   * Dans un dossier à soi (0700), pas dans le dossier temporaire commun : sur
   * une machine à plusieurs comptes, un autre compte ne peut pas substituer
   * l'archive entre la vérification et l'ouverture (revue du 27/09/2026).
   */
  const travail = mkdtempSync(join(racine(), ".telechargement-"));
  const archive = join(travail, "python.tar.gz");
  const empreinte = createHash("sha256");
  let recu = 0;
  const flux = Readable.fromWeb(reponse.body as import("node:stream/web").ReadableStream<Uint8Array>);
  flux.on("data", (morceau: Buffer) => {
    empreinte.update(morceau);
    recu += morceau.length;
    // Plus gros qu'annoncé : ce n'est pas le bon fichier, inutile d'aller au bout.
    if (recu > attendu.octets) flux.destroy(new Error("trop gros"));
    avancer?.(Math.min(99, Math.round((recu / attendu.octets) * 100)));
  });
  try {
    await pipeline(flux, createWriteStream(archive, { mode: 0o600, flags: "wx" }));
  } catch {
    rmSync(travail, { recursive: true, force: true });
    throw new Error(t("Le téléchargement de Python s'est interrompu : vérifiez la connexion, puis réessayez."));
  }
  if (empreinte.digest("hex") !== attendu.sha256) {
    rmSync(travail, { recursive: true, force: true });
    throw new Error(t("L'archive de Python ne correspond pas à son empreinte : elle a été effacée sans être ouverte."));
  }

  // Ouverte à côté, puis mise en place d'un coup : un arrêt au milieu ne laisse pas un Python à moitié posé.
  const provisoire = join(racine(), `.extraction-${Date.now()}`);
  mkdirSync(provisoire, { recursive: true });
  const tar = tarDuSysteme();
  const sortie = await new Promise<string | null>((resolve) =>
    execFile(tar, ["-xzf", archive, "-C", provisoire], { timeout: 10 * 60_000 }, (err, _o, e) => resolve(err ? String(e || err.message) : null)),
  );
  rmSync(travail, { recursive: true, force: true });
  if (sortie !== null || !existsSync(executable(provisoire))) {
    rmSync(provisoire, { recursive: true, force: true });
    throw new Error(tf("Python n'a pas pu être décompressé : {0}", (sortie ?? t("archive incomplète")).slice(-200)));
  }
  rmSync(dossierVersion(), { recursive: true, force: true });
  try {
    renommer(provisoire, dossierVersion());
  } catch (err) {
    // Sous Windows, un antivirus peut tenir le dossier : on ne laisse pas 100 Mo derrière soi.
    rmSync(provisoire, { recursive: true, force: true });
    throw err;
  }

  // Vérifié avant d'être rendu : il doit démarrer, et savoir créer un environnement.
  const exe = executable(dossierVersion());
  const essai = await new Promise<string>((resolve) =>
    execFile(exe, ["-c", "import sys, venv, ensurepip, ssl; print(sys.version.split()[0])"], { timeout: 60_000 }, (err, o) => resolve(err ? "" : String(o).trim())),
  );
  if (essai !== VERSION) {
    rmSync(dossierVersion(), { recursive: true, force: true });
    throw new Error(t("Python s'est installé mais ne démarre pas sur cette machine."));
  }
  avancer?.(100);
  console.log(`[oxoai] Python ${VERSION} posé dans ${dossierVersion()}.`);
  return exe;
}
