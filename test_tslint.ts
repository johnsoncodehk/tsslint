import { importTSLintRules } from './packages/config/lib/tslint';

async function test() {
	try {
		// 這裡我們模擬一個簡單的測試，因為環境中可能沒有安裝 tslint
		console.log('Testing importTSLintRules...');
		const rules = await importTSLintRules({
			'class-name': true,
			'no-arg': [true, 'extra-option'],
		});
		console.log('Rules imported successfully:', Object.keys(rules));
	}
	catch (err) {
		console.log('Expected error or success:', err.message);
	}
}

test();
