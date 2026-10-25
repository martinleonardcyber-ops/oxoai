import http from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db, type StoredCollection } from "./db.ts";
import { chiffrer, dechiffrer, chiffrementActif, estChiffreLie } from "./secret.ts";
import { journaliser } from "./audit.ts";
import { autresUsagesGoogle, clientGoogle, declarerUsageGoogle, messageSansRevocationGoogle } from "./clientGoogle.ts";
import { requeteHttps, ErreurTransport, type DemandeHttps, type ReponseHttps } from "./clientHttps.ts";
import { dansLaLangue, langue, t, tf, type Langue } from "./langue.ts";
import { refusLisible } from "./refusOauth.ts";
// Google Docs, Google Forms et Dropbox (28/09/2026) : leurs définitions et ce qui leur est propre vivent à part.
import { definitionsDocuments, identiteDropbox, revoquerDropbox } from "./natifs/documents.ts";
import { DEFINITIONS_PROJETS, identiteProjet, revocationProjet } from "./natifs/projetsRegles.ts";
// Microsoft 365 (28/09/2026) : sa définition vit dans son fichier, qui n'importe de valeur que de langue.ts.
import { DEFINITION_MICROSOFT, type ServiceMicrosoft } from "./natifs/microsoftBase.ts";

/**
 * Connexions natives de 2026.928.2 : Google Sheets, Google Slides, YouTube,
 * LinkedIn, Facebook (Pages), Instagram (compte professionnel) et TikTok.
 *
 * Demandé par Medhi le 28/09/2026 (« il manque plein de choses : Instagram,
 * TikTok, LinkedIn, Google Sheets, Google Slides, Facebook, YouTube ; pas tout
 * Composio, mais les principales »). Aucun de ces services ne publie de
 * serveur MCP qui accepte l'enregistrement automatique (connecteurs.ts) : on
 * parle donc à leur API, depuis l'instance, sans intermédiaire (PROJET.md
 * § 3.5, « ne jamais introduire un tiers que le client n'a pas déjà choisi »).
 *
 * X (ex-Twitter) les a rejoints le même jour, sur la branche `connecteur-x`,
 * à la demande de Medhi : même modèle, mêmes règles (définition `x`
 * ci-dessous, SECURITE.md § 42).
 *
 * Microsoft 365 (Outlook, OneDrive, SharePoint, Excel, Word, Teams) aussi, le
 * même jour, sur la branche `connecteurs-microsoft` : une seule connexion pour
 * les six, définie dans natifs/microsoftBase.ts (SECURITE.md § 44).
 *
 * Ce module porte ce qui est commun aux huit : l'autorisation, les jetons,
 * leur renouvellement, leur révocation, et l'état montré à l'écran. Les outils
 * de l'agent sont dans outilsNatifs.ts.
 *
 * ── Qui fournit l'application ───────────────────────────────────────────────
 *
 * L'organisation, toujours. Pour Google, c'est l'application déjà saisie pour
 * Drive et Agenda (clientGoogle.ts). Pour LinkedIn, Meta (Facebook et
 * Instagram) et TikTok, chaque organisation crée la sienne chez le fournisseur
 * et en colle l'identifiant et le secret à l'écran, une fois. OxoAI ne peut pas
 * fournir d'identifiant partagé : chez ces trois fournisseurs, une application
 * qui sert d'autres comptes que ceux de son éditeur passe une revue, et la
 * réussir ferait de l'agence l'éditrice d'une application qui publie au nom de
 * tous ses clients (le même raisonnement que pour Drive, drive.ts). Ce qui
 * marche sans revue est dit service par service ci-dessous, et à l'écran.
 *
 * ── Ce qui protège l'échange ────────────────────────────────────────────────
 *
 *  - `state` tiré au hasard (32 octets), comparé à durée constante, valable dix
 *    minutes et une seule fois ; un `state` inconnu ne touche à rien (il
 *    n'annule même pas la demande en cours : sinon tout processus du poste
 *    pourrait l'interrompre) ;
 *  - PKCE quand le fournisseur l'accepte : Google (S256) et TikTok (S256 écrit
 *    en hexadécimal, sa variante à lui). LinkedIn ne le propose qu'à la
 *    demande, par un autre point d'autorisation que LinkedIn doit ouvrir pour
 *    l'application ; Meta ne le documente pas pour le parcours manuel. Pour
 *    eux, le code ne vaut rien sans le secret de l'application, qui ne quitte
 *    pas l'instance ;
 *  - retour vérifié : la portée accordée est relue, et un accès qui manque ou
 *    qui déborde est révoqué sans être gardé ; puis le compte est lu (l'essai)
 *    avant que rien ne soit enregistré ;
 *  - jetons chiffrés au repos (secret.ts, lié à leur place), jamais rendus par
 *    une route, jamais écrits au journal (qui dit qui a branché quel service,
 *    et c'est tout) ;
 *  - sorties réseau par le client HTTPS de la passerelle (clientHttps.ts) :
 *    certificat vérifié, aucune redirection suivie, tailles et délais bornés,
 *    et vers les seuls hôtes écrits ici, jamais vers une adresse venue d'une
 *    requête ou du modèle (`HOTES`).
 *
 * ⚠ Rien de ceci n'a été essayé contre les vrais services : ni compte, ni
 * application de développeur n'étaient disponibles le 28/09/2026. Tout est
 * vérifié contre de faux serveurs locaux (scripts/securite.mjs, section
 * 15 bis), d'après la documentation citée à chaque définition. X de même
 * (section H de scripts/essai-natifs.mjs).
 */

// Brevo et Mailchimp (28/09/2026, natifs/projetsRegles.ts, SECURITE.md § 48).
// `linkedinPage` : la Page d'entreprise LinkedIn, par sa propre application (29/09/2026, définition plus bas).
export type IdNatif = "sheets" | "slides" | "youtube" | "linkedin" | "linkedinPage" | "facebook" | "instagram" | "tiktok" | "x" | "docs" | "forms" | "dropbox" | "brevo" | "mailchimp" | "microsoft";
export const IDS_NATIFS: IdNatif[] = ["sheets", "slides", "youtube", "linkedin", "linkedinPage", "facebook", "instagram", "tiktok", "x", "docs", "forms", "dropbox", "brevo", "mailchimp", "microsoft"];
export const estIdNatif = (v: unknown): v is IdNatif => typeof v === "string" && (IDS_NATIFS as string[]).includes(v);

/** Une option cochée à la connexion : des portées de plus, et dit si elles demandent une revue chez le fournisseur. */
export interface Choix {
  /**
   * `envoi` : envoyer une campagne (Brevo, Mailchimp) ; Microsoft 365 : un choix par service (natifs/microsoftBase.ts).
   * `page` : l'ancienne case « page d'entreprise » de LinkedIn, retirée le 29/09/2026. Aucune définition ne la
   * propose plus ; elle reste dans le type parce qu'un compte branché avant peut encore la porter
   * (`CompteEnregistre.choix`) : elle y est ignorée, et l'écran le dit.
   */
  id: "ecriture" | "page" | "envoi" | ServiceMicrosoft;
  portees: string[];
  revue: boolean;
  /** Portées demandées en plus pour ce choix quand « ecriture » est aussi coché (Microsoft 365). */
  ecriture?: string[];
  /** Demande le consentement d'un administrateur de l'annuaire (Microsoft 365). */
  admin?: boolean;
}

export interface Definition {
  id: IdNatif;
  nom: string;
  google: boolean;
  consentement: string;
  jetons: { hote: string; chemin: string; methode: "POST" | "GET" };
  /** Portées toujours demandées : la lecture, au plus juste. */
  lecture: string[];
  choix: Choix[];
  /** Portées que le fournisseur accorde sans qu'on les demande (tolérées à la relecture). */
  implicites: string[];
  separateur: " " | ",";
  pkce: "S256" | "S256-hex" | null;
  /** `boucle` : un port de la boucle locale ouvert le temps de l'accord ; `instance` : la route publique de retour. */
  retour: "boucle" | "instance";
  cheminBoucle: string;
  cleClient: "client_id" | "client_key";
  formeIdentifiant: RegExp;
  /**
   * Le secret peut manquer : le fournisseur accepte un client « public », que
   * PKCE seul protège (X, application de type « Native App »).
   */
  secretFacultatif?: boolean;
  /**
   * Avec un secret, le client s'identifie par l'en-tête `Authorization: Basic`
   * (RFC 6749 § 2.3.1) plutôt que par `client_secret` dans le corps (X).
   */
  identificationBasique?: boolean;
  /**
   * Le fournisseur refuse « localhost » dans l'adresse de retour : l'adresse
   * vue par le navigateur est réécrite en 127.0.0.1, qui mène à la même
   * passerelle, à l'écoute sur la boucle locale par défaut (config.ts).
   */
  sansLocalhost?: boolean;
  /** Le fournisseur n'a pas de portées (Mailchimp) : aucune n'est demandée ni relue ; la lecture seule est tenue par les outils. */
  sansPortees?: boolean;
  /** Hôtes de l'API qui dépendent du compte (Mailchimp : `<dc>.api.mailchimp.com`), de cette forme seulement. */
  motifHote?: RegExp;
  extras: Record<string, string>;
  /** Hôtes que ce service a le droit de joindre. Aucun autre, quoi qu'on demande. */
  hotes: string[];
  documentation: string[];
  /*
   * Ajouts du 28/09/2026 pour Microsoft 365 (natifs/microsoftBase.ts). Tous
   * facultatifs : les huit services d'avant ne les ont pas, et rien ne change
   * pour eux.
   */
  /** Hôtes admis par leur forme, en plus de `hotes` : les SharePoint où Graph envoie télécharger un fichier. */
  hoteAdmis?: (hote: string) => boolean;
  /** Retour sur la boucle locale sous le nom « localhost » (port ignoré par le fournisseur), écouté sur 127.0.0.1 et ::1. */
  boucleLocalhost?: boolean;
  /** Au moins un choix, hors « ecriture », doit être coché (les services de Microsoft 365). */
  choixRequis?: boolean;
  /** L'annuaire saisi avec l'application, qui entre dans les adresses de consentement et de jetons. */
  annuaire?: {
    lire: (brut: unknown) => { ok: true; valeur: string } | { ok: false; message: string };
    adresses: (annuaire: string) => { consentement: string; jetons: Definition["jetons"] };
  };
  /** Comment lire et comparer les portées rendues (Microsoft : encodées, préfixées par la ressource, casse libre). */
  relecture?: { accordees: (brut: unknown) => string[]; normaliser: (portee: string) => string };
  /** Messages propres au service, là où la phrase commune serait fausse (« révoqué » quand rien ne peut l'être). */
  messages?: {
    manquantes: (portees: string[]) => string;
    enTrop: (portees: string[]) => string;
    debranche: () => string;
    refus: (erreur: string, description: string) => string | null;
  };
}

export const GOOGLE_COMMUN = {
  google: true,
  consentement: "https://accounts.google.com/o/oauth2/v2/auth",
  jetons: { hote: "oauth2.googleapis.com", chemin: "/token", methode: "POST" as const },
  implicites: [],
  separateur: " " as const,
  pkce: "S256" as const,
  retour: "boucle" as const,
  cheminBoucle: "/",
  cleClient: "client_id" as const,
  formeIdentifiant: /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/,
  // Sans eux, Google ne rend de jeton d'actualisation qu'à la toute première autorisation (courrierOauth.ts).
  extras: { access_type: "offline", prompt: "consent" },
};

const VERSION_META = "v25.0";

/*
 * Version de l'API « Marketing » de LinkedIn, au format AAAAMM, exigée par
 * chaque appel à `/rest/…` ; LinkedIn en retire une par mois après un an
 * (la 202510 s'éteint le 15/10/2026). À relever à chaque version de OxoAI.
 * Ici depuis le 29/09/2026 (elle était dans outilsNatifs.ts) : la connexion de
 * la Page d'entreprise s'en sert déjà pour lire le compte (`identite`), et ce
 * module ne peut pas importer outilsNatifs.ts, qui l'importe.
 */
export const VERSION_LINKEDIN = "202609";

/*
 * LinkedIn rend les portées accordées « URL-encoded, space-delimited »
 * (https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow,
 * lu le 29/09/2026), et son exemple n'en montre qu'une : on ne sait pas si
 * plusieurs arrivent séparées par une espace, une virgule ou « %20 ». Les
 * trois sont acceptées ; rien d'autre n'est décodé.
 */
const RELECTURE_LINKEDIN: NonNullable<Definition["relecture"]> = {
  accordees: (brut) => (typeof brut === "string" ? brut.replace(/%20|%2C/gi, " ").split(/[\s,]+/).filter(Boolean) : []),
  normaliser: (p) => p,
};

export const DEFINITIONS: Record<IdNatif, Definition> = {
  /*
   * Google Sheets. `spreadsheets.readonly` pour lire ; écrire demande
   * `spreadsheets`, qui ouvre toutes les feuilles du compte (Google n'a pas de
   * portée « écrire une feuille donnée » sans passer par un sélecteur de
   * fichiers dans une page web). Toutes deux sont « sensibles », pas
   * « restreintes » : une application interne à un Workspace n'a aucune
   * vérification à passer. Quotas : 60 lectures et 60 écritures par minute et
   * par personne, 300 par projet (https://developers.google.com/workspace/sheets/api/limits).
   */
  sheets: {
    ...GOOGLE_COMMUN,
    id: "sheets",
    nom: "Google Sheets",
    lecture: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    choix: [{ id: "ecriture", portees: ["https://www.googleapis.com/auth/spreadsheets"], revue: false }],
    hotes: ["sheets.googleapis.com", "oauth2.googleapis.com"],
    documentation: ["https://developers.google.com/workspace/sheets/api/scopes", "https://developers.google.com/workspace/sheets/api/limits"],
  },
  /*
   * Google Slides, en lecture seule (`presentations.readonly`). Quotas :
   * 600 lectures par minute et par personne, 3000 par projet
   * (https://developers.google.com/workspace/slides/api/limits).
   */
  slides: {
    ...GOOGLE_COMMUN,
    id: "slides",
    nom: "Google Slides",
    lecture: ["https://www.googleapis.com/auth/presentations.readonly"],
    choix: [],
    hotes: ["slides.googleapis.com", "oauth2.googleapis.com"],
    documentation: ["https://developers.google.com/workspace/slides/api/scopes", "https://developers.google.com/workspace/slides/api/limits"],
  },
  /*
   * YouTube, en lecture seule (`youtube.readonly`) : chaînes, vidéos et leurs
   * statistiques publiques. Quota par défaut : 10 000 unités par jour pour le
   * projet, une lecture de liste coûte 1 unité ; la recherche (`search.list`)
   * n'est pas utilisée (https://developers.google.com/youtube/v3/getting-started).
   * Publier une vidéo n'est pas proposé : Medhi a demandé de lister et de lire
   * les statistiques.
   */
  youtube: {
    ...GOOGLE_COMMUN,
    id: "youtube",
    nom: "YouTube",
    lecture: ["https://www.googleapis.com/auth/youtube.readonly"],
    choix: [],
    hotes: ["www.googleapis.com", "oauth2.googleapis.com"],
    documentation: ["https://developers.google.com/youtube/v3/guides/auth/installed-apps", "https://developers.google.com/youtube/v3/getting-started"],
  },
  /*
   * LinkedIn, le profil (https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow).
   * Sans revue : les produits « Sign In with LinkedIn using OpenID Connect »
   * (`openid`, `profile`) et « Share on LinkedIn » (`w_member_social`,
   * publier au nom de la personne). Lire ses propres publications demande
   * `r_member_social`, **fermé** par LinkedIn (« We're not accepting access
   * requests at this time ») : aucun outil ne lit donc les publications d'un
   * profil. Pas de PKCE sur ce parcours (il existe, mais LinkedIn doit l'ouvrir
   * pour l'application). Jeton d'accès de 60 jours ; jeton d'actualisation
   * réservé à certains partenaires. Limites : 150 requêtes par personne et par
   * jour pour la publication, 100 000 pour l'application
   * (https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin),
   * remises à zéro à minuit UTC.
   *
   * La page d'une entreprise n'est plus une case de ce service depuis le
   * 29/09/2026 (décision de Medhi : « fais au mieux »). LinkedIn n'accorde le
   * produit « Community Management API » qu'à une application qui n'a aucun
   * autre produit (FAQ 4 de https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview,
   * relue ce jour-là : « Only request Community Management API Development
   * Tier access with new developer applications that don't have access to
   * other API products ») : sur l'application du profil, la case ne pouvait
   * jamais aboutir. La page a sa propre définition, `linkedinPage`,
   * ci-dessous. Un compte branché avant avec la case « page » la garde dans
   * `choix` : rien ne la lit plus, rien n'est réécrit, et l'écran invite à
   * brancher la Page d'entreprise (ConnecteurNatif.tsx).
   */
  linkedin: {
    id: "linkedin",
    nom: "LinkedIn",
    google: false,
    consentement: "https://www.linkedin.com/oauth/v2/authorization",
    jetons: { hote: "www.linkedin.com", chemin: "/oauth/v2/accessToken", methode: "POST" },
    lecture: ["openid", "profile"],
    choix: [{ id: "ecriture", portees: ["w_member_social"], revue: false }],
    implicites: [],
    separateur: " ",
    pkce: null,
    retour: "instance",
    cheminBoucle: "",
    cleClient: "client_id",
    formeIdentifiant: /^[A-Za-z0-9]{8,40}$/,
    extras: {},
    relecture: RELECTURE_LINKEDIN,
    hotes: ["www.linkedin.com", "api.linkedin.com"],
    documentation: [
      "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow",
      "https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin",
      "https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits",
    ],
  },
  /*
   * LinkedIn, la Page d'entreprise, par une seconde application qui n'a que le
   * produit « Community Management API » (29/09/2026). Lu ce jour-là :
   *
   *  - https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access :
   *    ce produit accorde `r_organization_social`, `w_organization_social`,
   *    `rw_organization_admin` (et d'autres, dont `r_basicprofile` et
   *    `w_member_social`, que l'on ne demande pas). **Pas `r_organization_admin`**,
   *    que l'ancienne case demandait : la page ne le liste que pour les
   *    produits Advertising API et Lead Sync API. On demande donc
   *    `rw_organization_admin`, plus large (« Manage organizations pages and
   *    retrieve reporting data »), parce que c'est la seule portée
   *    d'administration de ce produit ; aucun outil ne modifie la page ;
   *  - organizationAcls (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role) :
   *    les pages où la personne connectée a un rôle, par `q=roleAssignee`,
   *    avec `rw_organization_admin` ou `r_organization_admin` ; chaque élément
   *    porte `roleAssignee` (`urn:li:person:…`) et la page sous `organization`
   *    ou, dans d'autres exemples de la même page, `organizationTarget` ;
   *  - les publications d'une page (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) :
   *    lire, `r_organization_social` ; publier, `w_organization_social`, pour
   *    les rôles ADMINISTRATOR, DIRECT_SPONSORED_CONTENT_POSTER ou CONTENT_ADMIN ;
   *  - les statistiques (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics) :
   *    `rw_organization_admin`, rôle ADMINISTRATOR, douze mois glissants ;
   *  - le nom d'une page administrée (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api) :
   *    `rw_organization_admin`, champ `localizedName`.
   *
   * Ni `openid` ni `profile` : ils viennent du produit « Sign In with LinkedIn
   * using OpenID Connect », qu'il faudrait ajouter à l'application, et
   * LinkedIn refuserait alors le produit des pages. Le compte est reconnu par
   * les pages qu'il administre (organizationAcls), la personne par le
   * `roleAssignee` de la réponse. Aucune des pages lues ne dit que `openid`
   * serait exigé ou interdit sur une telle application : on ne le demande
   * simplement pas (incertain tant qu'une vraie application ne l'a pas montré).
   *
   * Examen : le produit est « vetted » ; un premier palier (« Development
   * tier ») de 500 appels par jour pour l'application et 100 par personne, à
   * finir d'intégrer en douze mois, puis un palier standard, sans limite, sur
   * vidéo de démonstration (https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review).
   * LinkedIn exige une organisation déclarée, une adresse professionnelle
   * vérifiée, une application vérifiée par un super administrateur de la page,
   * et aucun « LinkedIn » dans le nom ni le logo de l'application. Aucun délai
   * d'examen n'est annoncé.
   *
   * Jetons : 60 jours ; jeton d'actualisation d'un an pour les partenaires
   * approuvés (https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens),
   * gardé et servi s'il est rendu (champ `refresh_token_expires_in`). Pas de
   * révocation documentée.
   *
   * ⚠ Pas essayé avec une vraie application LinkedIn (29/09/2026) : ni compte
   * ni produit accordé. Vérifié contre un faux LinkedIn (scripts/essai-natifs.mjs,
   * section K ; scripts/securite.mjs, section 37).
   */
  linkedinPage: {
    id: "linkedinPage",
    // Traduit à l'usage, pas au chargement du module : ce n'est pas qu'un nom de marque.
    get nom() {
      return t("LinkedIn (Page d'entreprise)");
    },
    google: false,
    consentement: "https://www.linkedin.com/oauth/v2/authorization",
    jetons: { hote: "www.linkedin.com", chemin: "/oauth/v2/accessToken", methode: "POST" },
    lecture: ["r_organization_social", "rw_organization_admin"],
    choix: [{ id: "ecriture", portees: ["w_organization_social"], revue: false }],
    implicites: [],
    separateur: " ",
    pkce: null,
    retour: "instance",
    cheminBoucle: "",
    cleClient: "client_id",
    formeIdentifiant: /^[A-Za-z0-9]{8,40}$/,
    extras: {},
    relecture: RELECTURE_LINKEDIN,
    hotes: ["www.linkedin.com", "api.linkedin.com"],
    documentation: [
      "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview",
      "https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review",
      "https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access",
      "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role",
    ],
  },
  /*
   * Facebook, pages de l'organisation, par l'API Graph de Meta
   * (https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow).
   * `pages_show_list` et `pages_read_engagement` pour lister les pages et lire
   * leurs publications avec leurs réactions ; `pages_manage_posts` pour
   * publier (https://developers.facebook.com/docs/pages-api/posts, qui cite
   * aussi `pages_manage_engagement`, pour les commentaires : pas demandé). Sans
   * revue, en « accès standard », ces permissions ne s'accordent qu'aux
   * personnes qui ont un rôle dans l'application (administrateur, développeur,
   * testeur) ; l'« accès avancé », pour tout le monde, passe par la revue de
   * l'application et la vérification de l'entreprise
   * (https://developers.facebook.com/docs/graph-api/overview/access-levels).
   * Chaque appel porte `appsecret_proof`
   * (https://developers.facebook.com/docs/graph-api/securing-requests). Jeton
   * court échangé contre un jeton de 60 jours ; pas de jeton d'actualisation.
   * Limites : 4 800 appels par jour et par personne engagée pour une page
   * (https://developers.facebook.com/docs/graph-api/overview/rate-limiting).
   */
  facebook: {
    id: "facebook",
    nom: "Facebook",
    google: false,
    consentement: `https://www.facebook.com/${VERSION_META}/dialog/oauth`,
    jetons: { hote: "graph.facebook.com", chemin: `/${VERSION_META}/oauth/access_token`, methode: "GET" },
    lecture: ["pages_show_list", "pages_read_engagement"],
    choix: [{ id: "ecriture", portees: ["pages_manage_posts"], revue: false }],
    implicites: ["public_profile"],
    separateur: ",",
    pkce: null,
    retour: "instance",
    cheminBoucle: "",
    cleClient: "client_id",
    formeIdentifiant: /^[0-9]{5,25}$/,
    extras: {},
    hotes: ["graph.facebook.com"],
    documentation: [
      "https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow",
      "https://developers.facebook.com/docs/pages-api/posts",
      "https://developers.facebook.com/docs/graph-api/overview/access-levels",
      "https://developers.facebook.com/docs/graph-api/overview/rate-limiting",
    ],
  },
  /*
   * Instagram, compte professionnel, par l'« API Instagram avec connexion
   * Instagram » de Meta : pas de page Facebook à relier
   * (https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login).
   * `instagram_business_basic` (profil, publications, j'aime et commentaires
   * comptés), `instagram_business_manage_insights` (statistiques),
   * `instagram_business_content_publish` pour publier. Même règle d'accès que
   * Facebook : sans revue, seulement pour les comptes qui ont un rôle dans
   * l'application (testeur Instagram compris). Publication : une image JPEG
   * servie par une adresse publique, 100 publications par l'API sur 24 heures
   * glissantes (https://developers.facebook.com/docs/instagram-platform/content-publishing).
   * Jeton court échangé contre un jeton de 60 jours, renouvelable après 24 h.
   */
  instagram: {
    id: "instagram",
    nom: "Instagram",
    google: false,
    consentement: "https://www.instagram.com/oauth/authorize",
    jetons: { hote: "api.instagram.com", chemin: "/oauth/access_token", methode: "POST" },
    lecture: ["instagram_business_basic", "instagram_business_manage_insights"],
    choix: [{ id: "ecriture", portees: ["instagram_business_content_publish"], revue: false }],
    implicites: [],
    separateur: ",",
    pkce: null,
    retour: "instance",
    cheminBoucle: "",
    cleClient: "client_id",
    formeIdentifiant: /^[0-9]{5,25}$/,
    extras: {},
    hotes: ["api.instagram.com", "graph.instagram.com"],
    documentation: [
      "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login",
      "https://developers.facebook.com/docs/instagram-platform/content-publishing",
    ],
  },
  /*
   * TikTok, « Login Kit for Desktop » (https://developers.tiktok.com/doc/login-kit-desktop) :
   * PKCE obligatoire (défi en hexadécimal), retour sur la boucle locale avec un
   * port, joker accepté (`http://127.0.0.1:*\/callback/`). Lecture :
   * `user.info.basic`, `user.info.stats`, `video.list` ; publier une vidéo :
   * `video.publish` (Content Posting API). Sans revue : le « bac à sable »,
   * jusqu'à 10 comptes cibles (https://developers.tiktok.com/doc/add-a-sandbox) ;
   * et tant que l'application n'a pas passé l'audit de TikTok, **tout ce
   * qu'elle publie reste privé** (« restricted to private viewing mode »,
   * https://developers.tiktok.com/doc/content-posting-api-get-started). Jeton
   * d'accès de 24 heures, jeton d'actualisation d'un an
   * (https://developers.tiktok.com/doc/oauth-user-access-token-management).
   * Limites : 600 requêtes par minute pour l'utilisateur et la liste des vidéos
   * (https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit).
   */
  tiktok: {
    id: "tiktok",
    nom: "TikTok",
    google: false,
    consentement: "https://www.tiktok.com/v2/auth/authorize/",
    jetons: { hote: "open.tiktokapis.com", chemin: "/v2/oauth/token/", methode: "POST" },
    lecture: ["user.info.basic", "user.info.stats", "video.list"],
    choix: [{ id: "ecriture", portees: ["video.publish"], revue: true }],
    implicites: [],
    separateur: ",",
    pkce: "S256-hex",
    retour: "boucle",
    cheminBoucle: "/callback/",
    cleClient: "client_key",
    formeIdentifiant: /^[A-Za-z0-9]{8,40}$/,
    extras: {},
    hotes: ["open.tiktokapis.com", "open-upload.tiktokapis.com"],
    documentation: [
      "https://developers.tiktok.com/doc/login-kit-desktop",
      "https://developers.tiktok.com/doc/oauth-user-access-token-management",
      "https://developers.tiktok.com/doc/content-posting-api-get-started",
    ],
  },
  /*
   * X (ex-Twitter), OAuth 2.0 « Authorization Code Flow with PKCE », lu le
   * 28/09/2026 (https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code,
   * https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token) :
   *  - consentement sur `https://x.com/i/oauth2/authorize`, échange et
   *    renouvellement sur `https://api.x.com/2/oauth2/token`, révocation sur
   *    `https://api.x.com/2/oauth2/revoke` ; portées séparées par des espaces ;
   *  - PKCE S256 (ou `plain`, que l'on n'emploie pas) ; le code ne vaut que
   *    30 secondes ; `state` jusqu'à 500 caractères ;
   *  - jeton d'accès de deux heures, jeton d'actualisation seulement avec
   *    `offline.access` ;
   *  - deux sortes d'applications : « confidentielles » (Web App, Automated
   *    App or Bot), qui ont un secret et s'identifient par `Authorization:
   *    Basic`, sans `client_id` dans le corps ; « publiques » (Native App,
   *    Single Page App), sans secret, `client_id` dans le corps, PKCE seul
   *    (https://docs.x.com/fundamentals/developer-apps). Les deux sont acceptées ;
   *  - adresse de retour : correspondance exacte, dix au plus par application,
   *    « For local development, use http://127.0.0.1 (not localhost) »
   *    (même page). Aucun joker de port n'est documenté : on revient donc par
   *    la route publique de l'instance, dont l'adresse ne change pas, réécrite
   *    en 127.0.0.1 quand le navigateur l'atteint par « localhost ».
   *
   * Portées (tableau de la même page) : `tweet.read` et `users.read` pour lire
   * le compte et ses posts, `offline.access` pour rester branché ; publier :
   * `tweet.write`, et `media.write` pour joindre une image. `POST /2/tweets`
   * exige `tweet.read`, `users.read` et `tweet.write` ; `POST /2/media/upload`,
   * `media.write` (https://docs.x.com/x-api/posts/create-post,
   * https://docs.x.com/x-api/media/upload-media).
   *
   * Offres (https://docs.x.com/x-api/getting-started/pricing et
   * https://docs.x.com/changelog, lus le 28/09/2026) : depuis le 06/02/2026,
   * l'accès se paie à l'usage, par crédits achetés d'avance dans la console
   * (console.x.com). L'ancienne offre gratuite (« Legacy Free ») est fermée :
   * ses utilisateurs récents ont reçu un bon unique de 10 $ ; les offres
   * Basic et Pro restent ouvertes à leurs abonnés, qui peuvent passer à
   * l'usage. Tarifs publiés : lire un post 0,005 $ ; lire ses propres posts
   * (« Owned Reads », quand le compte connecté possède l'application)
   * 0,001 $ depuis le 20/04/2026 ; lire un compte 0,010 $ ; publier 0,015 $,
   * 0,20 $ si le post contient une adresse. Plafond : 3 millions de posts lus
   * par mois. Citer un post, suivre, aimer par l'API : retirés de toutes les
   * offres en libre-service le 20/04/2026 ; répondre, seulement à qui vous a
   * mentionné (23/02/2026). Rien de cela n'est proposé ici.
   *
   * Limites de débit (https://docs.x.com/x-api/fundamentals/rate-limits) :
   * `POST /2/tweets` 100 par 15 minutes et par personne, 10 000 par jour pour
   * l'application ; `GET /2/users/me` 75 par 15 minutes ;
   * `GET /2/users/:id/tweets` 900 par 15 minutes et par personne ;
   * `POST /2/media/upload` 500 par 15 minutes et par personne. Une réponse 429
   * dit de patienter (en-tête `x-rate-limit-reset`).
   */
  x: {
    id: "x",
    nom: "X",
    google: false,
    consentement: "https://x.com/i/oauth2/authorize",
    jetons: { hote: "api.x.com", chemin: "/2/oauth2/token", methode: "POST" },
    lecture: ["tweet.read", "users.read", "offline.access"],
    choix: [{ id: "ecriture", portees: ["tweet.write", "media.write"], revue: false }],
    implicites: [],
    separateur: " ",
    pkce: "S256",
    retour: "instance",
    cheminBoucle: "",
    cleClient: "client_id",
    // Exemple de la documentation : « M1M5R3BMVy13QmpScXkzTUt5OE46MTpjaQ ».
    formeIdentifiant: /^[A-Za-z0-9_-]{16,80}$/,
    secretFacultatif: true,
    identificationBasique: true,
    sansLocalhost: true,
    extras: {},
    hotes: ["api.x.com"],
    documentation: [
      "https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code",
      "https://docs.x.com/fundamentals/developer-apps",
      "https://docs.x.com/x-api/getting-started/pricing",
      "https://docs.x.com/x-api/fundamentals/rate-limits",
    ],
  },
  // Google Docs, Google Forms, Dropbox : natifs/documents.ts (fonction hoistée, sans rien lire de ce module au chargement).
  ...definitionsDocuments(GOOGLE_COMMUN),
  ...DEFINITIONS_PROJETS,
  // Microsoft 365 par Microsoft Graph (28/09/2026) : portées, adresses et limites relevées dans natifs/microsoftBase.ts.
  microsoft: DEFINITION_MICROSOFT,
};

const AGENT = "Connecteur-Natif/1";
const LIMITES = { delaiMs: 20_000, delaiTotalMs: 45_000, fluxMs: 10 * 60_000, jetons: 64 * 1024, api: 4 * 1024 * 1024 };
const COLLECTION: StoredCollection = "connecteursNatifs";
const PREFIXE_ETAT = "natif.";

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

type Transport = (demande: DemandeHttps, service: string) => Promise<ReponseHttps>;
let transport: Transport = requeteHttps;

/**
 * Pour la batterie de sécurité seulement (section 15 bis) : les requêtes
 * partent vers de faux serveurs locaux au lieu des vrais services. Appelable
 * depuis le processus de la passerelle, jamais depuis une requête : aucune
 * route ne la connaît. `null` rétablit le vrai client.
 */
export function remplacerTransportPourEssais(fn: Transport | null): void {
  transport = fn ?? requeteHttps;
}

export class ErreurNatif extends Error {
  categorie: "config" | "acces" | "api" | "quota" | "portee";
  /** Le service n'a pas dit si l'action était faite (5xx) : une écriture a peut-être eu lieu (outilsNatifs.ts, `sousGarde`). */
  incertaine: boolean;
  constructor(categorie: "config" | "acces" | "api" | "quota" | "portee", message: string, incertaine = false) {
    super(message);
    this.categorie = categorie;
    this.incertaine = incertaine;
  }
}

export interface ReponseApi {
  statut: number;
  json: Record<string, unknown>;
  entetes: Record<string, string | string[] | undefined>;
  /** Le corps tel que reçu : le contenu d'un fichier Dropbox n'est pas du JSON (natifs/documents.ts). */
  brut: Buffer;
  /** Le corps tel que reçu : le contenu d'un fichier téléchargé (Microsoft 365, natifs/microsoft.ts). */
  corps: Buffer;
}

function lireJson(r: ReponseHttps): Record<string, unknown> {
  try {
    const v = JSON.parse(r.corps.toString("utf8"));
    if (Array.isArray(v)) return { elements: v };
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Une requête vers un hôte du service, et aucun autre. */
export async function envoyer(
  id: IdNatif,
  d: { methode: DemandeHttps["methode"]; hote: string; chemin: string; entetes?: Record<string, string>; corps?: string | Buffer; octets?: number; delaiTotalMs?: number },
): Promise<ReponseApi> {
  const def = DEFINITIONS[id];
  if (!def.hotes.includes(d.hote) && !def.motifHote?.test(d.hote) && !def.hoteAdmis?.(d.hote)) throw new ErreurNatif("config", `Hôte non autorisé pour ${def.nom}.`);
  const r = await transport(
    {
      methode: d.methode,
      hote: d.hote,
      chemin: d.chemin,
      entetes: { Accept: "application/json", ...(d.entetes ?? {}) },
      ...(d.corps !== undefined ? { corps: d.corps } : {}),
      limiteOctets: d.octets ?? LIMITES.api,
      auDela: "refuser",
      delaiMs: LIMITES.delaiMs,
      delaiTotalMs: Math.min(d.delaiTotalMs ?? LIMITES.delaiTotalMs, 10 * 60_000),
      agentUtilisateur: AGENT,
    },
    def.nom,
  );
  return { statut: r.statut, json: lireJson(r), entetes: r.entetes as ReponseApi["entetes"], brut: r.corps, corps: r.corps };
}

const formulaire = (p: Record<string, string>) => new URLSearchParams(p).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Preuve demandée par Meta sur chaque appel : HMAC-SHA256 du jeton, clé = secret de l'application. */
export const preuveMeta = (jeton: string, secret: string): string => createHmac("sha256", secret).update(jeton).digest("hex");

/* ------------------------------------------------------------------ */
/* Persistance                                                         */
/* ------------------------------------------------------------------ */

interface ApplicationEnregistree {
  clientId: string;
  /** L'annuaire (Microsoft 365) : identifiant, domaine ou « common ». */
  annuaire?: string;
  /** Enveloppe `chiffrer()`, liée à sa place. */
  secret?: unknown;
  depuis: string;
  par: string;
}

interface JetonsClairs {
  acces: string;
  /** Péremption du jeton d'accès, en millisecondes. */
  expire?: number;
  actualisation?: string;
  expireActualisation?: number;
}

interface CompteEnregistre {
  compte: string;
  choix: Choix["id"][];
  portees: string[];
  /** Identifiants publics renvoyés par le service (membre LinkedIn, compte Instagram, open_id TikTok). */
  ids: Record<string, string>;
  /** Enveloppe `chiffrer()` des jetons, liée à sa place. */
  jetons: unknown;
  clientId: string;
  depuis: string;
  par: string;
  perdu?: string;
}

interface Magasin {
  applications: Partial<Record<IdNatif, ApplicationEnregistree>>;
  comptes: Partial<Record<IdNatif, CompteEnregistre>>;
}

let magasin: Magasin | undefined;
/** Le magasin n'a pas pu être lu : on n'écrit rien par-dessus (règle du projet, pertes du 20/09 et du 24/09). */
let illisible = false;
let chargement: Promise<void> | null = null;

const placeSecret = (id: IdNatif) => `connecteursNatifs#${id}#secret`;
const placeJetons = (id: IdNatif) => `connecteursNatifs#${id}#jetons`;

export async function charger(): Promise<void> {
  if (magasin) return;
  if (chargement) return chargement;
  chargement = (async () => {
    try {
      const v = (await db().read(COLLECTION)) as Partial<Magasin> | null;
      magasin = {
        applications: v && typeof v.applications === "object" && v.applications ? v.applications : {},
        comptes: v && typeof v.comptes === "object" && v.comptes ? v.comptes : {},
      };
      illisible = false;
    } catch (err) {
      console.error("[connecteurs natifs] magasin illisible :", err instanceof Error ? err.message : err);
      magasin = { applications: {}, comptes: {} };
      illisible = true;
    }
  })();
  try {
    await chargement;
  } finally {
    chargement = null;
  }
}

async function ecrire(): Promise<void> {
  if (illisible) {
    throw new ErreurNatif("config", t("Les connexions enregistrées n'ont pas pu être lues : rien n'est modifié tant qu'elles ne le sont pas. Redémarrez l'application ; si cela persiste, le trousseau ou la clé de chiffrement est en cause."));
  }
  await db().write(COLLECTION, magasin);
}

/* ------------------------------------------------------------------ */
/* Application du fournisseur                                          */
/* ------------------------------------------------------------------ */

type Client = { ok: true; clientId: string; clientSecret: string; source: "google" | "ecran"; annuaire?: string } | { ok: false };

function clientDe(id: IdNatif): Client {
  const def = DEFINITIONS[id];
  if (def.google) {
    const g = clientGoogle();
    return g.ok ? { ok: true, clientId: g.clientId, clientSecret: g.clientSecret, source: "google" } : { ok: false };
  }
  const a = magasin?.applications[id];
  if (!a) return { ok: false };
  let secret = "";
  if (a.secret !== undefined) {
    try {
      const clair = estChiffreLie(a.secret) ? dechiffrer(a.secret, placeSecret(id)) : null;
      secret = typeof clair === "string" ? clair : "";
    } catch {
      secret = "";
    }
  }
  return { ok: true, clientId: a.clientId, clientSecret: secret, source: "ecran", ...(a.annuaire ? { annuaire: a.annuaire } : {}) };
}

/**
 * L'application Microsoft 365 de l'instance, pour brancher aussi la boîte
 * Outlook par IMAP (courrierOauth.ts, 28/09/2026) : une seule inscription dans
 * Entra peut porter les deux adresses de retour et les deux jeux de
 * permissions (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow,
 * lu le 28/09/2026). Rien ne sort de la passerelle : l'écran n'en voit que
 * l'identifiant, par `etat`.
 */
export async function applicationMicrosoft(): Promise<{ clientId: string; clientSecret: string; annuaire?: string } | null> {
  await charger();
  const c = clientDe("microsoft");
  return c.ok ? { clientId: c.clientId, clientSecret: c.clientSecret, ...(c.annuaire ? { annuaire: c.annuaire } : {}) } : null;
}

/** Où consentir et où échanger les jetons : dans l'annuaire enregistré, pour Microsoft 365. */
function adressesDe(id: IdNatif, client: { annuaire?: string }): { consentement: string; jetons: Definition["jetons"] } {
  const def = DEFINITIONS[id];
  return def.annuaire && client.annuaire ? def.annuaire.adresses(client.annuaire) : { consentement: def.consentement, jetons: def.jetons };
}

/** Enregistre l'application créée par l'organisation chez LinkedIn, Meta ou TikTok. Le secret est chiffré, et ne ressort plus. */
export async function enregistrerApplication(id: unknown, brutId: unknown, brutSecret: unknown, qui: string, brutAnnuaire?: unknown): Promise<{ ok: boolean; message: string }> {
  if (!estIdNatif(id)) return { ok: false, message: t("Service inconnu.") };
  const def = DEFINITIONS[id];
  if (def.google) return { ok: false, message: t("Les services Google utilisent l'application Google de l'instance, saisie une fois pour Gmail, Agenda, Drive, Sheets, Slides, Docs, Forms et YouTube.") };
  await charger();
  const clientId = typeof brutId === "string" ? brutId.trim() : "";
  const secret = typeof brutSecret === "string" ? brutSecret.trim() : "";
  if (!def.formeIdentifiant.test(clientId)) return { ok: false, message: tf("Cet identifiant n'a pas la forme de ceux de {0}. Vérifiez le copier-coller.", def.nom) };
  // LinkedIn, Meta et TikTok exigent le secret pour échanger le code ; X l'accepte sans (client « public », PKCE seul).
  if (secret.length > 200 || /\s/.test(secret) || (!secret && !def.secretFacultatif)) return { ok: false, message: tf("Collez aussi le secret de l'application {0}, sans espace.", def.nom) };
  const annuaire = def.annuaire ? def.annuaire.lire(brutAnnuaire) : null;
  if (annuaire && !annuaire.ok) return { ok: false, message: annuaire.message };
  if (!chiffrementActif()) return { ok: false, message: t("Le chiffrement des données n'est pas actif sur cette machine : le secret ne sera pas enregistré en clair.") };
  const avant = magasin!.applications[id];
  magasin!.applications[id] = { clientId, ...(annuaire?.ok ? { annuaire: annuaire.valeur } : {}), ...(secret ? { secret: chiffrer(secret, placeSecret(id)) } : {}), depuis: new Date().toISOString(), par: qui };
  // Une autre application (ou un autre annuaire) : le compte branché avec l'ancienne ne vaut plus.
  const compte = magasin!.comptes[id];
  if (compte && (compte.clientId !== clientId || (avant?.annuaire ?? "") !== (annuaire?.ok ? annuaire.valeur : ""))) compte.perdu = new Date().toISOString();
  try {
    await ecrire();
  } catch (err) {
    if (avant) magasin!.applications[id] = avant;
    else delete magasin!.applications[id];
    throw err;
  }
  journaliser("natif.application_enregistree", qui, { service: id });
  return { ok: true, message: tf("Application {0} enregistrée. Vous pouvez maintenant vous connecter.", def.nom) };
}

export async function effacerApplication(id: unknown, qui: string): Promise<{ ok: boolean; message: string }> {
  if (!estIdNatif(id) || DEFINITIONS[id].google) return { ok: false, message: t("Service inconnu.") };
  await charger();
  if (magasin!.comptes[id]) await oublier(id, qui);
  delete magasin!.applications[id];
  await ecrire();
  journaliser("natif.application_effacee", qui, { service: id });
  return { ok: true, message: tf("Application {0} retirée de cette instance.", DEFINITIONS[id].nom) };
}

/* ------------------------------------------------------------------ */
/* Jetons et comptes                                                   */
/* ------------------------------------------------------------------ */

function jetonsDe(id: IdNatif, c: CompteEnregistre): JetonsClairs | null {
  if (!estChiffreLie(c.jetons)) return null;
  try {
    const v = dechiffrer(c.jetons, placeJetons(id)) as Partial<JetonsClairs> | null;
    return v && typeof v.acces === "string" && v.acces ? (v as JetonsClairs) : null;
  } catch {
    return null;
  }
}

function utilisable(id: IdNatif): CompteEnregistre | null {
  const c = magasin?.comptes[id];
  if (!c || c.perdu) return null;
  const client = clientDe(id);
  if (!client.ok || client.clientId !== c.clientId) return null;
  return c;
}

/** Synchrone, pour la liste des outils : le service est-il branché et utilisable ? */
export function connecte(id: IdNatif): boolean {
  if (!magasin) {
    void charger();
    return false;
  }
  return utilisable(id) !== null;
}

// Les services Google d'ici gardent un accès du projet Google de l'instance : une révocation les couperait tous (clientGoogle.ts).
for (const id of IDS_NATIFS) {
  if (!DEFINITIONS[id].google) continue;
  declarerUsageGoogle(`natif.${id}`, DEFINITIONS[id].nom, async () => {
    await charger();
    return utilisable(id) !== null;
  });
}

/**
 * Synchrone : une option (écriture, service Microsoft…) a-t-elle été accordée ?
 * Seulement si la définition la propose encore : l'ancienne case « page » de
 * LinkedIn, enregistrée dans un compte branché avant le 29/09/2026, ne vaut
 * plus rien (la Page d'entreprise a sa propre connexion, `linkedinPage`).
 */
export function aChoisi(id: IdNatif, choix: Choix["id"]): boolean {
  const c = connecte(id) ? magasin!.comptes[id] : null;
  return Boolean(c?.choix.includes(choix)) && DEFINITIONS[id].choix.some((x) => x.id === choix);
}

export function idsDe(id: IdNatif): Record<string, string> {
  return { ...(magasin?.comptes[id]?.ids ?? {}) };
}

/**
 * `lequel` : le compte dont l'accès vient d'être refusé. Un compte rebranché
 * pendant l'appel (l'administrateur reconnecte le service pendant qu'un Chat
 * s'en sert) n'est pas marqué perdu à sa place (tournée des connecteurs du
 * 28/09/2026).
 */
async function marquerPerdu(id: IdNatif, lequel?: CompteEnregistre): Promise<void> {
  const c = magasin?.comptes[id];
  if (!c || c.perdu) return;
  if (lequel && c !== lequel) return;
  c.perdu = new Date().toISOString();
  await ecrire().catch(() => {});
  journaliser("natif.acces_perdu", "agent", { service: id });
}

const enCoursActualisation = new Map<IdNatif, Promise<string>>();

/*
 * Instagram : le jeton de 60 jours se renouvelle « après 24 heures et avant
 * expiration », et il n'a pas de jeton d'actualisation. Il n'était renouvelé
 * que dans la dernière minute de sa vie : en pratique jamais, et le compte se
 * débranchait au bout de 60 jours même utilisé chaque jour (tournée des
 * connecteurs du 28/09/2026). Il l'est désormais dès qu'il lui reste moins de
 * 50 jours (il a donc plus de dix jours), une fois par heure au plus ; un
 * échec ne coupe rien tant que le jeton en cours est valable.
 */
const RENOUVELER_INSTAGRAM_MS = 50 * 24 * 3600_000;
let essaiInstagram = 0;

/** Le secret de l'application, pour Meta (`appsecret_proof`). Jamais rendu hors de la passerelle. */
export function secretApplication(id: IdNatif): string {
  const c = clientDe(id);
  return c.ok ? c.clientSecret : "";
}

/** Un jeton d'accès valable, renouvelé si le service le permet. */
export async function accesValide(id: IdNatif, forcer = false): Promise<string> {
  await charger();
  const c = utilisable(id);
  if (!c) throw new ErreurNatif("acces", magasin?.comptes[id] ? `L'accès à ${DEFINITIONS[id].nom} a été perdu : il faut le reconnecter dans Réglages, Connecteurs.` : `${DEFINITIONS[id].nom} n'est pas connecté.`);
  const j = jetonsDe(id, c);
  if (!j) throw new ErreurNatif("acces", `Le jeton enregistré pour ${DEFINITIONS[id].nom} est illisible : il faut le reconnecter dans Réglages, Connecteurs.`);
  const valable = Boolean(j.expire) && j.expire! - 60_000 > Date.now();
  const anticipe = !forcer && id === "instagram" && valable && j.expire! - Date.now() < RENOUVELER_INSTAGRAM_MS && Date.now() - essaiInstagram > 3600_000;
  if (!forcer && !anticipe && (!j.expire || valable)) return j.acces;
  const deja = enCoursActualisation.get(id);
  if (deja) return deja;
  const p = (async () => {
    if (anticipe) {
      essaiInstagram = Date.now();
      const neufs = await rafraichir(id, j).catch(() => null);
      // Refusé ou injoignable : le jeton en cours vaut encore, on s'en sert et on réessaiera.
      if (!neufs) return j.acces;
      c.jetons = chiffrer(neufs, placeJetons(id));
      await ecrire().catch(() => {});
      return neufs.acces;
    }
    /*
     * Une coupure pendant le renouvellement n'a rien laissé partir : dite
     * comme une erreur ordinaire, pas comme un transport qui aurait peut-être
     * écrit. Sinon `sousGarde` (outilsNatifs.ts) annonçait « c'est peut-être
     * déjà publié » et bloquait le même contenu une demi-heure, alors que rien
     * n'était parti (tournée des connecteurs du 28/09/2026).
     */
    const neufs = await rafraichir(id, j).catch((err: unknown) => {
      throw err instanceof ErreurTransport ? new ErreurNatif("api", err.message) : err;
    });
    if (!neufs) {
      await marquerPerdu(id, c);
      /*
       * `forcer` : le service vient de refuser l'accès (401). Un jeton qui
       * n'expire pas (Mailchimp) et qu'on a révoqué était dit « expiré » au
       * modèle (banc d'essai du 28/09/2026).
       */
      throw new ErreurNatif("acces", forcer ? `${DEFINITIONS[id].nom} n'accepte plus l'accès enregistré : il faut le reconnecter dans Réglages, Connecteurs.` : `L'accès à ${DEFINITIONS[id].nom} a expiré et ne se renouvelle pas seul : il faut le reconnecter dans Réglages, Connecteurs.`);
    }
    c.jetons = chiffrer(neufs, placeJetons(id));
    await ecrire();
    return neufs.acces;
  })();
  enCoursActualisation.set(id, p);
  try {
    return await p;
  } finally {
    enCoursActualisation.delete(id);
  }
}

/**
 * Comment le client se présente à l'échange de jetons. X, avec un secret :
 * `Authorization: Basic`, rien dans le corps (« You don't need client id for
 * confidential clients with a valid Authorization Header ») ; sans secret :
 * `client_id` dans le corps. Les autres : identifiant et secret dans le
 * corps, comme leur documentation le montre.
 */
function identification(id: IdNatif, client: { clientId: string; clientSecret: string }): { entetes: Record<string, string>; champs: Record<string, string> } {
  const def = DEFINITIONS[id];
  if (def.identificationBasique && client.clientSecret) {
    // RFC 6749 § 2.3.1 : identifiant et secret encodés comme dans un formulaire, puis en base 64.
    const paire = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    return { entetes: { Authorization: `Basic ${Buffer.from(paire, "utf8").toString("base64")}` }, champs: {} };
  }
  return { entetes: {}, champs: { [def.cleClient]: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) } };
}

/** Durée de vie du jeton d'actualisation, en secondes, sous le nom de TikTok ou de LinkedIn ; 0 si absente. */
const dureeActualisation = (json: Record<string, unknown>): number => Number(json.refresh_expires_in ?? json.refresh_token_expires_in) || 0;

async function rafraichir(id: IdNatif, j: JetonsClairs): Promise<JetonsClairs | null> {
  const client = clientDe(id);
  if (!client.ok) return null;
  if (id === "instagram") {
    // Renouvelable après 24 heures et avant expiration (documentation de la connexion Instagram).
    const r = await envoyer(id, { methode: "GET", hote: "graph.instagram.com", chemin: `/refresh_access_token?${formulaire({ grant_type: "ig_refresh_token", access_token: j.acces })}`, octets: LIMITES.jetons });
    // Comme pour les autres : une panne passagère n'est pas un accès perdu.
    if (r.statut === 429 || r.statut >= 500) throw new ErreurNatif("quota", `${DEFINITIONS[id].nom} n'a pas pu renouveler l'accès pour l'instant (code ${r.statut}). Réessaie dans quelques minutes, et dis-le à l'utilisateur ; l'accès reste branché.`);
    return r.statut === 200 && typeof r.json.access_token === "string" ? { acces: r.json.access_token, expire: Date.now() + (Number(r.json.expires_in) || 5_184_000) * 1000 } : null;
  }
  // Facebook : pas de jeton d'actualisation ; LinkedIn : seulement pour certains partenaires.
  if (!j.actualisation) return null;
  // `identification` rend `client_key` pour TikTok, `client_id` pour les autres, ou l'en-tête Basic de X.
  const qui = identification(id, client);
  const p: Record<string, string> = { ...qui.champs, grant_type: "refresh_token", refresh_token: j.actualisation };
  const point = adressesDe(id, client).jetons;
  const r = await envoyer(id, { methode: "POST", hote: point.hote, chemin: point.chemin, entetes: { ...FORM, ...qui.entetes }, corps: formulaire(p), octets: LIMITES.jetons });
  /*
   * Une panne passagère (429, 5xx) pendant le renouvellement n'est pas un
   * accès perdu : elle débranchait le service (banc d'essai du 28/09/2026 ;
   * Brevo renouvelle toutes les heures). Seul un refus le fait.
   */
  if (r.statut === 429 || r.statut >= 500) throw new ErreurNatif("quota", `${DEFINITIONS[id].nom} n'a pas pu renouveler l'accès pour l'instant (code ${r.statut}). Réessaie dans quelques minutes, et dis-le à l'utilisateur ; l'accès reste branché.`);
  if (r.statut !== 200 || typeof r.json.access_token !== "string") return null;
  return {
    acces: r.json.access_token,
    expire: r.json.expires_in ? Date.now() + Number(r.json.expires_in) * 1000 : undefined,
    // Certains fournisseurs font tourner le jeton d'actualisation (TikTok le peut).
    actualisation: typeof r.json.refresh_token === "string" ? r.json.refresh_token : j.actualisation,
    // TikTok écrit `refresh_expires_in`, LinkedIn `refresh_token_expires_in` (programmatic-refresh-tokens, lu le 29/09/2026).
    expireActualisation: dureeActualisation(r.json) ? Date.now() + dureeActualisation(r.json) * 1000 : j.expireActualisation,
  };
}

/**
 * Un appel d'API authentifié. Un 401 déclenche un renouvellement et une seule
 * reprise ; un second 401 débranche le service (jeton révoqué chez lui).
 */
export async function appelerApi(id: IdNatif, construire: (acces: string) => Parameters<typeof envoyer>[1]): Promise<ReponseApi> {
  await charger();
  const compte = magasin?.comptes[id];
  for (let essai = 0; essai < 2; essai++) {
    const acces = await accesValide(id, essai > 0);
    const r = await envoyer(id, construire(acces));
    if (r.statut === 401 && essai === 0) continue;
    if (r.statut === 401) {
      await marquerPerdu(id, compte);
      throw new ErreurNatif("acces", `${DEFINITIONS[id].nom} n'accepte plus l'accès enregistré : il faut le reconnecter dans Réglages, Connecteurs.`);
    }
    return r;
  }
  throw new ErreurNatif("acces", `${DEFINITIONS[id].nom} n'accepte plus l'accès enregistré.`);
}

/* ------------------------------------------------------------------ */
/* Autorisation                                                        */
/* ------------------------------------------------------------------ */

interface Flux {
  id: IdNatif;
  etat: string;
  verificateur: string;
  redirection: string;
  choix: Choix["id"][];
  portees: string[];
  qui: string;
  serveur: http.Server | null;
  /** Le même port sur ::1, quand « localhost » y mène (Microsoft 365, `boucleLocalhost`). */
  serveur6?: http.Server | null;
  minuterie: ReturnType<typeof setTimeout>;
  echangeEnCours: boolean;
  /** La langue de la demande : le retour arrive hors de toute requête de l'application. */
  langue: Langue;
}

const flux = new Map<IdNatif, Flux>();
const issues = new Map<IdNatif, { ok: boolean; message: string; quand: string }>();

function fermerFlux(id: IdNatif): void {
  const f = flux.get(id);
  if (!f) return;
  clearTimeout(f.minuterie);
  flux.delete(id);
  if (f.serveur) {
    const s = f.serveur;
    s.close();
    s.closeIdleConnections?.();
    // Plus tard : la réponse qui conclut passe par l'une de ces connexions (mesuré sur Drive).
    setTimeout(() => s.closeAllConnections?.(), 2000).unref?.();
  }
  if (f.serveur6) {
    const s6 = f.serveur6;
    s6.close();
    s6.closeIdleConnections?.();
    setTimeout(() => s6.closeAllConnections?.(), 2000).unref?.();
  }
}

function conclure(id: IdNatif, ok: boolean, message: string): { ok: boolean; message: string } {
  issues.set(id, { ok, message, quand: new Date().toISOString() });
  fermerFlux(id);
  return { ok, message };
}

const base64url = (b: Buffer) => b.toString("base64url");

function memeEtat(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const estEtatNatif = (etat: string): boolean => etat.startsWith(PREFIXE_ETAT);

const echapperHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function pageBoucle(res: http.ServerResponse, statut: number, titre: string, message: string): void {
  res.writeHead(statut, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  res.end(
    // Langue et titre de la demande (tournée des connecteurs du 28/09/2026) : la page disait « fr » et « Connexion » à tous.
    `<!doctype html><html lang="${langue()}"><head><meta charset="utf-8"><title>${echapperHtml(titre)}</title></head>` +
      '<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5">' +
      `<h1 style="font-size:1.25rem">${echapperHtml(titre)}</h1><p>${echapperHtml(message)}</p></body></html>`,
  );
}

/**
 * L'adresse sur laquelle la passerelle écoute vraiment (index.ts, à
 * l'ouverture du port). « localhost » ne se réécrit en 127.0.0.1 que si
 * 127.0.0.1 mène à elle.
 *
 * Tournée de la 2026.928.3 (SECURITE.md § 43) : avec `OXOAI_GATEWAY_HOST=::1`,
 * ou `localhost` (que macOS résout d'abord en ::1), la passerelle n'écoute pas
 * sur 127.0.0.1 ; l'adresse de retour de X, réécrite en 127.0.0.1, ne menait
 * à rien (essayé : connexion refusée), et la connexion à X ne pouvait pas
 * aboutir. Elle est alors écrite `[::1]`, la même machine par l'adresse où
 * l'instance écoute ; la documentation de X ne dit pas s'il l'accepte.
 */
let ecoute = "127.0.0.1";
export function noterEcoute(adresse: string): void {
  ecoute = adresse;
}
const ecouteSurIPv4 = () => ["127.0.0.1", "0.0.0.0", "::", ""].includes(ecoute);

/**
 * « localhost » réécrit en l'adresse de boucle où la passerelle écoute, pour
 * un fournisseur qui le refuse (X, Mailchimp ; Zoom pour les serveurs MCP,
 * connecteurs.ts, 28/09/2026). Une adresse nommée ou en https ne change pas.
 */
export function sansLocalhost(racine: string): string {
  const boucle = ecouteSurIPv4() ? "127.0.0.1" : ecoute === "::1" ? "[::1]" : "localhost";
  return racine.replace(/\/+$/, "").replace(/^(https?:\/\/)localhost(?=:\d{1,5}$|$)/i, (_, schema: string) => schema + boucle);
}

/** L'adresse de retour à déclarer chez le fournisseur, telle que l'écran doit la montrer. */
export function adresseDeRetour(id: IdNatif, base: string): string {
  const def = DEFINITIONS[id];
  if (def.retour === "instance") {
    const racine = base.replace(/\/+$/, "");
    return `${def.sansLocalhost ? sansLocalhost(racine) : racine}/oxoai/oauth/retour`;
  }
  // Google accepte tout port de la boucle locale pour une application « de bureau » ; TikTok, le joker `*` ; Microsoft ignore le port de « localhost ».
  if (def.boucleLocalhost) return `http://localhost${def.cheminBoucle}`;
  return def.google ? "http://127.0.0.1" : `http://127.0.0.1:*${def.cheminBoucle}`;
}

/**
 * Lance l'autorisation. `base` est l'adresse par laquelle le navigateur
 * atteint l'instance (index.ts, `adresseVue`) : pour LinkedIn et Meta, c'est
 * là que le fournisseur renverra la personne.
 */
export async function demarrer(brutId: unknown, qui: string, base: string, brutChoix: unknown): Promise<{ ok: boolean; message: string; url?: string }> {
  if (!estIdNatif(brutId)) return { ok: false, message: t("Service inconnu.") };
  const id = brutId;
  const def = DEFINITIONS[id];
  await charger();
  const client = clientDe(id);
  if (!client.ok) {
    return {
      ok: false,
      message: def.google
        ? t("Aucune application Google n'est enregistrée sur cette instance : renseignez-la d'abord.")
        : tf("Aucune application {0} n'est enregistrée sur cette instance : créez-la chez {0}, puis collez son identifiant et son secret.", def.nom),
    };
  }
  if (!chiffrementActif()) return { ok: false, message: t("Le chiffrement des données n'est pas actif sur cette machine : l'accès ne sera pas enregistré en clair.") };
  if (flux.get(id)?.echangeEnCours) return { ok: false, message: t("Une connexion est en train d'aboutir. Patientez quelques secondes.") };
  fermerFlux(id);
  issues.delete(id);

  const demandes = Array.isArray(brutChoix) ? brutChoix.filter((c): c is string => typeof c === "string") : [];
  const choix = def.choix.filter((c) => demandes.includes(c.id));
  if (def.choixRequis && !choix.some((c) => c.id !== "ecriture")) return { ok: false, message: tf("Cochez au moins un service de {0} à brancher.", def.nom) };
  /*
   * Sans doublon : chez Brevo, un brouillon et un envoi demandent la même
   * portée. L'ancienne case « page » de LinkedIn (retirée le 29/09/2026), si
   * un écran resté ouvert l'envoie encore, n'est dans aucune définition : elle
   * tombe au filtre ci-dessus, et rien n'est demandé pour elle.
   */
  const portees = [
    ...new Set([
      ...def.lecture,
      ...choix.flatMap((c) => c.portees),
      // Microsoft 365 : les portées d'écriture des services cochés, seulement si « ecriture » l'est aussi.
      ...(demandes.includes("ecriture") ? choix.flatMap((c) => c.ecriture ?? []) : []),
    ]),
  ];

  const etat = PREFIXE_ETAT + base64url(randomBytes(32));
  const verificateur = base64url(randomBytes(48));
  const langueDemande = langue();
  let redirection: string;
  let serveur: http.Server | null = null;
  let serveur6: http.Server | null = null;

  if (def.retour === "boucle") {
    const repondre = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const adresse = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || adresse.pathname !== def.cheminBoucle) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Introuvable.");
        return;
      }
      // La page de retour aussi, dans la langue de la demande (langue.ts, `dansLaLangue`).
      dansLaLangue(langueDemande, () => {
        void recevoir(adresse.searchParams, null).then(
          (r) => pageBoucle(res, r.ok ? 200 : 400, r.ok ? tf("{0} est connecté", def.nom) : t("La connexion n'a pas abouti"), r.ok ? `${r.message} ${t("Vous pouvez fermer cet onglet.")}` : r.message),
          () => pageBoucle(res, 500, t("La connexion n'a pas abouti"), t("Erreur inattendue.")),
        );
      });
    };
    serveur = http.createServer(repondre);
    serveur.keepAliveTimeout = 1000;
    const s = serveur;
    const port = await new Promise<number>((ok, ko) => {
      s.once("error", ko);
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        ok(typeof a === "object" && a ? a.port : 0);
      });
    }).catch(() => 0);
    if (!port) {
      s.close();
      return { ok: false, message: t("Impossible d'ouvrir un port sur la boucle locale pour recevoir la réponse du service.") };
    }
    if (def.boucleLocalhost) {
      /*
       * « localhost » : macOS le résout d'abord en ::1. Le même port y est
       * ouvert si l'on peut ; sinon le navigateur retombe sur 127.0.0.1.
       * Seulement ::1 et 127.0.0.1, jamais une adresse du réseau.
       */
      const s6 = http.createServer(repondre);
      s6.keepAliveTimeout = 1000;
      serveur6 = await new Promise<http.Server | null>((ok) => {
        s6.once("error", () => ok(null));
        s6.listen(port, "::1", () => ok(s6));
      });
    }
    redirection = `http://${def.boucleLocalhost ? "localhost" : "127.0.0.1"}:${port}${def.cheminBoucle}`;
  } else {
    redirection = adresseDeRetour(id, base);
  }

  const f: Flux = {
    id,
    etat,
    verificateur,
    redirection,
    choix: choix.map((c) => c.id),
    portees,
    qui,
    serveur,
    serveur6,
    echangeEnCours: false,
    langue: langueDemande,
    minuterie: setTimeout(() => dansLaLangue(langueDemande, () => conclure(id, false, t("Le délai de dix minutes est dépassé : rien n'a été enregistré. Recommencez."))), LIMITES.fluxMs),
  };
  f.minuterie.unref?.();
  flux.set(id, f);

  const p = new URLSearchParams({
    [def.cleClient]: client.clientId,
    redirect_uri: redirection,
    response_type: "code",
    ...(def.sansPortees ? {} : { scope: portees.join(def.separateur) }),
    state: etat,
    ...def.extras,
  });
  if (def.pkce) {
    const empreinte = createHash("sha256").update(verificateur).digest();
    p.set("code_challenge", def.pkce === "S256-hex" ? empreinte.toString("hex") : base64url(empreinte));
    p.set("code_challenge_method", "S256");
  }
  return { ok: true, message: tf("Autorisez l'accès dans la page de {0} qui s'ouvre. Cette demande expire dans dix minutes.", def.nom), url: `${adressesDe(id, client).consentement}?${p.toString()}` };
}

/**
 * Le retour du fournisseur : par la boucle locale, par la route publique de
 * l'instance (index.ts, `/oxoai/oauth/retour`), ou recopié à l'écran.
 */
export async function recevoir(parametres: URLSearchParams, quiCollage: string | null): Promise<{ ok: boolean; message: string; nom?: string }> {
  const recu = parametres.get("state") ?? "";
  const f = [...flux.values()].find((x) => memeEtat(recu, x.etat));
  // Un `state` inconnu n'annule rien : ce serait donner à n'importe qui le moyen d'interrompre.
  if (!f) return { ok: false, message: t("Cette réponse ne correspond à aucune demande de connexion en cours : elle est ignorée.") };
  // Dans la langue de qui a cliqué « Se connecter » : c'est lui qui lira le message à l'écran (langue.ts, `dansLaLangue`).
  return dansLaLangue(f.langue, () => recevoirFlux(f, parametres, quiCollage));
}

async function recevoirFlux(f: Flux, parametres: URLSearchParams, quiCollage: string | null): Promise<{ ok: boolean; message: string; nom?: string }> {
  const def = DEFINITIONS[f.id];
  /*
   * D'abord : un échange en cours n'est interrompu par rien. Un second retour
   * (même `state`, `error=…`) fermait la demande pendant l'échange, qui
   * enregistrait pourtant le compte ensuite (tournée des connecteurs du
   * 28/09/2026).
   */
  if (f.echangeEnCours) return { ok: false, message: t("La connexion est déjà en train d'aboutir.") };
  const erreur = parametres.get("error");
  if (erreur) {
    // Microsoft 365 : un code AADSTS dit ce qui manque (consentement de l'administrateur, adresse de retour) ; rien de la réponse n'est recopié.
    const propre = def.messages?.refus(erreur.slice(0, 100), (parametres.get("error_description") ?? "").slice(0, 2000));
    // Sinon la cause probable et le remède, par le code du protocole (refusOauth.ts, 28/09/2026).
    return { ...conclure(f.id, false, propre ?? refusLisible(erreur, def.nom, { google: def.google })), nom: def.nom };
  }
  const code = (parametres.get("code") ?? "").replace(/#_$/, "");
  if (!code || code.length > 2048) return { ...conclure(f.id, false, t("La réponse ne contient pas de code d'autorisation. Recommencez.")), nom: def.nom };
  f.echangeEnCours = true;
  try {
    return { ...conclure(f.id, true, await echanger(f, code, quiCollage ?? f.qui)), nom: def.nom };
  } catch (err) {
    return { ...conclure(f.id, false, messageUtilisateur(err)), nom: def.nom };
  }
}

export async function collerAdresse(brutId: unknown, brut: unknown, qui: string): Promise<{ ok: boolean; message: string }> {
  if (!estIdNatif(brutId) || DEFINITIONS[brutId].retour !== "boucle") return { ok: false, message: t("Service inconnu.") };
  const texte = typeof brut === "string" ? brut.trim() : "";
  if (!texte || texte.length > 4096) return { ok: false, message: t("Collez l'adresse complète affichée par le navigateur après votre accord.") };
  let parametres: URLSearchParams;
  try {
    const a = new URL(texte);
    if (a.hostname !== "127.0.0.1" && a.hostname !== "localhost") throw new Error("hôte");
    parametres = a.searchParams;
  } catch {
    return { ok: false, message: t("Cette adresse n'est pas celle du retour : elle commence par http://127.0.0.1.") };
  }
  return recevoir(parametres, qui);
}

const decouper = (v: unknown): string[] =>
  typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function erreurJetons(nom: string, json: Record<string, unknown>): ErreurNatif {
  const e = json.error;
  const code = typeof e === "string" ? e : typeof (e as { code?: unknown })?.code === "string" ? String((e as { code: string }).code) : "";
  if (code === "invalid_grant") return new ErreurNatif("acces", tf("Le code d'autorisation a expiré ou a déjà servi. Recommencez la connexion à {0}.", nom));
  if (code === "invalid_client" || code === "unauthorized_client") return new ErreurNatif("config", tf("{0} ne reconnaît pas l'application enregistrée (identifiant ou secret). Vérifiez-les dans Réglages, Connecteurs.", nom));
  if (/redirect/i.test(code) || /redirect/i.test(String(json.error_description ?? ""))) return new ErreurNatif("config", tf("{0} refuse l'adresse de retour : déclarez-la à l'identique dans l'application, telle que l'écran la montre.", nom));
  return new ErreurNatif("api", tf("{0} a refusé l'échange d'autorisation.", nom));
}

/** Échange le code, relit les portées, lit le compte (l'essai), puis seulement enregistre. */
async function echanger(f: Flux, code: string, qui: string): Promise<string> {
  const id = f.id;
  const def = DEFINITIONS[id];
  const client = clientDe(id);
  if (!client.ok) throw new ErreurNatif("config", tf("L'application {0} n'est plus configurée sur cette instance.", def.nom));
  const secret: Record<string, string> = client.clientSecret ? { client_secret: client.clientSecret } : {};

  let r: ReponseApi;
  if (id === "facebook") {
    // Meta documente un GET, paramètres dans l'adresse, de serveur à serveur.
    r = await envoyer(id, { methode: "GET", hote: def.jetons.hote, chemin: `${def.jetons.chemin}?${formulaire({ client_id: client.clientId, redirect_uri: f.redirection, ...secret, code })}`, octets: LIMITES.jetons });
  } else {
    const qui = identification(id, client);
    const p: Record<string, string> = {
      ...qui.champs,
      code,
      grant_type: "authorization_code",
      redirect_uri: f.redirection,
      ...(def.pkce ? { code_verifier: f.verificateur } : {}),
    };
    const point = adressesDe(id, client).jetons;
    r = await envoyer(id, { methode: "POST", hote: point.hote, chemin: point.chemin, entetes: { ...FORM, ...qui.entetes }, corps: formulaire(p), octets: LIMITES.jetons });
  }
  // Instagram rend parfois ses champs dans `data[0]`.
  const json = Array.isArray(r.json.data) && r.json.data[0] && typeof r.json.data[0] === "object" ? (r.json.data[0] as Record<string, unknown>) : r.json;
  if (r.statut !== 200 || typeof json.access_token !== "string") throw erreurJetons(def.nom, r.json);

  let jetons: JetonsClairs = {
    acces: json.access_token,
    expire: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
    ...(typeof json.refresh_token === "string" ? { actualisation: json.refresh_token } : {}),
    ...(dureeActualisation(json) ? { expireActualisation: Date.now() + dureeActualisation(json) * 1000 } : {}),
  };
  const ids: Record<string, string> = {};
  if (typeof json.open_id === "string") ids.openId = json.open_id.slice(0, 100);
  if (json.user_id !== undefined) ids.utilisateur = String(json.user_id).slice(0, 40);

  const revoquer = () => revocation(id, jetons, true).catch(() => false);
  /*
   * Tournée des connecteurs du 28/09/2026 : le message disait toujours
   * « l'accès a été révoqué », y compris chez LinkedIn et Instagram, qui n'ont
   * pas de révocation, et chez Google quand un autre service s'en sert encore
   * (clientGoogle.ts). Il ne le dit plus que si le fournisseur l'a confirmé.
   */
  const trop = async () => {
    const revoque = await revoquer();
    const base = tf("{0} a accordé plus que ce qui était demandé. Par prudence, rien n'a été enregistré.", def.nom);
    return revoque ? `${base} ${tf("L'accès a été révoqué chez {0}.", def.nom)}` : base;
  };

  // Jeton court de Meta : échangé contre celui de 60 jours, qui seul vaut la peine d'être gardé.
  if (id === "facebook" || id === "instagram") {
    const l =
      id === "facebook"
        ? await envoyer(id, { methode: "GET", hote: "graph.facebook.com", chemin: `/${VERSION_META}/oauth/access_token?${formulaire({ grant_type: "fb_exchange_token", client_id: client.clientId, ...secret, fb_exchange_token: jetons.acces })}`, octets: LIMITES.jetons })
        : await envoyer(id, { methode: "GET", hote: "graph.instagram.com", chemin: `/access_token?${formulaire({ grant_type: "ig_exchange_token", ...secret, access_token: jetons.acces })}`, octets: LIMITES.jetons });
    if (l.statut !== 200 || typeof l.json.access_token !== "string") {
      await revoquer();
      throw new ErreurNatif("api", tf("{0} n'a pas remis d'accès durable. Recommencez la connexion.", def.nom));
    }
    jetons = { acces: l.json.access_token, expire: Date.now() + (Number(l.json.expires_in) || 5_184_000) * 1000 };
  }

  // Ce qui a été accordé, relu. Meta ne le dit pas dans la réponse : on le lui demande.
  let accordees: string[];
  if (id === "facebook") {
    const p = await envoyer(id, { methode: "GET", hote: "graph.facebook.com", chemin: `/${VERSION_META}/me/permissions?${formulaire({ access_token: jetons.acces, appsecret_proof: preuveMeta(jetons.acces, client.clientSecret) })}` });
    const liste = Array.isArray(p.json.data) ? (p.json.data as { permission?: unknown; status?: unknown }[]) : [];
    accordees = liste.filter((x) => x.status === "granted" && typeof x.permission === "string").map((x) => String(x.permission));
  } else {
    accordees = def.relecture ? def.relecture.accordees(json.scope) : decouper(json.scope ?? json.permissions);
  }
  if (def.sansPortees) {
    // Mailchimp n'a pas de portées : rien à relire, et rien ne doit revenir.
    if (accordees.length > 0) throw new ErreurNatif("portee", await trop());
  } else if (accordees.length === 0) {
    /*
     * Les quatre documentations disent rendre les portées accordées : leur
     * absence est une anomalie, pas un accord. X ne l'écrit pas dans sa page ;
     * la réponse montrée sur son forum des développeurs porte `scope`
     * (« offline.access tweet.write media.write users.read tweet.read ») :
     * la même règle vaut, à vérifier sur le vrai service (PROJET.md).
     */
    await revoquer();
    throw new ErreurNatif("portee", t("Le service n'a pas dit quels accès il accordait : rien n'a été enregistré."));
  }
  // Comparées sous une même forme (Microsoft : sans le préfixe de Graph, sans casse) ; les autres telles quelles.
  const forme = def.relecture?.normaliser ?? ((p: string) => p);
  const recues = accordees.map(forme);
  const implicites = def.implicites.map(forme);
  // Mailchimp n'a pas de portées (`sansPortees`) : rien ne peut manquer.
  const manquantes = def.sansPortees ? [] : f.portees.filter((p) => !recues.includes(forme(p)) && !implicites.includes(forme(p)));
  if (manquantes.length > 0) {
    await revoquer();
    throw new ErreurNatif("portee", def.messages ? def.messages.manquantes(manquantes) : tf("Tous les accès demandés n'ont pas été accordés dans {0} (une case décochée, ou une permission que l'application n'a pas). Rien n'a été enregistré.", def.nom));
  }
  const demandees = f.portees.map(forme);
  const enTrop = recues.filter((p) => !demandees.includes(p) && !implicites.includes(p));
  if (enTrop.length > 0) {
    if (def.messages) {
      await revoquer();
      throw new ErreurNatif("portee", def.messages.enTrop(enTrop.map((p) => texteCourt(p, 80))));
    }
    throw new ErreurNatif("portee", await trop());
  }

  // L'essai : lire le compte avec ce jeton. Rien n'est gardé s'il échoue.
  let compte: string;
  try {
    const lu = await identite(id, jetons.acces, client);
    compte = lu.compte;
    Object.assign(ids, lu.ids);
  } catch (err) {
    await revoquer();
    throw err;
  }

  await charger();
  const avant = magasin!.comptes[id];
  magasin!.comptes[id] = {
    compte,
    choix: f.choix,
    portees: f.portees,
    ids,
    jetons: chiffrer(jetons, placeJetons(id)),
    clientId: client.clientId,
    depuis: new Date().toISOString(),
    par: qui,
  };
  try {
    await ecrire();
  } catch (err) {
    if (avant) magasin!.comptes[id] = avant;
    else delete magasin!.comptes[id];
    await revoquer();
    throw err;
  }
  journaliser("natif.branche", qui, { service: id, choix: f.choix });
  return f.choix.length > 0 ? tf("{0} connecté : {1}. Chaque écriture ou publication vous sera montrée et demandera votre accord.", def.nom, compte) : tf("{0} connecté en lecture seule : {1}.", def.nom, compte);
}

const texteCourt = (v: unknown, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim().slice(0, max) : "");

/** En-têtes des appels `/rest/…` de LinkedIn (organizationAcls, posts, statistiques). */
export const entetesLinkedin = (acces: string, json = false): Record<string, string> => ({
  Authorization: `Bearer ${acces}`,
  "LinkedIn-Version": VERSION_LINKEDIN,
  "X-Restli-Protocol-Version": "2.0.0",
  ...(json ? { "Content-Type": "application/json" } : {}),
});

/** Les pages administrées que liste organizationAcls, dans l'ordre, dix au plus. */
export const CHEMIN_ACL_LINKEDIN = "/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=20";

/**
 * Les identifiants de page d'une réponse d'organizationAcls, et la personne
 * (`roleAssignee`). La page est sous `organization`, ou sous
 * `organizationTarget` dans d'autres exemples de la même documentation
 * (organization-access-control-by-role, lue le 29/09/2026) : les deux sont
 * lus. Seules les formes `urn:li:organization:<chiffres>` et
 * `urn:li:person:<identifiant>` sont gardées.
 */
export function lireAclLinkedin(json: Record<string, unknown>): { pages: string[]; membre?: string } {
  const elements = Array.isArray(json.elements) ? (json.elements as { organization?: unknown; organizationTarget?: unknown; roleAssignee?: unknown }[]) : [];
  const pages = [
    ...new Set(
      elements
        .map((e) => /^urn:li:organization:(\d{1,20})$/.exec(texteCourt(e.organization ?? e.organizationTarget, 60))?.[1])
        .filter((x): x is string => Boolean(x)),
    ),
  ].slice(0, 10);
  const membre = elements.map((e) => /^urn:li:person:([A-Za-z0-9_-]{1,100})$/.exec(texteCourt(e.roleAssignee, 120))?.[1]).find(Boolean);
  return { pages, ...(membre ? { membre } : {}) };
}

/**
 * La Page d'entreprise LinkedIn (29/09/2026) : sans `profile`, le compte se
 * lit par les pages qu'il administre. Aucune page administrée : la connexion
 * ne servirait à rien, rien n'est gardé. Le nom affiché est celui de la
 * première page (un appel de plus : le palier de développement de LinkedIn ne
 * permet que 100 appels par personne et par jour).
 */
async function identitePageLinkedin(acces: string): Promise<{ compte: string; ids: Record<string, string> }> {
  const nom = DEFINITIONS.linkedinPage.nom;
  const r = await envoyer("linkedinPage", { methode: "GET", hote: "api.linkedin.com", chemin: CHEMIN_ACL_LINKEDIN, entetes: entetesLinkedin(acces) });
  if (r.statut !== 200) {
    throw new ErreurNatif(r.statut === 401 || r.statut === 403 ? "acces" : "api", tf("{0} n'a pas laissé lire le compte avec l'accès accordé (code {1}). Rien n'a été enregistré.", nom, r.statut));
  }
  const { pages, membre } = lireAclLinkedin(r.json);
  if (pages.length === 0) {
    throw new ErreurNatif("acces", t("Le compte LinkedIn connecté n'administre aucune page d'entreprise : rien n'a été enregistré. Connectez-vous avec un compte administrateur de la page."));
  }
  const o = await envoyer("linkedinPage", { methode: "GET", hote: "api.linkedin.com", chemin: `/rest/organizations/${pages[0]}`, entetes: entetesLinkedin(acces) }).catch(() => null);
  const premiere = (o?.statut === 200 ? texteCourt(o.json.localizedName) : "") || pages[0]!;
  return {
    compte: pages.length > 1 ? tf("{0} et {1} autre(s) page(s)", premiere, pages.length - 1) : premiere,
    ids: { ...(membre ? { membre } : {}), page: pages[0]! },
  };
}

/** Lit le compte avec le jeton obtenu : c'est l'essai qui précède l'enregistrement. */
async function identite(id: IdNatif, acces: string, client: { clientId: string; clientSecret: string }): Promise<{ compte: string; ids: Record<string, string> }> {
  const bearer = { Authorization: `Bearer ${acces}` };
  const echec = (r: ReponseApi) => new ErreurNatif(r.statut === 401 || r.statut === 403 ? "acces" : "api", tf("{0} n'a pas laissé lire le compte avec l'accès accordé (code {1}). Rien n'a été enregistré.", DEFINITIONS[id].nom, r.statut));
  switch (id) {
    case "sheets":
    case "slides":
    case "docs":
    case "forms": {
      // Ni Sheets ni Slides n'ont de « qui suis-je » avec leur seule portée : on vérifie que le jeton est bien pour cette application.
      const r = await envoyer(id, { methode: "GET", hote: "oauth2.googleapis.com", chemin: `/tokeninfo?${formulaire({ access_token: acces })}` });
      if (r.statut !== 200 || r.json.aud !== client.clientId) throw echec(r);
      return { compte: t("compte Google"), ids: {} };
    }
    case "youtube": {
      const r = await envoyer(id, { methode: "GET", hote: "www.googleapis.com", chemin: "/youtube/v3/channels?part=snippet&mine=true", entetes: bearer });
      if (r.statut !== 200) throw echec(r);
      const ch = Array.isArray(r.json.items) ? (r.json.items[0] as { id?: unknown; snippet?: { title?: unknown } } | undefined) : undefined;
      return { compte: texteCourt(ch?.snippet?.title) || t("compte Google sans chaîne"), ids: typeof ch?.id === "string" ? { chaine: ch.id } : {} };
    }
    case "linkedin": {
      const r = await envoyer(id, { methode: "GET", hote: "api.linkedin.com", chemin: "/v2/userinfo", entetes: bearer });
      if (r.statut !== 200 || typeof r.json.sub !== "string") throw echec(r);
      return { compte: texteCourt(r.json.name) || "LinkedIn", ids: { membre: r.json.sub.slice(0, 100) } };
    }
    case "linkedinPage":
      return identitePageLinkedin(acces);
    case "facebook": {
      const r = await envoyer(id, { methode: "GET", hote: "graph.facebook.com", chemin: `/${VERSION_META}/me?${formulaire({ fields: "id,name", access_token: acces, appsecret_proof: preuveMeta(acces, client.clientSecret) })}` });
      if (r.statut !== 200 || typeof r.json.id !== "string") throw echec(r);
      return { compte: texteCourt(r.json.name) || "Facebook", ids: { utilisateur: r.json.id.slice(0, 40) } };
    }
    case "instagram": {
      const r = await envoyer(id, { methode: "GET", hote: "graph.instagram.com", chemin: `/${VERSION_META}/me?${formulaire({ fields: "user_id,username,account_type", access_token: acces })}` });
      if (r.statut !== 200 || r.json.user_id === undefined) throw echec(r);
      return { compte: texteCourt(r.json.username) ? `@${texteCourt(r.json.username)}` : "Instagram", ids: { utilisateur: String(r.json.user_id).slice(0, 40) } };
    }
    case "tiktok": {
      const r = await envoyer(id, { methode: "GET", hote: "open.tiktokapis.com", chemin: "/v2/user/info/?fields=open_id,display_name", entetes: bearer });
      const u = ((r.json.data ?? {}) as { user?: { display_name?: unknown; open_id?: unknown } }).user;
      if (r.statut !== 200 || !u) throw echec(r);
      return { compte: texteCourt(u.display_name) || "TikTok", ids: typeof u.open_id === "string" ? { openId: u.open_id.slice(0, 100) } : {} };
    }
    case "x": {
      // https://docs.x.com/x-api/users/get-my-user (`tweet.read`, `users.read`). L'identifiant sert ensuite à lire ses posts.
      const r = await envoyer(id, { methode: "GET", hote: "api.x.com", chemin: "/2/users/me?user.fields=username,name", entetes: bearer });
      /*
       * Lire le compte est facturé (0,010 $) : sans crédit, c'est ici que la
       * connexion échoue. Tournée de la 2026.928.3 (SECURITE.md § 43) : la page
       * disait « n'a pas laissé lire le compte avec l'accès accordé (code
       * 402) », sans dire que la seule chose à faire est d'acheter des crédits.
       */
      if (r.statut === 402) throw new ErreurNatif("quota", t("X refuse de lire le compte (code 402, paiement requis) : l'application X de l'organisation n'a probablement pas de crédits. Achetez-en dans la console de X (console.x.com), puis reconnectez-vous. Rien n'a été enregistré."));
      const u = (r.json.data ?? {}) as { id?: unknown; username?: unknown; name?: unknown };
      if (r.statut !== 200 || typeof u.id !== "string" || !/^\d{1,19}$/.test(u.id)) throw echec(r);
      const pseudo = texteCourt(u.username, 50);
      return { compte: pseudo ? `@${pseudo}` : texteCourt(u.name) || "X", ids: { utilisateur: u.id } };
    }
    case "dropbox":
      return identiteDropbox(acces);
    case "brevo":
    case "mailchimp":
      return identiteProjet(id, acces, envoyer, echec);
    case "microsoft": {
      // https://learn.microsoft.com/en-us/graph/api/user-get (`User.Read`) : le compte branché, et son identifiant.
      const r = await envoyer(id, { methode: "GET", hote: "graph.microsoft.com", chemin: "/v1.0/me?$select=id,displayName,mail,userPrincipalName", entetes: bearer });
      if (r.statut !== 200 || typeof r.json.id !== "string" || !/^[0-9a-fA-F-]{8,64}$/.test(r.json.id)) throw echec(r);
      return { compte: texteCourt(r.json.mail) || texteCourt(r.json.userPrincipalName) || texteCourt(r.json.displayName) || "Microsoft 365", ids: { utilisateur: r.json.id } };
    }
  }
}

/**
 * Révoque chez le fournisseur quand il le permet. Rend vrai s'il l'a confirmé.
 * `echec` : la connexion en cours n'aboutit pas ; le compte déjà branché pour
 * ce service, s'il y en a un, compte alors parmi ceux à ne pas couper.
 */
async function revocation(id: IdNatif, j: JetonsClairs, echec = false): Promise<boolean> {
  const client = clientDe(id);
  if (DEFINITIONS[id].google) {
    // Google révoque tout ce que le projet a reçu de la personne (clientGoogle.ts, `autresUsagesGoogle`) : pas tant qu'un autre service s'en sert.
    if ((await autresUsagesGoogle(echec ? "" : `natif.${id}`)).length > 0) return false;
    const r = await envoyer(id, { methode: "POST", hote: "oauth2.googleapis.com", chemin: "/revoke", entetes: FORM, corps: formulaire({ token: j.actualisation ?? j.acces }), octets: LIMITES.jetons });
    return r.statut === 200;
  }
  if (id === "facebook" && client.ok) {
    // « DELETE /me/permissions » retire toutes les permissions accordées à l'application.
    const r = await envoyer(id, { methode: "DELETE", hote: "graph.facebook.com", chemin: `/${VERSION_META}/me/permissions?${formulaire({ access_token: j.acces, appsecret_proof: preuveMeta(j.acces, client.clientSecret) })}` });
    return r.statut === 200;
  }
  if (id === "tiktok" && client.ok) {
    const r = await envoyer(id, { methode: "POST", hote: "open.tiktokapis.com", chemin: "/v2/oauth/revoke/", entetes: FORM, corps: formulaire({ client_key: client.clientId, client_secret: client.clientSecret, token: j.acces }), octets: LIMITES.jetons });
    return r.statut === 200;
  }
  if (id === "x" && client.ok) {
    /*
     * « A revoke token invalidates an access token or refresh token » : les
     * deux sont révoqués, l'actualisation d'abord (c'est elle qui ferait
     * renaître un accès). Même identification qu'à l'échange du code.
     */
    const qui = identification(id, client);
    let tous = true;
    for (const jeton of [j.actualisation, j.acces].filter((v): v is string => Boolean(v))) {
      const r = await envoyer(id, { methode: "POST", hote: "api.x.com", chemin: "/2/oauth2/revoke", entetes: { ...FORM, ...qui.entetes }, corps: formulaire({ ...qui.champs, token: jeton }), octets: LIMITES.jetons }).catch(() => null);
      tous = tous && r?.statut === 200;
    }
    return tous;
  }
  // Dropbox : révoquer le jeton d'accès éteint aussi le jeton d'actualisation ; un jeton d'accès expiré est d'abord renouvelé.
  if (id === "dropbox") return revoquerDropbox(j.acces, async () => (await rafraichir(id, j))?.acces ?? null);
  if ((id === "brevo" || id === "mailchimp") && client.ok) return revocationProjet(id, j, client, envoyer);
  // LinkedIn et Instagram : pas de révocation documentée pour ces parcours ; l'écran dit où retirer l'accès.
  return false;
}

/** Débranche, et révoque chez le fournisseur quand il le permet : un jeton effacé ici mais valable là-bas resterait utilisable. */
export async function oublier(brutId: unknown, qui: string): Promise<{ ok: boolean; message: string }> {
  if (!estIdNatif(brutId)) return { ok: false, message: t("Service inconnu.") };
  const id = brutId;
  const def = DEFINITIONS[id];
  await charger();
  fermerFlux(id);
  issues.delete(id);
  const avant = magasin!.comptes[id];
  // Services Google : la révocation couperait aussi les autres (clientGoogle.ts) ; lus avant d'effacer celui-ci.
  const autresGoogle = def.google && avant ? await autresUsagesGoogle(`natif.${id}`) : [];
  let revoque = false;
  if (avant) {
    const j = jetonsDe(id, avant);
    if (j) revoque = await revocation(id, j).catch(() => false);
  }
  delete magasin!.comptes[id];
  await ecrire();
  journaliser("natif.debranche", qui, { service: id, revoque });
  if (!avant) return { ok: true, message: tf("{0} n'était pas connecté.", def.nom) };
  return {
    ok: true,
    message: revoque
      ? tf("{0} a été débranché, et l'accès révoqué chez {0}.", def.nom)
      : autresGoogle.length > 0
        ? messageSansRevocationGoogle(def.nom, autresGoogle)
        : def.messages
        ? def.messages.debranche()
        : tf("{0} a été débranché de cette instance. {0} n'a pas confirmé la révocation : retirez aussi l'accès de l'application dans les réglages de votre compte {0}.", def.nom),
  };
}

export function messageUtilisateur(err: unknown): string {
  if (err instanceof ErreurNatif || err instanceof ErreurTransport) return err.message;
  return t("La connexion au service a échoué.");
}

/* ------------------------------------------------------------------ */
/* État montré à l'écran                                               */
/* ------------------------------------------------------------------ */

export interface EtatNatif {
  id: IdNatif;
  nom: string;
  google: boolean;
  /** L'application du fournisseur est-elle renseignée ? */
  application: { disponible: boolean; identifiant?: string; avecSecret?: boolean; source?: "google" | "ecran"; annuaire?: string };
  choix: { id: Choix["id"]; portees: string[]; revue: boolean; ecriture?: string[]; admin?: boolean }[];
  lecture: string[];
  /** Adresse de retour à déclarer chez le fournisseur. */
  retour: string;
  configure: boolean;
  compte?: string;
  accordes?: Choix["id"][];
  depuis?: string;
  /** Date où l'accès expirera sans renouvellement possible (Facebook, LinkedIn). */
  expireLe?: string;
  aReconnecter: boolean;
  attente: boolean;
  issue?: { ok: boolean; message: string; quand: string };
  documentation: string[];
}

/** Ce que l'écran peut savoir : aucun jeton ni secret, sous aucune forme. */
export async function etat(base: string): Promise<EtatNatif[]> {
  await charger();
  return IDS_NATIFS.map((id) => {
    const def = DEFINITIONS[id];
    const client = clientDe(id);
    const c = magasin!.comptes[id];
    const ok = utilisable(id) !== null;
    const j = c && ok ? jetonsDe(id, c) : null;
    const sansRenouvellement = j && !j.actualisation && id !== "instagram" && j.expire;
    return {
      id,
      nom: def.nom,
      google: def.google,
      application: client.ok ? { disponible: true, identifiant: client.clientId, avecSecret: Boolean(client.clientSecret), source: client.source, ...(client.annuaire ? { annuaire: client.annuaire } : {}) } : { disponible: false },
      choix: def.choix.map((x) => ({ id: x.id, portees: [...x.portees], revue: x.revue, ...(x.ecriture ? { ecriture: [...x.ecriture] } : {}), ...(x.admin ? { admin: true } : {}) })),
      lecture: [...def.lecture],
      retour: adresseDeRetour(id, base),
      configure: ok,
      ...(c ? { compte: c.compte, accordes: [...c.choix], depuis: c.depuis } : {}),
      ...(sansRenouvellement ? { expireLe: new Date(j.expire!).toISOString() } : {}),
      aReconnecter: Boolean(c) && !ok,
      attente: flux.has(id),
      ...(issues.get(id) ? { issue: issues.get(id) } : {}),
      documentation: [...def.documentation],
    };
  });
}
