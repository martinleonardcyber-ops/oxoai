import { useCallback, useEffect, useState } from "react";
import { fetchMcp, toggleMcpServer, type McpServerStatus } from "@/lib/gateway";
import { apiFetch } from "@/lib/endpoint";
import { t } from "@/lib/i18n";

interface State {
  workspace?: string;
  espaces?: string[];
  toutLePoste?: boolean;
  servers: McpServerStatus[];
  loading: boolean;
  /** Le moteur d'outils n'a pas répondu du tout. */
  error?: string;
  /*
   * Motif d'un changement de dossier refusé. Distinct de `error` : « chemin
   * hors du disque autorisé » et « instance injoignable » n'appellent ni le
   * même message ni le même endroit à l'écran.
   */
  erreurWorkspace?: string;
}

/**
 * Signal interne : l'état MCP vient de changer quelque part.
 *
 * Chaque appel de `useMcp` porte son propre état. L'écran Cowork en monte deux :
 * la barre de contexte et le panneau de droite. Changer le dossier de travail
 * depuis la barre ne rafraîchissait donc que la barre — le panneau continuait
 * d'afficher l'ancien dossier et l'ancienne liste d'outils jusqu'au prochain
 * démontage. Ce signal les remet d'accord.
 */
export const MCP_CHANGE = "oxoai:mcp-change";

/** Serveurs MCP et outils réellement disponibles pour l'agent. */
export function useMcp() {
  const [state, setState] = useState<State>({ servers: [], loading: true });

  const refresh = useCallback(() => {
    fetchMcp()
      .then((d) =>
        setState({
          workspace: d.workspace,
          espaces: d.espaces,
          toutLePoste: d.toutLePoste,
          servers: d.servers,
          loading: false,
        }),
      )
      .catch((err: unknown) =>
        setState({
          servers: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(MCP_CHANGE, refresh);
    return () => window.removeEventListener(MCP_CHANGE, refresh);
  }, [refresh]);

  const toggle = useCallback(
    async (id: string, start: boolean) => {
      try {
        await toggleMcpServer(id, start);
      } catch {
        /* l'état rechargé montrera l'erreur */
      }
      window.dispatchEvent(new Event(MCP_CHANGE));
    },
    [],
  );

  /**
   * Change le dossier auquel l'agent a accès. Le serveur de fichiers redémarre
   * avec le nouveau périmètre : c'est un argument de lancement, pas un réglage
   * qui s'applique à chaud.
   */
  const changerWorkspace = useCallback(
    async (
      /** Un dossier, ou « poste » pour ouvrir tout le poste d'un coup. */
      dossier: string,
      identite?: { motDePasse: string; code?: string },
    ): Promise<{ ok: boolean; confirmation?: boolean }> => {
      // Une nouvelle tentative efface le motif du refus précédent.
      setState((s) => ({ ...s, erreurWorkspace: undefined }));
      try {
        const res = await apiFetch("/oxoai/mcp/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            dossier === "poste" ? { portee: "poste", ...identite } : { dossier, ...identite },
          ),
        });
        if (!res.ok) {
          const corps = (await res.json().catch(() => ({}))) as {
            error?: { message?: string; code?: string };
          };
          /*
           * Sur une instance partagée, le dossier de travail est commun à
           * toute l'équipe : l'instance redemande le mot de passe. L'écran le
           * demande à son tour, au lieu d'afficher un refus sans issue.
           */
          const confirmation = corps.error?.code === "identite-a-confirmer";
          setState((s) => ({
            ...s,
            erreurWorkspace: confirmation ? undefined : corps.error?.message ?? t("Changement refusé."),
          }));
          return { ok: false, confirmation };
        }
      } catch {
        setState((s) => ({ ...s, erreurWorkspace: "Instance injoignable." }));
        return { ok: false };
      }
      // Le dossier redéfinit le périmètre de l'agent : tout écran qui l'affiche
      // doit le relire, pas seulement celui d'où part le changement.
      window.dispatchEvent(new Event(MCP_CHANGE));
      return { ok: true };
    },
    [],
  );

  const toolCount = state.servers.reduce((n, s) => n + s.toolCount, 0);

  return { ...state, toolCount, refresh, toggle, changerWorkspace };
}
