import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import modele from "../application/modele.json" with { type: "json" };
import { completer } from "./completion.ts";
import type { Design } from "./design.ts";
import { t, tf } from "./langue.ts";
import { echapperRegex } from "./texteBrut.ts";

/**
 * Les applications de gestion de Helix Code, faites en plusieurs étapes.
 *
 * Demandé par Medhi le 26/09/2026 : « le petit modèle […] doit faire un beau
 * logiciel même si ça prend du temps », avec pour exemple l'écran d'un ERP
 * classique (barre du haut, menu et filtres à gauche, liste, fiche détaillée à
 * droite). Mesuré le même jour : laissé seul sur « un petit ERP pour un cabinet
 * d'avocat », Qwen3 8B écrit 600 lignes d'un coup, et le contrôle automatique
 * y trouve dix problèmes qu'il ne corrige pas en trois relances (page blanche,
 * menus déroulants vides, listes figées).
 *
 * On ne lui demande donc plus d'écrire le logiciel entier. Le travail est
 * découpé, et chaque morceau est de ceux qu'un petit modèle fait bien :
 *  1. le plan : les parties de l'application et leurs champs, en JSON tenu
 *     par un schéma (réponse contrainte, une seule forme possible) ;
 *  2. les exemples : quelques fiches réalistes par partie, une partie à la fois ;
 *  3. l'interface : écrite par Helix, pas par le modèle, à partir du plan
 *     (gateway/application : un moteur éprouvé, aux couleurs du design
 *     choisi par design.ts) ;
 *  4. les règles du métier : l'agent de code complète un seul petit fichier
 *     (app/metier.js : calculs, contrôles, chiffres du tableau de bord),
 *     puis le contrôle automatique (controleCode.ts) essaie le tout.
 *
 * Si le plan échoue (modèle absent, réponse inutilisable), on n'invente rien :
 * la demande part comme avant, avec le design et les règles d'application.
 */

export type TypeChamp = "texte" | "long" | "nombre" | "montant" | "date" | "choix" | "lien" | "courriel" | "telephone" | "oui_non";
const TYPES: TypeChamp[] = ["texte", "long", "nombre", "montant", "date", "choix", "lien", "courriel", "telephone", "oui_non"];
const ICONES = [
  "dossier", "personne", "groupe", "facture", "argent", "calendrier", "horloge", "document", "tache", "boite",
  "camion", "graphique", "batiment", "balance", "outil", "message", "etoile",
] as const;

export interface Champ {
  cle: string;
  libelle: string;
  type: TypeChamp;
  options?: string[];
  lien?: string;
  obligatoire?: boolean;
}
export interface Partie {
  cle: string;
  nom: string;
  unite: string;
  icone: string;
  titre: string;
  statut?: string;
  champs: Champ[];
}
export interface PlanApplication {
  cle: string;
  nom: string;
  sousTitre: string;
  modules: Partie[];
  exemples: Record<string, Record<string, unknown>[]>;
}

/* ------------------------------------------------------------------ */
/* Étape 1 : le plan                                                   */
/* ------------------------------------------------------------------ */

const SCHEMA_PLAN = {
  type: "object",
  additionalProperties: false,
  required: ["nom", "sousTitre", "modules"],
  properties: {
    nom: { type: "string" },
    sousTitre: { type: "string" },
    modules: {
      type: "array",
      minItems: 3,
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cle", "nom", "unite", "icone", "champs"],
        properties: {
          cle: { type: "string" },
          nom: { type: "string" },
          unite: { type: "string" },
          icone: { type: "string", enum: [...ICONES] },
          champs: {
            type: "array",
            minItems: 5,
            maxItems: 11,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["cle", "libelle", "type", "options", "lien", "obligatoire"],
              properties: {
                cle: { type: "string" },
                libelle: { type: "string" },
                type: { type: "string", enum: TYPES },
                options: { type: "array", items: { type: "string" }, maxItems: 7 },
                lien: { type: "string" },
                obligatoire: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
};

const CONSIGNE_PLAN = `Tu conçois le plan d'une application de gestion, pas son code. Réponds en JSON, dans la langue de la demande.
- nom : le nom court de l'application (2 à 4 mots, sans le mot « application ») ; sousTitre : une phrase qui dit à qui elle sert.
- modules : 3 à 6 parties, celles dont ce métier a vraiment besoin au quotidien (par exemple pour un cabinet d'avocat : clients, dossiers, audiences, temps passé, factures). La première est la plus importante.
- Pour chaque partie : cle (minuscules, sans accent ni espace, au pluriel, ex. "dossiers"), nom (au pluriel, ex. "Dossiers"), unite (au singulier, ex. "Dossier"), icone (dans la liste permise), champs.
- champs : 5 à 10 par partie, ceux qu'un professionnel de ce métier remplit vraiment. Le premier est le nom ou l'intitulé de la fiche (type "texte", obligatoire). cle en minuscules sans accent (ex. "date_ouverture").
- Ce qui se compte est un nombre : une durée est un "nombre" en heures (ex. "duree_heures"), pas deux dates ; un prix, des honoraires, un taux horaire sont des "montant". Une facture a un montant et un statut (ex. Brouillon, Envoyée, Payée, En retard).
- Types : texte, long (texte sur plusieurs lignes), nombre, montant (en euros), date, choix (options : 2 à 6 valeurs, ex. un statut), lien (renvoie vers une autre partie : lien = la cle de cette partie), courriel, telephone, oui_non.
- Relie les parties entre elles par des champs "lien" (ex. un dossier a un lien vers "clients", une facture a un lien vers "dossiers"). Chaque partie sauf la première a au moins un lien.
- Une partie qui a un suivi a un champ "choix" nommé statut, avec ses étapes réelles.
- Pour les champs qui ne sont ni choix ni lien : options = [] et lien = "". obligatoire = true pour les champs indispensables seulement.`;

const sansAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const cleDe = (s: string, repli: string) =>
  sansAccents(String(s ?? "").toLowerCase())
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || repli;
const court = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Remet le plan d'un modèle dans une forme sûre : clés uniques, liens qui existent, un titre et un statut par partie. */
export function normaliserPlan(brut: unknown): Omit<PlanApplication, "exemples" | "cle"> | null {
  const b = brut as { nom?: unknown; sousTitre?: unknown; modules?: unknown };
  if (!b || !Array.isArray(b.modules)) return null;
  const vuesParties = new Set<string>();
  const parties: (Partie & { liensBruts: Map<string, string> })[] = [];
  for (const [i, m] of (b.modules as Record<string, unknown>[]).slice(0, 7).entries()) {
    if (!m || typeof m !== "object") continue;
    let cle = cleDe(String(m.cle ?? m.nom ?? ""), `partie_${i + 1}`);
    while (vuesParties.has(cle)) cle += "_2";
    vuesParties.add(cle);
    const nom = court(m.nom, 40) || cle;
    const vuesChamps = new Set<string>(["id"]);
    const champs: Champ[] = [];
    const liensBruts = new Map<string, string>();
    for (const [j, c] of (Array.isArray(m.champs) ? (m.champs as Record<string, unknown>[]) : []).slice(0, 12).entries()) {
      if (!c || typeof c !== "object") continue;
      let k = cleDe(String(c.cle ?? c.libelle ?? ""), `champ_${j + 1}`);
      while (vuesChamps.has(k)) k += "_2";
      vuesChamps.add(k);
      let type = (TYPES as string[]).includes(String(c.type)) ? (c.type as TypeChamp) : "texte";
      const options = Array.isArray(c.options) ? [...new Set((c.options as unknown[]).map((o) => court(o, 30)).filter(Boolean))].slice(0, 6) : [];
      if (type === "choix" && options.length < 2) type = "texte";
      const champ: Champ = { cle: k, libelle: court(c.libelle, 40) || k, type };
      if (type === "choix") champ.options = options;
      if (c.obligatoire === true) champ.obligatoire = true;
      if (type === "lien") liensBruts.set(k, cleDe(String(c.lien ?? ""), ""));
      champs.push(champ);
    }
    if (champs.length === 0) continue;
    parties.push({ cle, nom, unite: court(m.unite, 30) || nom, icone: (ICONES as readonly string[]).includes(String(m.icone)) ? String(m.icone) : "dossier", titre: "", champs, liensBruts });
  }
  if (parties.length < 2) return null;
  // Les liens : vers la clé d'une autre partie, ou vers son nom (un petit modèle écrit parfois « client » pour « clients »).
  const trouver = (voulu: string, soi: string) => {
    if (!voulu) return undefined;
    const exact = parties.find((p) => p.cle === voulu && p.cle !== soi);
    if (exact) return exact.cle;
    const proche = parties.find((p) => p.cle !== soi && (p.cle.replace(/s$/, "") === voulu.replace(/s$/, "") || cleDe(p.unite, "") === voulu || cleDe(p.nom, "") === voulu));
    return proche?.cle;
  };
  for (const p of parties) {
    p.champs = p.champs.filter((c) => {
      if (c.type !== "lien") return true;
      const cible = trouver(p.liensBruts.get(c.cle) ?? "", p.cle);
      if (!cible) return false;
      c.lien = cible;
      return true;
    });
    // Le titre de la fiche : le premier texte ; s'il n'y en a pas, on en ajoute un.
    let titre = p.champs.find((c) => c.type === "texte");
    if (!titre) {
      titre = { cle: p.champs.some((c) => c.cle === "intitule") ? "intitule_2" : "intitule", libelle: "Intitulé", type: "texte" };
      p.champs.unshift(titre);
    }
    titre.obligatoire = true;
    p.titre = titre.cle;
    const statut = p.champs.find((c) => c.type === "choix" && /statut|etat|etape|avancement/.test(c.cle)) ?? p.champs.find((c) => c.type === "choix");
    if (statut) p.statut = statut.cle;
  }
  return {
    nom: court(b.nom, 40) || parties[0]!.nom,
    sousTitre: court(b.sousTitre, 140),
    modules: parties.map(({ liensBruts: _l, ...p }) => p),
  };
}

/* ------------------------------------------------------------------ */
/* Étape 2 : les exemples                                              */
/* ------------------------------------------------------------------ */

function schemaExemples(p: Partie): Record<string, unknown> {
  const proprietes: Record<string, unknown> = {};
  for (const c of p.champs) {
    if (c.type === "lien") continue;
    proprietes[c.cle] =
      c.type === "nombre" || c.type === "montant" ? { type: "number" }
      : c.type === "choix" ? { type: "string", enum: c.options }
      : c.type === "oui_non" ? { type: "boolean" }
      : { type: "string" };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["fiches"],
    properties: {
      fiches: {
        type: "array",
        minItems: 5,
        maxItems: 8,
        items: { type: "object", additionalProperties: false, required: Object.keys(proprietes), properties: proprietes },
      },
    },
  };
}

const dateValide = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const jourIso = (d: Date) => d.toISOString().slice(0, 10);

/** Des fiches propres : types respectés, dates au bon format, liens attribués en tournant parmi les fiches visées. */
function nettoyerFiches(p: Partie, brutes: Record<string, unknown>[], indice: number): Record<string, unknown>[] {
  return brutes.slice(0, 8).map((f, i) => {
    const fiche: Record<string, unknown> = { id: `e${indice}_${i + 1}` };
    for (const c of p.champs) {
      const v = f?.[c.cle];
      switch (c.type) {
        case "lien":
          break;
        case "nombre":
        case "montant": {
          const n = Number(v);
          fiche[c.cle] = Number.isFinite(n) ? (c.type === "montant" ? Math.round(Math.abs(n) * 100) / 100 : n) : null;
          break;
        }
        case "date": {
          const d = new Date();
          d.setDate(d.getDate() - (i * 11 + indice * 3) + (/(echeance|audience|prevu|fin|limite|rendez)/.test(c.cle) ? 30 : 0));
          fiche[c.cle] = dateValide(v) ? v : jourIso(d);
          break;
        }
        case "choix":
          fiche[c.cle] = c.options!.includes(String(v)) ? v : c.options![i % c.options!.length];
          break;
        case "oui_non":
          fiche[c.cle] = v === true;
          break;
        default:
          fiche[c.cle] = court(v, c.type === "long" ? 400 : 80);
      }
    }
    if (!fiche[p.titre]) fiche[p.titre] = `${p.unite} ${i + 1}`;
    return fiche;
  });
}

async function exemplesDe(plan: Omit<PlanApplication, "exemples" | "cle">, p: Partie, demande: string, qui: string) {
  const description = p.champs
    .filter((c) => c.type !== "lien")
    .map((c) => `- ${c.cle} (${c.libelle}) : ${c.type}${c.options ? ` parmi ${c.options.join(", ")}` : ""}`)
    .join("\n");
  const r = await completer(
    [
      {
        role: "system",
        content:
          "Tu écris des données d'exemple réalistes pour une application de gestion, en JSON. " +
          "Des noms, montants et dates plausibles pour ce métier, en France, variés d'une fiche à l'autre ; " +
          "dates au format AAAA-MM-JJ, en 2026 ; montants en euros, sans symbole. Jamais de « Exemple 1 » ni de « Lorem ».",
      },
      {
        role: "user",
        content: `Demande : ${demande.slice(0, 600)}\nApplication : ${plan.nom}\nPartie : ${p.nom}\nÉcris 6 fiches avec ces champs :\n${description}`,
      },
    ],
    { qui, maxTokens: 2500, delaiMs: 4 * 60_000, schema: { nom: "fiches", schema: schemaExemples(p) } },
  ).catch(() => null);
  if (!r || !r.ok) return null;
  try {
    const lu = JSON.parse(r.texte.replace(/^```(json)?|```$/g, "").trim()) as { fiches?: unknown };
    return Array.isArray(lu.fiches) ? (lu.fiches as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Étapes 1 et 2 ensemble                                              */
/* ------------------------------------------------------------------ */

export async function planifierApplication(
  demande: string,
  qui: string,
  statut: (message: string) => void,
): Promise<PlanApplication | null> {
  statut(t("Helix prépare l'application, étape 1 sur 4 : le plan des parties et des champs..."));
  const r = await completer(
    [
      { role: "system", content: CONSIGNE_PLAN },
      { role: "user", content: demande.slice(0, 3000) },
    ],
    { qui, maxTokens: 4000, delaiMs: 5 * 60_000, schema: { nom: "plan_application", schema: SCHEMA_PLAN } },
  ).catch(() => null);
  if (!r || !r.ok) return null;
  let brut: unknown;
  try {
    brut = JSON.parse(r.texte.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    return null;
  }
  const plan = normaliserPlan(brut);
  if (!plan) return null;

  const exemples: Record<string, Record<string, unknown>[]> = {};
  for (const [i, p] of plan.modules.entries()) {
    statut(tf("Helix prépare l'application, étape 2 sur 4 : les exemples de « {0} » ({1} sur {2})...", p.nom, i + 1, plan.modules.length));
    const fiches = await exemplesDe(plan, p, demande, qui);
    // Faute de réponse, des fiches sobres plutôt que rien : la page doit montrer ce qu'elle fait.
    exemples[p.cle] = nettoyerFiches(p, fiches ?? Array.from({ length: 4 }, () => ({})), i + 1);
  }
  // Les liens, une fois toutes les fiches connues : chaque fiche renvoie à une fiche de la partie visée, en tournant.
  for (const p of plan.modules) {
    for (const c of p.champs.filter((x) => x.type === "lien")) {
      const cibles = exemples[c.lien!] ?? [];
      exemples[p.cle]!.forEach((f, i) => {
        f[c.cle] = cibles.length ? cibles[(i * 2 + p.cle.length) % cibles.length]!.id : "";
      });
    }
  }
  return { ...plan, cle: cleDe(plan.nom, "application"), exemples };
}

/* ------------------------------------------------------------------ */
/* Étape 3 : l'interface                                               */
/* ------------------------------------------------------------------ */

type Rvb = [number, number, number];
const versRvb = (h: string | undefined, repli: string): Rvb => {
  const brut = (h && /^#[0-9a-f]{3,8}$/i.test(h.trim()) ? h.trim() : repli).replace("#", "");
  const v = brut.length === 3 ? brut.split("").map((c) => c + c).join("") : brut.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rvb;
};
const versHex = (c: Rvb) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const melange = (a: Rvb, b: Rvb, part: number): Rvb => a.map((x, i) => x * part + b[i]! * (1 - part)) as Rvb;
const luminance = (c: Rvb) => {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contraste = (a: Rvb, b: Rvb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const BLANC: Rvb = [255, 255, 255];
const ENCRE: Rvb = [17, 24, 39];
/** La couleur de texte la plus lisible sur `fond`. */
const surFond = (fond: Rvb) => (contraste(fond, BLANC) >= contraste(fond, ENCRE) ? BLANC : ENCRE);
/** Assombrit `c` jusqu'à un contraste de 4,5 avec le blanc (texte blanc dessus, ou texte de cette couleur sur blanc). */
const assezFonce = (c: Rvb) => {
  let x = c;
  for (let i = 0; i < 12 && contraste(x, BLANC) < 4.5; i++) x = melange(x, [0, 0, 0], 0.88);
  return x;
};

/**
 * Les couleurs de l'application, calculées ici en valeurs finies : le contrôle
 * de lisibilité (electron/rendu.cjs) lit les couleurs calculées par le
 * navigateur, et un `color-mix()` lui échappe.
 */
export function theme(design: Design | undefined): string {
  const c = design?.couleurs ?? {};
  const primaire = assezFonce(versRvb(c.primary, "#1D4ED8"));
  const encre = versRvb(c.fg, "#111827");
  const texte = contraste(encre, BLANC) >= 7 ? encre : ENCRE;
  const secondaire = versRvb(c.secondary, "#1F2937");
  // Le menu de gauche est sombre, comme dans les logiciels de gestion : la couleur secondaire si elle l'est, sinon la principale très assombrie.
  const cote = luminance(secondaire) < 0.06 ? secondaire : melange(primaire, [12, 16, 24], 0.22);
  const surCote = surFond(cote);
  const actif = melange(primaire, BLANC, 0.9);
  const serif = (n: string) => /serif|garamond|baskerville|playfair|lora|merriweather|fraunces|cormorant|libre/i.test(n) && !/sans/i.test(n);
  const titre = design?.polices.titre ?? "";
  const corps = design?.polices.texte ?? "";
  const pile = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  // Un tableau dense se lit mal en police à empattements : le texte reste sans empattements.
  const policeTexte = corps && !serif(corps) ? `"${corps}", ${pile}` : pile;
  const policeTitre = titre ? `"${titre}", ${serif(titre) ? "Georgia, serif" : pile}` : policeTexte;
  const fond = melange(primaire, [246, 247, 249], 0.03);
  const lignes = {
    "--primaire": versHex(primaire),
    "--primaire-fonce": versHex(melange(primaire, [0, 0, 0], 0.85)),
    "--sur-primaire": versHex(surFond(primaire)),
    "--lien": versHex(primaire),
    "--anneau": versHex(primaire),
    "--anneau-doux": `rgba(${primaire.join(", ")}, 0.18)`,
    "--fond": versHex(fond),
    "--surface": "#FFFFFF",
    "--entete-tableau": versHex(melange(primaire, [248, 249, 251], 0.04)),
    "--survol": versHex(melange(primaire, [243, 244, 246], 0.05)),
    "--choisie": versHex(melange(primaire, BLANC, 0.1)),
    "--texte": versHex(texte),
    "--texte-attenue": "#4B5563",
    "--bordure": "#E3E6EB",
    "--bordure-forte": "#CBD1D9",
    "--cote": versHex(cote),
    "--sur-cote": versHex(surCote),
    "--sur-cote-attenue": versHex(melange(surCote, cote, 0.72)),
    "--cote-survol": versHex(melange(surCote, cote, 0.1)),
    "--cote-actif": versHex(actif),
    "--sur-cote-actif": versHex(surFond(actif)),
    "--danger": "#B42318",
    "--sur-danger": "#FFFFFF",
    "--p0-fond": "#DBEAFE", "--p0-texte": "#1E40AF",
    "--p1-fond": "#FEF3C7", "--p1-texte": "#92400E",
    "--p2-fond": "#DCFCE7", "--p2-texte": "#166534",
    "--p3-fond": "#EDE9FE", "--p3-texte": "#5B21B6",
    "--p4-fond": "#FEE2E2", "--p4-texte": "#991B1B",
    "--p5-fond": "#E5E7EB", "--p5-texte": "#374151",
    "--police-titre": policeTitre,
    "--police-texte": policeTexte,
  };
  return `/*
 * Couleurs et polices de l'application, préparées par Helix${design ? ` (style « ${design.style} » pour « ${design.produit} »)` : ""}.
 * C'est le fichier à modifier pour changer l'allure ; le reste de la mise en page est dans app.css.
 */
:root {
${Object.entries(lignes).map(([k, v]) => `  ${k}: ${v};`).join("\n")}
  color-scheme: light;
}
`;
}

const TYPES_EXPLIQUES: Record<TypeChamp, string> = {
  texte: "une ligne de texte",
  long: "un texte sur plusieurs lignes",
  nombre: "un nombre",
  montant: "un montant en euros (nombre)",
  date: "une date, AAAA-MM-JJ",
  choix: "une valeur parmi `options`",
  lien: "l'identifiant d'une fiche d'une autre partie (`lien` = la clé de cette partie)",
  courriel: "une adresse électronique",
  telephone: "un numéro de téléphone",
  oui_non: "vrai ou faux",
};

/** Le résumé du plan, pour l'agent de code (et pour la personne). */
function resumePlan(plan: PlanApplication): string {
  return `# ${plan.nom}

${plan.sousTitre}

Application préparée par Helix en plusieurs étapes : le plan ci-dessous, des fiches d'exemple, puis l'interface complète.
Elle s'ouvre avec \`index.html\`, sans serveur. Les données sont enregistrées sur le poste (localStorage du navigateur).

## Les fichiers

- \`app/plan.js\` : les parties, leurs champs et les fiches d'exemple (\`window.PLAN\`), écrits par Helix.
- \`app/metier.js\` : les règles du métier. \`champs\` ajoute des champs aux parties (l'interface suit), \`completer\` remplit les champs calculés, \`valider\` contrôle avant l'enregistrement, \`indicateurs\` donne des chiffres au tableau de bord.
- \`app/theme.css\` : les couleurs et les polices.
- \`index.html\`, \`app/app.js\`, \`app/app.css\` : le moteur et la mise en page, écrits par Helix. Ils marchent : ne pas les réécrire.

## Les parties

${plan.modules
  .map(
    (p) =>
      `### ${p.nom} (\`${p.cle}\`)\n\n` +
      p.champs
        .map((c) => `- \`${c.cle}\` : ${c.libelle}, ${c.type}${c.options ? ` (${c.options.join(", ")})` : ""}${c.lien ? ` vers \`${c.lien}\`` : ""}${c.obligatoire ? ", obligatoire" : ""}`)
        .join("\n"),
  )
  .join("\n\n")}

## Types de champ permis (dans \`champs\` de app/metier.js)

${TYPES.map((x) => `- \`${x}\` : ${TYPES_EXPLIQUES[x]}`).join("\n")}

Icônes permises : ${ICONES.join(", ")}.
`;
}

/** Écrit l'application dans le dossier. Rend la liste des fichiers écrits. */
export function ecrireApplication(dossier: string, plan: PlanApplication, design: Design | undefined): string[] {
  const app = join(dossier, "app");
  mkdirSync(app, { recursive: true });
  const polices = design?.polices.url
    ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n  <link rel="stylesheet" href="${design.polices.url}">`
    : "";
  const echapperHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const fichiers: [string, string][] = [
    ["index.html", modele.index.replace("<!--POLICES-->", polices).replace("<title>Application</title>", `<title>${echapperHtml(plan.nom)}</title>`)],
    ["app/app.js", modele.app],
    ["app/app.css", modele.css],
    ["app/theme.css", theme(design)],
    ["app/plan.js", `/* Plan de l'application, préparé par Helix : parties, champs et fiches d'exemple. Voir app/PLAN.md. */\nwindow.PLAN = ${JSON.stringify(plan, null, 2)};\n`],
    ["app/metier.js", modele.metier],
    ["app/PLAN.md", resumePlan(plan)],
  ];
  for (const [nom, contenu] of fichiers) writeFileSync(join(dossier, nom), contenu);
  return fichiers.map(([nom]) => nom);
}

/** Une application déjà préparée par Helix dans ce dossier (la suite d'une conversation). */
export function applicationPreparee(dossier: string): boolean {
  return existsSync(join(dossier, "app", "plan.js")) && existsSync(join(dossier, "app", "app.js"));
}

/* ------------------------------------------------------------------ */
/* Étape 4 : la consigne de l'agent                                    */
/* ------------------------------------------------------------------ */

/**
 * `dossier` (23/10/2026) : capture d'un utilisateur sous Windows, l'agent
 * lisait « /app/PLAN.md » et écrivait « /app/metier.js » : les chemins
 * relatifs de cette consigne (« app/PLAN.md »), avec la description de `read`
 * qui veut un chemin absolu, devenaient un chemin absolu à la racine du disque
 * (C:\app\…), hors du dossier du projet, refusé par OpenCode
 * (`external_directory: deny`, opencode.ts). La consigne nomme désormais le
 * dossier du projet et le chemin entier des deux fichiers.
 */
export function consigneApplication(plan: PlanApplication | null, dossier: string): string {
  return [
    "",
    "",
    "---",
    plan
      ? `Helix a déjà construit l'application « ${plan.nom} » pour cette demande, en plusieurs étapes : le plan (${plan.modules.map((p) => p.nom).join(", ")}), des fiches d'exemple, puis l'interface complète (tableau de bord, menu, filtres, recherche, tri, pages, fiche détaillée avec les éléments liés, ajout, modification, suppression, export, enregistrement sur le poste). Un programme l'a vérifiée.`
      : "Helix a déjà construit l'application de ce dossier (voir app/PLAN.md).",
    `Le dossier du projet est ${dossier}. Les chemins ci-dessous (app/PLAN.md, app/metier.js…) sont relatifs à ce dossier : app/PLAN.md est ${join(dossier, "app", "PLAN.md")} et app/metier.js est ${join(dossier, "app", "metier.js")}. Jamais /app/… : ce serait un autre dossier, hors du projet.`,
    "Ton travail, dans cet ordre, une étape après l'autre :",
    "1. Lis app/PLAN.md, puis app/metier.js.",
    "2. Ne modifie pas index.html, app/app.js, app/app.css, app/theme.css ni app/plan.js : ils marchent.",
    "3. Si un champ indispensable à la demande manque (un montant TTC, un taux horaire...), déclare-le dans `champs` de app/metier.js, avec `calcule: true` s'il est calculé (types permis : voir app/PLAN.md).",
    "4. Écris app/metier.js EN ENTIER avec l'outil d'écriture (write), pas avec edit : le fichier est court. Garde la même forme (window.Metier = { champs, completer, valider, indicateurs }) et remplis les trois fonctions avec les règles de ce métier : les champs calculés (completer), les contrôles avant enregistrement (valider), deux à quatre chiffres utiles pour le tableau de bord (indicateurs). N'utilise QUE les clés de parties et de champs écrites dans app/PLAN.md, ou déclarées dans `champs` : un champ qui n'est ni l'un ni l'autre n'existe pas.",
    "5. Relis app/metier.js en entier. Termine en disant en quelques lignes ce que tu as ajouté. Ne dis pas que tu as essayé ce que tu n'as pas essayé : un programme essaiera l'application après toi.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Contrôle des règles du métier                                       */
/* ------------------------------------------------------------------ */

/** Le plan écrit dans app/plan.js (`window.PLAN = {…};`), lu sans exécuter le fichier. */
function lirePlan(dossier: string): PlanApplication | null {
  try {
    const texte = readFileSync(join(dossier, "app", "plan.js"), "utf8");
    const debut = texte.indexOf("{");
    const fin = texte.lastIndexOf("}");
    if (debut < 0 || fin <= debut) return null;
    const plan = JSON.parse(texte.slice(debut, fin + 1)) as PlanApplication;
    return Array.isArray(plan.modules) ? plan : null;
  } catch {
    return null;
  }
}

/**
 * Ce qu'un programme peut vérifier dans app/metier.js, mesuré sur l'essai du
 * 26/09/2026 (Qwen3 8B) : ses trois « edit » ont échoué (il sautait les
 * commentaires entre les fonctions), le fichier est resté vide, et il a
 * annoncé les règles « ajoutées » ; celles qu'il voulait écrire lisaient des
 * champs qui n'existent pas (`montant_ht`, un statut de facture absent du plan).
 * `prepareeCeTour` : l'application vient d'être préparée pour cette demande,
 * donc des règles étaient attendues.
 */
export function problemesMetier(dossier: string, prepareeCeTour: boolean): string[] {
  const plan = lirePlan(dossier);
  if (!plan) return [];
  let code = "";
  try {
    code = readFileSync(join(dossier, "app", "metier.js"), "utf8");
  } catch {
    return ["app/metier.js est introuvable : réécris-le en entier (window.Metier = { champs, completer, valider, indicateurs })."];
  }
  const problemes: string[] = [];
  const normalise = (x: string) => x.replace(/\s+/g, " ").trim();
  if (prepareeCeTour && normalise(code) === normalise(modele.metier)) {
    problemes.push(
      "app/metier.js n'a pas changé : aucune règle n'a été écrite (tes modifications ont échoué). " +
        "Réécris le fichier EN ENTIER avec l'outil write, dans la même forme, avec les trois fonctions remplies.",
    );
  }
  // Seulement le code, sans les commentaires (ils contiennent des exemples aux clés inventées).
  const sansCommentaires = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  const parties = new Set(plan.modules.map((p) => p.cle));
  const champs = new Set(["id", ...plan.modules.flatMap((p) => p.champs.map((c) => c.cle))]);
  // Les champs déclarés dans `champs` de metier.js existent aussi.
  for (const m of sansCommentaires.matchAll(/\bcle\s*:\s*["']([A-Za-z_$][\w$]*)["']/g)) champs.add(m[1]!);
  const inconnues = new Set<string>();
  for (const m of sansCommentaires.matchAll(/partie\s*===?\s*["']([^"']+)["']|donnees\.([A-Za-z_$][\w$]*)|donnees\[["']([^"']+)["']\]/g)) {
    const nom = m[1] ?? m[2] ?? m[3]!;
    if (!parties.has(nom)) inconnues.add(`partie « ${nom} »`);
  }
  for (const m of sansCommentaires.matchAll(/\bfiche\.([A-Za-z_$][\w$]*)/g)) {
    if (!champs.has(m[1]!)) inconnues.add(`champ « ${m[1]} »`);
  }
  /*
   * Les fiches parcourues : `donnees.dossiers.filter((d) => d.statut === …)`.
   * Mesuré le 26/09/2026 : « d.stat, "En cours" » au lieu de « d.statut ===
   * "En cours" » comptait toujours zéro dossier, sans la moindre erreur.
   */
  const parPartie = new Map(plan.modules.map((p) => [p.cle, new Set(["id", ...p.champs.map((c) => c.cle)])]));
  for (const m of sansCommentaires.matchAll(/\bcle\s*:\s*["']([A-Za-z_$][\w$]*)["']/g)) for (const ens of parPartie.values()) ens.add(m[1]!);
  const parcours =
    /donnees\.([A-Za-z_$][\w$]*)\s*\.\s*(?:filter|find|findIndex|some|every|map|forEach|reduce)\s*\(\s*(?:function\s*\(([^)]*)\)|\(([^)]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)/g;
  for (const m of sansCommentaires.matchAll(parcours)) {
    const ens = parPartie.get(m[1]!);
    if (!ens) continue;
    const params = (m[2] ?? m[3] ?? m[4] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    // reduce((total, fiche) => …) : la fiche est le second paramètre.
    const nom = /reduce\s*\($/.test(m[0].replace(/\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)$/, "")) ? params[1] : params[0];
    if (!nom || !/^[A-Za-z_$][\w$]*$/.test(nom)) continue;
    const suite = sansCommentaires.slice(m.index! + m[0].length, m.index! + m[0].length + 300);
    for (const x of suite.matchAll(new RegExp(`(?<![\\w$.])${echapperRegex(nom)}\\.([A-Za-z_$][\\w$]*)`, "g"))) {
      if (!ens.has(x[1]!)) inconnues.add(`champ « ${x[1]} » de ${m[1]}`);
    }
  }
  if (inconnues.size > 0) {
    problemes.push(
      `app/metier.js utilise ce qui n'existe pas dans app/plan.js : ${[...inconnues].slice(0, 8).join(", ")}. ` +
        `Parties : ${[...parties].join(", ")}. Champs : ${plan.modules.map((p) => `${p.cle} (${p.champs.map((c) => c.cle).join(", ")})`).join(" ; ")}. ` +
        "Utilise ces clés-là, ou déclare le champ dans `champs` de app/metier.js (réécris le fichier en entier avec write ; ne modifie pas app/plan.js).",
    );
  }
  return problemes;
}
