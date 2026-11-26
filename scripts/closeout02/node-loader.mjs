// Only repository TS modules; no downloads, package substitutes or owner data.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
registerHooks({
  resolve(specifier, context, next) {
    let path;
    if (specifier.startsWith('@/')) path = pathResolve(root, 'src', specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) path = fileURLToPath(new URL(specifier, context.parentURL));
    if (path && existsSync(path + '.ts')) return { url: pathToFileURL(path + '.ts').href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
    return next(url, context);
  },
});
