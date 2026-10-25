import { useMemo, useSyncExternalStore } from "react";
import { currentUser, IDENTITE_CHANGEE } from "@/lib/store/identity";
import { loadProfile, saveProfile, type UserProfile } from "@/lib/store/profile";
import { isolerLtr, langue, locale, t } from "@/lib/i18n";

/**
 * Formats de date et d'heure : le seul endroit de l'application qui transforme
 * un instant en texte.
 *
 * Tout affichage de date ou d'heure passe par ici. C'est la condition pour que
 * le réglage de Préférences pilote réellement quelque chose : tant que chaque
 * écran appelait `toLocaleDateString` de son côté, le réglage ne changeait que
 * l'aperçu de sa propre carte.
 *
 * ── Par personne, pas par poste ──────────────────────────────────────────────
 *
 * L'apparence est rangée par poste (`src/lib/store/apparence.ts`) pour deux
 * raisons : l'écran de connexion s'affiche avant qu'on sache qui est là, et le
 * bon thème dépend de la pièce et de l'heure. Aucune des deux ne vaut ici :
 *  - aucune date ne s'affiche avant la connexion. L'écran de connexion liste
 *    des comptes, pas des instants ; avant qu'une personne soit connue, le
 *    format par défaut suffit ;
 *  - un format de date est une habitude de lecture de la personne, pas une
 *    propriété du lieu. La comptable qui lit en ISO pour trier ses pièces veut
 *    l'ISO sur son portable comme sur le poste de l'accueil ; et deux
 *    collègues qui partagent le poste de l'atelier n'ont pas à s'imposer le
 *    format l'un de l'autre.
 *
 * Le choix est donc rangé dans le **profil privé** du compte (collection
 * `profiles`, qui ne sort jamais de son propriétaire côté instance) : il suit
 * la personne sur tous les postes rattachés à la même instance, et ne change
 * rien pour ses collègues.
 *
 * Le champ vit sous `formats` dans ce profil. Il n'est pas déclaré dans
 * `UserProfile` (src/lib/store/profile.ts) : ce module est le seul à le lire et
 * à l'écrire, et il valide ce qu'il y trouve.
 */

export type FormatDate = "eu" | "us" | "iso";
export type FormatHeure = "24" | "12";

export interface PreferencesFormats {
  date: FormatDate;
  heure: FormatHeure;
}

export const FORMATS_DATE: { valeur: FormatDate; nom: string }[] = [
  { valeur: "eu", nom: t("Format européen (JJ/MM/AAAA)") },
  { valeur: "us", nom: t("Format américain (MM/JJ/AAAA)") },
  { valeur: "iso", nom: t("ISO (AAAA-MM-JJ)") },
];

export const FORMATS_HEURE: { valeur: FormatHeure; nom: string }[] = [
  { valeur: "24", nom: t("24 heures") },
  { valeur: "12", nom: t("12 heures") },
];

/**
 * Ce qu'affiche une installation neuve : l'usage français. En japonais, l'année
 * d'abord (2026-09-28), l'ordre qu'on y lit ; le jour en premier y serait pris
 * pour une erreur (28/09/2026). L'espagnol, l'allemand et l'arabe gardent le
 * jour en premier, leur ordre à eux aussi (30/09/2026).
 */
const DEFAUT: PreferencesFormats = { date: langue() === "ja" ? "iso" : "eu", heure: "24" };

type ProfilAvecFormats = UserProfile & { formats?: unknown };

/**
 * Relit un réglage enregistré.
 *
 * Le profil arrive de l'instance, donc possiblement d'un autre poste ou d'une
 * autre version. Une valeur qu'on ne reconnaît pas retombe sur le défaut
 * plutôt que de produire une date illisible.
 */
function valider(brut: unknown): PreferencesFormats {
  const objet = typeof brut === "object" && brut !== null ? (brut as Record<string, unknown>) : {};
  const date = FORMATS_DATE.some((f) => f.valeur === objet.date)
    ? (objet.date as FormatDate)
    : DEFAUT.date;
  const heure = FORMATS_HEURE.some((f) => f.valeur === objet.heure)
    ? (objet.heure as FormatHeure)
    : DEFAUT.heure;
  return { date, heure };
}

/* ------------------------------------------------------------------ */
/* Lecture et écriture du réglage                                      */
/* ------------------------------------------------------------------ */

/** Émis par la synchronisation et par `useProfile` quand un profil a changé. */
const PROFIL_CHANGE = "oxoai:profile-changed";

/*
 * Réglage en mémoire, pour le compte qui l'a produit. `useSyncExternalStore`
 * exige la même référence tant que rien n'a changé ; relire le profil entier
 * à chaque rendu de chaque date serait de toute façon du gaspillage.
 */
let memoire: { compte: string; prefs: PreferencesFormats } | null = null;
const abonnes = new Set<() => void>();

function oublier(): void {
  memoire = null;
  for (const rappel of abonnes) rappel();
}

if (typeof window !== "undefined") {
  // Un autre poste a pu changer le réglage (synchronisation), ou un autre
  // compte vient de se connecter sur celui-ci.
  window.addEventListener(PROFIL_CHANGE, oublier);
  window.addEventListener(IDENTITE_CHANGEE, oublier);
}

/** Réglage de la personne connectée. */
export function lireFormats(): PreferencesFormats {
  const compte = currentUser().id;
  if (memoire && memoire.compte === compte) return memoire.prefs;
  const profil = loadProfile(compte) as ProfilAvecFormats;
  memoire = { compte, prefs: valider(profil.formats) };
  return memoire.prefs;
}

/** Enregistre le réglage dans le profil privé de la personne connectée. */
export function ecrireFormats(changements: Partial<PreferencesFormats>): void {
  const compte = currentUser().id;
  const profil = loadProfile(compte) as ProfilAvecFormats;
  const suivant: ProfilAvecFormats = {
    ...profil,
    formats: valider({ ...lireFormats(), ...changements }),
  };
  saveProfile(suivant);
  /*
   * Prévient aussi les écrans qui tiennent le profil en mémoire (`useProfile`) :
   * sans cela, le prochain enregistrement de leurs instructions réécrirait le
   * profil tel qu'ils l'avaient lu, et effacerait ce réglage.
   */
  window.dispatchEvent(new Event(PROFIL_CHANGE));
}

function abonner(rappel: () => void): () => void {
  abonnes.add(rappel);
  return () => abonnes.delete(rappel);
}

/* ------------------------------------------------------------------ */
/* Mise en forme                                                       */
/* ------------------------------------------------------------------ */

type Instant = Date | string | number;

function enDate(valeur: Instant): Date | null {
  const date = valeur instanceof Date ? valeur : new Date(valeur);
  return Number.isNaN(date.getTime()) ? null : date;
}

const deux = (n: number) => String(n).padStart(2, "0");

/*
 * Les chiffres sont assemblés ici plutôt que confiés à `Intl` : le rendu
 * d'`Intl` varie d'un moteur à l'autre (espaces insécables, séparateurs), et
 * l'application empaquetée ne tourne pas sur le même moteur que le navigateur
 * de développement. Ce que la personne a choisi doit s'afficher exactement.
 */

/** Date complète : 12/09/2026, 09/12/2026 ou 2026-09-12. Vide si l'instant est invalide. */
export function formaterDate(valeur: Instant, prefs: PreferencesFormats = lireFormats()): string {
  const d = enDate(valeur);
  if (!d) return "";
  const jour = deux(d.getDate());
  const mois = deux(d.getMonth() + 1);
  const annee = String(d.getFullYear());
  if (prefs.date === "us") return `${mois}/${jour}/${annee}`;
  if (prefs.date === "iso") return `${annee}-${mois}-${jour}`;
  return `${jour}/${mois}/${annee}`;
}

/** Heure : 14:05, ou 2:05 PM. */
export function formaterHeure(valeur: Instant, prefs: PreferencesFormats = lireFormats()): string {
  const d = enDate(valeur);
  if (!d) return "";
  const minutes = deux(d.getMinutes());
  if (prefs.heure === "12") {
    const h = d.getHours();
    // En arabe, « 2:05 PM » reste dans cet ordre (sinon « PM 2:05 », voir `isolerLtr`).
    return isolerLtr(`${h % 12 || 12}:${minutes} ${h < 12 ? "AM" : "PM"}`);
  }
  return `${deux(d.getHours())}:${minutes}`;
}

/** Date et heure : 12/09/2026 14:05. */
export function formaterDateHeure(
  valeur: Instant,
  prefs: PreferencesFormats = lireFormats(),
): string {
  const d = enDate(valeur);
  if (!d) return "";
  /*
   * En arabe (30/09/2026), la date reste avant l'heure : deux suites de
   * chiffres séparées par une espace s'échangeaient dans une ligne écrite de
   * droite à gauche. Les chiffres restent occidentaux, comme partout à l'écran.
   */
  return isolerLtr(`${formaterDate(d, prefs)} ${formaterHeure(d, prefs)}`.replace(/[\u2066\u2069]/g, ""));
}

/**
 * Forme courte, pour une liste où la place manque : l'heure seule pour un
 * instant d'aujourd'hui, la date seule sinon.
 */
export function formaterMomentCourt(
  valeur: Instant,
  prefs: PreferencesFormats = lireFormats(),
): string {
  const d = enDate(valeur);
  if (!d) return "";
  return d.toDateString() === new Date().toDateString()
    ? formaterHeure(d, prefs)
    : formaterDate(d, prefs);
}

/**
 * Mois en toutes lettres : « septembre 2026 », pour l'en-tête d'un
 * calendrier. Une forme écrite en lettres n'a pas d'ordre de chiffres à
 * choisir : elle ne dépend pas du réglage, mais passe ici pour que ce module
 * reste le seul à mettre des instants en texte.
 */
export function formaterMoisAnnee(valeur: Instant): string {
  const d = enDate(valeur);
  if (!d) return "";
  return d.toLocaleDateString(locale(), { month: "long", year: "numeric" });
}

/* ------------------------------------------------------------------ */
/* Pour les composants                                                 */
/* ------------------------------------------------------------------ */

/**
 * Formateurs liés au réglage courant.
 *
 * Un composant qui affiche une date doit passer par ce crochet, et non par les
 * fonctions nues : c'est lui qui le fait redessiner quand le réglage change.
 * La barre latérale reste montée pendant qu'on est dans Préférences ; sans
 * abonnement, sa liste de conversations garderait l'ancien format jusqu'au
 * prochain rechargement.
 */
export function useFormats() {
  const prefs = useSyncExternalStore(abonner, lireFormats, lireFormats);
  return useMemo(
    () => ({
      prefs,
      date: (v: Instant) => formaterDate(v, prefs),
      heure: (v: Instant) => formaterHeure(v, prefs),
      dateHeure: (v: Instant) => formaterDateHeure(v, prefs),
      momentCourt: (v: Instant) => formaterMomentCourt(v, prefs),
      moisAnnee: (v: Instant) => formaterMoisAnnee(v),
    }),
    [prefs],
  );
}
