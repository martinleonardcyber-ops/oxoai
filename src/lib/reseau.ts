import { apiFetch } from "./endpoint";
import { instance, setInstance } from "./instance";
import { secretsEcrits } from "./coffre";
import { t } from "@/lib/i18n";

/**
 * Ouverture de l'instance aux collègues, côté interface.
 *
 * Trois situations servies par le produit, et c'est la troisième qui a besoin
 * de cet écran : un particulier seul (rien à ouvrir), une entreprise dont
 * l'intégrateur règle tout dans le profil de déploiement, et **quelqu'un qui a
 * OxoAI sur son PC et veut inviter une personne à travailler avec lui**. Pour
 * lui, ouvrir l'instance demandait d'éditer un fichier JSON à la main.
 *
 * Ce que l'ouverture entraîne, et que l'écran doit dire : l'instance se met à
 * chiffrer (certificat auto-signé), donc son adresse passe en `https`, y
 * compris pour cette machine.
 */

/**
 * D'où une adresse est joignable.
 *
 *  - `local` : depuis le même réseau — le même Wi-Fi, le même câble.
 *  - `prive` : depuis n'importe où, à condition d'être sur le même réseau
 *    privé (VPN d'entreprise, Tailscale, WireGuard). Cette adresse n'existe
 *    que si un tunnel est monté sur cette machine ; OxoAI le détecte, il ne
 *    l'installe pas.
 */
export interface Proposition {
  url: string;
  genre: "local" | "prive";
}

export interface EtatReseau {
  ouverte: boolean;
  /** Fixé par le profil de déploiement : l'interrupteur n'y peut rien. */
  parLeProfil: boolean;
  depuis: string | null;
  /** Adresse à donner à un collègue, la meilleure d'abord. */
  adresse: string | null;
  adresses: string[];
  /** Les mêmes, avec ce que chacune permet (voir `gateway/src/reseau.ts`). */
  propositions: Proposition[];
  chiffre: boolean;
  administrateur: boolean;
}

export async function etatReseau(): Promise<EtatReseau | null> {
  try {
    const res = await apiFetch("/oxoai/reseau");
    if (!res.ok) return null;
    return (await res.json()) as EtatReseau;
  } catch {
    return null;
  }
}

/**
 * Ouvre ou referme l'instance, puis relance la passerelle et réaligne
 * l'adresse de ce poste.
 *
 * L'ordre compte. L'instance chiffre dès qu'elle écoute sur le réseau : si on
 * relançait sans changer l'adresse enregistrée ici, ce poste continuerait de
 * viser `http://` une passerelle devenue `https://`, et n'y arriverait plus.
 */
export async function reglerReseau(
  ouverte: boolean,
  identite: { motDePasse: string; code?: string },
): Promise<{ ok: boolean; adresse?: string; message?: string; confirmation?: boolean }> {
  let adresse: string | undefined;
  try {
    const res = await apiFetch("/oxoai/reseau", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ouverte, ...identite }),
    });
    const corps = (await res.json().catch(() => ({}))) as {
      adresse?: string;
      error?: { message?: string; code?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        message: corps.error?.message ?? t("Réglage refusé."),
        confirmation: corps.error?.code === "identite-a-confirmer",
      };
    }
    adresse = corps.adresse ?? undefined;
  } catch {
    return { ok: false, message: t("L'instance n'a pas répondu.") };
  }

  /*
   * Cette machine vise désormais sa propre passerelle en `https` quand elle
   * est ouverte, et en `http` quand elle ne l'est plus. Le certificat
   * auto-signé couvre `localhost` : le nom reste donc valide, et
   * l'application demandera une fois d'accepter son empreinte.
   */
  const courante = instance();
  const port = portDe(courante.url);
  setInstance({
    ...courante,
    url: `${ouverte ? "https" : "http"}://localhost:${port}`,
  });
  await secretsEcrits();

  const pont = (window as unknown as { oxoai?: { redemarrerPasserelle?: () => Promise<unknown> } })
    .oxoai?.redemarrerPasserelle;
  if (pont) await pont().catch(() => undefined);

  return { ok: true, adresse };
}

/** Port de l'adresse courante, 8787 à défaut. */
function portDe(url: string): number {
  try {
    const p = new URL(url).port;
    return p ? Number(p) : 8787;
  } catch {
    return 8787;
  }
}
