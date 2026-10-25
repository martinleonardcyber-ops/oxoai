import type http from "node:http";
import { statfs } from "node:fs/promises";
import { t } from "./langue.ts";

/**
 * Envoi d'un document en flux : bibliothèque, documents d'un agent.
 *
 * Jusqu'à la 0.16, un document partait en base64 dans un JSON, lu en entier en
 * mémoire des deux côtés : d'où une limite de 25 Mo, qui n'avait pas d'autre
 * raison. Désormais le corps de la requête est binaire :
 *
 *   [longueur de l'en-tête, 4 octets][en-tête JSON][octets du fichier]
 *
 * L'en-tête porte le nom, l'emplacement, la visibilité, et le texte extrait
 * sur le poste (2 millions de caractères au plus) ; le fichier suit tel quel
 * et s'écrit sur le disque au fil de l'eau (secret.ts, `ecrireEnFlux`). La
 * mémoire tenue par un envoi ne dépend plus de la taille du document.
 */

export const TYPE_ENVOI = "application/x-oxoai-document";

/** Taille d'un document : un gigaoctet. La mémoire n'en dépend plus ; le disque, si. */
export const DOCUMENT_MAX = 1024 * 1024 * 1024;
export const LIBELLE_DOCUMENT_MAX = "1 Go";

/** Assez pour 2 millions de caractères accentués, pas davantage. */
const ENTETE_MAX = 8 * 1024 * 1024;

export const estEnvoiEnFlux = (req: http.IncomingMessage) =>
  (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === TYPE_ENVOI;

/**
 * Lit l'en-tête, et rend le reste du corps comme un flux à consommer une fois.
 * Rien n'est lu au-delà de l'en-tête tant que l'appelant n'a pas décidé
 * d'accepter l'envoi.
 */
export async function lireEnvoi(
  req: http.IncomingMessage,
): Promise<{ ok: true; entete: Record<string, unknown>; fichier: AsyncIterable<Buffer> } | { ok: false; message: string }> {
  const iterateur = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let tampon = Buffer.alloc(0);
  const remplir = async (n: number): Promise<boolean> => {
    while (tampon.length < n) {
      const { value, done } = await iterateur.next();
      if (done) return false;
      tampon = Buffer.concat([tampon, value]);
    }
    return true;
  };
  if (!(await remplir(4))) return { ok: false, message: t("Envoi incomplet.") };
  const longueur = tampon.readUInt32BE(0);
  if (longueur === 0 || longueur > ENTETE_MAX) return { ok: false, message: t("Envoi mal formé.") };
  if (!(await remplir(4 + longueur))) return { ok: false, message: t("Envoi incomplet.") };
  let entete: unknown;
  try {
    entete = JSON.parse(tampon.subarray(4, 4 + longueur).toString("utf8"));
  } catch {
    return { ok: false, message: t("Envoi mal formé.") };
  }
  if (!entete || typeof entete !== "object" || Array.isArray(entete)) return { ok: false, message: t("Envoi mal formé.") };
  const deja = tampon.subarray(4 + longueur);
  async function* fichier(): AsyncGenerator<Buffer> {
    if (deja.length > 0) yield deja;
    for (;;) {
      const { value, done } = await iterateur.next();
      if (done) return;
      yield value;
    }
  }
  return { ok: true, entete: entete as Record<string, unknown>, fichier: fichier() };
}

/**
 * Le disque de l'instance peut-il accueillir `octets` de plus ? On garde une
 * marge de 512 Mo : un disque plein, c'est une base de données qui ne s'écrit
 * plus, bien pire qu'un document refusé. `true` si on ne sait pas mesurer.
 */
export async function placeSuffisante(dossier: string, octets: number): Promise<boolean> {
  try {
    const s = await statfs(dossier);
    return s.bavail * s.bsize >= octets + 512 * 1024 * 1024;
  } catch {
    return true;
  }
}

export const MESSAGE_DISQUE_PLEIN = "Le disque de l'instance n'a plus assez de place pour ce document.";
