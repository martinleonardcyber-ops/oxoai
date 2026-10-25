/**
 * Étape `afterPack` d'electron-builder, pour Windows : pose la clé publique de
 * l'éditeur dans l'application (`resources\cle-editeur.pem`, soit
 * `process.resourcesPath` une fois installée), avant que l'installateur NSIS
 * ne soit fait.
 *
 * Pourquoi (27/09/2026, mise à jour d'un clic sous Windows, SECURITE.md
 * § 29.11) : le poste vérifie la signature de l'éditeur sur l'installateur
 * d'une nouvelle version avec la clé de l'application qui tourne, jamais avec
 * une clé venue de la publication. Sur macOS, c'est scripts/signature/
 * signer-mise-a-jour.cjs (`afterSign`) qui la pose ; sous Windows, rien ne la
 * posait. `afterPack` et non `afterSign` : electron-builder ne lance
 * `afterSign` que s'il a signé quelque chose.
 *
 * Seule la clé publique est écrite ; la privée (~/.oxoai-editeur/, ou
 * OXOAI_CLE_EDITEUR) est lue sans être copiée. Sans elle, la fabrication
 * s'arrête, sauf avec OXOAI_SANS_CLE_EDITEUR=1 : les postes de cette
 * application garderont alors « Télécharger ».
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { FICHIER_CLE, cleDesRessources, empreinteCle } = require("../../electron/signatureEditeur.cjs");

exports.default = async function poserCleWindows(context) {
  if (context.electronPlatformName !== "win32") return;
  const chemin = process.env.OXOAI_CLE_EDITEUR || path.join(os.homedir(), ".oxoai-editeur", "cle-privee-mises-a-jour.pem");
  if (!fs.existsSync(chemin)) {
    if (process.env.OXOAI_SANS_CLE_EDITEUR === "1") {
      console.log("  • clé de l'éditeur (Windows) : aucune (OXOAI_SANS_CLE_EDITEUR=1) ; ces postes garderont « Télécharger »");
      return;
    }
    throw new Error(
      `Clé d'éditeur introuvable (${chemin}). Créez-la une fois avec « npm run cle:editeur », ` +
        "ou fabriquez sans mise à jour d'un clic avec OXOAI_SANS_CLE_EDITEUR=1.",
    );
  }
  const privee = crypto.createPrivateKey(fs.readFileSync(chemin, "utf8"));
  if (privee.asymmetricKeyType !== "ed25519") throw new Error("la clé d'éditeur doit être une clé Ed25519");
  const publique = crypto.createPublicKey(privee).export({ type: "spki", format: "pem" }).toString();
  const ressources = path.join(context.appOutDir, "resources");
  fs.writeFileSync(path.join(ressources, FICHIER_CLE), publique, { mode: 0o644 });
  // Relue aussitôt, comme le fera le poste.
  if (cleDesRessources(ressources) !== publique) throw new Error("clé de l'éditeur (Windows) illisible une fois posée");
  console.log(`  • clé de l'éditeur posée dans l'application Windows : ${empreinteCle(publique)}`);
};
