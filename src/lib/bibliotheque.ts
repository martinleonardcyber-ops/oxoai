import { apiFetch } from "./endpoint";
import { DOCUMENT_MAX, EXTRACTION_MAX, LIBELLE_DOCUMENT_MAX, envoyerEnFlux } from "./televersement";
import { t, tf, taille } from "@/lib/i18n";

/**
 * Bibliothèque de l'équipe (gateway/src/bibliotheque.ts). L'instance garde
 * les documents, chiffrés, et ne rend à chacun que ce qu'il a le droit de voir.
 */

export type Visibilite = "prive" | "groupes" | "organisation";
export type Couleur = "vert" | "bleu" | "orange" | "rouge";

export interface ElementBibliotheque {
  id: string;
  type: "dossier" | "document";
  nom: string;
  parentId: string | null;
  ownerId: string;
  visibilite: Visibilite;
  groupes: string[];
  emoji?: string;
  couleur?: Couleur;
  taille?: number;
  typeMime?: string;
  aTexte?: boolean;
  favori: boolean;
  estProprietaire: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Listage {
  dossier: { id: string; nom: string; estProprietaire: boolean; visibilite: Visibilite } | null;
  chemin: { id: string; nom: string }[];
  elements: ElementBibliotheque[];
}

export const TAILLE_MAX = DOCUMENT_MAX;
export { LIBELLE_DOCUMENT_MAX, EXTRACTION_MAX };

async function lire<T>(res: Response): Promise<T> {
  const corps = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  return corps;
}

const poster = (chemin: string, corps: unknown) =>
  apiFetch(chemin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });

export async function listerBibliotheque(options: { vue?: string; dossier?: string | null; q?: string }): Promise<Listage> {
  const p = new URLSearchParams();
  if (options.vue) p.set("vue", options.vue);
  if (options.dossier) p.set("dossier", options.dossier);
  if (options.q?.trim()) p.set("q", options.q.trim());
  return lire(await apiFetch(`/oxoai/bibliotheque?${p}`));
}

export async function creerDossier(d: {
  nom: string;
  parentId: string | null;
  visibilite: Visibilite;
  groupes: string[];
  emoji?: string;
  couleur?: Couleur;
}): Promise<ElementBibliotheque> {
  return (await lire<{ element: ElementBibliotheque }>(await poster("/oxoai/bibliotheque/dossiers", d))).element;
}

const TEXTES = ["txt", "md", "csv", "json", "html", "xml"];

/**
 * Texte d'un document, extrait ici, sur le poste : c'est ce qui le rend
 * cherchable, et lisible par les agents. Un PDF scanné n'en a pas : il est
 * gardé quand même, sans texte.
 */
async function texteDe(fichier: File): Promise<string | undefined> {
  if (fichier.size > EXTRACTION_MAX) return undefined;
  const ext = (fichier.name.split(".").pop() ?? "").toLowerCase();
  if (TEXTES.includes(ext)) return (await fichier.text()).slice(0, 2_000_000);
  const { EXTENSIONS_DOCUMENTS, extraireTexte } = await import("./documents");
  if (!EXTENSIONS_DOCUMENTS.includes(ext)) return undefined;
  try {
    return await extraireTexte(fichier, ext);
  } catch {
    return undefined;
  }
}

/**
 * Dépose un document : son texte est extrait ici, puis le fichier part en flux
 * (televersement.ts), sans passer par la mémoire. `onProgression` reçoit la
 * part déjà envoyée, de 0 à 1.
 */
export async function importerDocument(
  fichier: File,
  d: { parentId: string | null; visibilite: Visibilite; groupes: string[] },
  onProgression?: (fraction: number) => void,
): Promise<ElementBibliotheque> {
  if (fichier.size > TAILLE_MAX) throw new Error(tf("« {0} » dépasse {1}.", fichier.name, LIBELLE_DOCUMENT_MAX));
  if (fichier.size === 0) throw new Error(tf("« {0} » est vide.", fichier.name));
  const texte = await texteDe(fichier);
  const r = await envoyerEnFlux<{ element: ElementBibliotheque }>(
    "/oxoai/bibliotheque/documents",
    { nom: fichier.name, taille: fichier.size, texte, ...d },
    fichier,
    onProgression,
  );
  return r.element;
}

export async function modifierElement(
  id: string,
  d: Partial<{ nom: string; parentId: string | null; visibilite: Visibilite; groupes: string[]; emoji: string; couleur: Couleur | "" }>,
): Promise<ElementBibliotheque> {
  return (await lire<{ element: ElementBibliotheque }>(await poster(`/oxoai/bibliotheque/${encodeURIComponent(id)}`, d))).element;
}

export async function marquerFavori(id: string, favori: boolean): Promise<void> {
  await lire(await poster(`/oxoai/bibliotheque/${encodeURIComponent(id)}/favori`, { favori }));
}

export async function supprimerElement(id: string): Promise<void> {
  await lire(await poster(`/oxoai/bibliotheque/${encodeURIComponent(id)}/supprimer`, {}));
}

/** Le document, tel qu'il a été déposé, en `File` (pour un agent, ou pour l'enregistrer). */
export async function recupererDocument(e: Pick<ElementBibliotheque, "id" | "nom">): Promise<File> {
  const r = await apiFetch(`/oxoai/bibliotheque/${encodeURIComponent(e.id)}/contenu`);
  if (!r.ok) {
    const corps = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(corps.error?.message ?? tf("« {0} » est illisible.", e.nom));
  }
  return new File([await r.blob()], e.nom, { type: r.headers.get("X-OxoAI-Type") ?? "application/octet-stream" });
}

/** Enregistre un document sur le poste, sous son nom. */
export async function telechargerDocument(e: Pick<ElementBibliotheque, "id" | "nom">): Promise<void> {
  const fichier = await recupererDocument(e);
  const url = URL.createObjectURL(fichier);
  const a = document.createElement("a");
  a.href = url;
  a.download = e.nom;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** « 1,2 Mo », « 1.2 MB » : la langue de lecture décide (voir `taille`). */
export function taillePlaisante(octets?: number): string {
  return octets === undefined ? "" : taille(octets);
}
