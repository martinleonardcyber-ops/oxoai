import { deployment } from "./deployment.ts";
import { publicAccounts } from "./accounts.ts";

/**
 * Qui administre cette instance.
 *
 * ── Pourquoi c'est arrivé tard, et volontairement petit ─────────────────────
 *
 * La passerelle n'avait aucune notion de rôle, et c'était tenable tant que
 * chaque route ne rendait à chacun que ses propres données. Une chose y
 * échappait : le **journal d'audit**. Rendu en entier, il donnait à chaque
 * salarié la carte de l'activité de ses collègues ; cloisonné (0.22.0), il ne
 * laissait plus personne constater l'état de l'instance. Les deux sont
 * mauvais. Il fallait donc savoir dire « cette personne en répond ».
 *
 * ── Comment l'administrateur est désigné ────────────────────────────────────
 *
 * 1. Le **profil de déploiement** le dit : `administrateurs: ["…@…"]` dans
 *    `helix.config.json`. C'est un fichier posé sur la machine hôte par
 *    l'intégrateur, jamais modifiable par une requête. C'est la voie d'une
 *    instance d'entreprise.
 * 2. À défaut, le **premier compte créé** sur l'instance : celle ou celui qui
 *    l'a mise en route. Sur un poste personnel, c'est l'unique compte, et la
 *    question ne se pose pas. Sur une instance qu'on a montée sans profil,
 *    c'est la personne qui l'a montée.
 *
 * Ce rôle **n'ouvre aucune donnée personnelle** : ni les conversations, ni les
 * documents, ni les mails de qui que ce soit. Il ouvre la vue d'ensemble du
 * journal, c'est-à-dire des traces d'actions, et rien d'autre. Toute extension
 * de ce rôle doit être pesée ici, et écrite.
 *
 * ── Extension du 23/10/2026 : réinitialiser le mot de passe d'un collègue ───
 *
 * Demandée par Medhi (« quelqu'un perd son mot de passe, ça arrive souvent »).
 * C'est un pouvoir réel : qui remet un mot de passe provisoire pourrait, en
 * principe, s'en servir avant le collègue et ouvrir son compte. Pesé ainsi
 * (accounts.ts, `reinitialiserParAdministrateur`) : le mot de passe de
 * l'administrateur est redemandé à chaque fois ; le provisoire est tiré par
 * l'instance et expire en 72 heures ; le second facteur du collègue reste
 * (il protège alors le compte même contre l'administrateur), sauf retrait
 * coché ; la trace est écrite au nom du collègue, qui la voit dans son
 * journal, et son ancien mot de passe cesse de marcher, ce qu'il remarque à
 * la connexion suivante. Jamais sur son propre compte, jamais sur celui d'un
 * autre administrateur. La personne qui tient la machine de l'instance
 * pouvait déjà en faire autant avec `npm run motdepasse`.
 */

const normalise = (adresse: unknown): string =>
  typeof adresse === "string" ? adresse.trim().toLowerCase() : "";

/** Adresses déclarées administratrices par le profil de déploiement. */
function declarees(): string[] {
  const brut = (deployment() as { administrateurs?: unknown }).administrateurs;
  if (!Array.isArray(brut)) return [];
  return brut.map(normalise).filter(Boolean);
}

/** Cette personne administre-t-elle l'instance ? */
export async function estAdministrateur(accountId: string): Promise<boolean> {
  const comptes = await publicAccounts();
  const compte = comptes.find((c) => c.id === accountId);
  if (!compte) return false;

  const liste = declarees();
  /*
   * Une adresse que la personne s'est déclarée elle-même (changement de
   * profil, que rien ne vérifie) ne donne pas le rôle (revue du 26/09/2026) :
   * il suffisait de prendre l'adresse d'un administrateur qui n'avait pas
   * encore de compte pour lire tout le journal et régler l'instance. Même
   * règle que pour les partages (`adresseDePartage`, accounts.ts).
   */
  if (liste.length > 0) return !compte.adresseDeclareeLe && liste.includes(normalise(compte.email));

  /*
   * Aucun profil : le compte le plus ancien. `createdAt` est posé à la
   * création et n'est modifiable par aucune route (les comptes ne s'écrivent
   * pas par la synchronisation, voir handleDataWrite).
   */
  const premier = [...comptes].sort((a, b) =>
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  )[0];
  return Boolean(premier && premier.id === accountId);
}

/** Comment le rôle a été attribué, pour que l'écran puisse le dire. */
export async function origineDuRole(accountId: string): Promise<"profil" | "premier" | null> {
  if (!(await estAdministrateur(accountId))) return null;
  return declarees().length > 0 ? "profil" : "premier";
}
