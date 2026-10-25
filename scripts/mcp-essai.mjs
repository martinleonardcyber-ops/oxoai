#!/usr/bin/env node
/*
 * Petit serveur MCP d'essai (stdio, JSON-RPC ligne à ligne), sans compte ni
 * dépendance, pour `npm run essai:cli -- --modele` (essai-cli.mjs) : il sert
 * à vérifier qu'un connecteur MCP marche dans OxoAI Code, barrière comprise.
 *
 *   node scripts/mcp-essai.mjs <carnet> <trace>
 *
 * Deux outils : « noter » (ajoute une ligne au carnet : une modification) et
 * « lire_carnet » (lecture). Chaque appel reçu est aussi écrit dans la trace,
 * pour prouver de l'extérieur que l'outil a vraiment été exécuté, ou non.
 * Les chemins passent en arguments : une variable d'environnement serait un
 * « secret » pour le catalogue, qui refuse d'en garder sans chiffrement.
 */
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const [CARNET, TRACE] = process.argv.slice(2);
if (!CARNET || !TRACE) {
  console.error("usage : node scripts/mcp-essai.mjs <carnet> <trace>");
  process.exit(2);
}
const envoyer = (m) => process.stdout.write(JSON.stringify(m) + "\n");

const OUTILS = [
  {
    name: "noter",
    description: "Ajoute une note au carnet de l'équipe. Utilise cet outil quand on te demande de noter quelque chose dans le carnet.",
    inputSchema: { type: "object", properties: { texte: { type: "string", description: "La note à écrire" } }, required: ["texte"] },
  },
  {
    name: "lire_carnet",
    description: "Lit toutes les notes du carnet de l'équipe.",
    inputSchema: { type: "object", properties: {} },
  },
];

createInterface({ input: process.stdin }).on("line", (ligne) => {
  let m;
  try {
    m = JSON.parse(ligne);
  } catch {
    return;
  }
  if (m.method === "initialize") {
    envoyer({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "carnet-essai", version: "1.0.0" } } });
  } else if (m.method === "tools/list") {
    envoyer({ jsonrpc: "2.0", id: m.id, result: { tools: OUTILS } });
  } else if (m.method === "tools/call") {
    const { name, arguments: args = {} } = m.params ?? {};
    appendFileSync(TRACE, `${new Date().toISOString()} ${name} ${JSON.stringify(args)}\n`);
    if (name === "noter") {
      appendFileSync(CARNET, `${args.texte}\n`);
      envoyer({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `Note ajoutée au carnet : ${args.texte}` }] } });
    } else if (name === "lire_carnet") {
      const contenu = existsSync(CARNET) ? readFileSync(CARNET, "utf8") : "";
      envoyer({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: contenu || "(carnet vide)" }] } });
    } else {
      envoyer({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `outil inconnu : ${name}` } });
    }
  } else if (m.id !== undefined) {
    envoyer({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
