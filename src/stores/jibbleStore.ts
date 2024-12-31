import { create } from 'zustand';
import { getJibbleToken } from '../services/jibble/auth';

interface JibbleState {
  token: string | null;
  expiresAt: number | null;
  getToken: () => Promise<string>;
}

export const useJibbleStore = create<JibbleState>((set) => ({
  token: null,
  expiresAt: null,

  getToken: async () => {
    try {
      const token = await getJibbleToken();
      set({ token });
      return token;
    } catch (error) {
      console.error('Failed to get Jibble token:', error);
      throw error;
    }
  }
}));