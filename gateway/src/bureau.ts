import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve as normaliser, sep } from "node:path";
import { interpreteur, bureautiquePresente } from "./atelier.ts";
import { workspace } from "./mcp.ts";
import { estProtege } from "./zonesProtegees.ts";

/**
 * Outils bureautiques de Cowork.
 *
 * L'atelier (atelier.ts) pose les bibliothèques ; ce module les met entre les
 * mains de l'agent. Sans lui, Cowork ne dispose que du système de fichiers :
 * il sait écrire du texte, pas produire un .docx.
 *
 * Deux principes gouvernent ce fichier.
 *
 * 1. Le modèle fournit des **données**, jamais du code. Les scripts Python sont
 *    des constantes de ce module ; rien n'y est interpolé. Les paramètres
 *    voyagent en JSON sur l'entrée standard, pas en ligne de commande — un
 *    argument peut fuiter dans la liste des processus, et une interpolation
 *    ferait de chaque titre de document une injection possible.
 *
 * 2. Rien ne s'écrit hors de l'espace de travail. C'est la même garantie que
 *    celle du serveur de fichiers : un outil capable d'écrire ailleurs serait
 *    une porte dérobée, ouverte par le premier document piégé que l'agent
 *    aurait lu. Chaque chemin est donc résolu par `realpath` — liens
 *    symboliques compris — puis comparé à la racine réelle de l'espace.
 *
 * Le motif d'exposition reprend celui de computer.ts : `toolsForModel()` et
 * `callTool()`, fusionnés dans la boucle de conversation par chat.ts.
 */

/* ------------------------------ disponibilité --------------------------------- */

/**
 * Proposer au modèle des outils qui échoueront est pire que ne rien proposer :
 * il s'acharne dessus au lieu de chercher une autre voie. La liste est donc
 * vide tant que l'atelier n'est pas installé.
 *
 * Le test se limite à la présence, sur le disque, des modules que le script
 * importe (voir `bureautiquePresente`, atelier.ts). Un diagnostic
 * complet lance pip et lit des dizaines de manifestes : hors de question de le
 * refaire à chaque requête. Le résultat est gardé quelques secondes — assez
 * pour ne rien coûter, trop peu pour masquer longtemps une installation qui
 * vient de se terminer.
 */
const PRET_TTL = 30_000;
let pretCache: { at: number; value: boolean } | null = null;

/** À appeler après une préparation : l'atelier vient peut-être d'apparaître. */
export function oublierAtelier(): void {
  pretCache = null;
}

/*
 * Contrôle synchrone : `toolsForModel()` est appelé au montage de chaque
 * conversation, là où computer.ts répond aussi sans attendre. Un `existsSync`
 * mis en cache coûte moins qu'une promesse à propager dans tout chat.ts.
 */
function atelierPret(): boolean {
  if (pretCache && Date.now() - pretCache.at < PRET_TTL) return pretCache.value;
  // Les modules eux-mêmes, pas le seul venv : la dictée peut l'avoir créé seule.
  const value = bureautiquePresente();
  pretCache = { at: Date.now(), value };
  return value;
}

/* -------------------------------- périmètre ----------------------------------- */

/** Un chemin est-il à l'intérieur d'une racine, ou la racine elle-même ? */
function sousLaRacine(chemin: string, racine: string): boolean {
  return chemin === racine || chemin.startsWith(racine.endsWith(sep) ? racine : racine + sep);
}

type Verdict = { ok: true; chemin: string } | { ok: false; erreur: string };

/**
 * Résout un chemin reçu du modèle et refuse tout ce qui sort de l'espace.
 *
 * L'ordre compte. On normalise d'abord (`..` mangés), on résout ensuite le
 * dossier parent par `realpath` — c'est lui qui démasque un lien symbolique
 * posé dans l'espace et pointant ailleurs —, puis, si le fichier existe déjà,
 * on vérifie aussi sa propre cible : écrire « dans » un lien, c'est écrire au
 * bout du lien.
 *
 * @param extension Extension imposée, ajoutée si elle manque. `null` pour la
 *                  lecture, où c'est l'extension qui choisit le lecteur.
 */
async function cheminSur(brut: unknown, extension: string | null): Promise<Verdict> {
  if (typeof brut !== "string" || !brut.trim()) {
    return { ok: false, erreur: "Indique « chemin », le chemin complet du fichier à produire." };
  }

  let racine: string;
  try {
    racine = await realpath(workspace());
  } catch {
    return {
      ok: false,
      erreur: `L'espace de travail ${workspace()} est introuvable : signale-le à l'utilisateur.`,
    };
  }

  // Un chemin relatif est compté depuis l'espace de travail plutôt que refusé :
  // la vérification qui suit reste la même, et le modèle perd moins de tours.
  const vise = isAbsolute(brut) ? normaliser(brut) : normaliser(racine, brut);
  const cible = extension && extname(vise).toLowerCase() !== extension ? vise + extension : vise;

  let parent: string;
  try {
    parent = await realpath(dirname(cible));
  } catch {
    return {
      ok: false,
      erreur: `Le dossier ${dirname(cible)} n'existe pas : crée-le d'abord ou choisis un dossier existant de ${racine}.`,
    };
  }

  if (!sousLaRacine(parent, racine)) {
    return {
      ok: false,
      erreur: `Chemin hors de l'espace de travail : écris ce fichier sous ${racine}.`,
    };
  }

  const complet = join(parent, basename(cible));

  try {
    // Le fichier existe : c'est peut-être un lien qui sort de l'espace.
    const reel = await realpath(complet);
    if (!sousLaRacine(reel, racine)) {
      return {
        ok: false,
        erreur: `Ce fichier est un lien qui pointe hors de l'espace de travail : choisis un autre nom sous ${racine}.`,
      };
    }
    return protege(reel) ? { ok: false, erreur: REFUS_ZONE } : { ok: true, chemin: reel };
  } catch {
    // Il n'existe pas encore : c'est le cas normal d'une création.
    return protege(complet) ? { ok: false, erreur: REFUS_ZONE } : { ok: true, chemin: complet };
  }
}

/*
 * Les zones protégées (zonesProtegees.ts, revue du 25/09/2026) : avec « Tout
 * mon poste », l'espace est le dossier personnel, et un document produit ou lu
 * dans `~/.oxoai/data` ou `~/.ssh` n'y a rien à faire.
 */
const REFUS_ZONE =
  "Cet emplacement est protégé (données de l'instance, clés, réglages d'autres logiciels) : choisis un dossier de documents.";
const protege = (chemin: string): string | null => (estProtege(chemin) ? chemin : null);

/* --------------------------------- scripts ------------------------------------ */

/**
 * Script unique, figé. Il lit un objet JSON sur l'entrée standard, exécute
 * l'action demandée et écrit un objet JSON sur la sortie standard. Aucune
 * valeur venue du modèle n'entre dans le code : elles ne sont que des données
 * désérialisées par `json.load`.
 */
const SCRIPT_PYTHON = String.raw`
import json
import re
import sys

LIMITE = 20000


def texte(valeur):
    return "" if valeur is None else str(valeur)


def creer_document(demande):
    from docx import Document

    document = Document()
    titre = demande.get("titre")
    if titre:
        document.add_heading(str(titre), level=1)

    for paragraphe in demande.get("paragraphes") or []:
        document.add_paragraph(texte(paragraphe))

    for tableau in demande.get("tableaux") or []:
        if not isinstance(tableau, dict):
            continue
        lignes = [l for l in (tableau.get("lignes") or []) if isinstance(l, list)]
        if not lignes:
            continue
        sous_titre = tableau.get("titre")
        if sous_titre:
            document.add_heading(str(sous_titre), level=2)
        colonnes = max(len(l) for l in lignes)
        grille = document.add_table(rows=len(lignes), cols=colonnes)
        try:
            grille.style = "Table Grid"
        except Exception:
            pass
        for i, ligne in enumerate(lignes):
            for j, cellule in enumerate(ligne):
                grille.cell(i, j).text = texte(cellule)
        document.add_paragraph("")

    document.save(demande["chemin"])
    return "Document Word écrit."


def creer_classeur(demande):
    from openpyxl import Workbook

    feuilles = [f for f in (demande.get("feuilles") or []) if isinstance(f, dict)]
    if not feuilles:
        raise ValueError("aucune feuille fournie")

    classeur = Workbook()
    classeur.remove(classeur.active)

    formules = 0
    for feuille in feuilles:
        # Excel interdit ces caracteres dans un nom d'onglet et le limite a 31.
        nom = re.sub(r"[\\/*?:\[\]]", "-", str(feuille.get("nom") or "Feuille"))[:31].strip()
        onglet = classeur.create_sheet(title=nom or "Feuille")
        for ligne in feuille.get("lignes") or []:
            if not isinstance(ligne, list):
                continue
            valeurs = []
            for cellule in ligne:
                if cellule is None or isinstance(cellule, (bool, int, float)):
                    valeurs.append(cellule)
                    continue
                brut = str(cellule)
                # openpyxl marque d'office comme formule toute chaine ouvrant
                # sur « = » : c'est exactement la convention annoncee au modele.
                if len(brut) > 1 and brut.startswith("="):
                    formules += 1
                valeurs.append(brut)
            onglet.append(valeurs)

    classeur.save(demande["chemin"])
    return "Classeur écrit : %d feuille(s), %d formule(s)." % (len(classeur.sheetnames), formules)


def creer_presentation(demande):
    from pptx import Presentation

    diapositives = [d for d in (demande.get("diapositives") or []) if isinstance(d, dict)]
    if not diapositives:
        raise ValueError("aucune diapositive fournie")

    presentation = Presentation()
    # Mise en page 1 du modele par defaut : un titre et une liste a puces.
    mise_en_page = presentation.slide_layouts[1]

    for diapositive in diapositives:
        vue = presentation.slides.add_slide(mise_en_page)
        vue.shapes.title.text = str(diapositive.get("titre") or "")
        points = [texte(p) for p in (diapositive.get("points") or [])]
        corps = vue.placeholders[1].text_frame
        corps.text = points[0] if points else ""
        for point in points[1:]:
            paragraphe = corps.add_paragraph()
            paragraphe.text = point
            paragraphe.level = 0

    presentation.save(demande["chemin"])
    return "Présentation écrite : %d diapositive(s)." % len(diapositives)


def creer_pdf(demande):
    from xml.sax.saxutils import escape

    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    styles = getSampleStyleSheet()
    flux = []

    titre = str(demande.get("titre") or "")
    if titre:
        flux.append(Paragraph(escape(titre), styles["Title"]))
        flux.append(Spacer(1, 6 * mm))

    for paragraphe in demande.get("paragraphes") or []:
        # reportlab lit un balisage dans le texte : sans echappement, un « < »
        # venu d'un document quelconque casserait la mise en page.
        corps = escape(texte(paragraphe)).replace("\n", "<br/>")
        flux.append(Paragraph(corps or "&nbsp;", styles["BodyText"]))
        flux.append(Spacer(1, 3 * mm))

    if not flux:
        raise ValueError("aucun contenu fourni")

    page = SimpleDocTemplate(
        demande["chemin"],
        pagesize=A4,
        title=titre or None,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
    )
    page.build(flux)
    return "PDF écrit."


def lire_docx(chemin):
    from docx import Document

    document = Document(chemin)
    morceaux = [p.text for p in document.paragraphs]
    for grille in document.tables:
        for ligne in grille.rows:
            morceaux.append("\t".join(c.text for c in ligne.cells))
    return [m for m in morceaux if m.strip()]


def lire_xlsx(chemin):
    from openpyxl import load_workbook

    # data_only=False : on montre la formule. Sans tableur pour recalculer, la
    # valeur en cache serait vide, et la formule est ce qui renseigne le modele.
    classeur = load_workbook(chemin, data_only=False)
    morceaux = []
    for onglet in classeur.worksheets:
        morceaux.append("--- Feuille %s ---" % onglet.title)
        for ligne in onglet.iter_rows(values_only=True):
            if all(v is None for v in ligne):
                continue
            morceaux.append("\t".join(texte(v) for v in ligne))
    return morceaux


def lire_pptx(chemin):
    from pptx import Presentation

    morceaux = []
    for rang, diapositive in enumerate(Presentation(chemin).slides, 1):
        morceaux.append("--- Diapositive %d ---" % rang)
        for forme in diapositive.shapes:
            if forme.has_text_frame and forme.text_frame.text.strip():
                morceaux.append(forme.text_frame.text)
    return morceaux


def lire_pdf(chemin):
    import pdfplumber

    morceaux = []
    with pdfplumber.open(chemin) as document:
        for rang, page in enumerate(document.pages, 1):
            morceaux.append("--- Page %d ---" % rang)
            morceaux.append(page.extract_text() or "")
    return morceaux


LECTEURS = {".docx": lire_docx, ".xlsx": lire_xlsx, ".pptx": lire_pptx, ".pdf": lire_pdf}


def lire(demande):
    lecteur = LECTEURS.get(demande.get("extension"))
    if lecteur is None:
        raise ValueError("format non pris en charge")
    return "\n".join(lecteur(demande["chemin"])).strip()


ACTIONS = {
    "document": creer_document,
    "classeur": creer_classeur,
    "presentation": creer_presentation,
    "pdf": creer_pdf,
    "lire": lire,
}


def principal():
    # En UTF-8 explicitement : sous Windows, Python lit sinon l'entrée dans la page de code ANSI, et les accents sortaient abîmés (audit du 27/09/2026).
    demande = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    action = demande.get("action")
    fonction = ACTIONS.get(action)
    if fonction is None:
        return {"ok": False, "erreur": "action inconnue"}

    resultat = fonction(demande)
    if action == "lire":
        return {"ok": True, "texte": resultat[:LIMITE], "tronque": len(resultat) > LIMITE}
    return {"ok": True, "message": resultat}


try:
    sortie = principal()
except Exception as err:
    sortie = {"ok": False, "erreur": "%s : %s" % (type(err).__name__, err)}

sys.stdout.write("\n@@OXOAI@@" + json.dumps(sortie))
`;

/* -------------------------------- exécution ----------------------------------- */

/**
 * Une création tient en quelques secondes ; l'import de pdfplumber sur un
 * disque froid peut en demander une dizaine. Deux minutes laissent la marge
 * sans jamais bloquer une conversation indéfiniment.
 */
const DELAI = 120_000;

interface Reponse {
  ok: boolean;
  message?: string;
  texte?: string;
  tronque?: boolean;
  erreur?: string;
}

/**
 * Les bibliothèques PDF écrivent parfois des avertissements sur la sortie
 * standard. Le marqueur isole la réponse du bruit : sans lui, un avertissement
 * suffirait à faire échouer une génération réussie.
 */
const MARQUEUR = "@@OXOAI@@";

async function lancer(charge: Record<string, unknown>): Promise<Reponse> {
  const travail = await mkdtemp(join(tmpdir(), "oxoai-bureau-"));
  const script = join(travail, "bureau.py");

  try {
    await writeFile(script, SCRIPT_PYTHON, "utf8");

    const stdout = await new Promise<string>((resoudre, rejeter) => {
      const enfant = execFile(
        interpreteur(),
        [script],
        { cwd: travail, timeout: DELAI, maxBuffer: 8 << 20 },
        (err, sortie, erreur) => {
          if (err) return rejeter(new Error(String(erreur).trim() || err.message));
          resoudre(String(sortie));
        },
      );
      // Si l'interpréteur meurt avant d'avoir lu, EPIPE ne doit pas faire
      // tomber la passerelle : l'erreur utile est déjà dans le rappel.
      enfant.stdin?.on("error", () => {});
      enfant.stdin?.end(JSON.stringify(charge), "utf8");
    });

    const rang = stdout.lastIndexOf(MARQUEUR);
    if (rang < 0) throw new Error(stdout.trim().slice(-300) || "réponse vide");
    return JSON.parse(stdout.slice(rang + MARQUEUR.length)) as Reponse;
  } finally {
    await rm(travail, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------- outils exposés au modèle -------------------------- */

const CHEMIN = {
  type: "string",
  description:
    "Chemin du fichier à produire, dans l'espace de travail. L'extension est ajoutée si elle manque.",
};

const EXTENSIONS: Record<string, string> = {
  creer_document: ".docx",
  creer_classeur: ".xlsx",
  creer_presentation: ".pptx",
  creer_pdf: ".pdf",
};

/** Nom d'outil vers action du script. */
const ACTIONS: Record<string, string> = {
  creer_document: "document",
  creer_classeur: "classeur",
  creer_presentation: "presentation",
  creer_pdf: "pdf",
  lire_document: "lire",
};

/** Formats que sait relire `bureau__lire_document`. */
const LISIBLES = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);

export function toolsForModel(): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  if (!atelierPret()) return [];

  const fn = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
  ) => ({
    type: "function" as const,
    function: {
      name: `bureau__${name}`,
      description,
      parameters: { type: "object", properties, required },
    },
  });

  return [
    fn(
      "creer_document",
      "Crée un document Word (.docx) : un titre, des paragraphes, et des tableaux si besoin. " +
        "À préférer à l'écriture d'un fichier texte dès que le résultat doit être un document.",
      {
        chemin: CHEMIN,
        titre: { type: "string", description: "Titre placé en tête du document." },
        paragraphes: {
          type: "array",
          items: { type: "string" },
          description: "Un élément par paragraphe, dans l'ordre.",
        },
        tableaux: {
          type: "array",
          description: "Tableaux ajoutés après les paragraphes.",
          items: {
            type: "object",
            properties: {
              titre: { type: "string" },
              lignes: {
                type: "array",
                description: "Lignes du tableau ; la première sert d'en-tête.",
                items: { type: "array", items: { type: "string" } },
              },
            },
            required: ["lignes"],
          },
        },
      },
      ["chemin", "paragraphes"],
    ),
    fn(
      "creer_classeur",
      "Crée un classeur Excel (.xlsx). Une cellule qui commence par « = » est écrite comme une " +
        "formule, que le tableur calcule à l'ouverture. Les noms de fonctions s'écrivent en " +
        "anglais, comme l'exige le format : « =SUM(B2:B10) », « =AVERAGE(C2:C10) ». Excel les " +
        "affichera traduits.",
      {
        chemin: CHEMIN,
        feuilles: {
          type: "array",
          description: "Une entrée par onglet.",
          items: {
            type: "object",
            properties: {
              nom: { type: "string", description: "Nom de l'onglet." },
              lignes: {
                type: "array",
                // Vu le 23/09/2026 : trois lignes sans en-tête, puis « =SUM(B2:B4) », soit un total faux.
                description:
                  "Lignes de l'onglet ; les nombres restent des nombres. La première ligne donnée est " +
                  "la ligne 1 du classeur : mets une ligne d'en-tête en premier, et vérifie que les " +
                  "plages de tes formules visent bien les lignes des données.",
                items: { type: "array", items: { type: ["string", "number"] } },
              },
            },
            required: ["nom", "lignes"],
          },
        },
      },
      ["chemin", "feuilles"],
    ),
    fn(
      "creer_presentation",
      "Crée une présentation PowerPoint (.pptx) : une diapositive par entrée, avec un titre et " +
        "des puces.",
      {
        chemin: CHEMIN,
        diapositives: {
          type: "array",
          items: {
            type: "object",
            properties: {
              titre: { type: "string" },
              points: {
                type: "array",
                items: { type: "string" },
                description: "Puces de la diapositive.",
              },
            },
            required: ["titre", "points"],
          },
        },
      },
      ["chemin", "diapositives"],
    ),
    fn(
      "creer_pdf",
      "Crée un document PDF : un titre et des paragraphes, mis en page sur du A4.",
      {
        chemin: CHEMIN,
        titre: { type: "string" },
        paragraphes: { type: "array", items: { type: "string" } },
      },
      ["chemin", "paragraphes"],
    ),
    fn(
      "lire_document",
      "Extrait le texte d'un fichier .docx, .xlsx, .pptx ou .pdf. C'est le seul moyen de lire " +
        "ces formats : les outils de fichiers n'en renverraient que des octets illisibles.",
      { chemin: { type: "string", description: "Chemin du fichier à lire." } },
      ["chemin"],
    ),
  ];
}

export function hasTools(): boolean {
  return atelierPret();
}

/** Réponse d'échec, formulée pour que le modèle sache quoi changer. */
const refus = (erreur: string) => ({ ok: false, content: erreur });

/**
 * Contenu attendu par chaque outil de création.
 *
 * Vérifié ici plutôt qu'en Python : une `ValueError` remontée telle quelle
 * apprend au modèle qu'il s'est trompé, pas ce qu'il doit écrire à la place.
 */
const CONTENU: Record<string, { champ: string; attendu: string }> = {
  creer_document: { champ: "paragraphes", attendu: "un tableau de chaînes, une par paragraphe" },
  creer_classeur: {
    champ: "feuilles",
    attendu: "un tableau d'objets { nom, lignes }, au moins un onglet",
  },
  creer_presentation: {
    champ: "diapositives",
    attendu: "un tableau d'objets { titre, points }, au moins une diapositive",
  },
  creer_pdf: { champ: "paragraphes", attendu: "un tableau de chaînes, une par paragraphe" },
};

/**
 * Exécute un outil « bureau__… » appelé par le modèle.
 *
 * Rien de ce qui arrive ici n'est cru sur parole : le chemin est revérifié
 * même si le schéma le décrivait, et les tableaux sont ramenés à ce que le
 * script sait lire.
 */
export async function callTool(
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; content: string }> {
  const nom = qualifiedName.replace(/^bureau__/, "");
  const action = ACTIONS[nom];
  if (!action) return refus(`Outil inconnu : ${qualifiedName}.`);

  if (!atelierPret()) {
    return refus(
      "L'atelier bureautique n'est pas installé sur cette machine : demande à l'utilisateur " +
        "de le préparer depuis les paramètres de Cowork.",
    );
  }

  const exige = CONTENU[nom];
  if (exige) {
    const fourni = args[exige.champ];
    const garni = Array.isArray(fourni) && fourni.length > 0;
    // Un document peut n'être fait que de tableaux : ce n'est pas une erreur.
    const secours =
      nom === "creer_document" && Array.isArray(args.tableaux) && args.tableaux.length > 0;
    if (!garni && !secours) return refus(`Renseigne « ${exige.champ} » : ${exige.attendu}.`);
  }

  const verdict = await cheminSur(args.chemin, EXTENSIONS[nom] ?? null);
  if (!verdict.ok) return refus(verdict.erreur);

  const charge: Record<string, unknown> = { action, chemin: verdict.chemin };

  if (nom === "lire_document") {
    const extension = extname(verdict.chemin).toLowerCase();
    if (!LISIBLES.has(extension)) {
      return refus(
        "Ce format ne se lit pas ici : donne un fichier .docx, .xlsx, .pptx ou .pdf, " +
          "et les autres avec les outils de fichiers.",
      );
    }
    if (!existsSync(verdict.chemin)) {
      return refus(
        "Ce fichier n'existe pas : vérifie son chemin en listant le dossier avant de le lire.",
      );
    }
    charge.extension = extension;
  } else if (nom === "creer_document") {
    charge.titre = args.titre;
    charge.paragraphes = args.paragraphes;
    charge.tableaux = args.tableaux;
  } else if (nom === "creer_classeur") {
    charge.feuilles = args.feuilles;
  } else if (nom === "creer_presentation") {
    charge.diapositives = args.diapositives;
  } else {
    charge.titre = args.titre;
    charge.paragraphes = args.paragraphes;
  }

  let reponse: Reponse;
  try {
    reponse = await lancer(charge);
  } catch (err) {
    // L'atelier a pu être effacé entre-temps : le cache ne vaut plus rien.
    oublierAtelier();
    return refus(
      "L'atelier bureautique n'a pas répondu ; réessaie une fois, puis préviens l'utilisateur. " +
        `Détail : ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
    );
  }

  if (!reponse.ok) {
    return refus(
      `Le fichier n'a pas pu être produit : vérifie tes paramètres et recommence. Détail : ${
        reponse.erreur ?? "cause inconnue"
      }`,
    );
  }

  if (nom === "lire_document") {
    const texte = reponse.texte ?? "";
    if (!texte) return { ok: true, content: "Ce fichier ne contient aucun texte extractible." };
    return {
      ok: true,
      content: reponse.tronque ? `${texte}\n\n[Texte tronqué à 20 000 caractères.]` : texte,
    };
  }

  return { ok: true, content: `${reponse.message ?? "Fichier écrit."} Chemin : ${verdict.chemin}` };
}
