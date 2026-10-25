import { useCallback, useEffect, useState } from "react";
import { currentUser } from "@/lib/store/identity";
import {
  visibleTo,
  createAgent,
  updateAgent,
  deleteAgent,
  DEFAULT_AGENT,
  type Agent,
} from "@/lib/store/agents";

const CHANGED = "oxoai:agents-changed";

function notify(): void {
  window.dispatchEvent(new Event(CHANGED));
}

/** Agents visibles par l'utilisateur connecté. */
export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>(() => visibleTo(currentUser()));

  const refresh = useCallback(() => setAgents(visibleTo(currentUser())), []);

  useEffect(() => {
    window.addEventListener(CHANGED, refresh);
    return () => window.removeEventListener(CHANGED, refresh);
  }, [refresh]);

  const create = useCallback(
    (data: Parameters<typeof createAgent>[1]) => {
      const agent = createAgent(currentUser(), data);
      notify();
      return agent;
    },
    [],
  );

  const update = useCallback((id: string, changes: Partial<Agent>) => {
    updateAgent(id, changes);
    notify();
  }, []);

  const remove = useCallback((id: string) => {
    deleteAgent(id);
    notify();
  }, []);

  /** Liste proposée dans le sélecteur : agent par defaut en tete. */
  const selectable = [DEFAULT_AGENT, ...agents];

  return { agents, selectable, create, update, remove, refresh };
}
