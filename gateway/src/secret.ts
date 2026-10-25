import { execFileSync } from "node:child_process";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { deployment } from "./deployment.ts";
import { nomProduit } from "./marque.ts";
import { t } from "./langue.ts";

/**
 * Chiffrement des données au repos.
 *
 * Jusqu'ici, un accès au disque suffisait à tout lire : conversations,
 * projets, mémoire personnelle. Le mot de passe séparait les comptes, il ne
 * protégeait rien contre quelqu'un qui emporte la machine ou monte le disque.
 *
 * La clé vit désormais dans le **trousseau macOS**, pas à côté des données :
 * un disque copié ou volé ne suffit plus, il faut la session ouverte du compte
 * qui l'héberge.
 *
 * ⚠ Ce que cela ne protège pas : un attaquant qui obtient la session de
 * l'utilisateur — logiciel malveillant sous son compte, accès physique à une
 * machine déverrouillée — accède au trousseau comme OxoAI. Le chiffrement au
 * repos protège le disque, pas une session compromise.
 */

const SERVICE = "fr.oxoai.instance";
const COMPTE = "cle-donnees";

/** Repli hors macOS : la clé sur disque, avec les permissions les plus strictes. */
const cheminCleFichier = () =>
  join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), ".cle");

let cache: Buffer | null = null;

/**
 * Lecture du trousseau, en distinguant trois cas — c'est essentiel.
 *
 * « Absente » et « illisible » se ressemblent à l'exécution et ont des
 * conséquences opposées : sur une entrée absente il faut créer une clé, sur une
 * entrée illisible il faut s'arrêter. Les confondre revient à écraser une clé
 * existante et à rendre toutes les données irrécupérables.
 */
type LectureTrousseau =
  | { etat: "trouvee"; cle: Buffer }
  | { etat: "absente" }
  | { etat: "illisible"; detail: string };

function lireTrousseau(): LectureTrousseau {
  try {
    const sortie = execFileSync(
      "security",
      ["find-generic-password", "-a", COMPTE, "-s", SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!sortie) return { etat: "illisible", detail: t("entrée présente mais vide") };
    const cle = Buffer.from(sortie, "base64");
    return cle.length === 32
      ? { etat: "trouvee", cle }
      : { etat: "illisible", detail: t("clé de taille inattendue") };
  } catch (err) {
    /*
     * `security` renvoie 44 quand l'entrée n'existe pas. Tout autre code —
     * trousseau verrouillé, accès refusé, liste d'applications autorisées qui
     * ne reconnaît plus le binaire après une mise à jour — signifie qu'une clé
     * peut exister et qu'on ne sait pas la lire.
     */
    const code = (err as { status?: number }).status;
    const texte = String((err as { stderr?: Buffer }).stderr ?? "");
    if (code === 44 || /could not be found/i.test(texte)) return { etat: "absente" };
    return { etat: "illisible", detail: texte.trim() || `code ${code}` };
  }
}

/*
 * Le compte a-t-il un trousseau par défaut, bien présent sur le disque ?
 *
 * Vu le 27/09/2026 : une passerelle lancée avec un dossier personnel sans
 * trousseau (essai, compte de service) appelait `add-generic-password`, et
 * macOS ouvrait « Trousseau introuvable » avec un bouton « Rétablir les
 * valeurs par défaut ». Ce bouton remplace le trousseau de session par un
 * trousseau vide : les mots de passe de la personne ne sont plus accessibles
 * directement. `security default-keychain` répond sans aucune fenêtre (mesuré
 * le même jour, avec et sans trousseau) : on le consulte avant d'écrire.
 */
function trousseauPresent(): boolean {
  try {
    const sortie = execFileSync("security", ["default-keychain", "-d", "user"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chemin = /"([^"]+)"/.exec(sortie)?.[1];
    return Boolean(chemin && existsSync(chemin));
  } catch {
    return false;
  }
}

function ecrireTrousseau(cle: Buffer): boolean {
  // Sans trousseau, `security` ouvrirait une fenêtre qui invite à « rétablir » celui de la session.
  if (!trousseauPresent()) return false;
  try {
    execFileSync(
      "security",
      /*
       * Pas de `-T ""` ici : cette option vide la liste des applications
       * autorisées, ce qui bloque **aussi** OxoAI et rend les données
       * illisibles. L'entrée reste donc accessible aux outils du compte, ce qui
       * est le comportement attendu — la protection vient de la session
       * macOS, pas d'une liste d'applications.
       */
      /*
       * Volontairement **sans** `-U` : cette option met à jour l'entrée
       * existante, donc écrase une clé qu'on n'aurait pas su relire. La
       * commande doit échouer si une entrée est déjà là — c'est le seul
       * garde-fou contre la destruction des données.
       */
      /*
       * La clé part en argument, et sa page de manuel dit elle-même que c'est
       * « insecure ». La question a été instruite plutôt que laissée ouverte :
       *
       *  - `-w` sans valeur attend une invite interactive, qui exige un
       *    terminal. La passerelle n'en a pas ;
       *  - le mot de passe poussé sur l'entrée standard n'est pas lu : l'entrée
       *    est créée sans valeur (mesuré) ;
       *  - un terminal simulé par `script` échoue avec le code 2 (mesuré) ;
       *  - un vrai pseudo-terminal demanderait une dépendance native, ce que la
       *    passerelle s'interdit.
       *
       * Ce qui reste exposé : la clé apparaît dans les arguments du processus
       * le temps de l'appel. Sur macOS, seuls les processus du même compte les
       * voient — et un tel processus peut de toute façon lire la clé en
       * appelant `security find-generic-password`, avec les mêmes droits. Le
       * gain d'un attaquant est donc nul, à une réserve près : un journal
       * système qui enregistrerait les exécutions garderait cette ligne.
       *
       * À reprendre le jour où un pseudo-terminal sera disponible sans
       * dépendance, ou si l'API Keychain devient accessible autrement.
       */
      ["add-generic-password", "-a", COMPTE, "-s", SERVICE, "-w", cle.toString("base64")],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Clé de chiffrement de l'instance, créée au premier démarrage.
 * `null` si aucun stockage sûr n'est disponible : mieux vaut alors écrire en
 * clair que de chiffrer avec une clé posée à côté sans le dire.
 */
export function cleDonnees(): Buffer | null {
  if (cache) return cache;

  /*
   * Où garder la clé ? Le trousseau macOS par défaut : la clé n'est alors pas
   * sur le même disque que les données. Une instance Linux n'en a pas — d'où
   * `fichier`, plus faible mais explicite, plutôt qu'un repli silencieux qui
   * laisserait croire à une protection qu'on n'a pas.
   */
  const mode = deployment().chiffrement ?? (process.platform === "darwin" ? "trousseau" : "fichier");
  if (mode === false) return null;

  if (mode === "trousseau") {
    const lecture = lireTrousseau();
    if (lecture.etat === "trouvee") {
      cache = lecture.cle;
      return cache;
    }

    /*
     * Trousseau présent mais illisible : une clé existe peut-être. En créer une
     * nouvelle écraserait l'ancienne et rendrait toutes les données
     * définitivement illisibles. On s'arrête franchement.
     */
    if (lecture.etat === "illisible") {
      throw new Error(
        "Le trousseau ne peut pas être lu (" + lecture.detail + "). Une clé de " +
          "chiffrement s'y trouve peut-être : " + nomProduit() + " refuse de démarrer plutôt que " +
          "de risquer de l'écraser et de rendre vos données illisibles. " +
          "Déverrouillez la session du compte qui héberge l'instance, puis relancez.",
      );
    }

    const nouvelle = randomBytes(32);
    if (ecrireTrousseau(nouvelle)) {
      /*
       * On relit immédiatement ce qu'on vient d'écrire. Une clé qu'on peut
       * poser mais pas reprendre rendrait les données définitivement
       * illisibles au redémarrage suivant : mieux vaut rester en clair.
       */
      const relue = lireTrousseau();
      if (relue.etat === "trouvee" && relue.cle.equals(nouvelle)) {
        console.log("[oxoai] clé de chiffrement créée dans le trousseau.");
        cache = nouvelle;
        return cache;
      }
      console.warn(
        "[oxoai] la clé écrite dans le trousseau n'est pas relisible : " +
          "les données restent en clair plutôt que de devenir irrécupérables.",
      );
      return null;
    }
    console.warn(
      "[oxoai] trousseau inaccessible : les données restent en clair. " +
        "Réglez « chiffrement »: \"fichier\" dans oxoai.config.json pour chiffrer quand même.",
    );
    return null;
  }

  /*
   * Clé dans un fichier en `-rw-------`. Plus faible que le trousseau — clé et
   * données sur le même disque — mais cela protège encore d'une sauvegarde
   * recopiée ou d'un partage réseau mal réglé. Le compromis est documenté.
   */
  /*
   * Mêmes règles que le trousseau (audit Windows et Linux du 27/09/2026 :
   * c'est le mode par défaut de ces deux systèmes). Avant, une clé tronquée
   * était remplacée par une neuve sans rien dire, et toutes les données
   * chiffrées avec l'ancienne devenaient illisibles ; une clé qu'un
   * antivirus tenait verrouillée faisait écrire en clair.
   */
  const chemin = cheminCleFichier();
  /*
   * `lstat`, pas `existsSync` (revue de sécurité du 27/09/2026) : un `.cle`
   * qui est un lien vers un disque absent « n'existe pas » pour `existsSync`,
   * et la création bouclait alors sur EEXIST jusqu'au débordement de pile,
   * puis l'instance écrivait en clair.
   */
  if (lstatSync(chemin, { throwIfNoEntry: false })) {
    cache = lireCleExistante(chemin);
    return cache;
  }

  /*
   * Création : écrite à côté (nom tiré au sort, jamais réutilisé), forcée sur
   * le disque, puis mise en place sans jamais écraser une clé apparue
   * entre-temps (lien dur, qui échoue si le nom existe), et relue. Un échec
   * arrête le démarrage : pas d'écriture en clair sans le dire.
   */
  const nouvelle = randomBytes(32);
  const temp = `${chemin}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(chemin), { recursive: true, mode: 0o700 });
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, nouvelle.toString("base64"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, chemin);
    } catch (err) {
      // Une clé est apparue entre-temps (ou le système n'a pas de liens durs) : c'est elle qui vaut, une seule relecture.
      if (lstatSync(chemin, { throwIfNoEntry: false })) {
        cache = lireCleExistante(chemin);
        return cache;
      }
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
      renameSync(temp, chemin);
    }
    const relue = lireCleExistante(chemin);
    if (!relue.equals(nouvelle)) throw new Error("clé relue différente");
    cache = nouvelle;
    return cache;
  } catch (err) {
    throw new Error(
      `La clé de chiffrement (${chemin}) n'a pas pu être créée (${(err as Error).message}). ` +
        `${nomProduit()} refuse de démarrer plutôt que d'écrire vos données en clair. Vérifiez que le dossier des données est accessible en écriture.`,
    );
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* déjà renommé, ou jamais créé */
    }
  }
}

/** Relit une clé en place : illisible ou abîmée, on refuse de démarrer plutôt que de la remplacer. */
function lireCleExistante(chemin: string): Buffer {
  let texte: string;
  try {
    texte = readFileSync(chemin, "utf8");
  } catch (err) {
    throw new Error(
      `La clé de chiffrement (${chemin}) ne peut pas être lue (${(err as NodeJS.ErrnoException).code ?? "erreur"}). ` +
        `${nomProduit()} refuse de démarrer plutôt que d'écrire vos données en clair ou de remplacer la clé. ` +
        "Vérifiez qu'aucun autre programme (un antivirus) ne la tient ouverte, et que le disque où elle se trouve est branché, puis relancez.",
    );
  }
  const cle = Buffer.from(texte.trim(), "base64");
  if (cle.length !== 32) {
    throw new Error(
      `La clé de chiffrement (${chemin}) est abîmée. ${nomProduit()} refuse de démarrer plutôt que de la remplacer : ` +
        "les données chiffrées avec elle deviendraient illisibles pour toujours. Remettez ce fichier depuis une sauvegarde.",
    );
  }
  return cle;
}

/**
 * Enveloppe d'un contenu chiffré, reconnaissable au premier coup d'œil.
 *
 * Version 2 : l'enveloppe est **liée à sa place** (le nom de la collection)
 * par les données associées d'AES-GCM. Sans ce lien, quelqu'un qui peut
 * écrire dans la base sans en avoir la clé — l'hébergeur d'un PostgreSQL, une
 * sauvegarde restaurée à la main — pourrait recopier l'enveloppe d'une
 * collection dans une autre : elle se déchiffrerait sans erreur, au mauvais
 * endroit. Avec le lien, elle est refusée. La version 1, sans lien, reste
 * lisible le temps que `migrerChiffrement` la réécrive.
 */
interface Coffre {
  oxoaiChiffre: 1 | 2;
  iv: string;
  tag: string;
  donnees: string;
}

const estCoffre = (v: unknown): v is Coffre =>
  typeof v === "object" &&
  v !== null &&
  ((v as Coffre).oxoaiChiffre === 1 || (v as Coffre).oxoaiChiffre === 2);

/** La valeur est-elle déjà chiffrée dans la forme actuelle, liée à sa place ? */
export const estChiffreLie = (v: unknown): boolean =>
  estCoffre(v) && v.oxoaiChiffre === 2;

const donneesAssociees = (place: string) => Buffer.from(`oxoai:${place}`, "utf8");

/**
 * Chiffre une valeur. AES-256-GCM : le contenu est illisible **et** toute
 * modification est détectée au déchiffrement — un chiffrement sans
 * authentification laisserait un attaquant altérer les données à l'aveugle.
 */
export function chiffrer(valeur: unknown, place?: string): unknown {
  const cle = cleDonnees();
  if (!cle) return valeur;

  const iv = randomBytes(12);
  const chiffreur = createCipheriv("aes-256-gcm", cle, iv);
  if (place) chiffreur.setAAD(donneesAssociees(place));
  const donnees = Buffer.concat([
    chiffreur.update(JSON.stringify(valeur), "utf8"),
    chiffreur.final(),
  ]);

  return {
    oxoaiChiffre: place ? 2 : 1,
    iv: iv.toString("base64"),
    tag: chiffreur.getAuthTag().toString("base64"),
    donnees: donnees.toString("base64"),
  } satisfies Coffre;
}

/**
 * Déchiffre une valeur si elle l'est.
 *
 * Une valeur en clair est renvoyée telle quelle : c'est ce qui permet à une
 * installation existante de continuer à fonctionner, puis de basculer au
 * chiffrement à la première écriture, sans migration ni perte.
 */
export function dechiffrer(valeur: unknown, place?: string): unknown {
  if (!estCoffre(valeur)) return valeur;
  if (valeur.oxoaiChiffre === 2 && !place) {
    throw new Error("Données chiffrées liées à une place, lues sans elle.");
  }

  const cle = cleDonnees();
  if (!cle) {
    throw new Error(
      "Données chiffrées mais clé introuvable dans le trousseau. " +
        "Restaurez le trousseau du compte qui héberge l'instance.",
    );
  }

  try {
    const dechiffreur = createDecipheriv("aes-256-gcm", cle, Buffer.from(valeur.iv, "base64"));
    if (valeur.oxoaiChiffre === 2) dechiffreur.setAAD(donneesAssociees(place as string));
    dechiffreur.setAuthTag(Buffer.from(valeur.tag, "base64"));
    const clair = Buffer.concat([
      dechiffreur.update(Buffer.from(valeur.donnees, "base64")),
      dechiffreur.final(),
    ]);
    return JSON.parse(clair.toString("utf8"));
  } catch {
    /*
     * AES-GCM refuse aussi bien une donnée modifiée qu'une mauvaise clé, sans
     * distinguer les deux — c'est voulu. Le message doit donc couvrir les deux
     * causes, plutôt que de renvoyer l'erreur brute d'OpenSSL.
     */
    throw new Error(
      "Données illisibles : elles ont été modifiées, ou la clé de chiffrement " +
        "n'est pas celle qui a servi à les écrire. Restaurez la clé d'origine " +
        "(trousseau du compte hôte, ou fichier .cle) ou repartez d'une sauvegarde.",
    );
  }
}

/** Le chiffrement au repos est-il actif ? Pour l'afficher honnêtement. */
export const chiffrementActif = (): boolean => cleDonnees() !== null;

/*
 * Fichiers : même clé, même algorithme, sans passer par JSON (un fichier
 * gonflerait d'un tiers en base64). En-tête de cinq octets : « HLXF1 »
 * pour un contenu chiffré, « HLXF0 » pour un contenu écrit en clair faute de
 * clé, ce que l'écran dit (`chiffrementActif`). Suivent, s'il est chiffré, le
 * vecteur d'initialisation (12 octets), l'étiquette d'authentification
 * (16 octets), puis les données. La place (l'identifiant du document) est liée
 * par les données associées : un fichier recopié sous un autre nom est refusé.
 */
const FICHIER_CHIFFRE = Buffer.from("HLXF1", "latin1");
const FICHIER_CLAIR = Buffer.from("HLXF0", "latin1");

export function chiffrerOctets(octets: Buffer, place: string): Buffer {
  const cle = cleDonnees();
  if (!cle) return Buffer.concat([FICHIER_CLAIR, octets]);
  const iv = randomBytes(12);
  const chiffreur = createCipheriv("aes-256-gcm", cle, iv);
  chiffreur.setAAD(donneesAssociees(place));
  const donnees = Buffer.concat([chiffreur.update(octets), chiffreur.final()]);
  return Buffer.concat([FICHIER_CHIFFRE, iv, chiffreur.getAuthTag(), donnees]);
}

export function dechiffrerOctets(stocke: Buffer, place: string): Buffer {
  const entete = stocke.subarray(0, 5);
  if (entete.equals(FICHIER_CLAIR)) return stocke.subarray(5);
  if (!entete.equals(FICHIER_CHIFFRE)) throw new Error("Fichier illisible : format inconnu.");
  const cle = cleDonnees();
  if (!cle) throw new Error("Fichier chiffré mais clé introuvable. Restaurez le trousseau du compte qui héberge l'instance.");
  try {
    const dechiffreur = createDecipheriv("aes-256-gcm", cle, stocke.subarray(5, 17));
    dechiffreur.setAAD(donneesAssociees(place));
    dechiffreur.setAuthTag(stocke.subarray(17, 33));
    return Buffer.concat([dechiffreur.update(stocke.subarray(33)), dechiffreur.final()]);
  } catch {
    throw new Error("Fichier illisible : il a été modifié, ou la clé n'est pas celle qui l'a chiffré.");
  }
}

/*
 * Gros fichiers (documents de la bibliothèque) : chiffrés en flux, par
 * tranches de 4 Mo, sans jamais tenir le fichier entier en mémoire, ni à
 * l'écriture ni à la lecture. « HLXF2 », puis des enregistrements :
 *
 *   [nature, 1 octet][longueur, 4 octets][iv, 12][étiquette, 16][données]
 *
 * Chaque tranche est liée à sa place et à son rang (données associées
 * « place#rang ») : une tranche déplacée, dupliquée ou prise à un autre
 * fichier est refusée. Le dernier enregistrement (nature 2, lié à
 * « place#fin#rang ») porte la taille totale : un fichier tronqué est refusé
 * au lieu d'être rendu à moitié. Rien n'est jamais rendu avant d'avoir été
 * authentifié : une tranche est vérifiée en entier avant d'être transmise.
 *
 * Sans clé, « HLXF0 » puis les octets tels quels, comme `chiffrerOctets`.
 * La lecture reconnaît aussi « HLXF1 » (un seul bloc), le format des
 * documents déposés avant les envois en flux.
 */
const FICHIER_TRANCHES = Buffer.from("HLXF2", "latin1");
export const TRANCHE = 4 * 1024 * 1024;
const TRANCHE_DONNEES = 1;
const TRANCHE_FIN = 2;

function sceller(cle: Buffer, nature: number, donnees: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const chiffreur = createCipheriv("aes-256-gcm", cle, iv);
  chiffreur.setAAD(donneesAssociees(aad));
  const chiffre = Buffer.concat([chiffreur.update(donnees), chiffreur.final()]);
  const entete = Buffer.alloc(5);
  entete.writeUInt8(nature, 0);
  entete.writeUInt32BE(chiffre.length, 1);
  return Buffer.concat([entete, iv, chiffreur.getAuthTag(), chiffre]);
}

/**
 * Écrit un flux dans `chemin`, chiffré par tranches. Le fichier n'apparaît
 * sous son nom qu'une fois complet : un envoi interrompu ou trop lourd ne
 * laisse rien derrière lui. `max` borne la taille en clair.
 */
export async function ecrireEnFlux(
  source: AsyncIterable<Uint8Array>,
  chemin: string,
  place: string,
  max: number,
): Promise<{ ok: true; octets: number } | { ok: false; trop: true }> {
  const partiel = `${chemin}.partiel-${randomBytes(4).toString("hex")}`;
  const fichier = await open(partiel, "wx", 0o600);
  let complet = false;
  try {
    const cle = cleDonnees();
    await fichier.write(cle ? FICHIER_TRANCHES : FICHIER_CLAIR);
    let total = 0;
    let rang = 0;
    let tampon: Buffer[] = [];
    let taille = 0;
    const ecrireTranche = async (tranche: Buffer) => {
      await fichier.write(sceller(cle!, TRANCHE_DONNEES, tranche, `${place}#${rang}`));
      rang += 1;
    };
    for await (const bout of source) {
      const b = Buffer.isBuffer(bout) ? bout : Buffer.from(bout);
      total += b.length;
      if (total > max) return { ok: false, trop: true };
      if (!cle) {
        await fichier.write(b);
        continue;
      }
      tampon.push(b);
      taille += b.length;
      if (taille >= TRANCHE) {
        const tout = Buffer.concat(tampon, taille);
        let debut = 0;
        for (; tout.length - debut >= TRANCHE; debut += TRANCHE) await ecrireTranche(tout.subarray(debut, debut + TRANCHE));
        const reste = tout.subarray(debut);
        tampon = reste.length > 0 ? [reste] : [];
        taille = reste.length;
      }
    }
    if (cle) {
      if (taille > 0) await ecrireTranche(Buffer.concat(tampon, taille));
      const longueur = Buffer.alloc(8);
      longueur.writeBigUInt64BE(BigInt(total));
      await fichier.write(sceller(cle, TRANCHE_FIN, longueur, `${place}#fin#${rang}`));
    }
    await fichier.sync();
    complet = true;
    return { ok: true, octets: total };
  } finally {
    await fichier.close();
    if (complet) await rename(partiel, chemin);
    else await rm(partiel, { force: true });
  }
}

/**
 * Relit un fichier écrit par `ecrireEnFlux` (ou par `chiffrerOctets`), tranche
 * par tranche. Lève une erreur au premier octet douteux : tranche modifiée,
 * déplacée, fichier tronqué ou prolongé, clé différente.
 */
export async function* lireEnFlux(chemin: string, place: string): AsyncGenerator<Buffer> {
  const fichier = await open(chemin, "r");
  try {
    let position = 0;
    const lire = async (n: number): Promise<Buffer> => {
      const b = Buffer.alloc(n);
      let lus = 0;
      while (lus < n) {
        const { bytesRead } = await fichier.read(b, lus, n - lus, position + lus);
        if (bytesRead === 0) break;
        lus += bytesRead;
      }
      position += lus;
      return lus === n ? b : b.subarray(0, lus);
    };
    const entete = await lire(5);
    if (entete.equals(FICHIER_CLAIR)) {
      for (;;) {
        const b = await lire(1024 * 1024);
        if (b.length === 0) return;
        yield b;
      }
    }
    if (entete.equals(FICHIER_CHIFFRE)) {
      yield dechiffrerOctets(await fichier.readFile(), place);
      return;
    }
    if (!entete.equals(FICHIER_TRANCHES)) throw new Error("Fichier illisible : format inconnu.");
    const cle = cleDonnees();
    if (!cle) throw new Error("Fichier chiffré mais clé introuvable. Restaurez le trousseau du compte qui héberge l'instance.");
    const illisible = () => new Error("Fichier illisible : il a été modifié ou tronqué, ou la clé n'est pas celle qui l'a chiffré.");
    let rang = 0;
    let total = 0n;
    for (;;) {
      const tete = await lire(5);
      if (tete.length < 5) throw illisible();
      const nature = tete.readUInt8(0);
      const longueur = tete.readUInt32BE(1);
      if ((nature !== TRANCHE_DONNEES && nature !== TRANCHE_FIN) || longueur > TRANCHE + 16) throw illisible();
      const corps = await lire(28 + longueur);
      if (corps.length < 28 + longueur) throw illisible();
      let clair: Buffer;
      try {
        const dechiffreur = createDecipheriv("aes-256-gcm", cle, corps.subarray(0, 12));
        dechiffreur.setAAD(donneesAssociees(nature === TRANCHE_FIN ? `${place}#fin#${rang}` : `${place}#${rang}`));
        dechiffreur.setAuthTag(corps.subarray(12, 28));
        clair = Buffer.concat([dechiffreur.update(corps.subarray(28)), dechiffreur.final()]);
      } catch {
        throw illisible();
      }
      if (nature === TRANCHE_FIN) {
        if (clair.length !== 8 || clair.readBigUInt64BE(0) !== total || (await lire(1)).length !== 0) throw illisible();
        return;
      }
      rang += 1;
      total += BigInt(clair.length);
      yield clair;
    }
  } finally {
    await fichier.close();
  }
}
