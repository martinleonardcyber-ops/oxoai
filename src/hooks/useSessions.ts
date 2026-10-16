import { useCallback, useEffect, useMemo, useState } from "react";
import { currentUser } from "@/lib/store/identity";
import {
  archiverSession,
  deleteSession,
  estArchivee,
  estCowork,
  renommerSession,
  visibleTo,
  type Session,
} from "@/lib/store/sessions";
import { effacerMemoireDuChat } from "@/lib/memoireConversation";

/** Événement interne émis quand une session est créée ou mise à jour. */
export const SESSIONS_CHANGED = "helix:sessions-changed";

export function notifySessionsChanged(): void {
  window.dispatchEvent(new Event(SESSIONS_CHANGED));
}

/**
 * Sessions visibles par l'utilisateur connecté (les siennes + les partagées),
 * séparées en deux listes : celles de la barre latérale, et ses archives.
 *
 * `surface` : les Chats (par défaut) ou les sessions de Cowork, jamais les
 * deux mêlés (04/10/2026, store/sessions.ts, `surface`). Une session de
 * Cowork rouverte dans le Chat y perdait ses outils et son dossier.
 */
export function useSessions(surface: "chat" | "cowork" = "chat") {
  const [toutes, setToutes] = useState<Session[]>(() => visibleTo(currentUser()));

  const refresh = useCallback(() => {
    setToutes(visibleTo(currentUser()));
  }, []);

  useEffect(() => {
    window.addEventListener(SESSIONS_CHANGED, refresh);
    // Un autre onglet ou fenêtre a modifié le stockage.
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SESSIONS_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  const { sessions, archivees } = useMemo(() => {
    const moi = currentUser();
    const ici = toutes.filter((s) => estCowork(s) === (surface === "cowork"));
    return {
      sessions: ici.filter((s) => !estArchivee(s, moi)),
      archivees: ici.filter((s) => estArchivee(s, moi)),
    };
  }, [toutes, surface]);

  const remove = useCallback(
    (id: string) => {
      deleteSession(id);
      /*
       * Sa mémoire sur l'instance part avec lui (16/10/2026). L'instance
       * efface aussi celle de chacun quand le Chat quitte la collection
       * synchronisée ; ceci couvre un Chat qui n'y était pas encore arrivé.
       */
      void effacerMemoireDuChat(id).catch(() => {});
      refresh();
    },
    [refresh],
  );

  const archiver = useCallback(
    (id: string, archivee: boolean) => {
      archiverSession(id, currentUser(), archivee);
      refresh();
    },
    [refresh],
  );

  const renommer = useCallback(
    (id: string, titre: string) => {
      renommerSession(id, titre);
      refresh();
    },
    [refresh],
  );

  return { sessions, archivees, refresh, remove, archiver, renommer };
}
