import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { deployment } from "./deployment.ts";
import { surLeReseau } from "./config.ts";
import { nomsEtAdresses } from "./reseau.ts";
import { expireBientot, fabriquerAutoSigne } from "./certificat.ts";

/**
 * Chiffrement du transport.
 *
 * Sur la boucle locale, le trafic ne quitte pas la machine : le chiffrer
 * n'apporterait rien et compliquerait l'installation. Dès que l'instance est
 * ouverte au réseau (`share: true`), c'est l'inverse — jeton de séance,
 * conversations et documents circuleraient en clair sur le réseau de
 * l'entreprise, lisibles par quiconque écoute.
 *
 * Deux façons de fournir le certificat :
 *
 *  - **le vôtre** (`tls.cert` / `tls.key` dans le profil) : c'est ce qu'il faut
 *    pour un déploiement sérieux, avec un certificat reconnu ;
 *  - **auto-signé**, généré au premier démarrage : le trafic est chiffré et
 *    l'écoute passive devient inutile, mais rien ne prouve *à qui* on parle.
 *    Suffisant sur un réseau maîtrisé, insuffisant face à un attaquant capable
 *    de s'interposer. C'est un progrès, pas une garantie d'authenticité.
 */

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  /** Le certificat est-il auto-signé ? Détermine ce qu'on annonce à l'admin. */
  autoSigne: boolean;
  chemin: string;
}

const dossierTls = () => join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "tls");

/** Le certificat auto-signé arrive-t-il à expiration (dans 30 jours) ? On le refait avant. */
function bientotExpire(certPath: string): boolean {
  try {
    return expireBientot(readFileSync(certPath));
  } catch {
    return true;
  }
}

/**
 * Fabrique un certificat auto-signé valable un an, avec le nom de la machine et
 * les adresses de bouclage dans les noms alternatifs — sans quoi les clients
 * refusent la connexion avant même de regarder le certificat.
 */
/**
 * Noms et adresses que le certificat doit couvrir.
 *
 * `localhost` et la boucle locale pour cette machine, puis tout ce par quoi
 * une autre machine peut la joindre (reseau.ts). Sans ces derniers, un
 * collègue qui saisit l'adresse réellement résoluble se verrait refuser le
 * certificat : le nom présenté ne serait pas celui qu'il a demandé.
 */
function nomsAlternatifs(): string {
  const { noms, ips } = nomsEtAdresses();
  const entrees = [
    ...new Set([...noms.map((n) => `DNS:${n}`), "DNS:localhost"]),
    ...new Set([...ips.map((i) => `IP:${i}`), "IP:127.0.0.1"]),
  ];
  return entrees.join(",");
}

function genererAutoSigne(): { certPath: string; keyPath: string } | null {
  const dir = dossierTls();
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, "instance-cert.pem");
  const keyPath = join(dir, "instance-key.pem");

  /*
   * On réutilise le certificat en place, sauf s'il va expirer **ou** s'il ne
   * couvre plus les mêmes adresses. Un bail DHCP renouvelé change l'adresse de
   * la machine : sans ce contrôle, le collègue qui saisit la nouvelle adresse
   * tomberait sur un certificat qui ne la nomme pas, et l'instance serait
   * réputée usurpée alors qu'elle a seulement déménagé.
   */
  const couverts = join(dir, "instance-noms.txt");
  const memeCouverture = (() => {
    try {
      return readFileSync(couverts, "utf8").trim() === nomsAlternatifs();
    } catch {
      return false;
    }
  })();
  if (existsSync(certPath) && existsSync(keyPath) && !bientotExpire(certPath) && memeCouverture) {
    return { certPath, keyPath };
  }

  const nom = hostname();
  try {
    /*
     * Fabriqué par node:crypto (certificat.ts) depuis le 27/09/2026, plus par
     * openssl : Windows n'en a pas, et l'instance partagée servait alors en
     * clair. Écrit à côté puis renommé : un arrêt au milieu ne laisse pas une
     * clé qui ne va pas avec son certificat.
     */
    const { noms, ips } = nomsEtAdresses();
    const fait = fabriquerAutoSigne(nom, [...noms, "localhost"], [...ips, "127.0.0.1"]);
    // La clé privée ne doit être lisible que par le compte qui l'héberge.
    writeFileSync(`${keyPath}.tmp`, fait.key, { mode: 0o600 });
    writeFileSync(`${certPath}.tmp`, fait.cert, { mode: 0o644 });
    renameSync(`${keyPath}.tmp`, keyPath);
    renameSync(`${certPath}.tmp`, certPath);
    chmodSync(keyPath, 0o600);
    // La liste couverte est notée à côté : elle sert à savoir quand refaire le
    // certificat, l'adresse d'une machine n'étant pas éternelle.
    writeFileSync(join(dir, "instance-noms.txt"), nomsAlternatifs(), "utf8");
    console.log(`[oxoai] certificat auto-signé généré pour « ${nom} ».`);
    return { certPath, keyPath };
  } catch (err) {
    console.error("[oxoai] impossible de générer un certificat :", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Matériel TLS à utiliser, ou `null` pour servir en clair.
 *
 * En clair uniquement quand l'instance reste sur la boucle locale, ou quand
 * l'administrateur l'a explicitement demandé (`tls: false`, par exemple
 * derrière un reverse proxy qui termine déjà le TLS).
 */
export function tlsMaterial(): TlsMaterial | null {
  const profil = deployment();
  const config = profil.tls;

  if (config === false) return null;

  // Certificat fourni par l'administrateur : on le prend tel quel.
  if (config && typeof config === "object" && config.cert && config.key) {
    try {
      return {
        cert: readFileSync(config.cert),
        key: readFileSync(config.key),
        autoSigne: false,
        chemin: config.cert,
      };
    } catch (err) {
      console.error(
        `[oxoai] certificat illisible (${config.cert}) :`,
        err instanceof Error ? err.message : String(err),
      );
      // On n'ouvre pas en clair une instance censée être chiffrée.
      throw new Error(
        "Le certificat TLS déclaré dans le profil est illisible. " +
          "Corrigez `tls.cert` et `tls.key`, ou retirez `tls` pour servir en clair.",
      );
    }
  }

  /*
   * Pas de certificat déclaré : on chiffre quand même dès que l'instance sort
   * de la machine. Une instance partagée en clair est le défaut le plus coûteux
   * à rattraper une fois déployée chez un client.
   */
  const exposee = profil.share === true || surLeReseau();
  const demandeExplicite = config === true;
  if (!exposee && !demandeExplicite) return null;

  const fichiers = genererAutoSigne();
  /*
   * Jamais en clair sur le réseau faute de certificat (audit Windows du
   * 27/09/2026 : sans openssl, `null` ici servait l'instance partagée en
   * clair). L'instance ne démarre pas, et le dit.
   */
  if (!fichiers) {
    throw new Error(
      "Impossible de fabriquer le certificat de l'instance partagée : elle ne s'ouvre pas en clair sur le réseau. " +
        "Vérifiez que le dossier des données est accessible en écriture, ou déclarez votre certificat (`tls.cert`, `tls.key`).",
    );
  }

  return {
    cert: readFileSync(fichiers.certPath),
    key: readFileSync(fichiers.keyPath),
    autoSigne: true,
    chemin: fichiers.certPath,
  };
}
