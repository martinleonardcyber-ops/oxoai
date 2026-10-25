/**
 * Abstraction de persistance.
 *
 * Le cache local garde les lectures synchrones (aucun écran à réécrire) ; les
 * écritures sont répercutées vers l'instance partagée, ce qui rend le
 * multi-postes possible. Sans instance joignable, tout continue de fonctionner
 * localement — la synchronisation est un confort, pas une dépendance.
 */

import { COLLECTIONS, push, type Collection } from "./sync";
import { ecrireSecret, lireSecret } from "@/lib/coffre";
import { auGrand, ecrireGrand, lireGrand } from "./grandStockage";
import { refuseesParLeNavigateur } from "./secours";

const PREFIX = "oxoai:";

/**
 * Collection concernée par une clé locale, s'il y en a une.
 *
 * Déduite de `COLLECTIONS`, et surtout pas d'une liste tenue à la main : la
 * version d'avant en portait une, et ajouter une collection sans l'y inscrire
 * coûtait les données. Une écriture locale non reconnue ici n'est jamais
 * poussée vers l'instance ; la lecture suivante rend le tableau vide de
 * l'instance, qui écrase le travail local. Mesuré, sur les compétences : créée
 * à l'écran, disparue au rechargement.
 *
 * Les clés locales portent le nom de leur collection, à une exception près :
 * les profils sont rangés un par personne (« profile:<id> »).
 */
function collectionOf(key: string): Collection | null {
  if (key.startsWith("profile:")) return "profiles";
  // L'identité (« identity:current ») reste propre au poste : chacun ouvre sa
  // session sur sa machine, et rien ne la synchronise.
  return (COLLECTIONS as readonly string[]).includes(key) ? (key as Collection) : null;
}

/**
 * Clés rangées dans le coffre du système plutôt que dans le navigateur.
 *
 * `identity:current` n'est pas un secret : c'est le nom de la personne
 * connectée sur ce poste. Mais il fait couple avec le jeton de séance, qui,
 * lui, est au coffre — les séparer voudrait dire qu'une personne « restée
 * connectée » retrouverait un jeton valide et un écran de connexion. Ils
 * voyagent donc ensemble, et survivent ensemble à un changement d'origine.
 */
const AU_COFFRE = new Set(["identity:current"]);

/** Valeur brute d'une clé, telle qu'elle est rangée. Sert aussi aux abonnements. */
export function brut(key: string): string | null {
  if (AU_COFFRE.has(key)) return lireSecret(PREFIX + key) ?? null;
  if (auGrand(key)) return lireGrand(key);
  const refusee = refuseesParLeNavigateur.get(PREFIX + key);
  if (refusee !== undefined) return refusee;
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = brut(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },

  set<T>(key: string, value: T): void {
    if (AU_COFFRE.has(key)) {
      ecrireSecret(PREFIX + key, JSON.stringify(value));
      return;
    }
    if (auGrand(key)) {
      ecrireGrand(key, JSON.stringify(value));
      const collection = collectionOf(key);
      if (collection) void push(collection);
      return;
    }
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      refuseesParLeNavigateur.delete(PREFIX + key);
    } catch {
      // Quota dépassé : gardée en mémoire, et envoyée quand même à l'instance (secours.ts).
      refuseesParLeNavigateur.set(PREFIX + key, JSON.stringify(value));
      console.warn(`[oxoai] stockage du navigateur plein : « ${key} » est gardé en mémoire et envoyé à l'instance.`);
    }
    const collection = collectionOf(key);
    if (collection) void push(collection);
  },

  remove(key: string): void {
    if (AU_COFFRE.has(key)) {
      ecrireSecret(PREFIX + key, null);
      return;
    }
    if (auGrand(key)) {
      ecrireGrand(key, null);
      const collection = collectionOf(key);
      if (collection) void push(collection);
      return;
    }
    try {
      refuseesParLeNavigateur.delete(PREFIX + key);
      localStorage.removeItem(PREFIX + key);
    } catch {
      return;
    }
    const collection = collectionOf(key);
    if (collection) void push(collection);
  },
};

/**
 * Suite aléatoire en base 32 (5 bits par octet, sans biais), tirée par `crypto.getRandomValues` : disponible
 * aussi hors contexte sécurisé (instance jointe en HTTP sur le réseau local),
 * contrairement à `randomUUID`. `Math.random` suffisait pour des identifiants
 * qui ne protègent rien, mais l'analyse de code (CodeQL, 27/09/2026) ne sait pas
 * le distinguer d'un secret : un tirage sûr ne coûte rien.
 */
export function aleatoire(caracteres = 12): string {
  const octets = crypto.getRandomValues(new Uint8Array(caracteres));
  return Array.from(octets, (o) => (o & 31).toString(32)).join("");
}

/** Identifiant court, suffisant pour des enregistrements locaux. */
export const newId = (): string => `${Date.now().toString(36)}${aleatoire(6)}`;
