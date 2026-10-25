/**
 * Crée, une fois, la clé de l'éditeur qui signe les mises à jour d'un clic
 * (electron/signatureEditeur.cjs, SECURITE.md § 28).
 *
 *   npm run cle:editeur
 *
 * La clé privée est écrite dans ~/.oxoai-editeur/ (dossier 700, fichier 600),
 * jamais dans le dépôt, et n'est jamais affichée. Une clé déjà là n'est pas
 * remplacée : la remplacer ferait refuser toute mise à jour par les postes
 * déjà installés, qui ne connaissent que l'ancienne.
 */
import { generateKeyPairSync, createPublicKey, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const chemin = process.env.OXOAI_CLE_EDITEUR || join(homedir(), ".oxoai-editeur", "cle-privee-mises-a-jour.pem");
const empreinte = (pem) =>
  createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16).replace(/(.{4})(?!$)/g, "$1-");

if (existsSync(chemin)) {
  console.log(`La clé d'éditeur existe déjà : ${chemin}`);
  console.log(`Empreinte : ${empreinte(readFileSync(chemin, "utf8"))}`);
  console.log("Elle n'est pas remplacée : les postes installés ne connaissent qu'elle.");
  process.exit(0);
}
mkdirSync(dirname(chemin), { recursive: true, mode: 0o700 });
chmodSync(dirname(chemin), 0o700);
const { privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
writeFileSync(chemin, pem, { mode: 0o600, flag: "wx" });
chmodSync(chemin, 0o600);
console.log(`Clé d'éditeur créée : ${chemin}`);
console.log(`Empreinte : ${empreinte(pem)}`);
console.log("");
console.log("Gardez-en une copie en lieu sûr (gestionnaire de mots de passe, clé USB rangée) :");
console.log("sans elle, plus aucune mise à jour d'un clic ne s'installera sur les postes déjà livrés.");
console.log("Ne la mettez jamais dans le dépôt, ni dans un Chat, ni dans un mail.");
