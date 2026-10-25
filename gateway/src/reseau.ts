import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

/**
 * Ouverture de l'instance aux autres postes.
 *
 * ── Pourquoi ce module existe ───────────────────────────────────────────────
 *
 * Le produit sert trois situations, et la troisième n'était pas atteignable
 * sans terminal :
 *
 *  1. **un particulier**, seul sur sa machine : rien à ouvrir ;
 *  2. **une entreprise**, instance sur un serveur ou un cluster, postes
 *     rattachés : l'intégrateur règle `share` dans `oxoai.config.json` ;
 *  3. **quelqu'un qui a OxoAI sur son PC et veut inviter une personne à
 *     travailler avec lui.** Là, il n'y avait rien : il fallait éditer un
 *     fichier JSON à la main. Pour un produit qui promet de ne rien compliquer,
 *     c'était la marche de trop.
 *
 * Ce module porte donc un interrupteur, réglable depuis l'écran, et rangé à
 * côté des données de l'instance plutôt que dans le profil de déploiement :
 * ce dernier appartient à l'intégrateur, et une décision prise à l'écran n'a
 * pas à réécrire son fichier.
 *
 * ── Ce que l'ouverture entraîne, et qui n'est pas négociable ────────────────
 *
 * Dès que l'instance écoute sur le réseau, elle **chiffre** (tls.ts) : un
 * certificat auto-signé est produit, couvrant le nom de la machine et
 * `localhost`. Une instance ouverte en clair livrerait les jetons de chacun à
 * qui écoute le réseau. Il n'y a donc pas de réglage pour s'en passer.
 *
 * Le jeton d'instance reste exigé : ouvrir l'écoute n'ouvre pas l'accès.
 */

interface EtatReseau {
  ouverte: boolean;
  /** Quand, et par qui : ce réglage change la surface de la machine. */
  depuis?: string;
  par?: string;
}

function fichier(): string {
  const base = process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data");
  return join(base, "reseau.json");
}

/**
 * Lu **de façon synchrone**, comme le profil de déploiement : la décision
 * d'écouter sur le réseau se prend avant que quoi que ce soit d'asynchrone
 * ait pu démarrer.
 */
export function etatReseau(): EtatReseau {
  try {
    const brut = JSON.parse(readFileSync(fichier(), "utf8")) as EtatReseau;
    return { ouverte: brut?.ouverte === true, depuis: brut?.depuis, par: brut?.par };
  } catch {
    return { ouverte: false };
  }
}

/** L'instance a-t-elle été ouverte depuis l'écran ? */
export const ouverteDepuisLEcran = (): boolean => etatReseau().ouverte;

/**
 * Règle l'interrupteur. Prend effet au redémarrage de la passerelle :
 * l'adresse d'écoute se choisit à l'ouverture du serveur, pas après.
 */
export function reglerReseau(ouverte: boolean, par: string): EtatReseau {
  const etat: EtatReseau = ouverte
    ? { ouverte: true, depuis: new Date().toISOString(), par }
    : { ouverte: false };
  const chemin = fichier();
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, JSON.stringify(etat, null, 2), "utf8");
  return etat;
}

/**
 * D'où vient une adresse, et donc d'où elle est joignable.
 *
 *  - `local` : le réseau de la maison ou du bureau. Le collègue doit être sur
 *    le même Wi-Fi, ou branché au même câble.
 *  - `prive` : un tunnel — VPN d'entreprise, Tailscale, WireGuard. Le collègue
 *    est joignable **de n'importe où**, du moment qu'il est sur le même réseau
 *    privé. C'est la seule voie qui traverse Internet sans rien ouvrir sur la
 *    box, et c'est pour cela qu'on la met en avant quand elle existe.
 */
export type GenreDAdresse = "local" | "prive";

/**
 * Interfaces par lesquelles un tunnel passe, selon le système.
 *
 * On ne devine pas le produit, seulement la nature du lien : `utun` sur macOS,
 * `tun`/`wg`/`tailscale`/`nordlynx` sur Linux, `ppp` et `ipsec` partout. Se
 * tromper ici n'a qu'une conséquence : une adresse rangée sous la mauvaise
 * étiquette. Elle reste proposée, et reste dans le certificat.
 */
const INTERFACE_TUNNEL = /^(utun|tun|tap|wg|tailscale|nordlynx|proton|ipsec|ppp|zt)/i;

/**
 * 100.64.0.0/10 : plage réservée aux opérateurs (RFC 6598), que Tailscale a
 * adoptée pour ses réseaux privés. Une machine qui porte une telle adresse est
 * sur un tunnel, quel que soit le nom de sa carte.
 */
function dansLeCgnat(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** Exportée pour être vérifiable : la détection se teste sans monter de VPN. */
export function genreDAdresse(carte: string, ip: string): GenreDAdresse {
  return INTERFACE_TUNNEL.test(carte) || dansLeCgnat(ip) ? "prive" : "local";
}

/**
 * Noms et adresses par lesquels **une autre machine** peut joindre celle-ci.
 *
 * `hostname()` ne suffit pas, et c'est une leçon payée : sur ce Mac il rend
 * « Mini-de-Clabaut », alors que le réseau local annonce
 * « Mac-mini-de-Clabaut.local ». L'adresse donnée à un collègue n'aurait
 * résolu nulle part. On rend donc plusieurs candidats, du plus durable au
 * plus fragile :
 *
 *  1. le nom Bonjour/mDNS (`…​.local`) : il suit la machine, même si son
 *     adresse change ;
 *  2. les adresses IPv4 du réseau local : elles marchent toujours, mais
 *     peuvent changer au prochain bail DHCP.
 *
 * Tous sont inscrits dans le certificat (tls.ts) : quel que soit celui que le
 * collègue saisit, le nom reste valide.
 */
export function nomsEtAdresses(): { noms: string[]; ips: string[] } {
  const noms = new Set<string>();
  const brut = hostname().trim();
  if (brut) noms.add(brut);

  /*
   * Nom annoncé sur le réseau local. Sur macOS il se lit dans la
   * configuration système et diffère souvent du nom d'hôte ; ailleurs, on
   * suffixe le nom d'hôte, ce qui est la convention mDNS.
   */
  if (process.platform === "darwin") {
    try {
      const local = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], {
        encoding: "utf8",
        timeout: 5_000,
      }).trim();
      if (local) noms.add(`${local}.local`);
    } catch {
      /* scutil absent ou muet : on garde ce qu'on a */
    }
  }
  if (brut && !brut.includes(".")) noms.add(`${brut}.local`);

  return { noms: [...noms], ips: cartesUtiles().map((c) => c.ip) };
}

/** Adresses IPv4 joignables depuis une autre machine, avec leur nature. */
export function cartesUtiles(): { carte: string; ip: string; genre: GenreDAdresse }[] {
  const trouvees: { carte: string; ip: string; genre: GenreDAdresse }[] = [];
  for (const [nom, cartes] of Object.entries(networkInterfaces())) {
    // Réseaux virtuels de cette machine (Docker, machines virtuelles) : aucun collègue ne les joint (revue Linux du 27/09/2026).
    if (/^(docker\d|virbr\d|br-|veth|vmnet|vboxnet|lxcbr|lxdbr|cni|flannel|podman)/i.test(nom)) continue;
    for (const carte of cartes ?? []) {
      if (carte.internal || carte.family !== "IPv4") continue;
      // 169.254.x.x : adresse d'auto-configuration, signe qu'il n'y a pas de réseau.
      if (carte.address.startsWith("169.254.")) continue;
      trouvees.push({ carte: nom, ip: carte.address, genre: genreDAdresse(nom, carte.address) });
    }
  }
  return trouvees;
}

/**
 * Adresses à proposer, la meilleure d'abord : le nom mDNS, puis les IP.
 *
 * Le nom d'hôte brut n'y figure pas : il ne résout pas forcément depuis une
 * autre machine, et donner une adresse qui ne marche pas est pire que d'en
 * donner une de moins.
 */
export function adressesPourLesCollegues(port: number, chiffre: boolean): string[] {
  return propositions(port, chiffre).map((p) => p.url);
}

export interface Proposition {
  url: string;
  genre: GenreDAdresse;
}

/**
 * Les adresses à proposer, chacune avec ce qu'elle permet.
 *
 * L'ordre est celui de la robustesse décroissante **pour le cas courant**,
 * qui est le collègue d'à côté : le nom `.local` d'abord, car il suit la
 * machine quand son adresse change ; puis les adresses du réseau local, qui
 * marchent toujours mais peuvent bouger au prochain bail DHCP ; puis les
 * adresses de tunnel, qui portent plus loin mais n'existent que si les deux
 * machines sont sur le même réseau privé.
 *
 * On ne choisit pas à la place de la personne : elle sait, elle, si son
 * collègue est dans la pièce d'à côté ou à l'autre bout du pays. L'écran
 * nomme donc chaque adresse au lieu d'en imposer une.
 */
export function propositions(port: number, chiffre: boolean): Proposition[] {
  const { noms } = nomsEtAdresses();
  const schema = chiffre ? "https" : "http";
  const url = (h: string) => `${schema}://${h}:${port}`;
  const cartes = cartesUtiles();
  return [
    ...noms.filter((n) => n.endsWith(".local")).map((n) => ({ url: url(n), genre: "local" as const })),
    ...cartes.filter((c) => c.genre === "local").map((c) => ({ url: url(c.ip), genre: c.genre })),
    ...cartes.filter((c) => c.genre === "prive").map((c) => ({ url: url(c.ip), genre: c.genre })),
  ];
}


/** La première adresse utile, celle que porte le mail d'invitation. */
export function adressePourLesCollegues(port: number, chiffre: boolean): string {
  const [premiere] = adressesPourLesCollegues(port, chiffre);
  return premiere ?? `${chiffre ? "https" : "http"}://${hostname()}:${port}`;
}

/** Le fichier existe-t-il déjà ? Sert à ne rien dire de faux au premier lancement. */
export const reglageEcrit = (): boolean => existsSync(fichier());
