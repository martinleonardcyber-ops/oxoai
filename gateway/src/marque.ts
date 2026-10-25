/**
 * Nom du produit dans les messages de la passerelle.
 *
 * Le produit est livré en marque blanche : un message qui dirait « OxoAI
 * refuse de continuer » chez un client qui connaît l'application sous un autre
 * nom trahirait la marque sous-jacente, et le modèle le répéterait. L'application
 * de bureau transmet son nom au lancement (`OXOAI_NOM_PRODUIT`, tiré de
 * `productName`) ; sans lui (instance de serveur, essai), un repli neutre, dans la
 * langue de la personne : il restait en français pour tous (relevé en chinois le
 * 27/09/2026, « 随 l'application 提供 »).
 */

import { t } from "./langue.ts";

const nomTransmis = (): string | undefined => process.env.OXOAI_NOM_PRODUIT?.trim() || undefined;

/** Dans une phrase : « autorisez Marque dans… », « connectée à l'application ». */
export const nomProduit = (): string => nomTransmis() ?? t("l'application");

/** En début de phrase : « Marque refuse… », « L'application refuse… ». */
export const NomProduit = (): string => nomTransmis() ?? t("L'application");
