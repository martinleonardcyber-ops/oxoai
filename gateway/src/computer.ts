import { execFile } from "node:child_process";
import { readFile, unlink, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configEcran, modeModifiable, type SourceEcran } from "./reglagesEcran.ts";
import { resolve } from "./router.ts";
import { journaliser } from "./audit.ts";
import * as approbation from "./approbation.ts";
import { nomProduit } from "./marque.ts";
import { langue, t, tf } from "./langue.ts";
import { existsSync, statSync, readFileSync as lireFichier, writeFileSync } from "node:fs";
import { adresseMachine, applicationMachine, applicationsDisponibles, dossierEchange, echangeDansLaMachine, systemeMachine } from "./machine.ts";
import { relireDocument } from "./relecture.ts";
import { canalOuvert, ecouterLApplication, envoyerALApplication } from "./canalApplication.ts";

/**
 * Contrôle de l'écran (ADR-011).
 *
 * Deux environnements d'exécution, choisis dans le profil de déploiement :
 *
 *  - `sandbox` : une machine virtuelle dédiée, pilotée par cua/Lume. L'agent ne
 *    touche jamais la machine de l'utilisateur. C'est le mode recommandé.
 *  - `hote`    : la machine réelle. Utile pour les tâches qui portent sur les
 *    vrais fichiers et les vrais logiciels de l'utilisateur, mais toute erreur
 *    de l'agent est une erreur sur son poste.
 *  - `desactive` : par défaut. Aucune route de contrôle ne fonctionne.
 *
 * Sur l'hôte macOS, aucun binaire tiers n'est requis :
 *  - la capture passe par `screencapture` et `sips`, tous deux fournis par le
 *    système ;
 *  - la souris passe par des évènements CoreGraphics, via le pont ObjC de
 *    JavaScript for Automation ;
 *  - le clavier passe par `System Events`, qui sait déjà saisir du texte et
 *    les raccourcis avec modificateurs.
 *
 * Les deux autorisations macOS nécessaires (Enregistrement de l'écran,
 * Accessibilité) sont accordées à l'application OxoAI, pas à la passerelle :
 * elles se demandent au premier usage et se vérifient ici.
 */

const exec = (cmd: string, args: string[], timeout = 20_000) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number"
        ? (err as { code: number }).code
        : err
          ? 1
          : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const jxa = (script: string) => exec("osascript", ["-l", "JavaScript", "-e", script]);
const applescript = (script: string) => exec("osascript", ["-e", script]);

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export type ActionName =
  | "capture"
  | "deplacer"
  | "cliquer"
  | "double_cliquer"
  | "clic_droit"
  | "glisser"
  | "defiler"
  | "saisir"
  | "touche"
  | "ouvrir_app"
  | "attendre"
  /** Machine de l'agent seulement : enregistre le document ouvert dans le dossier d'échange. */
  | "enregistrer_document"
  /** Machine de l'agent seulement : tape un tableau dans le tableur, cellule par cellule. */
  | "saisir_tableau";

export interface Action {
  action: ActionName;
  x?: number;
  y?: number;
  /** Point d'arrivée d'un glisser. */
  x2?: number;
  y2?: number;
  texte?: string;
  /** Touche ou raccourci : « entree », « echap », « cmd+s »... */
  touche?: string;
  direction?: "haut" | "bas" | "gauche" | "droite";
  /** `saisir_tableau` : lignes de cellules, et cellule de départ (« A1 »). */
  lignes?: string[][];
  cellule?: string;
  /** Crans de molette, ou millisecondes pour « attendre ». */
  quantite?: number;
}

/** Formulation lisible du sens de défilement. */
const SENS: Record<NonNullable<Action["direction"]>, string> = {
  haut: "le haut",
  bas: "le bas",
  gauche: "la gauche",
  droite: "la droite",
};

/** Actions qui ne modifient rien : elles ne demandent pas d'approbation. */
const LECTURE = new Set<ActionName>(["capture", "attendre", "deplacer"]);

export const isReadOnly = (action: ActionName): boolean => LECTURE.has(action);

/* ------------------------------------------------------------------ */
/* Écran                                                               */
/* ------------------------------------------------------------------ */

/**
 * Largeur de la capture envoyée au modèle.
 *
 * Chaque pixel coûte : une capture de 1280 px fait basculer un Mac de 16 Go en
 * mémoire virtuelle et le modèle met plusieurs minutes à la lire, contre une
 * vingtaine de secondes à 1024 px. C'est le compromis retenu — assez fin pour
 * viser un bouton, assez léger pour rester utilisable sur une machine modeste.
 * L'intégrateur peut l'ajuster pour un cluster plus généreux.
 */
const MAX_LARGEUR = Number(process.env.OXOAI_CAPTURE_LARGEUR ?? 1024);

export interface Capture {
  /** Image PNG encodée en base64, redimensionnée pour le modèle. */
  base64: string;
  /** Taille de l'image transmise. Les coordonnées du modèle sont dans ce repère. */
  largeur: number;
  hauteur: number;
}

/** Taille logique de l'écran, en points — le repère des clics. */
async function logicalScreen(): Promise<{ largeur: number; hauteur: number } | null> {
  const { code, stdout } = await jxa(
    `ObjC.import('CoreGraphics');var d=$.CGMainDisplayID();` +
      `JSON.stringify({w:Number($.CGDisplayPixelsWide(d)),h:Number($.CGDisplayPixelsHigh(d))})`,
  );
  if (code !== 0) return null;
  try {
    const parsed = JSON.parse(stdout.trim()) as { w: number; h: number };
    if (!parsed.w || !parsed.h) return null;
    return { largeur: parsed.w, hauteur: parsed.h };
  } catch {
    return null;
  }
}

/**
 * L'autorisation d'enregistrer l'écran, pour l'état affiché : demandée à
 * l'application (electron/main.cjs), qui la lit sans rien ouvrir. Une vraie
 * capture la mesurait, et macOS affichait sa demande à chaque lancement, même
 * sans se servir du contrôle de l'écran (27/09/2026). Pas encore demandée :
 * utilisable, macOS la demandera à la première action. Sans l'application
 * (passerelle lancée seule), la capture d'essai, comme avant.
 */
let numeroDemande = 0;
async function autorisationCapture(): Promise<{ ok: true } | { ok: false; error: string }> {
  const statut = await new Promise<string | null>((resolve) => {
    // Le canal de l'application (canalApplication.ts : `utilityProcess` depuis le 28/09/2026).
    if (!canalOuvert()) return resolve(null);
    const id = ++numeroDemande;
    const fin = setTimeout(() => {
      arreter();
      resolve(null);
    }, 2000);
    const arreter = ecouterLApplication((m: unknown) => {
      const r = m as { type?: unknown; id?: unknown; statut?: unknown } | null;
      if (!r || r.type !== "permission-ecran" || r.id !== id) return;
      clearTimeout(fin);
      arreter();
      resolve(typeof r.statut === "string" ? r.statut : null);
    });
    envoyerALApplication({ type: "permission-ecran", id });
  });
  if (statut === "granted" || statut === "not-determined") return { ok: true };
  /*
   * Avant toute demande, macOS répond « refusé » (Chromium ne sait pas lire
   * « pas encore demandé » pour l'écran, revue du 27/09/2026) : tant que OxoAI
   * n'a jamais tenté de capture, c'est « pas encore demandé », et la première
   * action fera ouvrir la demande par macOS.
   */
  if (statut === "denied" && !existsSync(temoinDemandeEcran())) return { ok: true };
  if (statut === "denied" || statut === "restricted") {
    return {
      ok: false,
      error: tf(
        "Capture d'écran refusée par le système. Autorisez {0} dans Réglages Système > Confidentialité et sécurité > Enregistrement de l'écran, puis relancez l'application.",
        nomProduit(),
      ),
    };
  }
  const essai = await captureHost();
  return essai.ok ? { ok: true } : essai;
}

/** Dimensions d'un PNG, lues dans son en-tête IHDR. */
function pngSize(buffer: Buffer): { largeur: number; hauteur: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) return null;
  return { largeur: buffer.readUInt32BE(16), hauteur: buffer.readUInt32BE(20) };
}

/** Témoin : OxoAI a tenté au moins une capture sur cette machine (donc macOS a posé sa question). */
const temoinDemandeEcran = () => join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), ".ecran-demande");

async function captureHost(): Promise<{ ok: true; capture: Capture } | { ok: false; error: string }> {
  try {
    writeFileSync(temoinDemandeEcran(), "", { flag: "a", mode: 0o600 });
  } catch {
    /* dossier des données absent : l'état dira « refusé » plus tôt, rien de plus */
  }
  const dir = await mkdtemp(join(tmpdir(), "oxoai-capture-"));
  const file = join(dir, "ecran.png");
  try {
    // -x : pas de son d'obturateur. -C : inclure le curseur, utile au modèle.
    const shot = await exec("screencapture", ["-x", "-C", "-t", "png", file]);
    if (shot.code !== 0) {
      return {
        ok: false,
        error: tf(
          "Capture d'écran refusée par le système. Autorisez {0} dans Réglages Système > Confidentialité et sécurité > Enregistrement de l'écran, puis relancez l'application.",
          nomProduit(),
        ),
      };
    }

    // sips est fourni par macOS : pas de dépendance de traitement d'image.
    await exec("sips", ["-Z", String(MAX_LARGEUR), "-s", "format", "png", file, "--out", file]);

    const buffer = await readFile(file);
    const size = pngSize(buffer);
    if (!size) return { ok: false, error: t("Image de capture illisible.") };

    return {
      ok: true,
      capture: { base64: buffer.toString("base64"), largeur: size.largeur, hauteur: size.hauteur },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await unlink(file).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Souris et clavier, sur l'hôte                                       */
/* ------------------------------------------------------------------ */

/**
 * Le modèle raisonne sur l'image transmise ; la souris travaille en points
 * écran. Sans cette conversion, tous les clics tombent à côté sur un écran
 * Retina.
 */
export function toScreen(
  point: { x: number; y: number },
  image: { largeur: number; hauteur: number },
  screen: { largeur: number; hauteur: number },
): { x: number; y: number } {
  return {
    x: Math.round((point.x / image.largeur) * screen.largeur),
    y: Math.round((point.y / image.hauteur) * screen.hauteur),
  };
}

/** Corps du script JXA : les primitives souris, via CoreGraphics. */
const MOUSE_PRELUDE = `
ObjC.import('CoreGraphics');
function pos(){ return $.CGEventGetLocation($.CGEventCreate($())); }
function move(x,y){ $.CGEventPost($.kCGHIDEventTap,
  $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, {x:x,y:y}, $.kCGMouseButtonLeft)); }
function press(x,y,down,up,button,clicks){
  var d = $.CGEventCreateMouseEvent($(), down, {x:x,y:y}, button);
  var u = $.CGEventCreateMouseEvent($(), up,   {x:x,y:y}, button);
  if (clicks > 1) {
    $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, clicks);
    $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, clicks);
  }
  $.CGEventPost($.kCGHIDEventTap, d);
  pause(0.03);
  $.CGEventPost($.kCGHIDEventTap, u);
}
function pause(s){ $.NSThread.sleepForTimeInterval(s); }
`;

async function mouseScript(body: string): Promise<{ ok: boolean; error?: string }> {
  const { code, stderr } = await jxa(MOUSE_PRELUDE + body);
  if (code === 0) return { ok: true };
  return {
    ok: false,
    error:
      /not allowed|assistive|1743/i.test(stderr)
        ? tf("Contrôle de la souris refusé. Autorisez {0} dans Réglages Système > Confidentialité et sécurité > Accessibilité.", nomProduit())
        : stderr.trim() || t("Échec de l'action souris."),
  };
}

/** Traduit un raccourci « cmd+shift+s » en instruction System Events. */
/**
 * Nettoie un texte avant de le confier au clavier du systeme.
 *
 * `JSON.stringify` rend un caractere de controle sous la forme \\uXXXX, une
 * notation qu'AppleScript ne connait pas : il repondait `syntax error (-2741)`,
 * renvoye tel quel a l'agent, et la saisie echouait la ou elle aurait du
 * passer. Ce n'est pas une faille, l'echappement tient : c'est une saisie qui
 * casse sur un texte copie depuis un document.
 *
 * Le saut de ligne et la tabulation sont conserves, ils ont un sens au
 * clavier. Le retour chariot est ramene au saut de ligne, et une paire
 * retour chariot + saut de ligne ne produit qu'une seule frappe. Le reste des
 * caracteres de controle est ecarte : aucun n'a d'equivalent que l'on saurait
 * taper.
 */
function nettoyerPourSaisie(texte: string): string {
  return texte
    .replace(/\r\n?/g, "\n")
    .replace(
      new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g"),
      "",
    );
}

function keystrokeScript(touche: string): string {
  const parts = touche
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";

  const modifiers = parts
    .map((m) =>
      m === "cmd" || m === "commande" ? "command down"
      : m === "ctrl" || m === "controle" ? "control down"
      : m === "alt" || m === "option" ? "option down"
      : m === "maj" || m === "shift" ? "shift down"
      : "",
    )
    .filter(Boolean);

  /** Touches sans caractère imprimable : il faut leur code matériel. */
  const CODES: Record<string, number> = {
    entree: 36, entrer: 36, retour: 36, enter: 36, return: 36,
    tab: 48, tabulation: 48,
    espace: 49, space: 49,
    suppr: 51, backspace: 51,
    echap: 53, esc: 53, escape: 53,
    gauche: 123, droite: 124, bas: 125, haut: 126,
    f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
    accueil: 115, fin: 119, pagehaut: 116, pagebas: 121,
  };

  const suffix = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
  const code = CODES[key];
  const instruction =
    code !== undefined
      ? `key code ${code}${suffix}`
      : `keystroke ${JSON.stringify(key)}${suffix}`;

  return `tell application "System Events" to ${instruction}`;
}

/* ------------------------------------------------------------------ */
/* Mode sandbox : cua                                                  */
/* ------------------------------------------------------------------ */

/**
 * En mode sandbox, la passerelle ne pilote rien elle-même : elle parle au
 * serveur de cua qui tourne dans la machine virtuelle. Aucune permission macOS
 * n'est alors demandée sur le poste de l'utilisateur.
 */
/*
 * La machine de l'agent, démarrée par OxoAI (machine.ts) ; une autre adresse
 * reste possible. Relue à chaque appel : celle de la machine macOS n'est
 * connue qu'une fois qu'elle a démarré.
 */
const cuaUrl = () => process.env.OXOAI_CUA_URL ?? adresseMachine();

/** La touche des raccourcis dans la machine : Commande sur macOS, Contrôle sur Linux. */
const modificateur = () => (systemeMachine() === "macos" ? "command" : "ctrl");

/** En-têtes des conteneurs cua hébergés ; inutiles pour une VM locale. */
function cuaHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.OXOAI_CUA_CONTAINER) {
    headers["X-Container-Name"] = process.env.OXOAI_CUA_CONTAINER;
  }
  if (process.env.OXOAI_CUA_KEY) headers["X-API-Key"] = process.env.OXOAI_CUA_KEY;
  return headers;
}

/**
 * `/cmd` ne répond pas en JSON simple : c'est un flux d'évènements, une trame
 * `data: {...}` par ligne. On lit la dernière trame utile — lire la réponse
 * comme du JSON échouerait.
 */
function lastEvent(body: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      found = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>;
    } catch {
      /* trame partielle : on garde la précédente */
    }
  }
  return found;
}

/*
 * Une seconde chance quand la machine ne répond pas : mesuré le 24/09/2026, le
 * premier appel d'une demande tombait pendant le chargement du modèle de vision
 * (mémoire saturée quelques secondes) et échouait, alors que le même appel,
 * refait, passait en 220 ms. L'erreur est réelle seulement si elle se répète.
 */
async function cuaCall(
  command: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; body?: Record<string, unknown>; error?: string }> {
  const premier = await cuaCallUneFois(command, params);
  if (premier.ok || !premier.injoignable) return premier;
  await new Promise((r) => setTimeout(r, 2000));
  return cuaCallUneFois(command, params);
}

async function cuaCallUneFois(
  command: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; body?: Record<string, unknown>; error?: string; injoignable?: boolean }> {
  try {
    const res = await fetch(`${cuaUrl()}/cmd`, {
      method: "POST",
      headers: cuaHeaders(),
      body: JSON.stringify({ command, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, error: `cua a répondu ${res.status}.` };

    const event = lastEvent(await res.text());
    if (!event) return { ok: false, error: `Réponse illisible de cua (${command}).` };
    if (event.success === false) {
      return { ok: false, error: String(event.error ?? `Échec de « ${command} ».`) };
    }
    return { ok: true, body: event };
  } catch (err) {
    return {
      ok: false,
      injoignable: true,
      error: t(
        "La machine de l'agent ne répond pas. Démarrez-la dans Réglages, rubrique Contrôle de l'écran, puis réessayez.",
      ),
    };
  }
}

/**
 * L'écran de la machine de l'agent, pour le suivre en direct dans Cowork.
 * Hors du circuit des actions : ce n'est pas l'agent qui regarde, c'est la
 * personne, et regarder n'agit sur rien. Rien en mode hôte : on ne diffuse
 * pas l'écran de la personne.
 */
export async function captureMachine(): Promise<Buffer | null> {
  if (configEcran().mode !== "sandbox") return null;
  const res = await cuaCall("screenshot", { format: "png" });
  const image = (res.body as { image_data?: string; base64_image?: string } | undefined);
  const b64 = image?.image_data ?? image?.base64_image;
  return res.ok && b64 ? Buffer.from(b64, "base64") : null;
}

/* ------------------------------------------------------------------ */
/* Capacités                                                           */
/* ------------------------------------------------------------------ */

export interface Capability {
  mode: "sandbox" | "hote" | "desactive";
  /** D'où vient le mode : profil de déploiement, choix fait dans l'interface, défaut. */
  source: SourceEcran;
  /** Le mode peut-il être changé depuis l'interface, et sinon pourquoi. */
  modifiable: boolean;
  raisonNonModifiable?: string;
  /** Le contrôle est-il utilisable tout de suite ? */
  disponible: boolean;
  approbationRequise: boolean;
  ecran: { largeur: number; hauteur: number } | null;
  permissions: { capture: boolean; controle: boolean };
  /**
   * Modèle qui lira les captures. Piloter l'écran sans lui revient à cliquer
   * à l'aveugle : un modèle de conversation ne voit pas les images.
   */
  modeleEcran: string | null;
  /** Ce qu'il reste à faire pour que ça marche, en clair. */
  problemes: string[];
  /** Mode `sandbox` : le système de la machine de l'agent. */
  systeme?: "linux" | "macos";
  /** Piloter l'écran de cette machine même (« Cet écran ») : macOS seulement, l'écran ne le propose pas ailleurs. */
  hotePossible: boolean;
}

/** Le parc contient-il un modèle capable de lire une capture d'écran ? */
async function visionModel(): Promise<string | null> {
  for (const role of ["gui", "vision"] as const) {
    const found = await resolve({ role });
    if (!("error" in found)) return found.model.uid;
  }
  return null;
}

let ecranCache: { largeur: number; hauteur: number } | null = null;

/**
 * Le diagnostic prend une vraie capture d'écran : le répéter à chaque appel
 * serait à la fois lourd et intrusif. On garde le résultat quelques secondes,
 * assez pour que plusieurs écrans de l'interface se partagent une seule mesure,
 * pas assez pour masquer une autorisation qu'on vient d'accorder.
 */
const CAPACITE_TTL = 5_000;
/*
 * Une mesure par langue : `problemes` est rédigé pour la personne qui
 * demande, et un poste en anglais ne doit pas recevoir la mesure d'un
 * collègue en français, prise deux secondes plus tôt.
 */
let capaciteCache: { at: number; langue: string; value: Capability } | null = null;

/** Après un changement de mode : l'état mis en cache ne vaut plus. */
export function oublierCapacite(): void {
  capaciteCache = null;
}

export async function capability(): Promise<Capability> {
  if (capaciteCache && capaciteCache.langue === langue() && Date.now() - capaciteCache.at < CAPACITE_TTL) {
    return capaciteCache.value;
  }
  const value = await measure();
  capaciteCache = { at: Date.now(), langue: langue(), value };
  return value;
}

async function measure(): Promise<Capability> {
  const config = configEcran();
  const modifiable = modeModifiable();
  const base = {
    mode: config.mode,
    approbationRequise: config.requireApproval !== false,
    source: config.source,
    modifiable: modifiable.ok,
    ...(modifiable.ok ? {} : { raisonNonModifiable: modifiable.raison }),
    hotePossible: process.platform === "darwin",
  };

  if (config.mode === "desactive") {
    return {
      ...base,
      disponible: false,
      ecran: null,
      permissions: { capture: false, controle: false },
      modeleEcran: null,
      problemes: [
        config.source === "profil"
          ? t("Le contrôle de l'écran est désactivé par le profil de déploiement (oxoai.config.json, champ computerUse.mode).")
          : t("Le contrôle de l'écran n'est pas activé sur ce poste."),
      ],
    };
  }

  const modeleEcran = await visionModel();
  const problemes: string[] = [];
  if (!modeleEcran) {
    problemes.push(
      t("Aucun modèle capable de lire une capture n'est chargé. L'agent pourrait cliquer, mais sans voir l'écran. Chargez un modèle de vision (Qwen3-VL, par exemple) ou lancez la mise en route."),
    );
  }

  if (config.mode === "sandbox") {
    const probe = await cuaCall("get_screen_size", {});
    if (!probe.ok) problemes.unshift(probe.error ?? t("Machine virtuelle indisponible."));

    // La taille vient de la VM : la supposer décalerait tous les clics.
    const taille = probe.body?.size as { width?: number; height?: number } | undefined;
    return {
      ...base,
      systeme: systemeMachine(),
      disponible: probe.ok && Boolean(modeleEcran),
      ecran:
        taille?.width && taille?.height
          ? { largeur: taille.width, hauteur: taille.height }
          : null,
      permissions: { capture: probe.ok, controle: probe.ok },
      modeleEcran,
      problemes,
    };
  }

  // Mode hôte : les deux autorisations macOS sont vérifiées séparément, pour
  // dire précisément laquelle manque.
  const shot = await autorisationCapture();
  if (!shot.ok) problemes.unshift(shot.error);

  const controle = await mouseScript("pos();");
  if (!controle.ok) problemes.unshift(controle.error ?? t("Contrôle indisponible."));

  const ecran = ecranCache ?? (await logicalScreen());
  if (ecran) ecranCache = ecran;
  else problemes.push(t("Taille de l'écran indéterminée."));

  return {
    ...base,
    disponible: shot.ok && controle.ok && Boolean(ecran) && Boolean(modeleEcran),
    ecran,
    permissions: { capture: shot.ok, controle: controle.ok },
    modeleEcran,
    problemes,
  };
}

/* ------------------------------------------------------------------ */
/* Exécution                                                           */
/* ------------------------------------------------------------------ */

export interface ActionResult {
  ok: boolean;
  message: string;
  capture?: Capture;
}

/** Exécute une action, sans se préoccuper de l'approbation (voir `request`). */
export async function perform(action: Action): Promise<ActionResult> {
  const config = configEcran();

  if (config.mode === "desactive") {
    return { ok: false, message: t("Le contrôle de l'écran est désactivé sur cette instance.") };
  }

  if (config.mode === "sandbox") return performSandbox(action);
  return performHost(action);
}

/**
 * Relit un .docx (son texte) ou un .xlsx (ses cellules, « A1=valeur ») dans la
 * machine, pour l'agent. Encodé en base64 : rien à échapper dans la commande.
 */
const RELECTURE = Buffer.from(
  [
    "import sys, zipfile, re",
    "z = zipfile.ZipFile(sys.argv[1]); n = z.namelist()",
    "if 'word/document.xml' in n:",
    "    print(' '.join(re.sub(r'<[^>]+>', ' ', z.read('word/document.xml').decode()).split())[:1000])",
    "if 'xl/worksheets/sheet1.xml' in n:",
    "    si = z.read('xl/sharedStrings.xml').decode() if 'xl/sharedStrings.xml' in n else ''",
    "    partages = [''.join(re.findall(r'<t[^>]*>([^<]*)</t>', b)) for b in re.findall(r'<si>(.*?)</si>', si, re.S)]",
    "    cases = []",
    // Cellule vide fermée sur elle-même (« <c r="A1" s="1"/> ») : sautée, sans avaler la suivante (voir relecture.ts).
    "    for ref, attrs, fin, corps in re.findall(r'<c r=\"([A-Z]+[0-9]+)\"([^>]*?)(/>|>(.*?)</c>)', z.read('xl/worksheets/sheet1.xml').decode(), re.S):",
    "        if fin == '/>': continue",
    "        f = re.search(r'<f[^>]*>([^<]*)</f>', corps); v = re.search(r'<v>([^<]*)</v>', corps); v = v.group(1) if v else ''",
    "        if 't=\"s\"' in attrs and v: v = partages[int(v)]",
    "        cases.append(ref + '=' + (('=' + f.group(1) + ' -> ') if f else '') + v)",
    "    print('; '.join(cases)[:1000])",
  ].join("\n"),
).toString("base64");

/** Un nom de document sûr, avec une extension bureautique connue ; sinon null. */
function nomDocument(brut: string): string | null {
  const nom = brut.normalize("NFC").split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 80);
  if (!nom || nom.startsWith(".")) return null;
  return /\.(docx|xlsx|pptx|pdf|odt|ods|odp|txt|csv)$/i.test(nom) ? nom : null;
}

/**
 * Ne garde d'un nom d'application que ce qu'un nom d'application peut contenir.
 *
 * Le nom vient du modèle, donc potentiellement d'un texte que l'agent a lu
 * quelque part : tout ce qui ressemble à de la syntaxe de commande (`;`, `|`,
 * `$`, apostrophes, retours à la ligne) est retiré.
 */
function nomApplication(brut: string): string {
  return brut
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .trim()
    .slice(0, 64);
}

/**
 * Traduit une touche OxoAI vers le vocabulaire de cua (pyautogui).
 * Un nom inconnu serait ignoré silencieusement par la VM.
 */
function toCuaKeys(touche: string): string[] {
  const CLES: Record<string, string> = {
    cmd: "command", commande: "command",
    ctrl: "ctrl", controle: "ctrl",
    alt: "alt", option: "alt",
    maj: "shift", shift: "shift",
    entree: "enter", entrer: "enter", retour: "enter",
    echap: "esc", esc: "esc",
    espace: "space",
    suppr: "backspace",
    tab: "tab", tabulation: "tab",
    haut: "up", bas: "down", gauche: "left", droite: "right",
  };
  return touche
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => CLES[p] ?? p);
}

async function performSandbox(action: Action): Promise<ActionResult> {
  // L'attente n'est pas une commande de la VM : elle se fait ici.
  if (action.action === "attendre") {
    const ms = Math.min(Math.max(action.quantite ?? 500, 0), 10_000);
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true, message: tf("Attente de {0} ms.", ms) };
  }

  /*
   * `drag_to` part de la position courante du curseur : il faut donc s'y placer
   * d'abord, sinon le glisser démarre d'où le curseur traînait.
   */
  if (action.action === "glisser") {
    const depart = await cuaCall("move_cursor", { x: action.x, y: action.y });
    if (!depart.ok) return { ok: false, message: depart.error ?? "Échec du positionnement." };
    const fin = await cuaCall("drag_to", { x: action.x2, y: action.y2, button: "left" });
    return fin.ok
      ? { ok: true, message: t("Glisser exécuté dans la machine virtuelle.") }
      : { ok: false, message: fin.error ?? "Échec du glisser." };
  }

  /*
   * cua sépare le défilement vertical (`scroll_up` / `scroll_down`, en crans)
   * du défilement libre (`scroll`, en déplacement x/y). Il n'existe pas de
   * paramètre « direction ».
   */
  if (action.action === "defiler") {
    const crans = Math.min(Math.max(action.quantite ?? 3, 1), 20);
    const dir = action.direction ?? "bas";

    if (action.x !== undefined && action.y !== undefined) {
      const place = await cuaCall("move_cursor", { x: action.x, y: action.y });
      if (!place.ok) return { ok: false, message: place.error ?? "Échec du positionnement." };
    }

    const res =
      dir === "haut"
        ? await cuaCall("scroll_up", { clicks: crans })
        : dir === "bas"
          ? await cuaCall("scroll_down", { clicks: crans })
          : await cuaCall("scroll", { x: dir === "gauche" ? crans : -crans, y: 0 });

    return res.ok
      ? { ok: true, message: tf("Défilement vers {0} ({1} crans).", SENS[dir], crans) }
      : { ok: false, message: res.error ?? "Défilement refusé." };
  }

  const map: Partial<Record<ActionName, { command: string; params: Record<string, unknown> }>> = {
    capture: { command: "screenshot", params: { format: "png" } },
    deplacer: { command: "move_cursor", params: { x: action.x, y: action.y } },
    cliquer: { command: "left_click", params: { x: action.x, y: action.y } },
    double_cliquer: { command: "double_click", params: { x: action.x, y: action.y } },
    clic_droit: { command: "right_click", params: { x: action.x, y: action.y } },
    saisir: { command: "type_text", params: { text: action.texte ?? "" } },
    touche: { command: "hotkey", params: { keys: toCuaKeys(action.touche ?? "") } },
    /*
     * `run_command` passe par un interpréteur de commandes : un nom
     * d'application venu du modèle y serait une injection (« Safari; rm -rf ~ »).
     * Le nom est donc filtré en amont, puis mis entre apostrophes simples.
     */
    ouvrir_app: {
      command: "run_command",
      params: { command: `open -a '${nomApplication(action.texte ?? "")}'` },
    },
  };

  /*
   * Enregistrer, en une action sûre. Un petit modèle ne tenait pas seul
   * l'enchaînement raccourci, champ du nom, chemin, validation (mesuré le
   * 24/09/2026 : le texte était écrit, jamais enregistré). Le nom est filtré :
   * il entre ensuite, entre apostrophes, dans la commande de vérification.
   */
  /*
   * Remplir un tableur au clavier. Mesuré le 24/09/2026 (qwen3-vl-4b) : en
   * visant les cellules à la souris, il les a « glissées » au lieu de les
   * cliquer, et le fichier enregistré ne contenait que trois valeurs,
   * mal placées. Au clavier, depuis la zone de nom : aucune cible à viser.
   */
  if (action.action === "saisir_tableau") {
    const lignes = (action.lignes ?? []).slice(0, 200).map((l) => l.slice(0, 50).map((c) => c.slice(0, 1000)));
    if (lignes.length === 0) return { ok: false, message: t("Aucune ligne à saisir.") };
    const cellule = /^[A-Z]{1,3}[0-9]{1,6}$/i.test(action.cellule ?? "") ? action.cellule!.toUpperCase() : "A1";
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Zone de nom de Calc (Ctrl+Maj+F5) : on y tape la cellule de départ.
    for (const [commande, params, apres] of [
      ["hotkey", { keys: [modificateur(), "shift", "f5"] }, 500],
      ["hotkey", { keys: [modificateur(), "a"] }, 150],
      ["type_text", { text: cellule }, 150],
      ["hotkey", { keys: ["enter"] }, 400],
    ] as const) {
      const r = await cuaCall(commande, params);
      if (!r.ok) return { ok: false, message: r.error ?? t("Échec.") };
      await pause(apres);
    }
    for (const ligne of lignes) {
      for (let j = 0; j < ligne.length; j++) {
        if (ligne[j]) {
          const r = await cuaCall("type_text", { text: ligne[j] });
          if (!r.ok) return { ok: false, message: r.error ?? t("Échec.") };
        }
        if (j < ligne.length - 1) await cuaCall("hotkey", { keys: ["tab"] });
      }
      // Entrée après des tabulations : Calc revient à la colonne de départ, ligne suivante.
      await cuaCall("hotkey", { keys: ["enter"] });
      await pause(120);
    }
    return {
      ok: true,
      message: tf("{0} ligne(s) saisie(s) à partir de {1}. Prends une capture pour vérifier, puis enregistre.", lignes.length, cellule),
    };
  }

  if (action.action === "enregistrer_document") {
    const nom = nomDocument(action.texte ?? "");
    if (!nom) {
      return {
        ok: false,
        message: t("Nom de fichier refusé : donne un nom simple avec son extension (.docx, .xlsx, .pptx, .pdf, .odt, .ods, .odp, .txt, .csv)."),
      };
    }
    const chemin = `${echangeDansLaMachine()}/${nom}`;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const [commande, params, apres] of [
      ["hotkey", { keys: [modificateur(), "shift", "s"] }, 1800],
      ["hotkey", { keys: [modificateur(), "a"] }, 200],
      ["type_text", { text: chemin }, 300],
      ["hotkey", { keys: ["enter"] }, 2500],
    ] as const) {
      const r = await cuaCall(commande, params);
      if (!r.ok) return { ok: false, message: r.error ?? t("Échec.") };
      await pause(apres);
    }
    /*
     * Machine macOS : le fichier est lu là où la personne le trouvera, dans le
     * dossier d'échange du poste (relecture.ts). Python n'y est pas garanti.
     */
    if (systemeMachine() === "macos") {
      const surLePoste = join(dossierEchange(), nom);
      let taillePoste = 0;
      for (let i = 0; i < 6 && !taillePoste; i++) {
        try {
          taillePoste = statSync(surLePoste).size;
        } catch {
          await pause(500);
        }
      }
      if (!taillePoste) {
        return { ok: false, message: t("L'enregistrement n'a pas abouti : une fenêtre attend peut-être une réponse. Prends une capture pour voir ce qui bloque.") };
      }
      let reluPoste = "";
      try {
        reluPoste = relireDocument(lireFichier(surLePoste)).slice(0, 1200);
      } catch {
        /* format sans relecture (pdf, txt...) */
      }
      return {
        ok: true,
        message:
          tf("Document enregistré : {0} ({1} octets). La personne le trouve dans OxoAI/Machine.", nom, taillePoste) +
          (reluPoste ? `\n${t("Contenu relu dans le fichier :")}\n${reluPoste}` : ""),
      };
    }
    const verif = await cuaCall("run_command", { command: `test -s '${chemin}' && stat -c %s '${chemin}'` });
    const taille = String((verif.body as { stdout?: string } | undefined)?.stdout ?? "").trim();
    /*
     * Relecture de ce qui a été enregistré, pour que l'agent juge sur pièce et
     * non sur ce qu'il croit avoir tapé (mesuré : un tableau faux annoncé
     * comme fait). Script fixe, encodé ; le chemin, déjà filtré, en argument.
     */
    const relu =
      verif.ok && taille
        ? String(
            ((await cuaCall("run_command", { command: `python3 -c "import base64;exec(base64.b64decode('${RELECTURE}'))" '${chemin}'` })).body as
              | { stdout?: string }
              | undefined)?.stdout ?? "",
          )
            .trim()
            .slice(0, 1200)
        : "";
    return verif.ok && taille
      ? {
          ok: true,
          message:
            tf("Document enregistré : {0} ({1} octets). La personne le trouve dans OxoAI/Machine.", nom, taille) +
            (relu ? `\n${t("Contenu relu dans le fichier :")}\n${relu}` : ""),
        }
      : { ok: false, message: t("L'enregistrement n'a pas abouti : une fenêtre attend peut-être une réponse. Prends une capture pour voir ce qui bloque.") };
  }

  /*
   * Le nom demandé choisit une application d'une liste fermée (machine.ts) ;
   * il n'entre jamais dans la commande. Dans le bureau Linux, `open -a`
   * n'existe pas : inconnue, on dit ce qui est disponible. Sur la machine
   * macOS, une application hors liste passe par `open -a` (plus bas), le nom
   * filtré puis mis entre apostrophes.
   */
  if (action.action === "ouvrir_app") {
    const app = applicationMachine(action.texte ?? "");
    if (app) {
      const lance = await cuaCall("run_command", { command: app.commande });
      return lance.ok
        ? { ok: true, message: tf("{0} s'ouvre dans la machine (quelques secondes). Prends une capture pour voir où en est l'écran.", app.libelle) }
        : { ok: false, message: lance.error ?? t("Échec.") };
    }
    if (systemeMachine() === "linux") {
      return {
        ok: false,
        message: tf("Application inconnue dans la machine. Disponibles : {0}.", applicationsDisponibles().join(", ")),
      };
    }
  }

  const call = map[action.action];
  if (!call) return { ok: false, message: tf("Action inconnue : {0}", action.action) };

  const res = await cuaCall(call.command, call.params);
  if (!res.ok) return { ok: false, message: res.error ?? "Échec." };

  const body = res.body as
    | { image_data?: string; base64_image?: string }
    | undefined;

  if (action.action === "capture") {
    // Le nom du champ a changé selon les versions de cua : on accepte les deux.
    const image = body?.image_data ?? body?.base64_image;
    if (!image) return { ok: false, message: t("La machine virtuelle n'a renvoyé aucune image.") };

    // On lit la taille dans l'image plutôt que de la supposer : les VM ne font
    // pas toutes la même résolution, et une erreur ici décale tous les clics.
    const size = pngSize(Buffer.from(image, "base64"));
    if (!size) return { ok: false, message: t("Image de capture illisible.") };

    return { ok: true, message: t("Capture réalisée."), capture: { base64: image, ...size } };
  }
  return { ok: true, message: tf("Action « {0} » exécutée dans la machine virtuelle.", action.action) };
}

async function performHost(action: Action): Promise<ActionResult> {
  if (action.action === "enregistrer_document" || action.action === "saisir_tableau") {
    return { ok: false, message: t("Cette action n'existe que dans la machine de l'agent.") };
  }
  if (action.action === "capture") {
    const shot = await captureHost();
    return shot.ok
      ? { ok: true, message: t("Capture réalisée."), capture: shot.capture }
      : { ok: false, message: shot.error };
  }

  if (action.action === "attendre") {
    const ms = Math.min(Math.max(action.quantite ?? 500, 0), 10_000);
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true, message: tf("Attente de {0} ms.", ms) };
  }

  if (action.action === "ouvrir_app") {
    const nom = (action.texte ?? "").trim();
    if (!nom) return { ok: false, message: t("Nom d'application manquant.") };
    const { code, stderr } = await exec("open", ["-a", nom]);
    return code === 0
      ? { ok: true, message: tf("Application « {0} » ouverte.", nom) }
      : { ok: false, message: stderr.trim() || `Application « ${nom} » introuvable.` };
  }

  if (action.action === "saisir") {
    const texte = nettoyerPourSaisie(action.texte ?? "");
    if (!texte) return { ok: false, message: t("Texte manquant.") };
    const { code, stderr } = await applescript(
      `tell application "System Events" to keystroke ${JSON.stringify(texte)}`,
    );
    return code === 0
      ? { ok: true, message: tf("Texte saisi ({0} caractères).", texte.length) }
      : { ok: false, message: stderr.trim() || "Saisie refusée." };
  }

  if (action.action === "touche") {
    const touche = (action.touche ?? "").trim();
    if (!touche) return { ok: false, message: t("Touche manquante.") };
    const { code, stderr } = await applescript(keystrokeScript(touche));
    return code === 0
      ? { ok: true, message: tf("Touche « {0} » envoyée.", touche) }
      : { ok: false, message: stderr.trim() || "Touche refusée." };
  }

  // Actions souris : les coordonnées arrivent déjà converties en points écran.
  const x = Math.round(action.x ?? 0);
  const y = Math.round(action.y ?? 0);

  const scripts: Partial<Record<ActionName, string>> = {
    deplacer: `move(${x},${y});`,
    cliquer:
      `move(${x},${y}); pause(0.05); ` +
      `press(${x},${y}, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft, 1);`,
    double_cliquer:
      `move(${x},${y}); pause(0.05); ` +
      `press(${x},${y}, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft, 1); pause(0.05); ` +
      `press(${x},${y}, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft, 2);`,
    clic_droit:
      `move(${x},${y}); pause(0.05); ` +
      `press(${x},${y}, $.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGMouseButtonRight, 1);`,
    glisser:
      `move(${x},${y}); pause(0.05); ` +
      `$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, {x:${x},y:${y}}, $.kCGMouseButtonLeft)); pause(0.1); ` +
      `$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDragged, {x:${Math.round(action.x2 ?? x)},y:${Math.round(action.y2 ?? y)}}, $.kCGMouseButtonLeft)); pause(0.1); ` +
      `$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, {x:${Math.round(action.x2 ?? x)},y:${Math.round(action.y2 ?? y)}}, $.kCGMouseButtonLeft));`,
  };

  if (action.action === "defiler") {
    const crans = Math.min(Math.max(action.quantite ?? 3, 1), 20);
    const dir = action.direction ?? "bas";
    /*
     * CGEventCreateScrollWheelEvent(source, unites, nombreDAxes, axe1, axe2).
     * L'axe 1 est vertical, l'axe 2 horizontal ; une valeur positive fait
     * remonter le contenu, donc défiler vers le haut.
     */
    const roue =
      dir === "haut" ? `1, ${crans}`
      : dir === "bas" ? `1, ${-crans}`
      : dir === "gauche" ? `2, 0, ${crans}`
      : `2, 0, ${-crans}`;

    const body =
      (action.x !== undefined ? `move(${x},${y}); pause(0.05); ` : "") +
      `$.CGEventPost($.kCGHIDEventTap, ` +
      `$.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, ${roue}));`;

    const done = await mouseScript(body);
    return done.ok
      ? { ok: true, message: tf("Défilement vers {0} ({1} crans).", SENS[dir], crans) }
      : { ok: false, message: done.error ?? "Défilement refusé." };
  }

  const script = scripts[action.action];
  if (!script) return { ok: false, message: tf("Action inconnue : {0}", action.action) };

  const done = await mouseScript(script);
  return done.ok
    ? { ok: true, message: tf("Action « {0} » exécutée en ({1}, {2}).", action.action, x, y) }
    : { ok: false, message: done.error ?? "Action refusée." };
}

/* ------------------------------------------------------------------ */
/* Approbation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Une action qui modifie l'écran attend l'accord explicite d'un humain avant de
 * partir, sauf si l'intégrateur a levé cette exigence. Sans ce garde-fou, un
 * modèle qui se trompe de fenêtre agit sur les vraies données de l'utilisateur.
 *
 * La file d'attente, le flux d'évènements et le délai d'expiration ne vivent
 * plus ici : ils sont partagés avec l'approbation des outils de fichiers
 * (`approbation.ts`). Deux files concurrentes auraient divergé au premier
 * correctif, et l'interface aurait eu deux flux à écouter pour la même
 * question. Les fonctions ci-dessous restent le vocabulaire du contrôle
 * d'écran ; elles ne font plus que filtrer ce qui le concerne.
 */

/**
 * Évènements d'écran destinés à ce compte. Le flux portait l'action entière,
 * texte à saisir compris, à toute séance qui l'écoutait.
 */
export function onApprovalEvent(
  pour: string,
  fn: (event: { type: string; [k: string]: unknown }) => void,
): () => void {
  return approbation.surEvenement((event) => {
    if (event.nature !== "ecran") return;
    if (typeof event.pour === "string" && event.pour !== pour) return;
    fn(event);
  });
}

/** Demandes d'écran en attente pour ce compte. `pour` vient de la séance. */
export function pendingApprovals(pour?: string): { id: string; action: Action; createdAt: number }[] {
  return approbation
    .enAttente("ecran", pour)
    .map(({ id, action, createdAt }) => ({ id, action: action as Action, createdAt }));
}

export function resolveApproval(id: string, accord: boolean, par: string): boolean {
  return approbation.repondre(id, accord, "ecran", par);
}

const emit = (event: { type: string; [k: string]: unknown }): void =>
  approbation.emettre({ ...event, nature: "ecran" });

/** Formulation lisible d'une action, pour la demande et pour le journal. */
function resumerAction(action: Action): string {
  const point = action.x !== undefined ? ` en (${action.x}, ${action.y})` : "";
  switch (action.action) {
    case "cliquer":
      return `cliquer${point}`;
    case "double_cliquer":
      return `double-cliquer${point}`;
    case "clic_droit":
      return `faire un clic droit${point}`;
    case "glisser":
      return `glisser de (${action.x}, ${action.y}) vers (${action.x2}, ${action.y2})`;
    case "defiler":
      return `faire défiler vers ${SENS[action.direction ?? "bas"]}`;
    case "saisir":
      return "saisir du texte au clavier";
    case "touche":
      return `envoyer la touche « ${action.touche ?? ""} »`;
    case "ouvrir_app":
      return `ouvrir l'application « ${action.texte ?? ""} »`;
    case "capture":
      return "prendre une capture de l'écran";
    case "deplacer":
      return `déplacer le curseur${point}`;
    case "attendre":
      return "attendre";
    case "enregistrer_document":
      return `enregistrer le document sous « ${action.texte ?? ""} » dans le dossier d'échange`;
    case "saisir_tableau":
      return `saisir un tableau de ${action.lignes?.length ?? 0} ligne(s) à partir de ${action.cellule ?? "A1"}`;
    default:
      return "agir sur l'écran";
  }
}

async function askApproval(action: Action, pour: string): Promise<approbation.Reponse> {
  return approbation.demander({
    nature: "ecran",
    resume: resumerAction(action),
    // Seule la personne concernée voit l'action, texte à saisir compris.
    pour,
    detail: { action: action.action },
    action,
  });
}

/**
 * Point d'entrée unique : applique la politique d'approbation puis exécute.
 *
 * `pour` est le compte au nom duquel l'action est demandée : la personne dont
 * la conversation a lancé l'agent, ou celle qui essaie une action depuis les
 * réglages. Le journal nommait « agent » et « utilisateur », libellés fixes
 * qui ne permettaient pas, sur une instance partagée, de dire qui avait
 * demandé ni qui avait approuvé un clic.
 */
/**
 * Demandes déjà autorisées dans la machine de l'agent (mode sandbox) : un
 * « Autoriser » y vaut pour toute la demande en cours. Chaque clic d'une tâche
 * de bureautique appelait sinon sa propre carte : des dizaines pour un seul
 * document. Sur l'écran réel de la personne, rien ne change : un accord par
 * action. Le niveau « Demander pour tout » redemande à chaque fois partout.
 */
const demandesAutorisees = new Set<string>();

/**
 * Demandes où la personne a refusé une action d'écran. La suite est refusée
 * d'office, sans nouvelle carte : mesuré le 24/09/2026, après un refus, le
 * modèle essayait autrement (ouvrir une autre application, cliquer ailleurs),
 * et chaque essai redemandait l'accord. Un refus vaut pour la demande.
 */
const demandesRefusees = new Set<string>();

/** La personne a-t-elle refusé une action d'écran pendant cette demande ? */
export function demandeRefusee(portee: string): boolean {
  return demandesRefusees.has(portee);
}

/** Fin de la demande : son autorisation ne vaut plus. */
export function oublierDemandeEcran(portee: string): void {
  demandesAutorisees.delete(portee);
  dernieresImages.delete(portee);
  demandesRefusees.delete(portee);
}

export async function request(action: Action, pour = "anonyme", portee?: string): Promise<ActionResult> {
  const config = configEcran();

  /*
   * Désactivé : on le dit tout de suite. La demande d'accord partait avant ce
   * contrôle, fait seulement dans `perform` : une carte « Cowork veut agir sur
   * votre machine » s'affichait pour une fonction coupée, et l'appel restait
   * suspendu deux minutes (mesuré le 23/09/2026 sur /oxoai/computer/action).
   */
  if (config.mode === "desactive") {
    return { ok: false, message: t("Le contrôle de l'écran est désactivé sur cette instance.") };
  }

  /*
   * Le niveau choisi dans Cowork ne peut que **resserrer** ce que l'intégrateur
   * a réglé, jamais l'assouplir. « Demander pour tout » soumet donc même une
   * capture d'écran ; « Tout approuver » ne lève pas l'exigence posée dans le
   * profil de déploiement, sans quoi un utilisateur pourrait défaire depuis
   * l'interface une décision prise pour tout le parc.
   */
  const toutDemander = approbation.niveau() === "chaque";
  const soumettre = toutDemander || (config.requireApproval !== false && !isReadOnly(action.action));

  let approuvePar: string | undefined;
  const dejaAutorisee = config.mode === "sandbox" && !toutDemander && portee !== undefined && demandesAutorisees.has(portee);
  if (soumettre && dejaAutorisee) approuvePar = "demande autorisée";
  if (soumettre && portee !== undefined && demandesRefusees.has(portee)) {
    return {
      ok: false,
      message: t("La personne a refusé les actions d'écran pour cette demande. Arrête-toi : n'essaie pas autrement, explique ce qui n'a pas été fait."),
    };
  }
  if (soumettre && !dejaAutorisee) {
    journaliser("ecran.demande", pour, { action: action.action, par: "agent" });
    const { issue, par } = await askApproval(action, pour);
    if (issue !== "accord") {
      if (portee !== undefined) demandesRefusees.add(portee);
      journaliser("ecran.refuse", par ?? "personne", { action: action.action, issue, pour });
      /*
       * Refus et silence ne se disent pas pareil : « refusée par l'utilisateur »
       * accusait d'un refus quelqu'un qui n'avait simplement pas vu la carte,
       * et le modèle le lui répétait.
       */
      return {
        ok: false,
        message:
          issue === "expiration"
            ? t("Personne n'a répondu à temps à la demande d'accord : l'action d'écran n'a pas été faite.")
            : t("Action d'écran refusée par l'utilisateur : elle n'a pas été faite."),
      };
    }
    approuvePar = par;
    if (config.mode === "sandbox" && !toutDemander && portee !== undefined) demandesAutorisees.add(portee);
    journaliser("ecran.approuve", par ?? "personne", { action: action.action, pour });
  }

  /*
   * `pour` accompagne aussi le début et la fin de l'action. Sans lui, le filtre
   * de `onApprovalEvent` laissait passer ces deux évènements vers **toutes**
   * les séances de l'instance : l'action entière, texte à saisir compris (un
   * mot de passe tapé par l'agent), partait chez chaque collègue connecté.
   * Mesuré le 23/09/2026 sur le flux brut : `action_debut` sans `pour`.
   */
  emit({ type: "action_debut", action, pour });
  const result = await perform(action);

  // Une action qui échoue signale souvent une autorisation retirée entre-temps :
  // le diagnostic mis en cache n'est plus fiable.
  if (!result.ok) capaciteCache = null;

  /*
   * Seules les actions qui modifient quelque chose sont tracées : une capture
   * par seconde noierait le journal et masquerait ce qui compte. Ni les
   * coordonnées ni le texte saisi n'y figurent — le journal dit ce qui a été
   * fait, il n'enregistre pas ce que l'utilisateur a tapé.
   */
  if (!isReadOnly(action.action)) {
    journaliser("ecran.execute", pour, {
      action: action.action,
      mode: config.mode,
      ok: result.ok,
      ...(approuvePar ? { approuvePar } : { approbation: "non requise" }),
    });
  }

  emit({ type: "action_fin", action, ok: result.ok, message: result.message, pour });
  return result;
}

/* ------------------------------------------------------------------ */
/* Outils exposés au modèle                                            */
/* ------------------------------------------------------------------ */

const POINT = {
  x: { type: "number", description: "Abscisse, dans le repère de la dernière capture." },
  y: { type: "number", description: "Ordonnée, dans le repère de la dernière capture." },
};

/**
 * Les outils ci-dessous rejoignent ceux des serveurs MCP dans la boucle de
 * conversation : Cowork peut donc enchaîner fichiers et écran dans une même
 * demande.
 */
export function toolsForModel(): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  const config = configEcran();
  if (config.mode === "desactive") return [];

  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
    type: "function" as const,
    function: {
      name: `ecran__${name}`,
      description,
      parameters: { type: "object", properties, required },
    },
  });

  return [
    fn(
      "capture",
      "Prend une capture de l'écran et la renvoie. À appeler avant toute action pour voir " +
        "l'état réel, et après une action pour vérifier son effet.",
      {},
    ),
    fn("cliquer", "Clique une fois au point indiqué.", POINT, ["x", "y"]),
    fn("double_cliquer", "Double-clique au point indiqué (ouvrir un fichier, par exemple).", POINT, ["x", "y"]),
    fn("clic_droit", "Clic droit au point indiqué, pour ouvrir un menu contextuel.", POINT, ["x", "y"]),
    fn(
      "glisser",
      "Fait glisser depuis (x, y) jusqu'à (x2, y2) : déplacer un fichier, sélectionner une zone.",
      { ...POINT, x2: { type: "number" }, y2: { type: "number" } },
      ["x", "y", "x2", "y2"],
    ),
    fn(
      "defiler",
      "Fait défiler la fenêtre sous le curseur.",
      {
        direction: { type: "string", enum: ["haut", "bas", "gauche", "droite"] },
        quantite: { type: "number", description: "Nombre de crans, 3 par défaut." },
        ...POINT,
      },
      ["direction"],
    ),
    fn(
      "saisir",
      "Saisit du texte au clavier, dans le champ qui a le focus.",
      { texte: { type: "string" } },
      ["texte"],
    ),
    fn(
      "touche",
      "Envoie une touche ou un raccourci : « entree », « echap », « cmd+s », « cmd+shift+n ».",
      { touche: { type: "string" } },
      ["touche"],
    ),
    fn(
      "ouvrir_app",
      config.mode === "sandbox"
        ? `Ouvre une application de ta machine : ${applicationsDisponibles().join(", ")}.`
        : "Ouvre une application par son nom, par exemple « Finder » ou « Aperçu ».",
      { texte: { type: "string", description: "Nom de l'application." } },
      ["texte"],
    ),
    ...(config.mode === "sandbox"
      ? [
          fn(
            "saisir_tableau",
            "Dans Calc : tape un tableau au clavier, à partir d'une cellule (A1 par défaut), une ligne après l'autre. " +
              "Beaucoup plus sûr que de cliquer dans les cellules. Une formule s'écrit comme on la tape : « =SOMME(B1:B3) ».",
            {
              lignes: {
                type: "array",
                description: "Les lignes du tableau, chacune une liste de cellules : [[\"Loyer\",\"800\"],[\"Total\",\"=SOMME(B1:B1)\"]].",
                items: { type: "array", items: { type: "string" } },
              },
              cellule: { type: "string", description: "Cellule de départ, « A1 » par défaut." },
            },
            ["lignes"],
          ),
          fn(
            "enregistrer_document",
            "Enregistre le document ouvert (Writer, Calc, Impress) dans le dossier d'échange, sous le nom donné, " +
              "et vérifie qu'il existe. Le document apparaît alors chez la personne dans OxoAI/Machine. " +
              "Utilise-le au lieu de chercher toi-même la boîte d'enregistrement.",
            { texte: { type: "string", description: "Nom du fichier avec son extension : « compte-rendu.docx », « budget.xlsx »." } },
            ["texte"],
          ),
        ]
      : []),
    fn(
      "attendre",
      "Laisse à l'interface le temps de réagir.",
      { quantite: { type: "number", description: "Durée en millisecondes." } },
      ["quantite"],
    ),
  ];
}

export function hasTools(): boolean {
  return toolsForModel().length > 0;
}

/** Dernière capture connue, pour convertir les coordonnées du modèle. */
/*
 * Par demande (ou, faute de mieux, par personne) et non pour toute l'instance :
 * deux conversations qui pilotent l'écran en même temps convertiraient sinon
 * leurs clics avec la capture de l'autre. Bornée : les plus anciennes partent.
 */
const dernieresImages = new Map<string, { largeur: number; hauteur: number }>();

/**
 * Exécute un outil « ecran__… » appelé par le modèle.
 * Renvoie du texte pour la trace, et l'image quand il y en a une : c'est
 * l'appelant qui décide de la transmettre au modèle.
 */
/**
 * Actions d'écran réellement exécutables.
 *
 * Tenue à la main plutôt que dérivée : elle est le contrat entre ce que le
 * modèle peut demander et ce que la passerelle sait faire. Ajouter une action
 * sans l'inscrire ici la rend inopérante, ce qui est le bon sens de l'erreur.
 */
const ACTIONS_CONNUES = new Set<string>([
  "cliquer",
  "double_cliquer",
  "clic_droit",
  "glisser",
  "defiler",
  "saisir",
  "touche",
  "ouvrir_app",
  "capture",
  "deplacer",
  "attendre",
  "enregistrer_document",
  "saisir_tableau",
]);

/**
 * Ce modèle donne-t-il ses coordonnées sur une grille de 0 à 1000 ?
 *
 * Qwen3-VL et Qwen3.5 (et suivants) ne répondent pas en pixels : ils placent
 * tout sur une grille de 0 à 1000, quelle que soit la taille de l'image.
 * Mesuré le 24/09/2026, bouton « Enregistrer » centré en (637, 402) :
 *  - capture 1024x768 : Qwen3-VL 4B répond (616, 517), soit (631, 397) en
 *    pixels une fois converti. Pris tel quel, le clic tombait 115 px trop bas,
 *    à côté du bouton ;
 *  - capture 1600x900 : (407, 443), soit (651, 399). Même bouton, autres
 *    nombres : c'est bien une grille, pas des pixels.
 * On le leur demande donc explicitement (chat.ts), et on convertit ici.
 */
export function grilleMille(modele: string | undefined): boolean {
  return Boolean(modele && /qwen3-vl|qwen3\.\d/i.test(modele));
}

const depuisGrille = (v: number, taille: number) => Math.round((Math.min(Math.max(v, 0), 1000) / 1000) * (taille - 1));

export async function callTool(
  qualifiedName: string,
  args: Record<string, unknown>,
  pour = "anonyme",
  portee?: string,
  modele?: string,
): Promise<{ ok: boolean; content: string; capture?: Capture }> {
  const name = qualifiedName.replace(/^ecran__/, "") as ActionName;

  /*
   * Le nom est confronté à la liste des actions réelles AVANT toute suite.
   * Il était converti sans contrôle : un outil au nom inconnu déclenchait une
   * demande d'approbation, dérangeait l'utilisateur, et n'échouait qu'ensuite
   * sur « Action inconnue ». On ne fait pas valider à quelqu'un une action qui
   * n'existe pas.
   */
  if (!ACTIONS_CONNUES.has(name)) {
    return {
      ok: false,
      content: `Action d'écran inconnue : « ${name} ». Utilise l'un des outils proposés.`,
    };
  }

  const action: Action = {
    action: name,
    x: typeof args.x === "number" ? args.x : undefined,
    y: typeof args.y === "number" ? args.y : undefined,
    x2: typeof args.x2 === "number" ? args.x2 : undefined,
    y2: typeof args.y2 === "number" ? args.y2 : undefined,
    texte: typeof args.texte === "string" ? args.texte : undefined,
    lignes: Array.isArray(args.lignes)
      ? (args.lignes as unknown[]).filter(Array.isArray).map((l) => (l as unknown[]).map((c) => (c === null || c === undefined ? "" : String(c))))
      : undefined,
    cellule: typeof args.cellule === "string" ? args.cellule : undefined,
    touche: typeof args.touche === "string" ? args.touche : undefined,
    direction: args.direction as Action["direction"],
    quantite: typeof args.quantite === "number" ? args.quantite : undefined,
  };

  const mode = configEcran().mode;

  /*
   * Sans capture préalable, les coordonnées ne veulent rien dire : les prendre
   * pour des points écran ferait cliquer à côté sans que personne le sache.
   */
  const cleImage = portee ?? pour;
  const lastImage = dernieresImages.get(cleImage) ?? null;
  const grille = grilleMille(modele);
  if ((mode === "hote" || grille) && !lastImage && (action.x !== undefined || action.x2 !== undefined)) {
    return {
      ok: false,
      content:
        "Prends d'abord une capture avec « ecran__capture » : sans elle, les " +
        "coordonnées ne peuvent pas être converties.",
    };
  }

  // Grille 0-1000 → pixels de la dernière capture (voir grilleMille).
  if (grille && lastImage) {
    if (action.x !== undefined && action.y !== undefined) {
      action.x = depuisGrille(action.x, lastImage.largeur);
      action.y = depuisGrille(action.y, lastImage.hauteur);
    }
    if (action.x2 !== undefined && action.y2 !== undefined) {
      action.x2 = depuisGrille(action.x2, lastImage.largeur);
      action.y2 = depuisGrille(action.y2, lastImage.hauteur);
    }
  }

  // Conversion image → écran, en mode hôte uniquement : dans la VM, l'image
  // et le pilote partagent déjà le même repère.
  if (mode === "hote" && lastImage && (action.x !== undefined || action.x2 !== undefined)) {
    const screen = ecranCache ?? (await logicalScreen());
    if (screen) {
      ecranCache = screen;
      if (action.x !== undefined && action.y !== undefined) {
        const p = toScreen({ x: action.x, y: action.y }, lastImage, screen);
        action.x = p.x;
        action.y = p.y;
      }
      if (action.x2 !== undefined && action.y2 !== undefined) {
        const p = toScreen({ x: action.x2, y: action.y2 }, lastImage, screen);
        action.x2 = p.x;
        action.y2 = p.y;
      }
    }
  }

  const result = await request(action, pour, portee);
  if (result.capture) {
    dernieresImages.delete(cleImage);
    dernieresImages.set(cleImage, { largeur: result.capture.largeur, hauteur: result.capture.hauteur });
    if (dernieresImages.size > 50) dernieresImages.delete(dernieresImages.keys().next().value!);
    return {
      ok: result.ok,
      content:
        `Capture de ${result.capture.largeur}x${result.capture.hauteur} pixels. ` +
        (grille
          ? "Donne les coordonnées des actions suivantes sur ta grille de 0 à 1000."
          : "Les coordonnées des actions suivantes s'expriment dans ce repère."),
      capture: result.capture,
    };
  }
  return { ok: result.ok, content: result.message };
}
