import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";
import { journaliser } from "./audit.ts";
import { nomProduit, NomProduit } from "./marque.ts";
import { envoiActif, envoyerDeOxoAI } from "./courrier.ts";
import { t } from "./langue.ts";

/**
 * Inviter un collègue sur l'instance.
 *
 * ── Ce qui n'allait pas ─────────────────────────────────────────────────────
 *
 * L'écran d'un projet offrait « Inviter un collègue », un champ d'adresse et un
 * bouton à icône d'enveloppe. Rien ne partait : l'invitation était seulement
 * notée à côté du projet. Et la personne invitée, elle, se heurtait à un mur :
 * pour rattacher son poste il lui fallait le **jeton d'instance**, qu'aucun
 * écran ne montre, et pour ouvrir son compte il lui fallait… une séance, que
 * seul un compte existant possède. L'invitation désignait donc une porte que
 * l'invité ne pouvait pas franchir.
 *
 * ── Ce que fait ce module ───────────────────────────────────────────────────
 *
 * Il crée un **code d'invitation** : court, lisible au téléphone, lié à une
 * adresse, valable sept jours, et bon une seule fois. Avec lui, et lui seul,
 * la personne fait tout elle-même :
 *
 *   1. elle rattache son poste (`/oxoai/invitations/accepter` lui remet le
 *      jeton d'instance, qu'elle n'a donc jamais à recopier) ;
 *   2. elle ouvre son compte et **choisit son propre mot de passe** —
 *      personne d'autre ne l'a connu ;
 *   3. ses invitations en attente (projets, chats) se rattachent d'elles-mêmes.
 *
 * Si une boîte aux lettres est branchée sur l'instance, le mail part vraiment.
 * Sinon, l'écran rend le code à transmettre de vive voix, et le dit.
 *
 * ── Ce que le code vaut, et pourquoi c'est mieux qu'avant ───────────────────
 *
 * Un code est une clé au porteur : qui l'intercepte peut rattacher un poste.
 * C'est déjà ce que valait le jeton d'instance qu'on dictait au téléphone, à
 * ceci près que celui-ci ne périme jamais et sert à tout le parc. Le code, lui,
 * expire, ne sert qu'une fois, et ne nomme qu'une adresse. On échange une
 * clé éternelle contre une clé jetable : c'est le sens de l'opération.
 */

/** Sept jours : le temps qu'un collègue ouvre son courrier et prenne un moment. */
const DUREE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Alphabet du code : ni O/0, ni I/1/L, ni U (qui se confond avec V à l'oral).
 * Quatre groupes de quatre, soit environ 82 bits — largement hors de portée
 * d'un tirage au hasard, et dictable sans faire répéter.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const GROUPES = 4;
const PAR_GROUPE = 4;

export interface InvitationEnregistree {
  /** Empreinte du code : le code lui-même n'est jamais conservé. */
  empreinte: string;
  /** Adresse invitée, normalisée. Le compte ouvert portera celle-là. */
  email: string;
  /** Compte qui a invité, pour le journal et pour le texte du mail. */
  parQui: string;
  creeLe: string;
  expire: number;
  /** Horodatage de l'usage : une invitation ne sert qu'une fois. */
  utiliseeLe?: string;
}

const normalise = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");
const empreinteDe = (code: string): string =>
  createHash("sha256").update(normaliserCode(code)).digest("hex");

/** Mise en forme tolérante : espaces, tirets et minuscules acceptés à la saisie. */
export const normaliserCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function tirerCode(): string {
  /*
   * `randomInt`, pas `octet % 30` : 256 n'étant pas un multiple de 30, seize
   * lettres sortaient un peu plus souvent que les autres (relevé par CodeQL le
   * 27/09/2026 ; biais minime, mais un code d'invitation se tire sans biais).
   */
  const lettres = Array.from({ length: GROUPES * PAR_GROUPE }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return Array.from({ length: GROUPES }, (_, i) =>
    lettres.slice(i * PAR_GROUPE, (i + 1) * PAR_GROUPE),
  ).join("-");
}

async function lire(): Promise<InvitationEnregistree[]> {
  const valeur = await db().read("invitations");
  if (!Array.isArray(valeur)) return [];
  return (valeur as InvitationEnregistree[]).filter(
    (i) => i && typeof i.empreinte === "string" && typeof i.email === "string",
  );
}

async function ecrire(liste: InvitationEnregistree[]): Promise<void> {
  const maintenant = Date.now();
  // Ménage : une invitation périmée ou consommée depuis longtemps n'a plus d'objet.
  await db().write(
    "invitations",
    liste.filter((i) => i.expire > maintenant - DUREE_MS),
  );
}

/** Comparaison à durée constante entre deux empreintes hexadécimales. */
function memeEmpreinte(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export type Resultat<T> =
  | { ok: true; valeur: T }
  | { ok: false; statut: number; message: string };

const FORME_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Crée une invitation, et envoie le mail si une boîte est branchée.
 *
 * `adresseInstance` est celle par laquelle le navigateur atteint l'instance :
 * c'est la seule que le collègue pourra saisir à son tour.
 */
export async function inviter(
  emailBrut: unknown,
  parQui: string,
  nomInvitant: string,
  adresseInstance: string,
  autresAdresses: string[] = [],
  /** L'administrateur peut remplacer l'invitation d'un collègue ; les autres, seulement la leur. */
  administrateur = false,
): Promise<
  Resultat<{
    /** Absent quand le mail est parti : le code est alors la preuve que la personne lit cette adresse. */
    code?: string;
    email: string;
    expire: string;
    envoye: boolean;
    lien?: string;
    motif?: string;
  }>
> {
  const email = normalise(emailBrut);
  if (!FORME_EMAIL.test(email) || email.length > 254) {
    return { ok: false, statut: 400, message: t("Adresse email invalide.") };
  }

  const liste = await lire();
  /*
   * L'invitation d'un collègue ne se remplace pas par la sienne (revue du
   * 26/09/2026) : cela annulait son code et en donnait un neuf à qui voulait
   * ouvrir le compte de l'invitée à sa place, et hériter de ce qu'on lui avait
   * partagé.
   */
  const enCours = liste.find((i) => i.email === email && !i.utiliseeLe && i.expire > Date.now());
  if (enCours && enCours.parQui !== parQui && !administrateur) {
    return { ok: false, statut: 409, message: t("Un collègue a déjà invité cette adresse : son invitation est en attente. Demandez-lui, ou à l'administrateur, de la renvoyer.") };
  }
  const code = tirerCode();
  const expire = Date.now() + DUREE_MS;

  // Une nouvelle invitation pour la même adresse remplace la précédente : deux
  // codes vivants pour une personne, c'est un de trop à retenir et à révoquer.
  const suite = liste.filter((i) => i.email !== email || i.utiliseeLe);
  suite.push({
    empreinte: empreinteDe(code),
    email,
    parQui,
    creeLe: new Date().toISOString(),
    expire,
  });
  await ecrire(suite);
  journaliser("compte.invite", parQui, { email, expireLe: new Date(expire).toISOString() });

  /*
   * L'envoi est le dernier geste, et il ne doit **jamais** emporter
   * l'invitation avec lui. Le code est déjà écrit : si la boîte aux lettres
   * ne répond pas, la personne doit au moins repartir avec, pour le
   * transmettre de vive voix. Une exception non rattrapée ici rendait une
   * erreur interne et perdait le code — mesuré, serveur de courrier éteint.
   */
  let envoye = false;
  let motif: string | undefined;
  if (envoiActif()) {
    try {
      const r = await envoyerDeOxoAI(
        email,
        objetDuMail(nomInvitant),
        texteDuMail(nomInvitant, adresseInstance, code, autresAdresses),
        parQui,
      );
      envoye = r.ok;
      if (!r.ok) motif = "Le mail n'a pas pu partir : transmettez le code vous-même.";
    } catch {
      motif = "La boîte aux lettres de l'instance n'a pas répondu : transmettez le code vous-même.";
    }
  } else {
    motif = "Aucune boîte aux lettres n'est branchée sur cette instance : transmettez le code vous-même.";
  }

  return {
    ok: true,
    valeur: {
      /*
       * Le mail est parti : le code et le lien restent dans la boîte de
       * l'invitée, pas dans l'écran de qui l'invite (revue du 26/09/2026).
       * Sinon l'invitant pouvait ouvrir le compte lui-même, avec un mot de
       * passe de son choix, et le mail ne prouvait plus rien. Sans mail, il
       * faut bien les lui remettre : c'est lui qui les transmet.
       */
      ...(envoye ? {} : { code, lien: lienDInvitation(adresseInstance, code) }),
      email,
      expire: new Date(expire).toISOString(),
      envoye,
      ...(motif ? { motif } : {}),
    },
  };
}

const objetDuMail = (nomInvitant: string): string =>
  `${nomInvitant} vous invite sur ${nomProduit()}`;

/**
 * Le lien d'invitation : une seule chose à transmettre au lieu de deux.
 *
 * Recopier une adresse **et** un code, c'est deux occasions de se tromper, et
 * c'est la marche que les gens ratent. L'application s'enregistre auprès du
 * système comme ouvrant les liens `oxoai:` : cliquer suffit alors, et les deux
 * champs arrivent remplis. Quand le clic ne marche pas — {@link
 * https://www.rfc-editor.org/rfc/rfc7595 un schéma privé ne s'ouvre que si
 * l'application est installée} — le lien reste collable dans le champ
 * d'adresse, qui sait le découper. Et sous le lien, le mail garde l'adresse et
 * le code en clair : la voie manuelle ne disparaît jamais.
 *
 * Le code voyage dans le fragment (`#`) et non dans la requête : un fragment
 * ne quitte pas la machine qui l'ouvre, là où une requête finit dans les
 * journaux de tout ce qu'elle traverse.
 */
export function lienDInvitation(adresse: string, code: string): string {
  const champs = new URLSearchParams({ a: adresse, c: code });
  return `oxoai://rejoindre#${champs.toString()}`;
}

/**
 * Texte du mail. Écrit ici, jamais par un modèle : ce que OxoAI envoie en son
 * propre nom doit être relisible ligne à ligne dans le dépôt.
 */
function texteDuMail(
  nomInvitant: string,
  adresse: string,
  code: string,
  autres: string[] = [],
): string {
  /*
   * Le nom du produit s'insère dans des phrases : en marque blanche il vaut
   * « OxoAI », « Atlas »… mais sans nom transmis, le repli est « l'application ».
   * Les tournures ci-dessous doivent rester justes dans les deux cas — d'où
   * « l'instance de … » plutôt que « son instance … », qui donnait « son
   * instance l'application ».
   */
  const produit = nomProduit();
  const Produit = NomProduit();
  return [
    `Bonjour,`,
    ``,
    `${nomInvitant} vous invite à rejoindre l'instance de votre organisation.`,
    ``,
    /*
     * Tournures sans accord : sans marque transmise, le repli de `nomProduit`
     * est « l'application », féminin, là où « OxoAI » est masculin. « … est
     * installé » donnait « L'application est installé ». On écrit donc des
     * phrases qui tiennent dans les deux cas.
     */
    `${Produit} tourne chez vous : vos conversations, vos documents et les`,
    `modèles restent sur vos machines. Rien ne part ailleurs.`,
    ``,
    `Si vous avez déjà ${produit} sur votre poste, ce lien vous connecte`,
    `directement :`,
    ``,
    `  ${lienDInvitation(adresse, code)}`,
    ``,
    `Sinon, installez ${produit}, choisissez « Rejoindre l'instance de mon`,
    `entreprise », et saisissez :`,
    ``,
    `  Adresse : ${adresse}`,
    `  Code    : ${code}`,
    ``,
    ...(autres.length
      ? [
          `Si cette adresse ne répond pas, essayez l'une de celles-ci. Elles`,
          `mènent à la même instance par un autre chemin :`,
          ``,
          ...autres.map((a) => `  ${a}`),
          ``,
        ]
      : []),
    `Vous choisirez vous-même votre mot de passe : personne d'autre ne le`,
    `connaîtra, pas même la personne qui vous invite.`,
    ``,
    `Ce code vaut sept jours et ne sert qu'une fois.`,
    ``,
    `Si vous n'attendiez pas cette invitation, ignorez ce message : sans le`,
    `code, il ne donne accès à rien.`,
  ].join("\n");
}

/**
 * Vérifie un code sans le consommer, et rend l'adresse invitée.
 *
 * Sert au rattachement du poste : il faut remettre le jeton d'instance avant
 * que le compte existe, donc avant qu'il y ait quoi que ce soit à consommer.
 * La consommation a lieu à la création du compte, qui est le vrai usage.
 */
export async function verifier(codeBrut: unknown): Promise<Resultat<{ email: string }>> {
  const code = typeof codeBrut === "string" ? codeBrut : "";
  if (normaliserCode(code).length !== GROUPES * PAR_GROUPE) {
    return { ok: false, statut: 400, message: t("Code d'invitation invalide.") };
  }
  const cible = empreinteDe(code);
  const trouvee = (await lire()).find((i) => memeEmpreinte(i.empreinte, cible));
  if (!trouvee) return { ok: false, statut: 403, message: t("Code d'invitation inconnu.") };
  if (trouvee.utiliseeLe) {
    return { ok: false, statut: 409, message: t("Ce code a déjà servi. Demandez-en un nouveau.") };
  }
  if (trouvee.expire <= Date.now()) {
    return { ok: false, statut: 410, message: t("Ce code a expiré. Demandez-en un nouveau.") };
  }
  return { ok: true, valeur: { email: trouvee.email } };
}

/**
 * Consomme le code. Rend l'adresse invitée : c'est elle, et pas une autre, qui
 * devient l'adresse du compte — sans quoi un code destiné à une personne
 * servirait à en inscrire une autre.
 */
export async function consommer(codeBrut: unknown): Promise<Resultat<{ email: string }>> {
  const verdict = await verifier(codeBrut);
  if (!verdict.ok) return verdict;

  const cible = empreinteDe(codeBrut as string);
  const liste = await lire();
  const i = liste.findIndex((x) => memeEmpreinte(x.empreinte, cible));
  if (i < 0) return { ok: false, statut: 403, message: t("Code d'invitation inconnu.") };
  liste[i] = { ...liste[i]!, utiliseeLe: new Date().toISOString() };
  await ecrire(liste);
  return { ok: true, valeur: verdict.valeur };
}

/** Invitations en attente, pour l'écran qui les affiche. Jamais les codes. */
/** Les invitations en attente que cette personne a envoyées ; toutes, pour l'administrateur. */
export async function enAttente(qui: string, administrateur: boolean): Promise<{ email: string; creeLe: string; expire: string }[]> {
  const maintenant = Date.now();
  return (await lire())
    .filter((i) => !i.utiliseeLe && i.expire > maintenant && (administrateur || i.parQui === qui))
    .map((i) => ({ email: i.email, creeLe: i.creeLe, expire: new Date(i.expire).toISOString() }));
}

/** Annule une invitation en attente : le code cesse aussitôt de valoir. */
export async function annuler(emailBrut: unknown, qui: string, administrateur = false): Promise<Resultat<null>> {
  const email = normalise(emailBrut);
  const liste = await lire();
  // Seulement la sienne (l'administrateur : toutes).
  const suite = liste.filter((i) => i.email !== email || i.utiliseeLe || (!administrateur && i.parQui !== qui));
  if (suite.length === liste.length) {
    return { ok: false, statut: 404, message: t("Aucune invitation en attente pour cette adresse.") };
  }
  await ecrire(suite);
  journaliser("compte.invite", qui, { email, annulee: true });
  return { ok: true, valeur: null };
}
