import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "dsh-third-kernel";
declare const inject: string[];
/**
 * Mount the kernel API. The effect's disposer closes every live kernel child, so
 * unloading the plugin never leaves an orphaned app-server behind.
 */
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };