import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import react from '@astrojs/react';
import distributionAdapter from './distribution/astro-adapter.mjs';
export default defineConfig({ output:'server', adapter:distributionAdapter(), security:{allowedDomains:[{hostname:'mail.example.invalid',protocol:'https'}]}, devToolbar:{enabled:false}, vite:{plugins:[tailwindcss()]}, integrations:[react()] });
