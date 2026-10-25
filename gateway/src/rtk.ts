import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { autoProvisionEnabled } from "./deployment.ts";
import { t, tf } from "./langue.ts";
import { renommer } from "./processus.ts";
import { tarDuSysteme } from "./pythonPrive.ts";

/**
 * RTK, qui raccourcit la sortie des commandes de l'agent de code avant
 * qu'elle parte au modèle.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────────
 *
 * Demandé par Medhi le 28/09/2026 : « Pour les modèles cloud, si possible,
 * mettre RTK pour limiter la consommation de jetons. » RTK (github.com/rtk-ai/rtk,
 * Apache-2.0) est un programme en ligne de commande : `rtk git status` lance
 * `git status` et rend une sortie condensée (lignes vides, bruit de progression,
 * listes longues). Mesuré le 28/09/2026 dans un dépôt jetable (PROJET.md) :
 * `git status` 618 octets → 126, `ls -la` 2 600 → 873, `grep -rn` 17 823 →
 * 10 246 ; rien sur `npm test` (qu'il ne réécrit pas).
 *
 * ── Comment il est branché, et pourquoi pas comme RTK le propose ────────────
 *
 * RTK s'installe d'ordinaire par `rtk init --opencode`, qui pose un greffon
 * OpenCode (`tool.execute.before`) réécrivant `git status` en `rtk git status`
 * **avant** que l'outil `bash` demande l'autorisation : lu dans OpenCode
 * 1.18.32 (`ShellTool`, la demande `permission: "bash"` est faite dans
 * `execute`, après le crochet). La carte d'accord de OxoAI aurait montré
 * `rtk git status`, et la barrière aurait jugé l'enveloppe au lieu de la
 * commande. Écarté.
 *
 * OxoAI place RTK **après** la barrière, au moment où la commande part :
 * OpenCode lance chaque commande par `spawn(commande, { shell })` (lu dans
 * `ShellTool.run`), et son réglage `shell` accepte n'importe quel exécutable
 * (hors fish et nu). Ce réglage désigne `enveloppe` (écrite ici), qui reçoit
 * `-c <commande d'origine>`, demande à `rtk rewrite` son équivalent, et le
 * lance avec le vrai shell ; sinon la commande d'origine. Donc :
 *  - la carte, la barrière (zones protégées, réseau, niveau) et le journal ne
 *    voient que la commande d'origine, exactement comme avant ;
 *  - une commande que RTK ne connaît pas (`rtk rewrite` rend 1) passe telle quelle ;
 *  - RTK absent, ou `rtk rewrite` en échec : la commande d'origine, et une
 *    ligne dans `replis.log`, relayée au journal de la passerelle.
 *
 * Par session : le greffon d'environnement de OxoAI (opencode.ts) reçoit
 * `sessionID` à chaque commande (crochet `shell.env`, OpenCode 1.18.32) et ne
 * donne `OXOAI_RTK_DB` qu'aux sessions notées ici ; sans elle, l'enveloppe
 * passe la main au vrai shell sans appeler RTK. Réglage de l'écran Code :
 * « cloud » (défaut, demandé par Medhi), « toujours » (aide aussi les petits
 * modèles locaux, qui ont peu de place), « jamais ».
 *
 * ── Ce que RTK écrit, et ce qu'il envoie ────────────────────────────────────
 *
 * Lu dans son code 0.50.0 et vérifié sur le binaire publié :
 *  - **Télémétrie** : un envoi quotidien vers telemetry.rtk-ai.app, compilé
 *    dans la version publiée, mais seulement après un consentement donné par
 *    `rtk init` (jamais lancé ici) ; `RTK_TELEMETRY_DISABLED=1`, posé à chaque
 *    appel, la coupe avant même de lire ce consentement. C'est le seul code
 *    réseau de RTK (`ureq`), avec la demande d'effacement de `rtk telemetry
 *    forget`, jamais lancée.
 *  - **Historique** : une base SQLite des commandes (commande, jetons avant et
 *    après, 90 jours) ; `RTK_DB_PATH` la met dans `<données>/rtk/sessions/`,
 *    une par session, d'où vient le total affiché à l'écran.
 *  - **Sorties complètes** gardées pour `rtk recall` quand une commande échoue :
 *    coupées (`RTK_RECALL=0`). Elles recopieraient la sortie entière (secrets
 *    affichés compris) dans une seconde base, et l'agent n'a pas `rtk` dans son
 *    PATH pour les relire.
 *  - **Lectures** : son `config.toml` (dossier de configuration de la personne,
 *    s'il existe) et, pour décider d'une réécriture, les règles de
 *    `~/.claude/settings.json`. Rien n'y est écrit.
 *
 * ── Installation ────────────────────────────────────────────────────────────
 *
 * Comme OpenCode (opencodePrive.ts) : version épinglée, empreintes SHA-256
 * écrites ici, relevées le 28/09/2026 dans `checksums.txt` de la publication
 * **et** recalculées sur les archives téléchargées (identiques), aucun script
 * exécuté, un seul exécutable posé dans `<données>/rtk/<version>/` : ni droits
 * d'administration, ni PATH de la personne modifié. Seule la commande réécrite
 * reçoit ce dossier en tête de son PATH.
 *
 * Windows : l'archive est épinglée, mais rien n'est branché ni téléchargé.
 * OpenCode y choisit son shell autrement (cmd, PowerShell, Git Bash) et
 * l'enveloppe est un script POSIX ; les commandes y partent sans RTK, et
 * l'écran le dit. Linux arm64 : RTK ne publie qu'une archive glibc.
 */

const VERSION = "0.50.0";
const DEPOT = "https://github.com/rtk-ai/rtk/releases/download";

const ARCHIVES: Record<string, { fichier: string; sha256: string; octets: number }> = {
  "darwin-arm64": { fichier: "rtk-aarch64-apple-darwin.tar.gz", sha256: "fe54761a9950266e3a78ddb66a8af5e067251169da306a288e0751de63d836fe", octets: 4_122_143 },
  "darwin-x64": { fichier: "rtk-x86_64-apple-darwin.tar.gz", sha256: "ac23e20024ab3c71e7f50069f8b34190aec1b2d8f0c2cc19834039b3dac73373", octets: 4_512_079 },
  "linux-x64": { fichier: "rtk-x86_64-unknown-linux-musl.tar.gz", sha256: "bc2b8902b0d9c796c82ef45f16ae2307e17757afeca5ee156235a3dc7bda5f89", octets: 4_857_739 },
  "linux-arm64": { fichier: "rtk-aarch64-unknown-linux-gnu.tar.gz", sha256: "d1cc49dfa2cd443fc32625444b59fe616b6c80478cca210985118347174dd758", octets: 4_462_410 },
  "win32-x64": { fichier: "rtk-x86_64-pc-windows-msvc.zip", sha256: "cb03399305135dd59ee23eb59a3260ccdeea5a8e08fbc7a271b115b85583a6c9", octets: 4_511_565 },
};

/** Ce que OxoAI passe à chaque appel de RTK : pas de télémétrie, pas de copie des sorties complètes. */
export const ENV_RTK = { RTK_TELEMETRY_DISABLED: "1", RTK_RECALL: "0" } as const;

const cible = () => `${process.platform}-${process.arch}`;
const racine = () => join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "rtk");
const dossierVersion = () => join(racine(), VERSION);
const nomExecutable = () => (process.platform === "win32" ? "rtk.exe" : "rtk");
/** Une base d'historique par session racine (ses sous-agents compris). */
export const dossierBases = (): string => join(racine(), "sessions");
/** Sessions où RTK sert : identifiant → session racine (lu par le greffon d'environnement d'OpenCode). */
export const fichierSessions = (): string => join(racine(), "sessions.json");
const fichierReplis = () => join(racine(), "replis.log");
const cheminEnveloppe = () => join(racine(), "shell-code");
/** Le dossier mis en tête du PATH d'une commande réécrite : il n'y a là que le `rtk` de OxoAI (`ecrireRtkDesCommandes`). */
const dossierChemin = () => join(racine(), "chemin");

/** Même forme que les identifiants de session acceptés par la passerelle : aucun `.` ni `/`, donc un nom de fichier sûr. */
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;

/** Le RTK posé par OxoAI (chemin, qu'il existe ou non). */
export const rtkDeOxoAI = (): string => join(dossierVersion(), nomExecutable());
/** Celui qui sert : `OXOAI_RTK_BIN` (intégrateur, batterie de sécurité), sinon celui de OxoAI. */
export const rtkUtilise = (): string => process.env.OXOAI_RTK_BIN || rtkDeOxoAI();

/** RTK peut-il être branché sur l'agent de code ici ? La raison sinon. */
export function rtkBranchable(): string | null {
  if (process.platform === "win32") return t("Sous Windows, les commandes de l'agent de code partent sans RTK.");
  if (!ARCHIVES[cible()] && !process.env.OXOAI_RTK_BIN) return tf("RTK n'est pas publié pour ce système ({0}).", cible());
  return null;
}

export interface EtatInstallationRtk {
  enCours: boolean;
  pourcent: number | null;
  erreur: string | null;
}

const etat: EtatInstallationRtk = { enCours: false, pourcent: null, erreur: null };
export const etatInstallationRtk = (): EtatInstallationRtk => ({ ...etat });

let enCours: Promise<string> | null = null;

/** Pose RTK s'il ne l'est pas ; une installation à la fois. Rend l'exécutable. */
export function installerRtk(): Promise<string> {
  if (existsSync(rtkDeOxoAI())) return Promise.resolve(rtkDeOxoAI());
  if (!enCours) {
    Object.assign(etat, { enCours: true, pourcent: 0, erreur: null });
    enCours = installer()
      .catch((err: unknown) => {
        etat.erreur = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        etat.enCours = false;
        enCours = null;
      });
  }
  return enCours;
}

async function installer(): Promise<string> {
  const attendu = ARCHIVES[cible()];
  if (!attendu) throw new Error(tf("RTK n'est pas publié pour ce système ({0}).", cible()));
  const tar = tarDuSysteme();

  let reponse: Response;
  try {
    reponse = await fetch(`${DEPOT}/v${VERSION}/${attendu.fichier}`, { signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    throw new Error(t("github.com est injoignable : vérifiez l'accès à internet de cette machine, puis réessayez."));
  }
  if (!reponse.ok || !reponse.body) throw new Error(tf("Téléchargement de RTK impossible (HTTP {0}).", reponse.status));

  mkdirSync(racine(), { recursive: true, mode: 0o700 });
  // Dans un dossier à soi (0700), pas dans le dossier temporaire commun (même règle que pythonPrive.ts).
  const travail = mkdtempSync(join(racine(), ".telechargement-"));
  try {
    const archive = join(travail, attendu.fichier);
    const empreinte = createHash("sha256");
    let recu = 0;
    const flux = Readable.fromWeb(reponse.body as import("node:stream/web").ReadableStream<Uint8Array>);
    flux.on("data", (morceau: Buffer) => {
      empreinte.update(morceau);
      recu += morceau.length;
      if (recu > attendu.octets) flux.destroy(new Error("trop gros"));
      etat.pourcent = Math.min(99, Math.round((recu / attendu.octets) * 100));
    });
    try {
      await pipeline(flux, createWriteStream(archive, { mode: 0o600, flags: "wx" }));
    } catch {
      throw new Error(t("Le téléchargement de RTK s'est interrompu : vérifiez la connexion, puis réessayez."));
    }
    if (empreinte.digest("hex") !== attendu.sha256) {
      throw new Error(t("L'archive de RTK ne correspond pas à son empreinte : elle a été effacée sans être ouverte."));
    }

    const extrait = join(travail, "contenu");
    mkdirSync(extrait);
    const sortie = await new Promise<string | null>((resolve) =>
      execFile(tar, ["-xf", archive, "-C", extrait], { timeout: 5 * 60_000 }, (err, _o, e) => resolve(err ? String(e || err.message) : null)),
    );
    const exe = join(extrait, nomExecutable());
    if (sortie !== null || !existsSync(exe)) {
      throw new Error(tf("RTK n'a pas pu être décompressé : {0}", (sortie ?? t("archive incomplète")).slice(-200)));
    }
    if (process.platform !== "win32") chmodSync(exe, 0o755);

    // Vérifié avant d'être mis en place : il doit démarrer et dire sa version (« rtk 0.50.0 »).
    const essai = await new Promise<string>((resolve) =>
      execFile(exe, ["--version"], { timeout: 30_000, windowsHide: true, env: { ...process.env, ...ENV_RTK } }, (err, o) => resolve(err ? "" : String(o).trim())),
    );
    if (essai !== `rtk ${VERSION}`) throw new Error(t("RTK s'est installé mais ne démarre pas sur cette machine."));

    rmSync(dossierVersion(), { recursive: true, force: true });
    mkdirSync(racine(), { recursive: true, mode: 0o700 });
    renommer(extrait, dossierVersion());
    etat.pourcent = 100;
    console.log(`[oxoai] RTK ${VERSION} posé dans ${dossierVersion()}.`);
    return rtkDeOxoAI();
  } finally {
    rmSync(travail, { recursive: true, force: true });
  }
}

export type VerdictRtkEnFond = "profil" | "non-branchable" | "en-cours" | "present" | "lancee";

/**
 * RTK posé de lui-même, en arrière-plan, au démarrage de l'agent de code
 * (`ensureServer`, opencode.ts), comme OpenCode : rien si le profil réserve
 * les installations à l'intégrateur, si RTK ne peut pas être branché ici, ou
 * s'il est déjà là. Un échec (hors ligne) ne bloque rien : les commandes
 * partent sans RTK, et l'état le dit.
 */
export function rtkEnFond(): VerdictRtkEnFond {
  if (!autoProvisionEnabled()) return "profil";
  if (rtkBranchable() !== null) return "non-branchable";
  if (etat.enCours) return "en-cours";
  if (existsSync(rtkUtilise())) return "present";
  console.log("[oxoai] Installation de RTK en arrière-plan.");
  void installerRtk().catch((err: unknown) => console.warn(`[oxoai] RTK non installé : ${err instanceof Error ? err.message : String(err)}`));
  return "lancee";
}

/* ── L'enveloppe du shell ──────────────────────────────────────────────── */

/**
 * Le shell qu'OpenCode 1.18.32 aurait pris sans l'enveloppe : `SHELL` s'il
 * désigne un fichier (et ni fish ni nu, qu'il refuse pour l'outil `bash`),
 * sinon `/bin/zsh` sur Mac (sa valeur de repli, lue dans son code) et un
 * shell POSIX ailleurs.
 */
export function shellReel(): string {
  const voulu = process.env.SHELL ?? "";
  if (voulu && isAbsolute(voulu) && !["fish", "nu"].includes(basename(voulu).toLowerCase())) {
    try {
      if (statSync(voulu).isFile()) return voulu;
    } catch {
      /* absent : repli */
    }
  }
  const replis = process.platform === "darwin" ? ["/bin/zsh", "/bin/sh"] : ["/bin/bash", "/bin/sh"];
  return replis.find((c) => existsSync(c)) ?? "/bin/sh";
}

/** Une valeur entre apostrophes pour sh : rien n'y est interprété. */
const litteral = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

/**
 * Écrit l'enveloppe et rend son chemin (le réglage `shell` d'OpenCode), ou
 * `null` là où RTK ne se branche pas (Windows) : OpenCode garde alors son
 * propre choix, comme avant.
 *
 * Réécrite à chaque démarrage d'OpenCode : une modification par une commande
 * de l'agent ne survit pas au suivant. Sans `OXOAI_RTK_DB` (session sans RTK,
 * ou tout autre usage d'OpenCode), elle ne fait que passer la main au vrai
 * shell, avec les mêmes arguments.
 */
export function ecrireEnveloppe(): string | null {
  if (rtkBranchable() !== null) return null;
  mkdirSync(racine(), { recursive: true, mode: 0o700 });
  mkdirSync(dossierBases(), { recursive: true, mode: 0o700 });
  const rtk = rtkUtilise();
  ecrireRtkDesCommandes(rtk);
  const script = [
    "#!/bin/sh",
    "# Écrit par la passerelle OxoAI (gateway/src/rtk.ts) : ne pas modifier, réécrit à chaque démarrage de l'agent de code.",
    "# OpenCode lance ici chaque commande, déjà approuvée, sous la forme « -c <commande> ».",
    `REEL=${litteral(shellReel())}`,
    `RTK=${litteral(rtk)}`,
    `JOURNAL=${litteral(fichierReplis())}`,
    `CHEMIN=${litteral(dossierChemin())}`,
    'if [ "$#" -eq 2 ] && [ "$1" = "-c" ] && [ -n "${OXOAI_RTK_DB:-}" ]; then',
    '  if [ -x "$RTK" ]; then',
    '    REECRITE=$(RTK_TELEMETRY_DISABLED=1 RTK_RECALL=0 RTK_DB_PATH="$OXOAI_RTK_DB" "$RTK" rewrite "$2" 2>/dev/null)',
    "    CODE=$?",
    '    case "$CODE" in',
    "      0|3)",
    '        if [ -n "$REECRITE" ]; then',
    '          RTK_TELEMETRY_DISABLED=1; RTK_RECALL=0; RTK_DB_PATH="$OXOAI_RTK_DB"; PATH="$CHEMIN:$PATH"',
    "          export RTK_TELEMETRY_DISABLED RTK_RECALL RTK_DB_PATH PATH",
    '          exec "$REEL" -c "$REECRITE"',
    "        fi",
    "        ;;",
    "      1|2) ;;",
    `      *) printf '%s rtk rewrite a échoué (code %s) : commande lancée sans RTK\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$CODE" >> "$JOURNAL" 2>/dev/null ;;`,
    "    esac",
    "  else",
    `    printf '%s RTK absent (%s) : commande lancée sans RTK\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$RTK" >> "$JOURNAL" 2>/dev/null`,
    "  fi",
    "fi",
    'exec "$REEL" "$@"',
    "",
  ].join("\n");
  const chemin = cheminEnveloppe();
  writeFileSync(chemin, script, { encoding: "utf8", mode: 0o700 });
  chmodSync(chemin, 0o700);
  return chemin;
}

/**
 * Sous-commandes de RTK qu'une commande de l'agent ne lance pas : elles
 * changent sa configuration ou sa confiance (`trust`, `untrust`, `init`,
 * `config`, `telemetry`, `hook`), ou lisent l'historique de Claude Code de la
 * personne (`discover`, `session`, `learn`, `cc-economics`), hors du projet.
 */
const SOUS_COMMANDES_REFUSEES = ["trust", "untrust", "init", "config", "telemetry", "hook", "discover", "session", "learn", "cc-economics"];

/**
 * Le `rtk` que trouve une commande réécrite (le dossier `chemin`, en tête de
 * son PATH), à la place du vrai.
 *
 * Tournée finale de la 2026.928.6 (SECURITE.md § 53). Les filtres d'un projet
 * (`.rtk/filters.toml`) ne devaient valoir qu'après `rtk trust`. Mais RTK
 * 0.50.0 les applique sans cela quand la commande porte
 * `RTK_TRUST_PROJECT_FILTERS=1` et une variable d'intégration continue
 * (`GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`, `BUILDKITE`), et une commande
 * réécrite avait le vrai `rtk` dans son PATH : `rtk trust --yes` y marchait,
 * pour de bon (la confiance est gardée dans les réglages de RTK de la
 * personne, hors de OxoAI). Essayé avec le vrai RTK : un dépôt dont le filtre
 * retire tout et écrit « tous les tests passent » faisait lire cette phrase au
 * modèle à la place d'un échec, après `GITHUB_ACTIONS=true
 * RTK_TRUST_PROJECT_FILTERS=1 make test`.
 *
 * Ce `rtk`-ci retire `RTK_TRUST_PROJECT_FILTERS`, remet la télémétrie et la
 * copie des sorties coupées (une commande pouvait les rallumer en les
 * écrivant devant `rtk`), refuse les sous-commandes ci-dessus, puis passe la
 * main au vrai. Une commande qui nommerait le vrai par son chemin, dans les
 * données de OxoAI, le montre en entier sur sa carte.
 */
function ecrireRtkDesCommandes(rtk: string): void {
  mkdirSync(dossierChemin(), { recursive: true, mode: 0o700 });
  const script = [
    "#!/bin/sh",
    "# Écrit par la passerelle OxoAI (gateway/src/rtk.ts) : le rtk que trouvent les commandes réécrites de l'agent de code.",
    `VRAI=${litteral(rtk)}`,
    "unset RTK_TRUST_PROJECT_FILTERS",
    "RTK_TELEMETRY_DISABLED=1; RTK_RECALL=0",
    "export RTK_TELEMETRY_DISABLED RTK_RECALL",
    'for ARG in "$@"; do',
    '  case "$ARG" in',
    "    -*) continue ;;",
    `    ${SOUS_COMMANDES_REFUSEES.join("|")})`,
    "      printf 'rtk %s : refusé dans OxoAI Code (réglages et confiance de RTK, historique de la personne).\\n' \"$ARG\" >&2",
    "      exit 126 ;;",
    "  esac",
    "  break",
    "done",
    'exec "$VRAI" "$@"',
    "",
  ].join("\n");
  const chemin = join(dossierChemin(), "rtk");
  writeFileSync(chemin, script, { encoding: "utf8", mode: 0o700 });
  chmodSync(chemin, 0o700);
}

/* ── Les sessions où RTK sert ─────────────────────────────────────────── */

/** Le réglage de l'écran Code, envoyé avec chaque demande. */
export type ReglageRtk = "cloud" | "toujours" | "jamais";
export const lireReglageRtk = (v: unknown): ReglageRtk => (v === "toujours" || v === "jamais" ? v : "cloud");

/** Décidé à chaque demande : le réglage, et d'où vient le modèle (`origine` « cle » ou « agence » : un modèle cloud). */
export function rtkPourDemande(reglage: ReglageRtk, origine: string | undefined): boolean {
  if (reglage === "jamais") return false;
  if (reglage === "toujours") return true;
  return origine === "cle" || origine === "agence";
}

const SESSIONS_MAX = 500;
/** La mémoire fait foi ; le fichier n'en est que la copie lue par le greffon. */
let sessions: Map<string, string> | null = null;

function chargerSessions(): Map<string, string> {
  if (sessions) return sessions;
  sessions = new Map();
  try {
    const lu = JSON.parse(readFileSync(fichierSessions(), "utf8")) as Record<string, unknown>;
    for (const [id, racineSession] of Object.entries(lu)) {
      if (SESSION.test(id) && typeof racineSession === "string" && SESSION.test(racineSession)) sessions.set(id, racineSession);
    }
  } catch {
    /* absent ou illisible : rien à reprendre, les sessions sont renotées à leur prochaine demande */
  }
  return sessions;
}

function ecrireSessions(): void {
  const liste = chargerSessions();
  while (liste.size > SESSIONS_MAX) liste.delete(liste.keys().next().value!);
  try {
    mkdirSync(racine(), { recursive: true, mode: 0o700 });
    writeFileSync(fichierSessions(), JSON.stringify(Object.fromEntries(liste)), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(`[rtk] liste des sessions non écrite : ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Une demande part dans cette session : RTK y sert ou non, jusqu'à la suivante. */
export function noterRtkSession(sessionID: string, actif: boolean): void {
  if (!SESSION.test(sessionID)) return;
  const liste = chargerSessions();
  const avant = liste.get(sessionID);
  if (actif && avant === sessionID) return;
  if (!actif && avant === undefined) return;
  if (actif) {
    liste.delete(sessionID);
    liste.set(sessionID, sessionID);
    if (rtkBranchable() === null && !existsSync(rtkUtilise())) {
      console.log(`[rtk] absent : les commandes de la session ${sessionID} partent sans lui en attendant l'installation.`);
      rtkEnFond();
    }
  } else {
    for (const [id, r] of liste) if (id === sessionID || r === sessionID) liste.delete(id);
  }
  ecrireSessions();
}

/** Un sous-agent (outil `task`) : ses commandes suivent le réglage de la session qui l'a lancé, et comptent pour elle. */
export function rtkSousSession(enfant: string, parent: string): void {
  const liste = chargerSessions();
  const racineSession = liste.get(parent);
  if (!racineSession || !SESSION.test(enfant) || liste.get(enfant) === racineSession) return;
  liste.set(enfant, racineSession);
  ecrireSessions();
}

export const rtkActifDans = (sessionID: string): boolean => chargerSessions().has(sessionID);

/**
 * Le morceau du greffon d'environnement d'OpenCode (opencode.ts) qui donne
 * `OXOAI_RTK_DB` aux commandes des sessions notées, et une valeur vide aux
 * autres. Relu à chaque commande : un changement de réglage vaut dès la
 * commande suivante, sans redémarrer OpenCode.
 */
export function codeGreffonRtk(): string[] {
  return [
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `const RTK_SESSIONS = ${JSON.stringify(fichierSessions())};`,
    `const RTK_BASES = ${JSON.stringify(dossierBases())};`,
    "const baseRtk = (session) => {",
    "  try {",
    '    const racine = JSON.parse(readFileSync(RTK_SESSIONS, "utf8"))[session];',
    '    return typeof racine === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(racine) ? join(RTK_BASES, racine + ".db") : "";',
    "  } catch {",
    '    return "";',
    "  }",
    "};",
  ];
}

/* ── Ce que RTK a mesuré, et ses replis ────────────────────────────────── */

export interface EconomiesRtk {
  commandes: number;
  jetons: number;
}

/**
 * Jetons économisés dans une session, d'après l'historique que RTK tient
 * lui-même (`rtk gain --format json`, estimation de RTK : environ quatre
 * caractères par jeton). Lu sur ce poste, rien n'est envoyé nulle part.
 */
export async function economiesSession(sessionID: string): Promise<EconomiesRtk | null> {
  const racineSession = chargerSessions().get(sessionID) ?? (SESSION.test(sessionID) ? sessionID : null);
  if (!racineSession) return null;
  const base = join(dossierBases(), `${racineSession}.db`);
  const rtk = rtkUtilise();
  if (!existsSync(base) || !existsSync(rtk)) return null;
  const sortie = await new Promise<string>((resolve) =>
    execFile(
      rtk,
      ["gain", "--format", "json"],
      {
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 1 << 20,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homedir(), ...ENV_RTK, RTK_DB_PATH: base },
      },
      (err, o) => resolve(err ? "" : String(o)),
    ),
  );
  try {
    const debut = sortie.indexOf("{");
    const lu = JSON.parse(sortie.slice(debut)) as { summary?: { total_commands?: unknown; total_saved?: unknown } };
    const commandes = Number(lu.summary?.total_commands);
    const jetons = Number(lu.summary?.total_saved);
    if (!Number.isFinite(commandes) || !Number.isFinite(jetons)) return null;
    return { commandes, jetons: Math.max(0, Math.round(jetons)) };
  } catch {
    return null;
  }
}

let replisLus = 0;
/** Les replis notés par l'enveloppe depuis la dernière lecture, au journal de la passerelle. */
export function relayerReplis(): void {
  const fichier = fichierReplis();
  try {
    const taille = statSync(fichier).size;
    if (taille < replisLus) replisLus = 0;
    if (taille === replisLus) return;
    const longueur = Math.min(taille - replisLus, 64 * 1024);
    const tampon = Buffer.alloc(longueur);
    const fd = openSync(fichier, "r");
    try {
      readSync(fd, tampon, 0, longueur, taille - longueur);
    } finally {
      closeSync(fd);
    }
    replisLus = taille;
    for (const ligne of tampon.toString("utf8").split("\n").filter(Boolean).slice(-20)) console.warn(`[rtk] repli : ${ligne}`);
  } catch {
    /* aucun repli noté */
  }
}

/** Bases de plus de 90 jours (la durée que RTK garde lui-même) : retirées au démarrage de l'agent de code. */
export function menageBases(): void {
  const limite = Date.now() - 90 * 24 * 3600_000;
  try {
    for (const f of readdirSync(dossierBases())) {
      if (!/^[A-Za-z0-9_-]{1,64}\.db(-wal|-shm)?$/.test(f)) continue;
      const chemin = join(dossierBases(), f);
      if (statSync(chemin).mtimeMs < limite) unlinkSync(chemin);
    }
  } catch {
    /* dossier absent : rien à faire */
  }
}

/** Ce que l'écran Code montre de RTK. */
export function etatRtk(): { version: string; branchable: boolean; raison: string | null; installe: boolean; installation: EtatInstallationRtk } {
  const raison = rtkBranchable();
  return { version: VERSION, branchable: raison === null, raison, installe: existsSync(rtkUtilise()), installation: etatInstallationRtk() };
}
