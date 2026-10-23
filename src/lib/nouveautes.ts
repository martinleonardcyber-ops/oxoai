/**
 * Nouveautés des versions (demandé par Medhi le 23/10/2026).
 *
 * Les notes viennent des publications GitHub, lues et nettoyées par le
 * processus principal (electron/miseAJour.cjs, electron/notesVersion.cjs) :
 * la page ne contacte pas GitHub elle-même, et dans un navigateur (interface
 * servie par une instance) il n'y a rien à lire, donc rien n'est affiché.
 */

export interface NoteDeVersion {
  version: string;
  /** Date de publication (ISO), si GitHub la donne. */
  date: string | null;
  /** Markdown réduit, déjà nettoyé (ni HTML, ni tableau, ni lien hors https). */
  texte: string;
  /** Langue du texte : `en` (notes GitHub) ou celle de l'écran si une note traduite est publiée. */
  langue: string;
  lien: string | null;
}

export type ResultatNouveautes =
  | { ok: true; versions: NoteDeVersion[]; autres: number; lien: string | null }
  | { ok: false; lien: string | null };

export interface Lancement {
  version: string;
  /** Version d'avant ce lancement, si l'application vient d'être mise à jour. */
  depuis: string | null;
  /** Profil servi par une version d'avant ce repère : mise à jour, version précédente inconnue. */
  inconnue: boolean;
  nePlusAfficher: boolean;
}

interface PontNouveautes {
  nouveautes?: (demande: { depuis?: string | null; jusqua: string; langue: string }) => Promise<ResultatNouveautes>;
  lancement?: () => Promise<Lancement>;
  nouveautesVues?: (reglage?: { nePlusAfficher?: boolean }) => Promise<Lancement>;
}

/** Le pont de l'application de bureau, s'il connaît les nouveautés (absent d'une application plus ancienne et d'un navigateur). */
export const pontNouveautes = (): Required<PontNouveautes> | undefined => {
  if (typeof window === "undefined") return undefined;
  const p = (window as unknown as { helix?: { miseAJour?: PontNouveautes } }).helix?.miseAJour;
  return p && typeof p.nouveautes === "function" && typeof p.lancement === "function" && typeof p.nouveautesVues === "function"
    ? (p as Required<PontNouveautes>)
    : undefined;
};

/** Seuls les liens https sortent vers le navigateur du système ; tout autre lien n'est pas affiché. */
export const lienSur = (lien: string | null | undefined): string | null => {
  if (!lien) return null;
  try {
    return new URL(lien).protocol === "https:" ? lien : null;
  } catch {
    return null;
  }
};
