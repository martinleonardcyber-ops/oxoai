/**
 * Écrit `release/oxoai-mise-a-jour.json`, le manifeste que lit la mise à jour
 * d'un poste installé seul (electron/sourceGithub.cjs), à publier avec la
 * version :
 *
 *  - `mac` : l'archive macOS (`OxoAI-<version>-arm64-mac.zip` de `npm run
 *    package`), son empreinte SHA-512 (base64, la forme d'electron-updater) et
 *    sa taille. La signature de l'éditeur est dans l'application elle-même ;
 *  - `macIntel` (28/09/2026) : la même chose pour les Mac Intel
 *    (`OxoAI-<version>-x64-mac.zip`, `electron-builder --mac --x64`) ;
 *  - `windows` (27/09/2026) : l'installateur NSIS (`OxoAI-Setup-<version>-x64.exe`),
 *    son empreinte SHA-512, sa taille, et la signature de l'éditeur sur le
 *    tout (electron/signatureEditeur.cjs, `signerInstallateur`), faite avec la
 *    clé privée de l'éditeur (~/.oxoai-editeur/, ou OXOAI_CLE_EDITEUR), lue
 *    sans être copiée. Sans clé, pas de partie Windows : les postes Windows
 *    gardent « Télécharger ».
 *
 * Chaque partie n'est écrite que si son paquet est là ; il en faut au moins une.
 *
 *   node scripts/manifeste-mise-a-jour.mjs [dossier]   (par défaut : release/)
 */
import { createHash, createPublicKey } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const signatureEditeur = require("../electron/signatureEditeur.cjs");
const sourceGithub = require("../electron/sourceGithub.cjs");

// fileURLToPath, pas `.pathname` : le chemin du projet peut contenir des espaces (encodés en %20 par `.pathname`).
const racine = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(racine, "package.json"), "utf8"));
const { version } = pkg;
const dossier = process.argv[2] ? resolve(process.argv[2]) : join(racine, "release");

const empreinte = (chemin) => {
  const hash = createHash("sha512");
  return new Promise((ok, ko) => createReadStream(chemin).on("data", (m) => hash.update(m)).on("end", () => ok(hash.digest("base64"))).on("error", ko));
};

const manifeste = { version };

const zip = `OxoAI-${version}-arm64-mac.zip`;
if (existsSync(join(dossier, zip))) {
  manifeste.mac = { fichier: zip, sha512: await empreinte(join(dossier, zip)), octets: statSync(join(dossier, zip)).size };
  console.log(`mac : ${zip} (${manifeste.mac.octets} octets)`);
}

// Mac Intel (28/09/2026) : sa propre archive, lue par les seuls Mac Intel (sourceGithub.cjs, `lireManifeste`).
const zipIntel = `OxoAI-${version}-x64-mac.zip`;
if (existsSync(join(dossier, zipIntel))) {
  manifeste.macIntel = { fichier: zipIntel, sha512: await empreinte(join(dossier, zipIntel)), octets: statSync(join(dossier, zipIntel)).size };
  console.log(`mac intel : ${zipIntel} (${manifeste.macIntel.octets} octets)`);
}

const exe = `OxoAI-Setup-${version}-x64.exe`;
if (existsSync(join(dossier, exe))) {
  const cheminCle = process.env.OXOAI_CLE_EDITEUR || join(homedir(), ".oxoai-editeur", "cle-privee-mises-a-jour.pem");
  if (!existsSync(cheminCle)) {
    console.log(`windows : ${exe} trouvé, mais pas de clé d'éditeur (${cheminCle}) : pas de partie Windows, les postes garderont « Télécharger »`);
  } else {
    const privee = readFileSync(cheminCle, "utf8");
    const publique = createPublicKey(privee).export({ type: "spki", format: "pem" }).toString();
    /*
     * La clé posée dans l'application Windows à la fabrication
     * (scripts/signature/cle-windows.cjs) doit être la même : sinon les postes
     * installés depuis ce paquet refuseraient la version suivante.
     */
    const dansLApplication = signatureEditeur.cleDesRessources(join(dossier, "win-unpacked", "resources"));
    if (dansLApplication && dansLApplication !== publique) {
      console.error("windows : la clé posée dans l'application (win-unpacked) n'est pas celle qui signe : manifeste non écrit.");
      process.exit(1);
    }
    const description = { identifiant: pkg.name, version, fichier: exe, sha512: await empreinte(join(dossier, exe)), octets: statSync(join(dossier, exe)).size };
    const signature = signatureEditeur.signerInstallateur(privee, description);
    manifeste.windows = { fichier: exe, sha512: description.sha512, octets: description.octets, signature };
    // Relu aussitôt, comme le fera un poste : une signature qu'on ne sait pas relire ne part pas.
    if (!sourceGithub.lireManifesteWindows(JSON.stringify(manifeste), version, publique, pkg.name)) {
      console.error("windows : la partie Windows ne se relit pas avec la clé de l'éditeur : manifeste non écrit.");
      process.exit(1);
    }
    console.log(`windows : ${exe} (${description.octets} octets), signé par la clé ${signatureEditeur.empreinteCle(publique)}`);
  }
}

if (!manifeste.mac && !manifeste.windows) {
  console.error(`Ni ${zip} ni ${exe} (signé) dans ${dossier} : rien à décrire.`);
  process.exit(1);
}
writeFileSync(join(dossier, "oxoai-mise-a-jour.json"), `${JSON.stringify(manifeste, null, 2)}\n`);
console.log(`${join(dossier, "oxoai-mise-a-jour.json")} : ${version}`);
