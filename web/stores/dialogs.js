import { defineStore } from "pinia";
export const useDialogsStore = defineStore("dialogs", {
  state: () => ({ requests: [] }),
  actions: {
    applySnapshot(snapshot) {
      this.requests = snapshot.requests || [];
    },
    applyPatch(patch) {
      if ("requests" in patch) this.requests = patch.requests || [];
    },
  },
});
