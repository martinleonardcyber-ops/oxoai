import { authHeaders, GATEWAY_BASE, SEANCE_EXPIREE, sessionToken, setSessionToken } from "./endpoint";
import { t, tf, taille } from "@/lib/i18n";

/**
 * Envoi d'un document à l'instance, en flux (gateway/src/televersement.ts).
 *
 * Le corps est [longueur de l'en-tête sur 4 octets][en-tête JSON][fichier] :
 * un `Blob` qui se contente de pointer vers le fichier choisi, lu depuis le
 * disque au fil de l'envoi. Rien n'est converti en base64, rien n'est tenu en
 * mémoire : c'est ce qui permet d'aller jusqu'à un gigaoctet.
 *
 * `XMLHttpRequest` et non `fetch` : lui seul dit où en est l'envoi, et un
 * document de 800 Mo sans barre d'avancement ressemble à une application
 * figée.
 */

export const DOCUMENT_MAX = 1024 * 1024 * 1024;
/*
 * Calculé, et non écrit : « 1 Go » en dur s'affichait tel quel dans une
 * interface anglaise. La langue ne changeant qu'avec un rechargement, une
 * constante de module suffit.
 */
export const LIBELLE_DOCUMENT_MAX = taille(DOCUMENT_MAX);
/**
 * Au-delà, le texte n'est pas extrait sur le poste (le document est gardé
 * quand même, sans recherche dans son contenu) : lire un PDF de 600 Mo dans
 * la page prendrait des minutes et une mémoire que le poste n'a pas toujours.
 */
export const EXTRACTION_MAX = 100 * 1024 * 1024;

export function envoyerEnFlux<T>(
  chemin: string,
  entete: Record<string, unknown>,
  fichier: Blob,
  onProgression?: (fraction: number) => void,
): Promise<T> {
  const json = new TextEncoder().encode(JSON.stringify(entete));
  const longueur = new Uint8Array(4);
  new DataView(longueur.buffer).setUint32(0, json.length);
  const corps = new Blob([longueur, json, fichier]);
  const avaitSeance = Boolean(sessionToken());

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${GATEWAY_BASE}${chemin}`);
    for (const [cle, valeur] of Object.entries(authHeaders())) xhr.setRequestHeader(cle, valeur);
    xhr.setRequestHeader("Content-Type", "application/x-oxoai-document");
    if (onProgression) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgression(Math.min(1, e.loaded / e.total));
      };
    }
    xhr.onload = () => {
      let reponse: (T & { error?: { message?: string } }) | null = null;
      try {
        reponse = JSON.parse(xhr.responseText) as T & { error?: { message?: string } };
      } catch {
        /* réponse vide ou illisible : traitée plus bas */
      }
      if (xhr.status === 401 && avaitSeance) {
        setSessionToken(null);
        window.dispatchEvent(new Event(SEANCE_EXPIREE));
      }
      if (xhr.status >= 200 && xhr.status < 300 && reponse) return resolve(reponse);
      reject(new Error(reponse?.error?.message ?? tf("L'envoi a échoué ({0}).", xhr.status)));
    };
    xhr.onerror = () => reject(new Error(t("L'envoi a été interrompu : vérifiez la connexion à l'instance, puis recommencez.")));
    xhr.onabort = () => reject(new Error(t("Envoi annulé.")));
    xhr.send(corps);
  });
}
