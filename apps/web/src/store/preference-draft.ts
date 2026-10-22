import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PreferenceDraft } from '@tripbeam/contracts';

type PreferenceDraftStore = {
  draft: Partial<PreferenceDraft>;
  setDraft: (draft: Partial<PreferenceDraft>) => void;
  clearDraft: () => void;
};

export const usePreferenceDraftStore = create<PreferenceDraftStore>()(
  persist(
    (set) => ({
      draft: { startTime: '14:00' },
      setDraft: (draft) => set({ draft }),
      clearDraft: () => set({ draft: { startTime: '14:00' } }),
    }),
    { name: 'tripbeam-preference-draft' },
  ),
);
