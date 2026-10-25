/**
 * Construction signée et notariée de l'application macOS.
 *
 *   npm run package:signe
 *
 * Vérifie d'abord que tout ce qu'Apple exige est là, et le dit en clair s'il
 * manque quelque chose : mieux vaut s'arrêter en trente secondes qu'après dix
 * minutes de construction et un refus d'Apple. Puis construit, signe, fait
 * notariser et agrafer, et vérifie le résultat (scripts/signature/verifier.mjs).
 *
 * `npm run package`, lui, reste une construction non signée, pour les essais.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath et non `.pathname` : le chemin du projet contient des espaces.
const racine = fileURLToPath(new URL("../../", import.meta.url));
const erreurs = [];

if (process.platform !== "darwin") {
  console.error("La signature Apple se fait sur un Mac.");
  process.exit(1);
}

/* 1. Certificat « Developer ID Application » dans le trousseau. */
let identites = [];
try {
  identites = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((l) => l.includes("Developer ID Application:"))
    .map((l) => /"(.+)"/.exec(l)?.[1])
    .filter(Boolean);
} catch {
  /* traité juste en dessous */
}
if (identites.length === 0) {
  erreurs.push(
    "Aucun certificat « Developer ID Application » dans le trousseau de ce Mac.\n" +
      "   Créez-le dans Xcode (Réglages, Comptes, Manage Certificates, +) ou sur\n" +
      "   developer.apple.com, rubrique Certificates, avec le compte Apple Developer Program.",
  );
} else if (identites.length > 1 && !process.env.CSC_NAME) {
  erreurs.push(
    "Plusieurs certificats trouvés. Indiquez lequel utiliser :\n" +
      identites.map((i) => `   export CSC_NAME="${i.replace(/^Developer ID Application: /, "")}"`).join("\n"),
  );
}

/* 2. Identifiants de notarisation : une des trois formes acceptées. */
const env = process.env;
const formes = [
  { nom: "clé d'API App Store Connect", ok: env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER },
  { nom: "profil du trousseau (notarytool)", ok: env.APPLE_KEYCHAIN_PROFILE },
  { nom: "identifiant Apple", ok: env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID },
];
const forme = formes.find((f) => f.ok);
if (!forme) {
  erreurs.push(
    "Aucun identifiant de notarisation. Le plus simple et le plus sûr, une fois pour toutes :\n" +
      '   xcrun notarytool store-credentials "oxoai-notarisation" \\\n' +
      "     --apple-id vous@exemple.fr --team-id XXXXXXXXXX\n" +
      "   (le mot de passe d'application est demandé, puis gardé dans le trousseau)\n" +
      '   export APPLE_KEYCHAIN_PROFILE="oxoai-notarisation"\n' +
      "   Autres formes acceptées : APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER,\n" +
      "   ou APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.",
  );
}
if (env.APPLE_KEYCHAIN_PROFILE && !env.APPLE_KEYCHAIN) {
  // electron-builder demande aussi le trousseau qui porte le profil.
  env.APPLE_KEYCHAIN = join(env.HOME ?? "", "Library", "Keychains", "login.keychain-db");
}

/* 3. Adresse de mise à jour, facultative, mais en HTTPS si elle est donnée. */
const flux = env.OXOAI_MISE_A_JOUR_URL;
if (flux && !/^https:\/\//.test(flux)) {
  erreurs.push(`OXOAI_MISE_A_JOUR_URL doit commencer par https:// (reçu : ${flux}).`);
}

if (!existsSync(join(racine, "build", "entitlements.mac.plist"))) {
  erreurs.push("build/entitlements.mac.plist est absent : le durcissement ne peut pas être appliqué.");
}

if (erreurs.length > 0) {
  console.error("\nConstruction signée impossible pour l'instant :\n");
  erreurs.forEach((e, i) => console.error(`${i + 1}. ${e}\n`));
  console.error("Le détail est dans SIGNATURE.md.");
  process.exit(1);
}

console.log(`\nCertificat : ${env.CSC_NAME ?? identites[0]}`);
console.log(`Notarisation : ${forme.nom}`);
console.log(`Mise à jour : ${flux ?? "aucune adresse (l'application ne cherchera pas de mise à jour)"}\n`);

const lancer = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: racine, stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

lancer("npm", ["run", "build"]);
lancer("npx", [
  "electron-builder",
  "--mac",
  "--publish",
  "never",
  "-c.mac.notarize=true",
  ...(flux ? ["-c.publish.provider=generic", `-c.publish.url=${flux}`] : []),
]);
lancer("node", [join(racine, "scripts", "signature", "verifier.mjs")]);

if (flux) {
  console.log(
    "Pour publier la mise à jour, déposez sur le serveur, à l'adresse indiquée :\n" +
      "  release/latest-mac.yml, le .zip et le .dmg de cette version (et leurs .blockmap).\n",
  );
}
