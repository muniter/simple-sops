import { defineConfig } from '@vscode/test-cli';
import { resolve } from 'node:path';

export default defineConfig([
	{
		label: 'integration',
		files: 'out-test/integration.test.js',
		workspaceFolder: resolve('test-fixtures'),
		mocha: {
			timeout: 15000,
		},
		env: {
			SOPS_AGE_KEY_FILE: resolve('test-fixtures/age-key.txt'),
		},
	},
	{
		label: 'no-sops',
		files: 'out-test/no-sops.test.js',
		workspaceFolder: resolve('test-fixtures'),
		mocha: {
			timeout: 15000,
		},
		env: {
			PATH: resolve('tests/empty-bin'),
		},
	},
	{
		label: 'vsix',
		version: '1.114.0',
		files: resolve('out-test/integration.test.js'),
		extensionDevelopmentPath: resolve('tests/vsix-harness'),
		installExtensions: [resolve('.vscode-test/simple-sops.vsix')],
		workspaceFolder: resolve('test-fixtures'),
		mocha: {
			timeout: 15000,
		},
		env: {
			SOPS_AGE_KEY_FILE: resolve('test-fixtures/age-key.txt'),
			SIMPLE_SOPS_EXPECT_PACKAGED: '1',
		},
	},
	{
		label: 'vsix-no-sops',
		version: '1.114.0',
		files: resolve('out-test/no-sops.test.js'),
		extensionDevelopmentPath: resolve('tests/vsix-harness'),
		installExtensions: [resolve('.vscode-test/simple-sops.vsix')],
		workspaceFolder: resolve('test-fixtures'),
		mocha: {
			timeout: 15000,
		},
		env: {
			PATH: resolve('tests/empty-bin'),
			SIMPLE_SOPS_EXPECT_PACKAGED: '1',
		},
	},
]);
