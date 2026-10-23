import { oublierClesDe } from "./clesApi.ts";
import { pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";
import { journaliser } from "./audit.ts";
import { deployment } from "./deployment.ts";
import { nouveauSecret, nouveauxCodesDeSecours, trouverSecours, verifierCode } from "./totp.ts";
import { revokeAll } from "./usersession.ts";
import { t, tf } from "./langue.ts";

/**
 * Comptes, côté instance.
 *
 * Les empreintes de mots de passe ne quittent jamais le serveur : la
 * vérification se fait ici. Sans cela, chaque poste recevrait les empreintes de
 * tous ses collègues et pourrait les attaquer hors ligne.
 */

/*
 * 600 000 itérations de PBKDF2-SHA256, la recommandation actuelle de l'OWASP
 * (relevée le 27/09/2026, en préparant le dépôt public). Les empreintes d'avant
 * n'en notaient pas le nombre : elles valent 210 000, et sont refaites à
 * 600 000 à la connexion suivante, quand le mot de passe est connu.
 */
const ITERATIONS = 600_000;
const ITERATIONS_ANCIENNES = 210_000;
const KEYLEN = 32;
const DIGEST = "sha256";

export interface StoredAccount {
  id: string;
  /**
   * Mot de passe choisi par quelqu'un d'autre (l'administrateur qui a créé le
   * compte) : il ouvre une seule chose, le choix d'un mot de passe à soi. Pas
   * de séance avant (27/09/2026, revue de sécurité § 28).
   */
  motDePasseProvisoire?: boolean;
  /**
   * Mot de passe provisoire remis par un administrateur qui a réinitialisé
   * celui du compte (23/10/2026) : au-delà de cette date, il n'ouvre plus
   * rien, pas même le choix d'un mot de passe à soi. Un mot de passe noté sur
   * un papier ne doit pas rester une porte. Absent pour un compte créé par
   * l'administrateur, comme avant. Ne sort jamais de l'instance.
   */
  provisoireExpire?: string;
  /**
   * Codes de récupération du mot de passe (23/10/2026) : chacun redéfinit le
   * mot de passe une fois, depuis l'écran de connexion. Empreintes seulement,
   * comme les codes de secours du second facteur. Ne sort jamais de l'instance.
   */
  recuperation?: CodesRecuperation;
  handle: string;
  fullName: string;
  email: string;
  initials: string;
  groupIds: string[];
  organisationId: string;
  createdAt: string;
  /**
   * Date à laquelle la personne a elle-même changé son adresse, si elle l'a
   * fait. Une adresse ainsi déclarée n'est vérifiée par rien (l'instance ne
   * sait pas envoyer de courrier) : elle ne rattache donc aucun partage adressé
   * par email. Voir `adresseDePartage`.
   */
  adresseDeclareeLe?: string;
  /**
   * Photo de profil, en image intégrée (`data:image/jpeg;base64,…`), réduite
   * sur le poste à 256 pixels. Visible des collègues, comme le nom.
   */
  photo?: string;
  /**
   * Adresses que ce compte a portées avant l'actuelle. Elles lui restent
   * réservées : voir `adresseReservee`. Ne sort jamais de l'instance, un
   * historique d'adresses n'a rien à faire sur les postes des collègues.
   */
  anciennesAdresses?: string[];
  /** Ne sort jamais de l'instance. */
  passwordHash?: string;
  salt?: string;
  /** Itérations de PBKDF2 de `passwordHash` ; absent : ITERATIONS_ANCIENNES. Ne sort jamais de l'instance. */
  iterations?: number;
  /** Second facteur actif. Ne sort jamais de l'instance. Voir `gateway/src/totp.ts`. */
  deuxFacteurs?: DeuxFacteurs;
  /**
   * Secret tiré mais pas encore confirmé par un premier code juste. Tant qu'il
   * ne l'est pas, il ne protège rien et n'est pas demandé à la connexion :
   * quelqu'un qui abandonne à mi-chemin ne s'enferme pas dehors.
   */
  deuxFacteursEnAttente?: { secret: string; creeLe: string };
}

/**
 * Codes de récupération : ils remplacent le **mot de passe**, jamais le second
 * facteur. Un compte qui a les deux et récupère son mot de passe par un code
 * doit encore donner le code de son téléphone : la feuille de codes seule
 * n'ouvre pas un compte protégé par deux facteurs. C'est pourquoi ce ne sont
 * pas les codes de secours du second facteur : les réutiliser pour le mot de
 * passe aurait fait d'une seule feuille les deux facteurs à la fois.
 */
export interface CodesRecuperation {
  empreintes: string[];
  sel: string;
  creeLe: string;
}

export interface DeuxFacteurs {
  /** Secret partagé avec l'application d'authentification, en base 32. */
  secret: string;
  activeLe: string;
  /** Dernier pas de trente secondes accepté : un code ne sert qu'une fois. */
  dernierPas?: number;
  /** Empreintes des codes de secours restants, et leur sel. */
  secours: string[];
  selSecours: string;
}

/** Compte tel qu'il est transmis aux postes : sans aucun secret. */
export interface PublicAccount
  extends Omit<
    StoredAccount,
    | "passwordHash"
    | "salt"
    | "iterations"
    | "anciennesAdresses"
    | "deuxFacteurs"
    | "deuxFacteursEnAttente"
    | "provisoireExpire"
    | "recuperation"
  > {
  /** Le poste a seulement besoin de savoir s'il faut demander un mot de passe. */
  hasPassword: boolean;
  /** Et s'il faudra un code après le mot de passe. */
  deuxFacteursActive: boolean;
}

/**
 * Longueur minimale d'un mot de passe.
 *
 * Dix caractères : c'est la règle de l'outil de récupération depuis le début,
 * elle vaut maintenant partout. Pas de règle de composition (majuscule,
 * chiffre, symbole) : elles poussent vers « Motdepasse1! » sans rien gagner,
 * alors que la longueur, elle, compte vraiment.
 */
export const MOT_DE_PASSE_MIN = 10;
/** Au-delà, ce n'est plus un mot de passe mais une charge envoyée à la passerelle. */
const MOT_DE_PASSE_MAX = 1024;

/** Raison du refus, ou `null` si le mot de passe convient. */
export function motDePasseRefuse(valeur: unknown): string | null {
  if (typeof valeur !== "string" || valeur.trim() === "") return t("Un mot de passe est requis.");
  if (valeur.length < MOT_DE_PASSE_MIN) {
    return tf("Le mot de passe doit compter au moins {0} caractères.", MOT_DE_PASSE_MIN);
  }
  if (valeur.length > MOT_DE_PASSE_MAX) return t("Ce mot de passe est trop long.");
  return null;
}

function derive(password: string, salt: string, iterations = ITERATIONS): string {
  return pbkdf2Sync(password, salt, iterations, KEYLEN, DIGEST).toString("hex");
}

/**
 * Refait l'empreinte d'un mot de passe juste à ITERATIONS, dans la file des
 * écritures de comptes. Rien si le mot de passe a changé entre-temps ; un échec
 * n'empêche pas la connexion (on réessaiera à la suivante).
 */
function renforcerEmpreinte(accountId: string, ancienne: string, motDePasse: string): Promise<void> {
  return enFile(async () => {
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte || compte.passwordHash !== ancienne) return;
    const salt = randomBytes(16).toString("hex");
    compte.salt = salt;
    compte.passwordHash = derive(motDePasse, salt);
    compte.iterations = ITERATIONS;
    await save(accounts);
  }).catch(() => undefined);
}

/** Le mot de passe donné est-il celui du compte ? Au nombre d'itérations de son empreinte. */
function motDePasseJuste(compte: StoredAccount, donne: string): boolean {
  if (!compte.passwordHash || !compte.salt) return false;
  const attendu = Buffer.from(compte.passwordHash, "hex");
  const calcule = Buffer.from(derive(donne, compte.salt, compte.iterations ?? ITERATIONS_ANCIENNES), "hex");
  return attendu.length === calcule.length && timingSafeEqual(attendu, calcule);
}

async function load(): Promise<StoredAccount[]> {
  const value = await db().read("accounts");
  return Array.isArray(value) ? (value as StoredAccount[]) : [];
}

async function save(accounts: StoredAccount[]): Promise<void> {
  await db().write("accounts", accounts);
}

const normalise = (email: string) => email.trim().toLowerCase();

const FORME_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * File d'attente des écritures de comptes.
 *
 * Chaque mutation lit la collection, la modifie, puis la réécrit entière. Deux
 * requêtes simultanées pouvaient donc lire le même état : deux comptes
 * revendiquant la même adresse passaient chacun le contrôle d'unicité, et la
 * seconde écriture effaçait la première. En file, chacune relit ce que la
 * précédente a écrit.
 */
let file: Promise<unknown> = Promise.resolve();

function enFile<T>(travail: () => Promise<T>): Promise<T> {
  const suite = file.then(travail, travail);
  file = suite.catch(() => undefined);
  return suite;
}

/**
 * Cette adresse est-elle déjà tenue par un compte, ou l'a-t-elle été ?
 *
 * Une adresse abandonnée n'est pas rendue à la circulation. Les règles de
 * visibilité de l'instance (`gateway/src/authz.ts`) reconnaissent un membre de
 * projet ou un destinataire de partage à son identifiant **ou** à son adresse :
 * si Bruno quitte bruno@ pour une autre adresse, et qu'un nouveau compte prend
 * bruno@, ce nouveau compte verrait tous les projets où Bruno figure sous cette
 * adresse. Réserver l'ancienne adresse à son titulaire ferme cette porte, pour
 * les créations comme pour les changements.
 *
 * `sauf` exclut le compte qui demande : revenir à sa propre ancienne adresse
 * ne prend rien à personne.
 */
function adresseReservee(
  comptes: StoredAccount[],
  adresse: string,
  sauf?: string,
): "actuelle" | "ancienne" | null {
  for (const compte of comptes) {
    if (compte.id === sauf) continue;
    if (normalise(compte.email) === adresse) return "actuelle";
    if ((compte.anciennesAdresses ?? []).some((a) => normalise(a) === adresse)) {
      return "ancienne";
    }
  }
  return null;
}

/*
 * Valeur donnée à l'adresse de partage d'un compte qui a déclaré la sienne.
 * Elle ne peut correspondre à aucun destinataire réel : elle n'a pas d'arobase,
 * alors que les invitations ne portent que des adresses validées par
 * `FORME_EMAIL`. Le caractère nul de tête survit au `trim()` que la
 * comparaison applique (`memeEmail`, `gateway/src/authz.ts`) ; une chaîne vide,
 * elle, aurait correspondu à tout membre enregistré sans adresse.
 */
const AUCUNE_ADRESSE = "\u0000adresse-declaree";

/**
 * Adresse sous laquelle l'instance reconnaît ce compte dans les partages.
 *
 * Une invitation adressée par email (« partager avec claire@… ») est destinée à
 * celle ou celui qu'un collègue **inscrira** sous cette adresse : la création
 * d'un compte exige une séance, c'est-à-dire un collègue déjà connu qui se
 * porte garant. Un changement d'adresse, lui, est déclaré par la personne
 * seule, et rien ne le vérifie.
 *
 * Laisser une adresse déclarée rattacher les invitations reviendrait à rouvrir
 * la faille de prise de compte déjà fermée sur `/helix/auth/create` : il
 * suffirait de se déclarer à l'adresse d'une invitée en attente pour hériter
 * de ses projets et conversations. Un compte qui a changé son adresse n'est
 * donc plus reconnu que par son identifiant ; les partages qu'on lui adresse
 * ensuite le désignent d'ailleurs par identifiant, puisque l'interface
 * retrouve le compte à partir de l'adresse au moment d'inviter.
 */
export function adresseDePartage(compte: PublicAccount): string {
  return compte.adresseDeclareeLe ? AUCUNE_ADRESSE : compte.email;
}

/** Retire les secrets d'un compte avant de le transmettre. */
export function toPublic(account: StoredAccount): PublicAccount {
  const {
    passwordHash,
    salt: _salt,
    anciennesAdresses: _anciennes,
    deuxFacteurs,
    deuxFacteursEnAttente: _attente,
    // Qui a encore un mot de passe provisoire ne regarde personne : la liste des comptes se lit avant toute connexion.
    motDePasseProvisoire: _provisoire,
    provisoireExpire: _expire,
    recuperation: _recuperation,
    ...rest
  } = account;
  return { ...rest, hasPassword: Boolean(passwordHash), deuxFacteursActive: Boolean(deuxFacteurs) };
}

export async function publicAccounts(): Promise<PublicAccount[]> {
  return (await load()).map(toPublic);
}

function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function createAccount(input: {
  fullName: string;
  email: string;
  password?: string;
  organisationId?: string;
  /** Créé par quelqu'un d'autre que la personne : son mot de passe est à changer à la première connexion. */
  provisoire?: boolean;
}): Promise<{ ok: true; account: PublicAccount } | { ok: false; reason: string }> {
  return enFile(() => creerCompte(input));
}

async function creerCompte(input: {
  fullName: string;
  email: string;
  password?: string;
  organisationId?: string;
  provisoire?: boolean;
}): Promise<{ ok: true; account: PublicAccount } | { ok: false; reason: string }> {
  const fullName = (input.fullName ?? "").trim();
  const email = normalise(input.email ?? "");

  if (!fullName || !email) return { ok: false, reason: t("Nom et adresse email requis.") };
  /*
   * Plus de compte sans mot de passe, pas même le premier. Un compte qu'on
   * ouvre par simple sélection est une porte ouverte dès que l'instance est
   * partagée : la liste des comptes est lisible avec le seul jeton d'instance,
   * donc ce jeton suffisait à prendre l'identité de n'importe qui.
   */
  const refus = motDePasseRefuse(input.password);
  if (refus) return { ok: false, reason: refus };
  if (!FORME_EMAIL.test(email)) {
    return { ok: false, reason: t("Adresse email invalide.") };
  }

  const accounts = await load();
  const reservee = adresseReservee(accounts, email);
  if (reservee === "actuelle") {
    return { ok: false, reason: t("Un compte existe déjà avec cette adresse.") };
  }
  if (reservee === "ancienne") {
    return { ok: false, reason: t("Cette adresse a déjà servi à un compte de l'instance.") };
  }

  const salt = randomBytes(16).toString("hex");
  const account: StoredAccount = {
    id: `u_${randomBytes(9).toString("base64url")}`,
    handle: email.split("@")[0] || fullName,
    fullName,
    email,
    initials: initialsOf(fullName),
    groupIds: [],
    organisationId: input.organisationId ?? "org_default",
    createdAt: new Date().toISOString(),
    salt,
    passwordHash: derive(input.password as string, salt),
    iterations: ITERATIONS,
    ...(input.provisoire ? { motDePasseProvisoire: true } : {}),
  };

  await save([...accounts, account]);
  // La trace « compte.cree » est posée par la route, qui sait s'il s'agit de l'amorçage.
  return { ok: true, account: toPublic(account) };
}

/*
 * Limitation des tentatives.
 *
 * PBKDF2 à 210 000 itérations ralentit une attaque, il ne l'empêche pas : sans
 * ce frein, un poste du réseau peut essayer des milliers de mots de passe par
 * minute contre le compte d'un collègue. Après cinq échecs, le compte est
 * verrouillé une minute, et le délai double à chaque nouvelle série.
 */
const MAX_ECHECS = 5;
const BLOCAGE_BASE_MS = 60_000;
const BLOCAGE_MAX_MS = 15 * 60_000;

const echecs = new Map<string, { compte: number; jusqua: number }>();

/**
 * Qui a redéfini un mot de passe sans connaître l'ancien. Écrit au journal.
 *
 *  - « outil local » : `npm run motdepasse`, sur la machine de l'instance ;
 *  - « application de bureau » : « Mot de passe oublié ? » sur l'écran de
 *    connexion de l'application qui fait tourner l'instance, après que
 *    l'ordinateur a reconnu sa session (electron/motDePasseOublie.cjs) ;
 *  - « code de récupération » : un des codes remis à la personne ;
 *  - « administrateur » : réinitialisation d'un collègue, mot de passe
 *    provisoire (`reinitialiserParAdministrateur`).
 */
export type PorteDeRecuperation = "outil local" | "application de bureau" | "code de récupération" | "administrateur";

/**
 * Le cœur commun de toutes les portes de récupération, appelé dans la file des
 * écritures (avant le 23/10/2026, l'outil local écrivait hors file : une
 * connexion simultanée qui renforçait l'empreinte pouvait remettre l'ancien
 * mot de passe par-dessus le nouveau).
 *
 * Un nouveau sel est tiré à chaque fois : réutiliser l'ancien laisserait
 * deviner qu'un mot de passe a changé sans que l'empreinte bouge de forme.
 * À l'appelant de valider le mot de passe et d'être dans la file.
 */
async function redefinir(
  accounts: StoredAccount[],
  compte: StoredAccount,
  motDePasse: string,
  options: {
    par: PorteDeRecuperation;
    /** Mot de passe choisi par quelqu'un d'autre : il ne servira qu'à en choisir un à soi. */
    provisoire?: { expire: string };
    retirerDeuxFacteurs?: boolean;
    action?: "motdepasse.redefini" | "motdepasse.reinitialise";
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const salt = randomBytes(16).toString("hex");
  compte.salt = salt;
  compte.passwordHash = derive(motDePasse, salt);
  compte.iterations = ITERATIONS;
  if (options.provisoire) {
    compte.motDePasseProvisoire = true;
    compte.provisoireExpire = options.provisoire.expire;
  } else {
    // La personne a choisi ce mot de passe elle-même : il n'a plus rien de provisoire.
    delete compte.motDePasseProvisoire;
    delete compte.provisoireExpire;
  }
  const retirerDf = options.retirerDeuxFacteurs === true && Boolean(compte.deuxFacteurs || compte.deuxFacteursEnAttente);
  if (retirerDf) {
    delete compte.deuxFacteurs;
    delete compte.deuxFacteursEnAttente;
  }
  await save(accounts);
  // Le blocage tenait au mot de passe d'avant ; les défis en cours aussi.
  echecs.delete(compte.id);
  for (const [cle, d] of defis) if (d.accountId === compte.id) defis.delete(cle);

  /*
   * Et les séances tombent.
   *
   * C'est la raison même de ces portes : on redéfinit un mot de passe parce
   * qu'on l'a oublié, ou parce que quelqu'un d'autre le connaît. Sans cette
   * ligne, le jeton de séance de cet autre restait valable jusqu'à douze
   * heures, et jusqu'à trente jours tant qu'il s'en servait : changer le mot
   * de passe ne fermait rien.
   */
  const fermees = await revokeAll(compte.id);
  /*
   * Ses clés d'API aussi (revue du 26/09/2026) : sans cela, une séance volée
   * qui avait eu le temps d'en créer une gardait l'accès après la remise à
   * zéro du mot de passe, bases de connaissances comprises.
   */
  const cles = await oublierClesDe(compte.id);

  // Jamais le mot de passe, provisoire ou non, dans la trace.
  journaliser(options.action ?? "motdepasse.redefini", compte.id, {
    par: options.par,
    seancesFermees: fermees,
    clesApiRevoquees: cles,
    ...(retirerDf ? { deuxFacteursRetire: true } : {}),
    ...(options.detail ?? {}),
  });
  if (retirerDf) journaliser("deuxfacteurs.desactive", compte.id, { par: options.par });
}

/**
 * Redéfinit le mot de passe d'un compte, sans connaître l'ancien.
 *
 * Une empreinte PBKDF2 ne se relit pas : c'est voulu, et cela veut dire qu'un
 * mot de passe oublié verrouille l'instance pour de bon. Sur le poste d'une
 * PME, cela signifie perdre l'accès à ses propres dossiers. Il faut donc une
 * porte de service, et elle n'est ouverte qu'à qui tient déjà la machine :
 * cette fonction n'est appelée par aucune route HTTP. Deux appelants
 * seulement : l'outil en ligne de commande (`npm run motdepasse`), et le canal
 * entre l'application de bureau et sa passerelle (`mot-de-passe-local`,
 * index.ts), après que macOS a reconnu la session (Touch ID ou mot de passe
 * de la session), ou, sous Windows et Linux, que la personne a recopié le code
 * écrit dans un fichier de son dossier (electron/motDePasseOublie.cjs).
 * Quelqu'un dans cette position pouvait de toute façon tout lire.
 */
export function definirMotDePasse(
  accountId: string,
  motDePasse: string,
  par: "outil local" | "application de bureau" = "outil local",
  options: { retirerDeuxFacteurs?: boolean } = {},
): Promise<{ ok: boolean; raison?: string }> {
  return enFile(async () => {
    const refus = motDePasseRefuse(motDePasse);
    if (refus) return { ok: false, raison: refus };
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte) return { ok: false, raison: t("Compte introuvable.") };
    await redefinir(accounts, compte, motDePasse, { par, retirerDeuxFacteurs: options.retirerDeuxFacteurs });
    return { ok: true };
  });
}

/* ------------------------------------------------------------------------ */
/*  Réinitialisation par un administrateur                                   */
/* ------------------------------------------------------------------------ */

/** Durée de vie d'un mot de passe provisoire remis par une réinitialisation. */
export const DUREE_PROVISOIRE_MS = 72 * 3600_000;

/** Seize caractères tirés sans caractères qui se confondent (0/O, 1/l/I), par groupes de quatre. */
function provisoireAuHasard(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let brut = "";
  for (let i = 0; i < 16; i++) brut += alphabet[randomInt(alphabet.length)];
  return `${brut.slice(0, 4)}-${brut.slice(4, 8)}-${brut.slice(8, 12)}-${brut.slice(12)}`;
}

/**
 * Un administrateur réinitialise le mot de passe d'un collègue qui l'a oublié.
 *
 * Ce que la porte exige, et pourquoi (décisions du 23/10/2026) :
 *
 *  - **le mot de passe de l'administrateur**, et son code s'il a un second
 *    facteur, à chaque fois. Une séance d'administrateur laissée ouverte, ou
 *    volée, ne doit pas suffire à prendre le compte d'un collègue. Les échecs
 *    comptent dans le même blocage que la connexion de l'administrateur ;
 *  - **jamais son propre compte** : qui connaît son mot de passe le change
 *    dans Réglages ; qui l'a oublié n'a pas de séance pour arriver ici ;
 *  - **jamais un autre administrateur**. Deux administrateurs (profil de
 *    déploiement qui en désigne plusieurs) ont les mêmes pouvoirs : si l'un
 *    pouvait réinitialiser l'autre, le mot de passe d'un seul suffirait à
 *    prendre tous les comptes qui administrent l'instance, et à faire taire
 *    celui qui aurait pu s'en apercevoir. Un administrateur qui a oublié le
 *    sien passe par la machine de l'instance (application de bureau, outil
 *    local) ou par un code de récupération : des preuves qu'un collègue n'a
 *    pas ;
 *  - **un mot de passe tiré par l'instance**, pas choisi par l'administrateur,
 *    montré une fois, **provisoire** (il n'ouvre que le choix d'un mot de
 *    passe à soi) et qui expire au bout de 72 heures ;
 *  - **le second facteur reste**, sauf si l'administrateur coche son retrait
 *    (téléphone perdu aussi). Resté, il protège le compte même contre
 *    l'administrateur qui connaît le provisoire ; retiré, c'est écrit au
 *    journal ;
 *  - séances et clés d'API du compte tombent, et la trace est écrite au nom
 *    du compte réinitialisé, qui la voit dans son propre journal.
 *
 * `cibleAdministre` vient de roles.ts (qui lit ce module : pas d'import en
 * boucle).
 */
export function reinitialiserParAdministrateur(
  administrateurId: string,
  cibleId: unknown,
  motDePasseAdministrateur: unknown,
  codeAdministrateur: unknown,
  retirerDeuxFacteurs: unknown,
  cibleAdministre: (id: string) => Promise<boolean>,
): Promise<{ ok: true; provisoire: string; expire: string; deuxFacteursRetire: boolean } | Refus> {
  return enFile(async () => {
    if (typeof cibleId !== "string" || !cibleId) return { ok: false, statut: 400, reason: t("`accountId` est requis.") };
    if (cibleId === administrateurId) {
      return { ok: false, statut: 400, reason: t("Votre propre mot de passe ne se réinitialise pas ici. Oublié, il se retrouve depuis l'écran de connexion : « Mot de passe oublié ? ».") };
    }
    const accounts = await load();
    const admin = accounts.find((a) => a.id === administrateurId);
    const cible = accounts.find((a) => a.id === cibleId);
    if (!admin) return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    // Le mot de passe de l'administrateur d'abord : sans lui, rien ne se dit, pas même si le compte visé existe.
    const refus = controlerMotDePasse(admin, motDePasseAdministrateur);
    if (refus) return refus;
    if (admin.deuxFacteurs && !consommerCode(admin.deuxFacteurs, codeAdministrateur)) {
      noterEchec(admin.id);
      journaliser("connexion.refusee", admin.id, { motif: "code de vérification incorrect", pour: "réinitialisation" });
      return { ok: false, statut: 403, reason: t("Code de vérification incorrect (celui de l'application, ou un code de secours).") };
    }
    echecs.delete(admin.id);
    // Le code de l'administrateur est consommé : on l'enregistre même si la suite refuse.
    if (!cible) {
      if (admin.deuxFacteurs) await save(accounts);
      return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    }
    if (await cibleAdministre(cible.id)) {
      if (admin.deuxFacteurs) await save(accounts);
      journaliser("motdepasse.reinitialisation_refusee", admin.id, { cible: cible.id, motif: "compte administrateur" });
      return {
        ok: false,
        statut: 403,
        reason: t("Ce compte administre aussi l'instance : son mot de passe ne se réinitialise pas depuis un autre compte. Sur la machine de l'instance, l'écran de connexion de l'application propose « Mot de passe oublié ? » ; sinon, un code de récupération."),
      };
    }
    const provisoire = provisoireAuHasard();
    const expire = new Date(Date.now() + DUREE_PROVISOIRE_MS).toISOString();
    const avaitDf = Boolean(cible.deuxFacteurs);
    // Même tableau : `redefinir` enregistre aussi le code de l'administrateur consommé.
    await redefinir(accounts, cible, provisoire, {
      par: "administrateur",
      provisoire: { expire },
      retirerDeuxFacteurs: retirerDeuxFacteurs === true,
      action: "motdepasse.reinitialise",
      detail: { administrateur: admin.id, expire },
    });
    return { ok: true, provisoire, expire, deuxFacteursRetire: avaitDf && retirerDeuxFacteurs === true };
  });
}

/* ------------------------------------------------------------------------ */
/*  Codes de récupération                                                    */
/* ------------------------------------------------------------------------ */

export interface EtatRecuperation {
  restants: number;
  creeLe?: string;
  /** Faut-il un code de vérification pour en tirer de nouveaux ? */
  deuxFacteursActive: boolean;
}

export async function etatRecuperation(accountId: string): Promise<EtatRecuperation | null> {
  const compte = (await load()).find((a) => a.id === accountId);
  if (!compte) return null;
  return {
    restants: compte.recuperation?.empreintes.length ?? 0,
    ...(compte.recuperation ? { creeLe: compte.recuperation.creeLe } : {}),
    deuxFacteursActive: Boolean(compte.deuxFacteurs),
  };
}

/**
 * Nouvelle série de dix codes de récupération ; l'ancienne cesse aussitôt de
 * valoir. Mot de passe exigé, et code si le second facteur est actif : une
 * séance laissée ouverte ne doit pas suffire à se fabriquer une porte de
 * retour dans le compte d'un autre.
 */
export function creerCodesRecuperation(
  accountId: string,
  motDePasse: unknown,
  code: unknown,
): Promise<{ ok: true; codes: string[] } | Refus> {
  return enFile(async () => {
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte) return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    const refus = controlerMotDePasse(compte, motDePasse);
    if (refus) return refus;
    if (compte.deuxFacteurs && !consommerCode(compte.deuxFacteurs, code)) {
      noterEchec(accountId);
      return { ok: false, statut: 403, reason: t("Code de vérification incorrect (celui de l'application, ou un code de secours).") };
    }
    const serie = nouveauxCodesDeSecours();
    const remplace = Boolean(compte.recuperation);
    compte.recuperation = { empreintes: serie.empreintes, sel: serie.sel, creeLe: new Date().toISOString() };
    await save(accounts);
    echecs.delete(accountId);
    journaliser("recuperation.codes_crees", accountId, { nombre: serie.codes.length, ...(remplace ? { remplacent: true } : {}) });
    return { ok: true, codes: serie.codes };
  });
}

/**
 * Mot de passe oublié, code de récupération en main : le code (usage unique)
 * redéfinit le mot de passe. Au jeton seul, comme la connexion. Le second
 * facteur, s'il est actif, reste exigé à la connexion qui suit.
 *
 * Même réponse que le compte ait des codes ou non : la route ne dit pas qui en
 * a. Chaque échec compte dans le blocage du compte, et la route est bornée par
 * appelant (debit.ts).
 */
export function recupererParCode(
  accountId: unknown,
  code: unknown,
  nouveau: unknown,
): Promise<{ ok: true } | Refus> {
  return enFile(async () => {
    if (typeof accountId !== "string" || !accountId) return { ok: false, statut: 400, reason: t("`accountId` est requis.") };
    const blocage = refusBlocage(accountId);
    if (blocage) return blocage;
    const refus = motDePasseRefuse(nouveau);
    if (refus) return { ok: false, statut: 400, reason: refus };
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    const indice =
      compte?.recuperation && typeof code === "string" && code.length <= 64
        ? trouverSecours(code, compte.recuperation.sel, compte.recuperation.empreintes)
        : -1;
    if (!compte || !compte.recuperation || indice < 0) {
      noterEchec(accountId);
      if (compte) journaliser("connexion.refusee", compte.id, { motif: "code de récupération incorrect" });
      return { ok: false, statut: 401, reason: t("Code de récupération incorrect.") };
    }
    compte.recuperation.empreintes.splice(indice, 1);
    await redefinir(accounts, compte, nouveau as string, {
      par: "code de récupération",
      detail: { codesDeRecuperationRestants: compte.recuperation.empreintes.length },
    });
    return { ok: true };
  });
}

/**
 * Premier mot de passe d'un compte créé sans.
 *
 * Ne vaut que pour un compte qui n'en a **aucun** : pour changer un mot de
 * passe existant, il faut connaître l'ancien, ou passer par l'outil local.
 *
 * Exposition, pesée : avant, quiconque tenait le jeton d'instance ouvrait une
 * séance sur un compte sans mot de passe par simple sélection. Désormais, la
 * même personne pourrait tout au plus poser le mot de passe à la place du
 * titulaire, une seule fois. La fenêtre n'est pas plus large qu'avant, et
 * elle se ferme définitivement au premier usage. En cas de litige, l'outil
 * local (`npm run motdepasse`) tranche, depuis le poste.
 */
export function definirPremierMotDePasse(
  accountId: string,
  motDePasse: unknown,
): Promise<{ ok: true; account: PublicAccount } | { ok: false; reason: string; statut: number }> {
  return enFile(async () => {
    const refus = motDePasseRefuse(motDePasse);
    if (refus) return { ok: false, reason: refus, statut: 400 };

    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte) return { ok: false, reason: t("Compte introuvable."), statut: 404 };
    if (compte.passwordHash && compte.salt) {
      return { ok: false, reason: t("Ce compte a déjà un mot de passe."), statut: 409 };
    }

    const salt = randomBytes(16).toString("hex");
    compte.salt = salt;
    compte.passwordHash = derive(motDePasse as string, salt);
    compte.iterations = ITERATIONS;
    await save(accounts);
    journaliser("motdepasse.defini", accountId, {});
    return { ok: true, account: toPublic(compte) };
  });
}

/**
 * Remplace le mot de passe provisoire par celui que la personne choisit : il
 * faut le provisoire (compté dans le même blocage que la connexion), et un
 * nouveau différent. Le compte redevient alors un compte comme les autres.
 */
export function remplacerMotDePasseProvisoire(
  accountId: string,
  provisoire: unknown,
  nouveau: unknown,
): Promise<{ ok: true } | { ok: false; reason: string; statut: number }> {
  return enFile(async () => {
    const attente = blocageRestant(accountId);
    if (attente > 0) return { ok: false, reason: tf("Trop de tentatives. Réessayez dans {0} secondes.", String(Math.ceil(attente / 1000))), statut: 429 };
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte || !compte.passwordHash || !compte.salt) return { ok: false, reason: t("Compte introuvable."), statut: 404 };
    if (!compte.motDePasseProvisoire) return { ok: false, reason: t("Ce compte a déjà son propre mot de passe."), statut: 409 };
    if (provisoireExpire(compte)) return { ok: false, reason: t("Ce mot de passe provisoire a expiré. Demandez-en un nouveau à l'administrateur."), statut: 410 };
    if (typeof provisoire !== "string" || !motDePasseJuste(compte, provisoire)) {
      noterEchec(accountId);
      journaliser("connexion.refusee", accountId, { motif: "mot de passe provisoire incorrect" });
      return { ok: false, reason: t("Mot de passe provisoire incorrect."), statut: 401 };
    }
    const refus = motDePasseRefuse(nouveau);
    if (refus) return { ok: false, reason: refus, statut: 400 };
    if (nouveau === provisoire) return { ok: false, reason: t("Choisissez un mot de passe différent de celui qu'on vous a donné."), statut: 400 };
    const salt = randomBytes(16).toString("hex");
    compte.salt = salt;
    compte.passwordHash = derive(nouveau as string, salt);
    compte.iterations = ITERATIONS;
    delete compte.motDePasseProvisoire;
    delete compte.provisoireExpire;
    await save(accounts);
    journaliser("motdepasse.defini", accountId, { remplaceLeProvisoire: true });
    return { ok: true };
  });
}

/** Le mot de passe provisoire d'une réinitialisation a-t-il passé sa date ? */
function provisoireExpire(compte: StoredAccount): boolean {
  if (!compte.motDePasseProvisoire || !compte.provisoireExpire) return false;
  const fin = Date.parse(compte.provisoireExpire);
  // Une date illisible ne prolonge rien : elle vaut expirée.
  return !Number.isFinite(fin) || fin <= Date.now();
}

/** Combien de temps ce compte reste-t-il bloqué ? 0 s'il ne l'est pas. */
function blocageRestant(accountId: string): number {
  const suivi = echecs.get(accountId);
  if (!suivi) return 0;
  const reste = suivi.jusqua - Date.now();
  if (reste <= 0) return 0;
  return reste;
}

function noterEchec(accountId: string): void {
  const suivi = echecs.get(accountId) ?? { compte: 0, jusqua: 0 };
  suivi.compte += 1;
  if (suivi.compte >= MAX_ECHECS) {
    const series = suivi.compte - MAX_ECHECS;
    suivi.jusqua = Date.now() + Math.min(BLOCAGE_BASE_MS * 2 ** series, BLOCAGE_MAX_MS);
  }
  echecs.set(accountId, suivi);
}

export async function verifyAccount(
  accountId: string,
  password?: string,
): Promise<
  | { ok: true; account: PublicAccount }
  | { ok: false; reason: string; aDefinir?: boolean; aChanger?: boolean; defi?: string; inscription?: string }
> {
  const attente = blocageRestant(accountId);
  if (attente > 0) {
    const secondes = Math.ceil(attente / 1000);
    journaliser("connexion.bloquee", accountId, { secondesRestantes: secondes });
    return {
      ok: false,
      reason: secondes > 1 ? tf("Trop de tentatives. Réessayez dans {0} secondes.", secondes) : t("Trop de tentatives. Réessayez dans une seconde."),
    };
  }

  const account = (await load()).find((a) => a.id === accountId);
  if (!account) return { ok: false, reason: t("Compte introuvable.") };

  /*
   * Compte créé sans mot de passe, avant que la règle ne change : il ne
   * s'ouvre plus par simple sélection. La personne doit d'abord en définir un
   * (`definirPremierMotDePasse`) ; ensuite, le compte est protégé comme les
   * autres.
   */
  if (!account.passwordHash || !account.salt) {
    return { ok: false, reason: t("Ce compte n'a pas encore de mot de passe : définissez-en un."), aDefinir: true };
  }
  if (!password) {
    noterEchec(accountId);
    return { ok: false, reason: t("Mot de passe requis.") };
  }

  const valid = motDePasseJuste(account, password);

  if (!valid) {
    noterEchec(accountId);
    journaliser("connexion.refusee", accountId, { motif: "mot de passe incorrect" });
    return { ok: false, reason: t("Mot de passe incorrect.") };
  }
  // Empreinte d'avant les 600 000 itérations : refaite maintenant que le mot de passe est connu.
  if ((account.iterations ?? ITERATIONS_ANCIENNES) < ITERATIONS) void renforcerEmpreinte(accountId, account.passwordHash, password);

  /*
   * Mot de passe choisi par qui a créé le compte : il est juste, mais il
   * n'ouvre rien d'autre que le choix d'un mot de passe à soi. Sans cela, la
   * personne qui a créé le compte le connaissait pour toujours et pouvait s'y
   * connecter à volonté (revue du 26/09/2026).
   */
  if (account.motDePasseProvisoire) {
    echecs.delete(accountId);
    /*
     * Réinitialisation par un administrateur (23/10/2026) : le provisoire
     * expire. Passé ce délai, il n'ouvre plus rien, pas même le choix.
     */
    if (provisoireExpire(account)) {
      journaliser("connexion.refusee", accountId, { motif: "mot de passe provisoire expiré" });
      return { ok: false, reason: t("Ce mot de passe provisoire a expiré. Demandez-en un nouveau à l'administrateur.") };
    }
    return {
      ok: false,
      reason: account.provisoireExpire
        ? t("Choisissez votre propre mot de passe : celui-ci vous a été donné par l'administrateur qui a réinitialisé le vôtre.")
        : t("Choisissez votre propre mot de passe : celui-ci a été choisi par la personne qui a créé votre compte."),
      aChanger: true,
    };
  }

  /*
   * Mot de passe juste, second facteur actif : pas encore de séance. Les échecs
   * ne sont **pas** remis à zéro ici, sans quoi quelqu'un qui connaît le mot de
   * passe pourrait alterner mot de passe et codes au hasard sans jamais
   * atteindre le verrouillage. Ils ne le sont qu'une fois le code accepté.
   */
  if (account.deuxFacteurs) {
    journaliser("connexion.second_facteur_demande", accountId, {});
    return {
      ok: false,
      reason: t("Saisissez le code affiché par votre application d'authentification."),
      defi: nouveauDefi(accountId),
    };
  }

  echecs.delete(accountId);

  /*
   * Instance qui impose le second facteur, compte qui n'en a pas : le mot de
   * passe est prouvé, mais la séance attendra que le second facteur soit
   * activé. Le défi d'inscription tient lieu de preuve du mot de passe pour
   * les deux pas suivants.
   */
  if (deuxFacteursObligatoire()) {
    journaliser("connexion.second_facteur_a_activer", accountId, {});
    return {
      ok: false,
      reason: t("Votre instance exige la double authentification : activez-la pour vous connecter."),
      inscription: nouveauDefi(accountId, "inscription"),
    };
  }

  journaliser("connexion.reussie", accountId, {});
  return { ok: true, account: toPublic(account) };
}

/** L'instance impose-t-elle le second facteur à tous ? */
export const deuxFacteursObligatoire = (): boolean => deployment().deuxFacteursObligatoire === true;

/**
 * Un compte peut-il se servir d'une séance ? Non si l'instance impose le
 * second facteur et qu'il n'en a pas : une séance ouverte avant que la règle
 * ne soit posée ne doit pas la contourner.
 */
export function seanceAdmise(compte: PublicAccount): boolean {
  return !deuxFacteursObligatoire() || compte.deuxFacteursActive;
}

/* ------------------------------------------------------------------ */
/* Modification de son propre profil                                   */
/* ------------------------------------------------------------------ */

const NOM_MAX = 120;
const ADRESSE_MAX = 254;
// Caractères de contrôle : invisibles à l'écran, ils feraient d'un nom un piège.
const NON_AFFICHABLE = /[\u0000-\u001f\u007f]/;

export type ResultatProfil =
  | { ok: true; account: PublicAccount }
  /*
   * Jamais 401 pour un mot de passe refusé : l'interface lit tout 401 reçu
   * avec une séance comme une séance expirée, et ramène à l'écran de
   * connexion (`apiFetch`, src/lib/endpoint.ts). Une faute de frappe dans le
   * mot de passe déconnectait donc la personne. La séance est valide ; c'est
   * l'action qui est refusée, d'où 403.
   */
  | { ok: false; statut: 400 | 403 | 404 | 409 | 429; reason: string };

/**
 * Modifie le nom et, ou, l'adresse d'un compte.
 *
 * Cette fonction ne choisit pas le compte : c'est la route qui lui passe
 * l'identifiant tiré de la séance, jamais une valeur venue de la requête.
 *
 * Tout est validé avant que rien ne soit écrit : un nom accepté suivi d'une
 * adresse refusée laisserait la personne croire que rien n'a changé.
 *
 * L'adresse est un identifiant, d'où trois exigences :
 *  - le mot de passe actuel, si le compte en a un. Une séance se vole plus
 *    facilement qu'un mot de passe (poste resté ouvert) ; sans cette
 *    exigence, quelques secondes devant l'écran d'un collègue suffiraient à
 *    lui prendre son identifiant de connexion. Chaque échec compte dans le
 *    même blocage que la connexion, pour qu'on ne puisse pas deviner le mot
 *    de passe par cette route à la place de l'autre ;
 *  - une adresse libre, et qui n'a jamais servi à un autre compte
 *    (`adresseReservee`) ;
 *  - aucun héritage : l'adresse devient déclarée (`adresseDeclareeLe`), et une
 *    adresse déclarée ne rattache aucune invitation en attente
 *    (`adresseDePartage`).
 */
export function modifierProfil(
  accountId: string,
  changements: { fullName?: unknown; email?: unknown; password?: unknown; photo?: unknown },
): Promise<ResultatProfil> {
  return enFile(() => appliquerProfil(accountId, changements));
}

/** Taille maximale d'une photo, une fois décodée : largement de quoi faire 256 pixels. */
const PHOTO_MAX = 80 * 1024;

/**
 * Une photo n'est acceptée que si elle est bien une image : type déclaré ET
 * signature des premiers octets. Une « image » qui serait du SVG ou du HTML
 * n'est jamais stockée ; elle s'afficherait sur les postes des collègues.
 */
function photoValide(v: string): boolean {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (!m) return false;
  const octets = Buffer.from(m[2] ?? "", "base64");
  if (octets.length === 0 || octets.length > PHOTO_MAX) return false;
  const debut = octets.subarray(0, 12);
  if (m[1] === "jpeg") return debut[0] === 0xff && debut[1] === 0xd8 && debut[2] === 0xff;
  if (m[1] === "png") return debut.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return debut.subarray(0, 4).toString("latin1") === "RIFF" && debut.subarray(8, 12).toString("latin1") === "WEBP";
}

async function appliquerProfil(
  accountId: string,
  changements: { fullName?: unknown; email?: unknown; password?: unknown; photo?: unknown },
): Promise<ResultatProfil> {
  const accounts = await load();
  const compte = accounts.find((a) => a.id === accountId);
  if (!compte) return { ok: false, statut: 404, reason: t("Compte introuvable.") };

  /* ---- Photo : une image valide, ou `null` pour la retirer ---- */
  if (changements.photo !== undefined) {
    if (changements.photo === null || changements.photo === "") {
      if (compte.photo) {
        delete compte.photo;
        await save(accounts);
        journaliser("compte.photo_modifiee", accountId, { retiree: true });
      }
      return { ok: true, account: toPublic(compte) };
    }
    if (typeof changements.photo !== "string" || !photoValide(changements.photo)) {
      return { ok: false, statut: 400, reason: t("Photo refusée : une image JPEG, PNG ou WebP de 80 Ko au plus.") };
    }
    compte.photo = changements.photo;
    await save(accounts);
    journaliser("compte.photo_modifiee", accountId, { octets: Math.round((changements.photo.length * 3) / 4) });
    return { ok: true, account: toPublic(compte) };
  }

  /*
   * Échec fermé : un champ présent mais qui n'est pas du texte n'est pas
   * « rien à changer », c'est une requête qu'on ne comprend pas.
   */
  for (const champ of ["fullName", "email", "password"] as const) {
    const valeur = changements[champ];
    if (valeur !== undefined && typeof valeur !== "string") {
      return { ok: false, statut: 400, reason: tf("Le champ « {0} » doit être du texte.", champ) };
    }
  }
  const nomDemande = changements.fullName as string | undefined;
  const adresseDemandee = changements.email as string | undefined;
  const motDePasse = changements.password as string | undefined;

  /* ---- Nom ---- */
  let nouveauNom: string | null = null;
  if (nomDemande !== undefined) {
    if (NON_AFFICHABLE.test(nomDemande.replace(/[\t\n\r]/g, " "))) {
      return { ok: false, statut: 400, reason: t("Le nom contient des caractères non affichables.") };
    }
    const nom = nomDemande.trim().replace(/\s+/g, " ");
    if (!nom) return { ok: false, statut: 400, reason: t("Le nom ne peut pas être vide.") };
    if (nom.length > NOM_MAX) {
      return { ok: false, statut: 400, reason: tf("Le nom dépasse {0} caractères.", NOM_MAX) };
    }
    if (nom !== compte.fullName) nouveauNom = nom;
  }

  /* ---- Adresse ---- */
  let nouvelleAdresse: string | null = null;
  if (adresseDemandee !== undefined) {
    const adresse = normalise(adresseDemandee);
    if (adresse !== normalise(compte.email)) {
      if (!FORME_EMAIL.test(adresse) || adresse.length > ADRESSE_MAX) {
        return { ok: false, statut: 400, reason: t("Adresse email invalide.") };
      }

      /*
       * Le mot de passe avant l'unicité : sans lui, une séance volée servirait
       * au moins à sonder quelles adresses ont déjà servi sur l'instance.
       */
      if (compte.passwordHash && compte.salt) {
        const attente = blocageRestant(accountId);
        if (attente > 0) {
          const secondes = Math.ceil(attente / 1000);
          journaliser("connexion.bloquee", accountId, { secondesRestantes: secondes });
          return {
            ok: false,
            statut: 429,
            reason: secondes > 1 ? tf("Trop de tentatives. Réessayez dans {0} secondes.", secondes) : t("Trop de tentatives. Réessayez dans une seconde."),
          };
        }
        if (!motDePasse) {
          return {
            ok: false,
            statut: 400,
            reason: t("Votre mot de passe actuel est requis pour changer d'adresse."),
          };
        }
        if (!motDePasseJuste(compte, motDePasse)) {
          noterEchec(accountId);
          // Le mot de passe essayé ne figure évidemment pas dans la trace.
          journaliser("compte.adresse_refusee", accountId, { motif: "mot de passe incorrect" });
          return { ok: false, statut: 403, reason: t("Mot de passe incorrect.") };
        }
        echecs.delete(accountId);
      }

      const reservee = adresseReservee(accounts, adresse, accountId);
      if (reservee === "actuelle") {
        return { ok: false, statut: 409, reason: t("Un compte existe déjà avec cette adresse.") };
      }
      if (reservee === "ancienne") {
        return {
          ok: false,
          statut: 409,
          reason: t("Cette adresse a déjà servi à un compte de l'instance."),
        };
      }
      nouvelleAdresse = adresse;
    }
  }

  if (nouveauNom === null && nouvelleAdresse === null) {
    return { ok: true, account: toPublic(compte) };
  }

  /* ---- Écriture, en une fois ---- */
  const nomAvant = compte.fullName;
  const adresseAvant = normalise(compte.email);

  if (nouveauNom !== null) {
    compte.fullName = nouveauNom;
    compte.initials = initialsOf(nouveauNom);
  }
  if (nouvelleAdresse !== null) {
    const adresse = nouvelleAdresse;
    compte.anciennesAdresses = [
      ...new Set([...(compte.anciennesAdresses ?? []), adresseAvant]),
    ].filter((a) => a !== adresse);
    compte.email = adresse;
    // L'identifiant affiché est tiré de l'adresse, comme à la création.
    compte.handle = adresse.split("@")[0] || compte.fullName;
    compte.adresseDeclareeLe = new Date().toISOString();
  }

  await save(accounts);

  if (nouveauNom !== null) {
    journaliser("compte.nom_modifie", accountId, { avant: nomAvant, apres: nouveauNom });
  }
  if (nouvelleAdresse !== null) {
    journaliser("compte.adresse_modifiee", accountId, {
      avant: adresseAvant,
      apres: nouvelleAdresse,
      motDePasseVerifie: Boolean(compte.passwordHash),
    });
  }
  return { ok: true, account: toPublic(compte) };
}

/* ------------------------------------------------------------------------ */
/*  Second facteur                                                           */
/* ------------------------------------------------------------------------ */

/*
 * Défi de connexion : ce que reçoit un poste dont le mot de passe était juste,
 * pour prouver au pas suivant qu'il l'a bien été. Il vit cinq minutes, sert
 * une fois, et tombe après cinq codes faux : il faut alors repasser par le mot
 * de passe. Gardé en mémoire seulement, un redémarrage de l'instance les
 * annule tous, ce qui ne coûte qu'une nouvelle saisie.
 */
const DUREE_DEFI_MS = 5 * 60_000;
const ESSAIS_PAR_DEFI = 5;
/** Un secret non confirmé au bout d'un quart d'heure est jeté. */
const DUREE_ATTENTE_MS = 15 * 60_000;

/**
 * Deux sortes de défis, qui ne s'échangent pas : `connexion` (le code est
 * attendu) et `inscription` (le second facteur est à activer, instance qui
 * l'impose). Un défi d'inscription vit un quart d'heure : il faut le temps de
 * sortir son téléphone et d'installer une application.
 */
type SorteDefi = "connexion" | "inscription";

const defis = new Map<
  string,
  { accountId: string; expire: number; essais: number; sorte: SorteDefi; secret?: string }
>();

function nouveauDefi(accountId: string, sorte: SorteDefi = "connexion"): string {
  const maintenant = Date.now();
  for (const [cle, d] of defis) if (d.expire <= maintenant) defis.delete(cle);
  const cle = randomBytes(24).toString("base64url");
  const duree = sorte === "inscription" ? DUREE_ATTENTE_MS : DUREE_DEFI_MS;
  defis.set(cle, { accountId, expire: maintenant + duree, essais: 0, sorte });
  return cle;
}

/** Défi valide de la sorte attendue, ou rien : un défi d'une autre sorte ne sert pas. */
function defiValide(defi: unknown, sorte: SorteDefi) {
  const d = typeof defi === "string" ? defis.get(defi) : undefined;
  if (!d || d.expire <= Date.now() || d.sorte !== sorte) {
    if (typeof defi === "string" && d && d.expire <= Date.now()) defis.delete(defi);
    return null;
  }
  return d;
}

type Refus = { ok: false; reason: string; statut: number };

function refusBlocage(accountId: string): Refus | null {
  const attente = blocageRestant(accountId);
  if (attente <= 0) return null;
  const secondes = Math.ceil(attente / 1000);
  journaliser("connexion.bloquee", accountId, { secondesRestantes: secondes });
  return {
    ok: false,
    statut: 429,
    reason: secondes > 1 ? tf("Trop de tentatives. Réessayez dans {0} secondes.", secondes) : t("Trop de tentatives. Réessayez dans une seconde."),
  };
}

/**
 * Le mot de passe du compte, redemandé avant toute modification du second
 * facteur : une séance laissée ouverte sur un poste ne doit suffire ni à
 * l'activer avec le téléphone d'un autre, ni à le retirer.
 */
function controlerMotDePasse(compte: StoredAccount, motDePasse: unknown): Refus | null {
  const blocage = refusBlocage(compte.id);
  if (blocage) return blocage;
  if (!compte.passwordHash || !compte.salt) {
    return { ok: false, statut: 409, reason: t("Définissez d'abord un mot de passe.") };
  }
  if (typeof motDePasse !== "string" || !motDePasse) {
    return { ok: false, statut: 400, reason: t("Votre mot de passe est requis.") };
  }
  if (!motDePasseJuste(compte, motDePasse)) {
    noterEchec(compte.id);
    journaliser("connexion.refusee", compte.id, { motif: "mot de passe incorrect", pour: "second facteur" });
    return { ok: false, statut: 403, reason: t("Mot de passe incorrect.") };
  }
  return null;
}

/**
 * Consomme un code : celui de l'application, ou l'un des codes de secours.
 * Modifie le compte en mémoire (pas consommé, code de secours retiré) ; à
 * l'appelant d'enregistrer.
 */
function consommerCode(
  df: DeuxFacteurs,
  code: unknown,
): { facteur: "application" | "code de secours" } | null {
  if (typeof code !== "string" || !code.trim() || code.length > 64) return null;
  const pas = verifierCode(df.secret, code, df.dernierPas);
  if (pas !== null) {
    df.dernierPas = pas;
    return { facteur: "application" };
  }
  const indice = trouverSecours(code, df.selSecours, df.secours);
  if (indice >= 0) {
    df.secours.splice(indice, 1);
    return { facteur: "code de secours" };
  }
  return null;
}

/** Second pas de la connexion. En cas de succès, l'appelant ouvre la séance. */
export function validerSecondFacteur(
  defi: unknown,
  code: unknown,
): Promise<{ ok: true; account: PublicAccount } | (Refus & { expire?: boolean })> {
  return enFile(async () => {
    const d = defiValide(defi, "connexion");
    if (!d) {
      return {
        ok: false,
        statut: 401,
        expire: true,
        reason: t("Délai dépassé : saisissez de nouveau votre mot de passe."),
      };
    }

    const blocage = refusBlocage(d.accountId);
    if (blocage) return blocage;

    const accounts = await load();
    const compte = accounts.find((a) => a.id === d.accountId);
    if (!compte?.deuxFacteurs) {
      defis.delete(defi as string);
      return { ok: false, statut: 401, expire: true, reason: t("Saisissez de nouveau votre mot de passe.") };
    }

    const reconnu = consommerCode(compte.deuxFacteurs, code);
    if (!reconnu) {
      noterEchec(compte.id);
      d.essais += 1;
      journaliser("connexion.refusee", compte.id, { motif: "code de vérification incorrect" });
      if (d.essais >= ESSAIS_PAR_DEFI) {
        defis.delete(defi as string);
        return {
          ok: false,
          statut: 401,
          expire: true,
          reason: t("Trop de codes erronés : saisissez de nouveau votre mot de passe."),
        };
      }
      return {
        ok: false,
        statut: 401,
        reason: t("Code incorrect. Vérifiez aussi que l'heure du téléphone est juste."),
      };
    }

    await save(accounts);
    defis.delete(defi as string);
    echecs.delete(compte.id);
    journaliser("connexion.reussie", compte.id, {
      facteur: reconnu.facteur,
      ...(reconnu.facteur === "code de secours"
        ? { codesDeSecoursRestants: compte.deuxFacteurs.secours.length }
        : {}),
    });
    return { ok: true, account: toPublic(compte) };
  });
}

export interface EtatDeuxFacteurs {
  active: boolean;
  /** Imposée par l'instance : l'interface ne propose alors pas de la retirer. */
  obligatoire: boolean;
  activeLe?: string;
  codesDeSecoursRestants?: number;
}

export async function etatDeuxFacteurs(accountId: string): Promise<EtatDeuxFacteurs | null> {
  const compte = (await load()).find((a) => a.id === accountId);
  if (!compte) return null;
  const obligatoire = deuxFacteursObligatoire();
  if (!compte.deuxFacteurs) return { active: false, obligatoire };
  return {
    active: true,
    obligatoire,
    activeLe: compte.deuxFacteurs.activeLe,
    codesDeSecoursRestants: compte.deuxFacteurs.secours.length,
  };
}

/**
 * Premier temps de l'activation : tire le secret que la personne va scanner.
 * Rien n'est encore exigé à la connexion.
 */
export function preparerDeuxFacteurs(
  accountId: string,
  motDePasse: unknown,
): Promise<{ ok: true; secret: string } | Refus> {
  return enFile(async () => {
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte) return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    if (compte.deuxFacteurs) {
      return { ok: false, statut: 409, reason: t("La vérification en deux étapes est déjà active.") };
    }
    const refus = controlerMotDePasse(compte, motDePasse);
    if (refus) return refus;

    const secret = nouveauSecret();
    compte.deuxFacteursEnAttente = { secret, creeLe: new Date().toISOString() };
    await save(accounts);
    return { ok: true, secret };
  });
}

/**
 * Second temps : un premier code juste prouve que l'application a bien
 * enregistré le secret. Alors seulement le second facteur devient exigé, et
 * les codes de secours sont remis, une seule fois.
 */
export function activerDeuxFacteurs(
  accountId: string,
  code: unknown,
): Promise<{ ok: true; codesDeSecours: string[] } | Refus> {
  return enFile(async () => {
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte) return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    if (compte.deuxFacteurs) {
      return { ok: false, statut: 409, reason: t("La vérification en deux étapes est déjà active.") };
    }
    const attente = compte.deuxFacteursEnAttente;
    if (!attente || Date.now() - Date.parse(attente.creeLe) > DUREE_ATTENTE_MS) {
      return {
        ok: false,
        statut: 409,
        reason: t("Le code à scanner a expiré. Recommencez l'activation."),
      };
    }
    const pas = typeof code === "string" ? verifierCode(attente.secret, code, undefined) : null;
    if (pas === null) {
      return {
        ok: false,
        statut: 400,
        reason: t("Code incorrect. Vérifiez que l'heure du téléphone est juste, puis saisissez le code affiché."),
      };
    }

    const secours = nouveauxCodesDeSecours();
    compte.deuxFacteurs = {
      secret: attente.secret,
      activeLe: new Date().toISOString(),
      dernierPas: pas,
      secours: secours.empreintes,
      selSecours: secours.sel,
    };
    delete compte.deuxFacteursEnAttente;
    await save(accounts);
    journaliser("deuxfacteurs.active", accountId, {});
    return { ok: true, codesDeSecours: secours.codes };
  });
}

/**
 * Activation imposée, à la connexion : premier temps, le secret à scanner.
 * Le défi d'inscription prouve le mot de passe, saisi juste avant.
 */
export function preparerInscription(
  defi: unknown,
): Promise<{ ok: true; secret: string } | (Refus & { expire?: boolean })> {
  return enFile(async () => {
    const d = defiValide(defi, "inscription");
    if (!d) {
      return {
        ok: false,
        statut: 401,
        expire: true,
        reason: t("Délai dépassé : saisissez de nouveau votre mot de passe."),
      };
    }
    // Un même défi garde son secret : recharger l'écran ne change pas le QR code.
    d.secret ??= nouveauSecret();
    return { ok: true, secret: d.secret };
  });
}

/** Activation imposée, second temps : premier code juste, séance ouverte par l'appelant. */
export function activerInscription(
  defi: unknown,
  code: unknown,
): Promise<
  | { ok: true; account: PublicAccount; codesDeSecours: string[] }
  | (Refus & { expire?: boolean })
> {
  return enFile(async () => {
    const d = defiValide(defi, "inscription");
    if (!d?.secret) {
      return {
        ok: false,
        statut: 401,
        expire: true,
        reason: t("Délai dépassé : saisissez de nouveau votre mot de passe."),
      };
    }
    const pas = typeof code === "string" ? verifierCode(d.secret, code, undefined) : null;
    if (pas === null) {
      d.essais += 1;
      if (d.essais >= ESSAIS_PAR_DEFI) {
        defis.delete(defi as string);
        return {
          ok: false,
          statut: 401,
          expire: true,
          reason: t("Trop de codes erronés : saisissez de nouveau votre mot de passe."),
        };
      }
      return {
        ok: false,
        statut: 400,
        reason: t("Code incorrect. Vérifiez que l'heure du téléphone est juste, puis saisissez le code affiché."),
      };
    }

    const accounts = await load();
    const compte = accounts.find((a) => a.id === d.accountId);
    if (!compte) return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    const secours = nouveauxCodesDeSecours();
    compte.deuxFacteurs = {
      secret: d.secret,
      activeLe: new Date().toISOString(),
      dernierPas: pas,
      secours: secours.empreintes,
      selSecours: secours.sel,
    };
    delete compte.deuxFacteursEnAttente;
    await save(accounts);
    defis.delete(defi as string);
    journaliser("deuxfacteurs.active", compte.id, { imposee: true });
    journaliser("connexion.reussie", compte.id, { facteur: "application", inscription: true });
    return { ok: true, account: toPublic(compte), codesDeSecours: secours.codes };
  });
}

/**
 * Défi d'inscription pour un compte qui vient de prouver son mot de passe par
 * une autre voie (création à l'amorçage, premier mot de passe).
 */
export function defiInscription(accountId: string): string {
  return nouveauDefi(accountId, "inscription");
}

/** Retrait par la personne elle-même : mot de passe et code exigés. */
export function desactiverDeuxFacteurs(
  accountId: string,
  motDePasse: unknown,
  code: unknown,
): Promise<{ ok: true; account: PublicAccount } | Refus> {
  return enFile(async () => {
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte) return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    if (!compte.deuxFacteurs) {
      return { ok: false, statut: 409, reason: t("La vérification en deux étapes n'est pas active.") };
    }
    if (deuxFacteursObligatoire()) {
      return {
        ok: false,
        statut: 403,
        reason: t("Votre instance impose la double authentification : elle ne peut pas être retirée."),
      };
    }
    const refus = controlerMotDePasse(compte, motDePasse);
    if (refus) return refus;
    if (!consommerCode(compte.deuxFacteurs, code)) {
      noterEchec(accountId);
      return { ok: false, statut: 403, reason: t("Code incorrect.") };
    }
    delete compte.deuxFacteurs;
    await save(accounts);
    echecs.delete(accountId);
    journaliser("deuxfacteurs.desactive", accountId, { par: "titulaire" });
    return { ok: true, account: toPublic(compte) };
  });
}

/** Nouvelle série de codes de secours ; l'ancienne cesse aussitôt de valoir. */
export function regenererCodesDeSecours(
  accountId: string,
  motDePasse: unknown,
  code: unknown,
): Promise<{ ok: true; codesDeSecours: string[] } | Refus> {
  return enFile(async () => {
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte) return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    if (!compte.deuxFacteurs) {
      return { ok: false, statut: 409, reason: t("La vérification en deux étapes n'est pas active.") };
    }
    const refus = controlerMotDePasse(compte, motDePasse);
    if (refus) return refus;
    if (!consommerCode(compte.deuxFacteurs, code)) {
      noterEchec(accountId);
      return { ok: false, statut: 403, reason: t("Code incorrect.") };
    }
    const secours = nouveauxCodesDeSecours();
    compte.deuxFacteurs.secours = secours.empreintes;
    compte.deuxFacteurs.selSecours = secours.sel;
    await save(accounts);
    echecs.delete(accountId);
    journaliser("deuxfacteurs.codes_regeneres", accountId, {});
    return { ok: true, codesDeSecours: secours.codes };
  });
}

/**
 * Retrait sans code, pour qui a perdu téléphone **et** codes de secours.
 * Comme `definirMotDePasse`, aucune route HTTP n'y mène : seul l'outil local,
 * lancé sur le poste qui détient le trousseau, l'appelle.
 */
export async function retirerDeuxFacteurs(accountId: string): Promise<{ ok: boolean; raison?: string }> {
  const accounts = await load();
  const compte = accounts.find((a) => a.id === accountId);
  if (!compte) return { ok: false, raison: t("Compte introuvable.") };
  if (!compte.deuxFacteurs) return { ok: false, raison: t("Ce compte n'a pas de second facteur.") };
  delete compte.deuxFacteurs;
  delete compte.deuxFacteursEnAttente;
  await save(accounts);
  // Même raison que pour le mot de passe : cet outil sert quand on a perdu la
  // main, et une séance ouverte avant garderait ce que l'on vient de retirer.
  const fermees = await revokeAll(accountId);
  const cles = await oublierClesDe(accountId);
  journaliser("deuxfacteurs.desactive", accountId, { par: "outil local", seancesFermees: fermees, clesApiRevoquees: cles });
  return { ok: true };
}

/*
 * ------------------------------------------------------------------------
 *  Effacement (voir gateway/src/effacement.ts, qui orchestre l'ensemble)
 * ------------------------------------------------------------------------
 */

/**
 * La personne confirme qu'elle est bien elle : mot de passe, et code (ou code
 * de secours) si son second facteur est actif. Pour les gestes sans retour,
 * comme supprimer son compte.
 */
export function confirmerIdentite(
  accountId: string,
  motDePasse: unknown,
  code: unknown,
): Promise<Refus | null> {
  return enFile(async () => {
    const accounts = await load();
    const compte = accounts.find((a) => a.id === accountId);
    if (!compte) return { ok: false, statut: 404, reason: t("Compte introuvable.") };
    const refus = controlerMotDePasse(compte, motDePasse);
    if (refus) return refus;
    if (compte.deuxFacteurs) {
      if (!consommerCode(compte.deuxFacteurs, code)) {
        noterEchec(accountId);
        return {
          ok: false,
          statut: 403,
          reason: t("Code de vérification incorrect (celui de l'application, ou un code de secours)."),
        };
      }
      await save(accounts);
    }
    return null;
  });
}

/** Retire le compte lui-même. Le reste de ses données est traité par `effacement.ts`. */
export function retirerCompte(accountId: string): Promise<boolean> {
  return enFile(async () => {
    const accounts = await load();
    const reste = accounts.filter((a) => a.id !== accountId);
    if (reste.length === accounts.length) return false;
    await save(reste);
    echecs.delete(accountId);
    for (const [cle, d] of defis) if (d.accountId === accountId) defis.delete(cle);
    return true;
  });
}
