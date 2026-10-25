import { useSyncExternalStore } from "react";
import { brut as brutStocke, storage } from "./storage";
import { endSession, modifierCompte, toUser } from "./accounts";
import { sessionToken } from "@/lib/endpoint";

/**
 * Identité de l'utilisateur courant.
 *
 * L'authentification réelle (écran de connexion à l'installation) viendra avec
 * l'empaquetage : cette couche expose déjà la bonne forme, si bien que le reste
 * de l'application n'aura pas à changer. Tout ce qui est personnel est scopé
 * par `user.id`.
 */

export interface User {
  id: string;
  handle: string;
  fullName: string;
  email: string;
  initials: string;
  /** Groupes auxquels l'utilisateur appartient (partage de sessions). */
  groupIds: string[];
  /** Organisation, pour la visibilité « Tous les membres ». */
  organisationId: string;
  /** Photo de profil (image intégrée), si la personne en a mis une. */
  photo?: string;
}

const KEY = "identity:current";

/** Utilisateur par défaut tant que la connexion n'est pas branchée. */
const FALLBACK: User = {
  id: "u_local",
  // Neutre : le dépôt est public, et ce repli ne doit nommer personne (27/09/2026).
  handle: "local",
  fullName: "",
  email: "",
  initials: "?",
  groupIds: [],
  organisationId: "org_default",
};

/**
 * Le prénom, pour saluer.
 *
 * L'accueil disait « Bonjour, prenom.nom » : l'identifiant tiré de
 * l'adresse, qui est un nom de machine, pas un nom de personne. Le premier
 * mot du nom complet est ce qu'on dirait à voix haute ; l'identifiant ne sert
 * que si aucun nom n'a été donné.
 */
export function prenom(user: Pick<User, "fullName" | "handle">): string {
  const premier = user.fullName?.trim().split(/\s+/)[0];
  return premier || user.handle;
}

/** Un compte est-il connecté sur ce poste ? */
/**
 * Connecté ? Il faut les deux : un utilisateur retenu sur ce poste **et** une
 * séance ouverte auprès de l'instance.
 *
 * L'un sans l'autre donne l'état le plus déroutant du produit : l'application
 * s'ouvre, affiche « Bonjour » et le bon nom, puis répond « Session expirée »
 * au moindre écran qui demande une identité — choix du dossier, outils, agent
 * de code. Cela arrive dès que les séances sont révoquées côté instance, ou
 * après une réinstallation. Mieux vaut alors revenir à l'écran de connexion,
 * qui rouvre une séance en un clic.
 */
export function isSignedIn(): boolean {
  return storage.get<User | null>(KEY, null) !== null && sessionToken() !== undefined;
}

/**
 * Utilisateur connecté. L'application n'étant rendue qu'après connexion, la
 * valeur de repli ne sert qu'à protéger les appels faits hors de ce cadre.
 */
export function currentUser(): User {
  return storage.get<User>(KEY, FALLBACK);
}

/** Émis quand l'utilisateur connecté change, ou que son nom ou son adresse change. */
export const IDENTITE_CHANGEE = "oxoai:identite-changee";

export function setCurrentUser(user: User): void {
  storage.set(KEY, user);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(IDENTITE_CHANGEE));
}

/**
 * Groupes de la personne connectée, tels que l'instance les connaît : ce qui
 * leur est partagé apparaît chez elle. Réécrit seulement s'ils ont changé.
 */
export function retenirGroupes(ids: string[]): void {
  const actuel = storage.get<User | null>(KEY, null);
  if (!actuel) return;
  const tries = [...ids].sort();
  if (JSON.stringify([...(actuel.groupIds ?? [])].sort()) === JSON.stringify(tries)) return;
  setCurrentUser({ ...actuel, groupIds: tries });
}

/**
 * Enregistre un nouveau nom et, ou, une nouvelle adresse pour le compte
 * connecté, puis met à jour l'utilisateur affiché sur ce poste.
 *
 * L'identité retenue ici n'est qu'une copie de celle de l'instance : on ne la
 * réécrit qu'avec la réponse de l'instance, jamais avec ce qui a été saisi.
 * Sans cela, un changement refusé par l'instance resterait affiché comme fait.
 */
export async function modifierIdentite(changements: {
  fullName?: string;
  email?: string;
  password?: string;
  /** Image intégrée, ou `null` pour retirer la photo. */
  photo?: string | null;
}): Promise<User> {
  const compte = await modifierCompte(changements);
  const utilisateur = toUser(compte);
  setCurrentUser(utilisateur);
  return utilisateur;
}

/*
 * Instantané stable de l'utilisateur, pour `useSyncExternalStore` : il exige
 * la même référence tant que rien n'a changé, sans quoi React relance le rendu
 * sans fin. On le recalcule seulement quand la valeur brute stockée bouge.
 */
let instantane: { brut: string | null; utilisateur: User } | null = null;

function lireInstantane(): User {
  // Valeur brute telle qu'elle est rangée : au coffre du système dans
  // l'application, dans le navigateur ailleurs (lib/store/storage.ts).
  const valeur = brutStocke(KEY);
  if (instantane && instantane.brut === valeur) return instantane.utilisateur;
  instantane = { brut: valeur, utilisateur: currentUser() };
  return instantane.utilisateur;
}

function abonner(rappel: () => void): () => void {
  window.addEventListener(IDENTITE_CHANGEE, rappel);
  return () => window.removeEventListener(IDENTITE_CHANGEE, rappel);
}

/**
 * Utilisateur connecté, tenu à jour.
 *
 * `currentUser()` lu pendant le rendu ne se relit qu'au rendu suivant : la
 * barre latérale, montée en permanence, aurait gardé les anciennes initiales
 * jusqu'au prochain rechargement. Ce crochet fait redessiner le composant dès
 * que l'identité change.
 */
export function useUtilisateurCourant(): User {
  return useSyncExternalStore(abonner, lireInstantane, lireInstantane);
}

/**
 * Déconnexion : l'identité est oubliée, les données locales sont conservées.
 *
 * La séance est révoquée **sur l'instance**, pas seulement oubliée ici : un
 * jeton effacé du poste mais toujours valable côté serveur rouvrirait l'accès
 * sans mot de passe à qui le récupérerait.
 */
export async function clearCurrentUser(): Promise<void> {
  storage.remove(KEY);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(IDENTITE_CHANGEE));
  await endSession();
}
