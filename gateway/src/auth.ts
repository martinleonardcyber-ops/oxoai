import { randomBytes, timingSafeEqual } from "node:crypto";
import { valide as fluxValide } from "./flux.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type http from "node:http";

/**
 * Jeton d'instance.
 *
 * La passerelle donne accès aux données de l'entreprise, aux fichiers de
 * l'espace de travail et à l'exécution d'outils. Dès lors qu'elle est joignable
 * sur le réseau — ce qui est le principe même du multi-postes — elle doit
 * exiger une preuve d'autorisation.
 *
 * Le jeton est créé au premier démarrage et conservé en lecture seule pour son
 * propriétaire. L'administrateur le transmet aux postes qui rejoignent
 * l'instance, avec son adresse.
 */

const TOKEN_PATH =
  process.env.OXOAI_TOKEN_FILE ??
  join(process.env.OXOAI_DATA_DIR ?? join(homedir(), ".oxoai", "data"), "instance-token");

/** Où le jeton est écrit, en lecture seule pour son propriétaire. */
export const cheminDuJeton = (): string => TOKEN_PATH;

/** Routes accessibles sans jeton : uniquement de quoi tester la présence. */
const PUBLIC_PATHS = new Set([
  "/health",
  "/",
  /*
   * Retour d'autorisation OAuth d'un service distant (connecteurs.ts).
   *
   * C'est un navigateur qui arrive, renvoyé par le service : il n'a ni jeton
   * d'instance ni séance, et ne peut pas en avoir. Ce qui protège cette route
   * est le `state` — tiré au hasard, retenu au départ de la demande, à durée
   * de vie d'une autorisation — et le vérificateur PKCE, qui n'a jamais quitté
   * l'instance. Elle ne rend qu'une page à lire ; aucune donnée n'en sort.
   */
  "/oxoai/oauth/retour",
  /*
   * Rattachement d'un poste par code d'invitation (invitations.ts).
   *
   * Le poste qui appelle n'a rien : c'est justement ce qu'il vient chercher.
   * Ce qui l'autorise est le code — lié à une adresse, valable sept jours, bon
   * une fois — et la route est limitée en débit (debit.ts). Sans code valide,
   * elle ne rend rien.
   */
  "/oxoai/invitations/rejoindre",
  /*
   * Notifications de WhatsApp (natifs/messageries.ts, 28/09/2026) : c'est Meta
   * qui appelle, sans jeton ni séance. Ce qui protège la route : la signature
   * HMAC de chaque notification, faite avec le secret de l'application et
   * vérifiée avant toute lecture, et le jeton de vérification de l'abonnement,
   * tiré au sort par l'instance. Elle ne rend que « reçu ».
   */
  "/oxoai/messageries/whatsapp/webhook",
]);

let token: string | null = null;

export function instanceToken(): string {
  if (token) return token;

  if (process.env.OXOAI_TOKEN) {
    token = process.env.OXOAI_TOKEN;
    return token;
  }

  if (existsSync(TOKEN_PATH)) {
    token = readFileSync(TOKEN_PATH, "utf8").trim();
    if (token) return token;
  }

  token = randomBytes(24).toString("base64url");
  try {
    mkdirSync(dirname(TOKEN_PATH), { recursive: true });
    writeFileSync(TOKEN_PATH, token, "utf8");
    chmodSync(TOKEN_PATH, 0o600);
  } catch (err) {
    console.error(
      "[oxoai] jeton non enregistré (il changera au prochain démarrage) :",
      err instanceof Error ? err.message : err,
    );
  }
  return token;
}

/** Comparaison à durée constante : ne renseigne pas sur le préfixe correct. */
function sameToken(candidate: string): boolean {
  const expected = Buffer.from(instanceToken());
  const given = Buffer.from(candidate);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Jeton présenté par la requête, quel que soit le moyen employé. */
function presented(req: http.IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  // Les flux d'événements du navigateur (EventSource) ne portent pas d'en-tête.
  const query = url.searchParams.get("token");
  return query ? query.trim() : null;
}

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path);
}

/** Jeton valide présenté ? Sert à moduler ce que révèle une route publique. */
export function hasValidToken(req: http.IncomingMessage, url: URL): boolean {
  const candidate = presented(req, url);
  return candidate ? sameToken(candidate) : false;
}

/** La requête est-elle autorisée à atteindre cette route ? */
export function authorise(req: http.IncomingMessage, url: URL, path: string): boolean {
  if (isPublicPath(path)) return true;
  if (req.method === "OPTIONS") return true;
  /*
   * Un billet de flux vaut les deux jetons.
   *
   * Il n'a pu être obtenu que par une requête portant le jeton d'instance
   * **et** une séance ouverte (`POST /oxoai/flux/ticket`). Le présenter prouve
   * donc les deux, et évite de faire voyager l'un ou l'autre dans l'adresse
   * d'un flux, où `EventSource` ne sait pas poser d'en-tête (flux.ts). On se
   * contente ici de vérifier : c'est `demandeur()` qui le consomme.
   */
  if (fluxValide(url.searchParams.get("flux"))) return true;
  const candidate = presented(req, url);
  return candidate ? sameToken(candidate) : false;
}
