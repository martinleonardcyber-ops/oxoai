import en from "@/i18n/en.json";
import zh from "@/i18n/zh.json";
import ja from "@/i18n/ja.json";
import es from "@/i18n/es.json";
import de from "@/i18n/de.json";
import ar from "@/i18n/ar.json";

/**
 * La langue de l'interface.
 *
 * ── Le choix de méthode, et pourquoi celui-là ───────────────────────────────
 *
 * La clé de traduction **est la phrase française**. Pas un identifiant
 * (`chat.nouveau.bouton`), la phrase elle-même. C'est inhabituel, et c'est
 * délibéré :
 *
 *  - le code reste lisible. `t("Nouveau Chat")` se comprend sans aller
 *    chercher ce que contient `nav.newChat` ;
 *  - une phrase sans traduction s'affiche **en français**, pas en
 *    `nav.newChat`. Une traduction manquante dégrade, elle ne casse pas ;
 *  - le français n'a pas de catalogue à tenir : il est dans le code, et ne
 *    peut donc jamais être en retard sur lui.
 *
 * Le prix : changer un mot français change la clé, et la traduction retombe
 * en français jusqu'à ce qu'on la reporte. Le relevé (`npm run i18n`) dit
 * lesquelles manquent, et c'est ce qui rend ce prix payable.
 *
 * ── Pourquoi la page se recharge au changement de langue ────────────────────
 *
 * `t()` est une fonction ordinaire, pas un crochet React : elle est appelée
 * dans des tableaux constants, au chargement des modules, hors de tout
 * composant. Rien ne redessine l'écran quand la langue change. Plutôt que de
 * faire semblant, on recharge : c'est immédiat, total, et sans écran à moitié
 * traduit. Un changement de langue est rare ; un rendu faux ne doit jamais
 * arriver.
 *
 * ── Ce qui n'est pas traduit, et qui doit se savoir ─────────────────────────
 *
 * Les messages venus de l'instance (erreurs de la passerelle, résultats
 * d'outils) sont écrits en français dans `gateway/`. Ceux qui figurent aussi
 * dans le catalogue sont traduits au passage, les autres restent en français.
 * Le contenu écrit par les utilisateurs — chats, documents, procédures — n'est
 * évidemment jamais touché.
 */

/*
 * L'ordre de l'écran est celui du site helix-agence.fr (24/10/2026, demandé
 * par Medhi) : français, anglais, espagnol, allemand, arabe, chinois,
 * japonais. Il ne décide pas de la langue par défaut : c'est `PAR_DEFAUT`,
 * l'anglais, quand la langue du système n'est pas reconnue (décision de la
 * 0.26.0, rappelée le 25/09/2026). Les phrases françaises restent les clés du
 * catalogue : c'est une affaire de code, pas ce que l'écran présente.
 */
export const LANGUES = [
  { code: "fr", nom: "Français", natif: "Français" },
  { code: "en", nom: "Anglais", natif: "English" },
  // Demandés par Medhi le 30/09/2026 : l'espagnol, l'allemand et l'arabe.
  { code: "es", nom: "Espagnol", natif: "Español" },
  { code: "de", nom: "Allemand", natif: "Deutsch" },
  { code: "ar", nom: "Arabe", natif: "العربية" },
  { code: "zh", nom: "Chinois", natif: "中文" },
  // Demandé par Medhi le 28/09/2026.
  { code: "ja", nom: "Japonais", natif: "日本語" },
] as const;

export type Langue = (typeof LANGUES)[number]["code"];

const CLE = "oxoai:langue";

/** Catalogues embarqués : `t()` doit répondre dès le premier rendu. */
const CATALOGUES: Record<Exclude<Langue, "fr">, Record<string, string>> = {
  en: en as Record<string, string>,
  zh: zh as Record<string, string>,
  ja: ja as Record<string, string>,
  es: es as Record<string, string>,
  de: de as Record<string, string>,
  ar: ar as Record<string, string>,
};

function langueEnregistree(): Langue | null {
  try {
    const brut = localStorage.getItem(CLE);
    return LANGUES.find((l) => l.code === brut)?.code ?? null;
  } catch {
    return null;
  }
}

/**
 * Langue par défaut, quand le système n'en dit rien d'exploitable.
 *
 * L'anglais, et non le français, bien que le produit soit écrit en français :
 * c'est la langue que le plus grand nombre de gens peut lire, et un logiciel
 * qui s'ouvre dans une langue qu'on ne lit pas ne s'explore pas. Le français
 * reste la langue **source** — les clés du catalogue sont des phrases
 * françaises — ce qui est une autre question que la langue affichée.
 */
const PAR_DEFAUT: Langue = "en";

/**
 * Langue du système, quand rien n'a été choisi.
 *
 * On ne devine que ce qu'on sait servir. Un poste en italien s'ouvre en
 * anglais plutôt que de tomber dans une langue au hasard, et la personne
 * choisit elle-même. La première langue du système qu'on sait servir gagne
 * (30/09/2026 : sept langues, la liste est `LANGUES` et plus une suite de
 * `if`).
 */
function langueDuSysteme(): Langue {
  try {
    for (const etiquette of navigator.languages ?? [navigator.language]) {
      const base = etiquette.toLowerCase().split("-")[0];
      const connue = LANGUES.find((l) => l.code === base);
      if (connue) return connue.code;
    }
  } catch {
    /* pas de navigateur : la langue par défaut */
  }
  return PAR_DEFAUT;
}

const courante: Langue = langueEnregistree() ?? langueDuSysteme();

/** La langue en cours d'affichage. */
export const langue = (): Langue => courante;

/**
 * Le sens d'écriture d'une langue. L'arabe s'écrit de droite à gauche
 * (30/09/2026) : la page entière se retourne (`dir="rtl"` sur `<html>`), et
 * la mise en page suit parce qu'elle est écrite en propriétés logiques
 * (`ms-`, `pe-`, `start-`, `text-start` : « début » et « fin » de ligne, et non
 * « gauche » et « droite »). Les six autres langues restent de gauche à droite.
 */
const LANGUES_RTL: readonly Langue[] = ["ar"];
export const sensDe = (code: Langue): "rtl" | "ltr" => (LANGUES_RTL.includes(code) ? "rtl" : "ltr");

/** Le sens d'écriture de la langue affichée. */
export const sens = (): "rtl" | "ltr" => sensDe(courante);

/**
 * Garde un morceau technique dans son sens, de gauche à droite, au milieu d'une
 * phrase arabe : « 1,2 Mo », « 2:05 PM », « 12/09/2026 14:05 ». Sans cela,
 * l'algorithme bidirectionnel range les morceaux séparés par une espace de
 * droite à gauche, et l'écran affiche « PM 2:05 » ou l'heure avant la date.
 * Deux caractères d'isolement (U+2066 et U+2069), qui ne s'impriment pas ; rien
 * n'est ajouté dans les six langues qui s'écrivent de gauche à droite.
 */
export function isolerLtr(texte: string): string {
  return sens() === "rtl" && texte ? `\u2066${texte}\u2069` : texte;
}

/**
 * Des mentions courtes mises bout \u00e0 bout : \u00ab Apache 2.0 \u00b7 7 Go \u00b7 Note ECI 139 \u00bb.
 * Les mentions vides sont \u00e9cart\u00e9es. En arabe, chacune est isol\u00e9e (U+2068 et
 * U+2069) et garde son propre sens : sans cela, le \u00ab 7 \u00bb de \u00ab 7 Go \u00bb partait
 * avec \u00ab Apache 2.0 \u00bb \u00e0 l'autre bout de la ligne, loin de son unit\u00e9 (vu \u00e0
 * l'\u00e9cran le 30/09/2026, fiches des mod\u00e8les). Rien n'est ajout\u00e9 dans les six
 * langues qui s'\u00e9crivent de gauche \u00e0 droite.
 */
export function enumerer(morceaux: readonly (string | false | null | undefined)[], separateur = " \u00b7 "): string {
  const dits = morceaux.filter((m): m is string => Boolean(m));
  return sens() === "rtl" ? dits.map((m) => `\u2068${m}\u2069`).join(separateur) : dits.join(separateur);
}

/**
 * Une liste de noms dans une phrase : « Slack, Teams » en français, « Slack، Teams »
 * en arabe, « Slack、Teams » en chinois et en japonais (30/09/2026 : la virgule
 * latine restait dans ces trois langues). Chaque nom est isolé en arabe, comme
 * dans `enumerer`. Pas pour une valeur technique (portées OAuth, identifiants).
 */
const VIRGULE: Partial<Record<Langue, string>> = { ar: "\u060c ", zh: "\u3001", ja: "\u3001" };
export function lister(noms: readonly (string | false | null | undefined)[]): string {
  return enumerer(noms, VIRGULE[courante] ?? ", ");
}

/** Une langue a-t-elle été choisie, ou suit-on encore le système ? */
export const langueChoisie = (): boolean => langueEnregistree() !== null;

const table: Record<string, string> = courante === "fr" ? {} : CATALOGUES[courante];

/**
 * Traduit une phrase française. Sans traduction, rend la phrase telle quelle.
 *
 * Appelée partout, y compris au chargement des modules : elle est donc
 * volontairement triviale, sans effet de bord et sans dépendance à React.
 */
export function t(fr: string): string {
  if (courante === "fr") return fr;
  return table[fr] ?? fr;
}

/**
 * Étiquette de locale, pour ce qui se formate plutôt que se traduit :
 * nombres, dates, tailles de fichiers.
 */
export function locale(): string {
  /*
   * L'arabe garde les chiffres occidentaux (`nu-latn`) : le reste de l'écran
   * (dates assemblées par `formats.ts`, versions, tailles, prix) les écrit
   * ainsi, et un écran qui mêle « ١٢ » et « 12 » se lit mal. Sans région :
   * calendrier grégorien, mois de l'arabe standard (30/09/2026).
   */
  return { fr: "fr-FR", en: "en-US", zh: "zh-CN", ja: "ja-JP", es: "es-ES", de: "de-DE", ar: "ar-u-nu-latn" }[courante];
}

/**
 * Une taille de fichier dans la langue de lecture : « 1,2 Mo », « 1.2 MB ».
 *
 * Les unités étaient écrites en dur, en français, à plusieurs endroits du
 * code : l'écran passait en anglais en continuant d'annoncer « 1 Go ». Les
 * unités françaises (o, Ko, Mo, Go) n'ont pas cours ailleurs, l'anglais, le
 * chinois, le japonais, l'espagnol, l'allemand et l'arabe disant B, KB, MB, GB. La virgule décimale suit elle aussi la
 * langue.
 */
export function taille(octets: number): string {
  const unites = courante === "fr" ? ["o", "Ko", "Mo", "Go"] : ["B", "KB", "MB", "GB"];
  const nombre = (valeur: number, decimales: number) =>
    valeur.toLocaleString(locale(), { maximumFractionDigits: decimales });
  // En arabe, le nombre et son unité latine restent dans cet ordre (voir `isolerLtr`).
  if (octets < 1024) return isolerLtr(`${octets} ${unites[0]}`);
  if (octets < 1024 ** 2) return isolerLtr(`${Math.max(1, Math.round(octets / 1024))} ${unites[1]}`);
  if (octets < 1024 ** 3) return isolerLtr(`${nombre(octets / 1024 ** 2, 1)} ${unites[2]}`);
  return isolerLtr(`${nombre(octets / 1024 ** 3, 2)} ${unites[3]}`);
}

/**
 * Change la langue et recharge.
 *
 * Le rechargement fait partie du contrat (voir en tête de fichier) : sans lui,
 * la moitié de l'écran resterait dans l'ancienne langue jusqu'au prochain
 * rendu de chaque composant.
 */
export function changerLangue(nouvelle: Langue): void {
  try {
    localStorage.setItem(CLE, nouvelle);
  } catch {
    /* stockage indisponible : le choix vaudra pour cette session */
  }
  try {
    document.documentElement.lang = nouvelle;
    document.documentElement.dir = sensDe(nouvelle);
  } catch {
    /* pas de document */
  }
  window.location.reload();
}

/**
 * Traduit une phrase **à trous**, du genre « Écrire à {0} ».
 *
 * Une phrase qui contient une valeur ne peut pas être une clé telle quelle :
 * « Écrire à Marie » et « Écrire à Paul » seraient deux entrées de catalogue,
 * et aucune des deux ne se retrouverait. On numérote donc les trous, et la
 * traduction peut les remettre dans un autre ordre — ce qui est exactement le
 * besoin : le chinois et l'anglais ne placent pas les compléments comme le
 * français.
 */
export function tf(modele: string, ...valeurs: unknown[]): string {
  return t(modele).replace(/\{(\d+)\}/g, (_, i: string) => {
    const v = valeurs[Number(i)];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Combien de phrases ce catalogue couvre-t-il ? Affiché dans les réglages. */
export function couverture(code: Langue): { traduites: number; total: number } {
  if (code === "fr") return { traduites: 0, total: 0 };
  const cat = CATALOGUES[code];
  const traduites = Object.values(cat).filter((v) => typeof v === "string" && v.length > 0).length;
  return { traduites, total: Object.keys(cat).length };
}

/*
 * L'attribut `lang` du document suit la langue affichée : il décide de la
 * coupure des mots, de la police par défaut des idéogrammes, et de ce
 * qu'annonce un lecteur d'écran.
 */
try {
  document.documentElement.lang = courante;
  /*
   * Le sens d'écriture, posé ici et non dans un composant : ce module est
   * chargé avant le premier rendu de React, l'écran ne s'affiche donc jamais
   * une fois dans le mauvais sens. Toujours écrit, `ltr` compris : les
   * variantes `rtl:` de Tailwind et les règles `[dir="rtl"]` de index.css
   * s'appuient sur cet attribut (30/09/2026).
   */
  document.documentElement.dir = sensDe(courante);
} catch {
  /* rendu hors navigateur */
}

// L'application de bureau suit la même langue pour ses propres textes (zone de notification, menu de Windows et Linux).
try {
  (window as unknown as { oxoai?: { langue?: (code: string) => void } }).oxoai?.langue?.(courante);
} catch {
  /* navigateur, ou application d'une version antérieure */
}
