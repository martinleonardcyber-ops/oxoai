import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./endpoint";
import type { Visibilite } from "./bibliotheque";
import { t } from "@/lib/i18n";

/**
 * Bases de connaissances (gateway/src/connaissances.ts) : des documents de la
 * Bibliothèque indexés par le sens, que le Chat, Cowork et les agents
 * consultent avant de répondre. L'instance tient tout, droits compris : ce
 * poste ne reçoit que ce que la personne a le droit de voir.
 */

export type EtatDocument = "attente" | "encours" | "pret" | "erreur" | "sans_texte";

export interface DocumentDeBase {
  id: string;
  nom: string;
  etat: EtatDocument;
  morceaux: number;
  caracteres: number;
  modele: string | null;
  indexeLe: string | null;
  dureeMs: number | null;
  /** Morceaux déjà vectorisés, et combien il y en a en tout. */
  fait: number;
  total: number;
  erreur: string | null;
  detail: string | null;
}

export interface Base {
  id: string;
  nom: string;
  description: string;
  visibilite: Visibilite;
  groupes: string[];
  estProprietaire: boolean;
  documents: DocumentDeBase[];
  /** Documents supprimés de la Bibliothèque depuis : visibles de son propriétaire seul. */
  disparus: { id: string; nom: string }[];
  /** Documents de la base que la personne ne voit pas dans la Bibliothèque : ni nommés, ni cités. */
  masques: number;
  morceaux: number;
  enCours: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDisponible {
  id: string;
  nom: string;
  dossier: string;
  aTexte: boolean;
  taille: number;
}

export interface Passage {
  n: number;
  baseId: string;
  base: string;
  documentId: string;
  document: string;
  texte: string;
  debut: number;
  fin: number;
  similarite: number;
  rangSens: number | null;
  rangMots: number | null;
}

export interface Recherche {
  passages: Passage[];
  ignorees: number;
  aReindexer: number;
  morceauxParcourus: number;
  dureeMs: number;
  vectorisationMs: number;
  modele: string | null;
  erreur?: string;
}

/** Ce que la passerelle envoie avec la réponse du Chat, pour les citations. */
export interface Citation {
  n: number;
  base: string;
  document: string;
  documentId: string;
  extrait: string;
  debut: number;
  fin: number;
  similarite: number;
}

async function lire<T>(res: Response): Promise<T> {
  const corps = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  return corps;
}

const poster = (chemin: string, corps: unknown) =>
  apiFetch(chemin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) });

const chemin = (id: string, action?: string) => `/oxoai/connaissances/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

export async function listerBases(): Promise<Base[]> {
  return (await lire<{ bases: Base[] }>(await apiFetch("/oxoai/connaissances"))).bases;
}

export async function creerBase(d: { nom: string; description: string; visibilite: Visibilite; groupes: string[] }): Promise<Base> {
  return (await lire<{ base: Base }>(await poster("/oxoai/connaissances", d))).base;
}

export async function modifierBase(
  id: string,
  d: Partial<{ nom: string; description: string; visibilite: Visibilite; groupes: string[] }>,
): Promise<Base> {
  return (await lire<{ base: Base }>(await poster(chemin(id), d))).base;
}

export async function supprimerBase(id: string): Promise<void> {
  await lire(await poster(chemin(id, "supprimer"), {}));
}

export async function ajouterDocuments(id: string, documents: string[]): Promise<Base> {
  return (await lire<{ base: Base }>(await poster(chemin(id, "documents"), { documents }))).base;
}

export async function retirerDocument(id: string, document: string): Promise<Base> {
  return (await lire<{ base: Base }>(await poster(chemin(id, "retirer"), { document }))).base;
}

export async function reindexer(id: string, document?: string): Promise<Base> {
  return (await lire<{ base: Base }>(await poster(chemin(id, "reindexer"), document ? { document } : {}))).base;
}

export async function documentsDisponibles(): Promise<DocumentDisponible[]> {
  return (await lire<{ documents: DocumentDisponible[] }>(await apiFetch("/oxoai/connaissances/documents"))).documents;
}

export async function essayerQuestion(bases: string[], question: string): Promise<Recherche> {
  return lire(await poster("/oxoai/connaissances/chercher", { bases, question, nombre: 5 }));
}

/**
 * Les bases que la personne voit. Tant qu'une indexation tourne, la liste se
 * relit toutes les deux secondes : c'est ce qui fait avancer la barre de
 * progression à l'écran (l'instance garde la progression en mémoire).
 */
export function useBases() {
  const [bases, setBases] = useState<Base[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const vivant = useRef(true);

  const recharger = useCallback(async () => {
    try {
      const liste = await listerBases();
      if (!vivant.current) return;
      setBases(liste);
      setErreur(null);
    } catch (err) {
      // Liste illisible : on garde celle qu'on avait, on ne la remplace pas par du vide.
      if (vivant.current) setErreur(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    vivant.current = true;
    void recharger();
    return () => {
      vivant.current = false;
    };
  }, [recharger]);

  const enCours = bases?.some((b) => b.enCours) ?? false;
  useEffect(() => {
    if (!enCours) return;
    const minuterie = setInterval(() => void recharger(), 2000);
    return () => clearInterval(minuterie);
  }, [enCours, recharger]);

  return { bases, erreur, recharger };
}
