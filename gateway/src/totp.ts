import { createHmac, pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Codes à usage unique fondés sur le temps (TOTP, RFC 6238 sur HOTP, RFC 4226).
 *
 * C'est le format que lisent toutes les applications d'authentification du
 * marché, y compris celles qui n'envoient rien à personne (Aegis, 2FAS,
 * KeePassXC, l'app Mots de passe d'Apple) : OxoAI n'impose aucun service tiers,
 * il n'en contacte aucun. Le calcul tient en quelques lignes de `node:crypto`,
 * sans dépendance.
 *
 * Paramètres fixés, ceux que toutes les applications comprennent : SHA-1,
 * six chiffres, pas de trente secondes. SHA-1 n'est pas ici un choix de
 * faiblesse : dans un HMAC, ses collisions ne donnent rien, et les variantes
 * SHA-256 sont ignorées en silence par une partie des applications, qui
 * afficheraient alors des codes faux.
 */

export const PAS_SECONDES = 30;
const CHIFFRES = 6;
/** Taille du secret : 160 bits, la longueur de sortie de SHA-1 (RFC 4226, §4). */
const OCTETS_SECRET = 20;
/**
 * Tolérance d'horloge : le pas précédent et le suivant sont acceptés. Une
 * horloge de téléphone qui dérive de quelques secondes ne doit pas bloquer
 * quelqu'un devant son poste ; au-delà d'un pas, c'est l'horloge qu'il faut régler.
 */
const TOLERANCE = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function versBase32(octets: Buffer): string {
  let bits = 0;
  let valeur = 0;
  let sortie = "";
  for (const octet of octets) {
    valeur = (valeur << 8) | octet;
    bits += 8;
    while (bits >= 5) {
      sortie += BASE32[(valeur >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) sortie += BASE32[(valeur << (5 - bits)) & 31];
  return sortie;
}

export function depuisBase32(texte: string): Buffer {
  const propre = texte.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let valeur = 0;
  const octets: number[] = [];
  for (const car of propre) {
    const indice = BASE32.indexOf(car);
    if (indice < 0) throw new Error("Secret illisible.");
    valeur = (valeur << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(octets);
}

export function nouveauSecret(): string {
  return versBase32(randomBytes(OCTETS_SECRET));
}

/** HOTP (RFC 4226, §5.3) : troncature dynamique du HMAC du compteur. */
export function hotp(secret: Buffer, compteur: number, chiffres = CHIFFRES): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(compteur));
  const hmac = createHmac("sha1", secret).update(message).digest();
  const decalage = hmac[hmac.length - 1]! & 0x0f;
  const binaire =
    ((hmac[decalage]! & 0x7f) << 24) |
    (hmac[decalage + 1]! << 16) |
    (hmac[decalage + 2]! << 8) |
    hmac[decalage + 3]!;
  return String(binaire % 10 ** chiffres).padStart(chiffres, "0");
}

export function pasCourant(maintenant = Date.now()): number {
  return Math.floor(maintenant / 1000 / PAS_SECONDES);
}

/**
 * Vérifie un code à six chiffres.
 *
 * Renvoie le pas auquel il correspond, ou `null`. Un pas déjà consommé
 * (`dernierPas`) est refusé même si le code est juste : un code intercepté,
 * regardé par-dessus l'épaule ou rejoué depuis un journal ne rouvre rien.
 */
export function verifierCode(
  secretBase32: string,
  saisie: string,
  dernierPas: number | undefined,
  maintenant = Date.now(),
): number | null {
  const code = saisie.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const secret = depuisBase32(secretBase32);
  const courant = pasCourant(maintenant);
  let trouve: number | null = null;
  // On parcourt toute la fenêtre sans s'arrêter au premier : la durée de la
  // vérification ne dit pas lequel des pas a correspondu.
  for (let ecart = -TOLERANCE; ecart <= TOLERANCE; ecart++) {
    const pas = courant + ecart;
    const attendu = Buffer.from(hotp(secret, pas));
    if (timingSafeEqual(attendu, Buffer.from(code)) && trouve === null) trouve = pas;
  }
  if (trouve === null) return null;
  if (dernierPas !== undefined && trouve <= dernierPas) return null;
  return trouve;
}

/*
 * Codes de secours.
 *
 * Téléphone perdu, changé, réinitialisé : sans eux, la personne ne rentre plus
 * que par l'outil local, depuis le poste. Dix codes, chacun utilisable une
 * fois, montrés une seule fois. L'instance n'en garde que l'empreinte : même
 * avec le magasin déchiffré en main, on ne les relit pas.
 *
 * Alphabet sans caractères ambigus (ni 0/o, ni 1/l/i) : ils se recopient à la
 * main depuis une feuille imprimée. Dix caractères, soit environ 49 bits.
 */
const ALPHABET_SECOURS = "abcdefghjkmnpqrstuvwxyz23456789";
const NOMBRE_SECOURS = 10;
const ITERATIONS_SECOURS = 20_000;

export function normaliserSecours(saisie: string): string {
  return saisie.toLowerCase().replace(/[\s-]/g, "");
}

function empreinteSecours(code: string, sel: string): string {
  return pbkdf2Sync(normaliserSecours(code), sel, ITERATIONS_SECOURS, 32, "sha256").toString("hex");
}

export function nouveauxCodesDeSecours(): { codes: string[]; sel: string; empreintes: string[] } {
  const sel = randomBytes(16).toString("hex");
  const codes: string[] = [];
  for (let i = 0; i < NOMBRE_SECOURS; i++) {
    let brut = "";
    for (let j = 0; j < 10; j++) brut += ALPHABET_SECOURS[randomInt(ALPHABET_SECOURS.length)];
    codes.push(`${brut.slice(0, 5)}-${brut.slice(5)}`);
  }
  return { codes, sel, empreintes: codes.map((c) => empreinteSecours(c, sel)) };
}

/** Indice du code de secours reconnu, ou -1. */
export function trouverSecours(saisie: string, sel: string, empreintes: string[]): number {
  const normal = normaliserSecours(saisie);
  if (normal.length !== 10) return -1;
  const donnee = Buffer.from(empreinteSecours(normal, sel), "hex");
  let trouve = -1;
  empreintes.forEach((e, i) => {
    const attendue = Buffer.from(e, "hex");
    if (attendue.length === donnee.length && timingSafeEqual(attendue, donnee) && trouve < 0) {
      trouve = i;
    }
  });
  return trouve;
}
