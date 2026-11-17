// Explicit browser-only QA fixture. Install before E opens the native Whale tab.
// E keeps the exact /plugins/dsh-fusion/state DEMO route and all host UI actions.
export async function installNativeExtensionFixture(page) {
  await page.evaluate(() => {
    const key = "__WHALE_NATIVE_EXTENSION_QA__";
    if (window[key]) throw new Error("Whale extension QA fixture already installed");
    const state = { facades: [], cleanups: [], observation: undefined, select: undefined };
    const ready = event => {
      const api = window.__DSH_FUSION_TASK_VIEWS__;
      if (!api?.ready || api.api.major !== 1 || !api.has("register") ||
          event.detail?.generation !== api.generation) throw new Error("Whale public ready contract mismatch");
      state.observation = undefined;
      state.select = undefined;
      state.facades.push(api);
      state.cleanups.push(api.register({
        id: "whale-native-extension-qa-fixture",
        label: "QA FIXTURE · 集合视图",
        actions: ["dispatch", "cancel"],
        Component: props => {
          state.observation = {
            taskIds: props.tasks.map(task => task.id),
            nodeIds: props.nodes.map(node => node.id),
            topologyTaskIds: [...props.topology.taskIds],
            topologyVersion: props.topology.version,
            connectionStale: props.connectionStale,
            dispatchAvailable: typeof props.onDispatchTask === "function",
            cancelAvailable: typeof props.onCancelTask === "function",
          };
          state.select = props.onSelectTask;
          // Plain text is a valid React component result, independent of the host
          // React version. Button-to-callback wiring already has a module contract.
          return "QA FIXTURE · collection " + state.observation.taskIds.join(", ");
        },
      }));
    };
    state.stop = () => {
      window.removeEventListener("dsh-fusion:task-views-ready", ready);
      for (const cleanup of state.cleanups) cleanup();
      delete window[key];
    };
    window[key] = state;
    window.addEventListener("dsh-fusion:task-views-ready", ready);
  });
  return {
    async inspect() {
      return page.evaluate(() => {
        const state = window.__WHALE_NATIVE_EXTENSION_QA__;
        return {
          generations: state.facades.map(api => api.generation),
          readiness: state.facades.map(api => api.ready),
          staleErrors: state.facades.map(api => {
            try { api.list(); return null; } catch (error) { return error.message; }
          }),
          observation: state.observation ?? null,
        };
      });
    },
    async select(taskId) {
      await page.evaluate(id => {
        const state = window.__WHALE_NATIVE_EXTENSION_QA__;
        if (!state?.observation?.taskIds.includes(id) || typeof state.select !== "function")
          throw new Error("QA task must belong to the rendered extension collection");
        state.select(id);
      }, taskId);
    },
    async dispose() {
      await page.evaluate(() => window.__WHALE_NATIVE_EXTENSION_QA__?.stop());
    },
  };
}
