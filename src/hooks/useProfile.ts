import { useCallback, useEffect, useState } from "react";
import { currentUser, type User } from "@/lib/store/identity";
import {
  loadProfile,
  saveProfile,
  addMemory as addMemoryTo,
  removeMemory as removeMemoryFrom,
  type UserProfile,
} from "@/lib/store/profile";

/** Événement interne : garde les écrans synchronisés après une sauvegarde. */
const CHANGED = "oxoai:profile-changed";

/** Profil privé de l'utilisateur connecté. */
export function useProfile() {
  const [user] = useState<User>(() => currentUser());
  const [profile, setProfile] = useState<UserProfile>(() => loadProfile(currentUser().id));

  useEffect(() => {
    const onChange = () => setProfile(loadProfile(user.id));
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, [user.id]);

  const update = useCallback((changes: Partial<UserProfile>) => {
    setProfile((prev) => {
      const next = { ...prev, ...changes };
      saveProfile(next);
      window.dispatchEvent(new Event(CHANGED));
      return next;
    });
  }, []);

  const addMemory = useCallback((text: string) => {
    setProfile((prev) => {
      const next = addMemoryTo(prev, text);
      window.dispatchEvent(new Event(CHANGED));
      return next;
    });
  }, []);

  const removeMemory = useCallback((id: string) => {
    setProfile((prev) => {
      const next = removeMemoryFrom(prev, id);
      window.dispatchEvent(new Event(CHANGED));
      return next;
    });
  }, []);

  return { user, profile, update, addMemory, removeMemory };
}
