import oxoaiMark from "@/assets/oxoai-mark.png";
import oxoaiLogo from "@/assets/oxoai-logo.png";
import { t } from "@/lib/i18n";

/**
 * POINT DE PERSONNALISATION CLIENT UNIQUE.
 * -----------------------------------------------------------------------------
 * Toute la marque de la plateforme (nom affiche, logo, couleurs primaires,
 * URLs, pied de page) est pilotee depuis ce fichier. Changer ces valeurs suffit
 * a rebrander l'application entiere : aucun composant ne code une marque en dur.
 *
 * Les couleurs de theme (palette complete) vivent dans `src/styles/tokens.css`.
 * Ici on ne place que ce qui est propre a un client donne.
 */

export interface BrandLogo {
  /** Logo complet (mark + mot-repere) — utilise dans l'en-tete de barre laterale. */
  wordmark: string;
  /** Mark seul, sans texte — utilise au centre de l'ecran d'accueil. */
  mark: string;
  /** Texte alternatif accessible du logo. */
  alt: string;
}

/**
 * Édition du produit livrée au client.
 * `chat` = version allégée : conversation seule, modèles locaux, sans agent
 * qui agit sur la machine. `complete` = toutes les surfaces.
 */
export type Edition = "chat" | "complete";

/** Modules activables. Une édition n'est qu'un préréglage de ces drapeaux. */
export interface Features {
  cowork: boolean;
  /**
   * L'écran d'abonnement aux modèles hébergés.
   *
   * Éteint par défaut, dans les deux éditions : une entreprise qui installe
   * OxoAI chez elle n'a rien à acheter, et lui présenter une offre
   * commerciale dans ses propres réglages serait déplacé. Il s'allume par
   * `featureOverrides` dans la version distribuée par le prestataire qui,
   * lui, vend l'hébergement.
   */
  abonnement: boolean;
  code: boolean;
  projets: boolean;
  agents: boolean;
  bibliotheque: boolean;
  reunions: boolean;
  groupes: boolean;
  taches: boolean;
}

export const EDITION_PRESETS: Record<Edition, Features> = {
  chat: {
    cowork: false,
    abonnement: false,
    code: false,
    projets: true,
    agents: true,
    bibliotheque: true,
    reunions: true,
    groupes: true,
    taches: true,
  },
  complete: {
    cowork: true,
    abonnement: false,
    code: true,
    projets: true,
    agents: true,
    bibliotheque: true,
    reunions: true,
    groupes: true,
    taches: true,
  },
};

export interface Branding {
  /** Nom produit affiche partout (barre laterale, titres, a-propos). */
  name: string;
  /** Nom court / handle technique (favicon, sous-domaines). */
  shortName: string;
  /** Accroche courte, utilisee sur les ecrans d'accueil secondaires. */
  tagline: string;
  /** Version applicative affichee dans Parametres > Preferences. */
  version: string;
  /** Edition livree a ce client (preregle les modules actifs). */
  edition: Edition;
  /** Surcharge ponctuelle de modules, par-dessus le preset d'edition. */
  featureOverrides?: Partial<Features>;
  /** Couleurs intrinseques du logo-mark. */
  logo: BrandLogo;
  /** URLs & contacts propres au client. */
  urls: {
    instance: string;
    marketing: string;
    releases: string;
    /**
     * Où trouver le code source de **cette** version.
     *
     * Ce n'est pas une courtoisie : la licence du produit (AGPL-3.0) oblige qui
     * le distribue ou le propose comme service en ligne à en fournir le code à
     * ses utilisateurs. En marque blanche, c'est au prestataire d'y faire
     * pointer **son** dépôt, avec ses propres modifications. L'écran « À propos »
     * affiche cette adresse pour que l'obligation soit tenue par défaut.
     */
    sourceCode: string;
    dpoEmail: string;
    supportEmail: string;
  };
  /** Pied de page. */
  footer: {
    copyright: string;
    legalName: string;
  };
}

export const branding: Branding = {
  name: "OxoAI",
  shortName: "oxoai",
  tagline: t("Votre espace de travail IA, sur votre machine"),
  // Lue dans package.json à la construction : ne pas l'écrire à la main.
  version: __OXOAI_VERSION__,
  edition: "complete",
  // OxoAI ne vend rien : pas d'écran d'abonnement aux modèles hébergés.
  logo: {
    // Images importées comme modules : l'outil de construction en calcule
    // l'adresse. C'est le seul moyen fiable — un chemin écrit à la main casse
    // soit sur une route imbriquée (« /parametres/profil »), soit une fois
    // l'application empaquetée et chargée depuis le disque.
    // Pour rebrander : remplacer les fichiers dans `src/assets/`.
    wordmark: oxoaiLogo,
    mark: oxoaiMark,
    alt: "OxoAI",
  },
  urls: {
    // Pas d'instance hébergée ni de site commercial : OxoAI s'installe chez soi.
    instance: "",
    marketing: "",
    // Le dépôt public (27/09/2026) ; « latest » mène toujours à la dernière version publiée.
    releases: "https://github.com/martinleonardcyber-ops/oxoai/releases/latest",
    sourceCode: "https://github.com/martinleonardcyber-ops/oxoai",
    // Vides : l'aide passe par les tickets GitHub, et les écrans qui proposent
    // un mail ou un DPO ne s'affichent que si une adresse est renseignée ici.
    dpoEmail: "",
    supportEmail: "",
  },
  footer: {
    copyright: `© ${new Date().getFullYear()} OxoAI · d'après HelixAI de Medhi Clabaut (Helix Agence)`,
    // Dérivé de HelixAI (AGPL-3.0) : les droits d'origine restent à son auteur (COPYRIGHT.md).
    legalName: "OxoAI",
  },
};

/** Modules réellement actifs : preset d'édition + surcharges éventuelles. */
export const features: Features = {
  ...EDITION_PRESETS[branding.edition],
  ...(branding.featureOverrides ?? {}),
};

export default branding;
