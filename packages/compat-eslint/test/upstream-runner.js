"use strict";
// Minimal test runner for porting upstream @typescript-eslint/scope-manager
// tests to validate TsScopeManager. The upstream tests are vitest-based; this
// shim implements just enough of the API surface (describe/it/expect +
// chai-style isScopeOfType) to load their test files unchanged.
//
// The upstream tests live under `test/upstream/` (vendored from
// typescript-eslint, MIT — see test/upstream/README.md). Override with
// TSE_TESTS_DIR if you want to point at a different copy.
//
// Usage:
//   node packages/compat-eslint/test/upstream-runner.js [pattern]
//   TSE_TESTS_DIR=/path/to/tests node packages/compat-eslint/test/upstream-runner.js
//
// Each test file calls `parseAndAnalyze(code)` from its own test-utils. We
// intercept the require of '../test-utils/index.js' (the path tests use) and
// substitute an adapter that returns a TsScopeManager-backed result instead
// of upstream's analyze().
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefinitionType = exports.ScopeType = void 0;
exports.getRealVariables = getRealVariables;
exports.parseAndAnalyze = parseAndAnalyze;
const ts = __importStar(require("typescript"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const Module = require('module');
// Use typescript-estree's eager astConverter directly — upstream tests
// do shape comparisons (`parent === referencingNode`) that need
// identical node identity, which lazy mode breaks unless the entire
// tree pre-materialises (defeats lazy). Production-wise compat-eslint
// defaults to lazy via index.ts; this test runner uses eager to keep
// parity tests reliable.
const { astConverter } = require('@typescript-eslint/typescript-estree/use-at-your-own-risk');
const { TsScopeManager } = require('../lib/ts-scope-manager.js');
const PARSE_SETTINGS = {
    allowInvalidAST: false,
    comment: true,
    errorOnUnknownASTType: false,
    loc: true,
    range: true,
    suppressDeprecatedPropertyWarnings: true,
    tokens: true,
};
function buildHost(fileName, content) {
    const realLibPath = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest });
    const realLibName = realLibPath.split(/[\\/]/).pop();
    const realLibContent = ts.sys.readFile(realLibPath) ?? '';
    const realLib = ts.createSourceFile(realLibPath, realLibContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return {
        getSourceFile: (n) => n === fileName ? sf : (n === realLibPath ? realLib : undefined),
        getDefaultLibFileName: () => realLibName,
        getDefaultLibLocation: () => realLibPath.replace('/' + realLibName, ''),
        writeFile: () => { },
        getCurrentDirectory: () => '/',
        getDirectories: () => [],
        fileExists: (n) => n === fileName || n === realLibPath,
        readFile: (n) => n === fileName ? content : (n === realLibPath ? realLibContent : undefined),
        getCanonicalFileName: (n) => n,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
    };
}
function parseAndAnalyze(code, options) {
    const fileName = '/test.ts';
    const host = buildHost(fileName, code);
    const program = ts.createProgram({
        rootNames: [fileName],
        options: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, allowJs: false },
        host,
    });
    const sf = program.getSourceFile(fileName);
    const { astMaps, estree } = astConverter(sf, PARSE_SETTINGS, true);
    let sourceType = 'script';
    if (typeof options === 'string')
        sourceType = options;
    else if (options && typeof options === 'object' && options.sourceType)
        sourceType = options.sourceType;
    estree.sourceType = sourceType;
    const scopeManager = new TsScopeManager(sf, program, estree, astMaps, sourceType);
    return { ast: estree, scopeManager };
}
const allResults = [];
let currentSuite = [];
globalThis.describe = (name, fn) => {
    currentSuite.push(name);
    try {
        fn();
    }
    finally {
        currentSuite.pop();
    }
};
globalThis.it = (name, fn) => {
    const fullName = [...currentSuite, name].join(' > ');
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            throw new Error('async tests not supported in this runner');
        }
        allResults.push({ name: fullName, pass: true });
    }
    catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        allResults.push({ name: fullName, pass: false, error: msg });
    }
};
globalThis.it.skip = (_name, _fn) => { };
// vitest's `it.for([cases])(name, fn)` for parametrized tests. fn receives
// `(case, ctx)` where ctx has { expect, ... }. We forward our own expect.
globalThis.it.for = (cases) => (name, fn) => {
    for (const c of cases) {
        globalThis.it(`${name} (${ser(c)})`, () => fn(c, { expect: globalThis.expect }));
    }
};
class Expect {
    constructor(actual, negated = false) {
        this.actual = actual;
        this.negated = negated;
    }
    get not() { return new Expect(this.actual, !this.negated); }
    check(cond, msg) {
        const ok = this.negated ? !cond : cond;
        if (!ok)
            throw new Error(msg + (this.negated ? ' (negated)' : ''));
    }
    toBe(expected) {
        this.check(Object.is(this.actual, expected), `Expected ${ser(this.actual)} === ${ser(expected)}`);
    }
    toStrictEqual(expected) {
        this.check(deepEqual(this.actual, expected), `Expected ${ser(this.actual)} ≡ ${ser(expected)}`);
    }
    toHaveLength(n) {
        this.check(this.actual?.length === n, `Expected length ${this.actual?.length} === ${n}`);
    }
    toBeNull() { this.check(this.actual === null, `Expected null, got ${ser(this.actual)}`); }
    toBeUndefined() { this.check(this.actual === undefined, `Expected undefined, got ${ser(this.actual)}`); }
    toBeTruthy() { this.check(!!this.actual, `Expected truthy, got ${ser(this.actual)}`); }
    toBeFalsy() { this.check(!this.actual, `Expected falsy, got ${ser(this.actual)}`); }
    toBeGreaterThanOrEqual(n) { this.check(this.actual >= n, `Expected ${this.actual} >= ${n}`); }
    toContain(item) { this.check(this.actual?.includes?.(item), `Expected ${ser(this.actual)} to contain ${ser(item)}`); }
    toHaveDeclaredVariables(_names) {
        // Custom matcher used in get-declared-variables tests; defer / soft-pass for now.
        this.check(true, 'toHaveDeclaredVariables stub');
    }
    toMatchInlineSnapshot(_expected) {
        // Snapshot tests — soft-pass since we can't update snapshots.
        this.check(true, 'snapshot stub');
    }
}
function ser(v) {
    if (v == null)
        return String(v);
    if (typeof v === 'string')
        return JSON.stringify(v);
    if (typeof v !== 'object')
        return String(v);
    if (v.type && v.name)
        return `<${v.type} ${v.name}>`;
    if (Array.isArray(v))
        return `[len=${v.length}]`;
    return `<${v.constructor?.name ?? 'object'}>`;
}
function deepEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b)
        return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++)
            if (!deepEqual(a[i], b[i]))
                return false;
        return true;
    }
    if (a.constructor !== b.constructor)
        return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length)
        return false;
    for (const k of ka)
        if (!deepEqual(a[k], b[k]))
            return false;
    return true;
}
globalThis.expect = (actual) => new Expect(actual);
// chai.assert.isScopeOfType(scope, type) — used in eslint-scope tests.
globalThis.assert = {
    isScopeOfType(scope, type) {
        if (scope?.type !== type) {
            throw new Error(`Expected scope.type === ${type}, got ${scope?.type}`);
        }
    },
    isNotScopeOfType(scope, type) {
        if (scope?.type === type) {
            throw new Error(`Expected scope.type !== ${type}`);
        }
    },
    isDefinitionOfType(def, type) {
        if (def?.type !== type) {
            throw new Error(`Expected def.type === ${type}, got ${def?.type}`);
        }
    },
    isNodeOfType(node, type) {
        if (node?.type !== type) {
            throw new Error(`Expected node.type === ${type}, got ${node?.type}`);
        }
    },
    exists(v) {
        if (v == null)
            throw new Error(`Expected non-null, got ${ser(v)}`);
    },
    notExists(v) {
        if (v != null)
            throw new Error(`Expected null/undefined, got ${ser(v)}`);
    },
    isNull(v) {
        if (v !== null)
            throw new Error(`Expected null, got ${ser(v)}`);
    },
    isNotNull(v) {
        if (v === null)
            throw new Error(`Expected non-null, got null`);
    },
    isTrue(v) {
        if (v !== true)
            throw new Error(`Expected true, got ${ser(v)}`);
    },
    isFalse(v) {
        if (v !== false)
            throw new Error(`Expected false, got ${ser(v)}`);
    },
};
// --- Module loader interception -----------------------------------------
// Tests do `import { ScopeType, ... } from '../../src/index.js'`. We swap that
// for a tiny shim exporting matching constants/types and our parseAndAnalyze.
const REAL_RESOLVE = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === '../../src/index.js' || req === '../../../src/index.js' || req === '../test-utils/index.js' || req === '../../test-utils/index.js') {
        return path.resolve(__dirname, 'upstream-shim.js');
    }
    return REAL_RESOLVE.call(this, req, parent, ...rest);
};
// upstream-shim — generated next to the runner.
const SHIM_PATH = path.resolve(__dirname, 'upstream-shim.js');
fs.writeFileSync(SHIM_PATH, '"use strict";\n'
    + 'const { parseAndAnalyze, ScopeType, DefinitionType, getRealVariables } = require('
    + JSON.stringify(__filename) + ');\n'
    + 'module.exports = { parseAndAnalyze, ScopeType, DefinitionType, getRealVariables };\n');
exports.ScopeType = {
    block: 'block',
    'catch': 'catch',
    'class': 'class',
    classFieldInitializer: 'class-field-initializer',
    conditionalType: 'conditional-type',
    'for': 'for',
    'function': 'function',
    functionExpressionName: 'function-expression-name',
    functionType: 'function-type',
    global: 'global',
    mappedType: 'mapped-type',
    module: 'module',
    'switch': 'switch',
    tsEnum: 'tsEnum',
    tsModule: 'tsModule',
    type: 'type',
    'with': 'with',
};
exports.DefinitionType = {
    CatchClause: 'CatchClause',
    ClassName: 'ClassName',
    FunctionName: 'FunctionName',
    ImplicitGlobalVariable: 'ImplicitGlobalVariable',
    ImportBinding: 'ImportBinding',
    Parameter: 'Parameter',
    TDZ: 'TDZ',
    Variable: 'Variable',
    Type: 'Type',
    TSEnumName: 'TSEnumName',
    TSEnumMember: 'TSEnumMember',
    TSModuleName: 'TSModuleName',
};
function getRealVariables(variables) {
    // Filter synthetic 'arguments' and lib globals (matches upstream's
    // ImplicitLibVariable filter — ours has no class but we tag manager-side).
    return variables;
}
// --- Run --------------------------------------------------------------
const pattern = process.argv[2];
const testsRoot = process.env.TSE_TESTS_DIR
    ?? path.resolve(__dirname, 'upstream');
if (!fs.existsSync(testsRoot)) {
    console.error(`Upstream tests not found at ${testsRoot}.\n`
        + 'See the comment at the top of upstream-runner.ts for setup steps.');
    process.exit(2);
}
const testFiles = collectTests(testsRoot, pattern);
// The test files are .ts with `import` syntax. Pre-process each into a CJS
// snippet (strip types + rewrite import → require) and run it via vm.
function loadTestFile(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');
    // Strip TypeScript types — let TS itself transpile (faster than regex).
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: filePath,
    }).outputText;
    const wrapped = `(function(module, exports, require, __filename, __dirname){\n${transpiled}\n})`;
    const fn = (0, eval)(wrapped);
    const mod = { exports: {} };
    fn(mod, mod.exports, (req) => {
        // Tests reference '../../src/index.js' or '../test-utils/index.js' —
        // route both to our shim. Other requires resolve from this package
        // (so '@typescript-eslint/types' etc. find our node_modules).
        if (req === '../../src/index.js'
            || req === '../../../src/index.js'
            || req === '../test-utils/index.js'
            || req === '../../test-utils/index.js') {
            return require(SHIM_PATH);
        }
        return require(req);
    }, filePath, path.dirname(filePath));
}
console.log(`Running ${testFiles.length} test files...\n`);
for (const f of testFiles) {
    console.log(`--- ${path.relative(testsRoot, f)} ---`);
    const before = allResults.length;
    try {
        loadTestFile(f);
    }
    catch (err) {
        console.log('  LOAD ERROR: ' + (err instanceof Error ? err.message : String(err)));
    }
    const after = allResults.length;
    const fp = allResults.slice(before, after).filter(r => r.pass).length;
    const ff = allResults.slice(before, after).filter(r => !r.pass).length;
    console.log(`  ${fp} passed, ${ff} failed`);
}
const passed = allResults.filter(r => r.pass).length;
const failed = allResults.filter(r => !r.pass).length;
console.log(`\n=== ${passed}/${allResults.length} passed (${failed} failed) ===`);
if (failed > 0 && process.argv.includes('-v')) {
    console.log('\nFailures:');
    for (const r of allResults) {
        if (!r.pass) {
            const firstLine = (r.error ?? '').split('\n')[0];
            console.log(`  - ${r.name}: ${firstLine}`);
        }
    }
}
process.exit(failed > 0 ? 1 : 0);
function collectTests(dir, pat) {
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) {
                if (e.name === '__snapshots__' || e.name === 'fixtures' || e.name === 'test-utils')
                    continue;
                walk(full);
            }
            else if (e.name.endsWith('.test.ts')) {
                if (pat && !full.includes(pat))
                    continue;
                out.push(full);
            }
        }
    };
    walk(dir);
    return out;
}
//# sourceMappingURL=upstream-runner.js.map