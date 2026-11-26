import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
 plugins:[react()],
 optimizeDeps:{entries:['scripts/closeout02/component.html']},
 resolve:{alias:[
  {find:'@/lib/supabase',replacement:fileURLToPath(new URL('./adapter.mjs',import.meta.url))},
  {find:'@',replacement:fileURLToPath(new URL('../../src',import.meta.url))},
 ]},
 server:{host:'0.0.0.0',port:3137,strictPort:true},
});
