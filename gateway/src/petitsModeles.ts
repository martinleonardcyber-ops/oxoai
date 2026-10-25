import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve as resoudreChemin, sep } from "node:path";
import { accoladesCss, syntaxeJs } from "./controleWeb.ts";
import { etapeExigeAction } from "./plan.ts";
import { pythonPrive } from "./pythonPrive.ts";
import { controlerSyntaxeJs } from "./syntaxeNode.ts";
import { cheminReel, estProtege } from "./zonesProtegees.ts";

/**
 * Ce que la couche de OxoAI fait pour qu'un petit modèle (jusqu'à environ
 * 8 milliards de paramètres) code juste, dans Cowork et dans Code.
 *
 * Demandé par Medhi le 27/09/2026 : « même un modèle de 2 ou 3 milliards de
 * paramètres doit bien coder ; la couche logicielle de OxoAI doit l'aider ».
 * Contexte réel : un PC Windows sans carte graphique, où OxoAI choisit
 * Ministral 3B, Qwen3.5 4B ou Qwen3.5 2B.
 *
 * Les erreurs typiques d'un petit modèle dans une boucle d'outils, et ce qui
 * y répond ici (PROJET.md, entrée du 27/09/2026, pour les sources) :
 *  - un appel au mauvais nom (« write_file », « writeFile », « fichiers.lire »)
 *    → `reparerNomOutil`, vers un outil **proposé**, et seulement s'il n'y en a
 *    qu'un qui corresponde ;
 *  - des arguments au JSON cassé (retour à la ligne brut dans une chaîne,
 *    guillemets simples, virgule de trop, `True`, bloc ```json) → `reparerArguments`,
 *    sur la forme seulement : une chaîne restée ouverte est une valeur coupée,
 *    et reste refusée (règle de la 0.20.0, `lireArguments` de chat.ts) ;
 *  - des paramètres mal nommés (`file_path` pour `path`) → `adapterArguments` ;
 *  - un appel écrit dans le texte (`<tool_call>…`, `<function=…>` de Qwen3.5)
 *    au lieu d'un vrai appel → `appelsDansLeTexte` ;
 *  - le code recopié dans la réponse au lieu d'être écrit → `decritAuLieuDAgir`,
 *    et une relance avec un exemple ;
 *  - un fichier existant réécrit sans avoir été lu → `gardeLecture` : l'écriture
 *    ne part pas, le modèle est prié de le lire d'abord ;
 *  - du code écrit à la syntaxe fausse → `verifierEcriture` (node --check,
 *    analyse Python, JSON, CSS, scripts d'une page), le résultat joint au
 *    retour de l'outil, et une relance bornée avant de répondre (chat.ts) ;
 *  - trop d'outils, des consignes trop longues → `outilsPourPetit`,
 *    `consignePetit`, et pour OpenCode l'agent `oxoai-petit`.
 */

/* ------------------------------------------------------------------ */
/* Taille du modèle                                                    */
/* ------------------------------------------------------------------ */

/** Au-delà, un modèle n'est plus « petit » pour cette couche. */
export const TAILLE_PETIT = 8.5;

/**
 * Taille en milliards de paramètres : celle que déclare LM Studio (`params`,
 * « 3B », « 800M »), sinon celle que dit le nom (« qwen3.5-4b »,
 * « ministral-3-3b », « gemma-3n-e2b »), sinon le poids du fichier (environ
 * 0,6 Go par milliard, comme `strategie` dans plan.ts). Un modèle à experts
 * (« qwen3-30b-a3b ») compte pour sa taille totale : c'est elle qui dit ce
 * qu'il sait.
 */
export function milliardsDe(model: { id?: string; params?: string; sizeBytes?: number }): number | null {
  const declare = model.params?.match(/([\d.]+)\s*([BM])/i);
  if (declare) {
    const v = Number(declare[1]);
    if (Number.isFinite(v) && v > 0) return declare[2]!.toUpperCase() === "M" ? v / 1000 : v;
  }
  const nom = (model.id ?? "").toLowerCase().match(/(?:^|[-_/:\s.])e?(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  if (nom) {
    const v = Number(nom[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return model.sizeBytes ? model.sizeBytes / 1e9 / 0.6 : null;
}

/** Un petit modèle, au sens de cette couche. Taille inconnue : non (un service distant est supposé capable). */
export function estPetitModele(model: { id?: string; params?: string; sizeBytes?: number }): boolean {
  const taille = milliardsDe(model);
  return taille !== null && taille <= TAILLE_PETIT;
}

/* ------------------------------------------------------------------ */
/* Nom de l'outil                                                      */
/* ------------------------------------------------------------------ */

const normal = (nom: string) => nom.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Ce qu'un petit modèle écrit à la place du nom exact, vers la fin du nom
 * voulu (sans séparateurs). Relevé sur les noms d'outils des autres logiciels
 * de code qu'il a vus à l'entraînement (read, cat, create_file, str_replace…).
 */
const ALIAS: Record<string, string[]> = {
  readtextfile: ["read", "readfile", "cat", "view", "openfile", "open", "lire", "lirefichier", "getfile", "readtext"],
  writefile: ["write", "createfile", "savefile", "newfile", "create", "ecrire", "ecrirefichier", "enregistrer", "writetofile", "save"],
  editfile: ["edit", "modify", "modifyfile", "replace", "strreplace", "strreplacebasededitor", "modifier", "patch", "updatefile", "replaceinfile"],
  listdirectory: ["ls", "list", "listfiles", "listdir", "dir", "lister", "listfolder", "listerdossier"],
  createdirectory: ["mkdir", "createdir", "createfolder", "makedir", "makedirectory", "creerdossier"],
  movefile: ["mv", "move", "rename", "renamefile", "deplacer", "renommer"],
  searchfiles: ["find", "search", "glob", "findfiles", "chercher", "rechercher"],
};

/**
 * Le nom d'un outil **proposé** qui correspond à ce qu'a écrit le modèle, ou
 * null. Jamais de devinette : il faut une seule correspondance, sinon l'appel
 * reste refusé comme avant (« ne fait pas partie de ceux qui te sont proposés »).
 */
export function reparerNomOutil(nom: string, proposes: string[]): string | null {
  if (proposes.includes(nom)) return nom;
  // « functions.fichiers__write_file », « tool:write_file », « `write_file` »
  const nu = nom.trim().replace(/^[`"'\s]+|[`"'\s()]+$/g, "").replace(/^(functions?|tools?|default_api)[.:/]/i, "");
  if (proposes.includes(nu)) return nu;
  const n = normal(nu);
  if (n.length < 2) return null;
  const unique = (liste: string[]) => (liste.length === 1 ? liste[0]! : null);
  const exacts = proposes.filter((p) => normal(p) === n);
  if (exacts.length > 0) return unique(exacts);
  // Sans le préfixe du serveur (« write_file » pour « fichiers__write_file »), ou avec un autre séparateur.
  if (n.length >= 4) {
    const suffixe = unique(proposes.filter((p) => normal(p).endsWith(n) || normal(p.slice(p.indexOf("__") + 2)) === n));
    if (suffixe) return suffixe;
  }
  // Un alias connu, avec ou sans préfixe (« fichiers__read » → « fichiers__read_text_file »).
  const sansPrefixe = normal(nu.includes("__") ? nu.slice(nu.indexOf("__") + 2) : nu.replace(/^fichiers?[._:-]/i, ""));
  for (const [cible, alias] of Object.entries(ALIAS)) {
    if (!alias.includes(sansPrefixe) && !alias.includes(n)) continue;
    const trouve = unique(proposes.filter((p) => normal(p).endsWith(cible)));
    if (trouve) return trouve;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

const objet = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function essayer(texte: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(texte) as unknown;
    // Un objet encodé deux fois (« "{\"path\": …}" ») : fréquent chez les petits modèles.
    if (typeof v === "string") {
      try {
        return objet(JSON.parse(v));
      } catch {
        return null;
      }
    }
    return objet(v);
  } catch {
    return null;
  }
}

/**
 * Réécrit en JSON strict ce qu'un petit modèle a presque écrit en JSON. Rend
 * null si la réparation toucherait au fond : une chaîne jamais refermée (une
 * valeur coupée en route, qui deviendrait un faux chemin ou un fichier
 * tronqué), ou plus de trois accolades manquantes.
 *
 * Réparé, parce que c'est de la forme : retours à la ligne et tabulations bruts
 * dans une chaîne (le cas le plus courant quand il écrit le contenu d'un
 * fichier), barres obliques inverses isolées (« C:\dossier »), guillemets
 * simples, clés sans guillemets, `True`/`False`/`None`, virgules de trop,
 * accolades ou crochets finaux oubliés, guillemet intérieur non échappé quand
 * ce qui le suit montre qu'il ne ferme pas la chaîne.
 */
export function reparerJson(brut: string): string | null {
  const s = brut;
  let out = "";
  const pile: string[] = [];
  let i = 0;
  let attendCle = false;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      const guillemet = c;
      let valeur = "";
      i++;
      let ferme = false;
      while (i < s.length) {
        const d = s[i]!;
        if (d === "\\") {
          const e = s[i + 1];
          if (e === undefined) break;
          if (e === "'" && guillemet === "'") valeur += "'";
          else if ('"\\/bfnrt'.includes(e)) valeur += `\\${e}`;
          else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
            valeur += `\\u${s.slice(i + 2, i + 6)}`;
            i += 4;
          }
          // Une barre isolée (« C:\dossier », « \d ») : gardée telle quelle.
          else valeur += `\\\\${e === '"' ? '\\"' : e}`;
          i += 2;
          continue;
        }
        if (d === guillemet) {
          // Guillemet intérieur non échappé : ne ferme que s'il est suivi d'un séparateur JSON.
          const suite = s.slice(i + 1).match(/^\s*(.)/)?.[1];
          if (suite === undefined || ",}]:".includes(suite)) {
            ferme = true;
            i++;
            break;
          }
          valeur += guillemet === '"' ? '\\"' : "'";
          i++;
          continue;
        }
        if (d === '"') valeur += '\\"';
        else if (d === "\n") valeur += "\\n";
        else if (d === "\r") valeur += "\\r";
        else if (d === "\t") valeur += "\\t";
        else if (d.charCodeAt(0) < 0x20) valeur += `\\u${d.charCodeAt(0).toString(16).padStart(4, "0")}`;
        else valeur += d;
        i++;
      }
      if (!ferme) return null;
      out += `"${valeur}"`;
      attendCle = false;
      continue;
    }
    if (c === "{" || c === "[") {
      pile.push(c === "{" ? "}" : "]");
      out += c;
      attendCle = c === "{";
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      if (pile.pop() !== c) return null;
      out = out.replace(/,\s*$/, "");
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      out += c;
      attendCle = pile.at(-1) === "}";
      i++;
      continue;
    }
    // Un mot hors chaîne : clé sans guillemets, ou True / False / None.
    const mot = s.slice(i).match(/^[A-Za-z_$][\w$-]*/)?.[0];
    if (mot) {
      const apres = s.slice(i + mot.length).match(/^\s*(.)/)?.[1];
      if (attendCle && apres === ":") out += `"${mot}"`;
      else if (mot === "True" || mot === "true") out += "true";
      else if (mot === "False" || mot === "false") out += "false";
      else if (mot === "None" || mot === "null") out += "null";
      else return null;
      i += mot.length;
      attendCle = false;
      continue;
    }
    if (c === ":") attendCle = false;
    out += c;
    i++;
  }
  if (pile.length > 3) return null;
  out = out.replace(/,\s*$/, "");
  while (pile.length > 0) out += pile.pop();
  return out;
}

/**
 * Arguments d'un appel d'outil, réparés sur la forme au besoin. `repare` dit
 * si le texte d'origine n'était pas du JSON valide (pour le journal et la note
 * rendue au modèle).
 */
export function reparerArguments(brut: string): { args: Record<string, unknown> | null; repare: boolean } {
  if (!brut.trim()) return { args: {}, repare: false };
  const direct = essayer(brut);
  if (direct) return { args: direct, repare: false };
  let t = brut.trim();
  // Bloc de code autour du JSON, texte avant ou après.
  const bloc = t.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (bloc) t = bloc[1]!.trim();
  const debut = t.indexOf("{");
  if (debut > 0) t = t.slice(debut);
  const tel = essayer(t);
  if (tel) return { args: tel, repare: true };
  const fin = t.lastIndexOf("}");
  if (fin > 0 && fin < t.length - 1) {
    const coupe = essayer(t.slice(0, fin + 1));
    if (coupe) return { args: coupe, repare: true };
  }
  const repare = reparerJson(t);
  const args = repare ? essayer(repare) : null;
  return { args, repare: args !== null };
}

/** Les noms de paramètres qu'un petit modèle écrit à la place des vrais (à droite, ceux du serveur de fichiers). */
const ALIAS_CLES: Record<string, string[]> = {
  path: ["filepath", "file", "filename", "chemin", "fichier", "target", "targetfile", "dir", "directory", "folder", "dossier"],
  content: ["contents", "text", "data", "body", "code", "contenu", "texte", "filecontent", "filecontents"],
  source: ["from", "src", "sourcepath", "oldpath"],
  destination: ["to", "dest", "destinationpath", "newpath", "target"],
  pattern: ["query", "glob", "search", "motif"],
  paths: ["files", "filepaths", "fichiers"],
};

/**
 * Remet les arguments sous les noms que l'outil attend, d'après son schéma :
 * `file_path` → `path`, `text` → `content`, et pour `edit_file` des
 * `old_text`/`new_text` à plat rangés dans `edits`. Rien n'est inventé : une
 * clé n'est renommée que si le schéma a la cible, ne l'a pas déjà reçue, et
 * ne connaît pas la clé d'origine.
 */
export function adapterArguments(
  args: Record<string, unknown>,
  schema: unknown,
): { args: Record<string, unknown>; renommees: string[] } {
  const proprietes = objet(objet(schema)?.properties) ?? {};
  const connues = Object.keys(proprietes);
  if (connues.length === 0) return { args, renommees: [] };
  const sortie: Record<string, unknown> = { ...args };
  const renommees: string[] = [];
  for (const cle of Object.keys(args)) {
    if (connues.includes(cle)) continue;
    const n = normal(cle);
    const cible =
      connues.find((k) => normal(k) === n) ??
      connues.find((k) => (ALIAS_CLES[k] ?? []).includes(n));
    if (!cible || cible in sortie) continue;
    sortie[cible] = sortie[cle];
    delete sortie[cle];
    renommees.push(`${cle} → ${cible}`);
  }
  // edit_file : { path, edits: [{ oldText, newText }] } ; un petit modèle écrit volontiers les deux textes à plat.
  if (connues.includes("edits") && !Array.isArray(sortie.edits)) {
    const ancien = ["oldText", "old_text", "oldString", "old_string", "old", "search", "find"].find((k) => typeof sortie[k] === "string");
    const nouveau = ["newText", "new_text", "newString", "new_string", "new", "replace", "replacement"].find((k) => typeof sortie[k] === "string");
    if (ancien && nouveau) {
      sortie.edits = [{ oldText: sortie[ancien], newText: sortie[nouveau] }];
      delete sortie[ancien];
      delete sortie[nouveau];
      renommees.push(`${ancien}, ${nouveau} → edits`);
    } else if (objet(sortie.edits)) {
      sortie.edits = [sortie.edits];
      renommees.push("edits → [edits]");
    }
  }
  return { args: sortie, renommees };
}

/* ------------------------------------------------------------------ */
/* Appels écrits dans le texte                                         */
/* ------------------------------------------------------------------ */

/**
 * Les appels d'outils qu'un modèle a écrits dans sa réponse au lieu de les
 * faire. Deux formes vues : le JSON de Hermes dans `<tool_call>` (Qwen3,
 * beaucoup de petits modèles), et le XML de Qwen3.5
 * (`<function=nom><parameter=clé>valeur</parameter></function>`), que
 * llama.cpp laisse parfois dans le texte ou la réflexion (llama.cpp #20837,
 * #22684). Aussi : une réponse qui n'est qu'un objet `{"name", "arguments"}`.
 * Seulement vers un outil proposé.
 */
export function appelsDansLeTexte(texte: string, proposes: string[], plafond = 8): { name: string; args: string }[] {
  if (!texte || texte.length > 400_000) return [];
  const appels: { name: string; args: string }[] = [];
  const ajouterJson = (bloc: string) => {
    const lu = reparerArguments(bloc).args;
    const nom = typeof lu?.name === "string" ? lu.name : typeof lu?.tool === "string" ? lu.tool : null;
    const args = objet(lu?.arguments) ?? objet(lu?.parameters) ?? objet(lu?.args) ?? (typeof lu?.arguments === "string" ? reparerArguments(lu.arguments).args : null);
    const vrai = nom ? reparerNomOutil(nom, proposes) : null;
    if (vrai && args) appels.push({ name: vrai, args: JSON.stringify(args) });
  };
  const ajouterXml = (bloc: string) => {
    for (const f of bloc.matchAll(/<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/g)) {
      const vrai = reparerNomOutil(f[1]!, proposes);
      if (!vrai) continue;
      const args: Record<string, unknown> = {};
      for (const p of f[2]!.matchAll(/<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
        const brut = p[2]!;
        // Un nombre, un booléen ou un tableau écrit tel quel : relu comme tel ; tout le reste est du texte.
        const v = /^\s*(-?\d+(\.\d+)?|true|false|null|\[[\s\S]*\]|\{[\s\S]*\})\s*$/.test(brut) ? essayerValeur(brut) : brut;
        args[p[1]!] = v;
      }
      appels.push({ name: vrai, args: JSON.stringify(args) });
    }
  };
  const balises = [...texte.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)].map((m) => m[1]!);
  for (const b of balises) {
    if (/<function=/.test(b)) ajouterXml(b);
    else ajouterJson(b);
  }
  if (appels.length === 0 && balises.length === 0 && /<function=/.test(texte)) ajouterXml(texte);
  if (appels.length === 0 && balises.length === 0) {
    /*
     * Toute la réponse est un appel (éventuellement dans un bloc ```json).
     * Sans expression à double `[\s\S]*` ni `\s*```$` (tournée finale de la
     * 2026.928.6, SECURITE.md § 53) : sur un texte lu qui commence par `{`, porte
     * beaucoup de `"name":` ou une longue suite de blancs, elles coûtaient le
     * carré de sa taille (80 000 blancs : 6 s), à chaque appel relu par
     * `appelsLus`.
     */
    let nu = texte.trim();
    const ouverture = /^```(?:json)?/.exec(nu);
    if (ouverture) nu = nu.slice(ouverture[0].length).trimStart();
    if (nu.endsWith("```")) nu = nu.slice(0, -3).trimEnd();
    if (nu.startsWith("{") && nu.endsWith("}") && /"(name|tool)"\s*:/.test(nu)) ajouterJson(nu);
  }
  return appels.slice(0, plafond);
}

/** Un appel réduit à ce qu'il fait : le nom, et les arguments à clés triées (l'ordre et les espaces ne changent rien). */
export function empreinteAppel(appel: { name: string; args: string }): string {
  const trier = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(trier) : objet(v) ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, trier((v as Record<string, unknown>)[k])])) : v;
  let args: unknown = appel.args;
  try {
    args = JSON.parse(appel.args);
  } catch {
    /* gardé tel quel */
  }
  return `${appel.name}\u0000${JSON.stringify(trier(args))}`;
}

/**
 * Les appels écrits dans ce que le modèle a **lu** pendant la demande : un
 * résultat d'outil (une publication, un mail, une page, un fichier), un
 * document joint, un passage d'une base de connaissances, le message de la
 * personne. Tout sauf ce que le modèle a écrit lui-même.
 *
 * Tournée du 28/09/2026 (SECURITE.md § 41) : un appel écrit dans la réponse
 * est lancé comme un vrai appel (`appelsDansLeTexte`, pour les petits
 * modèles). Or un modèle à qui l'on demande de résumer une page Facebook
 * recopie volontiers ce qu'il a lu ; une publication écrite par n'importe qui
 * et contenant `<tool_call>{"name":"facebook__publier",…}</tool_call>`
 * devenait ainsi un appel « du modèle ». Essayé avec un faux modèle : la carte
 * « publier » apparaissait ; pour un outil qui ne demande rien (une lecture,
 * ou tout au niveau « Tout approuver »), il serait parti sans carte. Un appel
 * écrit qui ne fait que répéter l'un de ceux-là n'est donc pas lancé.
 */
export function appelsLus(messages: unknown[], proposes: string[]): Set<string> {
  const vus = new Set<string>();
  for (const m of messages as { role?: string; content?: unknown }[]) {
    if (!m || m.role === "assistant") continue;
    const textes =
      typeof m.content === "string"
        ? [m.content]
        : Array.isArray(m.content)
          ? (m.content as { type?: string; text?: unknown }[]).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text as string)
          : [];
    for (const texte of textes) {
      if (!/<tool_call>|<function=|"(name|tool)"\s*:/.test(texte)) continue;
      // Au-delà de la borne d'`appelsDansLeTexte`, le texte est lu par morceaux : un long résultat ne cache pas son appel.
      for (let i = 0; i < texte.length; i += 300_000) {
        for (const a of appelsDansLeTexte(texte.slice(Math.max(0, i - 4000), i + 300_000), proposes, 10_000)) vus.add(empreinteAppel(a));
      }
      // Un objet `{"name": …, "arguments": …}` au milieu du texte : la réponse qui ne serait que lui vaut un appel.
      for (const objetJson of objetsAppel(texte)) for (const a of appelsDansLeTexte(objetJson, proposes, 1)) vus.add(empreinteAppel(a));
      // Le XML de Qwen3.5 hors d'une balise `<tool_call>` : `appelsDansLeTexte` ne le lit que s'il n'y a aucune balise.
      for (const m of texte.matchAll(/<function=[^>\s]+>[\s\S]*?(?:<\/function>|$)/g)) for (const a of appelsDansLeTexte(m[0], proposes, 10_000)) vus.add(empreinteAppel(a));
    }
  }
  return vus;
}

/**
 * Les objets JSON d'un texte qui portent une clé `"name"` ou `"tool"`, **où
 * qu'elle soit dans l'objet**, refermés à leur accolade (chaînes comprises).
 *
 * Tournée finale de la 2026.928.6 (SECURITE.md § 53) : seuls les objets qui
 * commençaient par `{"name"` étaient relevés. Or la réponse du modèle faite
 * d'un seul objet est lancée comme un appel quel que soit l'ordre de ses clés
 * (`appelsDansLeTexte`). Un message Telegram, une page web ou un mail lu qui
 * écrivait `{"arguments": {…}, "name": "telegram__envoyer"}` n'était donc pas
 * reconnu comme lu : recopié seul par le modèle, il partait comme un appel
 * « du modèle » (une carte pour un envoi, rien pour une lecture ou au niveau
 * « Tout approuver ») ; avec la recherche sur le web, un vrai appel qui le
 * répétait n'était pas refusé non plus. Essayé avec les pièces seules.
 *
 * On part donc de chaque clé `"name"` / `"tool"` et on remonte à l'accolade
 * qui ouvre son objet (`ouvertureDe`), puis on le referme en avançant. Le
 * travail est borné par un budget de caractères parcourus, proportionnel au
 * texte : un texte fait pour épuiser ce budget est dit comme limite (§ 53).
 */
function objetsAppel(texte: string): string[] {
  const trouves: string[] = [];
  const debuts = new Set<number>();
  const budget = { reste: 4 * texte.length + 2_000_000 };
  for (const m of texte.matchAll(/"(?:name|tool)"\s*:/g)) {
    if (budget.reste <= 0) break;
    const debut = ouvertureDe(texte, m.index!, budget);
    if (debut < 0 || debuts.has(debut)) continue;
    debuts.add(debut);
    const objet = objetDepuis(texte, debut, budget);
    /*
     * Pas de nombre maximal d'objets (il y en avait un, 200) : deux cents
     * objets `{"name": …}` ordinaires placés avant l'appel suffisaient à le
     * cacher. Chaque objet relevé sera relu (JSON.parse) : sa longueur est
     * décomptée du même budget.
     */
    if (objet) {
      budget.reste -= objet.length;
      trouves.push(objet);
    }
  }
  return trouves;
}

/**
 * L'accolade qui ouvre l'objet dont `position` (le guillemet d'une clé) fait
 * partie, en remontant, chaînes comprises : un guillemet précédé d'un nombre
 * impair de barres obliques inverses est échappé. -1 s'il n'y en a pas à moins
 * de 100 000 caractères, ou si la clé est directement dans un tableau.
 */
function ouvertureDe(texte: string, position: number, budget: { reste: number }): number {
  let profondeur = 0;
  let dansChaine = false;
  const borne = Math.max(0, position - 100_000);
  for (let i = position - 1; i >= borne; i--) {
    budget.reste--;
    const c = texte[i];
    if (c === '"') {
      let barres = 0;
      for (let j = i - 1; j >= borne && texte[j] === "\\"; j--) barres++;
      if (barres % 2 === 0) dansChaine = !dansChaine;
      continue;
    }
    if (dansChaine) continue;
    if (c === "}" || c === "]") profondeur++;
    else if (c === "{" || c === "[") {
      if (profondeur === 0) return c === "{" ? i : -1;
      profondeur--;
    }
  }
  return -1;
}

/** L'objet qui commence à `debut` (une accolade), refermé à son accolade, chaînes comprises ; null s'il ne se referme pas à 100 000 caractères. */
function objetDepuis(texte: string, debut: number, budget: { reste: number }): string | null {
  let profondeur = 0;
  let dansChaine = false;
  for (let i = debut; i < Math.min(texte.length, debut + 100_000); i++) {
    budget.reste--;
    const c = texte[i];
    if (dansChaine) {
      if (c === "\\") i++;
      else if (c === '"') dansChaine = false;
    } else if (c === '"') dansChaine = true;
    else if (c === "{") profondeur++;
    else if (c === "}" && --profondeur === 0) return texte.slice(debut, i + 1);
  }
  return null;
}

function essayerValeur(t: string): unknown {
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return t;
  }
}

/** Le texte sans les appels qu'on vient d'en tirer : ce que le fil garde comme réponse du modèle. */
export function sansAppelsEcrits(texte: string): string {
  return texte
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "")
    .replace(/<function=[^>\s]+>[\s\S]*?(?:<\/function>|$)/g, "")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Décrire au lieu d'agir                                              */
/* ------------------------------------------------------------------ */

/** Le texte du dernier message de la personne. */
export function texteDuDernierMessage(messages: unknown[]): string {
  const m = [...(messages as { role?: string; content?: unknown }[])].reverse().find((x) => x.role === "user");
  if (typeof m?.content === "string") return m.content;
  return Array.isArray(m?.content) ? (m.content as { type?: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ") : "";
}

/** La demande de la personne (le dernier message) demande-t-elle de produire ou de changer quelque chose ? */
export function demandeUneAction(demande: string): boolean {
  if (etapeExigeAction(demande)) return true;
  return /\b(fais|faites|faire|fabrique|code|programme|make|create|write|build|save|add|fix|implement)\b/i.test(demande);
}

/**
 * La réponse donne-t-elle le code à la place de l'écrire ? Un bloc de code de
 * trois lignes au moins, ou une phrase qui renvoie la personne à la copie
 * (« enregistrez-le dans… », « créez un fichier… »). Ce qui dit qu'un fichier
 * a été écrit ne compte pas.
 */
export function decritAuLieuDAgir(texte: string): boolean {
  const t = texte.trim();
  if (!t) return false;
  const bloc = [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].some((m) => m[1]!.split("\n").filter((l) => l.trim()).length >= 3);
  const renvoie = /\b(enregistre[zr]?|copie[zr]?|colle[zr]?|cr[ée]e[zr]?|sauvegarde[zr]?)\b[^.\n]{0,40}\b(fichier|file|dans)\b|\b(save|copy|paste|create)\b[^.\n]{0,30}\b(file|as|into)\b|voici (le|un) (code|script|fichier|programme)|here is (the|a) (code|script|file)/i.test(t);
  const fait = /\b(j'ai (écrit|créé|enregistré|modifié)|i (wrote|created|saved|updated)|a été (écrit|créé|enregistré))\b/i.test(t);
  return (bloc || renvoie) && !fait;
}

/* ------------------------------------------------------------------ */
/* Outils et consignes pour un petit modèle (Cowork)                   */
/* ------------------------------------------------------------------ */

/**
 * Outils du serveur de fichiers retirés pour un petit modèle : doublons
 * (`read_file`, ancien nom de `read_text_file`), ou d'usage rare et coûteux
 * (`directory_tree` rend tout un arbre, `read_multiple_files` des milliers de
 * lignes d'un coup). Chaque définition est relue à chaque appel ; un petit
 * modèle choisit aussi mieux entre sept outils qu'entre quatorze. Les appels
 * à ces noms sont renvoyés, par `reparerNomOutil`, vers l'outil qui reste.
 */
const FICHIERS_RETIRES = ["read_file", "read_media_file", "read_multiple_files", "list_directory_with_sizes", "directory_tree", "get_file_info", "list_allowed_directories"];

export function outilsPourPetit<T>(outils: T[]): T[] {
  const noms = outils.map((o) => (o as { function?: { name?: string } }).function?.name ?? "");
  const garderLecture = !noms.includes("fichiers__read_text_file");
  return outils.filter((_, i) => {
    const nom = noms[i]!;
    if (!nom.startsWith("fichiers__")) return true;
    const court = nom.slice("fichiers__".length);
    if (court === "read_file" && garderLecture) return true;
    return !FICHIERS_RETIRES.includes(court);
  });
}

/**
 * Consigne courte et concrète, avec un exemple d'appel réussi, pour les
 * outils réellement proposés. Écrite simplement : un modèle de 2 à 4 milliards
 * suit mieux sept lignes et un exemple que trois pages de règles.
 */
export function consignePetit(nomsOutils: string[], dossier: string): string {
  const a = (nom: string) => nomsOutils.includes(nom);
  const lire = a("fichiers__read_text_file") ? "fichiers__read_text_file" : a("fichiers__read_file") ? "fichiers__read_file" : "";
  const ecrire = a("fichiers__write_file") ? "fichiers__write_file" : "";
  const lignes = [
    "Méthode de travail :",
    "1. Agis avec les outils. Pour créer ou changer un fichier, appelle l'outil d'écriture : ne recopie jamais le code dans ta réponse à la place.",
    "2. Un appel d'outil à la fois. Les arguments sont un objet JSON complet : guillemets doubles, \\n pour les retours à la ligne dans une chaîne.",
    "3. Lis un fichier qui existe avant de le modifier. Un fichier court : réécris-le en entier.",
    "4. N'utilise que les noms d'outils de ta liste, et que des fichiers, fonctions et valeurs que tu as vus.",
    "5. Si un outil renvoie une erreur, lis-la, corrige l'appel et réessaie une fois. L'instance vérifie la syntaxe de chaque fichier écrit et te le dit.",
    "6. Quand c'est fait, réponds en une ou deux phrases : ce que tu as fait, ce que tu n'as pas pu vérifier.",
  ];
  if (ecrire) {
    const chemin = `${dossier.replace(/[\\/]+$/, "")}${dossier.includes("\\") ? "\\" : "/"}bonjour.py`;
    lignes.push(
      "",
      "Exemple réussi. Demande : « crée bonjour.py qui affiche Bonjour ».",
      `Appel : ${ecrire} avec ${JSON.stringify({ path: chemin, content: 'print("Bonjour")\n' })}`,
      "Réponse : « J'ai créé bonjour.py, qui affiche Bonjour. »",
    );
    if (lire) {
      lignes.push(
        "Exemple réussi. Demande : « ajoute une ligne à notes.txt ».",
        `Appel 1 : ${lire} avec ${JSON.stringify({ path: chemin.replace("bonjour.py", "notes.txt") })}`,
        `Appel 2 : ${ecrire} avec le chemin et le contenu lu, plus la nouvelle ligne.`,
      );
    }
  }
  return lignes.join("\n");
}

/** Relance quand le modèle a donné le code au lieu de l'écrire : ce qu'il doit faire, avec l'outil exact. */
export function relanceAgir(nomsOutils: string[]): string {
  const ecrire = nomsOutils.find((n) => n.endsWith("__write_file")) ?? "l'outil d'écriture";
  return (
    "[Rappel de l'instance] Tu as écrit le code dans ta réponse, mais aucun fichier n'a été créé ni modifié. " +
    `Fais-le maintenant avec l'outil « ${ecrire} » : un appel, avec "path" (le chemin complet du fichier) et "content" (tout son contenu). ` +
    "N'écris pas d'explication avant d'avoir appelé l'outil."
  );
}

/* ------------------------------------------------------------------ */
/* Lire avant d'écrire                                                 */
/* ------------------------------------------------------------------ */

/** Ce que la demande a lu et écrit, par chemin absolu : de quoi savoir si une écriture part à l'aveugle. */
export interface SuiviFichiers {
  lus: Set<string>;
  ecrits: Set<string>;
  /** Fichiers dont l'écriture a déjà été retenue une fois : on ne bloque jamais deux fois. */
  avertis: Set<string>;
  /** Fichiers écrits dont la syntaxe est fausse, avec le problème. */
  enErreur: Map<string, string>;
}

export const nouveauSuivi = (): SuiviFichiers => ({ lus: new Set(), ecrits: new Set(), avertis: new Set(), enErreur: new Map() });

/** Chemin absolu d'un argument d'outil, dans le dossier de travail seulement. */
export function cheminDans(dossier: string, chemin: unknown): string | null {
  if (typeof chemin !== "string" || !chemin.trim()) return null;
  const absolu = isAbsolute(chemin) ? resoudreChemin(chemin) : resoudreChemin(dossier, chemin);
  return absolu === dossier || absolu.startsWith(dossier + sep) ? absolu : null;
}

const nomCourt = (outil: string) => (outil.includes("__") ? outil.slice(outil.indexOf("__") + 2) : outil);

/** Retient ce qu'un appel réussi a lu ou écrit. */
export function noterAppel(suivi: SuiviFichiers, outil: string, args: Record<string, unknown>, dossier: string): void {
  if (!outil.startsWith("fichiers__")) return;
  const court = nomCourt(outil);
  if (court === "read_text_file" || court === "read_file") {
    const c = cheminDans(dossier, args.path);
    if (c) suivi.lus.add(c);
  } else if (court === "read_multiple_files" && Array.isArray(args.paths)) {
    for (const p of args.paths) {
      const c = cheminDans(dossier, p);
      if (c) suivi.lus.add(c);
    }
  } else if (court === "write_file" || court === "edit_file") {
    const c = cheminDans(dossier, args.path);
    if (c) suivi.ecrits.add(c);
  }
}

/**
 * Un petit modèle qui réécrit un fichier existant sans l'avoir lu en efface ce
 * qu'il ne connaît pas ; qui le modifie sans l'avoir lu recopie de mémoire un
 * texte qui n'y est pas, et l'outil échoue. Comme les agents de code reconnus,
 * qui exigent la lecture avant la modification : la première fois, l'écriture
 * ne part pas, et le modèle est prié de lire d'abord le fichier. Le contenu
 * n'est pas joint ici : la lecture passe par l'outil, donc par la barrière
 * d'approbation (« Demander pour tout ») et les zones protégées, comme toute
 * autre. Une seule fois par fichier : jamais de blocage en boucle. Rend le
 * message, ou null si l'appel peut partir.
 */
export function gardeLecture(suivi: SuiviFichiers, outil: string, args: Record<string, unknown>, dossier: string, outilLecture: string): string | null {
  if (!outil.startsWith("fichiers__") || !outilLecture) return null;
  const court = nomCourt(outil);
  if (court !== "write_file" && court !== "edit_file") return null;
  const c = cheminDans(dossier, args.path);
  if (!c || suivi.lus.has(c) || suivi.ecrits.has(c) || suivi.avertis.has(c)) return null;
  // Une zone protégée : la barrière habituelle refuse l'écriture, sans que la garde dise rien du fichier.
  if (estProtege(cheminReel(c))) return null;
  try {
    const st = statSync(c);
    if (!st.isFile() || st.size === 0) return null;
  } catch {
    return null; // fichier neuf : rien à lire
  }
  suivi.avertis.add(c);
  return (
    `L'instance n'a pas lancé cette ${court === "edit_file" ? "modification" : "écriture"} : « ${basename(c)} » existe déjà et tu ne l'as pas lu. ` +
    `Lis-le d'abord avec « ${outilLecture} » (${JSON.stringify({ path: typeof args.path === "string" ? args.path : c })}), ` +
    "puis refais l'appel en partant de son contenu : garde ce qui doit rester, change seulement ce que la demande exige."
  );
}

/* ------------------------------------------------------------------ */
/* Vérifier ce qui vient d'être écrit                                  */
/* ------------------------------------------------------------------ */

/** Fichiers de réglages qui admettent des commentaires : ce n'est pas du JSON strict (comme controleCode.ts). */
const JSON_TOLERANT = /^(tsconfig|jsconfig)[\w.-]*\.json$|^\.?(eslintrc|babelrc)|settings\.json$|launch\.json$|extensions\.json$/i;

const ANALYSE_PY =
  "import ast,sys\np=sys.argv[1]\ntry:\n s=open(p,encoding='utf-8').read()\nexcept Exception:\n print('ok');sys.exit(0)\n" +
  "try:\n ast.parse(s,p);print('ok')\nexcept SyntaxError as e:\n print(str(e.lineno or 0)+'\\t'+str(e.msg))\n";

function lancer(commande: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; sortie: string; erreur: string } | null> {
  return new Promise((ok) => {
    execFile(commande, args, { timeout: 15_000, maxBuffer: 1_000_000, windowsHide: true, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      if (e && (e.code === "ENOENT" || e.killed)) return ok(null);
      ok({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, sortie: String(stdout), erreur: String(stderr) });
    });
  });
}

/**
 * La syntaxe d'un fichier que l'agent vient d'écrire, contrôlée sans rien
 * exécuter de son code : la compilation JavaScript dans la passerelle
 * (syntaxeNode.ts, ce que faisait `node --check`), l'analyse de
 * Python par `ast.parse` (ni import ni `.pyc` écrit, contrairement à
 * `py_compile`), `JSON.parse`, l'équilibre des accolades CSS et la
 * compilation des scripts écrits dans une page (controleWeb.ts). Rend le
 * problème en une phrase, ou null (juste, ou pas contrôlable ici : langage non
 * couvert, Python absent). Un contrôle qui ne peut pas se faire n'affirme rien.
 */
export async function verifierEcriture(absolu: string, racine: string): Promise<string | null> {
  const ext = extname(absolu).toLowerCase();
  const rel = relative(racine, absolu) || basename(absolu);
  let texte: string;
  try {
    if (statSync(absolu).size > 1_000_000) return null;
    texte = readFileSync(absolu, "utf8");
  } catch {
    return null;
  }
  if (ext === ".json") {
    if (JSON_TOLERANT.test(basename(absolu))) return null;
    try {
      JSON.parse(texte);
      return null;
    } catch (err) {
      return `${rel} : JSON invalide (${(err instanceof Error ? err.message : String(err)).slice(0, 160)})`;
    }
  }
  if (ext === ".css") {
    const e = accoladesCss(texte);
    return e ? `${rel} : ${e}` : null;
  }
  if (ext === ".html" || ext === ".htm") {
    for (const m of texte.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const e = syntaxeJs(m[1]!, `${rel} (script de la page)`);
      if (e) return `${rel} : ${e}`;
    }
    return null;
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    /*
     * Compilé dans la passerelle, sans lancer de programme ni rien exécuter
     * (syntaxeNode.ts) : `node --check` lançait le binaire de OxoAI en mode
     * Node, ce qui demandait le fusible RunAsNode ouvert (fermé le
     * 28/09/2026). Les modules (import, export) sont lus comme avant.
     */
    const erreur = await controlerSyntaxeJs(texte, absolu);
    if (!erreur) return null;
    const ligne = erreur.match(/:(\d+)\r?\n/)?.[1];
    const message = erreur.match(/^\w*Error: .*$/m)?.[0] ?? erreur.trim().split("\n").pop() ?? "";
    return `${rel} : erreur de syntaxe JavaScript${ligne ? ` ligne ${ligne}` : ""} (${message.slice(0, 200)})`;
  }
  if (ext === ".py") {
    const python = process.platform === "win32" ? (pythonPrive() ?? "python") : "python3";
    const r = await lancer(python, ["-I", "-B", "-c", ANALYSE_PY, absolu]);
    if (!r || r.code !== 0) return null;
    const sortie = r.sortie.trim();
    if (sortie === "ok" || !sortie.includes("\t")) return null;
    const [ligne, message] = sortie.split("\t");
    return `${rel} : erreur de syntaxe Python ligne ${ligne} (${(message ?? "").slice(0, 200)})`;
  }
  return null;
}

/** Ce que reçoit le modèle, à la suite du retour de l'outil, quand le fichier écrit a une erreur. */
export function noteErreurEcriture(probleme: string, outilEcriture: string): string {
  return (
    `\n\n[Contrôle de l'instance] Le fichier est écrit, mais il ne fonctionnera pas : ${probleme}. ` +
    `Relis cette ligne, puis réécris le fichier corrigé en entier avec « ${outilEcriture} ».`
  );
}

/** Relance avant la réponse finale, tant qu'un fichier écrit reste faux (bornée par chat.ts). */
export function relanceSyntaxe(enErreur: Map<string, string>, outilEcriture: string): string {
  return (
    "[Contrôle de l'instance] Avant de répondre, corrige ce qui ne fonctionne pas encore :\n" +
    [...enErreur.values()].map((p) => `- ${p}`).join("\n") +
    `\nRéécris chaque fichier corrigé en entier avec « ${outilEcriture} », puis réponds.`
  );
}

/* ------------------------------------------------------------------ */
/* OxoAI Code : l'agent d'OpenCode pour un petit modèle                */
/* ------------------------------------------------------------------ */

/** Nom de l'agent d'OpenCode réservé aux petits modèles (opencode.ts, `writeConfig` et `refModele`). */
export const AGENT_PETIT = "oxoai-petit";

/**
 * Consignes de l'agent de code pour un petit modèle, à la place de
 * `CONSIGNES_CODE` (allegementCode.ts). En anglais comme tout ce qu'OpenCode
 * envoie au modèle ; plus courtes, directives, numérotées, avec deux exemples
 * d'appels réussis dans les noms et paramètres réels d'OpenCode 1.18.32
 * (`read`, `write`, `edit`, `bash` ; `filePath`, `content`, `command`,
 * `description`, relevés dans son code). Les règles de sécurité de la revue du
 * 25/09/2026 (secrets, git destructeur, refus) restent.
 */
export const CONSIGNES_CODE_PETIT = [
  "You are the coding agent of this project folder. Work with the tools, one small step at a time.",
  "",
  "Rules:",
  "1. Act, do not describe. To create or change a file, call write or edit. Never paste code in your answer instead of writing the file.",
  "2. Read a file with read before changing it. For a file under 300 lines, write it again in full with write.",
  "3. Use only files, functions and names that exist: check with glob, grep or read first.",
  "4. After writing code, check it with bash (for example `node --check app.js`, `python -m py_compile app.py`, or the project's tests) and fix what fails.",
  "5. If a tool returns an error, read the error, fix the call, and try again.",
  // « <project> » (23/10/2026) : un chemin d'un autre système (/app/metier.js) sortait du dossier du projet et était refusé.
  "6. Stay in the project folder: every path starts with the project folder (the working directory), shown as <project> below; never /app, /home or C:\\ alone. Never commit, push or delete data unless asked. Never print or read secrets, keys or passwords. Never run destructive git commands (push --force, reset --hard, clean -f).",
  "7. Actions wait for the user's approval. A refusal is a decision: do not retry it another way.",
  "8. Answer in the user's language, in one or two short sentences: what you did, and what you could not check.",
  "",
  'Example. The user asks: "add a function double(n) to utils.js".',
  '- read {"filePath": "<project>/utils.js"}',
  '- write {"filePath": "<project>/utils.js", "content": "<the whole file, with the new function>"}',
  '- bash {"command": "node --check utils.js", "description": "Check syntax"}',
  'Answer: "Added double(n) to utils.js; the syntax is checked."',
  "",
  'Example. The user asks: "create hello.py that prints Bonjour".',
  '- write {"filePath": "<project>/hello.py", "content": "print(\\"Bonjour\\")\\n"}',
  '- bash {"command": "python hello.py", "description": "Run it"}',
  'Answer: "Created hello.py; it prints Bonjour."',
].join("\n");

/**
 * L'agent `oxoai-petit` d'OpenCode, tel qu'écrit dans sa configuration.
 * Vérifié dans le code d'OpenCode 1.18.32 (packages/opencode/src) :
 *  - un agent déclaré dans `agent` hérite des permissions globales de la
 *    configuration (`Permission.merge(defaults, user)`, agent/agent.ts), puis
 *    des siennes : les « ask » de OxoAI restent ;
 *  - une permission `deny` sur tout (`"*"`) retire l'outil de la liste envoyée
 *    au modèle (`Permission.disabled`, session/llm/request.ts) ;
 *  - `steps` borne les tours d'outils : au dernier, OpenCode demande au modèle
 *    de conclure sans outil (`MAX_STEPS_PROMPT`, session/prompt.ts) ;
 *  - `prompt` remplace les consignes du fournisseur, comme pour `build` ;
 *  - l'agent est choisi par le champ `agent` de `prompt_async` (`PromptInput`).
 * Retirés : `task` (un sous-agent repart d'un contexte vide et relit tout ; le
 * séquençage de OxoAI tient déjà le fil, sequenceCode.ts), `todowrite` et
 * `todoread` (même raison), `webfetch`, `websearch`, `codesearch` et `lsp`.
 * Restent : read, glob, grep, list, edit, write, bash et les connecteurs.
 */
export function agentPetitOpenCode(): Record<string, unknown> {
  return {
    description: "Coding agent for small local models: short instructions, essential tools only.",
    mode: "primary",
    prompt: CONSIGNES_CODE_PETIT,
    steps: 30,
    permission: {
      task: "deny",
      todowrite: "deny",
      todoread: "deny",
      webfetch: "deny",
      websearch: "deny",
      codesearch: "deny",
      lsp: "deny",
    },
  };
}

/**
 * Les modèles décrits à OpenCode comme petits, au moment où sa configuration
 * a été écrite (`writeConfig`) : l'agent `oxoai-petit` n'est demandé que pour
 * eux, et il existe forcément dans la configuration que lit l'OpenCode en
 * marche (elle n'est écrite qu'à son démarrage, et un modèle inconnu le fait
 * redémarrer, `modelesEcrits`). Un agent absent ferait échouer la demande
 * (« Agent not found »).
 */
let petitsEcrits = new Set<string>();

export function noterPetitsModeles(ids: string[]): void {
  petitsEcrits = new Set(ids);
}

/** Le champ `agent` d'une demande à OpenCode pour ce modèle : `oxoai-petit`, ou rien (l'agent par défaut). */
export function agentPourModele(id: string): { agent?: string } {
  return petitsEcrits.has(id) ? { agent: AGENT_PETIT } : {};
}
