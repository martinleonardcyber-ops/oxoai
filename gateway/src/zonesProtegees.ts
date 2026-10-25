import { readFileSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { emplacementLlamaChoisi } from "./llamaCppBase.ts";

/**
 * Ce que ni le dossier de l'équipe ni les agents ne doivent jamais ouvrir.
 *
 * ── Pourquoi (revue de sécurité du 25/09/2026) ──────────────────────────────
 *
 * « Tout mon poste » prend le dossier personnel comme dossier de l'équipe, et
 * les données de l'instance sont par défaut dans `~/.oxoai/data`. Mesuré sur
 * une instance jetable : `GET /oxoai/espace/fichier?chemin=.oxoai/data/…`
 * rendait 200 à n'importe quelle personne connectée, avec le jeton d'instance,
 * la configuration d'OpenClaw (son propre jeton) et la mémoire des employés.
 * La liste cachait les fichiers en point ; la lecture, elle, ne les refusait
 * pas. Le serveur de fichiers MCP de Cowork, lancé sur le même dossier
 * personnel, y lisait de même, et aussi `~/.ssh`, `~/.claude`, `~/.codex`.
 *
 * La règle tient en une fonction, `estProtege`, appelée partout où un chemin
 * du dossier de l'équipe est résolu : la liste et la lecture (`espace.ts`), les
 * outils bureautiques (`bureau.ts`), le contrôle du code web
 * (`controleWeb.ts`), le serveur de fichiers MCP (`mcp.ts`). Elle compare le
 * chemin **réel**, liens symboliques résolus : un lien posé dans l'espace et
 * pointant vers les données de l'instance est refusé comme la cible elle-même.
 *
 * Ce n'est pas une liste de tout ce qui est secret sur un poste : ce sont les
 * endroits où l'on sait que dorment des clés, des jetons ou les données de
 * l'instance. Un secret rangé ailleurs par la personne reste à sa portée et à
 * celle de l'agent, comme n'importe quel document.
 */

/*
 * Sous Windows, le chemin réel « natif » : celui de Node en JavaScript ne
 * développe pas les noms courts (`C:\Users\PRENOM~1`), et un chemin écrit
 * ainsi passait à côté de la zone qu'il désigne (audit Windows du 27/09/2026).
 */
const reel = (p: string): string => (process.platform === "win32" ? realpathSync.native(p) : realpathSync(p));

/** Dossier des données de l'instance, tel que la passerelle le calcule partout. */
const dossierDonnees = (): string => process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data");

/**
 * Les zones, en chemins absolus. Relues à chaque appel : `OXOAI_DATA_DIR` et
 * le dossier personnel ne changent pas en cours de route, mais une zone créée
 * après le démarrage (OpenClaw installé plus tard) doit valoir aussitôt.
 */
let memoire: { zones: string[]; jusqua: number } | null = null;

export function zonesProtegees(): string[] {
  // Deux secondes de mémoire : le contrôle du code web l'appelle pour chaque
  // dossier parcouru, et chaque calcul fait une vingtaine de `realpath`.
  if (memoire && memoire.jusqua > Date.now()) return memoire.zones;
  const zones = calculerZones();
  memoire = { zones, jusqua: Date.now() + 2000 };
  return zones;
}

function calculerZones(): string[] {
  const maison = homedir();
  const donnees = dossierDonnees();
  const zones = [
    // L'instance elle-même : base, jeton d'instance, OpenClaw de OxoAI
    // (`<données>/openclaw`, employes.ts) et son moteur (`openclaw-moteur`).
    donnees,
    join(maison, ".oxoai"),
    // Le dossier de travail d'OpenClaw installé par la personne : ce n'est pas
    // celui de OxoAI, mais il porte ses jetons de canaux et de modèles.
    join(maison, ".openclaw"),
    // Clés et identifiants.
    join(maison, ".ssh"),
    join(maison, ".gnupg"),
    join(maison, ".aws"),
    join(maison, ".azure"),
    join(maison, ".kube"),
    join(maison, ".docker"),
    join(maison, ".password-store"),
    join(maison, ".netrc"),
    join(maison, ".npmrc"),
    join(maison, ".git-credentials"),
    // Réglages des autres logiciels (dont les jetons de gcloud, gh, Cursor…).
    join(maison, ".config"),
    // Autres assistants : conversations et jetons d'accès.
    join(maison, ".claude"),
    join(maison, ".claude.json"),
    join(maison, ".codex"),
    join(maison, ".cursor"),
    /*
     * OpenCode (test d'intrusion du 27/09/2026) : `~/.opencode` est relu à
     * chaque démarrage de l'agent de code de OxoAI, greffons compris (un
     * fichier `plugin/*.js` écrit par un agent y serait exécuté) ;
     * `~/.local/share/opencode` porte `auth.json`, les clés de fournisseurs de
     * la personne, et ses sessions.
     */
    join(maison, ".opencode"),
    join(maison, ".local", "share", "opencode"),
    // Trousseaux du système.
    join(maison, "Library", "Keychains"),
    // Profil de l'application de bureau (séance ouverte dans son stockage local).
    join(maison, "Library", "Application Support", "OxoAI"),
    join(maison, "Library", "Application Support", "oxoai-plateforme"),
    /*
     * Linux et Windows (audit du 27/09/2026). Linux : les trousseaux de GNOME,
     * les profils de Firefox et de Thunderbird (mots de passe, cookies), les
     * certificats de Chromium, les données des applications Flatpak. Windows :
     * tout `AppData`, où vivent le profil de OxoAI (séance, cookies du bot de
     * réunion), les jetons de gh et de gcloud, les identifiants de Windows
     * (`Microsoft\Credentials`, `Protect`).
     */
    /*
     * LM Studio et son moteur sans interface : `bin/lms` est lancé par la
     * passerelle, et `~/.lmstudio-home-pointer` dit où le chercher. Écrits par
     * un agent, ils feraient exécuter un programme choisi par lui (revue de
     * sécurité du 27/09/2026).
     */
    join(maison, ".lmstudio"),
    join(maison, ".lmstudio-home-pointer"),
    join(maison, ".cache", "lm-studio"),
    join(maison, ".local", "share", "keyrings"),
    // KDE : le portefeuille. Ubuntu : Firefox, Thunderbird, Chromium sont des snaps, leurs profils vivent dans `~/snap`.
    join(maison, ".local", "share", "kwalletd"),
    join(maison, "snap"),
    join(maison, ".mozilla"),
    join(maison, ".thunderbird"),
    join(maison, ".pki"),
    join(maison, ".var", "app"),
    join(maison, "AppData"),
    ...[process.env.APPDATA, process.env.LOCALAPPDATA].filter((d): d is string => process.platform === "win32" && Boolean(d)),
    /*
     * L'emplacement des modèles choisi par l'administrateur (28/09/2026,
     * emplacementModeles.ts), sur un autre disque le plus souvent : le
     * dossier de LM Studio que désigne le pointeur (son `bin/lms` est lancé
     * par la passerelle, comme celui de `~/.lmstudio`), et le sous-dossier
     * des modèles du moteur ouvert (un modèle remplacé par un agent serait
     * chargé tel quel).
     */
    ...emplacementsDesModeles(maison),
  ];
  if (process.env.OXOAI_PROFIL_ESSAI) zones.push(process.env.OXOAI_PROFIL_ESSAI);
  // Chacune sous sa forme réelle aussi : `/var` et `/private/var` sur macOS,
  // un dossier de données qui serait lui-même un lien.
  const toutes = new Set<string>();
  for (const z of zones) {
    toutes.add(resolve(z));
    try {
      toutes.add(reel(z));
    } catch {
      /* absente sur ce poste */
    }
  }
  return [...toutes];
}

/**
 * Les emplacements de modèles hors des zones habituelles : la cible du
 * pointeur de LM Studio et le dossier des modèles du moteur ouvert. Un
 * pointeur vers le dossier personnel ou la racine d'un disque n'est pas
 * repris : il fermerait tout le poste aux agents, et `dossierLmStudio`
 * (engine.ts) ne le suit de toute façon pas s'il contient leur espace.
 */
function emplacementsDesModeles(maison: string): string[] {
  const liste: string[] = [];
  try {
    const pointe = readFileSync(join(maison, ".lmstudio-home-pointer"), "utf8").trim();
    if (pointe && isAbsolute(pointe) && !/^[\\/]{2}/.test(pointe)) {
      const p = resolve(pointe);
      if (p !== resolve(maison) && dirname(p) !== p) liste.push(p);
    }
  } catch {
    /* pas de pointeur */
  }
  const llama = emplacementLlamaChoisi();
  if (llama) liste.push(llama);
  return liste;
}

/** Forme repliée : le système de fichiers de macOS ignore la casse (voir `replier`, opencode.ts). */
const replier = (chemin: string) => chemin.normalize("NFC").toLowerCase();

/*
 * Sous Windows, des formes de chemin qui contournent la comparaison : un
 * chemin réseau ou de périphérique (`\\serveur\…`, `\\?\C:\…`), et un flux de
 * données secondaire (`fichier:flux`, un deux-points après la lettre du
 * disque). Aucun n'a d'usage légitime ici : refusés comme une zone.
 */
function douteuxSousWindows(chemin: string): boolean {
  if (process.platform !== "win32") return false;
  // Chemins de périphérique (`\\?\`, `\\.\`) : aucun usage ici.
  if (/^[\\/]{2}[?.][\\/]/.test(chemin)) return true;
  /*
   * Un partage réseau (`\\serveur\partage`) est permis : c'est souvent là que
   * vivent les documents d'une PME, et un lecteur réseau (`Z:`) y mène une
   * fois résolu (audit Windows du 27/09/2026). Pas les partages
   * d'administration (`C$`), ni ceux de cette machine elle-même, qui
   * rouvriraient le disque local par un détour.
   */
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)/.exec(chemin);
  if (unc) {
    const hote = unc[1]!.toLowerCase();
    if (["localhost", "127.0.0.1", "::1", hostname().toLowerCase()].includes(hote) || unc[2]!.endsWith("$")) return true;
    return chemin.slice(2).includes(":");
  }
  // Un flux de données secondaire (`fichier:flux`) : un deux-points après la lettre du disque.
  return chemin.slice(2).includes(":");
}

/** Ce chemin (absolu, déjà réel de préférence) est-il dans une zone protégée ? */
export function estProtege(chemin: string): boolean {
  if (douteuxSousWindows(chemin)) return true;
  const cible = replier(resolve(chemin));
  return zonesProtegees().some((z) => {
    const zone = replier(z);
    return cible === zone || cible.startsWith(zone + sep);
  });
}

/** Ce dossier contient-il une zone protégée ? Sert à savoir s'il faut filtrer une liste. */
export function contientUneZone(dossier: string): boolean {
  const d = replier(resolve(dossier));
  return zonesProtegees().some((z) => replier(z).startsWith(d + sep));
}

/**
 * Chemin réel, même pour un fichier qui n'existe pas encore : le parent
 * existant le plus proche est résolu, le reste lui est rattaché. C'est ce qui
 * démasque une écriture « dans » un lien symbolique qui pointe vers une zone.
 */
export function cheminReel(chemin: string): string {
  const absolu = resolve(chemin);
  try {
    return reel(absolu);
  } catch {
    const parent = dirname(absolu);
    if (parent === absolu) return absolu;
    return join(cheminReel(parent), basename(absolu));
  }
}

/** `~` et `~/…` comme les développe le serveur de fichiers MCP. */
const developper = (chemin: string) =>
  chemin === "~" ? homedir() : chemin.startsWith("~/") || (process.platform === "win32" && chemin.startsWith("~\\")) ? join(homedir(), chemin.slice(2)) : chemin;

/**
 * Un appel au serveur de fichiers MCP touche-t-il une zone protégée ?
 *
 * Le serveur (`@modelcontextprotocol/server-filesystem`) ne sait borner que
 * par ses dossiers de lancement : il ne sait pas exclure un sous-dossier. On
 * lit donc ses arguments avant de lui transmettre l'appel. Un chemin relatif
 * est compté depuis le dossier de l'équipe **et** depuis le dossier courant du
 * serveur (celui de la passerelle) : il suffit que l'un des deux tombe dans
 * une zone pour refuser.
 *
 * Rend le chemin fautif, ou null.
 */
export function cheminProtegeDans(args: Record<string, unknown>, espace: string): string | null {
  const valeurs: { brut: string; deplace: boolean }[] = [];
  for (const cle of ["path", "source", "destination"]) {
    if (typeof args[cle] === "string") valeurs.push({ brut: args[cle] as string, deplace: cle !== "path" });
  }
  if (Array.isArray(args.paths)) for (const p of args.paths) if (typeof p === "string") valeurs.push({ brut: p, deplace: false });
  for (const { brut, deplace } of valeurs) {
    const d = developper(brut.trim());
    const candidats = isAbsolute(d) ? [d] : [resolve(espace, d), resolve(process.cwd(), d)];
    for (const c of candidats) {
      const r = cheminReel(c);
      if (estProtege(r)) return brut;
      /*
       * Un déplacement (`move_file`) ne touche pas qu'un chemin : tout ce qui
       * est dessous part avec lui. Test d'intrusion du 28/09/2026
       * (SECURITE.md § 58) : renommer un dossier qui **contient** une zone
       * (`~/.local`, `~/Library`, le dossier choisi pour les modèles sur un
       * autre disque, ouvert aux agents en « Tout mon poste ») était permis,
       * puisque seul le chemin lui-même était comparé aux zones ; ce qu'elle
       * gardait se trouvait ensuite sous un nom qui n'en est plus une. Et une
       * destination qui contient une zone absente (`~/.cache` sans
       * `lm-studio`) la ferait naître d'un dossier préparé par l'agent.
       */
      if (deplace && contientUneZone(r)) return brut;
    }
  }
  return null;
}

/**
 * Retire d'un résultat du serveur de fichiers ce qui est dans une zone.
 *
 * Refuser la lecture ne suffit pas pour deux outils qui parcourent : une
 * recherche (`search_files`) et un arbre (`directory_tree`) lancés sur le
 * dossier personnel rendaient les noms des fichiers de l'instance, des clés
 * SSH, des conversations des autres assistants. Les noms seuls disent déjà
 * beaucoup. `list_directory` n'est pas filtré : il ne montre que le premier
 * niveau, et un nom de dossier comme « .ssh » n'apprend rien que l'on ne sache.
 */
export function filtrerResultat(outil: string, args: Record<string, unknown>, texte: string, espace: string): string {
  if (outil === "search_files") {
    return texte
      .split("\n")
      .filter((ligne) => !(isAbsolute(ligne.trim()) && estProtege(cheminReel(ligne.trim()))))
      .join("\n");
  }
  if (outil === "directory_tree" && typeof args.path === "string") {
    const d = developper(args.path.trim());
    const racine = cheminReel(isAbsolute(d) ? d : resolve(espace, d));
    if (!contientUneZone(racine)) return texte;
    try {
      type Noeud = { name: string; type: string; children?: Noeud[] };
      const elaguer = (noeuds: Noeud[], dossier: string): Noeud[] =>
        noeuds
          // Chemin réel : un lien de l'arbre qui pointe vers une zone est élagué comme elle.
          .filter((n) => !estProtege(cheminReel(join(dossier, n.name))))
          .map((n) => (n.children ? { ...n, children: elaguer(n.children, join(dossier, n.name)) } : n));
      return JSON.stringify(elaguer(JSON.parse(texte) as Noeud[], racine), null, 2);
    } catch {
      // Format inattendu : mieux vaut ne rien rendre que rendre ce qu'on n'a pas pu trier.
      return "Arbre non rendu : il passe par des dossiers protégés (données de l'instance, clés, réglages).";
    }
  }
  return texte;
}
