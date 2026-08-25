import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // GitHub Pages hosts this project beneath RupertLinacre's custom-domain
  // user site. Keep local development at / while production assets and data
  // resolve from https://rupertlinacre.com/buslens/.
  base: command === 'build' ? '/buslens/' : '/',
}));
