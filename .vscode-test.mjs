import { defineConfig } from '@vscode/test-cli';
import { resolve } from 'node:path';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: resolve('test-fixtures'),
	mocha: {
		timeout: 15000,
	},
	env: {
		SOPS_AGE_KEY_FILE: resolve('test-fixtures/age-key.txt'),
	},
});
