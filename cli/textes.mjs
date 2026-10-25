/*
 * Tous les textes affichés par la ligne de commande, au même endroit.
 *
 * La ligne de commande ne parle que français pour l'instant (décidé le
 * 25/09/2026 : d'abord qu'elle marche). Les textes sont rangés ici plutôt que
 * semés dans le code pour qu'une traduction se résume, le jour venu, à fournir
 * un second objet de la même forme et à choisir selon `LANG`.
 *
 * Aucun nom de produit en dur : le nom affiché vient de `OXOAI_NOM_PRODUIT`,
 * comme pour OpenCode (gateway/src/opencode.ts), et vaut « OxoAI » à défaut.
 * Pas de tiret cadratin dans ce qui s'affiche.
 */

export const NOM = process.env.OXOAI_NOM_PRODUIT?.trim() || "OxoAI";

export const T = {
  aide: `${NOM} en ligne de commande

Utilisation :
  oxoai                         Chat interactif (comme « oxoai chat »)
  oxoai chat ["question"]       Chat ; sans question, conversation interactive
  oxoai chat --outils           Chat avec les outils de l'instance (fichiers, connecteurs)
  oxoai code ["demande"]        ${NOM} Code sur le dossier courant ; sans demande, interactif
  oxoai connexion [--compte adresse@exemple.fr]
                                Se connecter avec son compte (mot de passe masqué)
  oxoai deconnexion             Fermer la séance de ce terminal
  oxoai modeles                 Modèles disponibles sur l'instance
  oxoai outils                  Outils et connecteurs de l'instance
  oxoai aide                    Cette aide

Options :
  --adresse URL     Instance à utiliser (ou OXOAI_ADRESSE). Défaut : http://127.0.0.1:8787
  --jeton JETON     Jeton d'instance (ou OXOAI_JETON). Défaut : celui de l'application
                    de cet ordinateur, lu seulement pour une adresse locale
  --modele NOM      Modèle à utiliser (voir « oxoai modeles »)
  --effort NIVEAU   Code : aucun, faible, moyen, eleve ou max
  --dossier CHEMIN  Code : dossier du projet sur la machine de l'instance. Défaut, pour
                    une instance locale seulement : le dossier courant
  --outils          Chat : autoriser l'agent à utiliser les outils (séance requise)

Dans une conversation :
  /nouveau          Nouveau Chat (ou nouvelle session de Code)
  /modele [NOM]     Voir ou changer de modèle
  /aide             Rappel des commandes
  /quitter          Sortir (ou Ctrl+D)
  Ctrl+C            Arrêter la réponse en cours ; au repos, sortir

Les actions qui demandent votre accord s'affichent ici et attendent votre réponse.`,

  aideConversation: "Commandes : /nouveau, /modele [NOM], /aide, /quitter. Ctrl+C arrête la réponse en cours.",

  // Instance et connexion
  injoignable: (adresse) =>
    `L'instance ne répond pas (${adresse}). Ouvrez l'application ${NOM} sur cet ordinateur, ou vérifiez --adresse.`,
  sansJeton: `Aucun jeton d'instance : ouvrez l'application ${NOM} sur cet ordinateur, ou donnez --jeton (ou OXOAI_JETON) pour une instance d'entreprise.`,
  jetonRefuse: "L'instance refuse ce jeton d'instance. Vérifiez --jeton (ou OXOAI_JETON).",
  httpDistant: (adresse) =>
    `Adresse refusée : ${adresse} est en http sur une autre machine, le jeton et la séance y partiraient en clair. Utilisez https://.`,
  adresseInvalide: (adresse) => `Adresse d'instance illisible : ${adresse}`,
  nonConnecte: "Vous n'êtes pas connecté sur ce terminal. Lancez : oxoai connexion",
  seanceExpiree: "Votre séance a expiré ou a été fermée. Reconnectez-vous : oxoai connexion",
  aucunCompte: "Aucun compte sur cette instance. Créez-en un depuis l'application.",
  compteInconnu: (email) => `Aucun compte ne correspond à « ${email} ».`,
  choisirCompte: "Comptes de cette instance :",
  numeroCompte: (n) => `Votre compte (1 à ${n}) : `,
  choixInvalide: "Choix invalide.",
  motDePasse: (nom) => `Mot de passe de ${nom} : `,
  codeDeuxFacteurs: "Code de vérification (application d'authentification, ou code de secours) : ",
  deuxFacteursAActiver:
    "Votre instance exige la double authentification et votre compte ne l'a pas encore : activez-la depuis l'application, puis réessayez.",
  premierMotDePasse:
    "Ce compte n'a pas encore de mot de passe : choisissez-le depuis l'application, puis réessayez.",
  connexionRefusee: "Connexion refusée.",
  connecte: (nom, adresse, fichier) => `Connecté à ${adresse} : ${nom}. La séance est gardée dans ${fichier} (lisible par vous seul).`,
  deconnecte: "Déconnecté : la séance est fermée sur l'instance et oubliée par ce terminal.",
  deconnecteLocal: "Séance oubliée par ce terminal (l'instance ne l'a pas confirmée : elle expirera d'elle-même).",
  dejaDeconnecte: "Aucune séance sur ce terminal pour cette instance.",
  fichierSeanceIllisible: (chemin) =>
    `Le fichier de séance ${chemin} est illisible. Il n'a pas été modifié : supprimez-le vous-même, puis reconnectez-vous.`,
  saisieInterrompue: "Saisie interrompue.",

  // Chat
  vous: "vous",
  modeleCourant: (m) => `Modèle : ${m || "choisi par l'instance"}`,
  modeleChange: (m) => `Modèle : ${m}`,
  nouveauChat: "Nouveau Chat.",
  arrete: "Arrêté.",
  aurevoir: "À bientôt.",
  outilsActifs: (liste) => `Outils : ${liste}`,
  aucunOutil: "Aucun outil n'est disponible sur l'instance en ce moment.",
  dossierOutils: (d) => `Fichiers : ${d} (le dossier de Cowork, choisi dans l'application)`,
  outilsSansSeance: "Les outils font agir l'instance en votre nom : connectez-vous d'abord (oxoai connexion).",
  plan: (n) => `Plan en ${n} étape${n > 1 ? "s" : ""} :`,
  etape: (i, n, titre) => `Étape ${i}/${n} : ${titre}`,
  noteSansOutils:
    "Tu réponds dans un terminal. Dans cette conversation, tu n'as aucun outil : tu ne peux ni lire, ni créer, ni modifier " +
    "de fichier, ni agir sur quoi que ce soit en dehors de ta réponse écrite. Si on te le demande, dis-le franchement, " +
    "sans prétendre l'avoir fait, et indique que « oxoai chat --outils » (outils de l'instance) ou « oxoai code » " +
    "(agent de code sur le dossier courant) le permettent.",
  reponseVide: "(réponse vide)",
  chatReflexion: (duree) => `Le modèle réfléchit (${duree})...`,
  chatReflexionFaite: (duree) => `Réflexion : ${duree}`,
  chatReflexionRequalifiee: "(ce qui précède était la réflexion du modèle ; sa réponse suit)",

  // Code
  codeSession: (dossier) => `${NOM} Code sur ${dossier}`,
  codeDossierDistant: (adresse) =>
    `L'instance ${adresse} n'est pas sur cet ordinateur : l'agent de code y travaille dans un dossier de SA machine, pas dans le dossier courant de ce poste. Donnez-le avec --dossier CHEMIN (un chemin sur le serveur de l'instance).`,
  codeSansSeance: `${NOM} Code modifie vos fichiers : connectez-vous d'abord (oxoai connexion).`,
  codeNouvelleSession: "Nouvelle session de Code.",
  codeRelance: "L'agent n'avait pas démarré : la demande est repartie dans une nouvelle session.",
  codeFini: "L'agent a terminé sans réponse écrite.",
  codeInterrompu: "Arrêt demandé à l'agent.",
  codeStatutRetente: (motif) => (motif ? `Le modèle n'a pas répondu (${motif}). Nouvelle tentative...` : "Le modèle n'a pas répondu. Nouvelle tentative..."),
  codeResume: "La conversation est longue : l'agent la résume pour continuer...",
  codeEchec: "L'agent de code a interrompu la tâche.",
  // Pendant que le modèle n'a encore rien rendu (oxoai.statut, gateway/src/attenteModele.ts), mêmes mots que l'écran Code.
  codeLecture: (detail, sousTache) => `${sousTache ? "Le modèle lit la demande de la sous-tâche" : "Le modèle lit la demande"} (${detail})...`,
  codeAttenteTour: (duree) => `Le modèle termine une autre demande avant celle-ci (${duree})...`,
  codeChargement: (duree) => `Le modèle se charge en mémoire (${duree})...`,
  codeReflexion: "L'agent réfléchit...",
  codePreparation: (libelle) => `L'agent prépare : ${libelle}...`,
  codeTaches: "Tâches :",
  environJetons: (n) => `environ ${n} jetons`,
  pourcent: (p) => `${p} %`,
  duree: (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ${String(s % 60).padStart(2, "0")} s` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  },
  codeFluxPerdu: "Le flux de l'agent s'est interrompu.",
  codeFin: {
    length: "Réponse interrompue : la limite de longueur du modèle est atteinte.",
    "content-filter": "Réponse bloquée par le filtre de contenu du modèle.",
    error: "Le modèle a signalé une erreur et s'est arrêté.",
    autre: "Le modèle s'est arrêté sans indiquer qu'il avait fini : la réponse peut être incomplète.",
  },
  modeleCodeLibre: "Le modèle se choisit à l'ouverture : « oxoai code --modele NOM ». /nouveau rouvre une session avec le modèle donné.",

  // Approbations
  approbationTitre: "Accord demandé",
  approbationSurface: { chat: "Chat", code: `${NOM} Code`, employe: "employé" },
  approbationCommande: "Commande",
  approbationContenu: "Ce qui partira, en entier",
  // Messageries (28/09/2026) : le destinataire résolu par l'instance, et le texte final d'un modèle WhatsApp.
  approbationDestinataire: "Destinataire",
  approbationTexteFinal: "Texte qui sera envoyé",
  approbationDroits: "Elle s'exécutera sur la machine de l'instance, avec les droits de son compte. Un accord ne vaut que pour cette commande.",
  approbationVeut: (resume) => `L'agent veut ${resume}.`,
  approbationEmploye: (nom) => `(demandé par ${nom})`,
  approbationMail: { a: "À", cc: "Cc", objet: "Objet", corps: "Texte" },
  approbationQuestion: "Autoriser ? [o/N] ",
  approbationAccordee: "Accordé.",
  approbationRefusee: "Refusé.",
  approbationAilleurs: "Répondu depuis un autre poste.",
  approbationExpiree: "Sans réponse depuis deux minutes : l'action n'a pas été faite.",
  approbationSansTerminal: (resume) =>
    `Une action attend votre accord (${resume}). Ce terminal ne peut pas poser la question : répondez dans l'application ${NOM} dans les deux minutes, sans quoi elle ne sera pas faite.`,
  approbationEchec: (m) => `Réponse non transmise : ${m}`,

  // Listes
  modelesTitre: "Modèles de l'instance :",
  modeleCharge: "chargé",
  aucunModele: "Aucun modèle disponible : vérifiez le moteur dans l'application.",
  outilsTitre: "Outils et connecteurs de l'instance :",
  outilsActif: "actif",
  outilsInactif: "indisponible",
  outilsCode: `aussi dans ${NOM} Code`,
  outilsNiveau: (n) =>
    `Accord demandé : ${n === "tout" ? "jamais (l'agent agit sans demander)" : n === "chaque" ? "avant chaque action, lectures comprises" : "avant chaque modification"}`,
  outilsNiveauInconnu: "Niveau d'accord : connectez-vous pour le voir (oxoai connexion).",

  // Erreurs génériques
  refus: (statut) => `L'instance a refusé la demande (${statut}).`,
  commandeInconnue: (c) => `Commande inconnue : ${c}. Voir « oxoai aide ».`,
  optionSansValeur: (o) => `L'option ${o} attend une valeur.`,
  erreur: (m) => `Erreur : ${m}`,
};

/** Libellés des outils, pour les lignes « ✓ Écriture index.html ». */
export const OUTILS = {
  // OpenCode
  read: "Lecture",
  write: "Écriture",
  edit: "Modification",
  patch: "Modification",
  apply_patch: "Modification",
  multiedit: "Modification",
  list: "Liste",
  glob: "Recherche",
  grep: "Recherche",
  bash: "Commande",
  webfetch: "Page web",
  todowrite: "Liste de tâches mise à jour",
  todoread: "Lecture de la liste de tâches",
  // Suivie de la description que l'agent en donne : « Sous-tâche : explorer le dossier src ».
  task: "Sous-tâche",
  // Serveur de fichiers de l'instance
  read_file: "Lecture",
  read_text_file: "Lecture",
  read_media_file: "Lecture de l'image",
  read_multiple_files: "Lecture",
  write_file: "Écriture",
  edit_file: "Modification",
  create_directory: "Création du dossier",
  move_file: "Déplacement",
  list_directory: "Liste",
  list_directory_with_sizes: "Liste",
  directory_tree: "Arborescence",
  search_files: "Recherche",
  get_file_info: "Informations",
  list_allowed_directories: "Dossiers ouverts",
};

/** « drive__chercher » → « Connecteur drive : chercher ». */
export const libelleConnecteur = (serveur, outil) => `Connecteur ${serveur} : ${outil}`;
