import { defineConfig } from 'vitest/config';

export default defineConfig( {
	// Relative base so `dist/` can be served from any sub-directory.
	base: './',
	server: {
		open: true,
	},
	build: {
		outDir: 'dist',
	},
	test: {
		// The heightfield and car physics are pure modules: they need no DOM/WebGL.
		environment: 'node',
		include: [ 'tests/**/*.test.js' ],
	},
} );
