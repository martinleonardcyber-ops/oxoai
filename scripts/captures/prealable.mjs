/*
 * Module chargé avant la passerelle d'essai des captures (`node --import`),
 * 28/09/2026. Il garde la passerelle sur la machine :
 *
 *  - api.mistral.ai est servi par le faux modèle de la scène (faux-modele.mjs,
 *    sous `/mistral`) : la clé branchée dans la scène est factice, et le
 *    « Mistral AI » de l'écran d'usage est ce faux serveur. L'adresse reste
 *    celle de Mistral pour la passerelle : c'est à elle qu'elle reconnaît le
 *    fournisseur et ses prix publiés (prixPublies.ts) ;
 *  - toute autre adresse hors de la boucle locale est refusée et notée dans
 *    le fichier `OXOAI_CAPTURES_SORTIES` (le capteur dit à la fin ce qui a
 *    voulu sortir) ;
 *  - le nom api.mistral.ai se résout sans DNS (une adresse de documentation,
 *    RFC 5737), pour que le contrôle des adresses sortantes (sortieReseau.ts)
 *    passe sans réseau.
 */
import { appendFileSync } from "node:fs";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const FAUX = process.env.OXOAI_CAPTURES_FAUX ?? "";
const SORTIES = process.env.OXOAI_CAPTURES_SORTIES ?? "";
const LOCAUX = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const lookupOrigine = dns.lookup;
dns.lookup = async (nom, options) => {
  if (nom === "api.mistral.ai") {
    const r = { address: "203.0.113.10", family: 4 };
    return (typeof options === "object" && options?.all) ? [r] : r;
  }
  return lookupOrigine(nom, options);
};
syncBuiltinESMExports();

const fetchOrigine = globalThis.fetch;
globalThis.fetch = async (entree, options) => {
  const brute = typeof entree === "string" || entree instanceof URL ? String(entree) : entree.url;
  const a = new URL(brute);
  if (LOCAUX.has(a.hostname)) return fetchOrigine(entree, options);
  if (a.hostname === "api.mistral.ai" && FAUX) {
    const vers = `${FAUX}/mistral${a.pathname}${a.search}`;
    return fetchOrigine(vers, typeof entree === "string" || entree instanceof URL ? options : { ...options, method: entree.method, headers: entree.headers, body: entree.body });
  }
  if (SORTIES) appendFileSync(SORTIES, `${a.origin}${a.pathname}\n`);
  throw new TypeError(`fetch failed (captures : aucune sortie vers ${a.hostname})`);
};
