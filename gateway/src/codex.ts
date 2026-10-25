import type http from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { t, tf } from "./langue.ts";
import { journaliser } from "./audit.ts";
import { entetesFlux } from "./entetes.ts";
import { niveau as niveauApprobation, type Niveau } from "./approbation.ts";
import { projectDir, validerDossier } from "./opencode.ts";
import { arreterArbre } from "./processus.ts";
import {
  argumentsTache,
  bacASable,
  etatTraduction,
  masquer,
  refusCodex,
  SESSION_CODEX,
  traduireCodex,
  type BacCodex,
  type ContexteCodex,
  type EvenementCodex,
} from "./codexGarde.ts";

/**
 * Codex, second moteur de l'écran Code, avec le compte ChatGPT de la personne.
 *
 * ── Ce qui a été décidé, et pourquoi c'est étroit ───────────────────────────
 *
 * Décidé par Medhi le 27/09/2026 (PROJET.md § 3.14, qui fait exception au
 * § 3.1 « un seul moteur ») : OxoAI pilote le programme `codex` **officiel**,
 * installé et connecté par la personne, par le parcours d'OpenAI, pour son
 * propre usage. C'est la forme qu'OpenAI décrit (« Integrate Codex within your
 * own application », page Codex SDK ; `codex exec` reprend la connexion
 * enregistrée, page « Non-interactive mode »). Tout le reste est écarté :
 *
 *  - OxoAI n'ouvre, ne lit, ne copie ni ne transmet jamais `~/.codex` ni aucun
 *    jeton. Ce module ne lit **aucun fichier** : il cherche un exécutable par
 *    son chemin, et demande tout le reste au programme lui-même
 *    (`codex --version`, `codex login status`). `~/.codex` reste une zone
 *    protégée pour les agents (zonesProtegees.ts) ;
 *  - OxoAI n'installe pas `codex` : c'est le logiciel d'un tiers, dont la
 *    personne accepte elle-même les conditions. L'écran donne la commande
 *    officielle ;
 *  - la connexion se fait par `codex login` : le navigateur de la personne
 *    s'ouvre chez OpenAI, OxoAI ne voit passer aucun jeton ;
 *  - réservé au propriétaire du poste (codexGarde.ts, `refusCodex`), vérifié
 *    ici à chaque route, pas seulement à l'écran.
 *
 * ── Exécution ───────────────────────────────────────────────────────────────
 *
 * `codex exec --json` dans le dossier du projet, la demande sur l'entrée
 * standard, le flux JSONL traduit en évènements de l'écran Code. L'app-server
 * relaierait mieux les demandes d'approbation vers la barrière de OxoAI, mais
 * OpenAI le dit expérimental (page « Codex app-server », 27/09/2026) : à
 * reprendre quand il ne le sera plus. D'ici là, `codex exec` ne demande rien
 * (`approval_policy = never`) et c'est le bac à sable qui borne ce qu'il fait,
 * jamais plus large que le niveau de OxoAI (codexGarde.ts, `bacASable`).
 *
 * Pas essayé avec un vrai compte le 27/09/2026 : la batterie de sécurité
 * joue un faux `codex` (scripts/faux-codex.mjs).
 */

/* ------------------------------------------------------------------ */
/* Trouver le programme                                                */
/* ------------------------------------------------------------------ */

/** Un programme à lancer : l'exécutable, et ce qui le précède (un script `.js` lancé par `node`). */
interface Programme {
  commande: string;
  prefixe: string[];
  /** Où il a été trouvé, pour l'écran. */
  chemin: string;
}

const executable = (chemin: string): boolean => {
  try {
    if (!statSync(chemin).isFile()) return false;
    if (process.platform !== "win32") accessSync(chemin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Les `bin` des versions de Node posées par nvm : un `npm install -g` y met `codex`. */
function binsNvm(): string[] {
  const racine = join(homedir(), ".nvm", "versions", "node");
  try {
    return readdirSync(racine).map((v) => join(racine, v, "bin"));
  } catch {
    return [];
  }
}

/** `node` trouvé par le PATH, pour lancer le script de `@openai/codex` sous Windows. */
function nodeDuPath(): string | null {
  for (const d of (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean)) {
    const c = join(d, process.platform === "win32" ? "node.exe" : "node");
    if (executable(c)) return c;
  }
  return null;
}

/**
 * Où chercher `codex`. `OXOAI_CODEX_BIN` d'abord : un intégrateur fixe ainsi
 * la version qu'il a éprouvée, et la batterie y met son faux programme. Puis
 * le PATH, puis les emplacements habituels d'une installation par npm ou
 * Homebrew, qu'une application ouverte depuis le Dock ne reçoit pas toujours
 * dans son PATH.
 *
 * Jamais sous `~/.codex` : c'est là que Codex range ses jetons, et OxoAI n'y
 * regarde pas, même pour chercher un exécutable. L'installateur d'OpenAI qui y
 * poserait le programme (`install.sh`) le met aussi dans le PATH du shell ;
 * s'il n'est pas dans celui de l'application, `OXOAI_CODEX_BIN` le désigne.
 *
 * Sous Windows (pas essayé sur un vrai Windows le 27/09/2026) : `codex.exe`
 * dans le PATH ou le dossier des liens de WinGet ; l'installation par npm pose
 * un `codex.cmd` que Node refuse de lancer sans interpréteur, on lance donc le
 * script du paquet par `node` (disposition relevée dans le paquet
 * `@openai/codex`, `bin/codex.js`).
 */
export function trouverCodex(): Programme | null {
  const impose = process.env.OXOAI_CODEX_BIN;
  if (impose) return executable(impose) ? { commande: impose, prefixe: [], chemin: impose } : null;

  const maison = homedir();
  const path = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "win32") {
    const dossiers = [...path, ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")] : [])];
    for (const d of dossiers) {
      const c = join(d, "codex.exe");
      if (executable(c)) return { commande: c, prefixe: [], chemin: c };
    }
    const script = process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : "";
    const node = script && existsSync(script) ? nodeDuPath() : null;
    return node ? { commande: node, prefixe: [script], chemin: script } : null;
  }
  const dossiers = [
    ...path,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(maison, ".local", "bin"),
    join(maison, ".npm-global", "bin"),
    join(maison, ".volta", "bin"),
    join(maison, ".bun", "bin"),
    ...binsNvm(),
    "/usr/bin",
  ];
  for (const d of [...new Set(dossiers)]) {
    const c = join(d, "codex");
    if (executable(c)) return { commande: c, prefixe: [], chemin: c };
  }
  return null;
}

/**
 * L'environnement de `codex` : ce qu'un programme attend (chemins, langue,
 * compte, dossier temporaire), le réglage de Codex choisi par la personne
 * (`CODEX_HOME`), et le mandataire réseau d'une entreprise. Rien d'autre :
 * ni le jeton de l'instance, ni les clés de fournisseurs de la passerelle,
 * ni `OPENAI_API_KEY` ou `CODEX_API_KEY`, qui feraient facturer une clé
 * d'API au lieu de l'abonnement connecté par `codex login`.
 */
const TRANSMISES = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "LOGNAME", "SHELL", "TZ", "TERM",
  "CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  "SystemRoot", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP", "ComSpec", "PATHEXT", "windir"];

function environnementCodex(p: Programme): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [nom, valeur] of Object.entries(process.env)) {
    if (valeur === undefined) continue;
    const transmise = process.platform === "win32" ? TRANSMISES.some((x) => x.toUpperCase() === nom.toUpperCase()) : TRANSMISES.includes(nom);
    if (transmise || nom.startsWith("LC_")) env[nom] = valeur;
  }
  // Le dossier du programme en tête du PATH : un `codex` posé par npm sous nvm y trouve son `node`.
  const cle = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[cle] = [dirname(p.commande), env[cle]].filter(Boolean).join(delimiter);
  return env;
}

/** Lance `codex` pour une réponse courte (version, état de connexion). Aucune entrée, délai borné. */
function demander(p: Programme, args: string[], delai = 15_000): Promise<{ code: number | null; sortie: string }> {
  return new Promise((ok) => {
    execFile(
      p.commande,
      [...p.prefixe, ...args],
      { env: environnementCodex(p), cwd: homedir(), timeout: delai, maxBuffer: 256 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
        ok({ code, sortie: `${stdout ?? ""}\n${stderr ?? ""}`.trim() });
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */

interface Detection {
  installe: boolean;
  chemin?: string;
  version?: string;
  connecte: boolean;
  /** Comment `codex` dit être connecté : par ChatGPT (l'abonnement), par une clé d'API, ou autre chose. */
  mode?: "chatgpt" | "cle" | "autre";
  /** La première ligne de `codex login status`, masquée. */
  detail?: string;
}

let detection: { quand: number; valeur: Detection } | null = null;
/** Une détection sert dix secondes : l'écran relit l'état à chaque ouverture. */
const DETECTION_MS = 10_000;

async function detecter(forcer = false): Promise<Detection> {
  if (!forcer && detection && Date.now() - detection.quand < DETECTION_MS) return detection.valeur;
  const p = trouverCodex();
  let valeur: Detection;
  if (!p) {
    valeur = { installe: false, connecte: false };
  } else {
    const version = await demander(p, ["--version"]);
    /*
     * `codex login status` : « exits 0 when credentials present » (page
     * « Developer commands », 27/09/2026). Le texte dit le mode ; on n'en
     * garde que la première ligne, masquée.
     */
    const etat = await demander(p, ["login", "status"]);
    const ligne = masquer(etat.sortie.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 200);
    const connecte = etat.code === 0;
    valeur = {
      installe: true,
      chemin: p.chemin,
      version: version.sortie.match(/\d+\.\d+\.\d+[\w.+-]*/)?.[0],
      connecte,
      ...(connecte ? { mode: /chatgpt/i.test(ligne) ? ("chatgpt" as const) : /api key|clé/i.test(ligne) ? ("cle" as const) : ("autre" as const) } : {}),
      ...(ligne ? { detail: ligne } : {}),
    };
  }
  detection = { quand: Date.now(), valeur };
  return valeur;
}

/** Commandes d'installation officielles (README de openai/codex, relu le 27/09/2026). */
function installation(): { commandes: string[]; source: string } {
  return {
    commandes: process.platform === "darwin" ? ["npm install -g @openai/codex", "brew install --cask codex"] : ["npm install -g @openai/codex"],
    source: "https://github.com/openai/codex",
  };
}

/* ------------------------------------------------------------------ */
/* Connexion                                                           */
/* ------------------------------------------------------------------ */

let connexion: { enfant: ChildProcess; debut: number; par: string } | null = null;
/** Au-delà, la connexion est abandonnée : la personne a fermé l'onglet du navigateur. */
const CONNEXION_MAX_MS = 10 * 60_000;

/**
 * Lance `codex login` : Codex ouvre le navigateur de la personne chez OpenAI,
 * attend son retour sur la boucle locale, et range lui-même ce qu'il reçoit.
 * OxoAI ne lit rien de ce que le programme écrit (sa sortie porte l'adresse
 * de connexion, avec son `state`) : il attend la fin, puis redemande l'état.
 */
function lancerConnexion(p: Programme, par: string): void {
  const enfant = spawn(p.commande, [...p.prefixe, "login"], {
    env: environnementCodex(p),
    cwd: homedir(),
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const minuterie = setTimeout(() => arreterArbre(enfant), CONNEXION_MAX_MS);
  connexion = { enfant, debut: Date.now(), par };
  const finir = () => {
    clearTimeout(minuterie);
    if (connexion?.enfant === enfant) connexion = null;
    detection = null;
  };
  enfant.on("exit", finir);
  enfant.on("error", finir);
}

/* ------------------------------------------------------------------ */
/* Tâches                                                              */
/* ------------------------------------------------------------------ */

/**
 * Les sessions ouvertes par cette passerelle : leur titulaire et leur dossier.
 * Une reprise ne vaut que pour l'une d'elles, dans son dossier : un
 * identifiant fabriqué ne fait pas rouvrir une autre conversation de Codex.
 * En mémoire seulement : après un redémarrage, on repart d'une session neuve.
 */
const sessions = new Map<string, { userId: string; dossier: string }>();

/** Une tâche à la fois : l'abonnement est celui d'une personne, qui ne tape qu'une demande à la fois. */
let tache: { enfant: ChildProcess; userId: string; arretee: boolean } | null = null;
/** Une tâche plus longue est arrêtée : rien ne tourne indéfiniment sur le compte de la personne. */
const TACHE_MAX_MS = 60 * 60_000;
const DEMANDE_MAX = 100_000;

export interface EtatCodex {
  /** L'écran peut-il proposer Codex à cette personne, sur ce poste ? */
  propose: boolean;
  refus?: { code: string; message: string };
  installe: boolean;
  chemin?: string;
  version?: string;
  connecte: boolean;
  mode?: Detection["mode"];
  detail?: string;
  connexionEnCours: boolean;
  tacheEnCours: boolean;
  niveau: Niveau;
  /** Le bac à sable que recevrait Codex au niveau actuel ; `null` : pas proposé à ce niveau. */
  bac: BacCodex | null;
  installation: { commandes: string[]; source: string };
}

async function etat(contexte: ContexteCodex, forcer = false): Promise<EtatCodex> {
  const niveau = niveauApprobation();
  const base = { connexionEnCours: Boolean(connexion), tacheEnCours: Boolean(tache), niveau, bac: bacASable(niveau), installation: installation() };
  const refus = refusCodex(contexte);
  // Refusé : on ne lance même pas `codex` pour le détecter. L'état du compte de quelqu'un d'autre ne regarde pas la personne.
  if (refus) return { propose: false, refus, installe: false, connecte: false, ...base };
  const d = await detecter(forcer);
  return { propose: true, ...d, ...base };
}

/** Le dossier du projet : celui demandé, validé comme pour OpenCode, sinon celui de la personne. */
function dossierDe(demande: unknown, userId: string): { ok: true; chemin: string } | { ok: false; raison: string } {
  const brut = typeof demande === "string" && demande.trim() ? demande : projectDir(userId);
  return validerDossier(brut, "code");
}

const trame = (res: http.ServerResponse, e: EvenementCodex | { kind: "debut"; bac: BacCodex; dossier: string; reprise: boolean }) => {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
};

async function lancerTache(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  corps: Record<string, unknown>,
  envoyer: (status: number, body: unknown) => void,
): Promise<void> {
  const texte = typeof corps.texte === "string" ? corps.texte : "";
  if (!texte.trim()) return envoyer(400, { error: { message: t("Demande vide.") } });
  if (texte.length > DEMANDE_MAX) return envoyer(413, { error: { message: tf("Demande trop longue ({0} caractères au plus).", DEMANDE_MAX) } });

  let session: string | undefined;
  let dossier: string;
  if (corps.session !== undefined && corps.session !== null && corps.session !== "") {
    const id = String(corps.session);
    const connue = SESSION_CODEX.test(id) ? sessions.get(id) : undefined;
    if (!connue || connue.userId !== userId) return envoyer(400, { error: { message: t("Session Codex inconnue : ouvrez-en une nouvelle.") } });
    session = id;
    // Une reprise reste dans le dossier où la session est née.
    const verdict = validerDossier(connue.dossier, "code");
    if (!verdict.ok) return envoyer(400, { error: { message: verdict.raison } });
    dossier = verdict.chemin;
  } else {
    const verdict = dossierDe(corps.dossier, userId);
    if (!verdict.ok) return envoyer(400, { error: { message: verdict.raison } });
    dossier = verdict.chemin;
  }

  const bac = bacASable(niveauApprobation());
  if (!bac) {
    return envoyer(409, {
      error: { message: t("Au niveau « Demander pour tout », Codex n'est pas proposé : il lit et lance des commandes sans rien demander. Choisissez un autre niveau, ou OpenCode.") },
    });
  }
  if (tache) return envoyer(409, { error: { message: t("Codex travaille déjà sur une demande. Arrêtez-la ou attendez qu'elle finisse.") } });
  const p = trouverCodex();
  if (!p) return envoyer(409, { error: { message: t("Codex n'est pas installé sur ce poste.") } });
  const d = await detecter();
  if (!d.connecte) return envoyer(409, { error: { message: t("Codex n'est pas connecté. Connectez-le d'abord avec votre compte ChatGPT.") } });
  // Revu après l'attente de la détection : deux demandes arrivées ensemble passaient toutes deux le premier contrôle.
  if (tache) return envoyer(409, { error: { message: t("Codex travaille déjà sur une demande. Arrêtez-la ou attendez qu'elle finisse.") } });

  const args = argumentsTache(bac, session);
  const enfant = spawn(p.commande, [...p.prefixe, ...args], {
    env: environnementCodex(p),
    cwd: dossier,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const courante = { enfant, userId, arretee: false };
  tache = courante;
  journaliser("code.codex_tache", userId, { dossier, bac, reprise: Boolean(session) });

  res.writeHead(200, entetesFlux(req));
  trame(res, { kind: "debut", bac, dossier, reprise: Boolean(session) });

  const traduction = etatTraduction();
  let tampon = "";
  let termine = false;
  let erreurs = "";
  let fini = false;
  const minuterie = setTimeout(() => {
    courante.arretee = true;
    arreterArbre(enfant);
  }, TACHE_MAX_MS);

  const appliquer = (ligne: string) => {
    if (!ligne.trim()) return;
    let brut: unknown;
    try {
      brut = JSON.parse(ligne);
    } catch {
      return; // Une ligne qui n'est pas du JSON (avertissement) : rien à montrer.
    }
    for (const e of traduireCodex(brut, traduction)) {
      if (e.kind === "session") sessions.set(e.id, { userId, dossier });
      if (e.kind === "done" || e.kind === "error") termine = true;
      trame(res, e);
    }
  };
  enfant.stdout?.setEncoding("utf8");
  enfant.stdout?.on("data", (morceau: string) => {
    tampon += morceau;
    const lignes = tampon.split("\n");
    tampon = lignes.pop() ?? "";
    for (const l of lignes) appliquer(l);
  });
  enfant.stderr?.setEncoding("utf8");
  enfant.stderr?.on("data", (morceau: string) => {
    erreurs = (erreurs + morceau).slice(-4000);
  });

  const cloturer = (code: number | null, echec?: string) => {
    if (fini) return;
    fini = true;
    clearTimeout(minuterie);
    if (tampon) appliquer(tampon);
    if (tache === courante) tache = null;
    if (courante.arretee) {
      trame(res, { kind: "fin", note: t("Arrêté à votre demande.") });
      trame(res, { kind: "done" });
    } else if (!termine) {
      const derniere = masquer(erreurs.trim().split("\n").filter(Boolean).slice(-3).join("\n")).slice(0, 1000);
      trame(res, { kind: "error", message: echec ?? (derniere ? tf("Codex s'est arrêté (code {0}) : {1}", code ?? "?", derniere) : tf("Codex s'est arrêté (code {0}).", code ?? "?")) });
    }
    if (!res.writableEnded) res.end();
  };
  enfant.on("error", (err) => cloturer(null, tf("Codex n'a pas pu démarrer : {0}", err.message)));
  enfant.on("close", (code) => cloturer(code));
  // L'écran s'est fermé : Codex s'arrête avec lui, rien ne tourne sans personne pour le voir.
  res.on("close", () => {
    if (!fini) {
      courante.arretee = true;
      arreterArbre(enfant);
    }
  });

  enfant.stdin?.on("error", () => undefined);
  enfant.stdin?.end(texte);
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/** La passerelle a-t-elle été lancée par l'application de bureau ? (electron/main.cjs pose `OXOAI_BUREAU`.) */
export const surLeBureau = (): boolean => process.env.OXOAI_BUREAU === "1";

/** Requête venue de la machine elle-même, par la boucle locale. */
export const depuisLaBoucle = (req: http.IncomingMessage): boolean => {
  const a = (req.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
  return a === "127.0.0.1" || a === "::1";
};

export interface OutilsRouteCodex {
  userId: string;
  contexte: ContexteCodex;
  lireCorps: () => Promise<unknown>;
  envoyer: (status: number, body: unknown) => void;
}

/**
 * `GET /oxoai/codex` : l'état (proposé ou non, installé, connecté, niveau) ;
 * `POST /oxoai/codex/connexion` et `/connexion/annuler` ; `POST
 * /oxoai/codex/tache` (flux d'évènements en réponse) ; `POST
 * /oxoai/codex/arreter`. La séance est déjà vérifiée par index.ts ; tout le
 * reste l'est ici.
 */
export async function routeCodex(req: http.IncomingMessage, res: http.ServerResponse, chemin: string, o: OutilsRouteCodex): Promise<void> {
  const { userId, contexte, envoyer } = o;
  if (req.method === "GET" && chemin === "/oxoai/codex") {
    return envoyer(200, await etat(contexte, new URL(req.url ?? "/", "http://x").searchParams.get("relire") === "1"));
  }
  if (req.method !== "POST") return envoyer(404, { error: { message: tf("Route inconnue : {0} {1}", req.method, chemin) } });

  const refus = refusCodex(contexte);
  if (refus) return envoyer(refus.code === "adresse" ? 400 : 403, { error: { message: refus.message, code: `codex_${refus.code}` } });

  if (chemin === "/oxoai/codex/connexion") {
    const p = trouverCodex();
    if (!p) return envoyer(409, { error: { message: t("Codex n'est pas installé sur ce poste.") } });
    if (!connexion) {
      lancerConnexion(p, userId);
      journaliser("code.codex_connexion", userId, {});
    }
    return envoyer(202, { started: true });
  }
  if (chemin === "/oxoai/codex/connexion/annuler") {
    if (connexion) arreterArbre(connexion.enfant);
    return envoyer(200, { ok: true });
  }
  if (chemin === "/oxoai/codex/tache") {
    const corps = await o.lireCorps().catch(() => ({}));
    return lancerTache(req, res, userId, (corps && typeof corps === "object" ? corps : {}) as Record<string, unknown>, envoyer);
  }
  if (chemin === "/oxoai/codex/arreter") {
    if (!tache || tache.userId !== userId) return envoyer(404, { error: { message: t("Aucune tâche Codex en cours.") } });
    tache.arretee = true;
    arreterArbre(tache.enfant);
    return envoyer(200, { ok: true });
  }
  return envoyer(404, { error: { message: tf("Route inconnue : {0} {1}", req.method, chemin) } });
}

/** Arrêt de la passerelle : rien de Codex ne lui survit. */
export function arreterCodex(): void {
  if (tache) arreterArbre(tache.enfant);
  if (connexion) arreterArbre(connexion.enfant);
}
