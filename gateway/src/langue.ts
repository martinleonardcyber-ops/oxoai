import { AsyncLocalStorage } from "node:async_hooks";
import en from "../i18n/en.json" with { type: "json" };
import zh from "../i18n/zh.json" with { type: "json" };
import ja from "../i18n/ja.json" with { type: "json" };
import es from "../i18n/es.json" with { type: "json" };
import de from "../i18n/de.json" with { type: "json" };
import ar from "../i18n/ar.json" with { type: "json" };

/**
 * Traduction des messages écrits par la passerelle.
 *
 * ── Le problème ─────────────────────────────────────────────────────────────
 *
 * L'interface se traduit entièrement (`src/lib/i18n.ts`), mais une part de ce
 * qui s'affiche ne vient pas d'elle : « L'adresse CalDAV n'est pas une URL
 * valide », « Agenda connecté en lecture seule : 3 calendrier(s) », les étapes
 * d'une installation. Ces phrases-là sont écrites ici, et arrivaient en
 * français au milieu d'un écran anglais ou chinois.
 *
 * ── Le choix : la langue voyage avec la requête ─────────────────────────────
 *
 * La passerelle sert plusieurs postes à la fois, qui peuvent lire dans sept
 * langues différentes. Une langue « de l'instance » serait donc fausse pour
 * quelqu'un. Chaque requête porte la sienne (`X-OxoAI-Langue`, posé par
 * `authHeaders()` côté écran), et `AsyncLocalStorage` la rend lisible depuis
 * n'importe quelle profondeur d'appel sans la passer en paramètre à trois cents
 * endroits. C'est du Node standard : la passerelle reste sans dépendance.
 *
 * Hors requête — démarrage, tâches planifiées, journal — il n'y a personne à
 * qui parler : la phrase reste en français, sa langue source.
 *
 * ── La clé est la phrase française ──────────────────────────────────────────
 *
 * Comme côté écran. Un message sans traduction s'affiche donc en français : le
 * pire cas est une phrase non traduite, jamais une phrase absente.
 */

// Le japonais depuis le 28/09/2026, l'espagnol, l'allemand et l'arabe depuis le 30/09/2026, demandés par Medhi.
export const LANGUES = ["fr", "en", "zh", "ja", "es", "de", "ar"] as const;
export type Langue = (typeof LANGUES)[number];

/**
 * L'étiquette de locale d'une langue, pour les nombres que la passerelle écrit
 * dans ses phrases. L'arabe garde les chiffres occidentaux (`nu-latn`), comme
 * l'écran (`src/lib/i18n.ts`).
 */
const LOCALES: Record<Langue, string> = { fr: "fr-FR", en: "en-US", zh: "zh-CN", ja: "ja-JP", es: "es-ES", de: "de-DE", ar: "ar-u-nu-latn" };
export const locale = (): string => LOCALES[langue()];

const CATALOGUES: Record<Exclude<Langue, "fr">, Record<string, string>> = {
  en: en as Record<string, string>,
  zh: zh as Record<string, string>,
  ja: ja as Record<string, string>,
  es: es as Record<string, string>,
  de: de as Record<string, string>,
  ar: ar as Record<string, string>,
};

const contexte = new AsyncLocalStorage<Langue>();

function normaliser(brut: string | undefined): Langue {
  const base = (brut ?? "").trim().toLowerCase().split(/[-_,;]/)[0];
  // Langue inconnue ou absente : l'anglais, langue de base du produit (27/09/2026, décidé par Medhi).
  return (LANGUES as readonly string[]).includes(base) ? (base as Langue) : "en";
}

/**
 * Exécute le traitement d'une requête en retenant la langue de son auteur.
 * Posé une seule fois, à l'entrée du serveur : une route ajoutée plus tard en
 * hérite sans rien avoir à faire.
 */
export function avecLangueDe<T>(
  entetes: Record<string, string | string[] | undefined>,
  adresse: URL,
  travail: () => T,
): T {
  const entete = entetes["x-oxoai-langue"];
  const navigateur = entetes["accept-language"];
  const brut =
    (Array.isArray(entete) ? entete[0] : entete) ??
    // Les flux d'évènements du navigateur ne portent pas d'en-tête.
    adresse.searchParams.get("langue") ??
    /*
     * Revérification des connecteurs du 28/09/2026 : la page publique de retour
     * d'une autorisation (`/oxoai/oauth/retour`) est ouverte par le navigateur
     * que le service renvoie, sans en-tête de l'application. Elle s'affichait
     * donc toujours en anglais, même à qui venait de cliquer « Se connecter »
     * en français. La langue du navigateur, faute de mieux.
     */
    (Array.isArray(navigateur) ? navigateur[0] : navigateur) ??
    undefined;
  return contexte.run(normaliser(brut ?? undefined), travail);
}

/**
 * Exécute un travail dans une langue retenue plus tôt. Tournée des connecteurs
 * du 28/09/2026 : le retour d'une autorisation (Google, TikTok, Microsoft 365)
 * arrive sur un port de la boucle locale, hors de toute requête de
 * l'application ; le message rangé pour l'écran était donc en anglais, même
 * pour qui avait cliqué « Se connecter » en français. La langue de la demande
 * est retenue au départ, et le retour s'y exécute.
 */
export function dansLaLangue<T>(l: Langue, travail: () => T): T {
  return contexte.run(l, travail);
}

/** La langue de la requête en cours, anglais hors requête (langue de base du produit). */
export function langue(): Langue {
  return contexte.getStore() ?? "en";
}

/** Traduit une phrase française. Sans traduction, la rend telle quelle. */
export function t(fr: string): string {
  const courante = langue();
  if (courante === "fr") return fr;
  return CATALOGUES[courante][fr] ?? fr;
}

/**
 * Traduit une phrase à trous : `tf("{0} calendrier(s) accessible(s).", 3)`.
 *
 * Les valeurs sont insérées **après** la traduction, pour que chaque langue
 * place ses morceaux dans son propre ordre. Un trou sans valeur reste tel
 * quel : mieux vaut voir `{1}` que perdre le reste de la phrase.
 */
export function tf(modele: string, ...valeurs: unknown[]): string {
  return t(modele).replace(/\{(\d+)\}/g, (brut, index: string) => {
    const valeur = valeurs[Number(index)];
    return valeur === undefined ? brut : String(valeur);
  });
}

/**
 * Une liste de noms dans une phrase que la personne lit : « Slack, Teams » en
 * français, en anglais, en espagnol et en allemand, « Slack، Teams » en arabe,
 * « Slack、Teams » en chinois et en japonais. La même règle que `lister` côté
 * écran (`src/lib/i18n.ts`, 30/09/2026) : la virgule latine restait dans ces
 * trois langues au milieu d'une phrase traduite. Les noms vides sont écartés.
 *
 * En arabe, chaque nom est isolé (U+2068 et U+2069) et garde son propre sens :
 * sans cela, un nom latin suivi d'un chiffre part à l'autre bout de la ligne.
 * Rien n'est ajouté dans les six autres langues.
 *
 * La langue est celle de la requête en cours, lue comme le font `t` et `tf`.
 * Pas pour ce que lit un modèle (consignes, résultats d'outils), ni pour un
 * journal, ni pour une valeur technique (portées OAuth, identifiants).
 */
const VIRGULE: Partial<Record<Langue, string>> = { ar: "، ", zh: "、", ja: "、" };
export function lister(noms: readonly (string | false | null | undefined)[]): string {
  const courante = langue();
  const dits = noms.filter((n): n is string => Boolean(n));
  const virgule = VIRGULE[courante] ?? ", ";
  return courante === "ar" ? dits.map((n) => `⁨${n}⁩`).join(virgule) : dits.join(virgule);
}
