/**
 * CLI report for dsh-effort-auto-toggle.
 *
 * Usage:
 *   node lib/report.js                # 所有会话的索引
 *   node lib/report.js --last         # 最近一个会话的报表
 *   node lib/report.js --session <id> # 指定会话的报表
 *   node lib/report.js --all          # 全部会话的合并报表
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, defaultLedgerDir, Ledger, renderReport } from "./ledger.js";
function parseArgs(argv) {
    const options = { session: undefined, last: false, all: false };
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--last')
            options.last = true;
        else if (arg === '--all')
            options.all = true;
        else if (arg === '--session' || arg === '-s') {
            index += 1;
            if (index < argv.length)
                options.session = argv[index];
        }
    }
    return options;
}
function print(text) {
    process.stdout.write(`${text}\n`);
}
/**
 * Price overrides live next to the ledger: `prices.json` maps a provider, a
 * model, or `provider|model` to a rate card. Anything malformed is ignored — a
 * report must never fail because of a hand-edited price file.
 */
function readPriceOverrides(dir) {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, 'prices.json'), 'utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
async function main() {
    const options = parseArgs(process.argv);
    const ledger = new Ledger();
    const ledgerDir = process.env.DSH_EFFORT_LEDGER_DIR ?? defaultLedgerDir();
    const prices = readPriceOverrides(ledgerDir);
    const sessions = await ledger.sessions();
    if (sessions.length === 0) {
        print('尚无账本记录（~/.dsh/effort-auto-toggle 为空）。');
        return;
    }
    if (options.session !== undefined) {
        print(renderReport(buildReport(await ledger.read(options.session), { priceOverrides: prices, ledgerDir })));
        return;
    }
    if (options.last) {
        const latest = sessions.at(-1);
        if (latest === undefined)
            return;
        print(`会话：${latest}`);
        print(renderReport(buildReport(await ledger.read(latest), { priceOverrides: prices, ledgerDir })));
        return;
    }
    if (options.all) {
        const records = (await Promise.all(sessions.map(id => ledger.read(id)))).flat();
        print(`合并 ${sessions.length} 个会话`);
        print(renderReport(buildReport(records, { priceOverrides: prices, ledgerDir })));
        return;
    }
    print('可用会话（--session <id> 查看，--last 最近，--all 合并）：');
    for (const id of sessions) {
        const records = await ledger.read(id);
        const output = records.reduce((sum, record) => sum + record.outputTokens, 0);
        print(`  ${id}  ${records.length} 步  ${output} tokens`);
    }
}
await main();
