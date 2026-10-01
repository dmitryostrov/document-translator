// Compatibility entry point; named/discoverable tests live under tests/e2e.
export {};
const child=Bun.spawn(["bun","run","test:e2e",...process.argv.slice(2)],{stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
