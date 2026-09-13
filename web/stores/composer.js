import { defineStore } from "pinia";

export const useComposerStore = defineStore("composer", {
  state: () => ({
    draft: "",
    drafts: new Map(),
    sending: false,
    commandIndex: 0,
    dismissed: "",
    picker: null,
    provider: null,
    modelQuery: "",
    popover: null,
    view: "chat",
  }),
  getters: {
    commandQuery: (state) => /^\/([^\s]*)$/.exec(state.draft),
    matches: (state) => (session) => {
      const match = /^\/([^\s]*)$/.exec(state.draft);
      return match &&
        state.dismissed !== state.draft &&
        session.connection === "connected"
        ? (session.commands || []).filter((item) =>
            item.name.toLowerCase().startsWith(match[1].toLowerCase()),
          )
        : [];
    },
  },
  actions: {
    restoreDraft(sessionId) {
      this.draft = this.drafts.get(sessionId) || "";
      this.dismissed = "";
      this.commandIndex = 0;
    },
    saveDraft(sessionId) {
      if (sessionId) this.drafts.set(sessionId, this.draft);
    },
    setDraft(value) {
      this.draft = value;
      this.dismissed = "";
      this.commandIndex = 0;
    },
    clear() {
      this.draft = "";
      this.dismissed = "";
      this.commandIndex = 0;
    },
    dismissCommands() {
      this.dismissed = this.draft;
    },
    togglePicker(value, models = []) {
      if (this.picker === value) {
        this.picker = null;
        return;
      }
      this.picker = value;
      this.popover = null;
      if (value === "model") {
        this.modelQuery = "";
        if (
          this.provider &&
          !models.some((item) => item.provider === this.provider)
        )
          this.provider = null;
      }
    },
    selectProvider(provider) {
      this.provider = provider || null;
      this.modelQuery = "";
    },
    closeOverlays() {
      this.picker = null;
      this.popover = null;
    },
  },
});
