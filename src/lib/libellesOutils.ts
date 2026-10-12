import { t } from "@/lib/i18n";
/**
 * Ce que l'outil fait, en français. Le nom technique (« read_file »,
 * « envoyer ») n'est pas une phrase ; un outil inconnu (connecteur ajouté)
 * garde son nom, faute de mieux.
 */
const LIBELLES_OUTILS: Record<string, string> = {
  /*
   * Deux libellés, pas un (28/09/2026) : le serveur de fichiers propose les
   * deux outils, et la liste des outils de Cowork montrait deux fois « Lecture
   * d'un fichier ». `read_file` est l'ancien nom de `read_text_file`.
   */
  read_file: t("Lecture d'un fichier (ancien outil)"),
  read_text_file: t("Lecture d'un fichier texte"),
  read_media_file: t("Ouverture d'une image"),
  read_multiple_files: t("Lecture de fichiers"),
  write_file: t("Écriture d'un fichier"),
  edit_file: t("Modification d'un fichier"),
  create_directory: t("Création d'un dossier"),
  list_directory: t("Contenu d'un dossier"),
  list_directory_with_sizes: t("Contenu d'un dossier, avec les tailles"),
  directory_tree: t("Arborescence"),
  move_file: t("Déplacement d'un fichier"),
  search_files: t("Recherche de fichiers"),
  get_file_info: t("Informations sur un fichier"),
  list_allowed_directories: t("Dossiers accessibles"),
  courrier__derniers: t("Derniers mails"),
  courrier__chercher: t("Recherche dans les mails"),
  courrier__lire: t("Lecture d'un mail"),
  courrier__brouillon: t("Brouillon de mail"),
  courrier__envoyer: t("Envoi d'un mail"),
  agenda__prochains: t("Prochains rendez-vous"),
  agenda__jour: t("Agenda du jour"),
  agenda__chercher: t("Recherche dans l'agenda"),
  agenda__creer: t("Création d'un événement"),
  agenda__modifier: t("Modification d'un événement"),
  agenda__supprimer: t("Suppression d'un événement"),
  drive__chercher: t("Recherche dans le Drive"),
  drive__recents: t("Fichiers récents du Drive"),
  drive__dossier: t("Dossier du Drive"),
  drive__lire: t("Lecture d'un fichier du Drive"),
  slack__salons: t("Salons Slack"),
  slack__messages: t("Messages Slack"),
  slack__fil: t("Fil Slack"),
  slack__chercher: t("Recherche dans Slack"),
  bureau__creer_document: t("Création d'un document Word"),
  bureau__creer_classeur: t("Création d'un classeur Excel"),
  bureau__creer_presentation: t("Création d'une présentation"),
  bureau__creer_pdf: t("Création d'un PDF"),
  bureau__lire_document: t("Lecture d'un document"),
  bibliotheque__chercher: t("Recherche dans la bibliothèque"),
  bibliotheque__lire: t("Lecture d'un document de la bibliothèque"),
  reunions__chercher: t("Recherche dans les réunions"),
  reunions__lire: t("Lecture d'une réunion"),
  controle__site_web: t("Contrôle du code web"),
  // Recherche sur le web du Chat (gateway/src/rechercheWeb.ts) et web gardé des employés : mêmes noms.
  web__chercher: t("Recherche sur le web"),
  web__lire: t("Lecture d'une page web"),
  /*
   * Palmier Pro (29/09/2026, gateway/src/palmierRegles.ts) : ceux dont la carte
   * doit se comprendre hors du français, parce qu'ils sortent de la machine ou
   * coûtent des crédits. Les autres gardent leur nom.
   */
  palmier__generate_video: t("Génération d'une vidéo (Palmier Pro)"),
  palmier__generate_image: t("Génération d'une image (Palmier Pro)"),
  palmier__generate_audio: t("Génération d'un son (Palmier Pro)"),
  palmier__upscale_media: t("Amélioration d'une vidéo ou d'une image par l'IA (Palmier Pro)"),
  palmier__get_transcript: t("Transcription de la timeline (Palmier Pro)"),
  palmier__add_captions: t("Sous-titres de la timeline (Palmier Pro)"),
  palmier__send_feedback: t("Message à l'équipe de Palmier"),
  palmier__get_timeline: t("Lecture de la timeline (Palmier Pro)"),
  palmier__add_clips: t("Ajout de plans à la timeline (Palmier Pro)"),
  // Roblox Studio et Blender (12/10/2026) : ce qui exécute du code, modifie ou sort de la machine.
  roblox__execute_luau: t("Exécution de code Luau (Roblox Studio)"),
  roblox__multi_edit: t("Modification d'un script (Roblox Studio)"),
  roblox__generate_mesh: t("Génération d'un objet 3D (Roblox Studio)"),
  roblox__generate_material: t("Génération d'un matériau (Roblox Studio)"),
  roblox__generate_procedural_model: t("Génération d'un modèle (Roblox Studio)"),
  roblox__upload_image: t("Envoi d'une image chez Roblox"),
  roblox__insert_asset: t("Ajout d'un élément du Creator Store (Roblox Studio)"),
  roblox__script_read: t("Lecture d'un script (Roblox Studio)"),
  blender__execute_blender_code: t("Exécution de code Python (Blender)"),
  blender__generate_3d: t("Génération d'un objet 3D (Blender)"),
  blender__search_assets: t("Recherche dans une bibliothèque en ligne (Blender)"),
  blender__import_asset: t("Import d'un élément d'une bibliothèque en ligne (Blender)"),
  blender__get_scene_info: t("Lecture de la scène (Blender)"),
  blender__look: t("Image de la scène (Blender)"),
  // Outils livrés de l'agent de code, quand ils demandent un accord (gateway/src/permissionsCode.ts).
  code__bash: t("Commande de l'agent de code"),
  code__edit: t("Modification d'un fichier du projet"),
  code__write: t("Modification d'un fichier du projet"),
  code__apply_patch: t("Modification d'un fichier du projet"),
  code__webfetch: t("Ouverture d'une adresse internet"),
  code__websearch: t("Recherche sur internet"),
  code__read: t("Lecture d'un fichier du projet"),
  code__glob: t("Recherche dans le projet"),
  code__grep: t("Recherche dans le projet"),
  code__list: t("Contenu d'un dossier du projet"),
  // Contrôle de l'écran (computer.ts) : sans eux, la trace montrait « cliquer », « ouvrir app ».
  ecran__capture: t("Capture de l'écran"),
  ecran__cliquer: t("Clic sur l'écran"),
  ecran__double_cliquer: t("Double-clic sur l'écran"),
  ecran__clic_droit: t("Clic droit sur l'écran"),
  ecran__glisser: t("Glisser sur l'écran"),
  ecran__defiler: t("Défilement de l'écran"),
  ecran__saisir: t("Saisie au clavier"),
  ecran__touche: t("Touche du clavier"),
  ecran__ouvrir_app: t("Ouverture d'une application"),
  ecran__attendre: t("Attente"),
  ecran__enregistrer_document: t("Enregistrement du document"),
  ecran__saisir_tableau: t("Saisie d'un tableau"),
  ecran__deplacer: t("Déplacement du curseur"),
  // Messageries (gateway/src/natifs/messageries.ts, 28/09/2026) : la carte d'un envoi, hors du français, commence par ce libellé.
  telegram__conversations: t("Conversations Telegram"),
  telegram__messages: t("Lecture de messages Telegram"),
  telegram__envoyer: t("Envoi d'un message Telegram"),
  discord__salons: t("Salons Discord"),
  discord__messages: t("Lecture de messages Discord"),
  discord__envoyer: t("Envoi d'un message Discord"),
  whatsapp__conversations: t("Conversations WhatsApp"),
  whatsapp__messages: t("Lecture de messages WhatsApp"),
  whatsapp__modeles: t("Modèles de message WhatsApp"),
  whatsapp__envoyer: t("Envoi d'un message WhatsApp"),
  whatsapp__envoyer_modele: t("Envoi d'un modèle WhatsApp"),
  /*
   * Les autres connexions natives (revue du 28/09/2026) : Google Sheets,
   * Slides, Docs, Forms, YouTube, réseaux sociaux, Dropbox, commerce, Brevo,
   * Mailchimp et Microsoft 365. Hors du français, la carte d'accord et les
   * étapes du Chat commencent par ce libellé : sans lui, une interface anglaise
   * ou japonaise lisait le nom interne, en français (« publier », « noter »,
   * « envoyer campagne »). Les noms sont ceux d'approbation.ts
   * (LECTURES_NATIVES, ECRITURES_NATIVES).
   */
  sheets__lire: t("Lecture d'une feuille Google Sheets"),
  sheets__ecrire: t("Écriture dans une feuille Google Sheets"),
  sheets__ajouter_lignes: t("Ajout de lignes à une feuille Google Sheets"),
  slides__lire: t("Lecture d'une présentation Google Slides"),
  youtube__chaine: t("Chaîne YouTube"),
  youtube__videos: t("Vidéos YouTube"),
  linkedin__profil: t("Profil LinkedIn"),
  linkedin__pages: t("Pages LinkedIn"),
  linkedin__publications: t("Publications LinkedIn"),
  linkedin__statistiques: t("Statistiques LinkedIn"),
  linkedin__publier: t("Publication sur LinkedIn"),
  linkedin__publier_page: t("Publication sur une page LinkedIn"),
  facebook__pages: t("Pages Facebook"),
  facebook__publications: t("Publications Facebook"),
  facebook__publier: t("Publication sur Facebook"),
  instagram__compte: t("Compte Instagram"),
  instagram__publications: t("Publications Instagram"),
  instagram__statistiques: t("Statistiques Instagram"),
  instagram__publier: t("Publication sur Instagram"),
  tiktok__profil: t("Profil TikTok"),
  tiktok__videos: t("Vidéos TikTok"),
  tiktok__publier_video: t("Publication d'une vidéo sur TikTok"),
  x__profil: t("Profil X"),
  x__publications: t("Posts X"),
  x__publier: t("Publication sur X"),
  docs__lire: t("Lecture d'un document Google Docs"),
  docs__creer: t("Création d'un document Google Docs"),
  docs__ajouter_texte: t("Ajout de texte à un document Google Docs"),
  forms__lire: t("Lecture d'un formulaire Google Forms"),
  forms__reponses: t("Réponses d'un formulaire Google Forms"),
  dropbox__lister: t("Contenu d'un dossier Dropbox"),
  dropbox__chercher: t("Recherche dans Dropbox"),
  dropbox__lire: t("Lecture d'un fichier Dropbox"),
  dropbox__envoyer: t("Envoi d'un fichier vers Dropbox"),
  stripe__paiements: t("Paiements Stripe"),
  stripe__clients: t("Clients Stripe"),
  stripe__factures: t("Factures Stripe"),
  stripe__abonnements: t("Abonnements Stripe"),
  shopify__commandes: t("Commandes Shopify"),
  shopify__produits: t("Produits Shopify"),
  shopify__stocks: t("Stocks Shopify"),
  woocommerce__commandes: t("Commandes WooCommerce"),
  woocommerce__produits: t("Produits WooCommerce"),
  salesforce__contacts: t("Contacts Salesforce"),
  salesforce__affaires: t("Opportunités Salesforce"),
  salesforce__noter: t("Note dans Salesforce"),
  pipedrive__contacts: t("Contacts Pipedrive"),
  pipedrive__affaires: t("Affaires Pipedrive"),
  pipedrive__noter: t("Note dans Pipedrive"),
  zendesk__tickets: t("Tickets Zendesk"),
  zendesk__ticket: t("Lecture d'un ticket Zendesk"),
  zendesk__repondre: t("Réponse à un ticket Zendesk"),
  brevo__compte: t("Compte Brevo"),
  brevo__listes: t("Listes de contacts Brevo"),
  brevo__campagnes: t("Campagnes Brevo"),
  brevo__campagne: t("Lecture d'une campagne Brevo"),
  brevo__creer_brouillon: t("Brouillon de campagne Brevo"),
  brevo__envoyer_campagne: t("Envoi d'une campagne Brevo"),
  mailchimp__compte: t("Compte Mailchimp"),
  mailchimp__audiences: t("Audiences Mailchimp"),
  mailchimp__campagnes: t("Campagnes Mailchimp"),
  mailchimp__campagne: t("Lecture d'une campagne Mailchimp"),
  mailchimp__creer_brouillon: t("Brouillon de campagne Mailchimp"),
  mailchimp__envoyer_campagne: t("Envoi d'une campagne Mailchimp"),
  outlook__mails: t("Derniers mails Outlook"),
  outlook__chercher: t("Recherche dans Outlook"),
  outlook__lire: t("Lecture d'un mail Outlook"),
  outlook__agenda: t("Agenda Outlook"),
  outlook__brouillon: t("Brouillon de mail Outlook"),
  outlook__envoyer: t("Envoi d'un mail Outlook"),
  outlook__creer_evenement: t("Création d'un événement Outlook"),
  onedrive__lister: t("Contenu d'un dossier OneDrive"),
  onedrive__chercher: t("Recherche dans OneDrive"),
  onedrive__lire: t("Lecture d'un fichier OneDrive"),
  sharepoint__sites: t("Sites SharePoint"),
  sharepoint__lister: t("Contenu d'une bibliothèque SharePoint"),
  sharepoint__chercher: t("Recherche dans SharePoint"),
  sharepoint__lire: t("Lecture d'un fichier SharePoint"),
  excel__lire: t("Lecture d'un classeur Excel"),
  excel__ecrire: t("Écriture dans un classeur Excel"),
  word__lire: t("Lecture d'un document Word"),
  teams__equipes: t("Équipes et canaux Teams"),
  teams__messages: t("Messages Teams"),
  teams__poster: t("Message dans Teams"),
};

/** Nom d'outil qualifié « serveur__outil » rendu lisible. */
export function libelleOutil(name: string): string {
  const [serveur, tool = name] = name.split("__");
  return (
    LIBELLES_OUTILS[name] ??
    (serveur === "fichiers" ? LIBELLES_OUTILS[tool] : undefined) ??
    (name.includes("__") ? undefined : LIBELLES_OUTILS[name]) ??
    tool.replace(/_/g, " ")
  );
}

/**
 * Argument le plus parlant d'un appel d'outil (chemin, requête...), celui que
 * le Chat montre à côté du libellé. Partagé depuis le 27/09/2026 : les étapes
 * gardées avec une réponse (hooks/useChat.ts) doivent se relire comme elles
 * s'affichaient.
 */
export function cibleAffichee(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "query", "url", "pattern", "source", "requete", "adresse"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
