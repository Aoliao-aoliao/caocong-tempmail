import node from '@astrojs/node';

// Preserve the official adapter's build/static handling; only its server entry changes.
export default function distributionAdapter() {
  const integration = node({mode:'standalone', bodySizeLimit:64 * 1024});
  const configure = integration.hooks['astro:config:done'];
  integration.hooks['astro:config:done'] = context => configure({
    ...context,
    setAdapter(adapter) {
      context.setAdapter({...adapter, serverEntrypoint:new URL('./runtime/astro-entry.mjs', import.meta.url)});
    },
  });
  return integration;
}
