"use strict";
// Compare 原版 TSSLint CLI vs PoC shim engine.
//
//   node packages/poc-tsgo/bench.js                    # micro (default)
//   node packages/poc-tsgo/bench.js --scenario=medium  # 3 packages, syntactic
//   node packages/poc-tsgo/bench.js --scenario=full    # root ts-eslint (slow)
//   node packages/poc-tsgo/bench.js --scenario=all     # all scenarios
//   node packages/poc-tsgo/bench.js --runs=3
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const os = require("os");
const path = require("path");
const engine_js_1 = require("./lib/engine.js");
const tsgo_load_js_1 = require("./lib/tsgo-load.js");
require('./lib/real-ts.js');
const repoRoot = path.resolve(__dirname, '../..');
const cliBin = path.join(repoRoot, 'packages/cli/bin/tsslint.js');
const pocBin = path.join(repoRoot, 'packages/poc-tsgo/run-poc.js');
const SCENARIOS = {
    micro: {
        id: 'micro',
        label: 'fixtures/define-rule — 1 file, syntactic no-console',
        fileCount: 1,
        cliArgs: ['--project', engine_js_1.cliProject],
        pocEngine: true,
        defaultRuns: 5,
    },
    medium: {
        id: 'medium',
        label: 'packages/{cli,core,config} — ~37 files, 根 tsslint.config + ts-eslint',
        fileCount: 37,
        cliArgs: [
            '--project', 'packages/cli/tsconfig.json',
            '--project', 'packages/core/tsconfig.json',
            '--project', 'packages/config/tsconfig.json',
        ],
        pocEngine: false,
        defaultRuns: 3,
    },
    full: {
        id: 'full',
        label: '根 tsslint.config + 全 packages — ts-eslint type-aware (~59 files)',
        fileCount: 59,
        cliArgs: ['--project', '{tsconfig.json,packages/*/tsconfig.json}'],
        pocEngine: false,
        defaultRuns: 1,
    },
};
function parseArg(name) {
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith(`--${name}=`))
            return arg.slice(name.length + 3);
    }
    return undefined;
}
function parseRuns(fallback) {
    const raw = parseArg('runs');
    if (raw !== undefined)
        return Math.max(1, Number(raw) || fallback);
    return fallback;
}
function parseScenarios() {
    const raw = parseArg('scenario') ?? 'micro';
    if (raw === 'all')
        return ['micro', 'medium', 'full'];
    if (raw in SCENARIOS)
        return [raw];
    console.error(`Unknown --scenario=${raw} (micro|medium|full|all)`);
    process.exit(1);
}
function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}
function timeFn(runs, fn) {
    const all = [];
    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        fn();
        all.push(performance.now() - t0);
    }
    return { med: median(all), all };
}
function timeCli(runs, extraArgs) {
    const all = [];
    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        (0, child_process_1.spawnSync)(process.execPath, [cliBin, '--force', ...extraArgs], {
            cwd: repoRoot,
            stdio: 'ignore',
        });
        all.push(performance.now() - t0);
    }
    return { med: median(all), all };
}
function timePocScript(runs, extraArgs) {
    const all = [];
    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        (0, child_process_1.spawnSync)(process.execPath, [pocBin, ...extraArgs], {
            cwd: repoRoot,
            stdio: 'ignore',
        });
        all.push(performance.now() - t0);
    }
    return { med: median(all), all };
}
function fmt(r) {
    return `${r.med.toFixed(0)}ms  (${r.all.map(t => t.toFixed(0)).join(', ')})`;
}
function benchScenario(scenario) {
    const runs = parseRuns(scenario.defaultRuns);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Scenario: ${scenario.id}`);
    console.log(`Workload: ${scenario.label}`);
    console.log(`Runs: ${runs} (median wall)\n`);
    const cliStrada = timeCli(runs, scenario.cliArgs);
    const cliTsgo = (0, engine_js_1.hasNativePreview)()
        ? timeCli(runs, [...scenario.cliArgs, '--tsgo'])
        : undefined;
    const cliTsgoFast = (0, engine_js_1.hasNativePreview)() && scenario.fileCount > 1
        ? timeCli(runs, [...scenario.cliArgs, '--tsgo', '--tsgo-fast'])
        : undefined;
    console.log('── 原版 CLI（完整 pipeline）──');
    console.log(`  Strada (default):  ${fmt(cliStrada)}`);
    if (cliTsgo) {
        const skipCache = scenario.fileCount > 1;
        console.log(`  --tsgo${skipCache ? ' (skip cache)' : ''}:  ${fmt(cliTsgo)}`);
        console.log(`  --tsgo / Strada:   ${(cliTsgo.med / cliStrada.med).toFixed(2)}×`);
    }
    else {
        console.log('  --tsgo:            skip (no @typescript/native-preview)');
    }
    if (cliTsgoFast) {
        console.log(`  --tsgo --tsgo-fast:  ${fmt(cliTsgoFast)} (eager-prepare)`);
        if (cliTsgo) {
            console.log(`  --tsgo-fast overhead: ${(cliTsgoFast.med / cliTsgo.med).toFixed(2)}× vs default --tsgo`);
        }
    }
    if (!scenario.pocEngine) {
        console.log('\n  (PoC engine 僅適用 micro 場景 — 不同 workload 略過)');
        return;
    }
    const pocBoth = timePocScript(runs, []);
    const pocStrada = timeFn(runs, () => (0, engine_js_1.runStrada)());
    const pocTsgo = (0, engine_js_1.hasNativePreview)() ? timeFn(runs, () => (0, engine_js_1.runTsgo)()) : undefined;
    const pocStradaScript = timePocScript(runs, ['--strada-only']);
    const pocTsgoScript = (0, engine_js_1.hasNativePreview)() ? timePocScript(runs, ['--tsgo-only']) : undefined;
    console.log('\n── PoC 腳本開銷（含 process spawn）──');
    console.log(`  run-poc (both):    ${fmt(pocBoth)}`);
    console.log(`  --strada-only:     ${fmt(pocStradaScript)}`);
    if (pocTsgoScript)
        console.log(`  --tsgo-only:       ${fmt(pocTsgoScript)}`);
    console.log('\n── PoC 引擎核心（同 process，無 parity 輸出）──');
    console.log(`  engine Strada:     ${fmt(pocStrada)}`);
    if (pocTsgo)
        console.log(`  engine tsgo:       ${fmt(pocTsgo)}`);
    console.log('\n── 解讀 ──');
    console.log(`  CLI Strada / PoC engine Strada ≈ ${(cliStrada.med / pocStrada.med).toFixed(2)}×  (CLI pipeline 開銷)`);
    if (pocTsgo) {
        console.log(`  PoC engine tsgo / Strada ≈ ${(pocTsgo.med / pocStrada.med).toFixed(2)}×`);
    }
    if (cliTsgo) {
        console.log(`  CLI --tsgo / CLI Strada ≈ ${(cliTsgo.med / cliStrada.med).toFixed(2)}×`);
    }
    console.log(`  PoC both / CLI Strada ≈ ${(pocBoth.med / cliStrada.med).toFixed(2)}×  (PoC 含 Strada+tsgo 兩遍)`);
}
function main() {
    const scenarios = parseScenarios();
    console.log('TSSLint CLI vs PoC 性能對比');
    console.log(`Host: ${os.platform()} ${os.arch()}, Node ${process.version}`);
    if ((0, engine_js_1.hasNativePreview)()) {
        try {
            const { layout } = (0, tsgo_load_js_1.loadTsgoModules)();
            console.log(`@typescript/native-preview layout: ${layout}`);
        }
        catch { /* ignore */ }
    }
    for (const id of scenarios) {
        benchScenario(SCENARIOS[id]);
    }
}
main();
//# sourceMappingURL=bench.js.map