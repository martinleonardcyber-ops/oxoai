import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dansLaLangue, langue, t, tf } from "./langue.ts";
import { requeteHttps } from "./clientHttps.ts";
import { refusLisible } from "./refusOauth.ts";

/**
 * Brancher une boîte Google ou Microsoft en cliquant, plutôt qu'en remplissant
 * six champs et un mot de passe d'application.
 *
 * ── Pourquoi ce n'était pas déjà le cas ─────────────────────────────────────
 *
 * Les trente-trois autres services se branchent en un clic parce qu'ils
 * distribuent eux-mêmes un identifiant d'application, automatiquement
 * (enregistrement dynamique, RFC 7591). Google et Microsoft ne le font pas :
 * chez eux, un humain examine l'application, et pour l'accès à une boîte mail
 * c'est leur catégorie la plus surveillée — audit annuel par un cabinet agréé,
 * plusieurs milliers d'euros par an. Surtout, ils délivrent l'autorisation à
 * **une** application identifiée par un secret ; or celle-ci est installée
 * chez chaque client, sur sa machine, où un secret n'en est plus un.
 *
 * ── Ce que ce module fait, et pour qui ──────────────────────────────────────
 *
 * Il sert le cas de **l'entreprise**, qui est celui qui marche sans rien
 * demander à personne : une organisation sous Google Workspace ou Microsoft 365
 * déclare cette application comme **interne à son propre domaine**. Cinq
 * minutes pour son administrateur, et surtout : une application interne
 * **saute la vérification de l'éditeur**, parce qu'elle ne sort pas de la
 * maison. Chaque salarié voit alors un vrai bouton « Se connecter », et n'a
 * plus un seul champ à remplir.
 *
 * L'identifiant obtenu par l'administrateur est saisi une fois, dans l'écran
 * des connecteurs. Il n'a rien de secret au sens fort — il ne vaut que pour le
 * domaine de l'organisation, et le secret qui l'accompagne ne sert qu'à
 * l'échange de jetons, depuis l'instance.
 *
 * Pour un Gmail **personnel**, non : une application interne suppose un
 * Workspace. Le mot de passe d'application reste le chemin, et l'écran le dit
 * au lieu de le cacher.
 *
 * ── Ce qui protège l'échange ────────────────────────────────────────────────
 *
 * PKCE (RFC 7636) : l'autorisation part avec l'empreinte d'un secret tiré au
 * hasard, et l'échange du code exige ce secret. Un code intercepté dans le
 * navigateur ne vaut donc rien sans lui. Et un `state` tiré au hasard, comparé
 * à durée constante, ferme la porte au rejeu depuis une autre page.
 */

export type FournisseurCourrier = "google" | "microsoft";

interface Definition {
  nom: string;
  /** Adresse où la personne autorise, chez son fournisseur. */
  autorisation: (tenant: string) => string;
  /** Adresse où l'instance échange le code contre des jetons. */
  jetons: (tenant: string) => string;
  /** Droits demandés : le minimum pour lire et envoyer. */
  portee: string;
  /** Paramètres propres au fournisseur sur la demande d'autorisation. */
  extras?: Record<string, string>;
}

const DEFINITIONS: Record<FournisseurCourrier, Definition> = {
  google: {
    nom: "Google",
    autorisation: () => "https://accounts.google.com/o/oauth2/v2/auth",
    jetons: () => "https://oauth2.googleapis.com/token",
    // `https://mail.google.com/` est la portée qu'exige IMAP/SMTP chez Google.
    portee: "https://mail.google.com/",
    /*
     * `access_type=offline` et `prompt=consent` : sans eux, Google ne rend un
     * jeton de rafraîchissement qu'à la toute première autorisation, jamais
     * aux suivantes. L'instance se retrouverait alors sans moyen de renouveler
     * l'accès après une heure, et la boîte se débrancherait toute seule.
     */
    extras: { access_type: "offline", prompt: "consent" },
  },
  microsoft: {
    nom: "Microsoft",
    autorisation: (tenant) =>
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    jetons: (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    /*
     * `offline_access` est ce qui donne le jeton de rafraîchissement chez
     * Microsoft. Les deux autres portées sont celles d'IMAP et de SMTP, et
     * elles seules : pas de lecture de calendrier ni de fichiers.
     */
    portee:
      "offline_access https://outlook.office.com/IMAP.AccessAsUser.All " +
      "https://outlook.office.com/SMTP.Send",
  },
};

export interface ReglageOauthCourrier {
  fournisseur: FournisseurCourrier;
  clientId: string;
  /** Vide pour une application « publique » (PKCE seul). */
  clientSecret?: string;
  /**
   * Microsoft : le domaine ou l'identifiant du locataire. « organizations »
   * accepte tout compte professionnel, « common » y ajoute les comptes
   * personnels. On garde le domaine quand il est donné : c'est ce qui rend
   * l'application réellement interne.
   */
  tenant?: string;
}

export interface JetonsCourrier extends ReglageOauthCourrier {
  refreshToken: string;
  accessToken?: string;
  /** Horodatage de péremption du jeton d'accès, en millisecondes. */
  expire?: number;
}

/** Préfixe du `state` : le retour d'autorisation sait ainsi à qui il est. */
const PREFIXE = "courriel.";

export const estEtatCourrier = (etat: string): boolean => etat.startsWith(PREFIXE);

interface EnAttente {
  reglage: ReglageOauthCourrier;
  verificateur: string;
  adresse: string;
  redirection: string;
  expire: number;
}

/**
 * Autorisations commencées et pas encore revenues.
 *
 * En mémoire, et c'est voulu : une autorisation interrompue par un
 * redémarrage n'a aucune raison de survivre, et le vérificateur PKCE qu'elle
 * porte ne doit jamais toucher le disque.
 */
const enAttente = new Map<string, EnAttente>();
const DUREE_MS = 10 * 60 * 1000;

function menage(): void {
  const maintenant = Date.now();
  for (const [cle, valeur] of enAttente) if (valeur.expire < maintenant) enAttente.delete(cle);
}

const base64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const tenantDe = (r: ReglageOauthCourrier): string =>
  r.fournisseur === "microsoft" ? (r.tenant?.trim() || "organizations") : "common";

export function valider(
  brut: unknown,
): { ok: true; reglage: ReglageOauthCourrier } | { ok: false; message: string } {
  const r = (brut ?? {}) as Record<string, unknown>;
  const fournisseur = r.fournisseur;
  if (fournisseur !== "google" && fournisseur !== "microsoft") {
    return { ok: false, message: t("Fournisseur inconnu : attendu « google » ou « microsoft ».") };
  }
  const clientId = typeof r.clientId === "string" ? r.clientId.trim() : "";
  if (!clientId) {
    return {
      ok: false,
      message: t("Indiquez l'identifiant d'application fourni par votre administrateur (« client ID »). Sans lui, votre fournisseur ne sait pas qui demande l'accès."),
    };
  }
  const clientSecret = typeof r.clientSecret === "string" ? r.clientSecret.trim() : "";
  const tenant = typeof r.tenant === "string" ? r.tenant.trim() : "";
  if (tenant && !/^[A-Za-z0-9.\-]{1,120}$/.test(tenant)) {
    return { ok: false, message: t("Le locataire ne peut contenir que des lettres, chiffres, points et tirets.") };
  }
  return {
    ok: true,
    reglage: { fournisseur, clientId, ...(clientSecret ? { clientSecret } : {}), ...(tenant ? { tenant } : {}) },
  };
}

/** Adresse à ouvrir dans le navigateur, et le `state` qui l'accompagne. */
export function demarrer(
  reglage: ReglageOauthCourrier,
  adresse: string,
  redirection: string,
): { url: string; etat: string } {
  menage();
  const etat = PREFIXE + base64url(randomBytes(24));
  const verificateur = base64url(randomBytes(32));
  const defi = base64url(createHash("sha256").update(verificateur).digest());

  const def = DEFINITIONS[reglage.fournisseur];
  const champs = new URLSearchParams({
    client_id: reglage.clientId,
    response_type: "code",
    redirect_uri: redirection,
    scope: def.portee,
    state: etat,
    code_challenge: defi,
    code_challenge_method: "S256",
    /*
     * L'adresse est proposée d'emblée : la personne n'a plus qu'à confirmer,
     * et ne risque pas d'autoriser la mauvaise boîte parmi celles où elle est
     * déjà connectée.
     */
    login_hint: adresse,
    ...(def.extras ?? {}),
  });

  enAttente.set(etat, {
    reglage,
    verificateur,
    adresse,
    redirection,
    expire: Date.now() + DUREE_MS,
  });

  return { url: `${def.autorisation(tenantDe(reglage))}?${champs.toString()}`, etat };
}

/**
 * Le fournisseur a renvoyé une erreur au lieu d'un code (`error=access_denied`…).
 * L'attente est consommée, et le message dit la cause probable et le remède
 * (refusOauth.ts, 28/09/2026). `null` pour un `state` inconnu : il ne touche à rien.
 */
/** Ce `state` est-il celui d'une autorisation en cours ? Un autre ne doit rien interrompre (retour par la boucle). */
export function courrierEnAttente(etat: string): boolean {
  menage();
  return [...enAttente.keys()].some((k) => memeEtat(k, etat));
}

export function refuserCourrier(etat: string, code: string): string | null {
  menage();
  const cle = [...enAttente.keys()].find((k) => memeEtat(k, etat));
  const attente = cle ? enAttente.get(cle) : undefined;
  if (!cle || !attente) return null;
  enAttente.delete(cle);
  return refusLisible(code, DEFINITIONS[attente.reglage.fournisseur].nom, { google: attente.reglage.fournisseur === "google" });
}

/* ------------------------------------------------------------------ */
/* Adresse de retour, et retour par la boucle locale (Gmail)            */
/* ------------------------------------------------------------------ */

const BOUCLE = /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * L'adresse de retour envoyée au fournisseur par la route publique de
 * l'instance (Outlook, et Gmail avec une application « Web », 28/09/2026).
 *
 * Microsoft : « the port component is ignored for the purposes of matching a
 * localhost redirect URI », mais le portail Entra refuse `http://127.0.0.1`
 * dans la liste des adresses (il faut éditer le manifeste :
 * https://learn.microsoft.com/en-us/entra/identity-platform/reply-url, lu le
 * 28/09/2026). Sur la boucle locale, l'adresse part donc sous le nom
 * « localhost », celui que l'application ouvre (src/lib/instance.ts) : une
 * page atteinte par 127.0.0.1 (le serveur de développement) demandait sinon
 * une adresse que l'administrateur ne pouvait pas déclarer.
 */
export function retourEnvoye(fournisseur: FournisseurCourrier, base: string): string {
  const racine = base.replace(/\/+$/, "");
  const nom = fournisseur === "microsoft" ? racine.replace(BOUCLE, (_t: string, schema: string, _h: string, port?: string) => `${schema}localhost${port ?? ""}`) : racine;
  return `${nom}/oxoai/oauth/retour`;
}

/**
 * L'adresse à déclarer chez le fournisseur, telle que l'écran la montre.
 * Microsoft, sur la boucle locale : sans le port, qu'il ignore pour
 * « localhost » ; une seule ligne vaut alors quel que soit le port de l'instance.
 */
export function retourADeclarer(fournisseur: FournisseurCourrier, base: string): string {
  const envoye = retourEnvoye(fournisseur, base);
  return fournisseur === "microsoft" ? envoye.replace(/^(http:\/\/localhost):\d{1,5}(?=\/)/i, "$1") : envoye;
}

/** L'adresse vue par le navigateur est-elle celle de la boucle locale ? */
export const surLaBoucle = (base: string): boolean => BOUCLE.test(base.replace(/\/+$/, ""));

/**
 * Gmail par l'application Google de l'instance (28/09/2026).
 *
 * Demandé par Medhi (« quand je veux connecter Gmail, il n'y a pas la
 * redirection vers où je dois aller pour créer l'appli ») : l'écran de Gmail
 * demandait un identifiant d'application à part, sans dire où le créer, et
 * une adresse de retour à déclarer. Or l'instance a déjà son application
 * Google, de type « Application de bureau », celle de Drive et d'Agenda
 * (clientGoogle.ts). Google n'y demande aucune adresse à déclarer : une
 * « Desktop app » accepte la boucle locale sur un port quelconque
 * (https://developers.google.com/identity/protocols/oauth2/native-app et
 * https://support.google.com/cloud/answer/15549257, lus le 28/09/2026). Gmail
 * la reprend donc, et revient comme Agenda (agendaGoogle.ts, essayé avec le
 * compte de Medhi le 26/09/2026) : `http://127.0.0.1:<port>/`, un port ouvert
 * le temps de l'accord, sur 127.0.0.1 seulement. Une instance sur une autre
 * machine : on colle l'adresse affichée après l'accord.
 *
 * Seule la dernière demande compte : en ouvrir une autre ferme la précédente.
 * Le `state` et le vérificateur PKCE restent ceux de `demarrer`, en mémoire.
 */
export type TraitementRetour = (parametres: URLSearchParams) => Promise<{ ok: boolean; message: string; ignore?: boolean }>;

interface Boucle {
  serveur: http.Server;
  minuterie: ReturnType<typeof setTimeout>;
  traiter: TraitementRetour;
}
let boucle: Boucle | null = null;
let issueBoucle: { ok: boolean; message: string; quand: string } | null = null;

export function fermerBoucle(): void {
  const b = boucle;
  if (!b) return;
  boucle = null;
  clearTimeout(b.minuterie);
  b.serveur.close();
  b.serveur.closeIdleConnections?.();
  // Plus tard : la réponse qui conclut passe par l'une de ces connexions (mesuré sur Drive).
  setTimeout(() => b.serveur.closeAllConnections?.(), 2000).unref?.();
}

/** Une connexion Gmail attend-elle son retour par la boucle ? */
export const boucleOuverte = (): boolean => boucle !== null;

/** L'issue du dernier retour par la boucle, pour l'écran qui attend (CourrierOauth.tsx). */
export const issueCourrier = (): { ok: boolean; message: string; quand: string } | null => issueBoucle;

const echapper = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function traiterRetour(b: Boucle, parametres: URLSearchParams): Promise<{ ok: boolean; message: string }> {
  const r = await b.traiter(parametres).catch(() => ({ ok: false, message: t("Erreur inattendue."), ignore: false }));
  // Un `state` inconnu n'annule rien : tout processus du poste pourrait sinon interrompre la demande.
  if (r.ignore) return r;
  issueBoucle = { ok: r.ok, message: r.message, quand: new Date().toISOString() };
  if (boucle === b) fermerBoucle();
  return r;
}

/** Ouvre le port de retour sur 127.0.0.1 et rend l'adresse à donner à Google. */
export async function ouvrirBoucle(traiter: TraitementRetour): Promise<{ ok: true; redirection: string } | { ok: false; message: string }> {
  fermerBoucle();
  issueBoucle = null;
  const langueDemande = langue();
  let b: Boucle | null = null;
  const serveur = http.createServer((req, res) => {
    const adresse = new URL(req.url ?? "/", "http://127.0.0.1");
    const courant = b;
    if (req.method !== "GET" || adresse.pathname !== "/" || !courant) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Introuvable.");
      return;
    }
    // Hors de toute requête de l'application : dans la langue de la demande (langue.ts, `dansLaLangue`).
    dansLaLangue(langueDemande, () => {
      void traiterRetour(courant, adresse.searchParams).then((r) => {
        const titre = r.ok ? t("Votre boîte est branchée") : t("La connexion n'a pas abouti");
        res.writeHead(r.ok ? 200 : 400, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        });
        res.end(
          `<!doctype html><html lang="${langue()}"><head><meta charset="utf-8"><title>${echapper(titre)}</title></head>` +
            '<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5">' +
            `<h1 style="font-size:1.25rem">${echapper(titre)}</h1><p>${echapper(r.ok ? `${r.message} ${t("Vous pouvez fermer cet onglet.")}` : r.message)}</p></body></html>`,
        );
      });
    });
  });
  serveur.keepAliveTimeout = 1000;
  const port = await new Promise<number>((ok, ko) => {
    serveur.once("error", ko);
    serveur.listen(0, "127.0.0.1", () => {
      const a = serveur.address();
      ok(typeof a === "object" && a ? a.port : 0);
    });
  }).catch(() => 0);
  if (!port) {
    serveur.close();
    return { ok: false, message: t("Impossible d'ouvrir un port sur la boucle locale pour recevoir la réponse de Google.") };
  }
  b = { serveur, traiter, minuterie: setTimeout(() => fermerBoucle(), DUREE_MS) };
  b.minuterie.unref?.();
  boucle = b;
  return { ok: true, redirection: `http://127.0.0.1:${port}/` };
}

/**
 * L'instance est sur une autre machine : le navigateur de la personne n'a pas
 * pu joindre son port de retour, et affiche une erreur à une adresse en
 * http://127.0.0.1. Elle la colle à l'écran, et l'échange se fait comme si
 * la page était revenue.
 */
export async function collerRetourCourrier(brut: unknown): Promise<{ ok: boolean; message: string }> {
  const texte = typeof brut === "string" ? brut.trim() : "";
  if (!boucle) return { ok: false, message: t("Aucune connexion Google n'est en cours pour la boîte. Relancez-la.") };
  if (!texte || texte.length > 4096) return { ok: false, message: t("Collez l'adresse complète affichée par le navigateur après votre accord.") };
  let parametres: URLSearchParams;
  try {
    const a = new URL(texte);
    if (a.hostname !== "127.0.0.1" && a.hostname !== "localhost") throw new Error("hôte");
    parametres = a.searchParams;
  } catch {
    return { ok: false, message: t("Cette adresse n'est pas celle du retour de Google : elle commence par http://127.0.0.1.") };
  }
  return traiterRetour(boucle, parametres);
}

/** Comparaison à durée constante de deux `state`. */
function memeEtat(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type Resultat =
  | { ok: true; jetons: JetonsCourrier; adresse: string }
  | { ok: false; message: string };

/** Échange le code contre des jetons. Consomme l'attente, quoi qu'il arrive. */
export async function achever(code: string, etat: string): Promise<Resultat> {
  menage();
  const cle = [...enAttente.keys()].find((k) => memeEtat(k, etat));
  const attente = cle ? enAttente.get(cle) : undefined;
  if (!cle || !attente) {
    return {
      ok: false,
      message: t("Cette autorisation n'est plus valable. Relancez-la depuis l'écran des connecteurs."),
    };
  }
  enAttente.delete(cle);

  const def = DEFINITIONS[attente.reglage.fournisseur];
  const corps = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: attente.redirection,
    client_id: attente.reglage.clientId,
    code_verifier: attente.verificateur,
    ...(attente.reglage.clientSecret ? { client_secret: attente.reglage.clientSecret } : {}),
  });

  try {
    const reponse = await pointDeJetons(def, tenantDe(attente.reglage), corps);
    const texte = reponse.texte;
    if (!reponse.ok) {
      return { ok: false, message: tf("{0} a refusé l'échange : {1}", def.nom, lisible(texte)) };
    }
    const json = JSON.parse(texte) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.refresh_token) {
      return {
        ok: false,
        message: tf(
          "{0} n'a pas fourni de jeton de renouvellement. L'accès expirerait au bout d'une heure sans que rien ne puisse le prolonger. Retirez l'autorisation donnée à cette application dans votre compte {0}, puis recommencez.",
          def.nom,
        ),
      };
    }
    return {
      ok: true,
      adresse: attente.adresse,
      jetons: {
        ...attente.reglage,
        refreshToken: json.refresh_token,
        accessToken: json.access_token,
        expire: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
      },
    };
  } catch {
    return { ok: false, message: tf("{0} n'a pas répondu à la demande de jetons.", def.nom) };
  }
}

/**
 * Le point de jetons du fournisseur, par le client HTTPS de la passerelle
 * (clientHttps.ts) plutôt que `fetch` : réponse bornée à 64 Ko, aucune
 * redirection suivie, délais bornés (tournée des connecteurs du 28/09/2026).
 * L'adresse est une constante de ce module ; seul le locataire Microsoft y
 * entre, et sa forme est vérifiée par `valider`.
 */
async function pointDeJetons(def: Definition, tenant: string, corps: URLSearchParams): Promise<{ ok: boolean; statut: number; texte: string }> {
  const adresse = new URL(def.jetons(tenant));
  const r = await requeteHttps(
    {
      methode: "POST",
      hote: adresse.hostname,
      chemin: `${adresse.pathname}${adresse.search}`,
      entetes: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      corps: corps.toString(),
      limiteOctets: 64 * 1024,
      auDela: "refuser",
      delaiMs: 15_000,
      delaiTotalMs: 30_000,
      agentUtilisateur: "Connecteur-Courrier/1",
    },
    def.nom,
  );
  return { ok: r.statut >= 200 && r.statut < 300, statut: r.statut, texte: r.corps.toString("utf8") };
}

type Renouvellement = { ok: true; acces: string; jetons: JetonsCourrier } | { ok: false; message: string };

/**
 * Renouvellements en cours, par jeton de renouvellement : deux lectures de la
 * boîte en même temps (un Chat et une mission « à chaque mail ») n'en font
 * qu'un. Chez Microsoft, qui fait tourner le jeton de renouvellement, deux
 * renouvellements simultanés en rendaient deux, et l'on ne savait plus lequel
 * garder (tournée des connecteurs du 28/09/2026).
 */
const renouvellements = new Map<string, Promise<Renouvellement>>();

/**
 * Jeton d'accès valide, renouvelé si besoin.
 *
 * On renouvelle **une minute avant** la péremption annoncée : une connexion
 * IMAP ouverte avec un jeton qui expire pendant l'échange est un échec sans
 * explication, et l'horloge du poste n'est pas celle du fournisseur.
 */
export async function accesValide(
  jetons: JetonsCourrier,
): Promise<{ ok: true; acces: string; jetons: JetonsCourrier } | { ok: false; message: string }> {
  if (jetons.accessToken && jetons.expire && jetons.expire - 60_000 > Date.now()) {
    return { ok: true, acces: jetons.accessToken, jetons };
  }
  const deja = renouvellements.get(jetons.refreshToken);
  if (deja) return deja;
  const p = renouveler(jetons).finally(() => renouvellements.delete(jetons.refreshToken));
  renouvellements.set(jetons.refreshToken, p);
  return p;
}

async function renouveler(jetons: JetonsCourrier): Promise<Renouvellement> {
  const def = DEFINITIONS[jetons.fournisseur];
  const corps = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: jetons.refreshToken,
    client_id: jetons.clientId,
    ...(jetons.clientSecret ? { client_secret: jetons.clientSecret } : {}),
  });

  try {
    const reponse = await pointDeJetons(def, tenantDe(jetons), corps);
    const texte = reponse.texte;
    /*
     * Une panne passagère (429, 5xx) n'est pas un refus : le message disait
     * « il faut rebrancher la boîte », alors qu'il suffit d'attendre (tournée
     * des connecteurs du 28/09/2026).
     */
    if (reponse.statut === 429 || reponse.statut >= 500) {
      return { ok: false, message: tf("{0} ne peut pas renouveler l'accès à la boîte pour l'instant (code {1}). Réessayez dans quelques minutes : la boîte reste branchée.", def.nom, reponse.statut) };
    }
    if (!reponse.ok) {
      return {
        ok: false,
        message: tf("{0} a refusé de renouveler l'accès à la boîte : {1}. Il faut rebrancher la boîte dans Réglages, Connecteurs.", def.nom, lisible(texte)),
      };
    }
    const json = JSON.parse(texte) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      return { ok: false, message: tf("{0} n'a pas rendu de jeton d'accès.", def.nom) };
    }
    return {
      ok: true,
      acces: json.access_token,
      jetons: {
        ...jetons,
        accessToken: json.access_token,
        // Certains fournisseurs font tourner le jeton de renouvellement.
        refreshToken: json.refresh_token ?? jetons.refreshToken,
        expire: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
      },
    };
  } catch {
    return { ok: false, message: tf("{0} n'a pas répondu au renouvellement.", def.nom) };
  }
}

/**
 * La chaîne d'authentification XOAUTH2, telle que Google et Microsoft
 * l'attendent : `user=<adresse>^Aauth=Bearer <jeton>^A^A`, en base64, où `^A`
 * est l'octet 0x01. Ce format est le leur, pas un standard IETF.
 */
export const chaineXoauth2 = (adresse: string, acces: string): string =>
  Buffer.from(`user=${adresse}auth=Bearer ${acces}`, "utf8").toString("base64");

/** Le nom lisible d'un fournisseur, pour un message d'écran. */
export const nomFournisseur = (f: FournisseurCourrier): string => DEFINITIONS[f].nom;

/**
 * Extrait de la réponse d'erreur ce qui aide, sans recopier une page entière
 * dans un message d'interface.
 */
function lisible(texte: string): string {
  const net = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").trim().slice(0, 200);
  try {
    const json = JSON.parse(texte) as { error_description?: unknown; error?: unknown };
    return net(json.error_description ?? json.error ?? texte);
  } catch {
    // Une page HTML (proxy, portail captif) ne se recopie pas à l'écran.
    return /^\s*</.test(texte) ? t("réponse inattendue") : net(texte);
  }
}
