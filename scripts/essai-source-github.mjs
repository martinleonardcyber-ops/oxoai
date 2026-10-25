/** Vérifie electron/sourceGithub.cjs sans Electron ni réseau : `node scripts/essai-source-github.mjs`. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const s = require("../electron/sourceGithub.cjs");
let echecs = 0;
const verifier = (nom, ok) => { console.log(`${ok ? "✓" : "✗"} ${nom}`); if (!ok) echecs++; };
verifier("0.27.1 > 0.27.0", s.plusRecente("0.27.1", "0.27.0"));
verifier("v0.28.0 > 0.27.9", s.plusRecente("v0.28.0", "0.27.9"));
verifier("0.27.0 pas > 0.27.0", !s.plusRecente("0.27.0", "0.27.0"));
verifier("0.26.9 pas > 0.27.0", !s.plusRecente("0.26.9", "0.27.0"));
verifier("0.10.0 > 0.9.0 (numérique, pas alphabétique)", s.plusRecente("0.10.0", "0.9.0"));
verifier("préversion jamais proposée", !s.plusRecente("0.28.0-beta", "0.27.0"));
const f = (n) => ({ name: n, browser_download_url: `https://github.com/o/d/releases/download/v1/${n}` });
const pub = ["OxoAI-0.27.1-arm64.dmg", "OxoAI-0.27.1-arm64-mac.zip", "OxoAI-Setup-0.27.1-x64.exe", "oxoai-plateforme_0.27.1_amd64.deb", "OxoAI-0.27.1.AppImage", "SHA256SUMS.txt", "oxoai-mise-a-jour.json"].map(f);
verifier("Mac : l'image disque", s.choisirPaquet(pub, { plateforme: "darwin", arch: "arm64" })?.name === "OxoAI-0.27.1-arm64.dmg");
verifier("Windows : l'installateur", s.choisirPaquet(pub, { plateforme: "win32", arch: "x64" })?.name === "OxoAI-Setup-0.27.1-x64.exe");
verifier("Linux .deb", s.choisirPaquet(pub, { plateforme: "linux", arch: "x64", appImage: false })?.name === "oxoai-plateforme_0.27.1_amd64.deb");
verifier("Linux AppImage", s.choisirPaquet(pub, { plateforme: "linux", arch: "x64", appImage: true })?.name === "OxoAI-0.27.1.AppImage");
verifier("Windows ARM : rien plutôt qu'un mauvais paquet", s.choisirPaquet(pub, { plateforme: "win32", arch: "arm64" }) === null);
const sha = "A".repeat(86) + "==";
const bon = { version: "0.27.1", mac: { fichier: "OxoAI-0.27.1-arm64-mac.zip", sha512: sha, octets: 10 } };
verifier("manifeste lu", s.lireManifeste(JSON.stringify(bon), "0.27.1")?.files[0].url === "OxoAI-0.27.1-arm64-mac.zip");
verifier("manifeste d'une autre version refusé", s.lireManifeste(JSON.stringify(bon), "0.27.2") === null);
verifier("chemin dans le nom refusé", s.lireManifeste(JSON.stringify({ ...bon, mac: { ...bon.mac, fichier: "../x.zip" } }), "0.27.1") === null);
verifier("empreinte mal formée refusée", s.lireManifeste(JSON.stringify({ ...bon, mac: { ...bon.mac, sha512: "abc" } }), "0.27.1") === null);
verifier("JSON abîmé refusé", s.lireManifeste("{", "0.27.1") === null);
// Mac Intel (28/09/2026) : sa propre partie, jamais celle des puces Apple.
const intel = { ...bon, macIntel: { ...bon.mac, fichier: "OxoAI-0.27.1-x64-mac.zip" } };
verifier("Mac Intel : lit la partie `macIntel`", s.lireManifeste(JSON.stringify(intel), "0.27.1", "x64")?.files[0].url === "OxoAI-0.27.1-x64-mac.zip");
verifier("Mac Intel : sans partie `macIntel`, rien (pas l'archive pour puce Apple)", s.lireManifeste(JSON.stringify(bon), "0.27.1", "x64") === null);
verifier("puce Apple : garde la partie `mac` quand `macIntel` existe", s.lireManifeste(JSON.stringify(intel), "0.27.1", "arm64")?.files[0].url === "OxoAI-0.27.1-arm64-mac.zip");
// La partie Windows (27/09/2026) : signée par une clé d'essai, tirée ici, jamais la vraie.
const { generateKeyPairSync, createPublicKey } = await import("node:crypto");
const sig = require("../electron/signatureEditeur.cjs");
const pem = (k) => k.export({ type: "pkcs8", format: "pem" });
const privee = pem(generateKeyPairSync("ed25519").privateKey);
const publique = createPublicKey(privee).export({ type: "spki", format: "pem" }).toString();
const autre = pem(generateKeyPairSync("ed25519").privateKey);
const shaWin = "B".repeat(86) + "==";
const windows = (cle, d = {}) => {
  const desc = { identifiant: "oxoai-plateforme", version: "0.27.1", fichier: "OxoAI-Setup-0.27.1-x64.exe", sha512: shaWin, octets: 20, ...d };
  return { fichier: desc.fichier, sha512: desc.sha512, octets: desc.octets, signature: sig.signerInstallateur(cle, desc) };
};
const avecWin = (w, version = "0.27.1") => JSON.stringify({ ...bon, version, windows: w });
const lireW = (brut, version = "0.27.1", cle = publique, id = "oxoai-plateforme") => s.lireManifesteWindows(brut, version, cle, id);
verifier("Windows : installateur signé par l'éditeur lu", lireW(avecWin(windows(privee)))?.fichier === "OxoAI-Setup-0.27.1-x64.exe");
verifier("Windows : le manifeste macOS se lit toujours à côté", s.lireManifeste(avecWin(windows(privee)), "0.27.1")?.files[0].url === "OxoAI-0.27.1-arm64-mac.zip");
verifier("Windows : signé par une autre clé, refusé", lireW(avecWin(windows(autre))) === null);
verifier("Windows : signature abîmée, refusée", lireW(avecWin({ ...windows(privee), signature: "A".repeat(86) + "==" })) === null);
verifier("Windows : sans signature, refusé", lireW(avecWin({ ...windows(privee), signature: undefined })) === null);
verifier("Windows : empreinte changée après la signature, refusée", lireW(avecWin({ ...windows(privee), sha512: "C".repeat(86) + "==" })) === null);
verifier("Windows : taille changée après la signature, refusée", lireW(avecWin({ ...windows(privee), octets: 21 })) === null);
verifier("Windows : manifeste d'une autre version, refusé", lireW(avecWin(windows(privee)), "0.27.2") === null);
verifier("Windows : signature d'une autre version remise dans ce manifeste, refusée", lireW(avecWin(windows(privee, { version: "0.27.0" }))) === null);
verifier("Windows : signature d'une autre application, refusée", lireW(avecWin(windows(privee)), "0.27.1", publique, "autre-application") === null);
verifier("Windows : sans clé dans l'application, rien", lireW(avecWin(windows(privee)), "0.27.1", null) === null);
verifier("Windows : chemin dans le nom, refusé", lireW(avecWin(windows(privee, { fichier: "..\\OxoAI-Setup-0.27.1-x64.exe" }))) === null);
verifier("Windows : installateur ARM ou autre extension, refusé", lireW(avecWin(windows(privee, { fichier: "OxoAI-Setup-0.27.1-arm64.exe" }))) === null && lireW(avecWin(windows(privee, { fichier: "OxoAI-Setup-0.27.1-x64.msi" }))) === null);
verifier("Windows : manifeste sans partie Windows, rien", lireW(JSON.stringify(bon)) === null);
// Taille du manifeste (test d'intrusion du 27/09/2026) : lu entier en mémoire, il ne doit pas pouvoir peser des gigaoctets.
const m = (size, url = "https://github.com/o/d/releases/download/v1/oxoai-mise-a-jour.json") => [{ name: "oxoai-mise-a-jour.json", size, browser_download_url: url }];
verifier("manifeste de taille normale retenu", s.manifesteDe(m(533))?.size === 533);
verifier("manifeste de plusieurs gigaoctets écarté avant d'être lu", s.manifesteDe(m(3 * 1024 ** 3)) === null);
verifier("manifeste sans taille connue écarté", s.manifesteDe(m(undefined)) === null);
verifier("manifeste hors https écarté", s.manifesteDe(m(533, "http://exemple.test/oxoai-mise-a-jour.json")) === null);
verifier("texte de manifeste plus gros qu'un manifeste refusé", s.lireManifeste(JSON.stringify({ ...bon, bourrage: "x".repeat(s.TAILLE_MANIFESTE_MAX) }), "0.27.1") === null && lireW(JSON.stringify({ ...JSON.parse(avecWin(windows(privee))), bourrage: "x".repeat(s.TAILLE_MANIFESTE_MAX) })) === null);
verifier("dépôt mal formé refusé", s.depotValide("a/b;rm") === null && s.depotValide("martinleonardcyber-ops/oxoai") === "martinleonardcyber-ops/oxoai");
// Processeur de l'exécutable (28/09/2026) : une archive pour puce Apple ne s'installe pas sur un Mac Intel, ni l'inverse.
const mince = (type) => { const b = Buffer.alloc(32); b.writeUInt32BE(0xcffaedfe, 0); b.writeUInt32LE(type, 4); return b; };
const universel = (...types) => { const b = Buffer.alloc(8 + 20 * types.length); b.writeUInt32BE(0xcafebabe, 0); b.writeUInt32BE(types.length, 4); types.forEach((t, i) => b.writeUInt32BE(t, 8 + i * 20)); return b; };
const archs = (b) => [...s.processeursMachO(b)].sort().join(",");
verifier("Mach-O puce Apple lu arm64", archs(mince(0x0100000c)) === "arm64");
verifier("Mach-O Intel lu x64", archs(mince(0x01000007)) === "x64");
verifier("Mach-O universel : les deux", archs(universel(0x01000007, 0x0100000c)) === "arm64,x64");
verifier("pas un exécutable : rien", archs(Buffer.from("#!/bin/sh\necho\n")) === "" && archs(Buffer.alloc(0)) === "");
{
  // Le vrai binaire d'Electron de ce poste : son processeur y est.
  const { existsSync, readFileSync } = await import("node:fs");
  const electron = new URL("../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", import.meta.url);
  if (process.platform === "darwin" && existsSync(electron)) verifier(`le binaire d'Electron de ce Mac porte ${process.arch}`, s.processeursMachO(readFileSync(electron).subarray(0, 4096)).has(process.arch));
}
console.log(echecs ? `${echecs} échec(s)` : "tout est bon");
process.exit(echecs ? 1 : 0);
