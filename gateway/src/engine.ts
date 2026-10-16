import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lister, t, tf } from "./langue.ts";
import { workspace } from "./mcp.ts";
import { tarDuSysteme } from "./pythonPrive.ts";

const exec = promisify(execFile);

/**
 * Installation du moteur d'exécution des modèles.
 *
 * Helix ne sait pas faire tourner un modèle tout seul : il s'appuie sur LM
 * Studio. Demander à l'utilisateur d'aller le chercher lui-même, c'est lui
 * demander de comprendre une plomberie qui ne le regarde pas — et c'est là que
 * la plupart des installations s'arrêtent.
 *
 * Tout est donc automatique, sans clic ni fenêtre d'installation : le moteur
 * sans interface de LM Studio (llmster), à une version épinglée, dont
 * l'archive est vérifiée par son empreinte SHA-512, écrite dans ce fichier,
 * avant d'être ouverte (plus bas).
 *
 * Les Mac à processeur Intel n'ont pas de moteur : LM Studio n'existe que pour
 * les Mac à puce Apple. Jusqu'au 27/09/2026, Helix y téléchargeait
 * l'application LM Studio d'après le catalogue Homebrew, sans version figée ni
 * empreinte écrite ici ; ce catalogue ne décrit plus que l'application pour
 * puce Apple (`depends_on arch: arm64`, relevé le 27/09/2026), qu'un Mac Intel
 * ne peut pas lancer. L'installation y est donc refusée, avec la raison
 * (audit de la chaîne d'approvisionnement du 27/09/2026).
 *
 * Depuis le 28/09/2026, ces Mac ont le moteur ouvert, llama.cpp, posé par
 * Helix à la place de LM Studio (llamaCpp.ts) : la route d'installation du
 * moteur n'arrive plus ici pour eux, sauf si `HELIX_MOTEUR=lmstudio` le
 * demande, et le refus ci-dessous reste alors vrai.
 */

export interface EngineProgress {
  phase: "resolution" | "telechargement" | "verification" | "installation" | "pret" | "erreur";
  message: string;
  percent?: number;
  error?: string;
}

/** Télécharge le paquet en calculant son empreinte SHA-512 au fil de l'eau. */
async function telecharger(
  paquet: { url: string },
  destination: string,
  onProgress: (p: EngineProgress) => void,
): Promise<string> {
  /*
   * Arrêté quand plus rien n'arrive depuis deux minutes, pas au bout d'un
   * temps total : 30 minutes coupaient les 615 Mo du moteur sous 2,8 Mbit/s,
   * et chaque nouvel essai repartait de zéro (revue du 27/09/2026).
   */
  const arret = new AbortController();
  let silence: NodeJS.Timeout | undefined;
  const veiller = () => {
    clearTimeout(silence);
    silence = setTimeout(() => arret.abort(), 2 * 60_000);
  };
  veiller();
  let res: Response;
  try {
    res = await fetch(paquet.url, { signal: arret.signal });
  } catch {
    clearTimeout(silence);
    throw new Error(t("Le serveur du moteur est injoignable : vérifiez l'accès à internet de cette machine, puis réessayez."));
  }
  if (!res.ok || !res.body) {
    clearTimeout(silence);
    throw new Error(tf("Téléchargement impossible (HTTP {0}).", res.status));
  }

  const total = Number(res.headers.get("content-length") ?? 0);
  const hash = createHash("sha512");
  let recu = 0;
  let dernierPourcent = -1;

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (morceau: Buffer) => {
    veiller();
    hash.update(morceau);
    recu += morceau.length;
    if (!total) return;
    const percent = Math.floor((recu / total) * 100);
    if (percent !== dernierPourcent) {
      dernierPourcent = percent;
      onProgress({
        phase: "telechargement",
        message: tf("Téléchargement du moteur... {0} %", percent),
        percent,
      });
    }
  });

  try {
    await pipeline(source, createWriteStream(destination));
  } catch {
    throw new Error(t("Le téléchargement du moteur s'est interrompu (plus rien reçu depuis deux minutes, ou connexion coupée) : vérifiez la connexion, puis réessayez."));
  } finally {
    clearTimeout(silence);
  }
  return hash.digest("hex");
}

/**
 * Emplacements où l'application peut se trouver, du plus général au plus
 * personnel. `HELIX_APPS_DIR` permet d'installer ailleurs — utile pour vérifier
 * une installation sans toucher à celle de la machine.
 */
function emplacements(): string[] {
  const force = process.env.HELIX_APPS_DIR;
  if (force) return [force];
  return ["/Applications", join(homedir(), "Applications")];
}

/** L'application est-elle déjà installée quelque part ? */
export async function appInstallee(): Promise<string | null> {
  if (process.platform !== "darwin") {
    const lms = lmsDeLlmster();
    return existsSync(lms) ? lms : null;
  }
  const application = applicationLmStudio();
  // Mac Intel : l'application, seule possible (pas de llmster pour eux).
  if (process.arch !== "arm64") return application;
  // Mac à puce Apple : l'application si elle a déjà servi, sinon le moteur sans interface.
  if (application && installationDeclaree("app-install-location.json")) return application;
  return moteurSansInterface() && existsSync(lmsDeLlmster()) ? lmsDeLlmster() : null;
}

/**
 * LM Studio a-t-il déclaré cette installation ? `lms` ne trouve son moteur que
 * par ces fichiers de `.internal` : `app-install-location.json`, écrit au
 * premier lancement de l'application, et `llmster-install-location.json`, écrit
 * par `llmster bootstrap` (relevé le 27/09/2026 sur macOS, llmster 0.0.25-1).
 * Sans l'un ni l'autre, `lms` répond « daemon is not running and no valid
 * installation could be found », même avec l'application dans Applications.
 */
function installationDeclaree(fichier: "app-install-location.json" | "llmster-install-location.json"): boolean {
  try {
    const { path } = JSON.parse(readFileSync(join(dossierLmStudio(), ".internal", fichier), "utf8")) as { path?: unknown };
    return typeof path === "string" && existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Mac à puce Apple où `lms` est là mais sans moteur qu'il sache démarrer :
 * l'application LM Studio posée par une version précédente de Helix, jamais
 * ouverte (vu sur un MacBook le 27/09/2026, deux fois). Le moteur y compte
 * comme absent : l'écran de mise en route propose de l'installer, et c'est le
 * moteur sans interface qui est posé, à côté de l'application.
 */
export function moteurAPoser(): boolean {
  /*
   * Windows et Linux aussi, depuis le 28/09/2026 : vu chez plusieurs personnes
   * sous Windows (2026.928.6), « LM Studio daemon is not running and no valid
   * installation could be found » à chaque modèle. `lms.exe` était là, donc le
   * moteur passait pour installé ; mais `lms` ne démarre le moteur que par sa
   * déclaration (`findOrStartLlmster`, lmstudio-js, relu le 28/09/2026 :
   * `llmster-install-location.json` ou `app-install-location.json`, dont le
   * chemin doit exister). Sans elle, le moteur est à poser, comme sur un Mac.
   */
  if (process.platform === "darwin" && process.arch !== "arm64") return false;
  if (!["darwin", "win32", "linux"].includes(process.platform)) return false;
  return !installationDeclaree("app-install-location.json") && !installationDeclaree("llmster-install-location.json");
}

/**
 * Ce que contient le dossier interne de LM Studio, pour le journal quand le
 * moteur ne se déclare pas (noms de fichiers seulement : diagnostic d'un poste
 * qu'on ne peut pas voir, 28/09/2026).
 */
export function diagnosticInstallation(): string {
  const dossier = join(dossierLmStudio(), ".internal");
  try {
    const noms = readdirSync(dossier).filter((n) => /install-location|pid|lock/i.test(n));
    const declaration = (f: string) => {
      try {
        const { path } = JSON.parse(readFileSync(join(dossier, f), "utf8")) as { path?: unknown };
        return typeof path === "string" ? `${f} → ${existsSync(path) ? "présent" : "ABSENT"}` : `${f} → illisible`;
      } catch {
        return `${f} → absent`;
      }
    };
    return `${dossier} : ${noms.join(", ") || "aucun fichier d'installation"} ; ${declaration("llmster-install-location.json")} ; ${declaration("app-install-location.json")}`;
  } catch {
    return `${dossier} : introuvable`;
  }
}

/** L'application LM Studio (avec son interface) sur ce Mac, ou null. */
export function applicationLmStudio(): string | null {
  if (process.platform !== "darwin") return null;
  for (const base of emplacements()) {
    const chemin = join(base, "LM Studio.app");
    if (existsSync(chemin)) return chemin;
  }
  return null;
}

/**
 * Le moteur est-il le moteur sans interface (llmster) ? Sous Windows et Linux,
 * toujours ; sur macOS, quand llmster est posé (par Helix, sur un Mac à puce
 * Apple) et que l'application LM Studio n'a jamais servi. Une application qui a
 * déjà servi garde la main : c'est elle que partagent les autres logiciels de la
 * machine (un agent personnel, LM Studio lui-même).
 */
export function moteurSansInterface(): boolean {
  if (process.platform !== "darwin") return true;
  return installationDeclaree("llmster-install-location.json") && !(applicationLmStudio() && installationDeclaree("app-install-location.json"));
}

/**
 * Le moteur est-il celui de Helix, et de lui seul (16/10/2026) ? Le moteur
 * sans interface déclaré (`llmster-install-location.json`), et aucune
 * application LM Studio déclarée sur la machine (`app-install-location.json`),
 * sur tout système. Sert à décider si Helix peut recharger un modèle chargé
 * avec une trop petite taille de conversation (backends.ts,
 * `agrandirLaConversation`) : l'application LM Studio de la personne, et ce
 * qu'elle y a chargé, ne sont jamais touchées.
 */
export function moteurGereParHelix(): boolean {
  return installationDeclaree("llmster-install-location.json") && !installationDeclaree("app-install-location.json");
}

/**
 * Installe le moteur. Renvoie le chemin de l'application installée.
 *
 * Chaque étape échoue bruyamment plutôt que de continuer à moitié : une
 * installation partielle serait plus difficile à diagnostiquer qu'une absence.
 */
export async function installerMoteur(
  onProgress: (p: EngineProgress) => void,
): Promise<string> {
  const dejaLa = await appInstallee();
  // `lms` présent mais installation non déclarée (Windows, 28/09/2026) : on repose le moteur au lieu de croire qu'il est là.
  if (dejaLa && !moteurAPoser()) return dejaLa;
  /*
   * Mac à puce Apple aussi, depuis le 27/09/2026 : l'application LM Studio
   * posée par Helix n'avait jamais été ouverte, et `lms` refusait alors de
   * démarrer son service (« daemon is not running and no valid installation
   * could be found », vu sur un MacBook). Le moteur sans interface démarre
   * sans elle. Les Mac Intel n'ont ni l'un ni l'autre (en-tête du fichier).
   */
  if (process.platform === "win32" || process.platform === "linux" || (process.platform === "darwin" && process.arch === "arm64")) {
    return installerLlmster(onProgress);
  }
  throw new Error(
    process.platform === "darwin"
      ? t("LM Studio n'existe pas pour les Mac à processeur Intel : aucun moteur ne peut être installé sur ce Mac. Branchez un modèle par une clé d'un fournisseur, ou un autre moteur compatible OpenAI dans le profil de déploiement.")
      : t("L'installation automatique du moteur n'existe pas pour ce système."),
  );
}

/* --------------- Windows, Linux et Mac à puce Apple : llmster --------------- */

/*
 * Linux et Windows (27/09/2026, demandé par Medhi : « tout s'installe en
 * automatique » sur les trois systèmes), puis Mac à puce Apple le même jour
 * (l'application LM Studio jamais ouverte ne démarrait pas). LM Studio publie pour eux un moteur
 * sans interface, llmster, avec le même outil `lms` : c'est lui que Helix
 * installe, comme le fait l'installateur officiel de l'éditeur
 * (lmstudio.ai/install.sh et install.ps1), mais sans exécuter de script
 * téléchargé :
 *
 *  1. la version est épinglée ici, avec l'empreinte SHA-512 de chaque archive
 *     (relevée dans les fichiers `.sha512` que l'éditeur publie) ;
 *  2. l'archive vient du dépôt de l'éditeur, et son empreinte est vérifiée
 *     avant ouverture ;
 *  3. l'archive est ouverte par `tar` (celui de Windows lui-même, pas un autre
 *     trouvé dans le PATH), puis `llmster bootstrap` pose `lms` dans
 *     `~/.lmstudio/bin`, pour ce compte seulement : ni droits
 *     d'administration, ni fenêtre, ni PATH modifié.
 *
 * Limite dite : l'empreinte a été relevée sur le même serveur que l'archive,
 * mais une fois, le 27/09/2026, et écrite ici : un serveur compromis ensuite
 * ne peut plus faire installer autre chose. Sur Mac Intel, rien n'est installé (pas de
 * moteur LM Studio pour eux). Essayé dans un Ubuntu 24.04
 * (conteneur) et installé sur macOS à la main ; pas encore sur une vraie machine
 * Windows ni Linux, ni démarré par Helix sur un Mac.
 */

/*
 * Version épinglée et empreintes SHA-512 écrites ici (revue de sécurité du
 * 27/09/2026), relevées ce jour-là dans les fichiers `.sha512` de l'éditeur :
 * plus rien n'est lu en ligne pour décider quoi installer, et une archive
 * changée sur le serveur, même avec une empreinte changée à côté, est refusée.
 * Passer à une version plus récente, c'est relever ses empreintes et les
 * écrire ici. L'empreinte de `linux-x64.full` est celle vérifiée par
 * l'installation réelle dans un Ubuntu 24.04 le même jour.
 */
const LLMSTER_VERSION = "0.0.25-1";
const LLMSTER: Record<string, { sha512: string; octets: number }> = {
  "0.0.25-1-linux-x64.full": { sha512: "4d119af740379fc7509894d761a85183420a6dd3cb994596a1b6e4b37208a5d3e8cb94ffe583115b1473a6722bab5fffc09b90eb22c755f5dde1458774ab4951", octets: 1_005_168_404 },
  "0.0.25-1-linux-x64.full+cuda12": { sha512: "179e05cee62c1e1f61f1c6480179b1e21df63af64ffa3a949a94f026afc4552d7a36db7208345e65f21f040d864c1603bf6cd1c0292e4751d696bee5679db007", octets: 1_105_623_572 },
  "0.0.25-1-linux-arm64.full": { sha512: "9743cfce0fd1e2b76f4fcbef6fbe4ed68f4e953781c0eba5c5db33308209f007939f3f946995618f22f8c4bb977919408c23a5cbbb369f530e2c92738f6891bc", octets: 1_257_501_655 },
  "0.0.25-1-win32-x64.full": { sha512: "a17bfd052ea7a63182c4cd39b0619982e8027d19f6b00d0207207c8fa308540e502251662886a8ce8191a2bd0eb9132a48ee4991e784ebb5474d62ed3103fffe", octets: 868_484_756 },
  "0.0.25-1-darwin-arm64.full": { sha512: "edf1fb01f49b6ea101b3bd7027b4516eb73261d7b0df871c4286fac7011eb4f12633f7f03c9c6a66322659231c248989b7d235528b41bd2f30d87ce085c13b32", octets: 615_370_329 },
  "0.0.25-1-win32-arm64.full": { sha512: "fde8717b0ec91758a5dbd3e2ef15d7d8cbe26d4190fedde258c9c38846fc7c79e320c75bf3e0793c53163a3460f5259f3036016929ea38098f7abeedb7e5e15b", octets: 279_979_911 },
};
const DEPOT_LLMSTER = "https://llmster.lmstudio.ai/download";

/** Le dossier de LM Studio pour ce compte : `~/.lmstudio`, ou celui que désigne `~/.lmstudio-home-pointer`. */
export function dossierLmStudio(): string {
  const habituel = join(homedir(), ".lmstudio");
  try {
    const pointe = readFileSync(join(homedir(), ".lmstudio-home-pointer"), "utf8").trim();
    /*
     * Le pointeur n'est suivi que vers un dossier local sûr (revue de sécurité
     * du 27/09/2026) : chemin absolu, pas un partage réseau (`\\serveur`, qui
     * enverrait les identifiants Windows ailleurs), un vrai dossier, à ce
     * compte sous macOS et Linux, et hors des dossiers que les agents peuvent
     * écrire. Sinon, l'emplacement habituel : c'est `bin/lms` de ce dossier
     * que la passerelle lance.
     */
    /*
     * Ni un lien, et l'espace des agents comparé au chemin réel (test
     * d'intrusion du 28/09/2026, SECURITE.md § 58) : un pointeur vers
     * `D:\Modeles\LM Studio`, où `LM Studio` était un lien vers l'espace des
     * agents, était suivi, la comparaison se faisant sur le chemin écrit.
     */
    if (pointe && isAbsolute(pointe) && !/^[\\/]{2}/.test(pointe) && !lstatSync(pointe).isSymbolicLink()) {
      const st = statSync(pointe);
      const aMoi = process.platform === "win32" || typeof process.getuid !== "function" || st.uid === process.getuid();
      if (st.isDirectory() && aMoi && !espaceEcrivable(pointe) && !espaceEcrivable(realpathSync(pointe))) return pointe;
    }
  } catch {
    /* pas de pointeur, ou illisible : l'emplacement habituel */
  }
  return habituel;
}

/** Le dossier est-il dans l'espace de travail des agents, ou le contient-il ? */
function espaceEcrivable(dossier: string): boolean {
  const a = resolve(dossier).toLowerCase();
  const b = resolve(workspace()).toLowerCase();
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

export const lmsDeLlmster = (): string => join(dossierLmStudio(), "bin", process.platform === "win32" ? "lms.exe" : "lms");

/* ------------- L'emplacement de LM Studio (28/09/2026) ------------- */

/*
 * Demandé par Medhi le 28/09/2026 : pouvoir mettre moteur et modèles sur un
 * autre disque que le disque principal (un D: sous Windows). LM Studio le
 * permet par `~/.lmstudio-home-pointer` : son code ouvert
 * (lmstudio-js, `lms-common-server/src/findLMStudioHome.ts`, lu le
 * 28/09/2026) lit ce fichier pour trouver son dossier tout entier (moteur,
 * téléchargements en cours dans `.internal/temp-downloads`, modèles), et
 * l'écrit vers `~/.lmstudio` s'il manque. Helix l'écrit donc avant la
 * première installation, jamais après (emplacementModeles.ts) : llmster se
 * pose alors directement sur le disque choisi. Que llmster lui-même suive le
 * pointeur à l'amorce n'a pas été vu avec le vrai llmster : d'où les deux
 * contrôles de `installerLlmster` ci-dessous.
 */

export const fichierPointeurLmStudio = (): string => join(homedir(), ".lmstudio-home-pointer");
export const dossierLmStudioHabituel = (): string => join(homedir(), ".lmstudio");

/** Le contenu du pointeur, s'il y en a un (sans le juger). */
export function pointeurLmStudio(): string | null {
  try {
    const brut = readFileSync(fichierPointeurLmStudio(), "utf8").trim();
    return brut || null;
  } catch {
    return null;
  }
}

/**
 * Le pointeur désigne-t-il un autre dossier que celui que Helix suit ? Disque
 * débranché, dossier effacé, ou refusé par `dossierLmStudio` : Helix
 * installerait ou chercherait ailleurs que LM Studio lui-même.
 */
export function pointeurNonSuivi(): string | null {
  const brut = pointeurLmStudio();
  if (!brut) return null;
  return resolve(brut) === resolve(dossierLmStudio()) ? null : brut;
}

/**
 * Où LM Studio est-il déjà en place sur ce compte (moteur, application
 * déclarée, ou modèles) ? Rend le dossier, ou null s'il n'y a rien : c'est
 * seulement alors que Helix peut encore choisir où il ira.
 */
export function lmStudioEnPlace(): string | null {
  const candidats = [...new Set([dossierLmStudio(), dossierLmStudioHabituel(), join(homedir(), ".cache", "lm-studio")].map((d) => resolve(d)))];
  return candidats.find(installationDans) ?? null;
}

/** Ce dossier porte-t-il une installation de LM Studio (moteur, déclaration, modèles, téléchargement commencé) ? */
export function installationDans(d: string): boolean {
  const exe = process.platform === "win32" ? "lms.exe" : "lms";
  const nonVide = (x: string) => {
    try {
      return readdirSync(x).some((n) => !n.startsWith("."));
    } catch {
      return false;
    }
  };
  if (
    existsSync(join(d, "bin", exe)) ||
    existsSync(join(d, ".internal", "llmster-install-location.json")) ||
    existsSync(join(d, ".internal", "app-install-location.json")) ||
    nonVide(join(d, "models")) ||
    nonVide(join(d, ".internal", "temp-downloads"))
  ) {
    return true;
  }
  // Les modèles rangés ailleurs par le réglage de LM Studio (« My Models › Change »).
  const ailleurs = dossierTelechargementsLmStudio(d);
  return Boolean(ailleurs && nonVide(ailleurs));
}

/** Le réglage `downloadsFolder` de LM Studio (le dossier de ses modèles), s'il en a un. */
export function dossierTelechargementsLmStudio(racine = dossierLmStudio()): string | null {
  try {
    const { downloadsFolder } = JSON.parse(readFileSync(join(racine, "settings.json"), "utf8")) as { downloadsFolder?: unknown };
    return typeof downloadsFolder === "string" && isAbsolute(downloadsFolder) ? downloadsFolder : null;
  } catch {
    return null;
  }
}

/** Le dossier des modèles de LM Studio : son réglage `downloadsFolder`, sinon `models` dans son dossier. */
export const dossierModelesLmStudio = (): string => dossierTelechargementsLmStudio() ?? join(dossierLmStudio(), "models");

/**
 * Place que prend l'installation du moteur, au plus fort (archive, contenu
 * ouvert et copie posée par l'amorce, côte à côte) : trois fois l'archive.
 * Une estimation, pas une mesure : la taille ouverte n'a été relevée sur
 * aucun système.
 */
export function placeMoteurLlmster(): number {
  try {
    const { nom } = nomLlmster(LLMSTER_VERSION);
    return (LLMSTER[nom]?.octets ?? LLMSTER[nom.replace(/\+cuda12$/, "")]?.octets ?? 1e9) * 3;
  } catch {
    return 3e9;
  }
}

/**
 * Avant de télécharger, et après l'amorce : llmster doit être (ou aller) là
 * où Helix le cherche. Sinon, une erreur claire, et pas un nouvel essai de
 * 600 Mo à chaque clic.
 */
/**
 * Un emplacement a été choisi (pointeur suivi, autre que `~/.lmstudio`), mais
 * `lms` n'y est pas, alors qu'il est dans `~/.lmstudio` : le moteur s'est posé
 * à l'emplacement habituel, pas à celui choisi.
 */
export function llmsterPoseAilleurs(): boolean {
  const suivi = dossierLmStudio();
  if (resolve(suivi) === resolve(dossierLmStudioHabituel())) return false;
  const exe = process.platform === "win32" ? "lms.exe" : "lms";
  return !existsSync(join(suivi, "bin", exe)) && existsSync(join(dossierLmStudioHabituel(), "bin", exe));
}

export function incoherenceEmplacement(apresAmorce = false): string | null {
  // L'application LM Studio déjà servie garde son dossier : rien à contrôler ici.
  if (process.platform === "darwin" && !moteurSansInterface() && installationDeclaree("app-install-location.json")) return null;
  const brut = pointeurNonSuivi();
  if (brut) {
    return tf("L'emplacement choisi pour LM Studio est introuvable ou refusé ({0}) : branchez le disque, ou revenez à l'emplacement habituel dans les réglages, Modèles locaux.", brut);
  }
  const suivi = dossierLmStudio();
  if (llmsterPoseAilleurs()) {
    return apresAmorce
      ? tf("Le moteur s'est installé dans {0}, et non à l'emplacement choisi ({1}). Revenez à l'emplacement habituel dans les réglages, Modèles locaux, puis réessayez : il n'y aura rien à retélécharger.", dossierLmStudioHabituel(), suivi)
      : tf("Le moteur est déjà installé dans {0}, et non à l'emplacement choisi ({1}). Revenez à l'emplacement habituel dans les réglages, Modèles locaux, puis réessayez : il n'y aura rien à retélécharger.", dossierLmStudioHabituel(), suivi);
  }
  return null;
}

/**
 * Le dossier temporaire interne du moteur, que llmster 0.0.25 ne crée pas
 * lui-même (essai sous Ubuntu 24.04 du 27/09/2026) : sans lui, chaque
 * chargement de modèle échouait (`ENOENT … mkdtemp .internal/temp/…`), juste
 * après une installation réussie. Créé à l'installation, et à chaque démarrage
 * du moteur pour les installations déjà faites. Sans effet s'il existe.
 */
export function preparerDossiersLlmster(): void {
  if (!moteurSansInterface()) return;
  const racine = dossierLmStudio();
  if (!existsSync(racine)) return;
  try {
    mkdirSync(join(racine, ".internal", "temp"), { recursive: true });
  } catch {
    /* dossier du moteur en lecture seule : le chargement le dira */
  }
}

/** Pilote NVIDIA assez récent pour la version CUDA 12 du moteur (même seuil que l'installateur officiel : 550.54.14). */
function cuda12(): boolean {
  try {
    const brut = execFileSync("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const v = (brut.split("\n")[0] ?? "").trim().split(".").map(Number);
    const seuil = [550, 54, 14];
    for (let i = 0; i < 3; i++) {
      const x = v[i] ?? 0;
      if (!Number.isFinite(x)) return false;
      if (x !== seuil[i]) return x > seuil[i];
    }
    return true;
  } catch {
    return false;
  }
}

/** Le nom de l'archive pour ce système, comme le calcule l'installateur officiel. */
function nomLlmster(version: string): { nom: string; extension: string } {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) throw new Error(tf("Le moteur de LM Studio n'existe pas pour ce processeur ({0}).", process.arch));
  if (process.platform === "win32") return { nom: `${version}-win32-${arch}.full`, extension: ".zip" };
  if (process.platform === "darwin") return { nom: `${version}-darwin-${arch}.full`, extension: ".tar.gz" };
  return { nom: `${version}-linux-${arch}.full${arch === "x64" && cuda12() ? "+cuda12" : ""}`, extension: ".tar.gz" };
}

/*
 * Linux : le moteur a besoin de `libatomic` (et, en pratique, de `libgomp`).
 * Une installation minimale ne les a pas, et Helix ne passe pas
 * administrateur : il le dit, avec la commande à lancer.
 */
function bibliothequesManquantes(): string[] {
  if (process.platform !== "linux") return [];
  let liste = "";
  for (const ldconfig of ["ldconfig", "/sbin/ldconfig", "/usr/sbin/ldconfig"]) {
    try {
      liste = execFileSync(ldconfig, ["-p"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
      break;
    } catch {
      /* suivant */
    }
  }
  if (!liste) return [];
  // `libgomp` aussi : sans lui, le moteur s'installe, puis le premier chargement échoue (AppImage sur un système minimal, revue du 27/09/2026).
  return ["libatomic.so.1", "libgomp.so.1"].filter((b) => !liste.includes(b));
}


/**
 * Lance `llmster bootstrap` comme le fait l'installateur officiel : variables
 * de l'installateur, dossier de l'archive ouverte, sortie lue au fil de l'eau
 * sans limite (seules les 8 000 dernières lettres sont gardées). Dix minutes
 * au plus : un service qui garderait la sortie ouverte ne bloque pas Helix.
 */
export function amorcer(amorce: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; fin: string }> {
  return new Promise((resolve) => {
    let fin = "";
    const garder = (b: Buffer) => {
      fin = (fin + b.toString()).slice(-8000);
    };
    const enfant = spawn(amorce, ["bootstrap"], {
      /*
       * Le dossier personnel, comme l'installateur officiel lancé d'un
       * terminal : la déclaration de LM Studio garde un dossier de travail
       * (`cwd`, lmstudio-js), et celui de l'archive est effacé juste après.
       */
      cwd: homedir(),
      env: { ...process.env, LMS_BOOTSTRAP_INSTALL_SH: "1", LMS_NO_MODIFY_PATH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    enfant.stdout.on("data", garder);
    enfant.stderr.on("data", garder);
    const garde = setTimeout(() => enfant.kill(), 600_000);
    enfant.on("error", (err) => {
      clearTimeout(garde);
      resolve({ code: -1, signal: null, fin: `${fin}\n${err.message}` });
    });
    enfant.on("close", (code, signal) => {
      clearTimeout(garde);
      resolve({ code, signal, fin });
    });
  });
}

async function installerLlmster(onProgress: (p: EngineProgress) => void): Promise<string> {
  // Emplacement choisi introuvable, ou moteur déjà posé ailleurs : dit avant de télécharger quoi que ce soit.
  const incoherence = incoherenceEmplacement();
  if (incoherence) throw new Error(incoherence);
  const manquantes = bibliothequesManquantes();
  if (manquantes.length > 0) {
    throw new Error(
      tf(
        "Il manque au système une bibliothèque dont le moteur a besoin ({0}). Installez-la, puis réessayez : sudo apt-get install -y libatomic1 libgomp1 (Debian, Ubuntu), ou sudo dnf install -y libatomic libgomp (Fedora).",
        lister(manquantes),
      ),
    );
  }

  // Version épinglée : rien n'est cherché en ligne (revue du 27/09/2026).
  onProgress({ phase: "resolution", message: t("Préparation du téléchargement...") });
  const version = LLMSTER_VERSION;
  const { nom, extension } = nomLlmster(version);
  /*
   * Carte NVIDIA : la version CUDA 12 d'abord, puis la version ordinaire si
   * elle ne passe pas (empreinte de la version CUDA lue chez l'éditeur, jamais
   * confirmée par un vrai téléchargement ; revue Linux du 27/09/2026).
   */
  const noms = nom.endsWith("+cuda12") ? [nom, nom.replace(/\+cuda12$/, "")] : [nom];
  // Sans empreinte écrite ici, rien n'est installé : c'est la règle du projet, sans exception.
  if (!noms.some((n) => LLMSTER[n]?.sha512)) throw new Error(tf("Le moteur de LM Studio n'existe pas pour ce processeur ({0}).", process.arch));

  /*
   * Sur le disque, dans un dossier à soi, pas dans `/tmp` : sous Fedora et
   * Debian 13, `/tmp` vit en mémoire (la moitié de la RAM), et l'archive plus
   * son contenu (environ 2 Go) pouvaient ne pas y tenir ; un `/tmp` monté
   * `noexec` empêchait aussi l'amorce (revue Linux du 27/09/2026).
   */
  /*
   * Emplacement choisi sur un autre disque (28/09/2026) : l'archive et son
   * contenu y sont aussi, pas sur le disque principal qui n'a pas la place.
   */
  const ailleurs = resolve(dossierLmStudio()) !== resolve(dossierLmStudioHabituel());
  const racineTravail = ailleurs ? dossierLmStudio() : (process.env.HELIX_DATA_DIR ?? join(homedir(), ".helix", "data"));
  await mkdir(racineTravail, { recursive: true, mode: 0o700 });
  const travail = await mkdtemp(join(racineTravail, ".moteur-"));
  try {
    const archive = join(travail, `llmster${extension}`);
    let dernierEchec: unknown = null;
    let installe = false;
    for (const n of noms) {
      const attendue = LLMSTER[n]?.sha512;
      if (!attendue) continue;
      try {
        onProgress({ phase: "telechargement", message: t("Téléchargement du moteur..."), percent: 0 });
        const empreinte = await telecharger({ url: `${DEPOT_LLMSTER}/${n}${extension}` }, archive, onProgress);
        onProgress({ phase: "verification", message: t("Vérification du paquet...") });
        if (empreinte !== attendue) {
          throw new Error(t("L'empreinte du paquet téléchargé ne correspond pas à celle publiée. Installation interrompue."));
        }
        installe = true;
        break;
      } catch (err) {
        dernierEchec = err;
        await rm(archive, { force: true }).catch(() => {});
        if (n !== noms[noms.length - 1]) console.warn(`[helix] moteur ${n} refusé, essai de la version ordinaire :`, err instanceof Error ? err.message : err);
      }
    }
    if (!installe) throw dernierEchec instanceof Error ? dernierEchec : new Error(String(dernierEchec));

    onProgress({ phase: "installation", message: t("Installation...") });
    const dossier = join(travail, "contenu");
    await mkdir(dossier, { recursive: true });
    await exec(tarDuSysteme(), ["-xf", archive, "-C", dossier], { timeout: 600_000 });
    const amorce = join(dossier, process.platform === "win32" ? "llmster.exe" : "llmster");
    if (!existsSync(amorce)) throw new Error(t("L'archive du moteur ne contient pas ce qui était attendu. Installation interrompue."));
    // Ce que fait l'installateur officiel, sans toucher au PATH ni aux profils du terminal.
    /*
     * `llmster bootstrap`, sans garder sa sortie en mémoire (28/09/2026).
     * Lancé jusqu'ici par `execFile`, dont la mémoire de sortie est bornée à
     * 1 Mo : au-delà, le programme est arrêté net. Vu chez plusieurs personnes
     * sous Windows (2026.928.6) : `lms.exe` était déjà copié, la déclaration de
     * l'installation (`llmster-install-location.json`) jamais écrite, et Helix,
     * qui ne regardait que `lms.exe`, passait au modèle ; chaque téléchargement
     * finissait sur « LM Studio daemon is not running and no valid installation
     * could be found ». L'installateur officiel (install.ps1) laisse la sortie
     * au terminal, sans borne. Ici, seule la fin est gardée, pour le journal.
     * Et l'installation n'est faite que si elle est déclarée : sinon, un second
     * essai, puis l'erreur avec ce que le dossier de LM Studio contient.
     */
    for (let essai = 1; essai <= 2; essai++) {
      const issue = await amorcer(amorce);
      if (issue.code !== 0) console.warn(`[helix] llmster bootstrap (essai ${essai}) : code ${issue.code ?? issue.signal}, fin de sortie : ${issue.fin.slice(-600)}`);
      if (existsSync(lmsDeLlmster()) && !moteurAPoser()) break;
      if (essai === 2) {
        const autrePart = incoherenceEmplacement(true);
        if (autrePart) throw new Error(autrePart);
        console.error(`[helix] moteur posé mais non déclaré : ${diagnosticInstallation()}`);
        throw new Error(
          existsSync(lmsDeLlmster())
            ? t("Le moteur s'est installé, mais LM Studio ne le reconnaît pas. Réessayez ; si cela se répète, installez LM Studio depuis lmstudio.ai et ouvrez-le une fois.")
            : t("Le moteur s'est installé, mais son outil `lms` est introuvable. Réessayez, ou installez LM Studio depuis lmstudio.ai."),
        );
      }
    }
    // Posé ailleurs qu'à l'emplacement choisi : dit tel quel (le prochain essai s'arrête avant de retélécharger).
    const ailleursQueChoisi = incoherenceEmplacement(true);
    if (ailleursQueChoisi) throw new Error(ailleursQueChoisi);
    const lms = lmsDeLlmster();
    if (!existsSync(lms)) throw new Error(t("Le moteur s'est installé, mais son outil `lms` est introuvable. Réessayez, ou installez LM Studio depuis lmstudio.ai."));
    /*
     * Mac : `lms` ne trouve le moteur que par sa déclaration
     * (`llmster-install-location.json`). Absente, Helix redemanderait
     * l'installation en boucle, 600 Mo à chaque fois (revue du 27/09/2026).
     */
    preparerDossiersLlmster();
    onProgress({ phase: "pret", message: tf("Moteur installé (version {0}).", version), percent: 100 });
    return lms;
  } finally {
    await rm(travail, { recursive: true, force: true }).catch(() => {});
  }
}
