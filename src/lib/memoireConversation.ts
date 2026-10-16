import { apiFetch } from "@/lib/endpoint";
import { t } from "@/lib/i18n";

/**
 * Mémoire d'un Chat sur l'instance (gateway/src/memoireConversation.ts,
 * 16/10/2026) : ce qui est sorti de la place du modèle, rangé au nom de la
 * personne de la séance. Le poste ne la lit pas ; il peut seulement l'effacer.
 */

/** « Effacer la mémoire de ce Chat » : la sienne seulement ; le Chat et ses messages restent. Rend vrai si une mémoire existait. */
export async function effacerMemoireDuChat(chat: string): Promise<boolean> {
  const res = await apiFetch(`/helix/memoire-chat/${encodeURIComponent(chat)}`, { method: "DELETE" });
  const corps = (await res.json().catch(() => ({}))) as { effacee?: boolean; error?: { message?: string } };
  if (!res.ok) throw new Error(corps.error?.message ?? t("L'instance n'a pas répondu."));
  return corps.effacee === true;
}
