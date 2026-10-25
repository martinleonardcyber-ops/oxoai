import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import donnees from "../design/donnees.json" with { type: "json" };
import { completer } from "./completion.ts";

/**
 * Un design professionnel pour les sites que fait OxoAI Code, même avec un
 * petit modèle.
 *
 * Demandé le 24/09/2026 : un site fait par Code avec Qwen3 8B était « moche ».
 * Un petit modèle ne sait pas inventer une palette, marier deux polices ni
 * régler des espacements : laissé seul, il écrit trois couleurs primaires sur
 * du Times. On ne lui demande donc plus de dessiner. OxoAI choisit le design
 * et le lui fournit tout fait :
 *
 *  - le choix vient des tables du skill « UI/UX Pro Max » (nextlevelbuilder,
 *    licence MIT, `gateway/design/`) : 192 types de produits, chacun avec son
 *    style, sa palette complète, son plan de page et ce qu'il faut éviter ;
 *    74 associations de polices ;
 *  - OxoAI écrit dans le projet `design/oxoai.css`, une feuille complète
 *    (en-tête, héros, boutons, cartes, tarifs, témoignages, FAQ, formulaire,
 *    pied de page), réglée sur ce choix, et `design/DESIGN.md`, qui montre
 *    chaque bloc en HTML prêt à copier ;
 *  - la consigne envoyée au modèle tient en quelques lignes : lire le guide,
 *    relier la feuille, composer avec ses classes, écrire un vrai contenu.
 *
 * Le modèle n'a plus qu'à écrire la structure et le texte, ce qu'il fait bien.
 */

interface Produit {
  type: string;
  kw: string;
  style: string;
  landing: string;
  note: string;
  c: Record<string, string>;
  typo: string;
  effets: string;
  eviter: string;
}
interface Police {
  nom: string;
  titre: string;
  texte: string;
  mood: string;
  pour: string;
  url: string;
}
interface PlanPage {
  nom: string;
  id: string;
  alias: string;
  kw: string;
  sections: string;
  cta: string;
  conversion: string;
}

const PRODUITS = donnees.produits as Produit[];
const POLICES = donnees.polices as Police[];
const PAGES = donnees.pages as PlanPage[];

/* ------------------------------------------------------------------ */
/* Est-ce une demande de site ?                                        */
/* ------------------------------------------------------------------ */

/*
 * Reconnaître une demande de site, sans prendre une demande de code pour une.
 *
 * L'ancienne règle cherchait un seul mot parmi « site, page, interface,
 * formulaire, html, css, web… ». « Ajoute une interface User en TypeScript »,
 * « corrige la validation du formulaire côté serveur » ou « la page 3 de l'API
 * renvoie une erreur » devenaient des demandes de site : un dossier design/ et
 * une consigne de couleurs et de polices partaient avec, et un petit modèle
 * s'y perdait (constaté en relisant la règle le 25/09/2026, à la demande de
 * Medhi).
 *
 * Désormais, trois familles de mots, comparées sans accents :
 *  - les mots sans ambiguïté (site, landing, vitrine, portfolio, page web,
 *    page d'accueil…) suffisent ;
 *  - les mots ambigus (page, interface, formulaire, maquette, html, css…) ne
 *    comptent qu'avec un verbe de création (crée, fais, conçois, build…) ;
 *  - et jamais à côté d'un mot de programmation (TypeScript, type, API,
 *    serveur, classe, fonction, test, bug…), qui dit que la demande porte sur
 *    du code, pas sur un écran à dessiner.
 * Le dossier déjà commencé reste protégé par `projetDejaCommence`.
 */
const SITE_SUR = /\b(site|sites|landing|vitrine|portfolio|website|webpage|homepage|page web|pages web|page d'accueil|page daccueil|application web|app web|site web|e-?commerce|boutique en ligne|blog)\b/;
const SITE_AMBIGU = /\b(page|pages|interface|interfaces|formulaire|formulaires|maquette|maquettes|accueil|html|css|front-?end|web|boutique|ecran|ecrans|form|ui|erp|crm|application|applications|appli|logiciel|gestion|tableau de bord|dashboard|back-?office)\b/;
/*
 * Une application de gestion (ERP, CRM, suivi, tableau de bord) : ajouté le
 * 26/09/2026. « Tu peux faire un petit ERP fonctionnel pour un cabinet
 * d'avocat ? » ne recevait ni design ni règle : page blanche à l'ouverture,
 * onglets blanc sur gris, listes figées. Elle reçoit le design et des règles de
 * comportement propres aux applications (`CONSIGNE_APPLICATION`).
 */
const APPLICATION = /\b(erp|crm|application|applications|appli|logiciel|gestion|tableau de bord|dashboard|back-?office|suivi (des|de|du)|outil (de|pour))\b/;
const CREATION = /\b(cree|creer|creez|crees|fais|faire|faites|fait|construis|construire|construisez|concois|concevoir|developpe|developper|realise|realiser|genere|generer|monte|monter|dessine|dessiner|refais|refaire|embellis|embellir|habille|habiller|design|designer|create|build|make|design|generate|develop|mock ?up|plus (beau|belle|beaux|belles|joli|jolie|moderne|professionnel|professionnelle|pro|attrayant|attrayante)|more (beautiful|modern|professional))\b/;
const CODE_CONTEXTE = /\b(ligne de commande|mobile|android|ios|typescript|javascript|python|java|rust|golang|php|type|types|typage|api|apis|endpoint|endpoints|route|routes|serveur|server|backend|back-?end|base de donnees|database|sql|requete|requetes|query|classe|classes|class|fonction|fonctions|function|methode|methodes|method|variable|variables|test|tests|unitaire|bug|bugs|erreur|erreurs|error|exception|stack ?trace|pagination|schema|migration|module|modules|package|dependance|dependances|import|export|refactor|refactorise|refactoriser|compile|compilation|script|scripts|regex|json|cli|terminal|props|enum|struct)\b/;

const sansAccents = (texte: string) =>
  texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’]/g, "'");

/** Une demande de site qui est une application (formulaires, listes, données), pas une vitrine. */
export function estApplication(texte: string): boolean {
  return estDemandeDeSite(texte) && APPLICATION.test(sansAccents(texte));
}

export function estDemandeDeSite(texte: string): boolean {
  const t = sansAccents(texte);
  if (CODE_CONTEXTE.test(t) && !SITE_SUR.test(t)) return false;
  if (SITE_SUR.test(t)) return !CODE_CONTEXTE.test(t) || CREATION.test(t);
  return SITE_AMBIGU.test(t) && CREATION.test(t);
}

/* ------------------------------------------------------------------ */
/* Choisir                                                             */
/* ------------------------------------------------------------------ */

/*
 * Les tables sont en anglais. Un modèle local traduit la demande en quelques
 * mots-clés ; s'il ne répond pas, ce petit lexique couvre les demandes les
 * plus courantes.
 */
const LEXIQUE: Record<string, string> = {
  restaurant: "restaurant food dining", boulangerie: "bakery food cafe", patisserie: "bakery pastry food", cafe: "cafe coffee",
  avocat: "legal law firm attorney", notaire: "legal law", juriste: "legal law", juridique: "legal law", comptable: "accounting finance", banque: "banking finance", assurance: "insurance",
  coiffeur: "beauty salon spa", coiffure: "beauty salon", esthetique: "beauty spa", spa: "spa wellness", yoga: "yoga wellness fitness",
  sport: "fitness gym sports", salle: "gym fitness", medecin: "healthcare medical clinic", dentiste: "dental clinic healthcare",
  clinique: "clinic healthcare medical", immobilier: "real estate property", hotel: "hotel hospitality travel", voyage: "travel tourism",
  mariage: "wedding event", evenement: "event conference", photographe: "photography portfolio", photo: "photography",
  architecte: "architecture interior design", artisan: "local service craft", plombier: "home service local", electricien: "home service local",
  ecole: "education school", formation: "education online course", cours: "education course", association: "nonprofit charity",
  startup: "saas startup tech", logiciel: "saas software", appli: "mobile app", application: "app software", agence: "agency creative",
  boutique: "ecommerce shop retail", mode: "fashion ecommerce", bijoux: "jewelry luxury ecommerce", luxe: "luxury premium",
  vin: "wine luxury", musique: "music entertainment", jeu: "gaming", crypto: "crypto web3 finance", ia: "ai artificial intelligence saas",
  consultant: "consulting professional services", portfolio: "portfolio personal", cv: "portfolio resume personal", blog: "blog content",
  garage: "automotive car service", voiture: "automotive car", animaux: "pet veterinary", veterinaire: "veterinary pet clinic",
  ferme: "agriculture organic food", bio: "organic eco food", ecologie: "sustainability eco green", energie: "energy sustainability",
};

/** Mots comparables : sans accents ni pluriel (« avocats » retrouve « avocat », « firms » retrouve « firm »). */
const mots = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length > 2)
    .map((m) => (m.length > 4 && /[sx]$/.test(m) ? m.slice(0, -1) : m));

const INDEX = PRODUITS.map((p) => new Set(mots(`${p.type} ${p.kw}`)));
/** Les mots du nom du type pèsent double : « Legal Services » l'emporte sur un annuaire qui cite « lawyer ». */
const NOMS = PRODUITS.map((p) => new Set(mots(p.type)));
const IDF = (() => {
  const compte = new Map<string, number>();
  for (const s of INDEX) for (const m of s) compte.set(m, (compte.get(m) ?? 0) + 1);
  return (m: string) => Math.log(1 + PRODUITS.length / (compte.get(m) ?? PRODUITS.length));
})();

/*
 * Ce que dit toute demande de site, quel que soit le métier : ces mots ne
 * départagent rien. Mesuré le 24/09/2026 : « avis clients et contact »
 * faisait choisir le style d'un logiciel de gestion de clients (CRM) pour une
 * boulangerie.
 */
const GENERIQUES = new Set(mots(
  "site web website page landing vitrine accueil home client customer contact avis review presentation about service business " +
  "online local horaire hour info information nous our team equipe offre product produit company entreprise design modern moderne simple",
));

/** Mots de métier sûrs (le lexique) d'un côté, mots du modèle de l'autre. */
async function motsCles(demande: string, qui: string): Promise<{ surs: string; modele: string }> {
  const lexique = mots(demande)
    .map((m) => LEXIQUE[m] ?? LEXIQUE[m.replace(/e$/, "")] ?? "")
    .join(" ");
  const r = await completer(
    [
      {
        role: "system",
        content:
          "Reply with 3 to 8 English keywords describing the kind of business or product this website is for " +
          "(industry, audience, tone). Keywords only, separated by spaces. No sentence.",
      },
      { role: "user", content: demande.slice(0, 1500) },
    ],
    { qui, maxTokens: 40, delaiMs: 30_000 },
  ).catch(() => null);
  return { surs: lexique, modele: `${demande} ${r && r.ok ? r.texte : ""}` };
}

function meilleurProduit(surs: string, autres: string): Produit {
  const poids = new Map<string, number>();
  for (const m of mots(autres)) if (!GENERIQUES.has(m)) poids.set(m, 1);
  for (const m of mots(surs)) if (!GENERIQUES.has(m)) poids.set(m, 3);
  let meilleur = -1;
  let score = 0;
  PRODUITS.forEach((_, i) => {
    let s = 0;
    for (const [m, w] of poids) if (INDEX[i]!.has(m)) s += IDF(m) * w * (NOMS[i]!.has(m) ? 2 : 1);
    if (s > score) {
      score = s;
      meilleur = i;
    }
  });
  // Rien de reconnu : un site d'entreprise sobre, le cas le plus courant.
  return PRODUITS[meilleur] ?? PRODUITS.find((p) => /service|business|corporate/i.test(p.type)) ?? PRODUITS[0]!;
}

function meilleuresPolices(p: Produit): Police {
  const q = new Set(mots(`${p.typo} ${p.type} ${p.kw} ${p.style}`));
  let meilleure = POLICES[0]!;
  let score = -1;
  for (const f of POLICES) {
    const s = mots(`${f.mood} ${f.pour}`).filter((m) => q.has(m)).length;
    if (s > score) {
      score = s;
      meilleure = f;
    }
  }
  return meilleure;
}

function planDePage(p: Produit): PlanPage | undefined {
  const cle = p.landing.toLowerCase();
  return PAGES.find((l) => l.nom.toLowerCase() === cle || l.alias.toLowerCase().split("|").includes(cle)) ??
    PAGES.find((l) => cle.includes(l.nom.toLowerCase().split(" ")[0]!));
}

/* ------------------------------------------------------------------ */
/* Familles de style                                                   */
/* ------------------------------------------------------------------ */

/*
 * Les 88 styles du skill se ramènent ici à cinq familles, celles qu'une
 * feuille de style peut rendre correctement sans images ni animations
 * complexes. Chaque famille règle les arrondis, les ombres et quelques effets.
 */
type Famille = "sobre" | "vif" | "doux" | "verre" | "sombre";

function familleDe(style: string): Famille {
  // « Vibrant & Block-based + Soft UI Evolution » : le premier style est le principal.
  const s = (style.split("+")[0] ?? style).toLowerCase();
  if (/dark|oled|cyber|hud|sci-fi|ai-native|3d/.test(s)) return "sombre";
  if (/glass|aurora|spatial|gradient/.test(s)) return "verre";
  if (/clay|soft|neumorph|organic|biophil|biomim|nature/.test(s)) return "doux";
  if (/vibrant|block|motion|brutal|pixel|memphis|y2k|kinetic|bold/.test(s)) return "vif";
  return "sobre";
}

const REGLAGES: Record<Famille, { rayon: string; rayonGrand: string; ombre: string; ombreHaute: string; bordure: string; titreGraisse: number }> = {
  sobre: { rayon: "8px", rayonGrand: "14px", ombre: "0 1px 2px rgb(0 0 0 / .05)", ombreHaute: "0 12px 32px -12px rgb(0 0 0 / .18)", bordure: "1px", titreGraisse: 650 },
  vif: { rayon: "14px", rayonGrand: "24px", ombre: "0 2px 0 rgb(0 0 0 / .08)", ombreHaute: "0 18px 40px -16px rgb(0 0 0 / .28)", bordure: "2px", titreGraisse: 800 },
  doux: { rayon: "18px", rayonGrand: "28px", ombre: "0 6px 18px -8px rgb(0 0 0 / .12)", ombreHaute: "0 20px 44px -18px rgb(0 0 0 / .22)", bordure: "1px", titreGraisse: 650 },
  verre: { rayon: "16px", rayonGrand: "26px", ombre: "0 8px 24px -12px rgb(0 0 0 / .2)", ombreHaute: "0 24px 60px -20px rgb(0 0 0 / .35)", bordure: "1px", titreGraisse: 700 },
  sombre: { rayon: "12px", rayonGrand: "20px", ombre: "0 0 0 1px rgb(255 255 255 / .06)", ombreHaute: "0 20px 50px -20px rgb(0 0 0 / .6)", bordure: "1px", titreGraisse: 700 },
};

export interface Design {
  produit: string;
  style: string;
  famille: Famille;
  couleurs: Record<string, string>;
  polices: Police;
  plan?: PlanPage;
  eviter: string;
  note: string;
  effets: string;
}

export async function choisirDesign(demande: string, qui: string): Promise<Design> {
  const cles = await motsCles(demande, qui);
  const p = meilleurProduit(cles.surs, cles.modele);
  return {
    produit: p.type,
    style: p.style,
    famille: familleDe(p.style),
    couleurs: p.c,
    polices: meilleuresPolices(p),
    plan: planDePage(p),
    eviter: p.eviter,
    note: p.note,
    effets: p.effets,
  };
}

/* ------------------------------------------------------------------ */
/* La feuille de style                                                 */
/* ------------------------------------------------------------------ */

const hex = (v: string | undefined, repli: string) => (v && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : repli);

/** Couleur claire ou sombre ? Pour régler les effets de la famille « sombre ». */
function clarte(h: string): number {
  const n = h.replace("#", "");
  const v = n.length === 3 ? n.split("").map((c) => c + c).join("") : n.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function feuilleDeStyle(d: Design): string {
  const c = d.couleurs;
  const r = REGLAGES[d.famille];
  const fond = hex(c.bg, "#FFFFFF");
  const sombre = clarte(fond) < 0.35;
  const famille = (nom: string, repli: string) => `"${nom}", ${repli}`;
  const serif = (n: string) => /serif|garamond|baskerville|playfair|lora|merriweather|fraunces|dm serif|cormorant|libre/i.test(n) && !/sans/i.test(n);
  const titre = famille(d.polices.titre, serif(d.polices.titre) ? "Georgia, serif" : "system-ui, sans-serif");
  const texte = famille(d.polices.texte, serif(d.polices.texte) ? "Georgia, serif" : "system-ui, sans-serif");

  return `/*
 * oxoai.css : feuille de style du site, préparée par OxoAI.
 * Style : ${d.style} (famille « ${d.famille} ») pour « ${d.produit} ».
 * Palette et polices : tables du skill UI/UX Pro Max (nextlevelbuilder, licence MIT).
 * Ne pas réécrire : composer la page avec ses classes (voir DESIGN.md).
 * Pour ajuster, ajouter des règles dans un fichier à part, après celui-ci.
 */

:root {
  --primaire: ${hex(c.primary, "#2563EB")};
  --sur-primaire: ${hex(c.onPrimary, "#FFFFFF")};
  --secondaire: ${hex(c.secondary, "#1E293B")};
  --sur-secondaire: ${hex(c.onSecondary, "#FFFFFF")};
  --accent: ${hex(c.accent, "#F59E0B")};
  --sur-accent: ${hex(c.onAccent, "#111111")};
  --fond: ${fond};
  --texte: ${hex(c.fg, "#0F172A")};
  --carte: ${hex(c.card, "#FFFFFF")};
  --texte-carte: ${hex(c.cardFg, hex(c.fg, "#0F172A"))};
  --attenue: ${hex(c.muted, "#F1F5F9")};
  --texte-attenue: ${hex(c.mutedFg, "#64748B")};
  --bordure: ${hex(c.border, "#E2E8F0")};
  --danger: ${hex(c.destructive, "#DC2626")};
  --anneau: ${hex(c.ring, hex(c.primary, "#2563EB"))};

  --police-titre: ${titre};
  --police-texte: ${texte};

  --rayon: ${r.rayon};
  --rayon-grand: ${r.rayonGrand};
  --ombre: ${r.ombre};
  --ombre-haute: ${r.ombreHaute};
  --trait: ${r.bordure};

  --largeur: 1160px;
  --marge: clamp(1.25rem, 4vw, 2.5rem);
  --section: clamp(4rem, 9vw, 7.5rem);
  --ecart: clamp(1rem, 2.5vw, 1.75rem);
  --transition: 180ms cubic-bezier(.2, .7, .2, 1);
  color-scheme: ${sombre ? "dark" : "light"};
}

/* ---------- Base ---------- */
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; }
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--police-texte);
  font-size: clamp(1rem, .96rem + .2vw, 1.0625rem);
  line-height: 1.65;
  color: var(--texte);
  background: var(--fond);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
img, svg, video { display: block; max-width: 100%; height: auto; }
a { color: var(--primaire); text-decoration-thickness: .08em; text-underline-offset: .2em; }
a:hover { color: var(--secondaire); }
h1, h2, h3, h4 {
  font-family: var(--police-titre);
  font-weight: ${r.titreGraisse};
  line-height: 1.12;
  letter-spacing: -0.02em;
  color: var(--texte);
  text-wrap: balance;
}
h1 { font-size: clamp(2.5rem, 1.6rem + 3.8vw, 4.5rem); }
h2 { font-size: clamp(1.9rem, 1.4rem + 2vw, 3rem); }
h3 { font-size: clamp(1.2rem, 1.1rem + .5vw, 1.45rem); letter-spacing: -0.01em; }
p { text-wrap: pretty; }
::selection { background: var(--primaire); color: var(--sur-primaire); }
:focus-visible { outline: 3px solid var(--anneau); outline-offset: 3px; border-radius: 4px; }

/* ---------- Mise en page ---------- */
.conteneur { width: min(100% - 2 * var(--marge), var(--largeur)); margin-inline: auto; }
.section { padding-block: var(--section); }
/* Teinté de la couleur principale plutôt que du gris des tables : un gris froid jurait sur un fond crème (mesuré sur une boulangerie). */
.section--attenuee { background: color-mix(in srgb, var(--primaire) 6%, var(--fond)); }
.section--primaire { background: var(--primaire); color: var(--sur-primaire); }
.section--primaire h2, .section--primaire h3 { color: var(--sur-primaire); }
.entete-section { max-width: 44rem; margin-bottom: clamp(2.5rem, 5vw, 3.5rem); }
.entete-section--centre { margin-inline: auto; text-align: center; }
.entete-section p { margin-top: 1rem; font-size: 1.125rem; color: var(--texte-attenue); }
.surtitre {
  display: inline-flex; align-items: center; gap: .5rem;
  margin-bottom: 1rem; padding: .35rem .8rem;
  font-size: .8125rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--primaire); background: color-mix(in srgb, var(--primaire) 10%, transparent);
  border-radius: 999px;
}
.grille { display: grid; gap: var(--ecart); grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
.grille--2 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); }
.grille--3 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); }
.pile { display: flex; flex-direction: column; gap: var(--ecart); }
.rangee { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
.centre { text-align: center; }
.texte-attenue { color: var(--texte-attenue); }

/* ---------- En-tête ---------- */
.entete {
  position: sticky; top: 0; z-index: 50;
  background: color-mix(in srgb, var(--fond) 82%, transparent);
  backdrop-filter: saturate(1.4) blur(14px); -webkit-backdrop-filter: saturate(1.4) blur(14px);
  border-bottom: 1px solid color-mix(in srgb, var(--bordure) 70%, transparent);
}
.entete .conteneur { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; min-height: 4.25rem; }
.logo { display: inline-flex; align-items: center; gap: .6rem; font-family: var(--police-titre); font-weight: 750; font-size: 1.2rem; color: var(--texte); text-decoration: none; letter-spacing: -0.02em; }
.logo__marque { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: calc(var(--rayon) * .8); background: var(--primaire); color: var(--sur-primaire); font-size: .95rem; }
.menu { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem 1.5rem; list-style: none; padding: 0; }
.menu a { color: var(--texte-attenue); text-decoration: none; font-weight: 500; font-size: .95rem; transition: color var(--transition); }
.menu a:hover, .menu a[aria-current="page"] { color: var(--texte); }

/* ---------- Héros ---------- */
.heros { padding-block: clamp(4.5rem, 11vw, 8.5rem) clamp(3.5rem, 8vw, 6rem); }
.heros--divise .conteneur { display: grid; gap: clamp(2rem, 5vw, 4rem); align-items: center; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
.heros--centre { text-align: center; }
.heros--centre .heros__texte { margin-inline: auto; }
.heros--centre .rangee { justify-content: center; }
.heros__texte { max-width: 38rem; margin-top: 1.25rem; font-size: clamp(1.1rem, 1rem + .4vw, 1.3rem); color: var(--texte-attenue); }
.heros .rangee { margin-top: 2rem; }
.heros__preuve { margin-top: 1.75rem; font-size: .9rem; color: var(--texte-attenue); }

/* Un visuel sans image : un dégradé aux couleurs du site, jamais une image cassée. */
div.visuel, figure.visuel {
  position: relative; aspect-ratio: 4 / 3; border-radius: var(--rayon-grand); overflow: hidden;
  background:
    radial-gradient(120% 90% at 10% 10%, color-mix(in srgb, var(--accent) 55%, transparent), transparent 60%),
    radial-gradient(90% 90% at 90% 90%, color-mix(in srgb, var(--primaire) 75%, transparent), transparent 65%),
    var(--secondaire);
  box-shadow: var(--ombre-haute);
}
div.visuel > img, figure.visuel > img { width: 100%; height: 100%; object-fit: cover; }
.visuel__legende { position: absolute; left: 1rem; bottom: 1rem; padding: .5rem .8rem; border-radius: var(--rayon); background: color-mix(in srgb, var(--carte) 88%, transparent); color: var(--texte-carte); font-size: .875rem; font-weight: 600; box-shadow: var(--ombre); }

/* ---------- Boutons ---------- */
.bouton {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  min-height: 2.9rem; padding: .7rem 1.35rem;
  font: 600 1rem/1 var(--police-texte); text-decoration: none; cursor: pointer;
  color: var(--sur-primaire); background: var(--primaire);
  border: var(--trait) solid var(--primaire); border-radius: var(--rayon);
  box-shadow: var(--ombre);
  transition: transform var(--transition), box-shadow var(--transition), background var(--transition), color var(--transition);
}
.bouton:hover { color: var(--sur-primaire); transform: translateY(-1px); box-shadow: var(--ombre-haute); background: color-mix(in srgb, var(--primaire) 88%, black); }
.bouton--secondaire { color: var(--texte); background: transparent; border-color: var(--bordure); box-shadow: none; }
.bouton--secondaire:hover { color: var(--texte); background: var(--attenue); border-color: var(--texte-attenue); }
.bouton--accent { color: var(--sur-accent); background: var(--accent); border-color: var(--accent); }
.bouton--accent:hover { color: var(--sur-accent); background: color-mix(in srgb, var(--accent) 88%, black); }
.bouton--grand { min-height: 3.4rem; padding-inline: 1.8rem; font-size: 1.06rem; }
.section--primaire .bouton { color: var(--primaire); background: var(--sur-primaire); border-color: var(--sur-primaire); }

/* ---------- Cartes ---------- */
.carte {
  display: flex; flex-direction: column; gap: .75rem;
  padding: clamp(1.4rem, 2.5vw, 2rem);
  color: var(--texte-carte); background: var(--carte);
  border: var(--trait) solid var(--bordure); border-radius: var(--rayon-grand);
  box-shadow: var(--ombre);
  transition: transform var(--transition), box-shadow var(--transition), border-color var(--transition);
}
a.carte { text-decoration: none; }
a.carte:hover, .carte--survol:hover { transform: translateY(-3px); box-shadow: var(--ombre-haute); border-color: color-mix(in srgb, var(--primaire) 35%, var(--bordure)); }
.carte h3 { color: var(--texte-carte); }
.carte p { color: var(--texte-attenue); }
.carte--mise-en-avant { border-color: var(--primaire); box-shadow: 0 0 0 1px var(--primaire), var(--ombre-haute); }
.icone {
  display: grid; place-items: center; width: 3rem; height: 3rem; flex: none;
  border-radius: calc(var(--rayon) * 1.1);
  color: var(--primaire); background: color-mix(in srgb, var(--primaire) 12%, transparent);
}
.icone svg { width: 1.5rem; height: 1.5rem; }

/* ---------- Étapes et chiffres ---------- */
.etapes { counter-reset: etape; display: grid; gap: var(--ecart); grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); list-style: none; padding: 0; }
.etapes li { counter-increment: etape; position: relative; padding-top: 3.5rem; }
.etapes li::before { content: counter(etape); position: absolute; top: 0; left: 0; display: grid; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: 999px; font-weight: 700; color: var(--sur-primaire); background: var(--primaire); }
.etapes h3 { margin-bottom: .4rem; }
.etapes p { color: var(--texte-attenue); }
.chiffres { display: grid; gap: var(--ecart); grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); }
.chiffre__valeur { display: block; font-family: var(--police-titre); font-size: clamp(2.2rem, 1.6rem + 2vw, 3.2rem); font-weight: 750; letter-spacing: -0.03em; color: var(--primaire); line-height: 1; }
.chiffre__libelle { display: block; margin-top: .5rem; color: var(--texte-attenue); }
.section--primaire .chiffre__valeur, .section--primaire .chiffre__libelle { color: var(--sur-primaire); }

/* ---------- Témoignages ---------- */
.temoignage { gap: 1.25rem; }
.temoignage blockquote { font-size: 1.08rem; line-height: 1.6; color: var(--texte-carte); }
.temoignage figcaption { display: flex; align-items: center; gap: .8rem; font-size: .92rem; color: var(--texte-attenue); }
.temoignage figcaption strong { display: block; color: var(--texte-carte); }
.avatar { display: grid; place-items: center; width: 2.75rem; height: 2.75rem; flex: none; border-radius: 999px; font-weight: 700; color: var(--sur-secondaire); background: var(--secondaire); }
.etoiles { color: var(--accent); letter-spacing: .15em; }

/* ---------- Tarifs ---------- */
.tarif { gap: 1.1rem; }
.tarif__prix { font-family: var(--police-titre); font-size: 2.6rem; font-weight: 750; letter-spacing: -0.03em; color: var(--texte-carte); line-height: 1; }
.tarif__prix small { font-size: 1rem; font-weight: 500; color: var(--texte-attenue); letter-spacing: 0; }
.liste-coches { display: grid; gap: .6rem; list-style: none; padding: 0; }
.liste-coches li { position: relative; padding-left: 1.75rem; color: var(--texte-carte); }
.liste-coches li::before { content: ""; position: absolute; left: 0; top: .3em; width: 1.05rem; height: 1.05rem; border-radius: 999px; background: color-mix(in srgb, var(--primaire) 14%, transparent) no-repeat center / 70% url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12l5 5L20 7'/%3E%3C/svg%3E"); }
.badge { align-self: flex-start; padding: .3rem .7rem; font-size: .78rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; border-radius: 999px; color: var(--sur-accent); background: var(--accent); }
.tarif .bouton { margin-top: auto; }

/* ---------- Questions fréquentes ---------- */
.faq { max-width: 48rem; margin-inline: auto; display: grid; gap: .75rem; }
.faq details { background: var(--carte); border: var(--trait) solid var(--bordure); border-radius: var(--rayon); padding: 1.1rem 1.3rem; }
.faq summary { cursor: pointer; list-style: none; display: flex; justify-content: space-between; gap: 1rem; font-weight: 600; color: var(--texte-carte); }
.faq summary::-webkit-details-marker { display: none; }
.faq summary::after { content: "+"; font-size: 1.3rem; line-height: 1; color: var(--primaire); transition: transform var(--transition); }
.faq details[open] summary::after { transform: rotate(45deg); }
.faq details p { margin-top: .75rem; color: var(--texte-attenue); }

/* ---------- Appel à l'action ---------- */
.appel {
  display: grid; justify-items: center; gap: 1.25rem; text-align: center;
  padding: clamp(2.5rem, 6vw, 4.5rem) var(--marge);
  border-radius: var(--rayon-grand);
  color: var(--sur-primaire);
  background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--accent) 45%, transparent), transparent 55%), var(--primaire);
  box-shadow: var(--ombre-haute);
}
.appel h2 { color: var(--sur-primaire); max-width: 36rem; }
.appel p { max-width: 36rem; color: color-mix(in srgb, var(--sur-primaire) 82%, transparent); font-size: 1.1rem; }
.appel .bouton { color: var(--primaire); background: var(--sur-primaire); border-color: var(--sur-primaire); }

/* ---------- Formulaire ---------- */
.formulaire { display: grid; gap: 1.1rem; }
.champ { display: grid; gap: .45rem; }
.champ label { font-weight: 600; font-size: .95rem; }
.champ input, .champ textarea, .champ select {
  width: 100%; padding: .8rem 1rem; font: inherit; color: var(--texte-carte);
  background: var(--carte); border: var(--trait) solid var(--bordure); border-radius: var(--rayon);
  transition: border-color var(--transition), box-shadow var(--transition);
}
.champ textarea { min-height: 8rem; resize: vertical; }
.champ input:focus, .champ textarea:focus, .champ select:focus { outline: none; border-color: var(--anneau); box-shadow: 0 0 0 4px color-mix(in srgb, var(--anneau) 22%, transparent); }

/* ---------- Pied de page ---------- */
.pied { padding-block: 3.5rem 2.5rem; background: color-mix(in srgb, var(--primaire) 8%, var(--fond)); color: var(--texte-attenue); font-size: .95rem; }
.pied__colonnes { display: grid; gap: 2rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); }
.pied h4 { font-size: .9rem; letter-spacing: .03em; text-transform: uppercase; margin-bottom: .9rem; color: var(--texte); }
.pied ul { list-style: none; padding: 0; display: grid; gap: .5rem; }
.pied a { color: var(--texte-attenue); text-decoration: none; }
.pied a:hover { color: var(--texte); }
.pied__bas { margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid var(--bordure); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; }

/* ---------- Apparition douce (visible même sans animation) ---------- */
@media (prefers-reduced-motion: no-preference) {
  .apparition { animation: apparition .7s cubic-bezier(.2, .7, .2, 1) both; }
  .apparition:nth-child(2) { animation-delay: .08s; }
  .apparition:nth-child(3) { animation-delay: .16s; }
  @keyframes apparition { from { transform: translateY(14px); } to { transform: none; } }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } * { transition: none !important; } }

@media (max-width: 720px) {
  .entete .conteneur { flex-wrap: wrap; padding-block: .75rem; }
  .menu { gap: .25rem 1rem; }
}
${SANS_CLASSES}
${extraFamille(d.famille, sombre)}`;
}

/*
 * Le HTML qu'écrit un petit modèle qui ne suit pas le guide. Mesuré le
 * 24/09/2026 avec Qwen3 8B : il a lu la consigne, écrit ses propres classes
 * (« en-tete », « hero », « cartes »), des sections sans conteneur, un
 * formulaire nu. Plutôt que d'espérer qu'il obéisse, la feuille habille aussi
 * ce HTML-là : les éléments eux-mêmes, et les noms de classes les plus courants.
 */
const SANS_CLASSES = `
/* ---------- Écarts courants d'un petit modèle, même avec les classes ---------- */
.entete h1 { font-size: 1.3rem; letter-spacing: -0.02em; }
.entete p { font-size: .9rem; color: var(--texte-attenue); }
.conteneur > h2 { margin-bottom: clamp(1.5rem, 3vw, 2.25rem); }
.conteneur > h2 + p { max-width: 44rem; margin: -.75rem 0 2rem; color: var(--texte-attenue); }
.pied a.bouton, .pied .bouton { color: var(--sur-primaire); }
.carte > div.visuel { aspect-ratio: 16 / 10; }

/* ---------- HTML sans les classes du guide ---------- */
body > header:not(.entete), body > header.en-tete, body > .header {
  position: sticky; top: 0; z-index: 50;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem 2rem;
  padding: .9rem max(var(--marge), calc((100% - var(--largeur)) / 2));
  background: color-mix(in srgb, var(--fond) 85%, transparent);
  backdrop-filter: saturate(1.4) blur(14px); -webkit-backdrop-filter: saturate(1.4) blur(14px);
  border-bottom: 1px solid color-mix(in srgb, var(--bordure) 70%, transparent);
}
body > header:not(.entete) .logo, body > header:not(.entete) > h1, body > header:not(.entete) > div:first-child {
  font-family: var(--police-titre); font-weight: 750; font-size: 1.25rem; letter-spacing: -0.02em; color: var(--texte);
}
header nav ul, nav > ul { display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; list-style: none; padding: 0; }
header nav a { color: var(--texte-attenue); text-decoration: none; font-weight: 500; }
header nav a:hover { color: var(--texte); }
main > section:not(:has(> .conteneur)), body > section:not(:has(> .conteneur)), body > main:not(:has(> section)) {
  padding: var(--section) max(var(--marge), calc((100% - var(--largeur)) / 2));
}
main > section:nth-of-type(even):not(.appel), body > section:nth-of-type(even):not(.appel) {
  background: color-mix(in srgb, var(--primaire) 6%, var(--fond));
}
:is(body > header, body > nav) + :is(section, main > section:first-child), .hero {
  padding-block: clamp(4.5rem, 11vw, 8rem);
}
:is(body > header, body > nav) + section > h1, .hero h1 { max-width: 16ch; }
:is(body > header, body > nav) + section > p, .hero > p { max-width: 38rem; margin-top: 1.25rem; font-size: clamp(1.1rem, 1rem + .4vw, 1.3rem); color: var(--texte-attenue); }
section > h2 { margin-bottom: 1.25rem; }
section > h2 + p { max-width: 44rem; color: var(--texte-attenue); margin-bottom: 2rem; }
section > p + p { margin-top: .75rem; }
section ul:not(.menu):not(.liste-coches):not(nav ul) { padding-left: 1.2rem; display: grid; gap: .4rem; }
section li::marker { color: var(--primaire); }
.cartes, .cards, .grid, .features, .services, .produits, .avis, .testimonials {
  display: grid; gap: var(--ecart); grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
}
.card, .cartes > div, .cards > div, .features > div, .services > div, .produits > div, .avis > div, .testimonials > div, section > article {
  display: flex; flex-direction: column; gap: .75rem;
  padding: clamp(1.4rem, 2.5vw, 2rem);
  color: var(--texte-carte); background: var(--carte);
  border: var(--trait) solid var(--bordure); border-radius: var(--rayon-grand); box-shadow: var(--ombre);
}
blockquote { font-size: 1.08rem; line-height: 1.6; }
.container { width: min(100% - 2 * var(--marge), var(--largeur)); margin-inline: auto; }
.btn, .button, button:not([class]), input[type="submit"], a.cta {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  min-height: 2.9rem; padding: .7rem 1.35rem;
  font: 600 1rem/1 var(--police-texte); text-decoration: none; cursor: pointer;
  color: var(--sur-primaire); background: var(--primaire);
  border: var(--trait) solid var(--primaire); border-radius: var(--rayon); box-shadow: var(--ombre);
}
.btn:hover, .button:hover, button:not([class]):hover, input[type="submit"]:hover, a.cta:hover { color: var(--sur-primaire); background: color-mix(in srgb, var(--primaire) 88%, black); }
form:not(.formulaire) { display: grid; gap: 1rem; max-width: 36rem; }
form:not(.formulaire) label { display: grid; gap: .4rem; font-weight: 600; }
input:not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select {
  width: 100%; padding: .8rem 1rem; font: inherit; color: var(--texte-carte);
  background: var(--carte); border: var(--trait) solid var(--bordure); border-radius: var(--rayon);
}
textarea { min-height: 8rem; resize: vertical; }
body > footer:not(.pied), .footer {
  padding: 3rem max(var(--marge), calc((100% - var(--largeur)) / 2)) 2.5rem;
  background: color-mix(in srgb, var(--primaire) 8%, var(--fond)); color: var(--texte-attenue); font-size: .95rem;
}
body > footer:not(.pied) a { color: var(--texte-attenue); }
`;

function extraFamille(f: Famille, sombre: boolean): string {
  if (f === "verre") {
    return `
/* ---------- Famille « verre » ---------- */
body { background:
  radial-gradient(60rem 40rem at 10% -10%, color-mix(in srgb, var(--primaire) 22%, transparent), transparent 70%),
  radial-gradient(50rem 40rem at 100% 10%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%),
  var(--fond) fixed; }
.carte, .faq details { background: color-mix(in srgb, var(--carte) 70%, transparent); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border-color: color-mix(in srgb, var(--bordure) 60%, transparent); }
`;
  }
  if (f === "vif") {
    return `
/* ---------- Famille « vif » ---------- */
.carte { box-shadow: 6px 6px 0 color-mix(in srgb, var(--texte) 85%, transparent); border-color: var(--texte); }
a.carte:hover, .carte--survol:hover { box-shadow: 9px 9px 0 color-mix(in srgb, var(--texte) 85%, transparent); transform: translate(-2px, -2px); }
.bouton { box-shadow: 3px 3px 0 color-mix(in srgb, var(--texte) 85%, transparent); }
.surtitre { color: var(--sur-accent); background: var(--accent); }
`;
  }
  if (f === "doux") {
    return `
/* ---------- Famille « doux » ---------- */
.carte { border-color: transparent; }
.icone { border-radius: 999px; }
.bouton { border-radius: 999px; }
`;
  }
  if (f === "sombre" || sombre) {
    return `
/* ---------- Famille « sombre » ---------- */
.carte { background: color-mix(in srgb, var(--carte) 92%, white 3%); }
.bouton { box-shadow: 0 0 0 1px color-mix(in srgb, var(--primaire) 40%, transparent), 0 8px 30px -10px color-mix(in srgb, var(--primaire) 70%, transparent); }
.chiffre__valeur, h1 { text-shadow: 0 0 40px color-mix(in srgb, var(--primaire) 35%, transparent); }
`;
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Le guide                                                            */
/* ------------------------------------------------------------------ */

const ICONES: Record<string, string> = {
  coche: '<path d="M5 12l5 5L20 7"/>',
  etoile: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  eclair: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  bouclier: '<path d="M12 3l8 3v6c0 4.4-3.4 8.3-8 9-4.6-.7-8-4.6-8-9V6z"/>',
  horloge: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  coeur: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  message: '<path d="M4 5h16v11H8l-4 4z"/>',
  graphique: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  lieu: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  telephone: '<path d="M5 3h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
};
const svg = (nom: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nom]}</svg>`;

export function guide(d: Design): string {
  const lien = `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${d.polices.url}">\n<link rel="stylesheet" href="design/oxoai.css">`;
  const sections = d.plan?.sections ?? "Hero > Avantages > Comment ça marche > Témoignages > Tarifs > FAQ > Appel à l'action > Pied de page";
  return `# Design du site

Préparé par OxoAI pour ce projet. **Ne réécris pas la feuille de style** : compose les pages avec les classes ci-dessous.

- Type de site reconnu : ${d.produit}
- Style : ${d.style}
- Polices : ${d.polices.titre} (titres) et ${d.polices.texte} (texte)
- Couleurs : primaire ${d.couleurs.primary}, accent ${d.couleurs.accent}, fond ${d.couleurs.bg}, texte ${d.couleurs.fg}
- À retenir : ${d.note}
- À éviter : ${d.eviter || "couleurs criardes, texte gris clair illisible, blocs collés sans espace"}

## Règles

1. Dans le \`<head>\` de CHAQUE page, colle exactement :
\`\`\`html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${lien}
\`\`\`
2. N'écris pas de \`<style>\` ni d'attribut \`style=\`, sauf nécessité réelle. Pas de couleur en dur : si tu en as besoin, \`var(--primaire)\`, \`var(--accent)\`, \`var(--texte-attenue)\`...
3. Chaque section : \`<section class="section">\` puis \`<div class="conteneur">\`. Alterne avec \`section section--attenuee\` pour rythmer la page.
4. Pas d'image inventée (une image qui n'existe pas s'affiche cassée) : utilise \`<div class="visuel"></div>\`, un dégradé aux couleurs du site.
5. Icônes : les SVG ci-dessous, dans \`<span class="icone">\`. Pas d'émoji comme icône.
6. Un vrai contenu, précis, dans la langue de la demande : jamais de « Lorem ipsum » ni de « Titre ici ».
7. Ordre des sections conseillé : ${sections}.${d.plan ? `\n   Bouton principal : ${d.plan.cta}.` : ""}

## Les blocs, prêts à copier

### En-tête
\`\`\`html
<header class="entete">
  <div class="conteneur">
    <a class="logo" href="index.html"><span class="logo__marque">N</span>Nom</a>
    <nav><ul class="menu"><li><a href="#services">Services</a></li><li><a href="#tarifs">Tarifs</a></li><li><a href="#contact">Contact</a></li></ul></nav>
    <a class="bouton" href="#contact">Prendre rendez-vous</a>
  </div>
</header>
\`\`\`

### Héros (texte à gauche, visuel à droite)
\`\`\`html
<section class="heros heros--divise">
  <div class="conteneur">
    <div class="apparition">
      <span class="surtitre">Accroche courte</span>
      <h1>La promesse principale, en une phrase</h1>
      <p class="heros__texte">Deux phrases qui disent pour qui, et ce que l'on y gagne.</p>
      <div class="rangee"><a class="bouton bouton--grand" href="#contact">Action principale</a><a class="bouton bouton--secondaire bouton--grand" href="#services">En savoir plus</a></div>
      <p class="heros__preuve"><span class="etoiles">★★★★★</span> 4,9/5 par 320 clients</p>
    </div>
    <div class="visuel apparition"><span class="visuel__legende">Détail qui rassure</span></div>
  </div>
</section>
\`\`\`
Variante centrée : \`<section class="heros heros--centre">\`, sans colonne visuel.

### Titre de section
\`\`\`html
<div class="entete-section entete-section--centre">
  <span class="surtitre">Services</span>
  <h2>Ce que nous faisons pour vous</h2>
  <p>Une phrase d'introduction.</p>
</div>
\`\`\`

### Cartes d'avantages
\`\`\`html
<div class="grille grille--3">
  <article class="carte carte--survol">
    <span class="icone">${svg("eclair")}</span>
    <h3>Avantage</h3>
    <p>Explication concrète en une ou deux phrases.</p>
  </article>
</div>
\`\`\`

### Étapes
\`\`\`html
<ol class="etapes">
  <li><h3>Premier pas</h3><p>Ce qui se passe.</p></li>
  <li><h3>Deuxième pas</h3><p>Ce qui se passe.</p></li>
  <li><h3>Résultat</h3><p>Ce que l'on obtient.</p></li>
</ol>
\`\`\`

### Chiffres
\`\`\`html
<div class="chiffres centre">
  <div><span class="chiffre__valeur">12 ans</span><span class="chiffre__libelle">d'expérience</span></div>
</div>
\`\`\`

### Témoignage
\`\`\`html
<figure class="carte temoignage">
  <span class="etoiles">★★★★★</span>
  <blockquote>« Ce que la cliente a vraiment apprécié, en une phrase. »</blockquote>
  <figcaption><span class="avatar">CM</span><span><strong>Camille Martin</strong>Cliente depuis 2023</span></figcaption>
</figure>
\`\`\`

### Tarifs
\`\`\`html
<div class="grille grille--3">
  <article class="carte tarif">
    <h3>Formule</h3>
    <p class="tarif__prix">49 € <small>/ mois</small></p>
    <ul class="liste-coches"><li>Ce qui est compris</li><li>Autre chose</li></ul>
    <a class="bouton bouton--secondaire" href="#contact">Choisir</a>
  </article>
  <article class="carte tarif carte--mise-en-avant">
    <span class="badge">Le plus choisi</span>
    <h3>Formule recommandée</h3>
    <p class="tarif__prix">89 € <small>/ mois</small></p>
    <ul class="liste-coches"><li>Tout le reste</li></ul>
    <a class="bouton" href="#contact">Choisir</a>
  </article>
</div>
\`\`\`

### Questions fréquentes
\`\`\`html
<div class="faq">
  <details><summary>La question que l'on vous pose le plus ?</summary><p>La réponse, claire et courte.</p></details>
</div>
\`\`\`

### Appel à l'action
\`\`\`html
<section class="section"><div class="conteneur">
  <div class="appel"><h2>Prêt à commencer ?</h2><p>Une phrase qui lève le dernier doute.</p><a class="bouton bouton--grand" href="#contact">Action principale</a></div>
</div></section>
\`\`\`

### Formulaire de contact
\`\`\`html
<form class="formulaire carte">
  <div class="champ"><label for="nom">Nom</label><input id="nom" name="nom" autocomplete="name" required></div>
  <div class="champ"><label for="courriel">Courriel</label><input id="courriel" name="courriel" type="email" autocomplete="email" required></div>
  <div class="champ"><label for="message">Message</label><textarea id="message" name="message"></textarea></div>
  <button class="bouton" type="submit">Envoyer</button>
</form>
\`\`\`

### Pied de page
\`\`\`html
<footer class="pied">
  <div class="conteneur">
    <div class="pied__colonnes">
      <div><a class="logo" href="index.html"><span class="logo__marque">N</span>Nom</a><p>Une phrase sur l'entreprise.</p></div>
      <div><h4>Liens</h4><ul><li><a href="#services">Services</a></li><li><a href="#contact">Contact</a></li></ul></div>
      <div><h4>Contact</h4><ul><li>01 23 45 67 89</li><li>contact@exemple.fr</li></ul></div>
    </div>
    <div class="pied__bas"><span>© 2026 Nom</span><a href="#">Mentions légales</a></div>
  </div>
</footer>
\`\`\`

## Icônes disponibles

${Object.keys(ICONES)
  .map((n) => `- ${n} : \`<span class="icone">${svg(n)}</span>\``)
  .join("\n")}

## Classes utiles

\`bouton\`, \`bouton--secondaire\`, \`bouton--accent\`, \`bouton--grand\`, \`carte\`, \`carte--survol\`, \`carte--mise-en-avant\`, \`grille\`, \`grille--2\`, \`grille--3\`, \`pile\`, \`rangee\`, \`centre\`, \`texte-attenue\`, \`surtitre\`, \`badge\`, \`visuel\`, \`section--attenuee\`, \`section--primaire\`, \`apparition\`.
`;
}

/* ------------------------------------------------------------------ */
/* Pour OxoAI Code                                                     */
/* ------------------------------------------------------------------ */

/**
 * Prépare le design dans le dossier du projet, s'il n'y en a pas déjà un, et
 * rend la consigne à joindre à la demande. Un design déjà là n'est jamais
 * écrasé : la personne a pu le retoucher, ou un premier site l'a fixé.
 */
/**
 * Règles de comportement d'une application, tirées de ce que Qwen3 8B a raté
 * sur l'ERP du 26/09/2026. Le contrôle automatique (controleCode.ts) vérifie
 * ensuite, dans un vrai navigateur, la page d'ouverture, la lisibilité et les
 * formulaires.
 */
const CONSIGNE_APPLICATION = [
  "Application : règles de qualité (un programme les vérifiera dans un vrai navigateur à la fin) :",
  '6. En haut, <header class="entete"> avec le nom de l\'application et une <nav> de <button> pour passer d\'une partie à l\'autre. La première partie est affichée dès l\'ouverture : jamais de page vide au chargement.',
  "7. Chaque partie : un <form> avec des <label> et des champs, puis la liste dans un <table> (<thead>, <tbody>). Une liste vide affiche une phrase (« Aucun client pour l'instant »).",
  "8. Après chaque ajout, modification ou suppression : enregistre (localStorage), puis mets à jour TOUT de suite toutes les listes ET tous les menus déroulants qui en dépendent (une fonction rafraichir() appelée après chaque changement). Jamais besoin de recharger la page.",
  '9. Montants en euros : valeur.toLocaleString("fr-FR", { style: "currency", currency: "EUR" }) ; dates : toLocaleDateString("fr-FR"). Demande confirmation avant une suppression.',
  "10. Chaque fonction appelée existe et fait vraiment son travail : pas de fonction vide, pas de « TODO », pas de faute de frappe. À la fin, relis chaque fichier en entier.",
].join("\n");

export async function preparerDesign(
  dossier: string,
  demande: string,
  qui: string,
  options: { application?: boolean } = {},
): Promise<{ consigne: string; cree: boolean; design?: Design }> {
  const dossierDesign = join(dossier, "design");
  const feuille = join(dossierDesign, "oxoai.css");
  /*
   * Seulement pour un site qui commence. Posé dans un projet qui a déjà son
   * code, le design changeait ce que la personne n'avait pas demandé : pour
   * « corrige le bouton de ma page contact » dans un site existant, la
   * consigne interdisait ses <style>, et `corrigerPages` ajoutait oxoai.css
   * en dernier à toutes ses pages, par-dessus sa propre feuille. Reste un cas :
   * une demande de code ordinaire (« ajoute une interface User ») pose encore un
   * dossier design/ dans le projet (celle-là n'est pas réglée ici : voir
   * docs-a-integrer/corrections.md).
   */
  if (!existsSync(feuille) && projetDejaCommence(dossier)) return { consigne: "", cree: false };
  const design = existsSync(feuille) ? undefined : await choisirDesign(demande, qui);
  const police = design?.polices.url ?? policeDuProjet(dossierDesign);
  /*
   * Les lignes indispensables sont dans la consigne même : un petit modèle ne
   * va pas toujours lire un fichier qu'on lui indique (mesuré : Qwen3 8B n'a
   * pas ouvert DESIGN.md). Le reste est dans le guide, pour qui le lit.
   */
  const consigne = [
    "",
    "",
    "---",
    "Design : ce projet a un design professionnel prêt à l'emploi (design/oxoai.css, guide complet dans design/DESIGN.md). Règles :",
    "1. Dans le <head> de chaque page, mets exactement ces lignes, chemin relatif, sans barre au début :",
    ...(police ? [`   <link rel="stylesheet" href="${police}">`] : []),
    '   <link rel="stylesheet" href="design/oxoai.css">',
    "2. N'écris aucun <style> ni attribut style : la feuille fait déjà tout le design.",
    '3. Structure : <header class="entete"><div class="conteneur">…</div></header>, puis des <section class="section"><div class="conteneur">…</div></section>,',
    '   le haut de page en <section class="heros heros--divise">, des cartes <article class="carte"> dans <div class="grille grille--3">,',
    '   les boutons en <a class="bouton">, le bas en <footer class="pied">. Les exemples complets sont dans design/DESIGN.md.',
    "4. Pas d'image inventée : à la place, <div class=\"visuel\"></div>. Pas d'émoji comme icône.",
    "5. Un vrai contenu, précis, dans la langue de la demande.",
    ...(options.application ? [CONSIGNE_APPLICATION] : []),
  ].join("\n");
  if (!design) return { consigne, cree: false };
  mkdirSync(dossierDesign, { recursive: true });
  writeFileSync(feuille, feuilleDeStyle(design));
  writeFileSync(join(dossierDesign, "DESIGN.md"), guide(design));
  return { consigne, cree: true, design };
}

/*
 * Fichiers qui disent qu'un site existe déjà : pages et feuilles de style, ou
 * composants d'un cadriciel. Un projet sans rien de tout cela (dossier neuf,
 * ou scripts d'une autre nature) reçoit le design comme avant.
 */
const CODE = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro|php)$/i;

/** Le dossier a-t-il déjà ses pages ou ses styles (hors design/, node_modules et fichiers cachés), sur trois niveaux ? */
export function projetDejaCommence(dossier: string): boolean {
  const parcourir = (d: string, profondeur: number): boolean => {
    let entrees: import("node:fs").Dirent[] = [];
    try {
      entrees = readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entrees) {
      if (/^(node_modules|\.)/.test(e.name) || (d === dossier && e.name === "design")) continue;
      if (e.isFile() && CODE.test(e.name)) return true;
      if (e.isDirectory() && profondeur > 0 && parcourir(join(d, e.name), profondeur - 1)) return true;
    }
    return false;
  };
  return parcourir(dossier, 2);
}

/** L'adresse des polices d'un design déjà posé, lue dans son guide. */
function policeDuProjet(dossierDesign: string): string | undefined {
  try {
    return /href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/.exec(readFileSync(join(dossierDesign, "DESIGN.md"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Repasse derrière le modèle, une fois qu'il a fini (index.ts, flux de Code) :
 * dans chaque page HTML du projet, le lien vers la feuille est remis (chemin
 * relatif : « /design/… » ne marche pas en ouvrant le fichier), les polices
 * ajoutées si elles manquent, et la feuille placée en dernier dans le <head>,
 * pour qu'elle l'emporte sur un <style> écrit par le modèle. Le contenu n'est
 * jamais touché. Rend le nombre de pages corrigées.
 */
export function corrigerPages(dossier: string): number {
  const feuille = join(dossier, "design", "oxoai.css");
  if (!existsSync(feuille)) return 0;
  const police = policeDuProjet(join(dossier, "design"));
  let corrigees = 0;
  const parcourir = (d: string, profondeur: number) => {
    let entrees: import("node:fs").Dirent[] = [];
    try {
      entrees = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entrees) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (profondeur > 0 && !/^(node_modules|\.|design$)/.test(e.name)) parcourir(p, profondeur - 1);
        continue;
      }
      if (!/\.html?$/i.test(e.name)) continue;
      let html: string;
      try {
        html = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      if (!/<head[\s>]/i.test(html) || !/<\/head>/i.test(html)) continue;
      const chemin = relative(dirname(p), feuille).split("\\").join("/");
      let neuf = html
        // Tout lien existant vers la feuille est retiré : on la remet au bon endroit, avec le bon chemin.
        .replace(/[ \t]*<link[^>]+href=["'][^"']*design\/oxoai\.css["'][^>]*>\s*\n?/gi, "")
        .replace(/(<body[^>]*class=["'][^"']*)\bvisuel\b/i, "$1");
      const ajouts: string[] = [];
      if (police && !/\/\/fonts\.googleapis\.com\//.test(neuf)) {
        ajouts.push('<link rel="preconnect" href="https://fonts.googleapis.com">', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', `<link rel="stylesheet" href="${police}">`);
      }
      if (!/<meta[^>]+name=["']viewport/i.test(neuf)) ajouts.unshift('<meta name="viewport" content="width=device-width, initial-scale=1">');
      ajouts.push(`<link rel="stylesheet" href="${chemin}">`);
      neuf = neuf.replace(/<\/head>/i, `  ${ajouts.join("\n  ")}\n</head>`);
      if (neuf !== html) {
        writeFileSync(p, neuf);
        corrigees += 1;
      }
    }
  };
  parcourir(dossier, 2);
  return corrigees;
}
