import { blocCarte } from "./carteProjet.ts";
import { completer } from "./completion.ts";
import { t, tf } from "./langue.ts";

/**
 * Le séquençage de OxoAI Code : une demande composée est faite étape par
 * étape, et c'est OxoAI qui tient le fil, pas le modèle.
 *
 * Demandé par Medhi le 26/09/2026 : « il faut que la couche logicielle soutienne
 * OxoAI Code et qu'il soit bon partout », même avec un petit modèle et un petit
 * contexte. Ce que les essais du jour ont montré avec Qwen3 8B : laissé seul
 * sur une demande composée, il écrit tout d'un coup, perd le fil, oublie ce
 * qu'il a nommé trois fichiers plus tôt, et annonce fini ce qui ne l'est pas.
 * Ce qu'il fait bien : un morceau court et précis, un fichier écrit en entier.
 *
 * Donc :
 *  1. le modèle de code fait d'abord un plan court (JSON tenu par un schéma),
 *     avec la carte du projet sous les yeux (carteProjet.ts) ;
 *  2. OxoAI lui envoie une seule étape à la fois, avec la carte à jour ;
 *  3. à la fin de chaque étape, le contrôle automatique (controleCode.ts)
 *     vérifie, fait corriger s'il le faut, et seulement alors l'étape suivante
 *     part.
 * Le régime dépend du modèle (`strategie`, plan.ts) : un grand modèle n'est pas
 * découpé, il perdrait plus qu'il ne gagnerait.
 */

export interface EtapeCode {
  titre: string;
  fichiers: string[];
  consigne: string;
}
interface Sequence {
  demande: string;
  etapes: EtapeCode[];
  /** L'étape en cours (indice). */
  courante: number;
  dossier: string;
}
const sequences = new Map<string, Sequence>();
const ETAPES_MAX = 8;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["une_seule_etape", "etapes"],
  properties: {
    une_seule_etape: { type: "boolean" },
    etapes: {
      type: "array",
      maxItems: ETAPES_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["titre", "fichiers", "consigne"],
        properties: {
          titre: { type: "string" },
          fichiers: { type: "array", items: { type: "string" }, maxItems: 4 },
          consigne: { type: "string" },
        },
      },
    },
  },
};

const CONSIGNE = `Tu prépares le plan de travail d'un agent de code, qui fera les étapes une par une. Réponds en JSON, dans la langue de la demande.
- Une question, une explication, ou une petite modification d'un seul fichier : une_seule_etape = true, etapes = [].
- Sinon : une_seule_etape = false, et 2 à 8 étapes dans l'ordre où les faire. D'abord ce dont les autres dépendent (données, fonctions communes, configuration), puis ce qui s'en sert, puis ce qui relie le tout.
- Une étape = UN fichier écrit en entier avec tout son contenu (ou une modification précise d'un fichier existant). Chaque fichier ne figure que dans une seule étape. Pas d'étape « créer un fichier vide », pas d'étape « tester » ni « vérifier » : OxoAI vérifie après chaque étape.
- titre : court (« Écrire app.py : lecture du fichier CSV »). fichiers : chemins relatifs au dossier.
- consigne : ce que l'étape doit contenir, précisément, en 1 à 5 phrases : les noms EXACTS des fonctions, classes, routes ou éléments qu'elle crée, avec leurs paramètres, et ce qu'ils font. Une étape suivante qui s'en sert doit reprendre ces mêmes noms.
- Garde les fichiers et les noms qui existent déjà (voir la carte du projet) ; n'en invente pas.`;

/** Lit le plan rendu par le modèle ; `null` s'il n'y a pas à découper (ou pas de plan utilisable). */
function lireEtapes(texte: string): EtapeCode[] | null {
  let brut: { une_seule_etape?: unknown; etapes?: unknown };
  try {
    brut = JSON.parse(texte.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    return null;
  }
  if (brut.une_seule_etape === true || !Array.isArray(brut.etapes)) return null;
  const court = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  let etapes: EtapeCode[] = (brut.etapes as Record<string, unknown>[])
    .map((e) => ({
      titre: court(e?.titre, 140),
      fichiers: Array.isArray(e?.fichiers)
        ? [...new Set((e.fichiers as unknown[]).map((f) => court(f, 200).replace(/^\.?\//, "")).filter((f) => f && !f.includes("..") && !f.startsWith("/")))].slice(0, 4)
        : [],
      consigne: court(e?.consigne, 900),
    }))
    .filter((e) => e.titre && !/^(tester|vérifier|verifier|test|relire)\b/i.test(e.titre));
  /*
   * Un fichier qui revient dans plusieurs étapes (créé, puis complété) : fondu
   * en une seule étape qui l'écrit en entier (regrouperParFichier, plan.ts,
   * mesuré sur le Chat : un petit modèle modifie mal par morceaux).
   */
  const parFichier = new Map<string, number>();
  const fondues: EtapeCode[] = [];
  for (const e of etapes) {
    const seul = e.fichiers.length === 1 ? e.fichiers[0]! : undefined;
    const deja = seul !== undefined ? parFichier.get(seul) : undefined;
    if (deja !== undefined) {
      const f = fondues[deja]!;
      f.consigne = `${f.consigne} ${e.consigne}`.slice(0, 1400);
      continue;
    }
    if (seul !== undefined) parFichier.set(seul, fondues.length);
    fondues.push({ ...e });
  }
  /*
   * Les titres restent ceux du modèle. La règle du Chat (regrouperParFichier,
   * plan.ts) les réécrivait en « Écrire X en entier, d'un seul coup avec
   * write_file… » : trois lignes par titre, et le nom d'un outil du Chat, pas
   * de Code (vu au premier essai, le 26/09/2026). La fusion par fichier
   * ci-dessus suffit.
   */
  etapes = fondues.slice(0, ETAPES_MAX);
  return etapes.length >= 2 ? etapes : null;
}

/** Le plan d'une demande, par le modèle de code. `null` : la demande se fait d'un seul tenant. */
export async function planifierCode(
  demande: string,
  dossier: string,
  qui: string,
  modele: string,
  statut: (message: string) => void,
): Promise<EtapeCode[] | null> {
  statut(t("OxoAI prépare le plan de travail..."));
  const carte = blocCarte(dossier, 4000);
  const r = await completer(
    [
      { role: "system", content: CONSIGNE },
      { role: "user", content: `Demande : ${demande.slice(0, 4000)}${carte || "\n\nLe dossier est vide."}` },
    ],
    { qui, modele, maxTokens: 2500, delaiMs: 5 * 60_000, schema: { nom: "plan_code", schema: SCHEMA } },
  ).catch(() => null);
  if (!r || !r.ok) return null;
  return lireEtapes(r.texte);
}

export function demarrerSequence(sessionID: string, demande: string, dossier: string, etapes: EtapeCode[]): void {
  sequences.set(sessionID, { demande, etapes, courante: 0, dossier });
}
export function oublierSequence(sessionID: string): void {
  sequences.delete(sessionID);
}
export function sequenceEnCours(sessionID: string): { courante: number; total: number } | null {
  const s = sequences.get(sessionID);
  return s ? { courante: s.courante, total: s.etapes.length } : null;
}

const decrire = (e: EtapeCode) =>
  [
    e.fichiers.length ? tf("Fichier(s) : {0}.", e.fichiers.join(", ")) : "",
    e.consigne ? tf("Contenu attendu : {0}", e.consigne) : "",
  ]
    .filter(Boolean)
    .join("\n");

/** Le marqueur du plan joint à la première demande : sessionsCode.ts le retire de l'historique. */
export const MARQUEUR_PLAN = "\n\n---\nPlan de OxoAI";

/** Ce qui s'ajoute à la demande de la personne pour la première étape. */
export function consignePremiereEtape(sessionID: string): string {
  const s = sequences.get(sessionID);
  if (!s) return "";
  const e = s.etapes[0]!;
  return [
    `${MARQUEUR_PLAN} (${s.etapes.length} étapes, faites une par une ; OxoAI vérifie après chacune) :`,
    ...s.etapes.map((x, i) => `${i + 1}. ${x.titre}`),
    "",
    tf("Fais SEULEMENT l'étape 1 maintenant : {0}", e.titre),
    decrire(e),
    t("Les étapes suivantes viendront ensuite, une à une : ne les commence pas. Termine par une phrase qui dit ce que tu as écrit."),
  ].join("\n");
}

/**
 * Passe à l'étape suivante et rend le texte à envoyer, avec la carte à jour ;
 * `null` quand le plan est fini (la séquence est alors oubliée).
 */
export function etapeSuivante(sessionID: string): { texte: string; numero: number; total: number; titre: string; demande: string } | null {
  const s = sequences.get(sessionID);
  if (!s) return null;
  s.courante++;
  if (s.courante >= s.etapes.length) {
    sequences.delete(sessionID);
    return null;
  }
  const e = s.etapes[s.courante]!;
  const numero = s.courante + 1;
  const texte = [
    // Le début reconnaît une relance de OxoAI dans l'historique (sessionsCode.ts) : il commence par « [OxoAI ».
    `${tf("[OxoAI : étape {0} sur {1}]", numero, s.etapes.length)} ${e.titre}`,
    tf("Demande de départ : {0}", s.demande.slice(0, 1500)),
    tf("Déjà fait : {0}.", s.etapes.slice(0, s.courante).map((x, i) => `${i + 1}. ${x.titre}`).join(" ; ")),
    "",
    tf("Fais maintenant SEULEMENT cette étape : {0}", e.titre),
    decrire(e),
    t("Reprends les noms exacts des fonctions et des fichiers des étapes précédentes (voir la carte). Termine par une phrase qui dit ce que tu as écrit."),
    blocCarte(s.dossier, 5000),
  ].join("\n");
  return { texte, numero, total: s.etapes.length, titre: e.titre, demande: s.demande };
}
