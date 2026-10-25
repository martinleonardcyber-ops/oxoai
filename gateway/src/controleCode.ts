import { nomProduit } from "./marque.ts";
import { pythonPrive } from "./pythonPrive.ts";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { applicationPreparee, problemesMetier } from "./application.ts";
import { ANALYSE_PYTHON } from "./analysePython.ts";
import { controler } from "./controleWeb.ts";
import { essayerTests } from "./essaisCode.ts";
import { etapeSuivante, oublierSequence, sequenceEnCours } from "./sequenceCode.ts";
import { estProtege } from "./zonesProtegees.ts";
import { t, tf } from "./langue.ts";

/**
 * Contrôle automatique de ce que OxoAI Code vient d'écrire, et relance de
 * l'agent tant que ce n'est pas propre.
 *
 * Demandé par Medhi le 26/09/2026 : « le petit modèle doit produire un bon
 * niveau de logiciel, même si c'est long, sinon personne n'utilisera OxoAI
 * Code ». Essai du même jour, ERP pour cabinet d'avocat avec Qwen3 8B :
 * l'agent annonçait une application « fonctionnelle » ; son script ne
 * compilait pas (`document,getElementById`), puis, corrigée, elle s'ouvrait
 * sur une page blanche, onglets blanc sur gris, listes figées. L'agent ne
 * s'en rendait compte que si on le lui disait. Désormais OxoAI le lui dit
 * lui-même, à la fin de chaque tour :
 *  1. contrôle statique des fichiers web modifiés pendant le tour
 *     (controleWeb.ts : syntaxe, fichiers liés, fonctions appelées, éléments
 *     cherchés) ;
 *  2. essai réel des pages modifiées dans le navigateur de l'application
 *     (electron/rendu.cjs : erreurs, page vide, texte illisible, boutons et
 *     formulaires essayés), quand l'application le prête ;
 *  3. s'il reste des problèmes, une demande de correction part à l'agent dans
 *     la même session, avec la liste exacte, jusqu'à `TOURS_MAX` fois ; le
 *     panneau de suivi dit où on en est.
 * Un programme vérifie, pas le modèle : il ne se contente pas de « c'est fait ».
 */

/*
 * La langue et les usages de la demande, pour tout ce que le programme
 * affiche. Mesuré le 26/09/2026 : pour une demande écrite en français, Qwen3 8B
 * a écrit « Category: … $12.50 ». Deviné sur le texte de la demande (lettres
 * chinoises, mots et accents français), anglais sinon ; aucune autre langue
 * n'est affirmée : on dit alors seulement « la langue de la demande ».
 */
export function consigneLangue(demande: string): string {
  const t = demande.toLowerCase();
  const chinois = (demande.match(/[\u3400-\u9fff]/g) ?? []).length;
  const francais = (t.match(/\b(le|la|les|un|une|des|du|de|et|pour|avec|qui|que|dans|sur|est|fais|fait|écris|ecris|peux|mon|mes)\b/g) ?? []).length + (t.match(/[éèêàçù]/g) ?? []).length;
  const anglais = (t.match(/\b(the|a|an|and|for|with|that|which|in|on|is|make|write|build|create|my|please)\b/g) ?? []).length;
  const regle =
    chinois >= 4
      ? "La demande est en chinois : tous les textes que le programme affiche sont en chinois, montants en yuans (¥) sauf demande contraire, dates AAAA-MM-JJ."
      : francais > anglais
        ? "La demande est en français : tous les textes que le programme affiche (titres, boutons, messages, sorties) sont en français, montants en euros au format français (1 234,50 €), dates JJ/MM/AAAA, sauf si la demande dit autre chose."
        : anglais > 0
          ? "The request is in English: every text the program shows is in English, with the usual conventions of the request (currency, dates), unless it says otherwise."
          : "Tous les textes que le programme affiche sont dans la langue de la demande, avec ses usages (monnaie, dates, nombres).";
  return `\n- ${regle} Les noms dans le code (fonctions, variables) peuvent rester en anglais.`;
}

/** Le début de chaque relance : sessionsCode.ts s'en sert pour ne pas l'afficher comme un message de la personne. */
export const ENTETE_RELANCE = "[Contrôle automatique de OxoAI] Le travail n'est pas terminé : un programme a vérifié les fichiers (et, selon le projet, essayé les pages ou lancé les tests), et a trouvé ces problèmes :";

/*
 * La méthode jointe à chaque demande de code (index.ts), quel que soit le
 * modèle. Tirée des essais du 26/09/2026 avec Qwen3 8B : ses « edit » échouaient
 * faute de recopier exactement le texte à remplacer (trois fois de suite sur un
 * fichier de 30 lignes), puis il annonçait le travail fait. Réécrire en entier
 * un fichier court a marché du premier coup. Le marqueur du début sert à
 * retirer ce texte de l'historique affiché (sessionsCode.ts).
 */
export const METHODE_CODE = [
  "",
  "",
  "---",
  "Méthode de travail (OxoAI), pour un travail juste du premier coup :",
  "- Avant de modifier un fichier, lis-le. Un fichier de moins de 300 lignes : réécris-le EN ENTIER avec write, plutôt qu'avec edit. Un fichier plus long : edit, en recopiant exactement le texte à remplacer, lu juste avant.",
  "- Un morceau à la fois : un fichier complet et juste, puis le suivant. Relis chaque fichier écrit.",
  "- N'utilise que des fonctions, des champs et des fichiers qui existent vraiment : vérifie-les dans le code avant de t'en servir.",
  "- Un programme (script, outil, bibliothèque, API) : écris aussi ses tests automatiques (pytest ou unittest en Python, node --test ou le script « test » en JavaScript). OxoAI les lance après toi, dans un bac à sable sans réseau, et te renvoie ce qui échoue.",
  "- Ne dis « fait », « corrigé » ou « testé » que pour ce que tu as vraiment fait. Un programme contrôlera ton travail après toi et te renverra ce qui ne va pas.",
].join("\n");

/** Relances automatiques par demande de la personne : au-delà, on s'arrête et on dit ce qui reste. */
export const TOURS_MAX = 5;
const FICHIERS_MAX = 2000;
const PAGES_ESSAYEES_MAX = 3;
const WEB = new Set([".html", ".htm", ".css", ".js", ".mjs"]);

interface Suivi {
  /** Début de la demande de la personne (ms) : les fichiers modifiés depuis sont ceux du travail. */
  debut: number;
  /** Relances automatiques déjà faites pour cette demande. */
  tours: number;
  /** Une relance automatique vient de partir : sa fin de tour ne remet pas le compteur à zéro. */
  enRelance: boolean;
  /** La personne a arrêté : pas de contrôle ni de relance jusqu'à sa prochaine demande. */
  arrete?: boolean;
}
const suivis = new Map<string, Suivi>();

/** Une demande de la personne (pas une relance de OxoAI) : nouveau travail, compteur à zéro. */
export function nouvelleDemandeCode(sessionID: string): void {
  const s = suivis.get(sessionID);
  if (s?.enRelance) {
    s.enRelance = false;
    return;
  }
  suivis.set(sessionID, { debut: Date.now() - 2000, tours: 0, enRelance: false });
  // Une nouvelle demande de la personne remplace le plan en cours (index.ts en pose un nouveau s'il le faut).
  oublierSequence(sessionID);
}

/** « Arrêter » : plus aucune relance automatique pour cette demande (la personne a repris la main). */
export function arretDemandeCode(sessionID: string): void {
  const s = suivis.get(sessionID);
  if (s) {
    s.tours = TOURS_MAX;
    s.enRelance = false;
    s.arrete = true;
  }
  oublierSequence(sessionID);
}

/** La personne a-t-elle arrêté la demande en cours (pendant la préparation d'une application, par exemple) ? */
export function demandeArretee(sessionID: string): boolean {
  return suivis.get(sessionID)?.arrete === true;
}

/** Fichiers web du dossier modifiés depuis `depuis`, sans node_modules ni fichiers cachés. */
function modifiesDepuis(dossier: string, depuis: number, extensions: Set<string> = WEB): string[] {
  const trouves: string[] = [];
  const pile = [dossier];
  let vus = 0;
  while (pile.length > 0 && vus < FICHIERS_MAX) {
    const courant = pile.pop()!;
    let noms: string[] = [];
    try {
      noms = readdirSync(courant);
    } catch {
      continue;
    }
    for (const nom of noms) {
      if (nom.startsWith(".") || nom === "node_modules" || nom === "dist" || nom === "build") continue;
      const chemin = join(courant, nom);
      vus++;
      let st;
      try {
        st = statSync(chemin);
      } catch {
        continue;
      }
      if (st.isDirectory()) pile.push(chemin);
      else if (extensions.has(extname(nom).toLowerCase()) && st.mtimeMs >= depuis && !estProtege(chemin)) trouves.push(chemin);
    }
  }
  return trouves;
}

/*
 * Au-delà du web : Python et JSON, ajoutés le 26/09/2026 (« tout doit être
 * optimisé pour qu'un petit modèle soit vraiment utile en code »). Sans rien
 * exécuter de ce que l'agent a écrit : Python est seulement analysé (`ast.parse`
 * lit le texte, n'importe ni ne lance rien), JSON seulement relu.
 */
const AUTRES = new Set([".py", ".json", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);
const JS = /\.(m|c)?(j|t)sx?$/i;
/** Fichiers de réglages qui admettent des commentaires : ce n'est pas du JSON strict. */
const JSON_TOLERANT = /^(tsconfig|jsconfig)[\w.-]*\.json$|^\.?(eslintrc|babelrc)|settings\.json$|launch\.json$|extensions\.json$/i;


/*
 * Les imports relatifs d'un fichier JavaScript ou TypeScript : le fichier visé
 * existe-t-il, et exporte-t-il les noms demandés ? Relevé dans le texte, sans
 * rien exécuter. Les paquets (« react », « node:fs ») ne sont pas jugés ici.
 */
const EXTENSIONS_JS = ["", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", "/index.js", "/index.ts", "/index.tsx", "/index.jsx", "/index.mjs"];
function resoudreJs(depuis: string, chemin: string): string | null {
  const base = join(dirname(depuis), chemin);
  for (const e of EXTENSIONS_JS) {
    const c = base + e;
    try {
      if (statSync(c).isFile()) return c;
    } catch {}
  }
  // « ./x.js » écrit pour un fichier x.ts (usage de TypeScript).
  const sansExt = base.replace(/\.(m|c)?js$/, "");
  for (const e of [".ts", ".tsx", ".mts", ".cts"]) {
    try {
      if (statSync(sansExt + e).isFile()) return sansExt + e;
    } catch {}
  }
  return null;
}
function exportsJs(code: string): { noms: Set<string>; defaut: boolean; tout: boolean } {
  const noms = new Set<string>();
  for (const m of code.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum|abstract\s+class|namespace)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu)) noms.add(m[1]!);
  for (const m of code.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const x of m[1]!.split(",")) {
      const n = x.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) noms.add(n.replace(/^type\s+/, ""));
    }
  }
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s*\{([^}]*)\}/g)) for (const x of m[1]!.split(",")) noms.add(x.trim().split(":").pop()!.trim());
  const commonjs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(code);
  for (const m of code.matchAll(/\bexports\.([\p{L}_$][\p{L}\p{N}_$]*)\s*=/gu)) noms.add(m[1]!);
  const cjsObjet = /module\.exports\s*=\s*\{([^}]*)\}/.exec(code);
  if (cjsObjet) for (const x of cjsObjet[1]!.split(",")) noms.add(x.trim().split(":")[0]!.trim());
  return { noms, defaut: /\bexport\s+default\b|\bexport\s*\{[^}]*\bas\s+default\b/.test(code) || commonjs, tout: /\bexport\s*\*\s*from\b/.test(code) || (commonjs && !cjsObjet && !/exports\.[A-Za-z_$]/.test(code)) };
}
export function problemesImportsJs(dossier: string, fichiers: string[]): string[] {
  const problemes: string[] = [];
  const rel = (f: string) => relative(dossier, f) || f;
  for (const f of fichiers.slice(0, 40)) {
    let code = "";
    try {
      code = readFileSync(f, "utf8").slice(0, 400_000);
    } catch {
      continue;
    }
    const sansCommentaires = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    // Une instruction à la fois : la clause ne franchit ni « ; » ni un autre « import » / « export » (sinon « from "react" » se collait à l'import suivant).
    const imports = sansCommentaires.matchAll(/\bimport\s+(type\s+)?((?:(?!\bimport\b|\bexport\b)[^;"'])*?)\s*\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bexport\s+(?:(?!\bimport\b|\bexport\b)[^;"'])*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|\bimport\s+["'](\.{1,2}\/[^"']+)["']/g);
    for (const m of imports) {
      const chemin = m[3] ?? m[4] ?? m[5] ?? m[6]!;
      if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|json|html|md|txt|wasm)$/i.test(chemin)) {
        try {
          statSync(join(dirname(f), chemin));
        } catch {
          problemes.push(`${rel(f)} : importe « ${chemin} », qui n'existe pas.`);
        }
        continue;
      }
      const cible = resoudreJs(f, chemin);
      if (!cible) {
        problemes.push(`${rel(f)} : importe « ${chemin} », qui n'existe pas dans le projet. Écris ce fichier, ou corrige le chemin.`);
        continue;
      }
      if (!m[2] || m[1]) continue;
      let codeCible = "";
      try {
        codeCible = readFileSync(cible, "utf8").slice(0, 400_000);
      } catch {
        continue;
      }
      const ex = exportsJs(codeCible);
      if (ex.tout) continue;
      const clause = m[2].trim();
      const accolades = /\{([^}]*)\}/.exec(clause);
      const defaut = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").replace(/,/g, "").trim();
      if (defaut && !ex.defaut) problemes.push(`${rel(f)} : importe « ${defaut} » par défaut depuis ${rel(cible)}, qui n'a pas d'export par défaut (exports : ${[...ex.noms].slice(0, 12).join(", ") || "aucun"}).`);
      if (accolades) {
        const manquants = accolades[1]!
          .split(",")
          .map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
          .filter((x) => x && x !== "default" && !ex.noms.has(x));
        if (manquants.length) {
          problemes.push(`${rel(f)} : importe ${manquants.map((x) => `« ${x} »`).join(", ")} depuis ${rel(cible)}, qui ne l'exporte pas (exports : ${[...ex.noms].slice(0, 12).join(", ") || "aucun"}). Exporte-le là-bas, ou importe un nom qui existe.`);
        }
      }
    }
  }
  return problemes;
}

async function problemesAutres(dossier: string, depuis: number): Promise<{ problemes: string[]; fichiers: number }> {
  const touches = modifiesDepuis(dossier, depuis, AUTRES).slice(0, 60);
  const problemes: string[] = [];
  const rel = (f: string) => relative(dossier, f) || f;
  for (const f of touches.filter((x) => x.endsWith(".json") && !JSON_TOLERANT.test(basename(x)))) {
    try {
      const st = statSync(f);
      if (st.size > 2_000_000) continue;
      JSON.parse(readFileSync(f, "utf8"));
    } catch (err) {
      problemes.push(`${rel(f)} : JSON invalide (${(err instanceof Error ? err.message : String(err)).slice(0, 160)}).`);
    }
  }
  const python = touches.filter((x) => x.endsWith(".py"));
  if (python.length > 0) {
    const r = await new Promise<string>((resolve) => {
      // Sous Windows, `python3` n'existe pas : le Python que OxoAI a posé, s'il l'a posé (pythonPrive.ts).
      execFile(process.platform === "win32" ? (pythonPrive() ?? "python") : "python3", ["-I", "-B", "-c", ANALYSE_PYTHON, dossier, ...python], { timeout: 30_000, maxBuffer: 2_000_000 }, (err, stdout) => resolve(err ? "" : stdout));
    });
    try {
      for (const e of JSON.parse(r || "[]") as { f: string; l: number; k: string; m: string }[]) {
        const ou = `${rel(e.f)}${e.l ? `, ligne ${e.l}` : ""}`;
        if (e.k === "syntaxe") problemes.push(`${ou} : erreur de syntaxe Python (${e.m}).`);
        else if (e.k === "nom") problemes.push(`${ou} : « ${e.m} » n'est défini nulle part (ni importé, ni écrit dans le fichier). Écris-le, importe-le, ou corrige le nom.`);
        else if (e.k === "import") problemes.push(`${ou} : import impossible, ${e.m}. Importe un nom qui existe dans ce fichier, ou écris-le d'abord.`);
        else if (e.k === "module") problemes.push(`${ou} : le module « ${e.m} » n'est ni installé ni dans le projet, ni listé dans requirements.txt. Ajoute-le à requirements.txt, ou utilise la bibliothèque standard.`);
      }
    } catch {
      // Python absent ou réponse illisible : rien n'est affirmé.
    }
  }
  for (const x of problemesImportsJs(dossier, touches.filter((f) => JS.test(f)))) problemes.push(x);
  return { problemes, fichiers: touches.length };
}

interface RapportRendu {
  ok?: boolean;
  console?: string[];
  ressources?: string[];
  texteAuChargement?: number;
  illisibles?: { texte: string; balise: string; contraste: number }[];
  essais?: { quoi: string; probleme: string }[];
  erreurs?: string[];
}

/** Essaie une page dans le navigateur de l'application ; `null` si l'application ne le prête pas (passerelle seule). */
async function essayerPage(fichier: string, racine: string): Promise<RapportRendu | null> {
  const url = process.env.OXOAI_RENDU_URL;
  const cle = process.env.OXOAI_RENDU_CLE;
  if (!url || !cle) return null;
  try {
    const r = await fetch(`${url}/rendre`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OxoAI-Cle": cle },
      // La racine du projet : la page n'est servie que depuis là (electron/rendu.cjs).
      body: JSON.stringify({ fichier, racine }),
      signal: AbortSignal.timeout(40_000),
    });
    return r.ok ? ((await r.json()) as RapportRendu) : null;
  } catch {
    return null;
  }
}

/** Les problèmes d'une page essayée, en phrases pour l'agent. */
function problemesDuRendu(page: string, r: RapportRendu): string[] {
  const p: string[] = [];
  for (const m of [...(r.console ?? []), ...(r.erreurs ?? [])]) p.push(tf("{0} : erreur à l'exécution : {1}", page, m));
  for (const m of r.ressources ?? []) p.push(tf("{0} : fichier ou ressource introuvable : {1}", page, m));
  if ((r.texteAuChargement ?? 1) < 30) {
    p.push(tf("{0} : la page s'ouvre (presque) vide ; le premier écran doit montrer quelque chose d'utile sans avoir à cliquer (une section active par défaut, par exemple).", page));
  }
  for (const i of r.illisibles ?? []) {
    p.push(tf("{0} : texte illisible « {1} » ({2}) : contraste {3} sur son fond, il faut au moins 4,5.", page, i.texte, i.balise, String(i.contraste)));
  }
  // Un bouton qui échoue sur une erreur déjà dite n'ajoute rien : on ne répète pas la même cause.
  const dites = new Set([...(r.console ?? []), ...(r.erreurs ?? [])]);
  for (const e of r.essais ?? []) {
    if (dites.has(e.probleme)) continue;
    dites.add(e.probleme);
    p.push(tf("{0} : {1} : {2}", page, e.quoi, e.probleme));
  }
  return p;
}

/** Les fonctions réellement définies dans les scripts d'un dossier : ce que l'agent peut appeler. */
function fonctionsDefinies(dossier: string): string[] {
  const noms = new Set<string>();
  for (const f of modifiesDepuis(dossier, 0).filter((x) => /\.m?js$/i.test(x)).slice(0, 20)) {
    let code = "";
    try {
      code = readFileSync(f, "utf8").slice(0, 400_000);
    } catch {
      continue;
    }
    for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) {
      noms.add(m[1] ?? m[2]!);
    }
  }
  return [...noms].slice(0, 60);
}

/*
 * L'ordre compte pour un petit modèle : il corrige d'abord ce qu'il lit en
 * premier. Les erreurs qui cassent tout (syntaxe, exécution, fonction absente)
 * passent devant la lisibilité et les formulaires.
 */
const gravite = (p: string) =>
  /syntaxe|compile|SyntaxError|JSON invalide/i.test(p) ? 0 : /n'est défini nulle part|import impossible|importe « /i.test(p) ? 1 : /erreur à l'exécution|n'est définie|introuvable|absent/i.test(p) ? 1 : /vide/i.test(p) ? 2 : 3;

/** Contrôle ce que le tour a modifié. Rend les problèmes (vides si tout va bien) et ce qui a été vérifié. */
export async function controlerTourCode(
  sessionID: string,
  dossier: string,
): Promise<{ problemes: string[]; fichiers: number; pagesEssayees: number; essaiReel: boolean; dossiers?: string[]; tests?: { commande: string; reussi: boolean; nonLances?: boolean } }> {
  const suivi = suivis.get(sessionID);
  const depuis = suivi?.debut ?? Date.now() - 10 * 60_000;
  const autres = await problemesAutres(dossier, depuis);
  /*
   * Les tests du projet, lancés dans le bac à sable (essaisCode.ts), quand le
   * tour a touché du code et que rien ne casse déjà à la lecture.
   */
  const essaiDesTests = async (problemes: string[]) => {
    if (problemes.some((x) => /syntaxe|compile|SyntaxError/i.test(x))) return undefined;
    const r = await essayerTests(dossier).catch(() => null);
    if (!r) return undefined;
    /*
     * Des tests, mais pas de bac à sable sur ce système (Windows, Linux) : ils
     * ne sont pas lancés, et le compte rendu le dit au lieu de se taire (audit
     * du 27/09/2026).
     */
    if ("sans" in r) return { commande: "", reussi: false, nonLances: true };
    if (!r.reussi) {
      problemes.push(
        `Les tests du projet échouent (${r.commande}, lancés par OxoAI dans un bac à sable, sans réseau). Fin de la sortie :\n${r.sortie.slice(-1800)}\nCorrige le programme ; si c'est le test qui se trompe, corrige le test.`,
      );
    }
    return { commande: r.commande, reussi: r.reussi };
  };
  const touches = modifiesDepuis(dossier, depuis);
  if (touches.length === 0) {
    const tests = autres.fichiers > 0 ? await essaiDesTests(autres.problemes) : undefined;
    return { problemes: autres.problemes, fichiers: autres.fichiers, pagesEssayees: 0, essaiReel: false, dossiers: [], ...(tests ? { tests } : {}) };
  }
  const dossiers = [...new Set(touches.map((f) => dirname(f)))];
  const retenus = dossiers.filter((d) => !dossiers.some((p) => p !== d && d.startsWith(p + sep)));
  const problemes: string[] = [...autres.problemes];
  let fichiers = autres.fichiers;
  for (const d of retenus) {
    const r = controler(d, { racine: dossier });
    fichiers += r.fichiers;
    for (const x of r.problemes) if (!problemes.includes(x)) problemes.push(x);
  }
  // Une application préparée par OxoAI (application.ts) : ses règles du métier, vérifiées sur le plan.
  if (applicationPreparee(dossier)) {
    let prepareeCeTour = false;
    try {
      prepareeCeTour = statSync(join(dossier, "app", "plan.js")).mtimeMs >= depuis;
    } catch {}
    for (const x of problemesMetier(dossier, prepareeCeTour)) if (!problemes.includes(x)) problemes.push(x);
  }
  const pages = touches.filter((f) => /\.html?$/i.test(f));
  // Une page non touchée mais dont le script ou la feuille l'a été : on essaie l'index de son dossier.
  for (const d of retenus) {
    const index = join(d, "index.html");
    if (!pages.includes(index) && modifiesDepuis(d, 0).includes(index)) pages.push(index);
  }
  let pagesEssayees = 0;
  let essaiReel = false;
  // Pas d'essai réel d'une page dont le script ne compile pas : l'erreur est déjà dite.
  if (!problemes.some((x) => /syntaxe|compile|SyntaxError/i.test(x))) {
    for (const page of pages.slice(0, PAGES_ESSAYEES_MAX)) {
      const r = await essayerPage(page, dossier);
      if (!r) break;
      essaiReel = true;
      pagesEssayees++;
      for (const x of problemesDuRendu(relative(dossier, page) || page, r)) if (!problemes.includes(x)) problemes.push(x);
    }
  }
  const tests = await essaiDesTests(problemes);
  problemes.sort((a, b) => gravite(a) - gravite(b));
  return { problemes: problemes.slice(0, 30), fichiers, pagesEssayees, essaiReel, dossiers: retenus, ...(tests ? { tests } : {}) };
}

/**
 * Fin d'un tour : contrôle, puis relance si besoin. `relancer` envoie un texte
 * à la session (index.ts, même modèle et même dossier) ; `statut` écrit dans
 * le panneau de suivi.
 */
export async function apresTourCode(
  sessionID: string,
  dossier: string,
  relancer: (texte: string) => Promise<boolean>,
  statut: (message: string) => void,
): Promise<void> {
  let suivi = suivis.get(sessionID);
  if (suivi?.arrete) return;
  if (!suivi) {
    suivi = { debut: Date.now() - 10 * 60_000, tours: 0, enRelance: false };
    suivis.set(sessionID, suivi);
  }
  statut(t("Contrôle automatique du code écrit..."));
  const r = await controlerTourCode(sessionID, dossier);
  /*
   * Une étape propre (ou sans fichier à contrôler) : l'étape suivante du plan
   * part, avec la carte du projet à jour (sequenceCode.ts). Les corrections
   * repartent de zéro pour chaque étape.
   */
  const passerALaSuite = async (): Promise<boolean> => {
    const enCours = sequenceEnCours(sessionID);
    if (!enCours) return false;
    const suite = etapeSuivante(sessionID);
    if (!suite) {
      statut(tf("Plan de OxoAI terminé : les {0} étapes sont faites et contrôlées.", enCours.total));
      return true;
    }
    suivi!.tours = 0;
    suivi!.enRelance = true;
    statut(tf("Étape {0} sur {1} : {2}", suite.numero, suite.total, suite.titre));
    console.log(`[code] plan : étape ${suite.numero}/${suite.total}.`);
    if (!(await relancer(suite.texte + METHODE_CODE + consigneLangue(suite.demande)))) {
      suivi!.enRelance = false;
      oublierSequence(sessionID);
      statut(t("Contrôle automatique : la demande de correction n'a pas pu partir."));
    }
    return true;
  };
  if (r.fichiers === 0) {
    if (await passerALaSuite()) return;
    return statut("");
  }
  if (r.problemes.length === 0) {
    const nonLances = r.tests?.nonLances
      ? ` ${tf("Les tests du projet n'ont pas été lancés : sur ce système, {0} n'a pas de bac à sable où les faire tourner sans risque.", nomProduit())}`
      : "";
    statut(
      (r.tests?.reussi
        ? tf("Contrôle automatique : {0} fichier(s) vérifié(s), et les tests du projet réussissent ({1}, dans un bac à sable).", r.fichiers, r.tests.commande)
        : r.essaiReel
        ? tf("Contrôle automatique : {0} fichier(s) vérifié(s) et {1} page(s) essayée(s), aucun problème trouvé.", r.fichiers, r.pagesEssayees)
        : (r.dossiers?.length ?? 0) === 0
          ? tf("Contrôle automatique : {0} fichier(s) vérifié(s), aucun problème trouvé.", r.fichiers)
          : tf("Contrôle automatique : {0} fichier(s) vérifié(s), aucun problème trouvé (pages non essayées : navigateur de l'application indisponible).", r.fichiers)) + nonLances,
    );
    console.log(`[code] contrôle automatique : propre (${r.fichiers} fichiers, ${r.pagesEssayees} pages essayées).`);
    await passerALaSuite();
    return;
  }
  if (suivi.tours >= TOURS_MAX) {
    // La liste elle-même : la personne voit ce qui reste, au lieu d'un « terminé » trompeur.
    statut([tf("Contrôle automatique : {0} problème(s) restent après {1} corrections :", r.problemes.length, TOURS_MAX), ...r.problemes.slice(0, 10).map((x) => `- ${x}`)].join("\n"));
    // Continuer le plan sur une étape cassée empilerait les erreurs : il s'arrête là, et l'écran le dit.
    const enCours = sequenceEnCours(sessionID);
    if (enCours) {
      oublierSequence(sessionID);
      statut(tf("Plan de OxoAI arrêté à l'étape {0} sur {1} : les problèmes ci-dessus restent à régler.", enCours.courante + 1, enCours.total));
    }
    console.log(`[code] contrôle automatique : ${r.problemes.length} problème(s) restent après ${TOURS_MAX} tours.`);
    return;
  }
  suivi.tours++;
  suivi.enRelance = true;
  statut(tf("Contrôle automatique : {0} problème(s) trouvé(s), l'agent les corrige (correction {1} sur {2}).", r.problemes.length, suivi.tours, TOURS_MAX));
  console.log(`[code] contrôle automatique : ${r.problemes.length} problème(s), relance ${suivi.tours}/${TOURS_MAX}.`);
  // Une fonction appelée qui n'existe pas : on lui dit celles qui existent, pour qu'il appelle la bonne ou écrive la manquante.
  const definies = r.problemes.some((x) => /n'est définie/.test(x)) ? [...new Set((r.dossiers ?? []).flatMap(fonctionsDefinies))] : [];
  const texte = [
    // Le texte en toutes lettres : le relevé des traductions (scripts/i18n-passerelle.mjs) ne lit que les chaînes écrites dans t().
    t("[Contrôle automatique de OxoAI] Le travail n'est pas terminé : un programme a vérifié les fichiers (et, selon le projet, essayé les pages ou lancé les tests), et a trouvé ces problèmes :"),
    ...r.problemes.map((x) => `- ${x}`),
    ...(definies.length > 0 ? ["", tf("Fonctions qui existent vraiment dans les scripts : {0}. Écris celles qui manquent, ou appelle celles-ci.", definies.join(", "))] : []),
    "",
    t("Un fichier de moins de 300 lignes : réécris-le en entier avec write, plutôt qu'avec edit (un edit échoue si le texte à remplacer n'est pas recopié à l'identique)."),
    t("Corrige-les tous, dans les fichiers concernés. Relis chaque fichier modifié en entier avant de dire que c'est fini. Ne réponds pas « c'est fait » sans avoir corrigé : le contrôle repassera après toi."),
  ].join("\n");
  const ok = await relancer(texte);
  if (!ok) {
    suivi.enRelance = false;
    statut(t("Contrôle automatique : la demande de correction n'a pas pu partir."));
  }
}
