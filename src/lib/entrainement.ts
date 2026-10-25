import { apiFetch } from "./endpoint";
import { t } from "@/lib/i18n";

/**
 * Entraîner un modèle sur ses propres exemples (gateway/src/entrainement.ts),
 * vu de l'interface.
 */

export interface Exemple {
  question: string;
  reponse: string;
}

export interface Travail {
  type: "installation" | "generation" | "entrainement" | "comparaison" | "publication";
  projet?: string;
  message: string;
  fait: number;
  total: number;
  debut: number;
  perte?: number;
  perteValidation?: number;
  resteSecondes?: number;
  memoireGo?: number;
  /** Travail lancé par quelqu'un d'autre : on n'en voit que la nature. */
  autre?: true;
}

export interface ResumeProjet {
  id: string;
  nom: string;
  modifie: string;
  exemples: number;
  propositions: number;
  entraine: boolean;
  publie: string | null;
}

export interface EtatEntrainement {
  possible: boolean;
  raison: string;
  moteur: "mlx" | "nvidia" | null;
  verifie: boolean;
  base: { cle: string; nom: string; depot: string; licence: string; verifie: boolean } | null;
  pret: boolean;
  telechargementGo: number;
  placeGo: number;
  placeActuelleGo: number;
  obstacles: string[];
  erreurInstallation: string | null;
  travail: Travail | null;
  projets: ResumeProjet[];
}

export interface Ligne {
  question: string;
  attendu: string;
  base: string;
  entraine: string;
}

export interface Projet {
  id: string;
  nom: string;
  exemples: Exemple[];
  propositions: Exemple[];
  entrainement: {
    etat: "fini" | "arrete" | "echec";
    date: string;
    base: string;
    pas: number;
    secondes: number;
    perte?: number;
    perteValidation?: number;
    exemplesAppris: number;
    misDeCote: number;
    message?: string;
    tentative?: { etat: "arrete" | "echec"; date: string; message: string };
  } | null;
  comparaison: { date: string; lignes: Ligne[] } | null;
  publie: { nom: string; cle: string | null; date: string; octets: number } | null;
  estimation: { secondes: number; disqueGo: number; pas: number; misDeCote: number } | null;
}

/** Nombre d'exemples en dessous duquel l'entraînement est refusé (même règle que la passerelle). */
export const EXEMPLES_MIN = 10;

async function lireErreur(res: Response): Promise<string> {
  const corps = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return corps.error?.message ?? t("L'instance n'a pas répondu.");
}

async function appel<T>(chemin: string, corps?: unknown): Promise<T> {
  const res = await apiFetch(`/oxoai/entrainement${chemin}`, corps === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });
  if (!res.ok) throw new Error(await lireErreur(res));
  return (await res.json()) as T;
}

export const etatEntrainement = () => appel<EtatEntrainement>("");
export const lireProjet = (id: string) => appel<Projet>(`/projet?id=${encodeURIComponent(id)}`);
export const installerMoteur = () => appel<EtatEntrainement>("/installer", {});
export const desinstallerMoteur = () => appel<EtatEntrainement>("/desinstaller", {});
export const creerProjet = (nom: string) => appel<Projet>("/projets", { nom });
export const enregistrerExemples = (projet: string, exemples: Exemple[], propositions?: Exemple[]) =>
  appel<Projet>("/exemples", { projet, exemples, propositions });
export const importerExemples = (projet: string, contenu: string, nom: string) =>
  appel<{ ajoutes: number; ignorees: number }>("/importer", { projet, contenu, nom });
export const genererDepuisDocument = (projet: string, texte: string, source: string) =>
  appel<Travail>("/generer", { projet, texte, source });
export const lancerEntrainement = (projet: string) => appel<Travail>("/lancer", { projet });
export const arreterTravail = () => appel<{ arrete: boolean }>("/arreter", {});
export const comparerModeles = (projet: string, questions: string[]) => appel<Travail>("/comparer", { projet, questions });
export const publierModele = (projet: string) => appel<Travail>("/publier", { projet });
export const retirerModele = (projet: string) => appel<Projet>("/retirer", { projet });
export const supprimerProjet = (projet: string) => appel<{ ok: boolean }>("/supprimer", { projet });
