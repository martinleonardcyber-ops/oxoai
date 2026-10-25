import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { isIP } from "node:net";

/**
 * Un certificat auto-signé fabriqué par `node:crypto`, sans openssl.
 *
 * Pourquoi (audit Windows du 27/09/2026) : Windows n'a pas d'openssl. La
 * fabrication échouait en silence, et une instance ouverte au réseau servait
 * alors en clair (jeton de séance, conversations, documents lisibles par qui
 * écoute le réseau de l'entreprise). Écrit ici en quelques encodages DER, le
 * même sur les trois systèmes, et relu par `X509Certificate` avant d'être
 * rendu : un certificat que Node ne sait pas relire n'est jamais posé.
 *
 * Clé ECDSA P-256, signature SHA-256 : reconnues partout (Chromium, Node,
 * curl, Windows). Mêmes extensions que `openssl req -x509` : noms
 * alternatifs, `basicConstraints` CA critique, identifiants de clé.
 */

const tlv = (tag: number, contenu: Buffer): Buffer => {
  const n = contenu.length;
  const longueur =
    n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 0xff]) : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), longueur, contenu]);
};
const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const ensemble = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const explicite = (n: number, contenu: Buffer) => tlv(0xa0 + n, contenu);
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const vrai = () => tlv(0x01, Buffer.from([0xff]));

function entier(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  // Un entier DER est signé : un premier octet haut le rendrait négatif.
  return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}

function oid(texte: string): Buffer {
  const n = texte.split(".").map(Number);
  const corps: number[] = [n[0] * 40 + n[1]];
  for (const v of n.slice(2)) {
    const pile = [v & 0x7f];
    for (let r = Math.floor(v / 128); r > 0; r = Math.floor(r / 128)) pile.unshift((r & 0x7f) | 0x80);
    corps.push(...pile);
  }
  return tlv(0x06, Buffer.from(corps));
}

/** UTCTime jusqu'en 2049, GeneralizedTime après (RFC 5280 § 4.1.2.5). */
function date(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii")) : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

function adresseIp(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split(".").map(Number));
  // IPv6 : développer « :: », puis seize octets.
  const [tete, queue] = ip.split("::");
  const a = tete ? tete.split(":") : [];
  const b = queue !== undefined && queue ? queue.split(":") : [];
  const groupes = queue === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  return Buffer.concat(groupes.map((g) => Buffer.from([parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff])));
}

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

export interface CertificatFabrique {
  cert: string;
  key: string;
}

/**
 * Fabrique un certificat auto-signé pour `nom`, couvrant ces noms et ces
 * adresses, valable `jours` jours (un jour de marge dans le passé, pour une
 * horloge de poste un peu en retard).
 */
export function fabriquerAutoSigne(nom: string, noms: string[], ips: string[], jours = 365): CertificatFabrique {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  // L'identifiant de clé : SHA-1 de la clé publique brute (RFC 5280 § 4.2.1.2, méthode 1).
  const brute = spki.subarray(spki.length - 65);
  const idCle = createHash("sha1").update(brute).digest();

  const cn = nom.replace(/[^\x20-\x7e]/g, "").slice(0, 64) || "oxoai";
  const sujet = sequence(ensemble(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))));
  const maintenant = Date.now();
  const validite = sequence(date(new Date(maintenant - 24 * 3600 * 1000)), date(new Date(maintenant + jours * 24 * 3600 * 1000)));

  const alternatifs = sequence(
    ...[...new Set(noms)].filter((n) => /^[\x21-\x7e]+$/.test(n)).map((n) => tlv(0x82, Buffer.from(n, "ascii"))),
    ...[...new Set(ips)].filter((i) => isIP(i)).map((i) => tlv(0x87, adresseIp(i))),
  );
  const extensions = explicite(
    3,
    sequence(
      sequence(oid("2.5.29.17"), octets(alternatifs)),
      sequence(oid("2.5.29.19"), vrai(), octets(sequence(vrai()))),
      sequence(oid("2.5.29.14"), octets(octets(idCle))),
      sequence(oid("2.5.29.35"), octets(sequence(tlv(0x80, idCle)))),
    ),
  );

  const numero = randomBytes(16);
  numero[0] &= 0x7f;
  const aSigner = sequence(explicite(0, entier(Buffer.from([2]))), entier(numero), ECDSA_SHA256, sujet, validite, sujet, spki, extensions);
  const signature = sign("sha256", aSigner, privateKey);
  const der = sequence(aSigner, ECDSA_SHA256, bits(signature));

  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
  // Relu avant d'être rendu : un certificat mal formé ne doit jamais être servi.
  const relu = new X509Certificate(cert);
  if (!relu.checkPrivateKey(privateKey) || !relu.verify(publicKey)) throw new Error("certificat fabriqué illisible");
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** Le certificat expire-t-il dans moins de `jours` jours (ou est-il illisible) ? */
export function expireBientot(pem: string | Buffer, jours = 30): boolean {
  try {
    return new Date(new X509Certificate(pem).validTo).getTime() - Date.now() < jours * 24 * 3600 * 1000;
  } catch {
    return true;
  }
}
