import { storage } from "./storage";
import { apiFetch, setSessionToken, sessionToken } from "@/lib/endpoint";
import type { User } from "./identity";
import { t } from "@/lib/i18n";

/**
 * Comptes locaux.
 *
 * Helix s'installe sur un poste et peut servir plusieurs collaborateurs. Le
 * compte détermine à qui appartiennent le profil, la mémoire et les sessions
 * (ADR-010).
 *
 * **Les mots de passe ne sont jamais manipulés ici.** Création et vérification
 * se font dans l'instance (`gateway/src/accounts.ts`) : les empreintes ne
 * quittent pas le serveur, faute de quoi chaque poste recevrait celles de tous
 * ses collègues et pourrait les attaquer hors ligne.
 *
 * ⚠ Le mot de passe sépare les comptes ; il ne chiffre pas les données, qui
 * restent lisibles par quiconque a accès au disque (voir SECURITE.md).
 */

export interface Account extends User {
  /** Faut-il demander un mot de passe pour ce compte ? */
  hasPassword?: boolean;
  createdAt?: string;
  /** Second facteur actif : « Mot de passe oublié ? » propose alors de le retirer aussi (téléphone perdu). */
  deuxFacteursActive?: boolean;
}

const KEY = "accounts";

/** Liste des comptes, telle que l'instance l'a transmise (sans secret). */
export function allAccounts(): Account[] {
  return storage.get<Account[]>(KEY, []);
}

/** Met à jour le cache local à partir d'une réponse de l'instance. */
function remember(account: Account): void {
  const others = allAccounts().filter((a) => a.id !== account.id);
  storage.set(KEY, [...others, account]);
}

/**
 * Création d'un compte. `inscription` est présent quand l'instance impose la
 * double authentification : le premier compte n'a alors pas de séance avant
 * de l'avoir activée, et l'écran enchaîne sur le QR code.
 */
export async function createAccount(data: {
  fullName: string;
  email: string;
  password?: string;
  /**
   * Code reçu par mail. Il tient lieu de séance : c'est ce qui permet à une
   * personne invitée d'ouvrir son compte **elle-même**, et de choisir son
   * propre mot de passe. L'instance impose alors l'adresse de l'invitation,
   * quelle que soit celle envoyée ici.
   */
  invitation?: string;
  /** « Rester connecté sur ce poste », comme à la connexion. */
  rester?: boolean;
}): Promise<{ account: Account; inscription?: string }> {
  const res = await apiFetch("/helix/auth/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, poste: nomDuPoste() }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    account?: Account;
    session?: { token?: string };
    defi?: string;
    error?: { message?: string };
  };
  if (!res.ok || !body.account) {
    throw new Error(body.error?.message ?? t("Création du compte impossible."));
  }
  /*
   * Le tout premier compte reçoit sa séance avec la réponse. Sans elle,
   * l'application s'ouvrait connectée mais inconnue de l'instance, et le
   * moindre écran demandant une identité affichait « Session expirée ».
   * Les comptes suivants sont créés par un collègue déjà connecté : il n'y a
   * alors pas de séance à prendre, et il ne faut surtout pas la sienne.
   */
  if (body.session?.token) setSessionToken(body.session.token);
  remember(body.account);
  return { account: body.account, inscription: body.defi };
}

/** Nom du poste, pour que l'utilisateur reconnaisse ses séances ouvertes. */
function nomDuPoste(): string {
  if (typeof navigator === "undefined") return t("Poste");
  const plateforme = /Mac/.test(navigator.userAgent)
    ? "Mac"
    : /Windows/.test(navigator.userAgent)
      ? "Windows"
      : /Linux/.test(navigator.userAgent)
        ? "Linux"
        : t("Poste");
  const navigateur = /Chrome/.test(navigator.userAgent)
    ? "Chrome"
    : /Safari/.test(navigator.userAgent)
      ? "Safari"
      : /Firefox/.test(navigator.userAgent)
        ? "Firefox"
        : "application";
  return `${plateforme} · ${navigateur}`;
}

/** Issue d'une tentative de connexion. `a-definir` : compte créé avant que
 *  le mot de passe devienne obligatoire, il doit en choisir un. */
export type Connexion =
  | { ok: true; account: Account }
  | { ok: false; raison: "a-definir" | "a-changer" | "deja-defini" | "expire" | "refuse"; message: string }
  /**
   * Mot de passe juste, reste le code (`deux-facteurs`), ou l'instance impose
   * un second facteur que ce compte n'a pas encore (`inscription`). `defi`
   * rattache l'étape suivante à cette tentative.
   */
  | { ok: false; raison: "deux-facteurs" | "inscription"; defi: string; message: string };

type ReponseConnexion = {
  account?: Account;
  session?: { token?: string };
  defi?: string;
  error?: { message?: string; code?: string };
};

/** Traduit la réponse de la passerelle, et ouvre la séance si elle en porte une. */
async function lireConnexion(res: Response, repli: string): Promise<Connexion> {
  const body = (await res.json().catch(() => ({}))) as ReponseConnexion;
  if (res.ok && body.account) {
    if (body.session?.token) setSessionToken(body.session.token);
    remember(body.account);
    return { ok: true, account: body.account };
  }
  const message = body.error?.message ?? repli;
  if (body.error?.code === "mot-de-passe-a-definir") {
    return { ok: false, raison: "a-definir", message };
  }
  // Mot de passe choisi par l'administrateur qui a créé le compte : la personne en choisit un à elle.
  if (body.error?.code === "mot-de-passe-a-changer") return { ok: false, raison: "a-changer", message };
  if (body.error?.code === "mot-de-passe-deja-defini") {
    return { ok: false, raison: "deja-defini", message };
  }
  if (body.error?.code === "defi-expire") return { ok: false, raison: "expire", message };
  if (body.error?.code === "deux-facteurs-requis" && body.defi) {
    return { ok: false, raison: "deux-facteurs", defi: body.defi, message };
  }
  if (body.error?.code === "deux-facteurs-a-activer" && body.defi) {
    return { ok: false, raison: "inscription", defi: body.defi, message };
  }
  return { ok: false, raison: "refuse", message };
}

/**
 * Vérifie les identifiants auprès de l'instance et ouvre une séance.
 *
 * La séance porte l'identité sur toutes les requêtes suivantes : sans elle,
 * l'instance ne sait pas qui demande et refuse les données.
 */
/**
 * « Rester connecté sur ce poste ».
 *
 * Ce n'est pas le mot de passe qu'on mémorise : c'est la **séance** qu'on
 * allonge. Le mot de passe n'est jamais conservé, nulle part. L'instance
 * prolonge la séance de trente jours à chaque usage au lieu de douze heures,
 * la marque comme telle, et elle reste révocable depuis Réglages, Sécurité.
 *
 * Le choix se fait à la connexion et accompagne chaque étape du parcours : la
 * séance n'est ouverte qu'à la dernière, après le code si la double
 * authentification est active.
 */
export async function authenticate(
  accountId: string,
  password?: string,
  rester = false,
): Promise<Connexion> {
  const res = await apiFetch("/helix/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password, poste: nomDuPoste(), rester }),
  });
  return lireConnexion(res, t("Mot de passe incorrect."));
}

/** Premier mot de passe d'un compte qui n'en a pas. Ouvre la séance. */
export async function definirPremierMotDePasse(
  accountId: string,
  password: string,
  rester = false,
): Promise<Connexion> {
  const res = await apiFetch("/helix/auth/premier-mot-de-passe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password, poste: nomDuPoste(), rester }),
  });
  return lireConnexion(res, t("Impossible d'enregistrer ce mot de passe."));
}

/** Remplace le mot de passe provisoire par le sien, puis connecte (second facteur compris). */
export async function remplacerMotDePasseProvisoire(
  accountId: string,
  provisoire: string,
  nouveau: string,
  rester = false,
): Promise<Connexion> {
  const res = await apiFetch("/helix/auth/mot-de-passe-provisoire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: provisoire, nouveau, poste: nomDuPoste(), rester }),
  });
  return lireConnexion(res, t("Impossible d'enregistrer ce mot de passe."));
}

/**
 * Mot de passe oublié, code de récupération en main : le code redéfinit le
 * mot de passe, puis la connexion suit son cours (second facteur compris).
 */
export async function recupererAvecCode(
  accountId: string,
  code: string,
  nouveau: string,
  rester = false,
): Promise<Connexion> {
  const res = await apiFetch("/helix/auth/recuperer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, code, nouveau, poste: nomDuPoste(), rester }),
  });
  return lireConnexion(res, t("Code de récupération incorrect."));
}

/** Second facteur : code à six chiffres, ou code de secours. Ouvre la séance. */
export async function validerDeuxFacteurs(
  defi: string,
  code: string,
  rester = false,
): Promise<Connexion> {
  const res = await apiFetch("/helix/auth/deux-facteurs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defi, code, poste: nomDuPoste(), rester }),
  });
  return lireConnexion(res, t("Code refusé."));
}

/** Activation imposée, premier temps : le secret à scanner, rattaché au défi. */
export async function preparerInscription(defi: string): Promise<{ secret: string }> {
  const res = await apiFetch("/helix/auth/deux-facteurs/inscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defi }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    secret?: string;
    error?: { message?: string };
  };
  if (!res.ok || !body.secret) throw new Error(body.error?.message ?? t("L'instance n'a pas répondu."));
  return { secret: body.secret };
}

/** Activation imposée, second temps : premier code, séance ouverte, codes de secours remis. */
export async function activerInscription(
  defi: string,
  code: string,
  rester = false,
): Promise<{ connexion: Connexion; codesDeSecours: string[] }> {
  const res = await apiFetch("/helix/auth/deux-facteurs/inscription/activer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defi, code, poste: nomDuPoste(), rester }),
  });
  const copie = res.clone();
  const corps = (await copie.json().catch(() => ({}))) as { codesDeSecours?: string[] };
  return {
    connexion: await lireConnexion(res, t("Code refusé.")),
    codesDeSecours: corps.codesDeSecours ?? [],
  };
}

/**
 * Ferme la séance de ce poste, côté instance **puis** côté poste.
 *
 * Oublier le jeton localement ne suffit pas : il resterait valable douze heures
 * sur le serveur. Quelqu'un qui le récupérerait rouvrirait l'accès sans mot de
 * passe. On révoque donc d'abord, et on oublie ensuite — même si la révocation
 * échoue, pour ne pas laisser un poste bloqué sur un serveur injoignable.
 */
export async function endSession(): Promise<void> {
  const jeton = sessionToken();
  if (jeton) {
    try {
      const res = await apiFetch("/helix/auth/sessions");
      const body = (await res.json().catch(() => ({}))) as {
        sessions?: { id: string; courante?: boolean }[];
      };
      const courante = body.sessions?.find((s) => s.courante);
      if (courante) {
        await apiFetch("/helix/auth/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: courante.id }),
        });
      }
    } catch {
      /* instance injoignable : la séance expirera d'elle-même */
    }
  }
  setSessionToken(null);
}

/**
 * Modifie le nom et, ou, l'adresse du compte connecté.
 *
 * L'instance décide de tout : quel compte (celui de la séance, jamais un
 * identifiant envoyé d'ici), si le mot de passe est juste, si l'adresse est
 * libre. Le poste ne fait que relayer, puis retenir la réponse ; le mot de
 * passe n'est ni conservé ni journalisé ici.
 *
 * Lève une erreur au message lisible si l'instance refuse ou ne répond pas :
 * rien n'a alors été enregistré.
 */
export async function modifierCompte(changements: {
  fullName?: string;
  email?: string;
  password?: string;
  photo?: string | null;
}): Promise<Account> {
  let res: Response;
  try {
    res = await apiFetch("/helix/auth/profil", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changements),
    });
  } catch {
    throw new Error(t("Instance injoignable : rien n'a été enregistré."));
  }
  const body = (await res.json().catch(() => ({}))) as {
    account?: Account;
    error?: { message?: string };
  };
  if (!res.ok || !body.account) {
    throw new Error(body.error?.message ?? t("Enregistrement du profil impossible."));
  }
  remember(body.account);
  return body.account;
}

/** L'utilisateur exposé au reste de l'application. */
export function toUser(account: Account): User {
  const { hasPassword: _p, createdAt: _c, ...user } = account;
  return user;
}
