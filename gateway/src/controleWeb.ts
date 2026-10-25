import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Script } from "node:vm";
import { workspace } from "./mcp.ts";
import { estProtege } from "./zonesProtegees.ts";
import { echapperRegex } from "./texteBrut.ts";

/**
 * Contrôle objectif d'un site ou d'une application web (HTML, CSS, JavaScript).
 *
 * Un petit modèle qui relit son propre code n'y voit pas les erreurs entre
 * fichiers. Mesuré sur qwen3-8b, une liste de tâches « terminée et relue » :
 * la page chargeait `decoupe/taches/app.js` depuis le dossier `decoupe/taches`
 * (introuvable, donc ni style ni script), et son bouton appelait
 * `ajouterTache()`, qui n'existait nulle part. Les étapes, puis la revue
 * finale, avaient dit « tout est fait ».
 *
 * Ce contrôle ne demande rien au modèle : c'est un programme, qui lit les
 * fichiers et dit ce qui ne peut pas marcher.
 *   - chaque fichier lié (feuille de style, script, image, lien entre pages) existe ;
 *   - chaque fonction appelée depuis le HTML (`onclick="f()"`) est définie ;
 *   - chaque élément cherché par un script (`getElementById("x")`) existe dans la page ;
 *   - la syntaxe JavaScript compile, les accolades CSS s'équilibrent.
 * Il n'exécute rien : le code est compilé par `node:vm` sans être lancé.
 *
 * Il sert de deux façons : la revue finale d'un travail découpé le lance
 * d'elle-même sur les fichiers modifiés (chat.ts), et le modèle peut
 * l'appeler comme un outil, en lecture seule.
 */

const FICHIERS_MAX = 300;
const TAILLE_MAX = 1_000_000;
const PROBLEMES_MAX = 40;
const WEB = new Set([".html", ".htm", ".css", ".js", ".mjs"]);

/** Fonctions du navigateur qu'un attribut `onclick` peut appeler sans les définir. */
const FONCTIONS_NAVIGATEUR = new Set([
  "alert", "confirm", "prompt", "print", "open", "close", "history", "location", "event", "this",
  "window", "document", "console", "setTimeout", "setInterval", "fetch", "return", "if",
]);

function lister(dossier: string): string[] {
  const trouves: string[] = [];
  const pile = [dossier];
  while (pile.length > 0 && trouves.length < FICHIERS_MAX) {
    const courant = pile.pop()!;
    let noms: string[] = [];
    try {
      noms = readdirSync(courant);
    } catch {
      continue;
    }
    for (const nom of noms) {
      if (nom.startsWith(".") || nom === "node_modules") continue;
      const chemin = join(courant, nom);
      try {
        /*
         * `lstat` et non `stat` : un lien symbolique posé dans l'espace de
         * travail faisait sinon lire, et compiler, un fichier hors du
         * périmètre. On ne suit aucun lien — ni vers un dossier, ni vers un
         * fichier.
         */
        const s = lstatSync(chemin);
        if (s.isSymbolicLink()) continue;
        // Un dossier de données sans point (`OXOAI_DATA_DIR=~/OxoAIDonnees`) n'est pas parcouru non plus.
        if (s.isDirectory()) {
          if (!estProtege(chemin)) pile.push(chemin);
        }
        else if (s.isFile() && WEB.has(extname(nom).toLowerCase()) && s.size <= TAILLE_MAX) trouves.push(chemin);
      } catch {
        /* disparu, ou lien cassé : ignoré */
      }
    }
  }
  return trouves;
}

const lire = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

/** Une fonction est-elle définie dans ce code, sous l'une des formes courantes ? */
function definit(code: string, nom: string): boolean {
  const n = echapperRegex(nom);
  return new RegExp(
    `function\\s+${n}\\s*\\(|(?:const|let|var)\\s+${n}\\s*=|\\b${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)|window\\.${n}\\s*=|\\b${n}\\s*\\([^)]*\\)\\s*\\{`,
  ).test(code);
}

/** Le script crée-t-il lui-même l'élément d'identifiant `id` ? */
function creeLId(code: string, id: string): boolean {
  const i = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.id\\s*=\\s*["'\`]${i}["'\`]|setAttribute\\(\\s*["']id["']\\s*,\\s*["'\`]${i}|id\\s*=\\s*\\\\?["']${i}\\\\?["']`).test(code);
}

export function syntaxeJs(code: string, nom: string): string | null {
  // Un module (import, export) ne se compile pas comme un script : on ne juge pas sa syntaxe ici.
  if (/^\s*(import|export)\b/m.test(code)) return null;
  try {
    new Script(code, { filename: nom });
    return null;
  } catch (err) {
    const e = err as Error;
    const ligne = new RegExp(`${nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(e.stack ?? "")?.[1];
    return `erreur de syntaxe JavaScript${ligne ? ` ligne ${ligne}` : ""} : ${e.message}`;
  }
}

export function accoladesCss(code: string): string | null {
  const nu = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  const ouvrantes = (nu.match(/\{/g) ?? []).length;
  const fermantes = (nu.match(/\}/g) ?? []).length;
  return ouvrantes === fermantes ? null : `accolades déséquilibrées (${ouvrantes} ouvrantes, ${fermantes} fermantes)`;
}

/** Contenu HTML de l'élément d'identifiant `id` (balises imbriquées de même nom comprises), ou null. */
function contenuDe(html: string, id: string): string | null {
  const i = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ouverture = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["']${i}["'][^>]*>`, "i").exec(html);
  if (!ouverture) return null;
  const balise = ouverture[1]!.toLowerCase();
  const debut = ouverture.index + ouverture[0].length;
  const motif = new RegExp(`<(/?)${balise}\\b[^>]*>`, "gi");
  motif.lastIndex = debut;
  let profondeur = 1;
  for (let m = motif.exec(html); m; m = motif.exec(html)) {
    profondeur += m[1] ? -1 : 1;
    if (profondeur === 0) return html.slice(debut, m.index);
  }
  return null;
}

/**
 * Un script qui vide un conteneur (`x.innerHTML = ""`) dont la page a mis des
 * champs ou des boutons à l'intérieur les efface avec lui. Mesuré sur
 * qwen3-8b : la liste de tâches effaçait son propre champ de saisie et son
 * bouton « Ajouter » au premier affichage.
 */
function videSesControles(html: string, code: string): string[] {
  const variables = new Map<string, string>();
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.(?:getElementById\(\s*["'`]([^"'`]+)["'`]|querySelector\(\s*["'`]#([\w-]+)["'`])/g)) {
    variables.set(m[1]!, (m[2] ?? m[3])!);
  }
  const vides: string[] = [];
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\.(?:innerHTML|textContent)\s*=\s*(?:""|''|``)/g)) {
    const id = variables.get(m[1]!);
    if (!id) continue;
    const contenu = contenuDe(html, id);
    if (contenu && /<(input|button|select|textarea|form)\b/i.test(contenu)) vides.push(id);
  }
  return [...new Set(vides)];
}

/** Mots d'interface anglais qu'un texte affiché ne devrait pas porter quand la demande est en français. */
const ANGLAIS = /^(delete|add|add task|remove|submit|save|cancel|edit|enter a new task|new task|task list|to-?do list|welcome|search|close|clear|done|home|contact us|send|products?|about us|our products)$/i;

/** Textes visibles d'une page : contenu des boutons, titres, liens, et attributs placeholder, title, value. */
function textesAffichesHtml(html: string): string[] {
  const textes: string[] = [];
  for (const m of html.matchAll(/<(button|h[1-6]|a|label|title|li|th|option)\b[^>]*>([^<]{1,60})</gi)) textes.push(m[2]!.trim());
  for (const m of html.matchAll(/\b(placeholder|title|value|aria-label)\s*=\s*["']([^"']{1,60})["']/gi)) textes.push(m[2]!.trim());
  return textes.filter(Boolean);
}

/** Textes qu'un script affiche : ce qu'il met dans textContent, innerText, placeholder, value. */
function textesAffichesJs(code: string): string[] {
  return [...code.matchAll(/\.(?:textContent|innerText|placeholder|value|title)\s*=\s*["'`]([^"'`$]{1,60})["'`]/g)].map((m) => m[1]!.trim());
}

/** Classes qu'une page ou un script posent : class="…", className = "…", classList.add/toggle("…"). */
function classesPosees(html: string, code: string): Set<string> {
  const classes = new Set<string>();
  const ajouter = (liste: string) => liste.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
  for (const m of html.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)) ajouter(m[1]!);
  for (const m of code.matchAll(/className\s*=\s*(?:[^;\n]*?\?\s*)?["'`]([^"'`$]+)["'`](?:\s*:\s*["'`]([^"'`$]*)["'`])?/g)) {
    ajouter(m[1]!);
    if (m[2]) ajouter(m[2]);
  }
  for (const m of code.matchAll(/classList\.(?:add|toggle|replace)\(\s*["'`]([\w-]+)["'`]/g)) classes.add(m[1]!);
  for (const m of code.matchAll(/class\s*=\s*\\?["']([^"'\\]+)\\?["']/g)) ajouter(m[1]!);
  return classes;
}

/**
 * Une classe posée par un script (une tâche « faite ») doit pouvoir être
 * atteinte par une règle de style. Mesuré sur qwen3-8b : le script posait
 * « completed » sur la ligne, la feuille ne barrait que « .task-text.completed »,
 * une classe que rien ne posait. Cocher ne barrait donc jamais rien.
 */
function classesSansEffet(code: string, css: string, posees: Set<string>): { classe: string; regles: string[] }[] {
  const selecteurs = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
  const parScript = new Set<string>();
  for (const m of code.matchAll(/classList\.(?:add|toggle)\(\s*["'`]([\w-]+)["'`]/g)) parScript.add(m[1]!);
  for (const m of code.matchAll(/className\s*=\s*[^;\n]*?\?\s*["'`]([\w-]+)["'`]/g)) parScript.add(m[1]!);
  const resultats: { classe: string; regles: string[] }[] = [];
  for (const classe of parScript) {
    const visees = selecteurs.filter((sel) => new RegExp(`\\.${classe}(?![\\w-])`).test(sel));
    if (visees.length === 0) continue; // aucune règle : peut-être voulu (classe de repère) ; on ne devine pas.
    const atteignables = visees.filter((sel) => [...sel.matchAll(/\.([\w-]+)/g)].every((m) => posees.has(m[1]!)));
    if (atteignables.length === 0) resultats.push({ classe, regles: visees.slice(0, 3) });
  }
  return resultats;
}

/**
 * Contrôle les fichiers web d'un dossier (et de ses sous-dossiers). Rend les
 * problèmes trouvés, en phrases, chemins relatifs à l'espace de travail.
 * `langue` : celle de la demande, pour signaler les textes d'interface dans une autre.
 */
export function controler(dossier: string, options: { langue?: "fr"; racine?: string } = {}): { problemes: string[]; fichiers: number } {
  // `racine` : le dossier de projet de OxoAI Code (controleCode.ts) ; sinon l'espace de Cowork.
  const racine = options.racine ?? workspace();
  const rel = (f: string) => relative(racine, f) || f;
  const fichiers = lister(dossier);
  const problemes: string[] = [];
  const noter = (p: string) => {
    if (!problemes.includes(p) && problemes.length < PROBLEMES_MAX) problemes.push(p);
  };

  for (const f of fichiers) {
    const ext = extname(f).toLowerCase();
    if (ext === ".js" || ext === ".mjs") {
      const e = syntaxeJs(lire(f), rel(f));
      if (e) noter(`${rel(f)} : ${e}`);
    } else if (ext === ".css") {
      const e = accoladesCss(lire(f));
      if (e) noter(`${rel(f)} : ${e}`);
    }
  }

  const references = new Set<string>();
  for (const page of fichiers.filter((f) => /\.html?$/i.test(f))) {
    const html = lire(page);
    const scripts: string[] = [];
    const feuilles: string[] = [];
    // Liens locaux : feuilles de style, scripts, images, pages.
    for (const m of html.matchAll(/<(link|script|img|a|source|iframe)\b[^>]*?\b(href|src)\s*=\s*["']([^"']*)["']/gi)) {
      const brut = m[3]!.trim();
      const url = brut.split(/[?#]/)[0]!;
      if (!url || /^(https?:|\/\/|mailto:|tel:|data:|javascript:)/i.test(brut)) continue;
      let cible: string;
      try {
        cible = url.startsWith("/") ? join(dossier, url) : resolve(dirname(page), decodeURIComponent(url));
      } catch {
        continue;
      }
      if (!existsSync(cible)) {
        noter(`${rel(page)} : « ${brut} » est introuvable (cherché à ${rel(cible)}). Un chemin se donne par rapport au fichier HTML lui-même.`);
      } else {
        references.add(cible);
        if (m[1]!.toLowerCase() === "script") scripts.push(lire(cible));
        else if (/\.css$/i.test(cible)) feuilles.push(lire(cible));
      }
    }
    // Scripts écrits dans la page.
    for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const code = m[1]!;
      scripts.push(code);
      const e = syntaxeJs(code, `${rel(page)} (script de la page)`);
      if (e) noter(`${rel(page)} : ${e}`);
    }
    const toutLeCode = scripts.join("\n");
    // Fonctions appelées par les attributs onclick, onsubmit…
    for (const m of html.matchAll(/\bon[a-z]+\s*=\s*["']\s*(?:return\s+)?([A-Za-z_$][\w$]*)\s*\(/gi)) {
      const nom = m[1]!;
      if (FONCTIONS_NAVIGATEUR.has(nom) || definit(toutLeCode, nom)) continue;
      noter(`${rel(page)} : appelle ${nom}(), qui n'est définie dans aucun script chargé par cette page.`);
    }
    // Éléments cherchés par les scripts de la page.
    const ids = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!));
    for (const m of toutLeCode.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]\s*\)|querySelector(?:All)?\(\s*["'`]#([\w-]+)["'`]\s*\)/g)) {
      const id = (m[1] ?? m[2])!;
      if (ids.has(id) || creeLId(toutLeCode, id)) continue;
      noter(`${rel(page)} : un script cherche l'élément d'identifiant « ${id} », absent de la page.`);
    }
    // Accents sans encodage déclaré : « tâches » devient « tĆ¢ches » chez qui sert la page sans le préciser.
    if (/[^\x00-\x7f]/.test(html) && !/<meta\b[^>]*charset/i.test(html)) {
      noter(`${rel(page)} : la page contient des accents mais ne déclare pas son encodage : ajouter <meta charset="UTF-8"> dans <head>.`);
    }
    const styleDeLaPage = [...feuilles, ...[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!)].join("\n");
    for (const { classe, regles } of classesSansEffet(toutLeCode, styleDeLaPage, classesPosees(html, toutLeCode))) {
      noter(
        `${rel(page)} : un script pose la classe « ${classe} », mais aucune règle de style ne peut l'atteindre ` +
          `(${regles.map((r) => `« ${r} »`).join(", ")} exige une autre classe que rien ne pose) : son effet n'apparaît jamais.`,
      );
    }
    if (options.langue === "fr") {
      const anglais = [...new Set([...textesAffichesHtml(html), ...textesAffichesJs(toutLeCode)].filter((t) => ANGLAIS.test(t)))];
      if (anglais.length > 0) noter(`${rel(page)} : textes affichés en anglais alors que la demande est en français : ${anglais.slice(0, 6).map((t) => `« ${t} »`).join(", ")}.`);
      if (/<html\b[^>]*\blang\s*=\s*["']en/i.test(html)) noter(`${rel(page)} : la page se déclare en anglais (lang="en") : mettre lang="fr".`);
    }
    for (const id of videSesControles(html, toutLeCode)) {
      noter(
        `${rel(page)} : un script vide l'élément « ${id} » (innerHTML = ""), qui contient des champs ou des boutons de la page : ` +
          "ils disparaissent au premier affichage. Mettre la liste dans un élément à part, et ne vider que celui-là.",
      );
    }
  }
  // Script ou feuille qu'aucune page ne charge : un reste, ou le fichier qu'une page aurait dû charger.
  if (fichiers.some((f) => /\.html?$/i.test(f))) {
    for (const f of fichiers.filter((x) => /\.(css|m?js)$/i.test(x))) {
      if (references.has(f)) continue;
      // Un script importé par un autre script n'est pas orphelin.
      const nom = f.split(sep).pop()!;
      if (fichiers.some((g) => g !== f && /\.m?js$/i.test(g) && lire(g).includes(nom))) continue;
      noter(`${rel(f)} n'est chargé par aucune page : un fichier en trop, ou celui qu'une page devrait charger à la place d'un autre.`);
    }
  }
  return { problemes, fichiers: fichiers.length };
}

/** Contrôle les dossiers des fichiers web modifiés par un travail. Vide s'il n'y en a pas. */
export function controlerTouches(
  chemins: string[],
  options: { langue?: "fr" } = {},
): { problemes: string[]; fichiers: number; dossiers: string[] } {
  const racine = workspace();
  const dossiers = [
    ...new Set(
      chemins
        .filter((c) => WEB.has(extname(c).toLowerCase()))
        .map((c) => dirname(isAbsolute(c) ? c : resolve(racine, c)))
        .filter((d) => d === racine || d.startsWith(racine + sep)),
    ),
  ];
  // Un dossier déjà couvert par un de ses parents n'est pas contrôlé deux fois.
  const retenus = dossiers.filter((d) => !dossiers.some((p) => p !== d && d.startsWith(p + sep)));
  const problemes: string[] = [];
  let fichiers = 0;
  for (const d of retenus) {
    const r = controler(d, options);
    fichiers += r.fichiers;
    for (const p of r.problemes) if (!problemes.includes(p)) problemes.push(p);
  }
  return { problemes, fichiers, dossiers: retenus.map((d) => relative(racine, d) || ".") };
}

/* ------------------------------------------------------------------ */
/* Outil                                                               */
/* ------------------------------------------------------------------ */

export function toolsForModel(): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  return [
    {
      type: "function",
      function: {
        name: "controle__site_web",
        description:
          "Contrôle le code web d'un dossier (HTML, CSS, JavaScript) sans rien modifier : fichiers liés introuvables " +
          "(style, script, image, lien entre pages), fonctions appelées mais absentes, éléments cherchés par un script " +
          "mais absents de la page, erreurs de syntaxe. Appelle-le après avoir écrit ou modifié du code web, et corrige ce qu'il signale.",
        parameters: {
          type: "object",
          properties: { dossier: { type: "string", description: "Dossier à contrôler, relatif au dossier de travail (par exemple « site »)." } },
          required: ["dossier"],
        },
      },
    },
  ];
}

export async function callTool(nom: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
  if (nom !== "controle__site_web") return { ok: false, content: `Outil inconnu : ${nom}.` };
  const racine = workspace();
  const demande = typeof args.dossier === "string" && args.dossier.trim() ? args.dossier.trim() : ".";
  let dossier: string;
  try {
    // Le dossier doit être dans le dossier de travail, liens symboliques résolus.
    dossier = realpathSync(isAbsolute(demande) ? demande : resolve(racine, demande));
    const reel = realpathSync(racine);
    if (dossier !== reel && !dossier.startsWith(reel + sep)) return { ok: false, content: "Ce dossier est hors du dossier de travail." };
    if (estProtege(dossier)) return { ok: false, content: "Ce dossier est protégé (données de l'instance, clés, réglages) : il ne se contrôle pas." };
    if (!statSync(dossier).isDirectory()) return { ok: false, content: "Ce chemin n'est pas un dossier." };
  } catch {
    return { ok: false, content: `Dossier « ${demande} » introuvable dans le dossier de travail.` };
  }
  const r = controler(dossier);
  if (r.fichiers === 0) return { ok: true, content: "Aucun fichier HTML, CSS ou JavaScript dans ce dossier." };
  return {
    ok: true,
    content:
      r.problemes.length === 0
        ? `Aucun problème trouvé dans ${r.fichiers} fichier(s) : liens, fonctions, éléments et syntaxe sont cohérents.`
        : `${r.problemes.length} problème(s) dans ${r.fichiers} fichier(s) :\n${r.problemes.map((p) => `- ${p}`).join("\n")}`,
  };
}
