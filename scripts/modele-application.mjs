#!/usr/bin/env node
/**
 * Rassemble les fichiers du modèle d'application de OxoAI Code
 * (gateway/application/*) dans un seul JSON, que la passerelle importe : elle
 * est empaquetée en un fichier (esbuild), et un JSON s'importe aussi bien sous
 * Node que dans le paquet. `--verifier` échoue si le JSON n'est pas à jour.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dossier = join(dirname(fileURLToPath(import.meta.url)), "..", "gateway", "application");
const modele = {
  index: readFileSync(join(dossier, "index.html"), "utf8"),
  app: readFileSync(join(dossier, "app.js"), "utf8"),
  css: readFileSync(join(dossier, "app.css"), "utf8"),
  metier: readFileSync(join(dossier, "metier.js"), "utf8"),
};
const texte = JSON.stringify(modele, null, 1) + "\n";
const cible = join(dossier, "modele.json");
if (process.argv.includes("--verifier")) {
  let actuel = "";
  try {
    actuel = readFileSync(cible, "utf8");
  } catch {}
  if (actuel !== texte) {
    console.error("gateway/application/modele.json n'est pas à jour : node scripts/modele-application.mjs");
    process.exit(1);
  }
  console.log("modele.json à jour.");
} else {
  writeFileSync(cible, texte);
  console.log(`modele.json écrit (${Math.round(texte.length / 1024)} Ko).`);
}
