import { defineAsyncComponent } from "vue";

const loaders = new Map([
  [
    "@juicesharp/rpiv-ask-user-question",
    () => import("./@juicesharp/rpiv-ask-user-question/index.js"),
  ],
]);
const components = new Map();
const modules = new Map();

export function packageRequestComponent(packageId) {
  if (!loaders.has(packageId)) return null;
  if (!components.has(packageId))
    components.set(
      packageId,
      defineAsyncComponent({
        loader: async () => {
          const module = await loaders.get(packageId)();
          modules.set(packageId, module);
          return module.default;
        },
        suspensible: false,
      }),
    );
  return components.get(packageId);
}

export function clearPackageRequestState(request) {
  modules.get(request?.packageId)?.clearRequestState?.(request.id);
}

export function cleanupPackageRequestState(requests) {
  for (const [packageId, module] of modules)
    module.cleanupRequestState?.(
      requests.filter(request => request.packageId === packageId),
    );
}
