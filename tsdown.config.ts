import type { UserConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'tsdown'
import { StaleGuardRecorder } from 'tsdown-stale-guard'

/**
 * Modules the Web shell already provides. These stay `require()` calls in the
 * client bundle and are resolved by the DSH module table (static seed words or
 * boot-graph rows), never bundled — see the `staticModules` map the shell hands
 * to `createClientModuleSystem`.
 */
export const dshExternal = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  /^@deepseek-ai\//,
]

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
const id = JSON.stringify(pkg.name)

const common: UserConfig = {
  outDir: 'dist',
  format: 'esm',
  outExtensions: () => ({ js: '.js' }),
  publint: true,
  external: dshExternal,
  plugins: [StaleGuardRecorder],
}

export default defineConfig([
  {
    ...common,
    entry: { index: 'src/index.ts' },
    dts: true,
    sourcemap: false,
    clean: true,
  },
  {
    ...common,
    entry: { client: 'src/client/index.ts' },
    // Client bundles are classic scripts consumed by dsh-client-modules.
    // CJS output is required so its exports remain inside the loader factory.
    format: 'cjs',
    // CJS must not use `.js` in a `"type": "module"` package: publint reads that
    // as an ESM/CJS mismatch, so the artifact is `.cjs`.
    outExtensions: () => ({ js: '.cjs' }),
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    banner: `window.__ModuleLoader__.load({id:${id},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
    footer: 'return module.exports;}});',
    dts: false,
    sourcemap: true,
    minify: true,
    clean: false,
    // The client entry is deliberately a classic CJS script wrapped by
    // ModuleLoader, so publint's ESM default-export heuristic is inapplicable.
    publint: false,
  },
])
