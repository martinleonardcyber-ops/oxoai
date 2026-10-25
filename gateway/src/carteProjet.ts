import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { estProtege } from "./zonesProtegees.ts";

/**
 * La carte du projet : les fichiers du dossier et, pour chacun, ce qu'il
 * définit (fonctions, classes, exports, identifiants d'une page), en quelques
 * milliers de caractères.
 *
 * Demandé par Medhi le 26/09/2026 : OxoAI Code doit être bon « sur tous les
 * domaines de code », même avec un petit modèle et un petit contexte. Mesuré
 * sur les essais du jour avec Qwen3 8B : ses erreurs viennent surtout de ce
 * qu'il ne sait pas ce qui existe (fonction appelée qui n'existe pas, champ
 * inventé, fichier modifié à l'aveugle). Lire tout le projet déborderait son
 * contexte (celui d'OpenCode en prend déjà 18 000 jetons sur 32 000) ; la
 * carte lui dit l'essentiel en une fois, et il n'ouvre que ce dont il a besoin.
 *
 * Rien n'est exécuté : les définitions sont relevées dans le texte.
 */

const IGNORES = /^(node_modules|\.git|\.svn|\.hg|dist|build|out|target|coverage|__pycache__|\.venv|venv|env|\.next|\.nuxt|\.cache|\.idea|\.vscode|\.DS_Store|vendor|Pods)$/;
const FICHIERS_MAX = 400;
const TAILLE_LUE_MAX = 300_000;

const CODE = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".html", ".htm", ".css", ".json", ".go", ".rs", ".java", ".kt", ".php", ".rb", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".sql", ".vue", ".svelte"]);

/** Les définitions d'un fichier, relevées dans son texte selon son langage. */
function definitions(fichier: string, texte: string): string[] {
  const ext = extname(fichier).toLowerCase();
  const noms: string[] = [];
  const relever = (re: RegExp, format: (m: RegExpMatchArray) => string | undefined = (m) => m[1]) => {
    for (const m of texte.matchAll(re)) {
      const n = format(m);
      if (n && !noms.includes(n)) noms.push(n);
      if (noms.length >= 40) break;
    }
  };
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte"].includes(ext)) {
    relever(/^\s*export\s+default\s+(?:async\s+)?(?:function|class)\s*([A-Za-z_$][\w$]*)?/gm, (m) => `export default ${m[1] ?? ""}`.trim());
    relever(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm, (m) => `${m[1]}(${m[2]!.replace(/\s+/g, " ").slice(0, 60)})`);
    relever(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, (m) => `class ${m[1]}`);
    relever(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|[A-Za-z_$][\w$]*)\s*=>/gm, (m) => `${m[1]}(${(m[2] ?? "").replace(/\s+/g, " ").slice(0, 60)})`);
    relever(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (m) => m[1]);
    relever(/^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, (m) => `type ${m[1]}`);
    relever(/^\s*export\s*\{([^}]+)\}/gm, (m) => `export { ${m[1]!.replace(/\s+/g, " ").trim().slice(0, 80)} }`);
    relever(/^\s*(?:app|router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/gm, (m) => `${m[1]!.toUpperCase()} ${m[2]}`);
  } else if (ext === ".py") {
    relever(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm, (m) => `${m[1]}(${m[2]!.replace(/\s+/g, " ").slice(0, 60)})`);
    relever(/^class\s+([A-Za-z_]\w*)/gm, (m) => `class ${m[1]}`);
    relever(/^ {4}(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, (m) => (m[1]!.startsWith("__") && m[1] !== "__init__" ? undefined : `.${m[1]}()`));
    relever(/^([A-Z][A-Z0-9_]+)\s*=/gm, (m) => m[1]);
    relever(/@(?:app|router|bp)\.(?:route|get|post|put|delete)\(\s*["']([^"']+)/g, (m) => `route ${m[1]}`);
    if (/^if\s+__name__\s*==\s*["']__main__["']/m.test(texte)) noms.push("(programme principal)");
  } else if (ext === ".html" || ext === ".htm") {
    const titre = /<title>([^<]{1,80})<\/title>/i.exec(texte)?.[1];
    if (titre) noms.push(`titre « ${titre.trim()} »`);
    relever(/<script[^>]+src=["']([^"']+)["']/gi, (m) => `script ${m[1]}`);
    relever(/<link[^>]+href=["']([^"']+\.css)["']/gi, (m) => `style ${m[1]}`);
    relever(/\bid=["']([^"']+)["']/gi, (m) => `#${m[1]}`);
  } else if (ext === ".json" && /package\.json$/.test(fichier)) {
    try {
      const p = JSON.parse(texte) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      if (p.scripts) noms.push(`scripts : ${Object.keys(p.scripts).slice(0, 12).join(", ")}`);
      const dep = [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})];
      if (dep.length) noms.push(`dépendances : ${dep.slice(0, 20).join(", ")}`);
    } catch {
      noms.push("(JSON illisible)");
    }
  } else if (ext === ".go") {
    relever(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm);
    relever(/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm, (m) => `type ${m[1]}`);
  } else if (ext === ".rs") {
    relever(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm);
    relever(/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm, (m) => `type ${m[1]}`);
  } else if ([".java", ".kt", ".cs", ".swift", ".php", ".rb", ".cpp", ".hpp", ".c", ".h"].includes(ext)) {
    relever(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|open\s+)*(?:class|interface|struct|enum|object)\s+([A-Za-z_]\w*)/gm, (m) => `class ${m[1]}`);
    relever(/^\s*(?:def|func|fun|function)\s+([A-Za-z_]\w*[!?]?)/gm);
  } else if (ext === ".sql") {
    relever(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([A-Za-z_]\w*)/gi, (m) => `table ${m[1]}`);
  }
  return noms;
}

/** Les fichiers du projet, les plus proches de la racine d'abord. */
function fichiersDu(dossier: string): string[] {
  const trouves: string[] = [];
  const file = [dossier];
  while (file.length > 0 && trouves.length < FICHIERS_MAX) {
    const courant = file.shift()!;
    let noms: string[] = [];
    try {
      noms = readdirSync(courant).sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    for (const nom of noms) {
      if (IGNORES.test(nom) || (nom.startsWith(".") && nom !== ".env.example")) continue;
      const chemin = join(courant, nom);
      let st;
      try {
        st = statSync(chemin);
      } catch {
        continue;
      }
      if (st.isDirectory()) file.push(chemin);
      else if (!estProtege(chemin)) trouves.push(chemin);
      if (trouves.length >= FICHIERS_MAX) break;
    }
  }
  return trouves;
}

/**
 * La carte, bornée à `budget` caractères. Vide pour un dossier vide. Les
 * fichiers qui ne tiennent plus dans le budget sont nommés sans détail, puis
 * seulement comptés.
 */
export function carteDuProjet(dossier: string, budget = 6000): string {
  const fichiers = fichiersDu(dossier);
  if (fichiers.length === 0) return "";
  const lignes: string[] = [];
  let taille = 0;
  let sansDetail = 0;
  for (const f of fichiers) {
    const rel = relative(dossier, f);
    let ligne = rel;
    if (CODE.has(extname(f).toLowerCase())) {
      try {
        const st = statSync(f);
        if (st.size <= TAILLE_LUE_MAX) {
          const texte = readFileSync(f, "utf8");
          const n = texte.split("\n").length;
          const defs = definitions(f, texte);
          ligne = `${rel} (${n} lignes)${defs.length ? " : " + defs.join(", ") : ""}`;
        } else {
          ligne = `${rel} (gros fichier)`;
        }
      } catch {
        // Illisible : nommé seulement.
      }
    }
    if (taille + ligne.length + 3 > budget) {
      if (taille + rel.length + 3 <= budget) {
        lignes.push(`- ${rel}`);
        taille += rel.length + 3;
      } else sansDetail++;
      continue;
    }
    lignes.push(`- ${ligne}`);
    taille += ligne.length + 3;
  }
  if (sansDetail > 0) lignes.push(`- … et ${sansDetail} autre(s) fichier(s)`);
  return lignes.join("\n");
}

/** Le marqueur du bloc : sessionsCode.ts le retire de l'historique affiché. */
export const MARQUEUR_CARTE = "\n\n---\nCarte du projet (OxoAI)";

/** La carte, prête à joindre à une demande (vide si le dossier est vide). */
export function blocCarte(dossier: string, budget = 6000): string {
  const carte = carteDuProjet(dossier, budget);
  if (!carte) return "";
  return `${MARQUEUR_CARTE}, ce qui existe déjà dans le dossier (fichiers et ce qu'ils définissent). Sers-t'en : n'appelle que ce qui y figure ou ce que tu écris ; ouvre un fichier avant de le modifier.\n${carte}`;
}
