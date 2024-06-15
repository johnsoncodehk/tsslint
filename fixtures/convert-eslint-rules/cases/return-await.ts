// @ts-nocheck

async function invalidInTryCatch1() {
	try {
		return Promise.reject('try');
	} catch (e) {
		// Doesn't execute due to missing await.
	}
}

async function invalidInTryCatch2() {
	try {
		throw new Error('error');
	} catch (e) {
		// Unnecessary await; rejections here don't impact control flow.
		return await Promise.reject('catch');
	}
}

// Prints 'starting async work', 'cleanup', 'async work done'.
async function invalidInTryCatch3() {
	async function doAsyncWork(): Promise<void> {
		console.log('starting async work');
		await new Promise(resolve => setTimeout(resolve, 1000));
		console.log('async work done');
	}

	try {
		throw new Error('error');
	} catch (e) {
		// Missing await.
		return doAsyncWork();
	} finally {
		console.log('cleanup');
	}
}

async function invalidInTryCatch4() {
	try {
		throw new Error('error');
	} catch (e) {
		throw new Error('error2');
	} finally {
		// Unnecessary await; rejections here don't impact control flow.
		return await Promise.reject('finally');
	}
}

async function invalidInTryCatch5() {
	return await Promise.resolve('try');
}

async function invalidInTryCatch6() {
	return await 'value';
}
